import type { LLMProvider, LLMCompletionInput } from "@page-assistant/core";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { HttpProviderError } from "./errors.js";

/**
 * Models the widget settings UI and /v1/models may offer, newest and most capable first.
 * Ids are exact and carry no date suffix (`claude-haiku-4-5`, never
 * `claude-haiku-4-5-20251001`).
 */
export const AVAILABLE_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", provider: "anthropic" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", provider: "openai" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (OpenRouter)", provider: "openrouter" },
];

/**
 * What this deployment will actually honour for `model`, for `GET /v1/models`.
 *
 * Two things the old endpoint got wrong: it listed every model regardless of which
 * provider keys were set, and it gave the widget no way to know that the server ignores
 * the client's choice — so the settings panel showed a picker that changed nothing.
 *
 * Set `PA_FIXED_MODEL` to pin the model server-side: the router then ignores whatever the
 * client asks for, and the widget hides the picker instead of pretending.
 */
export function modelCatalog(env: NodeJS.ProcessEnv = process.env): {
  models: typeof AVAILABLE_MODELS;
  fixed: boolean;
  reason?: string;
} {
  if (env.PA_FIXED_MODEL) {
    return { models: [], fixed: true, reason: "The model is chosen by this site and cannot be changed here." };
  }
  const models = AVAILABLE_MODELS.filter((m) => {
    if (m.provider === "anthropic") return !!env.ANTHROPIC_API_KEY;
    if (m.provider === "openai") return !!env.OPENAI_API_KEY;
    if (m.provider === "openrouter") return !!env.OPENROUTER_API_KEY;
    return false;
  });
  // Nothing to choose between is not a choice — treat one (or zero) model as fixed so the
  // widget explains instead of offering a one-item dropdown.
  return { models, fixed: models.length <= 1 };
}

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
      // A pinned deployment ignores the client's model outright — that is the whole point
      // of PA_FIXED_MODEL, so a visitor cannot upgrade themselves onto a costlier one.
      if (env.PA_FIXED_MODEL) {
        const pinned = providerForModel(env.PA_FIXED_MODEL, env);
        if (!pinned) throw new Error(`PA_FIXED_MODEL "${env.PA_FIXED_MODEL}" has no configured provider (need the matching API key).`);
        return pinned.complete({ ...input, model: undefined });
      }
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
