# @page-assistant/server

Node backend for the page assistant: LLM proxy (keys stay server-side), voice
(ElevenLabs / OpenAI TTS, Whisper STT), the external agent endpoint, and `llm.txt`
hosting.

## Standalone proxy

```bash
npx page-assistant-server            # or: node dist/bin.js
```

Env: `PORT`, `PA_AUTH_TOKEN`, `PA_CORS_ORIGIN`, `PA_TICKETS_FILE`, plus an LLM key
(`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`).

## Programmatic

```ts
import { createServer, JsonFileTicketStore } from "@page-assistant/server";

createServer({
  capabilities: [ /* server-side actions */ ],   // mounts /v1/agent + llm.txt
  llmTxt: { appName, appUrl, description, agentEndpoint },
  ticketStore: new JsonFileTicketStore("./data/tickets.json"),
}).listen(8787);
```

**`/v1/agent`, `/llm.txt`, and `/.well-known/llm-actions.json` only mount when you
pass `capabilities`.** The default bin is a stateless proxy without them — see
[`examples/full-server.mjs`](https://github.com/philipposk/page-assistant/blob/main/examples/full-server.mjs)
for a runnable capability-backed server.

Server capabilities are **separate** from the widget's browser capabilities; they do
not carry over. See [SECURITY.md](https://github.com/philipposk/page-assistant/blob/main/SECURITY.md)
for production hardening.

MIT
