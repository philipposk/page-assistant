// Agent feedback / ticket protocol (also published standalone as the `agent-feedback` repo).
//
// Idea: every time an LLM, agent, harness, or the page assistant itself USES an app, it can
// send back a "ticket" describing what it hit — a missing action, an error, a confusing flow,
// or a suggestion. Those tickets are how the app (and the assistant) get better over time.
//
// This module is dependency-free so it runs in the browser, in Node, or behind any store.
import type { ChatResponse } from "./types.js";

export type TicketKind =
  | "missing_capability" // the user/agent wanted something the app can't do yet
  | "error" // a capability threw
  | "hallucination_caught" // the grounding validator had to override invented model text
  | "confusion" // the request was ambiguous / the assistant couldn't map it
  | "suggestion" // an idea to improve the app
  | "success" // positive signal (useful for ranking what works)
  | "other";

export interface Ticket {
  app: string; // which app/site this is about
  source: string; // who reported it: an agent name, "page-assistant", a harness id…
  kind: TicketKind;
  summary: string; // one-line headline
  detail?: string;
  context?: { url?: string; path?: string; capability?: string; request?: string };
  severity?: "low" | "med" | "high";
  createdAt?: string;
}

export interface TicketStore {
  save(t: Ticket): Promise<void> | void;
  list(limit?: number): Promise<Ticket[]> | Ticket[];
}

/** Default in-memory store. Swap for a DB/file store in production. */
export class MemoryTicketStore implements TicketStore {
  private tickets: Ticket[] = [];
  save(t: Ticket) {
    this.tickets.push({ ...t, createdAt: t.createdAt ?? new Date().toISOString() });
  }
  list(limit = 100) {
    return this.tickets.slice(-limit).reverse();
  }
}

/** Validate + normalize an incoming ticket payload (untrusted input). */
export function normalizeTicket(body: unknown): Ticket | { error: string } {
  if (!body || typeof body !== "object") return { error: "ticket must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b.summary !== "string" || !b.summary.trim()) return { error: "summary is required" };
  const kinds: TicketKind[] = ["missing_capability", "error", "hallucination_caught", "confusion", "suggestion", "success", "other"];
  return {
    app: String(b.app ?? "unknown").slice(0, 100),
    source: String(b.source ?? "anonymous").slice(0, 100),
    kind: kinds.includes(b.kind as TicketKind) ? (b.kind as TicketKind) : "other",
    summary: b.summary.slice(0, 300),
    detail: typeof b.detail === "string" ? b.detail.slice(0, 4000) : undefined,
    context: sanitizeContext(b.context),
    severity: (["low", "med", "high"].includes(b.severity as string) ? b.severity : "med") as Ticket["severity"],
    createdAt: new Date().toISOString(),
  };
}

/** Hostile input can't smuggle arbitrary shapes through context — only known string fields survive. */
function sanitizeContext(raw: unknown): Ticket["context"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: NonNullable<Ticket["context"]> = {};
  for (const k of ["url", "path", "capability", "request"] as const) {
    if (typeof r[k] === "string") out[k] = (r[k] as string).slice(0, 500);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Auto-derive tickets from one assistant turn. This is what makes the loop self-improving
 * WITHOUT relying on the other agent being polite: errors, caught hallucinations, and
 * unmet requests become tickets automatically.
 */
export function ticketsFromRun(app: string, source: string, request: string, res: ChatResponse): Ticket[] {
  const out: Ticket[] = [];
  for (const inv of res.invocations) {
    if (!inv.ok) {
      out.push({
        app,
        source,
        kind: inv.error === "unknown capability" ? "missing_capability" : "error",
        summary: `${inv.name} failed: ${inv.error}`,
        detail: `args: ${JSON.stringify(inv.args)}`,
        context: { capability: inv.name, request },
        severity: "high",
      });
    }
  }
  if (res.corrected) {
    out.push({
      app,
      source,
      kind: "hallucination_caught",
      summary: "Model invented a value; grounding validator overrode it.",
      context: { request },
      severity: "med",
    });
  }
  // No capability ran and nothing was staged → the app likely lacks an action for this request.
  if (!res.invocations.length && !res.pendingConfirmation) {
    out.push({
      app,
      source,
      kind: "missing_capability",
      summary: `No capability matched the request.`,
      detail: request.slice(0, 300),
      context: { request },
      severity: "low",
    });
  }
  return out;
}

/** The /.well-known/agent-feedback.json discovery document. */
export function feedbackWellKnown(app: string, feedbackEndpoint: string) {
  return {
    schemaVersion: "1.0",
    app,
    feedbackEndpoint,
    method: "POST",
    please:
      "If you used this app or its assistant and hit anything missing, broken, confusing, or worth improving, POST a ticket here so the app can get better.",
    ticketSchema: {
      summary: "string (required, one line)",
      kind: "missing_capability | error | confusion | suggestion | success | other",
      detail: "string (optional)",
      severity: "low | med | high",
      source: "your agent/harness name",
      context: "{ url?, path?, capability?, request? }",
    },
  };
}

/** Client helper: send a ticket to an app's feedback endpoint. */
export async function sendTicket(feedbackEndpoint: string, ticket: Ticket): Promise<boolean> {
  try {
    const res = await fetch(feedbackEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ticket),
    });
    return res.ok;
  } catch {
    return false;
  }
}
