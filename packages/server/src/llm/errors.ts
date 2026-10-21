/**
 * A provider returned a non-2xx HTTP response. Carries the status so callers can tell a
 * client/config error (4xx — surface it, don't retry or fall through and re-bill) from a
 * transient upstream error (5xx / 429 — fall through to the next provider). The raw
 * provider `detail` is kept for server-side logs only; it must NOT be returned to clients.
 */
export class HttpProviderError extends Error {
  constructor(
    public provider: string,
    public status: number,
    public detail: string
  ) {
    super(`${provider} ${status}`);
    this.name = "HttpProviderError";
  }

  /** 4xx (except 429) = the request itself is wrong; retrying/falling through wastes spend. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

/** The provider's words for "no such model" or "not this model for you". */
export const MODEL_REFUSED =
  /(?:unknown|invalid|unsupported|not a valid) model|model\b[^.\n]{0,80}?(?:not (?:found|supported|available)|does not exist)|(?:access|permission) to (?:use )?(?:the |this |that )?(?:specified )?model/;

/** The provider's words for an account that can't pay for the call. */
export const BILLING_PROBLEM = /credit balance|insufficient_quota|billing|payment required|out of credits?/;

/**
 * This provider can't serve the call, though another one could: its key is wrong or revoked
 * (401/403), the account is out of credit (402, or a 400 saying so), or it doesn't have the
 * model (404, or a 400 naming it). A router moves to its next provider on these. Anything else
 * in 4xx is the request itself (a malformed body, too large) and would fail anywhere.
 */
export function isProviderSpecific(e: unknown): boolean {
  if (!(e instanceof HttpProviderError)) return false;
  if (e.status === 401 || e.status === 402 || e.status === 403 || e.status === 404) return true;
  const detail = (e.detail || "").toLowerCase();
  return e.status === 400 && (BILLING_PROBLEM.test(detail) || MODEL_REFUSED.test(detail));
}

/** Every provider in a router's chain failed. `errors` keeps each one, in chain order. */
export class AllProvidersFailedError extends Error {
  constructor(public errors: unknown[]) {
    super(`All LLM providers failed: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join(" | ")}`);
    this.name = "AllProvidersFailedError";
  }
}
