// Small request guards shared by the agent and voice routes.

/**
 * Read a request body, but stop at `max` bytes: null when it is bigger. A missing or false
 * Content-Length (chunked uploads) can't make the server buffer more than `max`.
 */
export async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Refuse a request another site's page made with the user's cookies (CSRF). A browser says
 * where a request came from in `Sec-Fetch-Site`; only "same-origin" (or "none": typed, a
 * bookmark) passes unless `corsOrigin` names the caller. Without that header (an older browser)
 * the `Origin` must match the host. A non-browser caller (no Origin) passes: it carries no
 * victim's cookies. Returns the reason to refuse, or null.
 */
export function crossSiteRefusal(req: Request, corsOrigin?: string): string | null {
  const origin = req.headers.get("origin");
  const allowedOrigin = !!corsOrigin && (corsOrigin === "*" || origin === corsOrigin);
  const site = req.headers.get("sec-fetch-site");
  if (site) {
    if (site === "same-origin" || site === "none" || allowedOrigin) return null;
    return "Requests from other sites are not allowed.";
  }
  if (!origin || allowedOrigin) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return "Requests from other sites are not allowed.";
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? safeHost(req.url);
  return originHost === host ? null : "Requests from other sites are not allowed.";
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
