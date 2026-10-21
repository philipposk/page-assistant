/**
 * What a Claude model accepts, by model id. Newer models reject request fields older ones
 * took, and a field the model rejects fails the whole call with a 400, so the Anthropic
 * provider leaves out what a model does not take instead of sending it and failing.
 *
 * Ids are matched by family and version, so a dated id (`claude-haiku-4-5-20251001`) is
 * read the same as its alias.
 */

const id = (model: string) => model.trim().toLowerCase();

/**
 * Whether `temperature` may be sent. The 5.x generation and Opus 4.7/4.8 answer a
 * non-default temperature (or top_p / top_k) with a 400; Haiku 4.5, Sonnet/Opus 4.6 and
 * older take it.
 */
export function acceptsSampling(model: string): boolean {
  const m = id(model);
  if (/^claude-(fable|mythos)/.test(m)) return false;
  if (/^claude-(opus|sonnet|haiku)-5/.test(m)) return false;
  if (/^claude-opus-4-[78]/.test(m)) return false;
  return true;
}

/**
 * Whether a forced `tool_choice` ({type:"tool"} / {type:"any"}) is accepted. Fable 5.1,
 * Mythos 5.1, Opus 5.5 and Sonnet 5.5 (and later versions of those lines) answer it with a
 * 400; the provider then sends `auto` and the agent's prompt names the tool instead.
 * Haiku 5.5 still accepts it. The minor version is read as a whole number, so `-5-10` counts
 * as later than `-5-5` and a dated id (`claude-opus-5-20260101`) is not read as minor 20260101.
 */
export function acceptsForcedTool(model: string): boolean {
  const m = id(model);
  if (/^claude-(fable|mythos)-5-[1-9]\d?(?!\d)/.test(m)) return false;
  if (/^claude-(fable|mythos)-[6-9]/.test(m)) return false;
  if (/^claude-(opus|sonnet)-5-(?:[5-9]|[1-9]\d)(?!\d)/.test(m)) return false;
  if (/^claude-(opus|sonnet)-[6-9]/.test(m)) return false;
  return true;
}

/** Whether `output_config.effort` is accepted (it errors on Sonnet 4.5, Haiku 4.5 and older). */
export function acceptsEffort(model: string): boolean {
  const m = id(model);
  if (/^claude-(fable|mythos)/.test(m)) return true;
  if (/^claude-(opus|sonnet|haiku)-[5-9]/.test(m)) return true;
  if (/^claude-opus-4-[5-9]/.test(m)) return true;
  if (/^claude-sonnet-4-[6-9]/.test(m)) return true;
  return false;
}

/**
 * Whether the model thinks before it answers without being asked. The 5.x generation does,
 * and its thinking shares the `max_tokens` budget with the reply, so a small cap can be spent
 * before any text comes out.
 */
export function thinksByDefault(model: string): boolean {
  const m = id(model);
  if (/^claude-(fable|mythos)/.test(m)) return true;
  return /^claude-(opus|sonnet|haiku)-(?:[5-9]|[1-9]\d)(?!\d)/.test(m);
}

/**
 * A Claude model as OpenRouter writes it (`anthropic/claude-opus-4.7`) in Anthropic's own
 * form (`claude-opus-4-7`), so the rules above apply to it too; null for any other model.
 */
export function claudeIdFromOpenRouter(model: string): string | null {
  const m = id(model);
  if (!m.startsWith("anthropic/")) return null;
  return m.slice("anthropic/".length).replace(/:.*$/, "").replace(/\./g, "-");
}

/**
 * An OpenAI reasoning model (o1, o3, o4-mini, the GPT-5 family; `openai/…` on OpenRouter too).
 * These take no `temperature`, cap output with `max_completion_tokens`, spend part of that
 * cap on reasoning, and take `reasoning_effort`. The `-chat` variants are plain chat models.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  const m = id(model).replace(/^openai\//, "");
  return (/^o\d/.test(m) || /^gpt-5/.test(m)) && !/-chat\b/.test(m);
}
