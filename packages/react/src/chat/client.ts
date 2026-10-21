// Talking to the agent route: one POST per turn, JSON or Server-Sent Events.

import type { AgentIntro, AgentStatus, AgentTurnBody, AgentTurnResponse } from "../protocol.js";

/** The route refused the request before any turn ran (401, 422, 429, 5xx without a reply). */
export class AgentRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail?: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(`agent request failed (${status})`);
    this.name = "AgentRequestError";
  }
}

export interface AgentTransport {
  /** The agent route, e.g. "/api/pa/agent". */
  endpoint: string;
  /**
   * A bearer token for the route, when the app authenticates API calls that way. Cookie
   * sessions (Supabase SSR, NextAuth) need nothing: requests are same-origin with credentials.
   */
  getAuthToken?: () => string | null | undefined | Promise<string | null | undefined>;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

async function requestHeaders(t: AgentTransport, extra: Record<string, string>): Promise<Record<string, string>> {
  const h: Record<string, string> = { ...(t.headers ?? {}), ...extra };
  const token = t.getAuthToken ? await t.getAuthToken() : null;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** Fill in fields an older server may leave out, so the dock can rely on them. */
export function normaliseReply(raw: unknown): AgentTurnResponse {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AgentTurnResponse>;
  return {
    message: typeof r.message === "string" ? r.message : "",
    uiActions: Array.isArray(r.uiActions) ? r.uiActions : [],
    uiActionMode: r.uiActionMode === "guided" ? "guided" : "immediate",
    pendingAction: r.pendingAction && typeof r.pendingAction.token === "string" ? r.pendingAction : null,
    suggestions: Array.isArray(r.suggestions) ? r.suggestions : [],
    cards: Array.isArray(r.cards) ? r.cards : [],
    errorCode: r.errorCode ?? null,
    chatId: r.chatId ?? null,
    tainted: r.tainted === true,
  };
}

export interface PostTurnOptions {
  signal?: AbortSignal;
  /** Ask for Server-Sent Events and report progress. */
  stream?: boolean;
  onStatus?: (s: AgentStatus) => void;
}

export async function postTurn(t: AgentTransport, body: AgentTurnBody, opts: PostTurnOptions = {}): Promise<AgentTurnResponse> {
  const doFetch = t.fetch ?? fetch;
  const res = await doFetch(t.endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: await requestHeaders(t, {
      "content-type": "application/json",
      accept: opts.stream ? "text/event-stream" : "application/json",
    }),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const type = res.headers.get("content-type") ?? "";
  if (res.ok && type.includes("text/event-stream") && res.body) return readEvents(res.body, opts.onStatus);
  let data: Record<string, unknown> | null = null;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = null;
  }
  if (res.ok) return normaliseReply(data);
  // A server fault with a readable reply (internal_error) is still a reply.
  if (data && typeof data.message === "string" && typeof data.errorCode === "string") return normaliseReply(data);
  const retryHeader = Number(res.headers.get("retry-after"));
  const retryAfter = typeof data?.retryAfterSeconds === "number" ? data.retryAfterSeconds : Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined;
  throw new AgentRequestError(res.status, typeof data?.error === "string" ? data.error : undefined, retryAfter);
}

/** Parse an SSE body: `status` events go to `onStatus`, the `reply` event resolves. */
export async function readEvents(body: ReadableStream<Uint8Array>, onStatus?: (s: AgentStatus) => void): Promise<AgentTurnResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = parseEventBlock(block);
        if (!event) continue;
        if (event.name === "status" && onStatus) {
          try {
            onStatus(JSON.parse(event.data) as AgentStatus);
          } catch {
            /* a bad status line is not worth failing for */
          }
        } else if (event.name === "reply") {
          return normaliseReply(JSON.parse(event.data));
        }
      }
      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  throw new AgentRequestError(0, "The connection closed before the answer arrived.");
}

function parseEventBlock(block: string): { name: string; data: string } | null {
  let name = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { name, data: data.join("\n") } : null;
}

/** GET the route's intro (assistant name, starter chips). Null when it fails. */
export async function fetchIntro(t: AgentTransport): Promise<AgentIntro | null> {
  try {
    const res = await (t.fetch ?? fetch)(t.endpoint, { method: "GET", credentials: "same-origin", headers: await requestHeaders(t, { accept: "application/json" }) });
    return res.ok ? ((await res.json()) as AgentIntro) : null;
  } catch {
    return null;
  }
}
