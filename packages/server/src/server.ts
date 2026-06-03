import express, { type Express } from "express";
import {
  Assistant,
  InMemoryStore,
  generateLlmTxt,
  generateActionsJson,
  type Capability,
  type LLMProvider,
  type LlmTxtMeta,
} from "@page-assistant/core";
import { routerFromEnv } from "./llm/router.js";
import { synthesize, transcribe } from "./voice.js";

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

  // --- LLM proxy: one tool-calling round. The widget's grounding loop drives this. ---
  app.post("/v1/llm/complete", async (req, res) => {
    try {
      const out = await llm.complete(req.body);
      res.json(out);
    } catch (e) {
      res.status(502).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  // --- Voice ---
  app.post("/v1/voice/tts", async (req, res) => {
    try {
      const { audio, contentType } = await synthesize(req.body);
      res.setHeader("content-type", contentType);
      res.send(audio);
    } catch (e) {
      res.status(502).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  app.post("/v1/voice/stt", async (req, res) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      const text = await transcribe(buf, "audio.webm");
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
    });
    app.post("/v1/agent", async (req, res) => {
      try {
        const { message, page, history } = req.body ?? {};
        if (!message) return res.status(400).json({ error: "message required" });
        const result = await assistant.chat({
          message,
          page: page ?? { url: config.llmTxt?.appUrl ?? "", path: "/" },
          history,
          caller: "agent",
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
      }
    });
  }

  // --- llm.txt + machine manifest for other agents to discover the app ---
  if (config.llmTxt && config.capabilities) {
    app.get("/llm.txt", (_req, res) => {
      res.type("text/plain").send(generateLlmTxt(config.llmTxt!, config.capabilities!));
    });
    app.get("/.well-known/llm-actions.json", (_req, res) => {
      res.json(generateActionsJson(config.llmTxt!, config.capabilities!));
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
