#!/usr/bin/env node
// Standalone dev server: a stateless LLM + voice proxy any widget can point at.
import { createServer } from "./server.js";
import { JsonFileTicketStore } from "./ticketFileStore.js";

const port = Number(process.env.PORT ?? 8787);
createServer({
  corsOrigin: process.env.PA_CORS_ORIGIN ?? "*",
  ticketStore: new JsonFileTicketStore(process.env.PA_TICKETS_FILE ?? "./data/tickets.json"),
}).listen(port, () => {
  console.log(`[page-assistant] proxy listening on http://localhost:${port}`);
  console.log(`  POST /v1/llm/complete  POST /v1/voice/tts  POST /v1/voice/stt  POST /v1/feedback`);
  if (!process.env.PA_AUTH_TOKEN) console.log(`  WARNING: PA_AUTH_TOKEN not set — spend endpoints are open (rate-limited only).`);
});
