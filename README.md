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

### 1. Run the backend (holds your API keys)

```bash
npm install && npm run build
cp .env.example packages/server/.env   # add an LLM key
npm run dev:server                      # http://localhost:8787
```

### 2. Embed the widget

```html
<script src="https://unpkg.com/@page-assistant/widget/dist/page-assistant.global.js"></script>
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

In a bundler (React/Next/Vue): `import { PageAssistant, capability } from "@page-assistant/widget"`.

## Reading any page (first-visit scan)

On first open the widget runs a same-origin scan (`fullScan()`): headings, nav links one level deep, and every interactive control with a stable selector. That map is fed to the model so the assistant understands apps it wasn't hand-integrated into. Integrated apps get it too — it just makes the assistant smarter about what's clickable.

## llm.txt — let other agents use your app

If you give the server your capabilities + metadata, it serves:

- `GET /llm.txt` — human/agent-readable description of the app and every action.
- `GET /.well-known/llm-actions.json` — machine manifest.
- `POST /v1/agent` — the **agent-to-agent endpoint**: another AI agent sends `{ message, page }` and drives your assistant, getting back the same grounded, validated results a human would.

## Voice

- **Free / default:** browser `SpeechSynthesis` (out) + `SpeechRecognition` (in).
- **Best quality:** set `voice: { ttsMode: "server" }` to route through ElevenLabs Flash (TTS) and Whisper (STT) on the backend.
- **Barge-in:** talking over the assistant stops it instantly.

## Packages

| Package | What |
|---|---|
| `@page-assistant/core` | Grounding brain: capability registry, tool loop, validator, `llm.txt` generator. Runs in browser or Node. |
| `@page-assistant/widget` | The embeddable browser widget (UI, scanner, voice). |
| `@page-assistant/server` | Node backend: LLM proxy, voice, agent endpoint, `llm.txt` hosting. |

## Tests

```bash
npm test     # proves the anti-hallucination guarantees
```

## License

MIT © Philippos Kontistakis
