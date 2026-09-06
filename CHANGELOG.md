# Changelog

All notable changes to page-assistant. This project follows [semantic versioning](https://semver.org).

## 0.5.0 — Language, and controls that tell the truth

The mic was hardcoded to `en-US` and every label in the widget was hardcoded English. In a
Greek app that meant a mic button that returned nothing (a recogniser told the wrong
language hears nothing it can transcribe) inside an English chrome wrapped around Greek
replies. This release makes both the language and the chrome the host's to set. All
packages bumped `0.4.0 → 0.5.0` together.

### Language

- **`lang` on `PageAssistantConfig` and `VoiceOptions`** (BCP-47, e.g. `"el-GR"`). Applied
  to `SpeechRecognition`, to `speechSynthesis`, to Whisper STT and to ElevenLabs TTS, and
  set on the widget's host element for assistive tech.
- **Resolved per call, not at module load:** the explicit option first, then
  `document.documentElement.lang`, then `navigator.language`, then `"en-US"`. A host that
  flips `<html lang>` when the user switches language is followed on the next mic tap with
  no reload. An explicit `lang` always wins — `<html lang>` is only a last resort, because
  a host can render a fully translated UI while its root element still says `"en"`.
- **Speech synthesis picks by language before name.** `browserVoice: "Samantha"` is an
  en-US voice; reading Greek with it is unintelligible. A voice matching the target
  language now wins across languages, while the name hint still wins inside the same
  language (an app that asked for "Daniel" keeps Daniel while the page is in English).
- **Server voice takes the hint.** The widget sends `x-audio-lang` (and `?lang=`) with the
  STT upload and `lang` in the TTS body. `transcribe()` passes `language` to Whisper
  instead of letting it guess from a 4-second clip; `synthesize()` passes `language_code`
  to ElevenLabs. `transcribe(audio, hint, env)` still accepts its old string second
  argument, so existing callers are untouched.

### Localisable chrome

- **`strings` on `PageAssistantConfig`** — a flat `Partial<WidgetStrings>` overriding the
  input placeholder, every button, every `aria-label` and `title`, the toasts, `Confirm` /
  `Cancel` / `Retry` / `Try:`, the page-scan status, and the voice error messages
  ("I didn't catch that…", "Microphone permission denied…", the server-STT fallback
  notice). Omitted keys keep their English default; blank values are ignored rather than
  blanking a label. `DEFAULT_STRINGS` and the `WidgetStrings` type are exported.
- Deliberately not an i18n framework: no locale negotiation, no plural rules, no message
  files. The host already knows what language it is in.
- Chat-sidebar labels (rename prompt, search, context menu) are not covered yet.

### A control that cannot work is not shown as one

- **The mic button is disabled when nothing can back it** — no `SpeechRecognition` and no
  `serverUrl` for server STT — with a `title`/`aria-label` saying why. A button that
  silently does nothing was the whole shape of the reported bug.

### UX

- **The read-aloud toggle is a speaker, not a telephone.** `☎` read as "call support"
  rather than "speak this reply"; the launcher's telephone had already been replaced with
  a choosable mark and this second one was missed. On (`🔊`) and off (`🔈`) are different
  marks, not just a colour change.
- **Page-scan chatter is a transient toast, not permanent chat messages.** "Reading this
  app…" and "Ready — mapped 6 pages, 22 controls." used to sit in the transcript forever,
  in English among translated replies; the count was developer telemetry that meant
  nothing to the people using these apps. Both now pass through `strings`, and the counts
  are gone from the UI.

### Reconciled branches

- `verbatim` (a capability whose `render()` replaces the model's prose, for figures that
  only mean something beside their label) and the choosable launcher mark are now on the
  same line as the 0.4 hardening. Neither branch contained the other.

## 0.4.0 — Production hardening

A hardening release across security, reliability, UX, accessibility, and distribution,
plus two new capabilities. All packages bumped `0.3.0 → 0.4.0` together.

### New features

- **Server-capability–aware voice settings.** The extended settings modal fetches
  `GET /v1/voice/capabilities` and greys out server TTS/STT (ElevenLabs · OpenAI ·
  Whisper) the server has no key for, so users can't pick a voice that silently falls
  back to the browser. Degrades gracefully to browser-only if the endpoint is missing.
- **CLI `serve --config` + runnable full-server example.** `page-assistant serve` can
  now load a config module/JSON to mount `/v1/agent`, `/llm.txt`, and
  `/.well-known/llm-actions.json`. New `examples/full-server.mjs` starts a
  capability-backed server so the agent-to-agent journey works out of the box.

### UX & accessibility

- Fixed the extended settings modal not revealing the Provider/Voice rows when
  switching the speech engine to Server TTS — it now re-renders on both the assistant
  and voice settings change events instead of requiring a modal reopen.
- Added a note that models depend on the server's configured providers; an unsupported
  model errors at send time rather than failing silently.

### Reliability

- CLI `serve` now loads a local `.env` and persists feedback tickets to disk
  (`JsonFileTicketStore`), matching the server bin instead of losing tickets on restart.
- CLI `chat` and the MCP `ask_page_assistant` tool now return a clear message when
  `/v1/agent` is not mounted (404) instead of an opaque error.
- CLI and MCP report their real version from `package.json` instead of a hardcoded
  literal.
- **Fixed `serve --config` crash.** `examples/full-server.mjs` started its own server at
  import time and exported no config, so `page-assistant serve --config ./examples/full-server.mjs`
  raced a second, capability-less server onto the same port and died with `EADDRINUSE`.
  The example now `export default`s its config and only self-boots when run directly; the
  CLI reads that config so `/v1/agent` + `/llm.txt` actually mount.
- **Clean port-in-use errors.** CLI `serve` prints a one-line, actionable message and
  exits 1 on `EADDRINUSE` instead of dumping a stack trace (the server bin already did).
- **Graceful shutdown.** The standalone server drains in-flight requests on
  `SIGTERM`/`SIGINT` before exiting (force-exit after a 10s grace window), so a
  deploy/restart doesn't cut active chats mid-response.
- Anti-hallucination validator: closed a gap where invented numbers could slip past the
  factual check; VAD-based mic capture and result highlighting hardened in the widget.

### Security

- Documented the dual capability-registration model (browser vs server) so integrators
  don't assume widget capabilities reach `/v1/agent`.
- Hardening guidance carried forward in SECURITY.md (auth on spend endpoints, confirm
  gates, rate limits, CORS), plus a clean auth seam (`bearerAuth`) on spend + agent routes.
- **Multi-instance / scaling caveat documented.** SECURITY.md now spells out that the
  rate limiter, usage meter, daily budget, agent session memory, and analytics are
  per-process in-memory and the JSON ticket file is last-writer-wins across replicas —
  run one instance or move that state to a shared layer. INTEGRATION.md links to it.

### Distribution

- Added `prepublishOnly: npm run build` to core/widget/server/cli/mcp so the gitignored
  `dist/` is always built before publish.
- Added `repository` (with `directory`) to the CLI and MCP packages.
- Honest README quick start: clone → `npm install && npm run build` → open
  `examples/demo.html`; unpkg/npm paths clearly marked as post-publish.
- Per-package READMEs for core/widget/server/cli/mcp (the npm package pages) and a
  Python client README.
- Added cli + mcp to the README packages table; documented the MCP server in AGENTS.md.
- CI adds a typecheck step; `release.yml` now runs the server test suite and a typecheck
  before any publish, and CI uses `npm ci` (lockfile in sync).
- Publishable packages now ship `LICENSE` + `README.md` in their npm tarballs, and all
  `package.json` files declare `engines.node >= 20.6.0`.
- **Deployment story.** Added a multi-stage `Dockerfile` (`node:22-alpine`, non-root
  runtime) and a "Deploying the server" section in the README covering PORT/env, the
  single-instance caveat, SIGTERM grace, and CORS/auth hardening.
- Removed the empty `examples/greenpert` and `scripts/` directories and stray `.DS_Store`.

## 0.3.0

Production-ready baseline: chat history, distribution scaffolding, security hardening,
voice fixes, live memory, blind-mode actions.
