import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "http";
import { randomUUID } from "crypto";

// --- Config ---
const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || "simple-wallet-panama.myshopify.com";
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("ERROR: SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required");
  process.exit(1);
}

const BASE_URL = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}`;

// --- Token manager (auto-refresh every 24h) ---
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const response = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Token refresh failed ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // Refresh 5 minutes before expiry
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return cachedToken;
}

// --- Shopify API helper ---
async function shopifyFetch(endpoint, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    // If 401, force token refresh and retry once
    if (response.status === 401) {
      cachedToken = null;
      tokenExpiresAt = 0;
      const newToken = await getAccessToken();
      const retry = await fetch(url.toString(), {
        headers: { "X-Shopify-Access-Token": newToken, "Content-Type": "application/json" },
      });
      if (!retry.ok) {
        const errorBody = await retry.text();
        throw new Error(`Shopify API ${retry.status}: ${errorBody}`);
      }
      return retry.json();
    }
    const errorBody = await response.text();
    throw new Error(`Shopify API ${response.status}: ${errorBody}`);
  }

  return response.json();
}

// Helper to handle pagination
async function shopifyFetchAll(endpoint, resourceKey, params = {}, maxPages = 5) {
  const token = await getAccessToken();
  const allItems = [];
  let url = `${BASE_URL}${endpoint}`;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.set(key, String(value));
    }
  }
  if (searchParams.toString()) {
    url += `?${searchParams.toString()}`;
  }

  let page = 0;
  while (url && page < maxPages) {
    const currentToken = await getAccessToken();
    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": currentToken,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Shopify API ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    if (data[resourceKey]) {
      allItems.push(...data[resourceKey]);
    }

    // Check for next page via Link header
    const linkHeader = response.headers.get("link");
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        url = nextMatch[1];
      }
    }
    page++;
  }

  return allItems;
}

// --- MCP Server (used for stdio mode) ---
const server = new McpServer({
  name: "shopify",
  version: "1.0.0",
});

// --- Register all tools on a given server instance ---
function registerTools(srv) {

// ---- TOOL: get_orders ----
srv.tool(
  "get_orders",
  "Get orders from Shopify. Returns order details including line items, totals, dates, and source channel. Essential for cross-referencing with Meta Ads attribution.",
  {
    status: z.enum(["any", "open", "closed", "cancelled"]).default("any").describe("Order status filter"),
    created_at_min: z.string().optional().describe("Minimum creation date (ISO 8601, e.g. 2026-03-01T00:00:00-05:00)"),
    created_at_max: z.string().optional().describe("Maximum creation date (ISO 8601)"),
    limit: z.number().min(1).max(250).default(50).describe("Number of orders to return (max 250)"),
    fields: z.string().optional().describe("Comma-separated fields to include (e.g. id,created_at,line_items,total_price)"),
    financial_status: z.enum(["any", "authorized", "pending", "paid", "partially_paid", "refunded", "voided", "partially_refunded", "unpaid"]).optional().describe("Filter by financial status"),
    since_id: z.string().optional().describe("Only orders after this ID (for pagination)"),
    product_id: z.string().optional().describe("Filter orders containing this product ID"),
  },
  async (params) => {
    try {
      const queryParams = { limit: params.limit };
      if (params.status !== "any") queryParams.status = params.status;
      if (params.created_at_min) queryParams.created_at_min = params.created_at_min;
      if (params.created_at_max) queryParams.created_at_max = params.created_at_max;
      if (params.fields) queryParams.fields = params.fields;
      if (params.financial_status && params.financial_status !== "any") queryParams.financial_status = params.financial_status;
      if (params.since_id) queryParams.since_id = params.since_id;

      const data = await shopifyFetch("/orders.json", queryParams);
      let orders = data.orders || [];

      // Client-side filter by product_id if provided
      if (params.product_id) {
        orders = orders.filter(order =>
          order.line_items?.some(item => String(item.product_id) === params.product_id)
        );
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_orders: orders.length,
            orders: orders.map(o => ({
              id: o.id,
              order_number: o.order_number,
              created_at: o.created_at,
              financial_status: o.financial_status,
              fulfillment_status: o.fulfillment_status,
              total_price: o.total_price,
              subtotal_price: o.subtotal_price,
              total_discounts: o.total_discounts,
              currency: o.currency,
              source_name: o.source_name,
              referring_site: o.referring_site,
              landing_site: o.landing_site,
              line_items: o.line_items?.map(li => ({
                product_id: li.product_id,
                variant_id: li.variant_id,
                title: li.title,
                variant_title: li.variant_title,
                quantity: li.quantity,
                price: li.price,
                sku: li.sku,
              })),
              customer: o.customer ? {
                id: o.customer.id,
                email: o.customer.email,
                first_name: o.customer.first_name,
                last_name: o.customer.last_name,
                orders_count: o.customer.orders_count,
              } : null,
              tags: o.tags,
              note: o.note,
            })),
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ---- TOOL: get_orders_summary ----
srv.tool(
  "get_orders_summary",
  "Get aggregated order summary — total revenue, order count, average order value, and top products for a date range. Great for quick performance snapshots.",
  {
    created_at_min: z.string().optional().describe("Start date (ISO 8601)"),
    created_at_max: z.string().optional().describe("End date (ISO 8601)"),
    financial_status: z.enum(["any", "paid", "refunded", "partially_refunded"]).default("paid").describe("Financial status filter"),
  },
  async (params) => {
    try {
      const queryParams = { limit: 250, status: "any" };
      if (params.created_at_min) queryParams.created_at_min = params.created_at_min;
      if (params.created_at_max) queryParams.created_at_max = params.created_at_max;
      if (params.financial_status !== "any") queryParams.financial_status = params.financial_status;

      const orders = await shopifyFetchAll("/orders.json", "orders", queryParams);

      const productSales = {};
      let totalRevenue = 0;
      let totalDiscount = 0;
      const dailySales = {};

      for (const order of orders) {
        const revenue = parseFloat(order.total_price || 0);
        totalRevenue += revenue;
        totalDiscount += parseFloat(order.total_discounts || 0);

        const day = order.created_at?.split("T")[0];
        if (day) {
          dailySales[day] = (dailySales[day] || 0) + revenue;
        }

        for (const item of order.line_items || []) {
          const key = item.title || "Unknown";
          if (!productSales[key]) {
            productSales[key] = { title: key, quantity: 0, revenue: 0 };
          }
          productSales[key].quantity += item.quantity || 0;
          productSales[key].revenue += parseFloat(item.price || 0) * (item.quantity || 0);
        }
      }

      const topProducts = Object.values(productSales)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_orders: orders.length,
            total_revenue: totalRevenue.toFixed(2),
            average_order_value: orders.length > 0 ? (totalRevenue / orders.length).toFixed(2) : "0.00",
            total_discounts: totalDiscount.toFixed(2),
            top_products: topProducts,
            daily_sales: dailySales,
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ---- TOOL: get_products ----
srv.tool(
  "get_products",
  "Get products from the Shopify catalog with variants, prices, and status.",
  {
    limit: z.number().min(1).max(250).default(50).describe("Number of products to return"),
    title: z.string().optional().describe("Filter by product title (exact match)"),
    product_type: z.string().optional().describe("Filter by product type"),
    status: z.enum(["active", "archived", "draft"]).default("active").describe("Product status"),
    collection_id: z.string().optional().describe("Filter by collection ID"),
  },
  async (params) => {
    try {
      const queryParams = {
        limit: params.limit,
        status: params.status,
      };
      if (params.title) queryParams.title = params.title;
      if (params.product_type) queryParams.product_type = params.product_type;
      if (params.collection_id) queryParams.collection_id = params.collection_id;

      const data = await shopifyFetch("/products.json", queryParams);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_products: data.products?.length || 0,
            products: (data.products || []).map(p => ({
              id: p.id,
              title: p.title,
              product_type: p.product_type,
              vendor: p.vendor,
              status: p.status,
              tags: p.tags,
              created_at: p.created_at,
              variants: p.variants?.map(v => ({
                id: v.id,
                title: v.title,
                price: v.price,
                compare_at_price: v.compare_at_price,
                sku: v.sku,
                inventory_quantity: v.inventory_quantity,
                weight: v.weight,
                weight_unit: v.weight_unit,
              })),
              images: p.images?.length || 0,
            })),
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ---- TOOL: get_inventory ----
srv.tool(
  "get_inventory",
  "Get inventory levels for products/variants. Shows current stock quantities per location.",
  {
    inventory_item_ids: z.string().optional().describe("Comma-separated inventory item IDs"),
    location_ids: z.string().optional().describe("Comma-separated location IDs"),
    limit: z.number().min(1).max(250).default(50).describe("Number of results"),
  },
  async (params) => {
    try {
      // If no specific IDs, get all products first to find inventory item IDs
      if (!params.inventory_item_ids) {
        const productsData = await shopifyFetch("/products.json", { limit: 250, fields: "id,title,variants" });
        const items = [];
        for (const p of productsData.products || []) {
          for (const v of p.variants || []) {
            items.push({
              product_id: p.id,
              product_title: p.title,
              variant_id: v.id,
              variant_title: v.title,
              sku: v.sku,
              inventory_item_id: v.inventory_item_id,
              inventory_quantity: v.inventory_quantity,
            });
          }
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ total_items: items.length, inventory: items }, null, 2),
          }],
        };
      }

      const queryParams = { limit: params.limit };
      if (params.inventory_item_ids) queryParams.inventory_item_ids = params.inventory_item_ids;
      if (params.location_ids) queryParams.location_ids = params.location_ids;

      const data = await shopifyFetch("/inventory_levels.json", queryParams);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_levels: data.inventory_levels?.length || 0,
            inventory_levels: data.inventory_levels,
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ---- TOOL: get_customers ----
srv.tool(
  "get_customers",
  "Get customer data — country, order count, total spent, and creation date. Useful for cohort analysis and LTV.",
  {
    limit: z.number().min(1).max(250).default(50).describe("Number of customers to return"),
    created_at_min: z.string().optional().describe("Minimum creation date (ISO 8601)"),
    created_at_max: z.string().optional().describe("Maximum creation date (ISO 8601)"),
    since_id: z.string().optional().describe("Only customers after this ID"),
  },
  async (params) => {
    try {
      const queryParams = { limit: params.limit };
      if (params.created_at_min) queryParams.created_at_min = params.created_at_min;
      if (params.created_at_max) queryParams.created_at_max = params.created_at_max;
      if (params.since_id) queryParams.since_id = params.since_id;

      const data = await shopifyFetch("/customers.json", queryParams);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_customers: data.customers?.length || 0,
            customers: (data.customers || []).map(c => ({
              id: c.id,
              email: c.email,
              first_name: c.first_name,
              last_name: c.last_name,
              orders_count: c.orders_count,
              total_spent: c.total_spent,
              currency: c.currency,
              created_at: c.created_at,
              tags: c.tags,
              default_address: c.default_address ? {
                country: c.default_address.country,
                city: c.default_address.city,
                province: c.default_address.province,
              } : null,
              verified_email: c.verified_email,
            })),
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ---- TOOL: get_shop_info ----
srv.tool(
  "get_shop_info",
  "Get basic store information — name, domain, currency, timezone, plan.",
  {},
  async () => {
    try {
      const data = await shopifyFetch("/shop.json");
      const s = data.shop;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name: s.name,
            domain: s.domain,
            myshopify_domain: s.myshopify_domain,
            email: s.email,
            currency: s.currency,
            timezone: s.iana_timezone,
            country: s.country_name,
            plan_name: s.plan_name,
            created_at: s.created_at,
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ---- TOOL: count_orders ----
srv.tool(
  "count_orders",
  "Get the total count of orders matching filters. Fast way to check volume without fetching all data.",
  {
    status: z.enum(["any", "open", "closed", "cancelled"]).default("any").describe("Order status"),
    created_at_min: z.string().optional().describe("Start date (ISO 8601)"),
    created_at_max: z.string().optional().describe("End date (ISO 8601)"),
    financial_status: z.enum(["any", "authorized", "pending", "paid", "partially_paid", "refunded", "voided", "partially_refunded", "unpaid"]).optional().describe("Financial status filter"),
  },
  async (params) => {
    try {
      const queryParams = {};
      if (params.status !== "any") queryParams.status = params.status;
      if (params.created_at_min) queryParams.created_at_min = params.created_at_min;
      if (params.created_at_max) queryParams.created_at_max = params.created_at_max;
      if (params.financial_status && params.financial_status !== "any") queryParams.financial_status = params.financial_status;

      const data = await shopifyFetch("/orders/count.json", queryParams);

      return {
        content: [{ type: "text", text: JSON.stringify({ count: data.count }, null, 2) }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }
);

} // end registerTools

// --- Start server ---
const PORT = process.env.PORT;
const MCP_API_KEY = process.env.MCP_API_KEY;

if (PORT) {
  // --- Remote mode: Streamable HTTP + SSE fallback (for Railway / shared access) ---
  const httpSessions = new Map();   // Streamable HTTP sessions
  const sseSessions = new Map();    // Legacy SSE sessions

  // Helper: read request body as JSON
  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  }

  const httpServer = createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // Auth check
    if (MCP_API_KEY) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${MCP_API_KEY}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Health check
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "shopify-mcp", version: "1.0.0" }));
      return;
    }

    // =============================================
    // Streamable HTTP endpoint (new, preferred)
    // =============================================
    if (url.pathname === "/mcp") {
      // POST /mcp — initialize or send messages
      if (req.method === "POST") {
        const body = await readBody(req);
        const sessionId = req.headers["mcp-session-id"];

        // Existing session — route to its transport
        if (sessionId && httpSessions.has(sessionId)) {
          const transport = httpSessions.get(sessionId);
          await transport.handleRequest(req, res, body);
          return;
        }

        // New session — must be an initialize request
        if (!sessionId) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              httpSessions.set(sid, transport);
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) httpSessions.delete(sid);
          };

          const mcpInstance = new McpServer({ name: "shopify", version: "1.0.0" });
          registerTools(mcpInstance);
          await mcpInstance.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        // Session ID provided but not found
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid session ID" }));
        return;
      }

      // GET /mcp — open SSE stream for server-to-client notifications
      if (req.method === "GET") {
        const sessionId = req.headers["mcp-session-id"];
        if (sessionId && httpSessions.has(sessionId)) {
          const transport = httpSessions.get(sessionId);
          await transport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session ID required" }));
        return;
      }

      // DELETE /mcp — close session
      if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"];
        if (sessionId && httpSessions.has(sessionId)) {
          const transport = httpSessions.get(sessionId);
          await transport.handleRequest(req, res);
          httpSessions.delete(sessionId);
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
    }

    // =============================================
    // Legacy SSE endpoints (backward compatibility)
    // =============================================
    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      sseSessions.set(transport.sessionId, transport);
      transport.onclose = () => sseSessions.delete(transport.sessionId);

      const mcpInstance = new McpServer({ name: "shopify", version: "1.0.0" });
      registerTools(mcpInstance);
      await mcpInstance.connect(transport);
      return;
    }

    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      const transport = sseSessions.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      const body = await readBody(req);
      req.body = body;
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(PORT, () => {
    console.log(`Shopify MCP server running on port ${PORT}`);
    console.log(`Streamable HTTP: http://0.0.0.0:${PORT}/mcp`);
    console.log(`Legacy SSE:      http://0.0.0.0:${PORT}/sse`);
  });
} else {
  // --- Local mode: stdio ---
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
