#!/usr/bin/env node
/** page-assistant CLI — health, chat, serve */
import { createServer } from "@page-assistant/server";

const [cmd, ...args] = process.argv.slice(2);
const serverUrl = (process.env.PA_SERVER_URL ?? "http://localhost:8787").replace(/\/$/, "");
const authToken = process.env.PA_AUTH_TOKEN;

async function main() {
  switch (cmd ?? "help") {
    case "health":
      await health();
      break;
    case "chat":
      await chat(args.join(" "));
      break;
    case "serve":
      serve(Number(args[0] ?? process.env.PORT ?? 8787));
      break;
    case "models":
      await models();
      break;
    default:
      console.log(`page-assistant CLI v0.3.0

Usage:
  page-assistant health          Check backend health
  page-assistant chat <message>  Send message to /v1/agent (if configured)
  page-assistant models          List available LLM models
  page-assistant serve [port]    Start standalone proxy server

Env: PA_SERVER_URL, PA_AUTH_TOKEN, PORT
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
    console.error(text);
    process.exit(1);
  }
  try {
    const data = JSON.parse(text);
    console.log(data.message ?? text);
  } catch {
    console.log(text);
  }
}

function serve(port: number) {
  createServer({ corsOrigin: process.env.PA_CORS_ORIGIN ?? "*" }).listen(port, () => {
    console.log(`[page-assistant] listening on http://localhost:${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
