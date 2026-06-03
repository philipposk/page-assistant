import type { LLMProvider } from "@page-assistant/core";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";

/**
 * Pick an LLM provider from env, with a fallback chain (Anthropic → OpenAI → OpenRouter).
 * Slimmed from AI-OS router.py. Returns a provider that tries each configured backend in order.
 */
export function routerFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const chain: LLMProvider[] = [];
  if (env.ANTHROPIC_API_KEY) chain.push(anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.PA_ANTHROPIC_MODEL }));
  if (env.OPENAI_API_KEY) chain.push(openaiProvider({ apiKey: env.OPENAI_API_KEY, model: env.PA_OPENAI_MODEL }));
  if (env.OPENROUTER_API_KEY)
    chain.push(openaiProvider({ apiKey: env.OPENROUTER_API_KEY, baseUrl: "https://openrouter.ai/api/v1", model: env.PA_OPENROUTER_MODEL ?? "anthropic/claude-3.5-haiku" }));
  if (!chain.length) throw new Error("No LLM key set. Provide ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY.");

  return {
    name: "router",
    async complete(input) {
      let lastErr: unknown;
      for (const p of chain) {
        try {
          return await p.complete(input);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    },
  };
}
