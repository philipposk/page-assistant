import { MODEL_CATALOG, MODEL_DEFAULTS, type CatalogModel, type LLMProvider, type LLMCompletionInput } from "@page-assistant/core";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider, OPENROUTER_BASE_URL } from "./openai.js";
import { AllProvidersFailedError, HttpProviderError, isProviderSpecific } from "./errors.js";
import { llmTimeoutMs } from "./fetchWithRetry.js";
import { claudeIdFromOpenRouter } from "./modelRules.js";

/**
 * Models the widget settings UI and /v1/models may offer, most capable first. The list lives
 * in core (MODEL_CATALOG), with every other model id, so a retired one is changed in one place.
 */
export const AVAILABLE_MODELS: readonly CatalogModel[] = MODEL_CATALOG;

/** Time the next provider in the chain needs to be worth starting. */
const MIN_FALLBACK_MS = 3_000;

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
 *
 * The next provider is tried when this one can't serve the call (busy, down, unreachable, a
 * bad or revoked key, no credit, or no such model) — not when the request itself is wrong
 * (it would fail everywhere) and not after a timeout (the request may still be running and
 * billing). The whole chain shares the call's time budget (`timeoutMs`): a fallback gets
 * what is left, and none starts with less than a few seconds.
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
      const budget = input.timeoutMs ?? llmTimeoutMs();
      const deadline = Date.now() + budget;
      const errors: unknown[] = [];
      for (const [i, p] of chain.entries()) {
        const remaining = deadline - Date.now();
        if (i > 0 && remaining < MIN_FALLBACK_MS) break;
        try {
          return await p.complete({ ...input, model: undefined, timeoutMs: i === 0 ? budget : remaining });
        } catch (e) {
          // The caller gave up (Stop, or its deadline): don't start the same request elsewhere.
          if (input.signal?.aborted) throw e;
          // A malformed or too-large request fails the same on every provider: say so now
          // instead of paying for it twice.
          if (e instanceof HttpProviderError && e.isClientError && !isProviderSpecific(e)) throw e;
          errors.push(e);
          // Timed out: the request may have landed and still be generating (and billing).
          if (isTimeout(e)) break;
        }
      }
      // Every provider tried has failed — surface all causes, not just the last.
      throw new AllProvidersFailedError(errors);
    },
  };
}

function buildChain(env: NodeJS.ProcessEnv): LLMProvider[] {
  const chain: LLMProvider[] = [];
  if (env.ANTHROPIC_API_KEY) chain.push(anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.PA_ANTHROPIC_MODEL }));
  if (env.OPENAI_API_KEY) chain.push(openaiProvider({ apiKey: env.OPENAI_API_KEY, model: env.PA_OPENAI_MODEL }));
  if (env.OPENROUTER_API_KEY) chain.push(openRouterProvider(env.OPENROUTER_API_KEY, env.PA_OPENROUTER_MODEL ?? MODEL_DEFAULTS.openrouter));
  return chain;
}

/**
 * OpenRouter speaks both formats. Its Claude models go through the Anthropic-format endpoint
 * (`/messages`), so thinking blocks survive between tool rounds and the model rules for
 * temperature and forced tool_choice apply; every other model uses chat completions.
 */
function openRouterProvider(apiKey: string, model: string): LLMProvider {
  if (claudeIdFromOpenRouter(model)) return anthropicProvider({ apiKey, baseUrl: OPENROUTER_BASE_URL, auth: "bearer", model });
  return openaiProvider({ apiKey, baseUrl: OPENROUTER_BASE_URL, model });
}

function providerForModel(model: string, env: NodeJS.ProcessEnv): LLMProvider | null {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude") && env.ANTHROPIC_API_KEY) {
    return anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model });
  }
  if (lower.includes("/") && env.OPENROUTER_API_KEY) {
    return openRouterProvider(env.OPENROUTER_API_KEY, model);
  }
  if (env.OPENAI_API_KEY) {
    return openaiProvider({ apiKey: env.OPENAI_API_KEY, model });
  }
  if (env.ANTHROPIC_API_KEY) {
    return anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model });
  }
  return null;
}

function isTimeout(e: unknown): boolean {
  const msg = (e instanceof Error ? `${e.name} ${e.message}` : String(e)).toLowerCase();
  return /timeouterror|timed? ?out|aborted due to timeout/.test(msg);
}
