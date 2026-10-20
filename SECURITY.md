# Security guide

## Threat model

Page-assistant sits in the browser with access to the user's session. Treat it as **a privileged UI** that can spend API credits and trigger actions on behalf of the signed-in user.

## Already guarded (library defaults)

| Layer | Protection |
|-------|------------|
| **Capability boundary** | Model can only call registered functions |
| **Confirm gate** | `confirm: true` capabilities stage until approved (user UI or agent gets `pendingConfirmation`) |
| **Factual validator** | Replaces prose that invents numbers tools didn't return |
| **Blind-mode clicks** | `open_page_link` requires confirm; exact label match only |
| **TTS** | Max 2000 chars per request |
| **STT** | Max 5MB audio (configurable `PA_STT_MAX_BYTES`) |
| **knowledgeUrl** | Widget fetches same-origin only |
| **Standalone server** | Per-IP rate limits; optional `PA_AUTH_TOKEN` bearer on spend + agent routes |
| **Tickets** | `GET /v1/feedback` behind bearer token |

## Host responsibilities (required in production)

### 1. Authenticate every spend endpoint

The widget's LLM/voice calls go through **your** backend. Use session auth (Supabase, NextAuth, etc.) — not a public URL.

Transcriber pattern: `getUserId()` → 401 if missing → `enforceRateLimit(req, "mcp", userId)`.

### 2. Capabilities must enforce permissions

`run()` must call the same APIs your UI uses. Never trust the model to "only read" — if a capability exists, assume it will be called.

### 3. Use `confirm: true` on risky actions

Deletes, payments, sends, admin changes, checkout, irreversible navigation.

### 4. Standalone `@page-assistant/server` hardening

```env
PA_AUTH_TOKEN=long-random-secret      # required in production
PA_CORS_ORIGIN=https://yourapp.com    # not *
PA_RATE_LLM=30
PA_RATE_VOICE=20
PA_RATE_AGENT=10
```

Pass `authToken` in `PageAssistant.init()` when using `PA_AUTH_TOKEN`, or prefer host session auth instead.

### 5. Agent endpoint (`/v1/agent`)

- Behind auth in integrated apps (user-scoped capabilities)
- Confirm-required capabilities return `pendingConfirmation` — they do not auto-execute for agents
- Rate-limit aggressively; agents can loop

### 6. Prompt injection

Scanned page text and `knowledgeUrl` content enter the system prompt. Mitigations: capability boundary, confirm gates, validator. Do not register overly broad capabilities (e.g. "run arbitrary SQL").

### 6a. Agent mode (`@page-assistant/server/agent`, `/next`)

- **`getUser` is required** and must check your real session; no user → 401. Every turn spends
  model credit and every tool acts as that user.
- **Tools run outside your HTTP routes**, so each must enforce permissions itself. Hand them a
  client that acts as the user (`context`, e.g. a Supabase client with the user's session) so
  row-level security does most of it.
- **`risk: "confirm"` for anything that can't be undone** (delete, send, pay, export, invite).
  A model call only creates a card; the action runs from the card's token: random, stored only
  as a SHA-256 hash, single use (atomic delete), bound to the user, 10-minute lifetime, re-checked
  against the tool's schema and `enabled` flag, and run as the *clicking* request's user. The
  model is not involved in a confirm.
- **On serverless, keep cards in a shared store** (`supabasePendingActionStore` with a
  service-role client). `assistant_pending_actions.sql` gives users no access to the table on
  purpose: a user who could insert rows could mint a card with arguments the server never
  checked.
- **`taints: true` on every tool that returns text someone else wrote** (messages, documents,
  web pages). After such a read nothing changes without a card — for the rest of the turn and
  for every later turn while that reply is still in the history the model reads (the reply says
  `tainted: true`, the dock tags it in the history it sends back and in saved chats). `write`
  tools are refused or turned into a card (`confirmWhenTainted`), and the reply's markdown is
  cleaned: no images, raw HTML or in-text links except addresses a tool result wrote word for
  word (a planted link could carry data out). The cleaner is linear-time and capped at 50 KB.
- **CSRF**: the agent and voice routes take JSON only and refuse requests from another site
  (`Sec-Fetch-Site`, else `Origin` vs host), unless `corsOrigin` names that origin. Sibling apps
  on one domain share cookies (`SameSite=Lax`), so this matters on `*.6x7.gr`.
- **Stop means stop**: the request's signal (Stop, a closed tab) is checked before every model
  call and every tool, and cancels the provider request; nothing queued runs after it.
- **Bounded input**: request bodies are read with a byte cap before parsing (also in
  `toNodeHandler`, before sign-in runs); a voice id is accepted only as `[A-Za-z0-9_-]{1,64}`.
- **UI actions are view-only**: in-app paths only, never `/api/...` or a sign-out path (checked
  on the server and again in the browser), `point_at` only to registered pages, highlights by
  anchor name only (never a selector), custom types validated against the schema you register.
- **A confirmed run gets only its stored arguments** — not the page state at click time, which
  may differ from what the card showed.
- The built-in per-user rate limit is in memory (per instance on serverless); put a shared
  limit in front (Upstash, the database) for a hard cap, via `rateLimit: (user) => ...`.

### 7. Memory (localStorage)

`remember_fact` persists in the browser. Do not store secrets, tokens, or PCI data via memory capabilities.

## Scaling: state is per-process (run one instance, or share state)

The standalone `@page-assistant/server` keeps most of its safety and accounting state
**in the memory of a single process**. It is **not** shared across replicas. If you run
two or more instances behind a load balancer, each one enforces limits independently:

| State | Where it lives | What breaks with N replicas |
|-------|----------------|-----------------------------|
| **Rate limiter** (per-IP) | in-memory, per process | Effective limit is up to N× your configured value — a caller spread across replicas gets N buckets |
| **Usage meter** (`/v1/usage`, dashboard) | in-memory, per process | Each replica reports only its own slice; totals are fragmented |
| **Daily budget** (`PA_DAILY_BUDGET`) | in-memory, per process | Real spend can reach N× the cap before any single replica trips it |
| **Agent session memory** | in-memory, per process | A follow-up request routed to a different replica loses conversation context |
| **Analytics counters** | in-memory, per process | Split across replicas |
| **Ticket store (JSON file)** | shared file, **last-writer-wins** | Atomic rename prevents *torn* writes, but concurrent writers can still **lose** each other's updates |

**Guidance — decide this before you scale out:**

- **Simplest correct option: run exactly ONE instance.** All limits, budgets, and the
  usage meter then mean what they say. Vertical scaling goes a long way for a proxy.
- **If you must run multiple instances**, move the enforcement that has to be global
  into a **shared layer**:
  - **Rate limiting** → do it at the edge (Cloudflare / nginx `limit_req` / API gateway),
    or back it with Redis, instead of relying on the in-process limiter.
  - **Daily budget / usage** → track spend in a shared store (Redis, your DB), not the
    in-memory meter.
  - **Agent session memory** → use sticky sessions, or externalize the session store.
  - **Tickets** → use a real datastore (DB) rather than the JSON file if writes are
    concurrent and you cannot afford lost updates.

The library ships the single-instance in-memory versions by design (zero infra to
start). Scaling horizontally is a host responsibility.

## Reporting

File security issues via GitHub private disclosure on [page-assistant](https://github.com/philipposk/page-assistant).
