import { envInt } from "../env.js";

/**
 * fetch() with a hard timeout and ONE retry on network/timeout errors only.
 *
 * Why: a hung provider with no timeout pins a request for ~5 minutes, and in the
 * router's fallback chain that stacks across every provider. AbortSignal.timeout caps
 * each attempt. We retry ONCE on transport failures (DNS, reset, timeout) with a small
 * backoff — but NEVER on an HTTP response, so a 4xx (bad key, bad request) surfaces
 * immediately instead of being retried and re-billed.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; retries?: number; backoffMs?: number }
): Promise<Response> {
  const retries = opts.retries ?? 1;
  const backoff = opts.backoffMs ?? 300;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Returns as soon as headers arrive; a 4xx/5xx is a resolved Response, not a throw.
      return await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (e) {
      // Only transport-level failures (timeout / network) throw here — safe to retry.
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, backoff * (attempt + 1)));
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`network error after ${retries + 1} attempt(s): ${reason}`);
}

export function llmTimeoutMs(): number {
  return envInt("PA_LLM_TIMEOUT_MS", 30_000, { min: 1 });
}

export function voiceTimeoutMs(): number {
  return envInt("PA_VOICE_TIMEOUT_MS", 30_000, { min: 1 });
}

export function maxTokens(): number {
  return envInt("PA_MAX_TOKENS", 1024, { min: 1 });
}
