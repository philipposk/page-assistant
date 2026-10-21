// Fixed reply texts and text helpers for agent mode. Plain language: these reach end users.

import type { AgentErrorCode } from "./types.js";

export const FAILURE_MESSAGES: Record<Exclude<AgentErrorCode, "incomplete">, string> = {
  llm_timeout:
    "The assistant took too long to answer, so I stopped waiting. Nothing was changed. Please try again, or ask for something smaller.",
  llm_busy: "The assistant's AI service is busy right now. Nothing was changed. Please try again in a minute.",
  llm_unavailable:
    "The assistant's AI service can't be reached right now. Nothing was changed. Please try again in a few minutes.",
  llm_error:
    "The assistant's AI service could not handle this request. Nothing was changed. Please try again or rephrase it.",
  llm_too_large:
    "That request was too big for the assistant to take in one go. Nothing was changed. Ask for less at once, or start a new chat.",
  llm_not_configured:
    "The assistant can't answer right now because its AI service is not set up. Nothing was changed. Trying again won't help until it is fixed.",
  internal_error:
    "Something went wrong on my side and I could not finish. Check whether anything changed before you try again.",
};

export function failureMessage(code: AgentErrorCode): string {
  return code === "incomplete" ? STOPPED_AFTER_STEPS : FAILURE_MESSAGES[code] ?? FAILURE_MESSAGES.llm_error;
}

/** Under the steps that ran when the model stopped answering after them. */
export const STOPPED_AFTER_STEPS =
  "The AI service stopped answering after this, so I could not finish. If you asked for more than what is above, ask me for the rest.";
export const NO_REPLY_MESSAGE = "I could not produce a reply. Please try again or narrow your request.";
export const TOO_MANY_STEPS_MESSAGE = "That took too many steps. Please simplify your request.";
export const REFUSAL_MESSAGE = "I can't help with that request.";
export const FORCED_TOOL_SKIPPED_MESSAGE =
  "I could not complete the data check that question needs, so I will not guess. Please try again, a bit more specifically.";
export const UNVERIFIED_NUMBERS_MESSAGE =
  "I couldn't check the figures in my answer against your data, so I won't guess. Please ask again, a bit more specifically.";

export const CONFIRM_EXPIRED_MESSAGE =
  "That confirmation has expired or was already used, so nothing ran. Ask me again if you still want it.";
export const CONFIRM_GONE_MESSAGE = "That action can no longer be confirmed. Ask me again.";
/** A tool that ran past the turn's deadline (or Stop). It may still finish on its own. */
export const TOOL_TIMEOUT_MESSAGE =
  "That took too long, so I stopped waiting. It may still finish — check before you try again.";
export const CARD_MESSAGE = "This needs your OK. Confirm on the card below.";
/** Said under every confirm card: a turn that asks a question runs nothing after it. */
export const CARD_STOPS_THE_TURN =
  "I stopped at the question above and ran nothing after it. Answer it, then ask me for anything else you wanted.";
export const TEXT_CARD_STOPS_THE_TURN = "I stopped there and ran nothing after it. Ask me for anything else you wanted.";

// --- Prompt-injection guard ("tainted" turns) --------------------------------------------

/** The reply under a card in a turn that read text someone else wrote. */
export const TAINTED_CARD_MESSAGE =
  "I read text someone else wrote in this chat (a document, a web page or a message), so I need your OK before I change anything. Confirm on the card below.";
/**
 * What a write answers in such a turn. The text stays in this chat's history (the model reads it
 * again next turn), so the way out is a new chat, not a new message.
 */
export const WRITE_REFUSAL =
  "I read text someone else wrote in this chat (a document, a web page or a message), and it could contain instructions that aren't yours, so I won't change anything here. Start a new chat and ask me again.";
/** The last line of a card in a tainted turn. */
export const TAINT_NOTE =
  "I read text someone else wrote in this chat. Check this is what you asked for.";

/** Between two step answers of one turn. */
export const RENDER_SEPARATOR = "\n\n---\n\n";

export function joinRenders(parts: string[]): string {
  return parts.filter((p) => (p ?? "").trim()).join(RENDER_SEPARATOR);
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Longest value shown on a card line. */
const MAX_VALUE_CHARS = 300;

/** One card value, verbatim: a bool as yes/no, a list joined with commas, one line, cut at 300. */
export function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  let text: string;
  if (Array.isArray(value)) text = value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
  else if (value && typeof value === "object") text = JSON.stringify(value);
  else text = String(value ?? "");
  text = text.split(/\s+/).filter(Boolean).join(" ");
  if (text.length > MAX_VALUE_CHARS) {
    return `${text.slice(0, MAX_VALUE_CHARS)} … (${text.length - MAX_VALUE_CHARS} more characters)`;
  }
  return text;
}

/** "cvr_number" → "Cvr number". */
export function labelFor(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

/**
 * A closing model line worth showing under step answers: one that asks something back or
 * says what could not be done. Every other closing line is a summary of the steps above it,
 * and a summary that drifts from them is worse than none.
 */
const UNFINISHED_BUSINESS_RE =
  /\?|can'?t\b|cannot\b|can not\b|couldn'?t\b|could not\b|unable\b|won'?t\b|will not\b|don'?t have\b|do not have\b|no tool\b/i;

export function hasUnfinishedBusiness(text: string): boolean {
  return !!text && UNFINISHED_BUSINESS_RE.test(text);
}

const FAILURE_LINES = [...Object.values(FAILURE_MESSAGES), STOPPED_AFTER_STEPS, NO_REPLY_MESSAGE, TOO_MANY_STEPS_MESSAGE];

/** An assistant history line without the failure sentences the model would read as its own words. */
export function stripFailureLines(text: string): string {
  let out = text;
  for (const line of FAILURE_LINES) out = out.split(line).join("");
  return out.replace(/^(?:\s*---\s*)+|(?:\s*---\s*)+$/g, "").trim();
}

// --- Markdown cleaning for text someone else wrote ----------------------------------------

// Control characters (except tab and line end), bidi overrides, zero-width characters.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Every quantifier is bounded or stops at the next bracket, so a hostile document full of
// "[](" or "![" costs linear time, not cubic (an unbounded `[^)]*` after `[^)\s]*` froze the
// process on a few kilobytes).
const IMAGE_RE = /!\[[^\][\n]{0,500}\]\([^)\n]{0,2048}\)|!\[[^\][\n]{0,500}\]\[[^\][\n]{0,500}\]/g;
const LINK_RE = /\[([^\][\n]{0,500})\]\(\s{0,10}([^)\s]{0,2048})(?:\s{1,10}"[^"\n]{0,300}")?\s{0,10}\)/g;
const REF_DEF_RE = /^ {0,3}\[[^\]\n]{1,500}\]:[ \t]*(\S{1,2048}).*$/gm;
/** Longest text cleaned; the rest is cut (cleaning is linear, but replies need no more). */
export const MAX_CLEAN_CHARS = 50_000;

export interface CleanOptions {
  /**
   * In a turn that read untrusted text, an http(s) link is kept only when its address is in
   * here (it came from a tool result word for word; compared by `canonicalUrl`, so give
   * addresses in that form); any other becomes plain text, so injected
   * prose can't plant a click-to-leak link (`https://evil/?d=<private data>`).
   */
  keepUrls?: ReadonlySet<string>;
}

/**
 * Make model or tool markdown safe to render in a turn that read untrusted text. What comes
 * out holds no image (an image address can carry private data out), no raw HTML, and no link
 * that is not http(s) or an in-app path. Idempotent; never throws.
 */
export function cleanMarkdown(text: string, opts: CleanOptions = {}): string {
  try {
    let current = String(text ?? "");
    if (current.length > MAX_CLEAN_CHARS) current = current.slice(0, MAX_CLEAN_CHARS) + "…";
    for (let pass = 0; pass < 5; pass++) {
      const next = cleanPass(current, opts);
      if (next === current) return next;
      current = next;
    }
    return plainText(current);
  } catch {
    return plainText(String(text ?? "").slice(0, MAX_CLEAN_CHARS));
  }
}

function cleanPass(text: string, opts: CleanOptions): string {
  let s = text.replace(/\r\n?|\u2028|\u2029/g, "\n").replace(HIDDEN_CHARS, "");
  s = s.replace(IMAGE_RE, "");
  s = s.replace(LINK_RE, (_m, label: string, href: string) => (isSafeHref(href, opts) ? `[${label}](${href})` : label));
  s = s.replace(REF_DEF_RE, (line, href: string) => (isSafeHref(href, opts) ? line : ""));
  // No raw HTML and no <scheme:...> autolink can start: every "<" becomes exactly "\<"
  // (any backslashes already in front of it go, so "\\<" cannot leave a live "<").
  s = s.replace(/\\*</g, "\\<");
  return s;
}

/**
 * Characters a kept link's address may not contain. The client renderer reads `\`, backticks,
 * `*` and brackets as markdown, so an address holding them can hide a second link inside the
 * first that only the client would see (`[a](/x[b](https://evil/?d=…)`).
 */
const HREF_MARKUP = /[[\]()`*<>\\"'\s]/;

function isSafeHref(href: string, opts: CleanOptions): boolean {
  const h = href.trim();
  if (HREF_MARKUP.test(h)) return false;
  if (/^https?:\/\//i.test(h)) return !opts.keepUrls || opts.keepUrls.has(canonicalUrl(h));
  return h.startsWith("/") && !h.startsWith("//") && !h.includes("\\");
}

/** Every http(s) address written in a value (a tool result), for `keepUrls`. */
export function urlsIn(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 8 || out.size > 500 || value === null || value === undefined) return out;
  if (typeof value === "string") {
    for (const m of value.slice(0, MAX_CLEAN_CHARS).match(/https?:\/\/[^\s)<>"'\]]{1,2048}/gi) ?? []) out.add(m);
  } else if (Array.isArray(value)) value.slice(0, 500).forEach((v) => urlsIn(v, out, depth + 1));
  else if (typeof value === "object") Object.values(value as Record<string, unknown>).slice(0, 500).forEach((v) => urlsIn(v, out, depth + 1));
  return out;
}

/**
 * An http(s) address in one canonical spelling (scheme and host lower-cased, default port and
 * empty path filled in), so `HTTPS://Evil.com` and `https://evil.com/` compare equal. The
 * input as it is when it doesn't parse.
 */
export function canonicalUrl(url: string): string {
  try {
    return new URL(url.trim()).href;
  } catch {
    return url.trim();
  }
}

/** Without hidden characters: control characters, bidi overrides, zero-width characters. */
export function stripHidden(text: string): string {
  return String(text ?? "").replace(HIDDEN_CHARS, "");
}

function plainText(text: string): string {
  return text.replace(HIDDEN_CHARS, "").replace(/[!\[\]<>]|https?:\/\/\S+/g, "");
}
