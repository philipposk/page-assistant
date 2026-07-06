#!/usr/bin/env node
/** page-assistant CLI — health, chat, serve, models */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer, JsonFileTicketStore, type ServerConfig } from "@page-assistant/server";

// Load a local .env if present so `serve` behaves like the server's own bin.ts
// (keys, PA_AUTH_TOKEN, PORT). Node 20.12+/22 built-in; ignore if the file is absent.
try {
  (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env — fine */
}

const VERSION = readVersion();
const [cmd, ...args] = process.argv.slice(2);
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

async function main() {
  switch (cmd ?? "help") {
    case "health":
      await health();
      break;
    case "chat":
      await chat(args.join(" "));
      break;
    case "serve":
      await serve();
      break;
    case "models":
      await models();
      break;
    default:
      console.log(`page-assistant CLI v${VERSION}

Usage:
  page-assistant health              Check backend health
  page-assistant chat <message>      Send message to /v1/agent
  page-assistant models              List available LLM models
  page-assistant serve [port]        Start standalone proxy server

Serve flags:
  --config <path>   Load a config module (.js/.mjs default export) or JSON file
                    providing { capabilities, llmTxt, appName, ... }. Required to
                    mount /v1/agent, /llm.txt and /.well-known/llm-actions.json —
                    without capabilities those endpoints 404 (see examples/full-server.mjs).

Notes:
  \`chat\` and the MCP \`ask_page_assistant\` tool call POST /v1/agent, which only
  mounts when the server was started with capabilities. Point them at a config-backed
  server (e.g. \`page-assistant serve --config ./examples/full-server.mjs\`, or run
  examples/full-server.mjs directly).

Env: PA_SERVER_URL, PA_AUTH_TOKEN, PORT, PA_CORS_ORIGIN, PA_TICKETS_FILE
     A local .env is loaded automatically if present.
`);
  }
}

async function health() {
  const res = await fetch(`${serverUrl}/v1/health`);
  console.log(await res.text());
}

async function models() {
  const headers: Record<string, string> = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(`${serverUrl}/v1/models`, { headers });
  console.log(await res.text());
}

async function chat(message: string) {
  if (!message) {
    console.error("Usage: page-assistant chat <message>");
    process.exit(1);
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(`${serverUrl}/v1/agent`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, page: { url: serverUrl, path: "/" }, source: "cli" }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) {
      console.error(
        `${serverUrl}/v1/agent is not mounted. Start a server WITH capabilities ` +
          `(e.g. \`page-assistant serve --config ./examples/full-server.mjs\` or run that file directly).`
      );
    } else {
      console.error(text);
    }
    process.exit(1);
  }
  try {
    const data = JSON.parse(text);
    console.log(data.message ?? text);
  } catch {
    console.log(text);
  }
}

/** Parse `--config <path>` from serve args; the first bare arg is the port. */
function parseServeArgs(argv: string[]): { port?: number; config?: string } {
  let port: number | undefined;
  let config: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      config = argv[++i];
    } else if (a.startsWith("--config=")) {
      config = a.slice("--config=".length);
    } else if (!port && /^\d+$/.test(a)) {
      port = Number(a);
    }
  }
  return { port, config };
}

/** Load a ServerConfig from a JS/MJS module (default export or named `config`) or a JSON file. */
async function loadConfig(path: string): Promise<Partial<ServerConfig>> {
  const abs = resolve(process.cwd(), path);
  if (/\.json$/i.test(path)) {
    return JSON.parse(readFileSync(abs, "utf8"));
  }
  const mod = await import(pathToFileURL(abs).href);
  const cfg = mod.default ?? mod.config ?? mod;
  if (typeof cfg === "function") return await cfg();
  return cfg;
}

async function serve() {
  const { port, config } = parseServeArgs(args);
  const resolvedPort = port ?? Number(process.env.PORT ?? 8787);

  let extra: Partial<ServerConfig> = {};
  if (config) {
    try {
      extra = await loadConfig(config);
    } catch (e) {
      console.error(`Failed to load config "${config}":`, (e as Error).message);
      process.exit(1);
    }
  }

  const server = createServer({
    corsOrigin: process.env.PA_CORS_ORIGIN ?? "*",
    // Persist tickets to disk (parity with the server's own bin.ts) instead of losing
    // them on restart with the default in-memory store.
    ticketStore: new JsonFileTicketStore(process.env.PA_TICKETS_FILE ?? "./data/tickets.json"),
    ...extra,
  });

  server.listen(resolvedPort, () => {
    console.log(`[page-assistant] listening on http://localhost:${resolvedPort}`);
    console.log("  POST /v1/llm/complete  POST /v1/voice/tts  POST /v1/voice/stt  POST /v1/feedback");
    if (extra.capabilities?.length) {
      console.log("  POST /v1/agent  GET /llm.txt  GET /.well-known/llm-actions.json  (from --config)");
    } else {
      console.log("  (no --config: /v1/agent and /llm.txt are NOT mounted — see examples/full-server.mjs)");
    }
    if (!process.env.PA_AUTH_TOKEN) {
      console.log("  WARNING: PA_AUTH_TOKEN not set — spend endpoints are open (rate-limited only).");
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
