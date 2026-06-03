#!/usr/bin/env node
// Standalone dev server: a stateless LLM + voice proxy any widget can point at.
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
createServer({ corsOrigin: process.env.PA_CORS_ORIGIN ?? "*" }).listen(port, () => {
  console.log(`[page-assistant] proxy listening on http://localhost:${port}`);
  console.log(`  POST /v1/llm/complete  POST /v1/voice/tts  POST /v1/voice/stt`);
});
