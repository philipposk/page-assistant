# v0.2 review — findings and resolutions

Full audit of v0.1 (independent reviewer pass + manual audit), with what was fixed on this
branch and what is deliberately left as a documented trade-off.

## Fixed on this branch

### Security
| # | Finding | Fix |
|---|---|---|
| S1 | `/v1/llm/complete`, `/v1/voice/*`, `/v1/agent`, `/v1/feedback` had **no rate limiting** — anyone could drain the host's LLM/ElevenLabs credit. | Per-IP fixed-window limiter on all of them (`PA_RATE_LLM/VOICE/AGENT/FEEDBACK`, sane defaults). |
| S2 | Spend endpoints had **no auth option**. | Optional `PA_AUTH_TOKEN` bearer gate on `/v1/llm/complete` + `/v1/voice/*` (and ticket reads). Unset = dev mode, warned at boot. |
| S3 | `GET /v1/feedback` exposed all tickets publicly. | Behind the bearer token. |
| S4 | Ticket `context` accepted arbitrary object shapes (hostile payload smuggling). | Sanitized to known string fields, length-clamped. |
| S5 | TTS accepted unbounded text (cost amplification). | 400 over 2000 chars; STT 400s on empty/non-buffer body instead of transcribing silence. |

### Bugs
| # | Finding | Fix |
|---|---|---|
| B1 | Mic stuck forever: SpeechRecognition ends on silence with neither result nor error — promise never resolved. | Settle on `onend` + 12s hard timeout. |
| B2 | `listenServer` leaked the mic stream on error and could hang if `onstop` never fired. | `try/finally` track cleanup; `onstop` attached before `stop()`, raced with timeout. |
| B3 | Browser TTS could hang (cancel/backgrounded tab drops events) leaving mascot in "talking". | `onend`+`onerror`+length-scaled safety timeout, settle-once. |
| B4 | `handleConfirm`/`say`/`toggleMic` had no error handling — one throw froze the UI state. | try/catch/finally everywhere state changes. |
| B5 | Stale `pendingConfirmation` could fire long after the user moved on. | Typing a new message cancels the staged action visibly. |
| B6 | Confirm prompt grammar broken ("This will delete a note. confirm…"). | "Confirm this action? <description>". |
| B7 | Validator flagged honest roundings ("20.7" → "21") and comma formats ("1,200") as invented. | Tolerance for round/`toFixed(1)`/±0.05 variants and comma stripping. |
| B8 | `feedbackEndpoint` advertised a relative path when no `llmTxt.appUrl` set. | Absolute when appUrl exists; relative fallback documented as same-origin-only. |
| B9 | Widget reached into UI internals via `(this.ui as any).launcher`. | Proper `onToggle` handler; also stops speech when panel closes. |

### Features (new)
- **Memory is now real**: relevant facts are recalled into the system prompt every turn
  (was dead code), the assistant can `remember_fact`, and the widget persists memory in
  localStorage across visits (`memory: "session"` to opt out).
- **Blind-mode actions**: built-in `open_page_link` + `rescan_page` capabilities let the
  assistant DO things on pages with zero registered capabilities, using only scanned controls.
- **File-backed ticket store** (`JsonFileTicketStore`) so feedback survives restarts without a DB.
- **CI**: GitHub Actions build + full test suite on every push/PR.
- Widget UX: close button, input autofocus on open, ARIA labels/dialog role, mic error message.

## Known limitations (deliberate, documented)

1. **Tool results are threaded as plain text**, not native `tool_use`/`tool_result` blocks.
   Works reliably with forced tool choice + the validator, but native threading would improve
   multi-round behavior. Planned for v0.3 (needs tool-call IDs through `ChatMessage`).
2. **Validator ignores numbers ≤ 4** to avoid false-positives on list numbering ("1.", "2.").
   A model could therefore invent a small count. The capability `render()` text remains the
   trusted source shown for factual answers; treat model prose around small counts as narrative.
3. **Prompt injection surface**: scanned page text and fetched `knowledgeUrl` content go into
   the system prompt. A hostile page could try to steer the assistant. Mitigations already in
   place: the capability boundary (it can only call registered functions), the confirm gate on
   destructive actions, and the factual validator. Don't register dangerous capabilities
   without `confirm: true`.
4. **CORS defaults to `*`** for drop-in DX. Production deployments should set
   `PA_CORS_ORIGIN` to the host origin and set `PA_AUTH_TOKEN`.
5. **Rate limiting is per-IP in-process** — fine for one instance; use an upstream limiter
   (Cloudflare, nginx) for multi-instance deployments.
