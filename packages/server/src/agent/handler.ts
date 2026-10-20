// A framework-agnostic HTTP handler for agent mode, on the web-standard Request/Response,
// so the same code mounts in Next.js App Router, Vercel functions, Hono, Deno or Bun — and in
// Express/Node through `toNodeHandler`.
//
//   POST  { message, history?, page?, confirmToken?, suggestionTool?, clientCapabilities?, chatId? }
//         → AgentTurnResponse (JSON), or Server-Sent Events when the client sends
//           `Accept: text/event-stream`: `status` events while it works, then one `reply`.
//   GET   → { ok, assistantName, intro } for the dock's empty state. Also signed-in only.
//
// Every request must be signed in (`getUser`); there is no anonymous mode, because every
// turn spends model credit and tools act as the user.

import { crossSiteRefusal, readLimited } from "./http.js";
import { createAgent, type Agent } from "./loop.js";
import { failureMessage } from "./text.js";
import type { AgentConfig, AgentHistoryTurn, AgentPage, AgentTurnRequest, AgentTurnResponse, AgentUser } from "./types.js";

export interface AgentHandlerOptions<C = unknown> extends AgentConfig<C> {
  /**
   * The signed-in user for this request, or null. Use the app's own session (cookie/JWT).
   * Return a string id or an object with `id`.
   */
  getUser: (req: Request) => Promise<AgentUser | string | null | undefined> | AgentUser | string | null | undefined;
  /** Per-request host context handed to tools as `ctx.app` (e.g. a Supabase client acting as the user). */
  context?: (req: Request, user: AgentUser) => Promise<C> | C;
  /**
   * Per-user limit, checked before a turn. Default: 20 a minute and 400 a day, in memory
   * (per process — on serverless, per instance; put a shared limit in front for a hard cap).
   * `false` turns the built-in one off.
   */
  rateLimit?:
    | false
    | { perMinute?: number; perDay?: number }
    | ((user: AgentUser, req: Request) => Promise<RateDecision> | RateDecision);
  /** Shown by the dock before the first message. */
  intro?: { text?: string; suggestions?: Array<{ label: string; prompt: string }> };
  /** Largest request body in bytes. Default 256 KB. */
  maxBodyBytes?: number;
  /** Adds CORS headers for this origin (cross-origin docks only). Same-origin needs none. */
  corsOrigin?: string;
}

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds?: number; message?: string };

export const MAX_MESSAGE_CHARS = 12_000;
const MAX_HISTORY_ITEMS = 60;
const MAX_HISTORY_CHARS = 32_000;

class BadRequest extends Error {}

/** Build the handler once (module scope). */
export function createAgentHandler<C = unknown>(options: AgentHandlerOptions<C>): ((req: Request) => Promise<Response>) & { agent: Agent<C> } {
  const agent = createAgent<C>(options);
  const limiter = makeLimiter(options.rateLimit);
  const maxBody = options.maxBodyBytes ?? 256 * 1024;

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    "cache-control": "no-store",
    ...(options.corsOrigin
      ? {
          "access-control-allow-origin": options.corsOrigin,
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          vary: "origin",
        }
      : {}),
    ...extra,
  });
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: headers({ "content-type": "application/json; charset=utf-8", ...extra }) });

  const handler = async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() });
    if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed." }, 405, { allow: "GET, POST, OPTIONS" });
    // Another site's page must not drive the assistant with this user's cookies (CSRF).
    const crossSite = crossSiteRefusal(req, options.corsOrigin);
    if (crossSite) return json({ error: crossSite }, 403);
    // JSON only: a cross-site form or a "simple" fetch (text/plain) can't send it without a
    // CORS preflight, which this route only answers for `corsOrigin`.
    if (req.method === "POST" && !(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      return json({ error: "Send JSON (content-type: application/json)." }, 415);
    }

    let user: AgentUser | null;
    try {
      user = normaliseUser(await options.getUser(req));
    } catch {
      user = null;
    }
    if (!user) return json({ error: "Sign in to use the assistant." }, 401);

    if (req.method === "GET") {
      return json({ ok: true, assistantName: options.assistantName ?? null, intro: options.intro ?? null });
    }

    let body: AgentTurnRequest;
    try {
      body = await readBody(req, maxBody);
    } catch (e) {
      const status = e instanceof BadRequest ? 422 : 400;
      return json({ error: e instanceof BadRequest ? e.message : "The request body must be JSON." }, status);
    }

    // A confirm click spends no model credit, so only typed turns count against the limit.
    if (!body.confirmToken) {
      const decision = await limiter(user, req);
      if (!decision.ok) {
        const retry = Math.max(1, Math.ceil(decision.retryAfterSeconds ?? 60));
        return json(
          { error: decision.message ?? "You're sending messages faster than the assistant can keep up with. Try again in a minute.", retryAfterSeconds: retry },
          429,
          { "retry-after": String(retry) }
        );
      }
    }

    let app: C;
    try {
      app = options.context ? await options.context(req, user) : (undefined as C);
    } catch (e) {
      logError("context", e);
      return json(internalError(body.chatId), 500);
    }

    const wantsStream = (req.headers.get("accept") ?? "").includes("text/event-stream");
    if (!wantsStream) {
      try {
        return json(await agent.turn(body, user, app, { signal: req.signal }));
      } catch (e) {
        logError("turn", e);
        return json(internalError(body.chatId), 500);
      }
    }

    const encoder = new TextEncoder();
    // The stream closing (Stop, tab closed) stops the turn, like the request's own signal.
    const stop = new AbortController();
    const onReqAbort = () => stop.abort(req.signal.reason);
    if (req.signal.aborted) onReqAbort();
    else req.signal.addEventListener("abort", onReqAbort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        stop.abort(new Error("stream closed"));
      },
      async start(controller) {
        let open = true;
        const send = (event: string, data: unknown) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            open = false;
          }
        };
        // Keeps proxies from closing a quiet connection while a tool runs.
        const ping = setInterval(() => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            open = false;
          }
        }, 10_000);
        try {
          const reply = await agent.turn(body, user!, app, { onProgress: (p) => send("status", p), signal: stop.signal });
          send("reply", reply);
        } catch (e) {
          logError("turn", e);
          send("reply", internalError(body.chatId));
        } finally {
          clearInterval(ping);
          req.signal.removeEventListener("abort", onReqAbort);
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: headers({ "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" }),
    });
  };
  return Object.assign(handler, { agent });
}

function internalError(chatId: string | undefined): AgentTurnResponse {
  return {
    message: failureMessage("internal_error"),
    uiActions: [],
    uiActionMode: "immediate",
    pendingAction: null,
    suggestions: [],
    cards: [],
    errorCode: "internal_error",
    chatId: chatId ?? null,
    tainted: false,
  };
}

/** Server-side only, and never the user's text. */
function logError(where: string, e: unknown) {
  console.error(
    JSON.stringify({ level: "error", route: "agent", where, errType: e instanceof Error ? e.name : typeof e, msg: e instanceof Error ? e.message.slice(0, 300) : undefined })
  );
}

function normaliseUser(u: AgentUser | string | null | undefined): AgentUser | null {
  if (!u) return null;
  if (typeof u === "string") return u.trim() ? { id: u.trim() } : null;
  return typeof u.id === "string" && u.id.trim() ? u : null;
}

async function readBody(req: Request, maxBytes: number): Promise<AgentTurnRequest> {
  const bytes = await readLimited(req, maxBytes);
  if (!bytes) throw new BadRequest("The request is too large.");
  const raw = JSON.parse(new TextDecoder().decode(bytes) || "{}");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequest("The request body must be a JSON object.");
  const message = typeof raw.message === "string" ? raw.message : "";
  const confirmToken = typeof raw.confirmToken === "string" && raw.confirmToken.length <= 200 ? raw.confirmToken : undefined;
  if (!message.trim() && !confirmToken) throw new BadRequest("message cannot be empty.");
  if (message.length > MAX_MESSAGE_CHARS) throw new BadRequest(`That message is too long (max ${MAX_MESSAGE_CHARS} characters). Shorten it and try again.`);

  const history: AgentHistoryTurn[] = [];
  if (Array.isArray(raw.history)) {
    for (const t of raw.history.slice(-MAX_HISTORY_ITEMS)) {
      if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string") continue;
      const turn: AgentHistoryTurn = { role: t.role, content: t.content.slice(0, MAX_HISTORY_CHARS) };
      if (t.kind === "narrate" || t.kind === "error") turn.kind = t.kind;
      if (t.tainted === true) turn.tainted = true;
      history.push(turn);
    }
  }
  let page: AgentPage | undefined;
  if (raw.page && typeof raw.page === "object" && !Array.isArray(raw.page)) {
    const p = raw.page;
    page = {};
    if (typeof p.path === "string") page.path = p.path.slice(0, 2000);
    if (typeof p.url === "string") page.url = p.url.slice(0, 2000);
    if (typeof p.title === "string") page.title = p.title.slice(0, 300);
    if (p.state && typeof p.state === "object" && !Array.isArray(p.state)) page.state = p.state;
  }
  const caps = Array.isArray(raw.clientCapabilities)
    ? raw.clientCapabilities.filter((c: unknown): c is string => typeof c === "string" && c.length <= 40).slice(0, 16)
    : [];
  return {
    message,
    history,
    page,
    confirmToken,
    suggestionTool: typeof raw.suggestionTool === "string" && raw.suggestionTool.length <= 64 ? raw.suggestionTool : undefined,
    clientCapabilities: caps,
    chatId: typeof raw.chatId === "string" && raw.chatId.length <= 128 ? raw.chatId : undefined,
  };
}

function makeLimiter(opt: AgentHandlerOptions["rateLimit"]): (user: AgentUser, req: Request) => Promise<RateDecision> {
  if (opt === false) return async () => ({ ok: true });
  if (typeof opt === "function") {
    return async (user, req) => {
      try {
        return await opt(user, req);
      } catch {
        // A limit store that is down lets the turn through: a hiccup must not lock everyone out.
        return { ok: true };
      }
    };
  }
  const perMinute = opt?.perMinute ?? 20;
  const perDay = opt?.perDay ?? 400;
  return memoryLimiter(perMinute, perDay);
}

/** Sliding windows per user, in memory. Exported for tests. */
export function memoryLimiter(perMinute: number, perDay: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return async (user: AgentUser): Promise<RateDecision> => {
    const t = now();
    const list = (hits.get(user.id) ?? []).filter((x) => t - x < 86_400_000);
    const lastMinute = list.filter((x) => t - x < 60_000);
    if (perMinute > 0 && lastMinute.length >= perMinute) {
      hits.set(user.id, list);
      return { ok: false, retryAfterSeconds: Math.ceil((60_000 - (t - lastMinute[0])) / 1000) };
    }
    if (perDay > 0 && list.length >= perDay) {
      hits.set(user.id, list);
      return { ok: false, retryAfterSeconds: Math.ceil((86_400_000 - (t - list[0])) / 1000), message: "You've reached today's limit for the assistant. It resets tomorrow." };
    }
    list.push(t);
    hits.delete(user.id);
    hits.set(user.id, list);
    // Bound memory: drop the least recently active users.
    while (hits.size > 10_000) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
    return { ok: true };
  };
}
