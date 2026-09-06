# Instructions for coding agents

When adding or tuning **page-assistant** in a host app, read these files **in order** before writing code:

1. **[INTEGRATION.md](./INTEGRATION.md)** — step-by-step embed checklist, capabilities, server routes, voice settings
2. **[SECURITY.md](./SECURITY.md)** — production auth, rate limits, confirm gates, what not to expose
3. **[README.md](./README.md)** — architecture and anti-hallucination model

## Your job in a host app

Make the assistant able to do **everything a signed-in user could do** on that site, safely:

1. **Register capabilities** for every real action (search, create, update, delete, navigate, export). Each `run()` must call the app's real API — never fake results in the LLM.
2. **Mark destructive or irreversible actions** with `confirm: true` so the user approves before execution.
3. **Expose server routes** under a prefix (e.g. `/api/pa/*`): LLM proxy, voice TTS/STT, optional `/v1/agent`, `llm.txt`. Require **user session auth** on all spend endpoints (see Transcriber's `app/api/pa/` for a Next.js pattern).
4. **Wire the widget** with `PageAssistant.init({ serverUrl, capabilities, voice: true, settingsPageUrl })`. Built-in voice settings and gear modal work out of the box.
5. **Publish discovery**: serve `llm.txt` and `/.well-known/llm-actions.json` so other agents can find capabilities.
6. **Tune persona + knowledge** so the assistant understands the product; use `getPageState()` for current view context.

## Do not

- Skip auth on LLM/voice/agent routes in production
- Register capabilities that bypass the app's normal permission checks
- Set `confirm: false` on delete/pay/checkout/send-email actions
- Pass user-controlled URLs as `knowledgeUrl` (same-origin only)
- Duplicate voice-settings UI — use `mountVoiceSettingsPanel()` from `@page-assistant/widget`

## Talking to an app from your own agent (MCP + CLI)

If you are an agent that wants to **use** an app that ships page-assistant (rather than
embed one), install the MCP server — it is the artifact Cursor / Claude Desktop users
add:

- **`@page-assistant/mcp`** — MCP stdio server. Tools: `ask_page_assistant` (drives the
  app's assistant via `POST /v1/agent`) and `health_check`. Configure with
  `PA_SERVER_URL` (and `PA_AUTH_TOKEN` if the server requires it). The target server
  must be started **with capabilities**, or `/v1/agent` returns 404 — see
  `examples/full-server.mjs`.
- **`@page-assistant/cli`** — `page-assistant chat "<message>"` hits the same
  `/v1/agent` endpoint; `serve --config <file>` starts a capability-backed server.

Example MCP config:

```json
{ "mcpServers": { "page-assistant": {
  "command": "npx", "args": ["-y", "@page-assistant/mcp"],
  "env": { "PA_SERVER_URL": "http://localhost:8787" }
} } }
```

## Reference implementation

[Transcriber](https://github.com/philipposk/transcriber): `components/PageAssistantWidget.tsx`, `lib/page-assistant/capabilities.ts`, `app/api/pa/*`
