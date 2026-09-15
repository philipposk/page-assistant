/**
 * Rewrites applied to every user-facing reply, so configuration and internals the host
 * never meant to show do not reach the user: credentials, connection strings, environment
 * variable names, and whatever the host adds (internal system names, old product names).
 *
 * A reply mixes model prose with host-written render() output and raw error text from
 * run(), so no single author can be trusted to keep these out; this runs last, on the
 * final text.
 */

/**
 * `[pattern, replacement]`. A string pattern matches as a whole word, case-insensitively;
 * a RegExp is used as given (made global). The replacement may use `$1`-style groups.
 */
export type ScrubRule = [pattern: string | RegExp, replacement: string];

const REDACTED = "[redacted]";

/** On by default. Nothing here is ever useful to the person reading the reply. */
export const DEFAULT_SCRUB_RULES: ScrubRule[] = [
  // Connection strings carry hosts and often passwords.
  [/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|rediss?|amqps?):\/\/[^\s"'<>]+/gi, REDACTED],
  // Provider API keys, GitHub and AWS tokens, JWTs, bearer headers.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/g, `$1 ${REDACTED}`],
  // Environment variable names: configuration the user cannot act on. Only names with a
  // configuration suffix, so an ordinary status value such as IN_PROGRESS is left alone.
  [
    /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|URL|URI|DSN|HOST|PORT|ENABLED|DISABLED|MODEL(?:_ID)?)\b/g,
    "a server setting",
  ],
];

/**
 * For surfaces that render replies as plain text (the widget does): markdown emphasis and
 * inline code would otherwise show as literal `**` and backticks.
 */
export const PLAIN_TEXT_SCRUB_RULES: ScrubRule[] = [
  [/\*\*(?=\S)([^*\n]+?)\*\*/g, "$1"],
  [/__(?=\S)([^_\n]+?)__/g, "$1"],
  [/`([^`\n]+)`/g, "$1"],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(pattern: string | RegExp): RegExp {
  if (typeof pattern === "string") return new RegExp(`(?<![\\w])${escapeRegExp(pattern)}(?![\\w])`, "gi");
  return pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

/** Apply `rules` in order. */
export function scrubText(text: string, rules: ScrubRule[]): string {
  let out = text;
  for (const [pattern, replacement] of rules) {
    const re = compile(pattern);
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}
