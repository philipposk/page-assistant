#!/usr/bin/env node
// Standalone dev server: a stateless LLM + voice proxy any widget can point at.
import type { Server } from "node:http";
import { createServer } from "./server.js";
import { JsonFileTicketStore } from "./ticketFileStore.js";
import { log } from "./env.js";

const port = Number(process.env.PORT ?? 8787);

// A crash left unhandled takes the process down WITHOUT a clean log line, and an unhandled
// promise rejection will (on modern Node) also terminate. Convert both into a structured
// log + a non-zero exit so an orchestrator (systemd/k8s) restarts us and the cause is on
// record instead of a bare stack on stderr.
process.on("uncaughtException", (err) => {
  log("error", { route: "process", msg: "uncaughtException", errType: err?.name, error: err?.message, stack: err?.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : undefined;
  log("error", { route: "process", msg: "unhandledRejection", errType: err?.name, error: err ? err.message : String(reason), stack: err?.stack });
  process.exit(1);
});

const server: Server = createServer({
  corsOrigin: process.env.PA_CORS_ORIGIN ?? "*",
  ticketStore: new JsonFileTicketStore(process.env.PA_TICKETS_FILE ?? "./data/tickets.json"),
}).listen(port, () => {
  // createServer() already emitted a structured boot summary (providers, auth, limits,
  // trust-proxy). Here we just print the listen URL + endpoint hints for humans.
  console.log(`[page-assistant] proxy listening on http://localhost:${port}`);
  console.log(`  POST /v1/llm/complete  POST /v1/voice/tts  POST /v1/voice/stt  POST /v1/feedback`);
  console.log(`  GET  /v1/usage  GET /v1/usage/dashboard  GET /v1/voice/capabilities`);
});

// A busy port is the single most common local-dev failure. Print one clean line telling the
// user what to do instead of a raw ELIFECYCLE/stack trace that buries the actual problem.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log("error", { route: "boot", msg: `port ${port} is already in use — stop the other process or set PORT to a free port` });
  } else {
    log("error", { route: "boot", msg: "server failed to start", errType: err.name, error: err.message });
  }
  process.exit(1);
});

// Graceful shutdown: stop accepting new connections and let in-flight requests drain before
// exiting, so a deploy/restart doesn't cut active chats mid-response. Force-exit if the
// server won't close within a grace window.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", { route: "shutdown", msg: `received ${signal}, closing server` });
  const force = setTimeout(() => {
    log("error", { route: "shutdown", msg: "did not close in time, forcing exit" });
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close((err) => {
    if (err) {
      log("error", { route: "shutdown", msg: "error while closing", error: err.message });
      process.exit(1);
    }
    log("info", { route: "shutdown", msg: "closed cleanly" });
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
