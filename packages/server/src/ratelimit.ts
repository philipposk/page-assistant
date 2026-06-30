import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Fixed-window per-IP rate limiter, dependency-free. These endpoints spend real money
 * (LLM tokens, ElevenLabs characters) — without this, anyone who finds the URL can
 * drain the host's API credit.
 */
export function rateLimit(opts: { windowMs: number; max: number; name?: string }) {
  const hits = new Map<string, { n: number; reset: number }>();
  // Bound memory: sweep expired windows periodically instead of growing forever.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }, opts.windowMs * 2);
  // Don't hold the process open just for the sweeper.
  if (typeof sweeper.unref === "function") sweeper.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now > h.reset) {
      h = { n: 0, reset: now + opts.windowMs };
      hits.set(key, h);
    }
    h.n++;
    if (h.n > opts.max) {
      res.setHeader("retry-after", Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: `Rate limit exceeded${opts.name ? ` for ${opts.name}` : ""}. Try again shortly.` });
    }
    next();
  };
}

/**
 * Optional shared-secret gate for the money-spending endpoints. When PA_AUTH_TOKEN is
 * set, requests must send `Authorization: Bearer <token>`. Unset = open (dev mode).
 */
export function bearerAuth(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) return next();
    const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    try {
      const a = Buffer.from(got);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return next();
    } catch {
      /* length mismatch */
    }
    res.status(401).json({ error: "Missing or invalid bearer token." });
  };
}
