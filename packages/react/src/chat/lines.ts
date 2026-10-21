// The dock's conversation lines, and the rules for what is saved, what is resent to the model,
// and how a failed turn reads. Pure functions, so they are testable without the dock.
//
// `lines` mixes real turns with two local-only kinds: narration beats from a walkthrough and
// error bubbles. Neither is saved and neither is sent back: the model should only ever see
// what was really said.

import type { AgentHistoryTurn, AgentTurnResponse, ResultCard } from "../protocol.js";
import { AgentRequestError } from "./client.js";

export type ChatLineKind = "turn" | "narration" | "error";

export interface ChatLineRetry {
  /** "Retry" when nothing ran; "Try again" after an unknown failure or a Stop. */
  label: "Retry" | "Try again";
  message: string;
  suggestionTool?: string;
  /** Epoch ms before which the button stays disabled (Retry-After). */
  notBefore?: number;
}

export interface ChatLine {
  id: string;
  role: "user" | "assistant";
  content: string;
  kind?: ChatLineKind;
  retry?: ChatLineRetry;
  cards?: ResultCard[];
  /** A short line under a reopened reply; never saved or sent. */
  note?: string;
  /** The reply holds text someone else wrote (server's `tainted`). Saved and sent back tagged. */
  tainted?: boolean;
}

/** Longest history item the server takes. */
export const MAX_TURN_CHARS = 32_000;
/** How many earlier turns a request carries. The server reads no more than this. */
export const MAX_HISTORY_TURNS = 24;
/**
 * Most bytes of history a request carries. The server refuses a body over 256 KB, and a long
 * chat of long replies would pass that and then fail on every message after.
 */
export const MAX_HISTORY_BYTES = 100_000;
/** A Retry-After above this is a daily limit: no button. */
export const MAX_RETRY_WAIT_SECONDS = 3600;

let counter = 0;
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `text` cut to `max` UTF-16 units, never on half an emoji. */
export function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const encoder = new TextEncoder();
const turnBytes = (t: AgentHistoryTurn) => encoder.encode(JSON.stringify(t)).length;

/**
 * The `history` of a request: the latest real turns, newest kept first when space runs out.
 * Narration beats and error bubbles are left out. `tainted` stays on the turns that have it.
 */
export function toHistoryTurns(lines: ChatLine[], maxBytes: number = MAX_HISTORY_BYTES): AgentHistoryTurn[] {
  const out: AgentHistoryTurn[] = [];
  let bytes = 2;
  for (let i = lines.length - 1; i >= 0 && out.length < MAX_HISTORY_TURNS; i--) {
    const l = lines[i];
    if ((l.kind ?? "turn") !== "turn") continue;
    const t: AgentHistoryTurn = { role: l.role, content: clipChars(l.content, MAX_TURN_CHARS) };
    if (l.tainted) t.tainted = true;
    let size = turnBytes(t) + 1;
    if (bytes + size > maxBytes) {
      if (out.length) break; // older turns would not fit
      // Even the newest turn alone is too big: cut it down until it fits.
      while (size + bytes > maxBytes && t.content.length > 0) {
        t.content = clipChars(t.content, Math.floor(t.content.length * 0.7));
        size = turnBytes(t) + 1;
      }
    }
    out.push(t);
    bytes += size;
  }
  return out.reverse();
}

/** Real turns only: what a saved chat holds (with the taint tag, so a reopened chat stays guarded). */
export function toSavable(lines: ChatLine[]): Array<{ role: "user" | "assistant"; content: string; tainted?: boolean }> {
  return lines
    .filter((l) => (l.kind ?? "turn") === "turn")
    .map((l) => ({ role: l.role, content: l.content, ...(l.tainted ? { tainted: true } : {}) }));
}

export const CARD_GONE_NOTE = "This needed your OK and was not done. Ask again if you still want it.";
export const NO_ANSWER_NOTE = "No answer. Ask again if you still want it.";
const CARD_PROMISE = /\bconfirm on the card below\b|\bI stopped at the question above\b/i;

/** Lines of a reopened chat. A reply that pointed at a card (single use, not kept) says so. */
export function linesFromSaved(turns: ReadonlyArray<{ role: string; content: string; tainted?: unknown }>): ChatLine[] {
  const clean = turns.filter((t): t is { role: "user" | "assistant"; content: string; tainted?: unknown } => (t.role === "user" || t.role === "assistant") && typeof t.content === "string");
  return clean.map((t, i) => {
    const line: ChatLine = { id: newId(), role: t.role, content: t.content, ...(t.tainted === true ? { tainted: true } : {}) };
    if (t.role === "user" && clean[i + 1]?.role !== "assistant") line.note = NO_ANSWER_NOTE;
    if (t.role === "assistant" && CARD_PROMISE.test(t.content) && clean[i + 1]?.role !== "assistant") line.note = CARD_GONE_NOTE;
    return line;
  });
}

/** A short title from the first message. */
export function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 48 ? `${t.slice(0, 46)}…` : t || "New chat";
}

export interface ChatFailure {
  content: string;
  /** No turn ran (refused before it started): take the user line back, restore the typed text. */
  rollback: boolean;
  retry?: { label: ChatLineRetry["label"]; waitSeconds?: number };
}

export const STOPPED_FAILURE: ChatFailure = { content: "Stopped.", rollback: false, retry: { label: "Try again" } };

/** A thrown request error → what the chat shows. Raw server bodies are never shown. */
export function failureFromError(err: unknown): ChatFailure {
  if (err instanceof AgentRequestError || (err && typeof err === "object" && "status" in err)) {
    const e = err as AgentRequestError;
    if (e.status === 401) return { content: "Sign in to use the assistant.", rollback: true };
    if (e.status === 429) {
      const wait = e.retryAfterSeconds;
      const content = e.detail ?? "You're sending messages faster than the assistant can keep up with. Try again in a minute.";
      if (wait !== undefined && wait > MAX_RETRY_WAIT_SECONDS) return { content, rollback: true };
      return { content, rollback: true, retry: { label: "Retry", waitSeconds: Math.max(0, wait ?? 0) } };
    }
    if (e.status === 422) return { content: e.detail ?? "The assistant could not take that message. If it is very long, shorten it.", rollback: true };
    if (e.status === 413) return { content: "That message is too large to send.", rollback: true };
    if (e.status === 403) return { content: "The assistant refused this request.", rollback: true };
  }
  // A dropped connection, a proxy's 502/504, a network error: the turn may have run steps on
  // the server before the answer got lost. Keep the question, say so, and offer a manual retry
  // only (an automatic "Retry" could repeat a write).
  return { content: "The answer didn't arrive. Check whether anything changed before you try again.", rollback: false, retry: { label: "Try again" } };
}

/** A 200 reply with an error code → its retry button (the message is already readable). */
export function retryForReply(reply: Pick<AgentTurnResponse, "errorCode">): ChatFailure["retry"] | undefined {
  switch (reply.errorCode) {
    case "llm_timeout":
    case "llm_busy":
    case "llm_unavailable":
    case "llm_error":
      return { label: "Retry" }; // nothing changed: resending is safe
    case "internal_error":
      return { label: "Try again" }; // unknown point: a manual choice only
    default:
      return undefined; // too large / not configured fail the same way; incomplete already ran steps
  }
}

/** Whether a reply only reports a failed turn (not saved). `incomplete` ran steps and is kept. */
export function isFailureReply(reply: Pick<AgentTurnResponse, "errorCode">): boolean {
  return !!reply.errorCode && reply.errorCode !== "incomplete";
}
