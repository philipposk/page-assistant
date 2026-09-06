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
