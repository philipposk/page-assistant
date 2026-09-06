import { createRequire } from "node:module";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import {
  Assistant,
  InMemoryStore,
  generateLlmTxt,
  generateActionsJson,
  MemoryTicketStore,
  makeTicketFloodGuard,
  normalizeTicket,
  ticketsFromRun,
  feedbackWellKnown,
  type Capability,
  type LLMProvider,
  type LlmTxtMeta,
  type MemoryStore,
  type TicketStore,
} from "@page-assistant/core";
import { routerFromEnv, AVAILABLE_MODELS } from "./llm/router.js";
import { HttpProviderError } from "./llm/errors.js";
import { synthesize, transcribe } from "./voice.js";
import { rateLimit, bearerAuth } from "./ratelimit.js";
import { envInt, envBool, trustProxySetting, log } from "./env.js";
import { UsageMeter, usageDashboardHtml } from "./usage.js";

// Read our own version from package.json instead of hardcoding it.
const SERVER_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export interface ServerConfig {
  /** LLM provider; defaults to env-based router. */
  llm?: LLMProvider;
  /**
   * Server-side capabilities. Powers the external agent endpoint (/v1/agent) — the
   * "assistant living on the app" that other agents talk to. Optional: a pure widget
   * deployment can omit these and run grounding client-side instead.
   */
  capabilities?: Capability[];
  /** Metadata for the generated llm.txt / actions.json. */
  llmTxt?: LlmTxtMeta;
  /** CORS allowed origin. Default "*". */
  corsOrigin?: string;
  appName?: string;
  persona?: string;
  /** Where improvement tickets are stored. Default in-memory. */
  ticketStore?: TicketStore;
  /** Background knowledge (README/docs) injected so the assistant understands the app. */
  knowledge?: string;
  /** Suggested prompts the assistant offers proactively. */
  suggestions?: string[];
  /** Which discovery files to serve. All default true. */
  expose?: { robotsTxt?: boolean; llmTxt?: boolean; llmActions?: boolean };
}

/** Client-facing error text — never leaks raw provider bodies. */
function genericError(status: number): string {
  if (status === 429) return "The assistant is busy right now. Please try again shortly.";
  if (status >= 500) return "The upstream AI provider is unavailable right now. Please try again shortly.";
  return "The request could not be completed.";
}

/** Map any thrown error to a safe client message while logging the real cause server-side. */
function handleError(res: Response, e: unknown, route: string, reqId: string): void {
  // Always 502 to the client for upstream failures: a bad provider key or malformed body
  // is OUR config problem, not the caller's, and the raw provider text must not leak.
  const status = 502;
  if (e instanceof HttpProviderError) {
    log("error", { reqId, route, msg: e.message, errType: "HttpProviderError", provider: e.provider, providerStatus: e.status, detail: e.detail.slice(0, 500), stack: e.stack });
  } else {
    // Include the stack server-side only (never in the client response) so an unexpected
    // failure is actually diagnosable from logs instead of a bare one-line message.
    log("error", { reqId, route, msg: e instanceof Error ? e.message : String(e), errType: e instanceof Error ? e.name : "Error", stack: e instanceof Error ? e.stack : undefined });
  }
  res.status(status).json({ error: genericError(status) });
}

/** Build an Express app exposing the page-assistant backend. Mount or listen() it. */
export function createServer(config: ServerConfig = {}): Express {
  const app = express();
  // trust proxy is OFF by default: with it on but no real trusted proxy, a client could
  // spoof X-Forwarded-For and defeat per-IP rate limiting. Only enable behind nginx/CF.
  app.set("trust proxy", trustProxySetting());

  // Lower body limits. JSON payloads (chat, analytics) are small; the raw STT path rejects
  // anything over PA_STT_MAX_BYTES (~5MB) anyway, so a 25MB raw cap was just an attack surface.
  app.use(express.json({ limit: process.env.PA_JSON_LIMIT ?? "256kb" }));
  app.use(express.raw({ type: "application/octet-stream", limit: process.env.PA_RAW_LIMIT ?? "6mb" }));

  // Per-request id, attached for correlated logging.
  app.use((req: Request & { reqId?: string }, res, next) => {
    const id = (req.headers["x-request-id"] as string) || Math.random().toString(36).slice(2, 10);
    req.reqId = id;
    res.setHeader("x-request-id", id);
    next();
  });

  const origin = config.corsOrigin ?? "*";
  app.use((_req, res, next) => {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type, authorization, x-request-id");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (_req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  const llm = config.llm ?? lazyRouter();
  const tickets: TicketStore = config.ticketStore ?? new MemoryTicketStore();
  const usage = new UsageMeter();
  const ticketFlood = makeTicketFloodGuard();
  const baseUrl = config.llmTxt?.appUrl?.replace(/\/$/, "");
  // Without an absolute base URL the discovery docs would advertise a relative path,
  // which breaks any agent reading them from elsewhere — fall back honestly to relative
  // only for same-origin use and document it.
  const feedbackEndpoint = baseUrl ? `${baseUrl}/v1/feedback` : "/v1/feedback";

  const reqId = (req: Request) => (req as Request & { reqId?: string }).reqId ?? "-";

  // --- Abuse protection: these endpoints spend real API credit. ---
  const authToken = process.env.PA_AUTH_TOKEN;
  const guard = bearerAuth(authToken);
  const llmLimit = rateLimit({ windowMs: 60_000, max: envInt("PA_RATE_LLM", 30), name: "llm" });
  const voiceLimit = rateLimit({ windowMs: 60_000, max: envInt("PA_RATE_VOICE", 20), name: "voice" });
  const agentLimit = rateLimit({ windowMs: 60_000, max: envInt("PA_RATE_AGENT", 10), name: "agent" });
  const feedbackLimit = rateLimit({ windowMs: 60_000, max: envInt("PA_RATE_FEEDBACK", 10), name: "feedback" });
  const analyticsLimit = rateLimit({ windowMs: 60_000, max: envInt("PA_RATE_ANALYTICS", 60), name: "analytics" });

  // Budget gate for LLM-spending routes: when today's cap is hit, decline politely instead
  // of silently draining credit.
  const budgetGate = (req: Request, res: Response, next: NextFunction) => {
    if (usage.isBudgetExceeded()) {
      log("warn", { reqId: reqId(req), route: req.path, msg: "daily budget exceeded; declining" });
      res.setHeader("retry-after", "3600");
      return res.status(429).json({ error: "The assistant is resting for today and will be back tomorrow." });
    }
    next();
  };

  // --- LLM proxy: one tool-calling round. The widget's grounding loop drives this. ---
  app.post("/v1/llm/complete", guard, llmLimit, budgetGate, async (req, res) => {
    try {
      const { model, messages, tools, ...rest } = req.body ?? {};
      // Validate the caller's body BEFORE handing it to a provider. A missing/invalid
      // `messages` is the CALLER's mistake → 400, not a misleading 502 that reads as "the
      // AI provider is down". `tools` is optional; default it so providers never map undefined.
      if (!Array.isArray(messages)) {
        return res.status(400).json({ error: "`messages` must be an array." });
      }
      if (tools !== undefined && !Array.isArray(tools)) {
        return res.status(400).json({ error: "`tools` must be an array when provided." });
      }
      const out = await llm.complete({ ...rest, model, messages, tools: tools ?? [] });
      usage.record({ usage: out.usage, provider: out.provider });
      res.json(out);
    } catch (e) {
      handleError(res, e, "/v1/llm/complete", reqId(req));
    }
  });

  app.get("/v1/models", guard, (_req, res) => {
    res.json({ models: AVAILABLE_MODELS });
  });

  // --- Anonymous usage analytics (opt-in from widget) ---
  const analyticsEvents: Array<{ type: string; ts: string; meta?: Record<string, unknown> }> = [];
  app.post("/v1/analytics", guard, analyticsLimit, (req, res) => {
    const { type, ts, meta } = req.body ?? {};
    if (typeof type !== "string" || !type.trim()) return res.status(400).json({ error: "type required" });
    analyticsEvents.push({
      type: type.slice(0, 100),
      ts: typeof ts === "string" ? ts.slice(0, 40) : new Date().toISOString(),
      meta: sanitizeMeta(meta),
    });
    if (analyticsEvents.length > 10_000) analyticsEvents.splice(0, analyticsEvents.length - 10_000);
    res.json({ ok: true });
  });
  app.get("/v1/analytics", guard, (_req, res) => {
    res.json({ events: analyticsEvents.slice(-500) });
  });

  // --- Usage metering / budget dashboard (maintainer view). ---
  app.get("/v1/usage", guard, (_req, res) => res.json(usage.snapshot()));
  app.get("/v1/usage/dashboard", guard, (_req, res) => {
    res.type("html").send(usageDashboardHtml(usage.snapshot()));
  });

  // --- Voice capabilities: lets the settings UI grey out unconfigured options. ---
  // PUBLIC (no bearer guard): it returns only booleans about which provider keys exist —
  // no secrets, no spend — so the widget's settings UI can query it before the user has a
  // token. Still rate-limited to keep it from being a free unauthenticated ping flood.
  const capsLimit = rateLimit({ windowMs: 60_000, max: envInt("PA_RATE_ANALYTICS", 60), name: "voice-caps" });
  app.get("/v1/voice/capabilities", capsLimit, (_req, res) => {
    const providers: string[] = [];
    if (process.env.ELEVENLABS_API_KEY) providers.push("elevenlabs");
    if (process.env.OPENAI_API_KEY) providers.push("openai");
    res.json({
      tts: { server: providers.length > 0, providers },
      stt: { server: !!process.env.OPENAI_API_KEY },
    });
  });

  // --- Voice ---
  app.post("/v1/voice/tts", guard, voiceLimit, async (req, res) => {
    try {
      const text = req.body?.text;
      if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text required" });
      if (text.length > 2000) return res.status(400).json({ error: "text too long (max 2000 chars)" });
      const { audio, contentType } = await synthesize(req.body);
      res.setHeader("content-type", contentType);
      res.send(audio);
    } catch (e) {
      handleError(res, e, "/v1/voice/tts", reqId(req));
    }
  });

  app.post("/v1/voice/stt", guard, voiceLimit, async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "audio body required (content-type: application/octet-stream)" });
      }
      const maxBytes = envInt("PA_STT_MAX_BYTES", 5 * 1024 * 1024, { min: 1 });
      if (req.body.length > maxBytes) {
        return res.status(400).json({ error: `audio too large (max ${maxBytes} bytes)` });
      }
      // Honor a format hint from the browser (Safari records mp4) so Whisper labels it right.
      const hint = (req.headers["x-audio-content-type"] as string) || (req.query.format as string) || undefined;
      // Language hint from the widget (header or ?lang=) so Whisper isn't guessing.
      const lang = (req.headers["x-audio-lang"] as string) || (req.query.lang as string) || undefined;
      const text = await transcribe(req.body, { hint, lang });
      res.json({ text });
    } catch (e) {
      handleError(res, e, "/v1/voice/stt", reqId(req));
    }
  });

  // --- External agent endpoint: other agents drive the on-app assistant. ---
  if (config.capabilities?.length) {
    // Per-caller memory isolation: one shared store would leak one caller's remembered
    // facts into every other caller's prompt. Each caller/session id gets its own store.
    // NOTE: the session key is CLIENT-SUPPLIED (session/source/IP). This is a coarse
    // isolation gate to stop accidental cross-talk between callers — it is NOT tenant auth.
    // A caller that knows/guesses another caller's session id could address the same store,
    // so do not treat this as a security boundary; put real auth in front for that.
    const memories = new Map<string, MemoryStore>();
    const maxSessions = () => envInt("PA_MAX_SESSIONS", 1000, { min: 1 });
    const memoryFor = (key: string): MemoryStore => {
      const existing = memories.get(key);
      if (existing) {
        // LRU: touch on access so a busy session isn't evicted just for being created early.
        // Map preserves insertion order, so delete+re-set moves this key to the newest slot.
        memories.delete(key);
        memories.set(key, existing);
        return existing;
      }
      const m = new InMemoryStore();
      // Bound the number of distinct sessions we keep memory for; evict the LEAST recently
      // used (front of the Map) once we're at the cap.
      while (memories.size >= maxSessions()) {
        const oldest = memories.keys().next().value;
        if (oldest === undefined) break;
        memories.delete(oldest);
      }
      memories.set(key, m);
      return m;
    };
    const makeAssistant = (memory: MemoryStore) =>
      new Assistant({
        capabilities: config.capabilities!,
        llm,
        memory,
        appName: config.appName,
        persona: config.persona,
        knowledge: config.knowledge,
        suggestions: config.suggestions,
      });

    app.post("/v1/agent", guard, agentLimit, budgetGate, async (req, res) => {
      try {
        const { message, page, history, source, session } = req.body ?? {};
        if (!message || typeof message !== "string") return res.status(400).json({ error: "message required" });
        // Session key: explicit session id, else the caller-provided source, else the IP.
        // Anonymous callers sharing an IP still get isolation from other IPs/sessions.
        const key = String(session || source || req.ip || "anon").slice(0, 200);
        const assistant = makeAssistant(memoryFor(key));
        const result = await assistant.chat({
          message,
          page: page ?? { url: config.llmTxt?.appUrl ?? "", path: "/" },
          history,
          caller: "agent",
        });
        usage.record({
          usage: result.usage,
          provider: result.usage?.provider,
          capabilities: result.invocations.filter((i) => i.ok).map((i) => i.name),
        });
        // Self-improving loop: auto-file tickets for errors / caught hallucinations / unmet asks…
        // …but pass them through a flood guard so a looping agent can't spam identical tickets.
        for (const t of ticketsFromRun(config.appName ?? "app", source ?? "agent", message, result))
          if (ticketFlood(t)) await tickets.save(t);
        // …and explicitly invite the calling agent to add its own.
        res.json({
          ...result,
          feedback: {
            endpoint: feedbackEndpoint,
            please: "If anything was missing, broken, or confusing, POST a ticket here so this app improves.",
          },
        });
      } catch (e) {
        handleError(res, e, "/v1/agent", reqId(req));
      }
    });
  }

  // --- Feedback / ticket intake (the improvement loop) ---
  app.post("/v1/feedback", feedbackLimit, async (req, res) => {
    try {
      const t = normalizeTicket({ app: config.appName, ...req.body });
      if ("error" in t) return res.status(400).json(t);
      await tickets.save(t);
      res.json({ ok: true });
    } catch (e) {
      handleError(res, e, "/v1/feedback", reqId(req));
    }
  });
  // Reading tickets is for maintainers, not the public — always behind the token when set.
  app.get("/v1/feedback", guard, async (_req, res) => res.json({ tickets: await tickets.list() }));
  app.get("/.well-known/agent-feedback.json", (_req, res) => res.json(feedbackWellKnown(config.appName ?? "app", feedbackEndpoint)));

  // --- Discovery files (toggleable; all default on) ---
  const expose = { robotsTxt: true, llmTxt: true, llmActions: true, ...(config.expose ?? {}) };
  if (expose.robotsTxt) {
    app.get("/robots.txt", (_req, res) => {
      const base = config.llmTxt?.appUrl.replace(/\/$/, "") ?? "";
      const lines = ["User-agent: *", "Allow: /", "", "# AI agents: this app ships a grounded assistant + machine-readable capabilities."];
      if (config.llmTxt && config.capabilities && expose.llmTxt) lines.push(`# Capabilities: ${base}/llm.txt`);
      if (config.llmTxt && config.capabilities && expose.llmActions) lines.push(`# Capabilities (JSON): ${base}/.well-known/llm-actions.json`);
      if (config.capabilities) lines.push(`# Drive the assistant: POST ${base}/v1/agent`);
      res.type("text/plain").send(lines.join("\n") + "\n");
    });
  }
  // --- llm.txt + machine manifest for other agents to discover the app ---
  if (config.llmTxt && config.capabilities) {
    const meta = { ...config.llmTxt, feedbackEndpoint };
    if (expose.llmTxt)
      app.get("/llm.txt", (_req, res) => {
        res.type("text/plain").send(generateLlmTxt(meta, config.capabilities!));
      });
    if (expose.llmActions)
      app.get("/.well-known/llm-actions.json", (_req, res) => {
        res.json({ ...generateActionsJson(meta, config.capabilities!), feedbackEndpoint });
      });
  }

  app.get("/v1/health", (_req, res) => res.json({ ok: true, version: SERVER_VERSION }));

  app.get("/v1/openapi.json", (_req, res) => {
    res.json({
      openapi: "3.0.0",
      info: { title: "Page Assistant API", version: SERVER_VERSION },
      paths: {
        "/v1/llm/complete": { post: { summary: "LLM tool-calling round" } },
        "/v1/voice/tts": { post: { summary: "Text-to-speech" } },
        "/v1/voice/stt": { post: { summary: "Speech-to-text" } },
        "/v1/voice/capabilities": { get: { summary: "Which voice providers are configured" } },
        "/v1/agent": { post: { summary: "External agent endpoint" } },
        "/v1/models": { get: { summary: "Available LLM models" } },
        "/v1/usage": { get: { summary: "Usage aggregates (tokens/requests today)" } },
        "/v1/usage/dashboard": { get: { summary: "HTML usage dashboard" } },
        "/v1/analytics": { get: { summary: "Usage events" }, post: { summary: "Track event" } },
        "/v1/feedback": { get: { summary: "List tickets" }, post: { summary: "Submit ticket" } },
        "/v1/health": { get: { summary: "Health check" } },
        "/llm.txt": { get: { summary: "Human-readable capability manifest" } },
        "/.well-known/llm-actions.json": { get: { summary: "Machine capability manifest" } },
      },
    });
  });

  logBootSummary(config, authToken);
  return app;
}

/** One structured line at boot: what's configured, so misconfig is obvious in logs. */
function logBootSummary(config: ServerConfig, authToken: string | undefined): void {
  const providers: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) providers.push("anthropic");
  if (process.env.OPENAI_API_KEY) providers.push("openai");
  if (process.env.OPENROUTER_API_KEY) providers.push("openrouter");
  const voice: string[] = [];
  if (process.env.ELEVENLABS_API_KEY) voice.push("elevenlabs");
  if (process.env.OPENAI_API_KEY) voice.push("openai");
  log("info", {
    route: "boot",
    msg: "page-assistant server ready",
    version: SERVER_VERSION,
    llmProviders: providers,
    voiceProviders: voice,
    auth: authToken ? "on" : "off",
    trustProxy: trustProxySetting(),
    agentEndpoint: !!config.capabilities?.length,
    rateLimits: {
      llm: envInt("PA_RATE_LLM", 30),
      voice: envInt("PA_RATE_VOICE", 20),
      agent: envInt("PA_RATE_AGENT", 10),
      feedback: envInt("PA_RATE_FEEDBACK", 10),
      analytics: envInt("PA_RATE_ANALYTICS", 60),
    },
    dailyBudget: process.env.PA_DAILY_BUDGET
      ? `${envInt("PA_DAILY_BUDGET", 0)} tokens`
      : process.env.PA_DAILY_REQUEST_BUDGET
      ? `${envInt("PA_DAILY_REQUEST_BUDGET", 0)} requests`
      : "none",
  });
  if (!authToken)
    log("warn", { route: "boot", msg: "PA_AUTH_TOKEN not set — spend endpoints are open (rate-limited only)" });
  if (!providers.length)
    log("warn", { route: "boot", msg: "no LLM key set — /v1/llm/complete and /v1/agent will error until one is provided" });
}

/**
 * Clamp untrusted analytics `meta`: keep only string-ish primitive values, cap the number
 * of keys, and cap the total serialized size. Without this, `meta` could be up to the JSON
 * body limit and 10k of them are retained — a cheap memory bomb.
 */
function sanitizeMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const MAX_KEYS = 20;
  const MAX_BYTES = 4096;
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (keys >= MAX_KEYS) break;
    let val: unknown;
    if (typeof v === "string") val = v.slice(0, 500);
    else if (typeof v === "number" || typeof v === "boolean") val = v;
    else continue; // drop objects/arrays/functions — no nested structures
    out[String(k).slice(0, 60)] = val;
    keys++;
  }
  // Final size cap: if still oversized (many medium strings), drop keys until it fits.
  let serialized = JSON.stringify(out);
  while (serialized.length > MAX_BYTES) {
    const k = Object.keys(out).pop();
    if (k === undefined) break;
    delete out[k];
    serialized = JSON.stringify(out);
  }
  return Object.keys(out).length ? out : undefined;
}

// Defer router construction until first call so the server boots even without keys
// (voice-only or static deployments), failing only on the endpoint that needs an LLM.
function lazyRouter(): LLMProvider {
  let inner: LLMProvider | null = null;
  return {
    name: "lazy-router",
    async complete(input) {
      if (!inner) inner = routerFromEnv();
      return inner.complete(input);
    },
  };
}
