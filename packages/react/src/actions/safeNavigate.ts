// A `navigate` path ultimately comes from a model turn. Nothing should be able to talk the
// app into sending the user off-site, so only same-app absolute paths are followed. The server
// checks the same rule; this is the second lock.

/** True when the string contains a C0 control character or DEL. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isSafeInAppPath(to: unknown): to is string {
  if (typeof to !== "string") return false;
  const path = to.trim();
  if (!path.startsWith("/")) return false; // no absolute URLs, no relative escapes
  if (path.startsWith("//")) return false; // protocol-relative resolves off-site
  // Browsers read a backslash as "/" in http URLs, so "/\host" is "//host".
  if (path.includes("\\")) return false;
  if (hasControlChars(path)) return false;
  if (/^\/*[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.length <= 2048;
}

// Resolving a path needs a base; this host never exists, so a path that lands anywhere else
// than on it escaped.
const NAV_BASE = "http://in-app.invalid";

/**
 * Where a `navigate` action may go, written out the way it will be followed: an in-app path
 * that is not an API route or a sign-out, or null. Navigation happens without a click, so it
 * must never hit a GET with side effects. The path is resolved first (`/notes/../api/x`,
 * `/./logout`, `/%2e/api/x` all point somewhere else than they read), and the result is what
 * gets followed. Same rule as the server's `normalizeNavigationPath`.
 */
export function normalizeNavigationPath(to: unknown): string | null {
  if (!isSafeInAppPath(to)) return null;
  let url: URL;
  try {
    url = new URL(to.trim(), NAV_BASE);
  } catch {
    return null;
  }
  if (url.origin !== NAV_BASE) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return null;
  }
  // An encoded slash or dot segment that only a decoding server would resolve, a `;` path
  // parameter some servers drop (`/api;x`, `/a/..;/api`), or a second layer of encoding.
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded) || /[\\;%]/.test(decoded)) return null;
  if (/^\/+api(?:\/|$)/.test(decoded)) return null;
  if (SIGN_OUT.test(decoded)) return null;
  // A sign-out asked for in the query (`/?logout=1`, `/session?action=sign_out`).
  let query: string;
  try {
    query = decodeURIComponent(url.search.replace(/\+/g, " ")).toLowerCase();
  } catch {
    return null;
  }
  if (/(?:^|[?&=/])(?:sign[-_]?out|log[-_]?out|log[-_]?off|sign[-_]?off)(?:$|[&=/.])/.test(query)) return null;
  return url.pathname + url.search + url.hash;
}

const SIGN_OUT = /(?:^|\/)(?:sign[-_]?out|log[-_]?out|log[-_]?off|sign[-_]?off)(?:\/|$|\.)/;

export function isSafeNavigationPath(to: unknown): to is string {
  return normalizeNavigationPath(to) !== null;
}

/** An http(s) link safe to open in a new tab. */
export function isExternalHttpUrl(href: unknown): href is string {
  if (typeof href !== "string") return false;
  try {
    const u = new URL(href.trim());
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
