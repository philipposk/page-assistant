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
 * Haiku 5.5 still accepts it.
 */
export function acceptsForcedTool(model: string): boolean {
  const m = id(model);
  if (/^claude-(fable|mythos)-5-[1-9]/.test(m)) return false;
  if (/^claude-(fable|mythos)-[6-9]/.test(m)) return false;
  if (/^claude-(opus|sonnet)-5-[5-9]/.test(m)) return false;
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
