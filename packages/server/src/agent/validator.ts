// The fact check on model prose. A number in the reply that no tool returned (and the user
// did not say) is not trusted: the reply is replaced by the tools' own rendered answers.
//
// The trusted figures of a result are its `factKeys` values, every number inside its
// `factTextKeys`, and every number in its rendered text. A tool that declares none of those
// (a raw-JSON tool the model narrates) vouches for every number it returned.
//
// The comparison itself — rounding, list numbering, years in a date, versions, numbers inside
// ids and links — is the core validator's, so Lite and Agent mode judge numbers alike.

import { validateFactualText, type ToolInvocation } from "@page-assistant/core";
import type { AgentTool } from "./types.js";

export interface FactSource {
  tool: AgentTool;
  value: unknown;
  /** The call's arguments (what the model supplied). */
  args?: Record<string, unknown>;
  /** The step's rendered answer, when the tool has one. */
  rendered?: string;
}

export function trustedNumbers(sources: FactSource[], extraText: string[] = []): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push(String(v));
    else if (typeof v === "string") out.push(...(v.replace(/(\d),(\d)/g, "$1$2").match(/\d+(?:\.\d+)?/g) ?? []));
  };
  const walk = (node: unknown, depth = 0): void => {
    if (depth > 8 || node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "number" || typeof node === "string") return push(node);
    if (Array.isArray(node)) return node.slice(0, 500).forEach((n) => walk(n, depth + 1));
    if (typeof node === "object") for (const v of Object.values(node as Record<string, unknown>).slice(0, 500)) walk(v, depth + 1);
  };
  for (const s of sources) {
    const value = s.value as Record<string, unknown> | null;
    const declared = !!(s.tool.factKeys?.length || s.tool.factTextKeys?.length || s.tool.render);
    if (!declared) walk(value);
    if (value && typeof value === "object") {
      for (const k of s.tool.factKeys ?? []) push(value[k]);
      for (const k of s.tool.factTextKeys ?? []) walk(value[k]);
    }
    if (s.rendered) push(s.rendered);
  }
  for (const t of extraText) push(t);
  return out;
}

/**
 * `text` when every figure in it is vouched for; otherwise `fallback`. Nothing to check
 * against (no successful tool this turn) leaves the text alone: there is no data to contradict.
 */
export function validateAgentText(
  text: string,
  sources: FactSource[],
  opts: { extraText?: string[]; fallback: string }
): { text: string; corrected: boolean } {
  if (!sources.length || !text) return { text, corrected: false };
  const corpus = trustedNumbers(sources, opts.extraText).join(" ");
  // The core validator compares the prose's numbers with those in the rendered outputs.
  const inv: ToolInvocation[] = [{ name: "facts", args: {}, ok: true, rendered: corpus || "-" }];
  const { wasCorrected } = validateFactualText(text, inv);
  return wasCorrected ? { text: opts.fallback, corrected: true } : { text, corrected: false };
}
