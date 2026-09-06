import { envInt } from "../env.js";

/**
 * fetch() with a hard timeout and ONE retry, but ONLY on a genuine pre-response CONNECTION
 * failure (the request never reached the server).
 *
 * Why the narrow retry: every provider call here is a NON-idempotent POST that spends money.
 * If the request already reached the provider and we time out waiting for the response, the
 * provider may STILL be generating (and billing) — retrying would double-bill and could
 * double-execute. So we retry ONLY when we're sure the server never got the request:
 * connection refused / DNS failure / socket hang up before any response. A timeout
 * (AbortError) is explicitly NOT retried, and neither is any HTTP response (a 4xx/5xx is a
 * resolved Response, not a throw — it surfaces immediately).
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
      lastErr = e;
      // Retry ONLY a genuine connection error, and only if we have attempts left. A timeout
      // (the request may have landed and be billing) or any other error is surfaced as-is.
      if (attempt < retries && isRetryableConnectionError(e)) {
        await new Promise((r) => setTimeout(r, backoff * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`network error: ${reason}`);
}

/**
 * True only for pre-response CONNECTION failures where the request never reached the server,
 * so a retry cannot double-execute or double-bill: connection refused, DNS not found, or a
 * socket hang up before any bytes of a response arrived.
 *
 * Deliberately EXCLUDES the timeout AbortError (`e.name === "AbortError"` /
 * "TimeoutError"): once the request is in flight the provider may already be generating and
 * billing, so we must NOT re-send it.
 */
export function isRetryableConnectionError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // A timeout aborts the request — never retry it (it may have reached the provider).
  if (e.name === "AbortError" || e.name === "TimeoutError") return false;
  const code = (e as NodeJS.ErrnoException).code;
  if (code && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EPIPE"].includes(code)) return true;
  // Undici wraps the low-level cause; inspect it and the message for the same signals.
  const cause = (e as { cause?: unknown }).cause;
  const causeCode = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  if (causeCode && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EPIPE"].includes(causeCode)) return true;
  const msg = `${e.message} ${cause instanceof Error ? cause.message : ""}`.toLowerCase();
  return /econnrefused|enotfound|eai_again|socket hang up|econnreset|dns|getaddrinfo|network|failed to fetch/.test(msg);
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
