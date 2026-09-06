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
