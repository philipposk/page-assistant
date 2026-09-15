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
- `enabled: () => flags.exports` for anything behind a feature flag, a plan tier, or a backend that may not be configured. While it is off the assistant is never told about it and a stale call is refused
- Schemas are checked at registration: one `type` per field (optional fields already accept `null`), unique names, every `required` key declared in `properties`. A bad schema throws `CapabilitySchemaError` at `init`, instead of failing every chat turn
- Built-in blind-mode `open_page_link` already requires confirm; prefer explicit capabilities for integrated apps

## 4. Embed the widget

```typescript
PageAssistant.init({
  serverUrl: "/api/pa",              // your proxy prefix
  appName: "My App",
  assistantName: "Ada",              // optional: who the assistant says it is; appName stays the product
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

**Workspace vocabulary** (recommended when users create their own tags, folders,
statuses or projects): give the model the real values, so "the Q3 shortlist" maps onto a
real tag instead of a question back to the user.

```typescript
PageAssistant.init({
  // ...
  vocabulary: {
    load: async () => ({
      values: { Tags: await myApi.tagNames(), Statuses: ["Open", "Won", "Lost"] },
      glossary: { shortlist: "a tag", board: "the Projects view" },
    }),
    ttlMs: 60_000, // the default; a load that throws or takes over 3 s is skipped and retried next turn
  },
});
```

On the server, one `Assistant` serves one `/v1/agent` request, so the vocabulary is loaded
per request. If you build a long-lived `Assistant` that serves several workspaces, return
the workspace id from `vocabulary.key`.

**Chat history in the user's account** (optional). By default chats stay in the browser
(`"device"`). To sync them across the user's devices, give the widget an adapter that reads
and writes the signed-in user's chats with their own credentials:

```typescript
import { supabaseChatHistoryAdapter } from "@page-assistant/widget";

PageAssistant.init({
  // ...
  chatHistoryMode: "account",       // default until the user picks; "device" for sensitive data
  chatHistoryAdapter: supabaseChatHistoryAdapter(supabase, { app: "my-app" }),
});
// Call after sign-in and sign-out:
PageAssistant.refreshChatHistory();
```

1. Apply [`packages/widget/supabase/assistant_chats.sql`](./packages/widget/supabase/assistant_chats.sql)
   as a migration in your own project. It creates `assistant_chats` with row-level security
   (each user sees only their rows) and schedules the 12-month inactivity sweep with pg_cron
   — or tells you to run it from your own daily job. Rows are keyed on `(user_id, app, id)`,
   so several apps (the adapter's `app` option) can share the table without overwriting
   each other's chats. Applied an earlier copy keyed on `(user_id, id)`? Re-run the file, or
   add a migration with the two `alter table` lines in the CHANGELOG's upgrade notes.
2. Pass the **user-session** client, never a service-role client. The adapter's
   `currentUserId()` reads the session, so logged-out visitors fall back to
   `chatHistoryFallbackMode` (`"device"` unless you say `"off"`).
3. Not on Supabase? Implement `ChatHistoryAdapter` (`list`, `get`, `save`, `delete`,
   `deleteAll`, optional `currentUserId`) against your API; every call must be scoped to
   the signed-in user on the server.

Users switch between account, device and off in the Data tab, and can delete one chat or all
of them. For sensitive data, keep `chatHistoryMode: "device"` and let users opt in to account.

**Shared computers.** Implement `currentUserId()` whenever two people might use one browser.
With it, each signed-in user's device chats are kept under their own key
(`${storageKey}:user:${id}`) and chats made while signed out under the plain `storageKey`
(where earlier versions kept everything). The widget shows only the current person's slot —
after sign-out, sign-in or a change of user — and "Move my chats to my account" moves only
the user's own. Signed-out chats are offered separately, as "chats made while signed out on
this device", and move only if the user picks that. Without `currentUserId` the widget can't
tell people apart: all device chats share the one signed-out slot and are never offered to
anyone as theirs. This keeps people apart in the widget; it is not encryption — anyone with
the browser profile can read localStorage. On a shared machine, `"off"` or `"account"` is
the safe choice for sensitive data.

If your app runs on shared computers (a front desk, a kiosk, a family laptop), also pass
`offerSignedOutChats: false`. Whoever used the browser while signed out is often not the
person who signs in next, so the widget then never offers, counts or moves the signed-out
chats — not into the account, not into the user's own device chats. They stay in the
signed-out slot. The default, `true`, keeps the offer.

A reply that is still loading when someone signs out or another account signs in is
dropped, not saved into whatever is on screen by then; the same goes for a reply to a chat
the user has left for another one. Call `refreshChatHistory()` as soon as your app's auth
state changes so the widget notices promptly.

**Moving and retention.** Moving device chats into the account counts as activity: each moved
chat is saved with `updatedAt` = now (`createdAt` keeps its real age), so a chat older than
the retention window is not deleted straight after the move.

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

## 6. Agent discovery (llm.txt) — the second capability list

**Capabilities register in two separate places.** The list you pass to
`PageAssistant.init()` runs in the **browser** and powers the on-page assistant. It is
**not** the same list that backs `/v1/agent`, `/llm.txt`, and
`/.well-known/llm-actions.json` — those are driven by a **separate**
`ServerConfig.capabilities` list you pass to `createServer()` on the server. They do
**not** carry over. If you want external agents to drive your app, register the
relevant actions on the server too:

```typescript
import { createServer } from "@page-assistant/server";

createServer({
  appName: "My App",
  capabilities: serverCaps,          // separate from the widget's browser caps
  llmTxt: {
    appName: "My App",
    appUrl: "https://myapp.com",
    description: "What the app does.",
    agentEndpoint: "https://myapp.com/v1/agent",
  },
}).listen(8787);
```

`/v1/agent` and the discovery files **only mount when `capabilities` are present** — a
plain proxy returns 404 for them. See `examples/full-server.mjs` for a runnable
capability-backed server, and point the CLI `chat` command or the `@page-assistant/mcp`
server at it via `PA_SERVER_URL`.

The low-level generators are also exported if you host the manifests yourself:

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
- [ ] Parity list: every action a user can take in your UI maps to a capability, or is
      noted as browser-only (downloads, payments, OAuth)
- [ ] Account chat history (if used): migration applied, RLS on, retention sweep scheduled,
      adapter built on the user-session client with `currentUserId()`,
      `refreshChatHistory()` called on sign-in/out, `offerSignedOutChats: false` if the app
      runs on shared computers
- [ ] Your internal names (databases, services, old product names) added to `scrub`:
      `[...DEFAULT_SCRUB_RULES, ["InternalDB", "our records"]]`. Credentials, connection
      strings and environment variable names are scrubbed by default
- [ ] **Running more than one instance?** The standalone server's rate limiter, usage
      meter, daily budget, agent session memory, and analytics are **per-process
      in-memory**, and the JSON ticket file is last-writer-wins. Run **one** instance, or
      move that state into a shared layer (edge/Redis) — see the "Scaling" section in
      [SECURITY.md](./SECURITY.md).

## What you get for free

- Grounding loop + anti-hallucination validator
- Page scanner + blind-mode link clicking (with confirm)
- Floating UI, memory (localStorage), feedback tickets
- Voice settings UI, agent-to-agent endpoint, llm.txt generation
