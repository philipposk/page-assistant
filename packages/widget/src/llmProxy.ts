import type { LLMProvider, LLMCompletionInput, LLMCompletionOutput } from "@page-assistant/core";

/** Carries the HTTP status (or 0 for network/timeout) so the UI can map to a friendly string. */
export class ProxyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ProxyError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Client-side LLM provider that proxies each grounding round to the backend, so the
 * API key never reaches the browser. The grounding loop itself runs in the page, which
 * means capabilities (real host functions) execute locally — results are never round-tripped
 * through the model and so cannot be fabricated.
 */
export function proxyProvider(
  serverUrl: string,
  authToken?: string,
  getModel?: () => string | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS
): LLMProvider {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  return {
    name: "proxy",
    async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
      const model = getModel?.();
      const body = model ? { ...input, model } : input;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(`${serverUrl.replace(/\/$/, "")}/v1/llm/complete`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e: any) {
        // AbortError (timeout) or "Failed to fetch" (offline / CORS / DNS) → status 0.
        throw new ProxyError(0, e?.name === "AbortError" ? "request timed out" : "network error");
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ProxyError(res.status, `assistant backend ${res.status}: ${text}`);
      }
      return res.json();
    },
  };
}
