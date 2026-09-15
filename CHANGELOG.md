# Changelog

All notable changes to page-assistant. This project follows [semantic versioning](https://semver.org).

## Unreleased

Lessons from running a page assistant in production, generalised. No version bump.

### Capabilities

- **Schemas are checked at registration.** `new Assistant()` — and so `PageAssistant.init`
  and `createServer` — throws a `CapabilitySchemaError` listing every problem: a
  list-valued `"type"` (`["number", "null"]`), a name registered twice, a `required` key
  missing from `properties`, or a name providers reject. The whole tool list goes out on
  every turn, so one bad schema failed every message. The list-valued form also made the
  argument check refuse every value for that field, and a duplicate name silently replaced
  the first capability. Optional arguments already accept `null`.
  `capabilitySchemaProblems()` returns the same list without throwing.
- **`enabled`**, a boolean or a function re-read every turn. When off, the capability is
  left out of the tool list, forced routing, `llm.txt` and the actions manifest, and a
  stale call or `confirmAndRun` is refused instead of run. A flag that throws counts as
  off. For feature flags, plan tiers and backends that may not be configured.

### Routing

- **Forced routing never picks a `confirm: true` capability.** "How many orders would
  archiving touch?" was routed to the archive action and answered with a confirmation card.
- **Keyword overlap matches at word starts.** "rate" no longer counts inside "generate",
  nor "late" inside "template"; plurals and inflections still match.
- **`forcedRouting`**: `false` turns the heuristic off, a function replaces it. A name
  that is not a registered, enabled capability is ignored rather than forced.

### What the assistant says

- **Replies are scrubbed.** Every user-facing message — model prose, `render()` output,
  the raw error of a failed `run()` — and error text sent back to the model passes through
  `scrub` rules. `DEFAULT_SCRUB_RULES` covers connection strings, provider and cloud
  tokens, JWTs, bearer headers, and environment variable names with a configuration
  suffix (`…_API_KEY`, `…_URL`, `…_ENABLED`, …), so a status like `IN_PROGRESS` is left
  alone. Extend it with your own internal terms, or pass `scrub: false`. The widget adds
  `PLAIN_TEXT_SCRUB_RULES` because it renders replies as plain text, where `**` showed
  literally. The system prompt gains a matching rule.
- **`assistantName`**, separate from `appName`: the model introduces itself by it and
  answers "who are you" with it. Carried in `llm.txt` and as `app.assistantName` in the
  actions manifest; the widget uses it as the panel title when set.
- **`vocabulary`**: the real values in the user's workspace (tags, statuses, projects)
  and a glossary of their words, placed in the system prompt with a rule to map loose
  wording onto the closest real value or ask. Static, or a loader cached per instance
  (and per `key`) for 60 s by default. Best-effort: a loader that throws or takes longer
  than 3 s is skipped for that turn and not cached. Values are one line each and the
  block is bounded.

### Chat history

- **Three modes, chosen by the user in the Data tab:** `"account"` (saved through a host
  adapter, synced across devices), `"device"` (localStorage, the default and the old
  behaviour) and `"off"` (this page only). New init options: `chatHistoryMode` (the default
  until the user picks), `chatHistoryAdapter`, `chatHistoryFallbackMode` and
  `onChatHistoryError`; `PageAssistant.refreshChatHistory()` after a sign-in or sign-out.
  The choice is remembered in the browser per signed-in user.
- **`ChatHistoryAdapter`**, implemented by the host: `list`, `get`, `save`, `delete`,
  `deleteAll`, and optionally `currentUserId`, `saveMany`, `retentionMonths`. The widget never
  talks to a database. Without an adapter, or with nobody signed in, account falls back and
  settings says why.
- **Moving and leaving.** Switching to account offers to move the user's own device chats
  (removed locally only once saved). Leaving account deletes nothing; "Delete all my chats"
  empties the user's device chats and, when someone is signed in, the account.
- **Device chats are kept per person.** When the adapter's `currentUserId()` names the user,
  their device chats live under `${storageKey}:user:${id}`; the plain `storageKey` is the
  signed-out slot. Each person sees only their own slot — after a sign-out, a sign-in or a
  change of user, and not even briefly on page load (with such an adapter, device chats load
  once the sign-in check finishes). "Move my chats" moves only the user's own. Signed-out
  chats are offered separately, worded as "made while signed out on this device", and move
  only on that explicit choice (into the account, or into the user's own device chats).
  `moveDeviceChats({ from: "signed-out" })`, `ChatHistoryState.signedOutDeviceChatCount`,
  `deviceStorageKey()` and `historyMoveOffers()` expose this; three new strings.
- **Moving counts as activity.** A moved chat is saved with `updatedAt` set to the moment of
  the move (`createdAt` keeps its real age), so account retention runs from the move. Before,
  a chat older than the retention window was hidden and pruned right after the user was told
  it was moved, and its device copy was already gone.
- **Safe by construction:** empty chats are never saved; a chat listed without messages is
  fetched before it is saved, so a rename cannot blank it; writes waiting when the user
  signs out or changes are dropped, never sent as the next person.
- **A reply in flight never lands in the next person's chats.** The question and its answer
  used to be written wherever the page pointed when the answer arrived: after a sign-out,
  the signed-out chats the next visitor sees; after another account signed in, that
  account. Now the widget notes the chat and the signed-in user when it sends, and drops a
  reply (or its error, and a confirmed action's result) if either changed meanwhile —
  including when the user opened another chat. Nothing is pushed, saved or shown; a toast
  (`historyReplyDiscarded`, one new string) says a reply was discarded.
- **`offerSignedOutChats`** (default `true`). `false` never offers, counts or moves the chats
  made in the browser while signed out: for apps used on shared computers.
- **Reference Supabase adapter** (`supabaseChatHistoryAdapter`) and migration
  (`packages/widget/supabase/assistant_chats.sql`, now shipped in the package): row-level
  security with every policy `auth.uid() = user_id`, no anon access, timestamps that cannot
  be set in the future, and a 12-month inactivity sweep scheduled with pg_cron when it is
  enabled, with a documented fallback. Rows are keyed on `(user_id, app, id)` and the
  adapter upserts on exactly that, so apps sharing the table never overwrite each other's
  chat with the same id (the first draft keyed on `(user_id, id)`).
- 26 new strings for the history section; `ChatHistoryStore` gains memory-only storage and
  an `onChange` feed.

### Upgrade notes

- A host whose capabilities have one of the schema problems above now fails at startup
  with the list, instead of misbehaving per turn.
- Replies that contained one of the default scrub patterns now read differently;
  `scrub: false` restores the old output.
- Chat history is unchanged unless you pass the new options: still `"device"`, same
  storage key. The Data tab now shows the history choice, and its hint default changed to
  "Export your chats to a file, or import a backup." (the old one claimed data never left
  the browser, which account mode makes untrue). A translated `settingsDataHint` is kept.
- Chats saved by earlier versions stay under the plain `storageKey`, now the signed-out slot.
  Without an adapter, or with one that has no `currentUserId`, nothing moves. With one that
  names users, a signed-in user no longer sees those chats as theirs; settings offers to add
  them, worded as signed-out chats (unless `offerSignedOutChats: false`).
- Applied an earlier copy of `assistant_chats.sql` (primary key `(user_id, id)`)? Re-run the
  updated file — it re-keys the table only when it finds the old key — or add a migration:

  ```sql
  alter table public.assistant_chats drop constraint assistant_chats_pkey;
  alter table public.assistant_chats add constraint assistant_chats_pkey primary key (user_id, app, id);
  ```

  Existing rows keep their `app` (default `''`), so nothing is lost. Update the adapter at the
  same time: an old adapter's `onConflict: "user_id,id"` has no matching key afterwards.

## 0.5.1 — The rest of the translation, a themed panel, and an honest model picker

Found by running 0.5.0 in a live Greek app. 0.5.0 translated the widget chrome and left
the sidebar and both settings modals in English, which reads worse than the fully-English
widget did — it looks broken rather than untranslated.

### Localisation finished

- **`strings` now covers the chat sidebar and both settings modals**, not just `ui.ts`:
  the search placeholder, "Collapse sidebar", "+ New chat", "No chats yet", the
  Pinned/Recent/Archived section headings, `Actions for "…"`, every context-menu item, the
  rename prompt and the delete confirmation — plus every label, option, hint and note in
  the voice modal and all three tabs of the extended settings modal.
- 70 new keys, same rules as before: flat, English defaults, blank overrides ignored.
- **A key a host has never heard of falls back rather than failing.** `resolveStrings` now
  ignores keys that are not part of the current set instead of merging them in, so a host
  written against 0.5.0 (which knows none of the new keys) keeps English for the rest, and
  one written against a later version does not inject stray keys into this one.
- Three controller messages that were still hardcoded are now overridable: "Cancelled.",
  "Previous pending action cancelled.", and the cross-origin knowledge-fetch notice.

### The settings modal follows the host's theme

- Both settings surfaces painted themselves with hardcoded dark greens (`#e7f5ec` on
  `#0b1310`, `#244234` borders) regardless of the app around them, so a light-themed app
  opened a black-green modal beside its own chrome — and a host that had explicitly set
  `theme: "light"` got one anyway. They now use the widget's `--pa-*` theme tokens and
  follow the stored light/dark/system choice, re-theming live when it changes or when the
  OS flips under `system`.
- They also set `color-scheme`, so the native `<select>` popups, checkboxes and focus
  rings match instead of rendering white dropdowns over dark rows.
- New tokens: `--pa-accent-hover` and `--pa-bg-elevated`. The voice modal's duplicated
  copy of the panel stylesheet is gone — both surfaces share one themed sheet.

### The model picker no longer lies

- **Refreshed the list.** Ids are exact and carry no date suffix. Out: Claude Sonnet 4
  (`claude-sonnet-4-20250514`), Claude 3.5 Haiku, and the date-suffixed
  `claude-haiku-4-5-20251001`. In, newest first: **Claude Opus 5** (`claude-opus-5`),
  **Claude Sonnet 5** (`claude-sonnet-5`), **Claude Haiku 4.5** (`claude-haiku-4-5`) and
  **Claude Fable 5.1** (`claude-fable-5-1`), then the GPT-4o pair and an OpenRouter route.
- **A dead control is no longer shown.** `showModelPicker` widens from `boolean` to
  `boolean | "auto"` and now defaults to `"auto"`, which asks the server. `false` still
  hides it outright — the answer for a host whose own server pins the model and ignores
  what the client sends.
- **`GET /v1/models` answers the question.** It now returns `{ models, fixed, reason? }`,
  filters `models` to the providers the server actually holds keys for, and reports
  `fixed: true` when `PA_FIXED_MODEL` is set or when there is at most one model to choose
  between. One option is not a choice.
- **`PA_FIXED_MODEL` is enforced, not advertised.** When set, the router ignores the
  client's `model` outright, so a visitor cannot upgrade themselves onto a costlier one.
- **The default model is now "let the server choose"** (`model: ""`, sending no override).
  It was `gpt-4o-mini`, so every widget named an OpenAI model even against an
  Anthropic-only server — which the router rejects with a hard error. The picker gains an
  explicit "Server default (recommended)" option, and a stored model the server no longer
  offers falls back to it instead of rendering a blank box.

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

### Every mic path now ends in something the user can read

- **The mic button is disabled when nothing can back it** — no `SpeechRecognition` and no
  `serverUrl` for server STT — with a `title`/`aria-label` saying why. A button that
  silently does nothing was the whole shape of the reported bug.
- **STT falls back in both directions, once each.** Server → browser existed; browser →
  server is new and is the one that matters on iOS, where `webkitSpeechRecognition` is
  present inside an installed PWA / WKWebView but its service does not work. A single
  retry, never a loop, and the user is told which path is being used once per session
  rather than on every tap.
- **New `"service"` error reason**, separating "the speech service failed" from "the user
  refused the microphone". Only the former is retried through the server — a refused mic
  would fail identically there. `VoiceErrorReason` gains `"service"`; a caller switching on
  it with a default branch is unaffected.
- **`listenServer()` no longer resolves `""` when there is no server**, and a missing
  recogniser with no server throws instead of resolving empty. Those empty resolves were
  how a mic tap ended in no transcript, no error and no message.

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

### Host-settable voice defaults

- **`voiceDefaults?: Partial<VoiceSettings>` on `PageAssistantConfig`**, layered
  `shipped defaults < voiceDefaults < the user's stored settings`. A host can say "start
  with server transcription on this app" while a user who picks something else in the
  settings panel still wins. Passing a full `VoiceOptions` object to `voice` bypasses the
  settings UI and its change listener, so the user's own preferences stop applying — this
  is the way to set a default without that.
- The shipped `DEFAULTS` are unchanged: browser (free) STT stays the default, so no app is
  moved onto a paid path by a version bump. `setVoiceDefaults` / `getVoiceDefaults` are
  exported for hosts that configure voice outside `init`.

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
