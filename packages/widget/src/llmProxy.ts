import type { LLMProvider, LLMCompletionInput, LLMCompletionOutput } from "@page-assistant/core";

/**
 * Client-side LLM provider that proxies each grounding round to the backend, so the
 * API key never reaches the browser. The grounding loop itself runs in the page, which
 * means capabilities (real host functions) execute locally — results are never round-tripped
 * through the model and so cannot be fabricated.
 */
export function proxyProvider(serverUrl: string, authToken?: string, getModel?: () => string | undefined): LLMProvider {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  return {
    name: "proxy",
    async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
      const model = getModel?.();
      const body = model ? { ...input, model } : input;
      const res = await fetch(`${serverUrl.replace(/\/$/, "")}/v1/llm/complete`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`assistant backend ${res.status}: ${await res.text()}`);
      return res.json();
    },
  };
}
