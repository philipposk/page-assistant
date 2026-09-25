import type { Capability } from "./types.js";

/** Options for a read-only capability that explains confusing UI. */
export interface ExplainUiCapabilityOptions<R> {
  /** Tool name, e.g. `explain_pos_card_field`. */
  name: string;
  /** When to call this — shown to the model in the tool list. */
  description: string;
  tags?: string[];
  enabled?: boolean | (() => boolean);
  /** Load the user's real configuration (banks, flags, modules, …). */
  run: () => R | Promise<R>;
  /** Turn that state into the exact sentence the user should read. */
  render: (result: R) => string;
}

/**
 * Factory for procedural "how does this field work?" capabilities.
 *
 * Host apps use these when an explanation depends on org state — greyed-out
 * fields, optional modules, missing setup — so the model must not guess.
 * Answers are marked `verbatim: true` so the grounding validator keeps the
 * host's wording.
 */
export function explainUiCapability<R>(
  opts: ExplainUiCapabilityOptions<R>,
): Capability<Record<string, never>, R> {
  return {
    name: opts.name,
    description: opts.description,
    parameters: { type: "object", properties: {} },
    tags: opts.tags ?? ["help"],
    verbatim: true,
    enabled: opts.enabled,
    async run() {
      return await opts.run();
    },
    render: opts.render,
  };
}

/**
 * Merge a screen hint into `getPageState()` output so the model knows which
 * explain capability to run on this view.
 */
export function pageStateHint(
  base: Record<string, unknown>,
  hint: string,
): Record<string, unknown> {
  return { ...base, hint };
}
