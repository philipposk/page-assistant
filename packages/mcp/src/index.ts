#!/usr/bin/env node
/**
 * MCP stdio server — exposes page-assistant /v1/agent as an MCP tool.
 *
 * The target server must be started WITH capabilities for /v1/agent to exist;
 * an out-of-the-box proxy (no config) returns 404. Point PA_SERVER_URL at a
 * capability-backed server (see examples/full-server.mjs in the repo).
 *
 * Env:
 *   PA_SERVER_URL  — backend base URL (default http://localhost:8787)
 *   PA_AUTH_TOKEN  — bearer token if required
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const serverUrl = (process.env.PA_SERVER_URL ?? "http://localhost:8787").replace(/\/$/, "");
const authToken = process.env.PA_AUTH_TOKEN;

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js -> ../package.json
    const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function callAgent(message: string, page?: Record<string, unknown>) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(`${serverUrl}/v1/agent`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, page: page ?? { url: serverUrl, path: "/" }, source: "mcp" }),
  });
  if (res.status === 404) {
    throw new Error(
      `agent 404: ${serverUrl}/v1/agent is not mounted. Point PA_SERVER_URL at a server started ` +
        `with capabilities (see examples/full-server.mjs).`
    );
  }
  if (!res.ok) throw new Error(`agent ${res.status}: ${await res.text()}`);
  return res.json();
}

const server = new Server({ name: "page-assistant", version: readVersion() }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask_page_assistant",
      description:
        "Send a message to the grounded page assistant living on the host app (POST /v1/agent). " +
        "Returns validated, capability-backed results. Requires PA_SERVER_URL to point at a server started with capabilities.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "User message or task for the assistant" },
          page_url: { type: "string", description: "Optional page URL context" },
        },
        required: ["message"],
      },
    },
    {
      name: "health_check",
      description: "Check if the page-assistant backend is reachable.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "health_check") {
    const res = await fetch(`${serverUrl}/v1/health`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
  if (name === "ask_page_assistant") {
    const message = String((args as any)?.message ?? "");
    const pageUrl = (args as any)?.page_url;
    const result = await callAgent(message, pageUrl ? { url: pageUrl, path: new URL(pageUrl).pathname } : undefined);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
