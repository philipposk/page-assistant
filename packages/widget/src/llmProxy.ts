import type { LLMProvider, LLMCompletionInput, LLMCompletionOutput } from "@page-assistant/core";

/**
 * Client-side LLM provider that proxies each grounding round to the backend, so the
 * API key never reaches the browser. The grounding loop itself runs in the page, which
 * means capabilities (real host functions) execute locally — results are never round-tripped
 * through the model and so cannot be fabricated.
 */
export function proxyProvider(serverUrl: string): LLMProvider {
  return {
    name: "proxy",
    async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
      const res = await fetch(`${serverUrl.replace(/\/$/, "")}/v1/llm/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`assistant backend ${res.status}: ${await res.text()}`);
      return res.json();
    },
  };
}
