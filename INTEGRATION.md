# Integrating page-assistant into your app

Portable checklist for React, Next.js, Vue, or plain HTML hosts.

## 1. Add the packages

**Monorepo / submodule** (recommended for forks):

```bash
git submodule add https://github.com/philipposk/page-assistant.git vendor/page-assistant
# package.json:
# "@page-assistant/widget": "file:vendor/page-assistant/packages/widget"
# "@page-assistant/server": "file:vendor/page-assistant/packages/server"
# "@page-assistant/core": "file:vendor/page-assistant/packages/core"
```

**npm** (when published):

```bash
npm install @page-assistant/widget @page-assistant/server @page-assistant/core
```

## 2. Backend routes (keys stay server-side)

Mount or reimplement these endpoints. **Every spend route must require your app's user auth** (session, JWT, API key scoped to user).

| Route | Purpose |
|-------|---------|
| `POST /v1/llm/complete` | LLM proxy for grounding loop |
| `POST /v1/voice/tts` | ElevenLabs / OpenAI TTS |
| `POST /v1/voice/stt` | Whisper STT |
| `POST /v1/agent` | Optional: external agents drive server capabilities |
| `GET /llm.txt` | Human/agent-readable capability manifest |
| `GET /.well-known/llm-actions.json` | Machine manifest |
| `GET /v1/health` | Health check |

**Standalone Express server**: `createServer()` from `@page-assistant/server`. Set `PA_AUTH_TOKEN`, `PA_CORS_ORIGIN`, rate limit env vars (see SECURITY.md).

**Next.js pattern**: proxy routes in `app/api/pa/*` with `getUserId()` + Upstash rate limits (see Transcriber).

## 3. Register capabilities (the important part)

Capabilities are the **only** actions the assistant can perform. To match "everything a user can do", register one capability per user-facing action:

```typescript
import { capability, PageAssistant } from "@page-assistant/widget";

const caps = [
  capability({
    name: "search_items",
    description: "Search items by keyword.",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    run: async ({ q }) => myApi.search(q),           // real API
    render: (r) => `Found ${r.count} items.`,       // trusted user-facing text
  }),
  capability({
    name: "delete_item",
    description: "Permanently delete an item.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    confirm: true,                                   // user must approve
    run: async ({ id }) => myApi.delete(id),
    render: () => "Item deleted.",
  }),
];
```

Rules:

- `run()` calls your real backend with the **current user's** credentials
- `render()` produces facts shown to the user; the validator blocks invented numbers
- `confirm: true` for writes, deletes, payments, sends, irreversible navigation
- Built-in blind-mode `open_page_link` already requires confirm; prefer explicit capabilities for integrated apps

## 4. Embed the widget

```typescript
PageAssistant.init({
  serverUrl: "/api/pa",              // your proxy prefix
  appName: "My App",
  persona: "Short role description.",
  knowledge: "What this app does (from README).",
  knowledgeUrl: "/llm.txt",          // same-origin only; fetched on first open
  voice: true,                       // built-in voice settings + ☎ toggle
  settingsPageUrl: "/settings#assistant",
  capabilities: caps,
  getPageState: () => ({ view: currentView, selection: selectedId }),
  suggestions: ["Search my recent orders", "What can you do?"],
});
```

**Settings page embed** (optional):

```typescript
import { mountVoiceSettingsPanel } from "@page-assistant/widget";
mountVoiceSettingsPanel(document.getElementById("pa-voice-settings")!);
```

## 5. Voice (built-in)

- Default: **text only** (free)
- Gear icon → voice picker (ElevenLabs / OpenAI / browser)
- Mic: browser (free) or server Whisper
- No custom UI needed unless you override `onSettings`

## 6. Agent discovery (llm.txt)

Serve generated manifests so Cursor, Claude, or other agents can discover and call your assistant:

```typescript
import { generateLlmTxt, generateActionsJson } from "@page-assistant/core";
```

## 7. Production checklist

- [ ] User auth on all `/v1/llm/*`, `/v1/voice/*`, `/v1/agent`
- [ ] Rate limits per user (not just IP)
- [ ] `confirm: true` on destructive capabilities
- [ ] Capabilities enforce same permissions as your UI
- [ ] CORS restricted to your origin (standalone server)
- [ ] `ELEVENLABS_API_KEY` / `OPENAI_API_KEY` only on server
- [ ] Test: ask assistant to do something it shouldn't — it must refuse or ask to confirm

## What you get for free

- Grounding loop + anti-hallucination validator
- Page scanner + blind-mode link clicking (with confirm)
- Floating UI, memory (localStorage), feedback tickets
- Voice settings UI, agent-to-agent endpoint, llm.txt generation
