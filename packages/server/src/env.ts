// Small env-parsing + structured-logging helpers shared across the server.
// Kept dependency-free.

/**
 * Parse an integer env var, falling back to `def` and WARNING (once) on bad input.
 * The original `Number(process.env.X ?? d)` returns NaN on garbage, and NaN comparisons
 * are always false — a rate limit of NaN silently disables the limiter. This makes bad
 * config loud and safe instead of silently open.
 */
export function envInt(name: string, def: number, opts: { min?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  const min = opts.min ?? 0;
  if (!Number.isFinite(n) || n < min) {
    log("warn", { route: "boot", msg: `env ${name}="${raw}" is not a valid number >= ${min}; using default ${def}` });
    return def;
  }
  return Math.floor(n);
}

/** Parse a boolean-ish env var: "1", "true", "yes", "on" → true. Unset/other → def. */
export function envBool(name: string, def = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Express `trust proxy` value from PA_TRUST_PROXY. Off by default so req.ip can't be
 * spoofed via X-Forwarded-For when NOT behind a trusted proxy. "1"/"true"/"yes" → true,
 * a number → that many proxy hops, otherwise the raw string (subnet / "loopback").
 */
export function trustProxySetting(): boolean | number | string {
  const raw = process.env.PA_TRUST_PROXY;
  if (raw === undefined || raw === "") return false;
  const t = raw.trim();
  if (/^(1|true|yes|on)$/i.test(t)) return true;
  if (/^(0|false|no|off)$/i.test(t)) return false;
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  return t; // e.g. "loopback", a subnet
}

type Level = "info" | "warn" | "error";

/** Structured JSON-line logger. One object per line: easy to grep / ship to a log pipe. */
export function log(level: Level, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
