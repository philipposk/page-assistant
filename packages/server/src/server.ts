import express, { type Express } from "express";
import {
  Assistant,
  InMemoryStore,
  generateLlmTxt,
  generateActionsJson,
  MemoryTicketStore,
  normalizeTicket,
  ticketsFromRun,
  feedbackWellKnown,
  type Capability,
  type LLMProvider,
  type LlmTxtMeta,
  type TicketStore,
} from "@page-assistant/core";
import { routerFromEnv } from "./llm/router.js";
import { synthesize, transcribe } from "./voice.js";
import { rateLimit, bearerAuth } from "./ratelimit.js";

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

/** Build an Express app exposing the page-assistant backend. Mount or listen() it. */
export function createServer(config: ServerConfig = {}): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.raw({ type: "application/octet-stream", limit: "25mb" }));

  const origin = config.corsOrigin ?? "*";
  app.use((_req, res, next) => {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (_req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  const llm = config.llm ?? lazyRouter();
  const tickets: TicketStore = config.ticketStore ?? new MemoryTicketStore();
  const baseUrl = config.llmTxt?.appUrl?.replace(/\/$/, "");
  // Without an absolute base URL the discovery docs would advertise a relative path,
  // which breaks any agent reading them from elsewhere — fall back honestly to relative
  // only for same-origin use and document it.
  const feedbackEndpoint = baseUrl ? `${baseUrl}/v1/feedback` : "/v1/feedback";

  // --- Abuse protection: these endpoints spend real API credit. ---
  const guard = bearerAuth(process.env.PA_AUTH_TOKEN);
  const llmLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.PA_RATE_LLM ?? 30), name: "llm" });
  const voiceLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.PA_RATE_VOICE ?? 20), name: "voice" });
  const agentLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.PA_RATE_AGENT ?? 10), name: "agent" });
  const feedbackLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.PA_RATE_FEEDBACK ?? 10), name: "feedback" });

  // --- LLM proxy: one tool-calling round. The widget's grounding loop drives this. ---
  app.post("/v1/llm/complete", guard, llmLimit, async (req, res) => {
    try {
      const out = await llm.complete(req.body);
      res.json(out);
    } catch (e) {
      res.status(502).json({ error: String(e instanceof Error ? e.message : e) });
    }
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
      res.status(502).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  app.post("/v1/voice/stt", guard, voiceLimit, async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "audio body required (content-type: application/octet-stream)" });
      }
      const text = await transcribe(req.body, "audio.webm");
      res.json({ text });
    } catch (e) {
      res.status(502).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  // --- External agent endpoint: other agents drive the on-app assistant. ---
  if (config.capabilities?.length) {
    const assistant = new Assistant({
      capabilities: config.capabilities,
      llm,
      memory: new InMemoryStore(),
      appName: config.appName,
      persona: config.persona,
      knowledge: config.knowledge,
      suggestions: config.suggestions,
    });
    app.post("/v1/agent", agentLimit, async (req, res) => {
      try {
        const { message, page, history, source } = req.body ?? {};
        if (!message) return res.status(400).json({ error: "message required" });
        const result = await assistant.chat({
          message,
          page: page ?? { url: config.llmTxt?.appUrl ?? "", path: "/" },
          history,
          caller: "agent",
        });
        // Self-improving loop: auto-file tickets for errors / caught hallucinations / unmet asks…
        for (const t of ticketsFromRun(config.appName ?? "app", source ?? "agent", message, result)) await tickets.save(t);
        // …and explicitly invite the calling agent to add its own.
        res.json({
          ...result,
          feedback: {
            endpoint: feedbackEndpoint,
            please: "If anything was missing, broken, or confusing, POST a ticket here so this app improves.",
          },
        });
      } catch (e) {
        res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
      }
    });
  }

  // --- Feedback / ticket intake (the improvement loop) ---
  app.post("/v1/feedback", feedbackLimit, async (req, res) => {
    const t = normalizeTicket({ app: config.appName, ...req.body });
    if ("error" in t) return res.status(400).json(t);
    await tickets.save(t);
    res.json({ ok: true });
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

  app.get("/v1/health", (_req, res) => res.json({ ok: true }));
  return app;
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
