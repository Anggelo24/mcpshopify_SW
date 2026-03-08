#!/usr/bin/env node
/**
 * Stdio-to-StreamableHTTP bridge for the Shopify MCP server.
 * Replaces mcp-remote with a simpler, more reliable proxy.
 *
 * Usage (in claude_desktop_config.json):
 * {
 *   "command": "node",
 *   "args": ["path/to/bridge.js"],
 *   "env": {
 *     "MCP_SERVER_URL": "https://mcpshopifysw-production.up.railway.app/mcp",
 *     "MCP_API_KEY": "Bearer tuinity_..."
 *   }
 * }
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SERVER_URL = process.env.MCP_SERVER_URL;
const API_KEY = process.env.MCP_API_KEY;

if (!SERVER_URL) {
  console.error("MCP_SERVER_URL is required");
  process.exit(1);
}

// Build headers
const headers = { "Content-Type": "application/json" };
if (API_KEY) headers["Authorization"] = API_KEY;

// Create the remote transport (HTTP → Railway)
const remoteTransport = new StreamableHTTPClientTransport(
  new URL(SERVER_URL),
  { requestInit: { headers } }
);

// Create the local transport (stdio ← Claude Code)
const localTransport = new StdioServerTransport();

// Wire: local stdin → remote, remote → local stdout
localTransport.onmessage = async (message) => {
  try {
    await remoteTransport.send(message);
  } catch (err) {
    process.stderr.write(`[bridge] send error: ${err.message}\n`);
  }
};

remoteTransport.onmessage = async (message) => {
  try {
    await localTransport.send(message);
  } catch (err) {
    process.stderr.write(`[bridge] recv error: ${err.message}\n`);
  }
};

// Handle close
localTransport.onclose = () => {
  remoteTransport.close();
  process.exit(0);
};
remoteTransport.onclose = () => {
  process.stderr.write("[bridge] remote disconnected\n");
};
remoteTransport.onerror = (err) => {
  process.stderr.write(`[bridge] remote error: ${err.message}\n`);
};

// Start both transports
await remoteTransport.start();
await localTransport.start();
process.stderr.write("[bridge] connected to remote MCP server\n");
