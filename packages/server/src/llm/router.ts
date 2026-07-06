import type { LLMProvider, LLMCompletionInput } from "@page-assistant/core";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { HttpProviderError } from "./errors.js";

/** Available models for widget settings UI and /v1/models endpoint. */
export const AVAILABLE_MODELS = [
  { id: "gpt-4o-mini", label: "GPT-4o Mini", provider: "openai" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", provider: "anthropic" },
  { id: "anthropic/claude-3.5-haiku", label: "Claude 3.5 Haiku (OpenRouter)", provider: "openrouter" },
];

/**
 * Pick an LLM provider from env, with a fallback chain (Anthropic → OpenAI → OpenRouter).
 * Supports per-request model override from the widget settings.
 */
export function routerFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const chain = buildChain(env);
  if (!chain.length) throw new Error("No LLM key set. Provide ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY.");

  return {
    name: "router",
    async complete(input) {
      const model = input.model;
      if (model) {
        const targeted = providerForModel(model, env);
        // An explicit model override must NOT silently fall back to the default chain —
        // that would bill a different model than asked for. Fail loudly instead.
        if (!targeted) {
          throw new Error(
            `Requested model "${model}" has no configured provider (need the matching API key). ` +
              `Set the key for that model, or omit "model" to use the default chain.`
          );
        }
        return targeted.complete({ ...input, model: undefined });
      }
      const errors: string[] = [];
      for (const p of chain) {
        try {
          return await p.complete({ ...input, model: undefined });
        } catch (e) {
          // A 4xx is a request/config problem (bad key, malformed body). Trying the next
          // provider just wastes spend and hides the real cause — surface it immediately.
          if (e instanceof HttpProviderError && e.isClientError) throw e;
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      // Every provider failed transiently — surface all causes, not just the last.
      throw new Error(`All LLM providers failed: ${errors.join(" | ")}`);
    },
  };
}

function buildChain(env: NodeJS.ProcessEnv): LLMProvider[] {
  const chain: LLMProvider[] = [];
  if (env.ANTHROPIC_API_KEY) chain.push(anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.PA_ANTHROPIC_MODEL }));
  if (env.OPENAI_API_KEY) chain.push(openaiProvider({ apiKey: env.OPENAI_API_KEY, model: env.PA_OPENAI_MODEL }));
  if (env.OPENROUTER_API_KEY)
    chain.push(
      openaiProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: "https://openrouter.ai/api/v1",
        model: env.PA_OPENROUTER_MODEL ?? "anthropic/claude-3.5-haiku",
      })
    );
  return chain;
}

function providerForModel(model: string, env: NodeJS.ProcessEnv): LLMProvider | null {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude") && env.ANTHROPIC_API_KEY) {
    return anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model });
  }
  if (lower.includes("/") && env.OPENROUTER_API_KEY) {
    return openaiProvider({ apiKey: env.OPENROUTER_API_KEY, baseUrl: "https://openrouter.ai/api/v1", model });
  }
  if (env.OPENAI_API_KEY) {
    return openaiProvider({ apiKey: env.OPENAI_API_KEY, model });
  }
  if (env.ANTHROPIC_API_KEY) {
    return anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model });
  }
  return null;
}
