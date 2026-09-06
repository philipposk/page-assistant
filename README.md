# Page Assistant

An embeddable, **voice-capable**, **grounded** assistant that drops into any web app, **reads the page**, and performs **real actions** for the user — without faking or hallucinating results. It also publishes an `llm.txt` so *other* AI agents can understand your app and talk to the assistant living on it.

Born from the strive-backend page assistant (its anti-hallucination layer), Daisy (voice), and AI-OS (memory + LLM routing), rebuilt as a portable TypeScript SDK.

---

## Why it doesn't hallucinate

Most "AI on your site" widgets let the model *say* it did something. This one can't. Three guarantees, lifted from the strive page assistant and generalized:

1. **Capability boundary** — the assistant can only call functions the host explicitly registers. No registered action ⇒ it tells the user it can't, instead of pretending.
2. **Trusted rendering** — each capability's own `render()` produces the user-facing numbers. The model narrates *around* facts, it doesn't invent them.
3. **Factual validator** — after the model writes its reply, any number that no executed capability actually returned is rejected and replaced with the trusted output. (Proven in `packages/core/test` — the model says "9000/100", the user sees the real "72".)

## Architecture

```
┌─────────────── browser ───────────────┐     ┌──────── your server ────────┐
│  @page-assistant/widget                │     │  @page-assistant/server      │
│   • floating mascot + chat + voice     │     │   • LLM proxy (keys stay here)│
│   • page scanner ("read any page")     │ ──▶ │   • voice: ElevenLabs / Whisper│
│   • grounding loop runs HERE, so your  │     │   • /v1/agent  (agent-to-agent)│
│     real functions run locally         │     │   • /llm.txt   (agent discovery)│
└────────────────────────────────────────┘     └──────────────────────────────┘
                    │
              @page-assistant/core  (grounding brain, shared)
```

Capabilities run **in the page**, so results never round-trip through the model — that's what makes them trustworthy.

## Quick start

The packages are **not on npm yet** — this repo is the source of truth. Clone and
build; the widget bundle and all `dist/` output are produced locally (they're
gitignored).

### 1. Clone, build, run the backend (holds your API keys)

```bash
git clone https://github.com/philipposk/page-assistant.git
cd page-assistant
npm install && npm run build            # produces every package's dist/ (incl. the widget bundle)
cp .env.example packages/server/.env    # add an LLM key
npm run dev:server                      # http://localhost:8787
```

### 2. Open the demo page

`examples/demo.html` embeds the freshly-built widget and points it at the local
server. Open it in a browser (e.g. `open examples/demo.html`, or serve the repo root
with any static server). It loads the widget from the built path
`../packages/widget/dist/page-assistant.global.js` — so it only works **after
`npm run build`**.

### 3. Embed in your own app

```html
<!-- Local build (works today): copy the built bundle, or reference its dist path -->
<script src="/path/to/page-assistant/packages/widget/dist/page-assistant.global.js"></script>
<script>
  PageAssistant.init({
    serverUrl: "http://localhost:8787",
    appName: "Acme Assistant",
    voice: true,                         // browser voice; or { ttsMode: "server" } for ElevenLabs
    capabilities: [
      {
        name: "simulate_cross",
        description: "Simulate a breeding cross and predict yield and height.",
        parameters: { type: "object", properties: {
          a: { type: "string" }, b: { type: "string" }
        }, required: ["a", "b"] },
        run: ({ a, b }) => myApp.simulate(a, b),          // your REAL function
        render: (r, args) => `Yield ${r.yieldScore}/100, height ${r.heightLow}–${r.heightHigh} cm.`
      }
    ]
  });
</script>
```

In a bundler (React/Next/Vue): `import { PageAssistant, capability } from "@page-assistant/widget"`
(point the dependency at `file:...` until published).

### After publish (once on npm)

Once the packages are published, the same widget is available from a CDN and npm —
until then these will 404:

```html
<!-- available AFTER publish -->
<script src="https://unpkg.com/@page-assistant/widget/dist/page-assistant.global.js"></script>
```

```bash
# available AFTER publish
npm install @page-assistant/widget @page-assistant/server @page-assistant/core
```

## Reading any page (first-visit scan)

On first open the widget runs a same-origin scan (`fullScan()`): headings, nav links one level deep, and every interactive control with a stable selector. That map is fed to the model so the assistant understands apps it wasn't hand-integrated into. Integrated apps get it too — it just makes the assistant smarter about what's clickable.

## llm.txt — let other agents use your app

If you give the **server** your capabilities + metadata, it serves:

- `GET /llm.txt` — human/agent-readable description of the app and every action.
- `GET /.well-known/llm-actions.json` — machine manifest.
- `POST /v1/agent` — the **agent-to-agent endpoint**: another AI agent sends `{ message, page }` and drives your assistant, getting back the same grounded, validated results a human would.

These endpoints **only mount when you pass `capabilities` (and `llmTxt`) to
`createServer`**. The default proxy (`npm run dev:server`, or `page-assistant serve`
with no config) does not include them, so an out-of-the-box server returns 404 for
`/v1/agent` — that's why the CLI `chat` command and the MCP `ask_page_assistant` tool
need a capability-backed server. See [`examples/full-server.mjs`](./examples/full-server.mjs)
for a runnable one.

### Two capability lists — they do NOT carry over

There are **two separate places** you register capabilities, one per path:

| Path | Where capabilities live | Runs where |
|------|-------------------------|------------|
| On-page assistant | `PageAssistant.init({ capabilities })` (widget) | the **browser** |
| Agent-to-agent (`/v1/agent`, `llm.txt`) | `createServer({ capabilities })` (server) | your **server** |

The browser list and the server list are independent. Capabilities you pass to
`PageAssistant.init` are **not** visible to `/v1/agent` or `llm.txt`, and vice versa.
If you want both the on-page assistant and the external agent endpoint, register the
relevant actions in **both** places. (Server capabilities usually call your backend
directly; widget capabilities call your real in-page functions with the user's
session.)

## Voice

- **Free / default:** text-only replies; browser `SpeechRecognition` for mic input. Toggle read-aloud with the speaker button (🔈 / 🔊) in the panel.
- **Best quality:** built-in settings (gear icon) or `PageAssistant.mountVoiceSettingsPanel()` — pick ElevenLabs / OpenAI voices, browser vs server TTS/STT. Stored in `localStorage` (`page_assistant_voice_settings` by default).
- **Host override:** `onSettings` replaces the built-in modal; `settingsPageUrl` adds a link to your app settings page.
- **Barge-in:** talking over the assistant stops it instantly.
- **No silent mic:** if the browser has no `SpeechRecognition` and there is no `serverUrl`
  to send recorded audio to, the mic button renders visibly disabled with an explanation
  rather than doing nothing when tapped. Every other failure — refused permission, no
  device, a dead speech service — surfaces a readable message instead of nothing.
- **Two-way STT fallback (one retry each way).** Server STT unavailable falls back to the
  browser; a browser recogniser that is missing or whose service fails falls back to the
  server. The second matters on iOS, where `webkitSpeechRecognition` exists inside an
  installed PWA but does not work. The user is told which path is in use once, not on
  every tap.
- **`voiceDefaults`** sets this app's starting preferences — `shipped defaults <
  voiceDefaults < the user's stored settings` — so a host can start on server STT without
  bypassing the settings panel:

  ```js
  PageAssistant.init({ serverUrl, capabilities, voiceDefaults: { sttMode: "server" } });
  ```

## Language

The widget is English by default and stays that way unless you say otherwise.

```js
PageAssistant.init({
  serverUrl: "https://api.example.com",
  lang: "el-GR",                 // BCP-47: speech recognition, speech synthesis, Whisper, ElevenLabs
  strings: {                     // any subset; omitted keys keep their English default
    inputPlaceholder: "Ρωτήστε με κάτι…",
    confirm: "Επιβεβαίωση",
    cancel: "Άκυρο",
    voiceNoSpeech: "Δεν σας άκουσα — δοκιμάστε ξανά.",
  },
});
```

**`lang`** is resolved on every mic tap and every spoken reply, in this order:

1. the `lang` option — always wins when set;
2. `document.documentElement.lang`;
3. `navigator.language`;
4. `"en-US"`.

Set it explicitly if you know the language. `<html lang>` is a last resort only: a host can
render a fully translated UI while its root element still says `"en"`, and a recogniser told
the wrong language returns nothing at all — which used to surface as a mic button that
produced no transcript, no error and no message. Because it is resolved per call, a host that
flips `<html lang>` when the user switches language is followed on the next tap, no reload.

`lang` is applied to `SpeechRecognition`, to the chosen `speechSynthesis` voice (language
beats the `browserVoice` name hint across languages, so Greek text is not read by a US
English voice), to Whisper STT (`x-audio-lang` / `?lang=`) and to ElevenLabs TTS
(`language_code`).

**`strings`** overrides every user-facing string the SDK renders — the widget chrome
(placeholder, buttons, `aria-label`s, toasts, voice errors), the chat sidebar (search,
"+ New chat", the context menu, the rename prompt and delete confirmation) and both
settings modals (every label, option, hint and note).
`import { DEFAULT_STRINGS } from "@page-assistant/widget"` for the full key set. Blank
values are ignored rather than blanking a label, and a key this version does not know is
ignored rather than throwing — so a host written against an older SDK keeps English for
whatever was added since.

## Choosing the model

The settings panel only offers a model picker when there is a real choice to make.

```js
PageAssistant.init({
  serverUrl, capabilities,
  showModelPicker: "auto",  // default: ask the server
  // showModelPicker: false, modelFixedNote: "Το μοντέλο ορίζεται από τον διακομιστή.",
});
```

- `"auto"` (default) calls `GET /v1/models`, which returns `{ models, fixed, reason? }`.
  `@page-assistant/server` filters `models` to the providers it actually holds keys for and
  reports `fixed: true` when `PA_FIXED_MODEL` is set or there is at most one model to pick.
- `false` hides the picker outright — the right answer when your own server pins the model
  and ignores what the client asks. `modelFixedNote` replaces the explanation shown instead.
- `true` always shows it.

Set `PA_FIXED_MODEL` on `@page-assistant/server` to pin the model: the router then ignores
the client's `model` entirely, so a visitor cannot upgrade themselves onto a costlier one.

The stored default is `model: ""` — send no override and let the server use what it is
configured with. Naming a model the server has no key for is a hard error at send time.

## Deploying the server

The standalone `@page-assistant/server` is a small Node/Express proxy. A [`Dockerfile`](./Dockerfile)
is included — `node:22-alpine`, multi-stage (build → runtime), runs as a non-root user:

```bash
docker build -t page-assistant .
docker run -p 8787:8787 \
  -e OPENAI_API_KEY=sk-...          # or ANTHROPIC_API_KEY / OPENROUTER_API_KEY
  -e PA_AUTH_TOKEN=long-random \    # protect spend + agent routes
  -e PA_CORS_ORIGIN=https://yourapp.com \
  page-assistant
```

- **Port / env.** The server binds `PORT` (default `8787`) on all interfaces. All keys
  and tuning are env vars: LLM key, `PA_AUTH_TOKEN`, `PA_CORS_ORIGIN`, `PA_RATE_*`,
  `PA_DAILY_BUDGET`, `PA_TICKETS_FILE`. See [`.env.example`](./.env.example) and
  [SECURITY.md](./SECURITY.md).
- **Harden before exposing it.** Set **`PA_AUTH_TOKEN`** (bearer on spend + agent
  routes) and **`PA_CORS_ORIGIN`** to your real origin — the default `*` CORS and
  open (rate-limited-only) endpoints are for local dev, not production.
- **Run ONE instance** unless you move shared state out. The rate limiter, usage meter,
  daily budget, agent session memory, and analytics are **per-process in-memory**, and
  the JSON ticket file is last-writer-wins across replicas. Scaling horizontally without
  a shared limiter/store silently multiplies your limits and budget — see the
  [Scaling section in SECURITY.md](./SECURITY.md).
- **Graceful shutdown (SIGTERM).** The server bin handles `SIGTERM`/`SIGINT`: it stops
  accepting new connections and lets in-flight requests drain (force-exit after a 10s
  grace window), so a stop/redeploy doesn't cut active chats mid-response. Give the
  orchestrator at least ~10s of termination grace. Persisted tickets are also written
  atomically (temp file + rename), so a shutdown mid-write can't corrupt the ticket file.
- **The Docker image runs the plain proxy** (no `/v1/agent`, no `llm.txt`). To serve
  capabilities, run `page-assistant serve --config <your-config>` or import
  `createServer({ capabilities, llmTxt })` in your own entrypoint (see
  [`examples/full-server.mjs`](./examples/full-server.mjs)).

## Packages

| Package | What |
|---|---|
| `@page-assistant/core` | Grounding brain: capability registry, tool loop, validator, `llm.txt` generator. Runs in browser or Node. |
| `@page-assistant/widget` | The embeddable browser widget (UI, scanner, voice). |
| `@page-assistant/server` | Node backend: LLM proxy, voice, agent endpoint, `llm.txt` hosting. |
| `@page-assistant/cli` | Command line: `health`, `models`, `chat` (→ `/v1/agent`), `serve` a proxy (with optional `--config` for capabilities). |
| `@page-assistant/mcp` | MCP stdio server exposing the assistant to Cursor / Claude Desktop as `ask_page_assistant`. |

A dependency-free Python REST client also lives in `packages/python` (not yet on PyPI).

## Tests

```bash
npm test     # proves the anti-hallucination guarantees
```

## Publishing (maintainers)

Packages publish automatically from `.github/workflows/release.yml` when you push a
version tag:

```bash
# bump every package to the new version first (root + all 5 packages + internal pins),
# commit, then:
git tag v0.5.1 && git push --tags
```

The workflow builds, typechecks, tests, and `npm publish`es core → widget → server →
cli → mcp. It requires a repo secret **`NPM_TOKEN`** (an npm automation token with
publish rights to the `@page-assistant` scope). Versions that already exist on npm will
fail the publish, so always bump before tagging.

## License

MIT © Philippos Kontistakis

## For agents / integrators

- **[AGENTS.md](./AGENTS.md)** — read this first when embedding in another app
- **[INTEGRATION.md](./INTEGRATION.md)** — full setup checklist
- **[SECURITY.md](./SECURITY.md)** — production hardening
