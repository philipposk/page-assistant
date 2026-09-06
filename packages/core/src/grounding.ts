import type {
  Capability,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  JSONSchema,
  LLMProvider,
  LLMTokenUsage,
  MemoryStore,
  PageContext,
  ToolInvocation,
} from "./types.js";

const MAX_TOOL_ROUNDS = 6;
// Keep the last N history+working messages sent to the model. Prevents unbounded prompts
// (cost + latency + context-window overflow) on long conversations. Tunable via env.
const DEFAULT_HISTORY_WINDOW = 20;

function historyWindow(): number {
  const raw = Number(
    (typeof process !== "undefined" && process.env?.PA_HISTORY_WINDOW) || DEFAULT_HISTORY_WINDOW
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_HISTORY_WINDOW;
}

/** Keep the most recent `window` messages but never split a tool_result from its call. */
function windowMessages(messages: ChatMessage[], window: number): ChatMessage[] {
  if (messages.length <= window) return messages;
  let start = messages.length - window;
  // Don't lead with an orphaned tool result (no preceding assistant tool_use) — the
  // provider would reject it. Walk back to the assistant turn that produced it.
  while (start > 0 && messages[start].role === "tool") start--;
  return messages.slice(start);
}

let uid = 0;
function genToolCallId(): string {
  return `tc_${Date.now().toString(36)}_${(uid++).toString(36)}`;
}

export interface AssistantOptions {
  capabilities: Capability[];
  llm: LLMProvider;
  memory: MemoryStore;
  /** Extra lines appended to the system prompt (host persona / app description). */
  persona?: string;
  /** App name used in the system prompt. */
  appName?: string;
  /**
   * Free-text knowledge about the app — README, docs, "what this is for". Injected into the
   * system prompt so the assistant understands the product, not just its buttons.
   */
  knowledge?: string;
  /** Suggested things the user can ask. The assistant offers these proactively. */
  suggestions?: string[];
}

/**
 * The grounded assistant. Mirrors the strive page-assistant safety model:
 *  1. The model may ONLY call registered capabilities (no free-form actions).
 *  2. Factual answers come from each capability's render(), not model prose.
 *  3. A validator strips/replaces model text that asserts numbers the tools
 *     never returned, so the assistant cannot hallucinate results.
 */
export class Assistant {
  private caps: Map<string, Capability>;
  constructor(private opts: AssistantOptions) {
    this.caps = new Map(opts.capabilities.map((c) => [c.name, c]));
  }

  get capabilities(): Capability[] {
    return [...this.caps.values()];
  }

  /** Fold in extra knowledge discovered at runtime (e.g. fetched README / llm.txt). */
  setKnowledge(text: string) {
    this.opts.knowledge = [this.opts.knowledge, text].filter(Boolean).join("\n\n").slice(0, 6000);
  }

  private systemPrompt(page: PageContext, recalled: string[] = []): string {
    const app = this.opts.appName ?? "this app";
    const lines = [
      `You are the in-app assistant for ${app}. You help the user by calling the app's real capabilities.`,
      `RULES:`,
      `- You can only do things by calling a listed capability. Never claim you did something you did not call.`,
      `- Never invent numbers, names, or results. If a capability returns data, report exactly what it returned.`,
      `- If you lack a capability for the request, say so plainly and suggest what the user can do.`,
      `- For capabilities marked confirm, describe what will happen and wait for the user to approve before calling.`,
      `- Be concise. Prefer doing the action over describing it.`,
      `Current page: ${page.title ?? page.path} (${page.path}).`,
    ];
    if (page.state && Object.keys(page.state).length) {
      lines.push(`Page state: ${JSON.stringify(page.state).slice(0, 800)}`);
    }
    if (page.map) {
      lines.push(
        `This page was scanned. Known controls: ${page.map.controls
          .slice(0, 25)
          .map((c) => `${c.kind}:${c.label}`)
          .join(", ")}.`
      );
    }
    if (this.opts.persona) lines.push(this.opts.persona);
    if (recalled.length) lines.push(`Things you remember about this user (from earlier sessions):\n${recalled.map((r) => `- ${r}`).join("\n")}`);
    if (this.opts.knowledge) lines.push(`\nWhat this app is (background — use it to understand requests, not as facts to quote verbatim):\n${this.opts.knowledge.slice(0, 4000)}`);
    if (this.opts.suggestions?.length)
      lines.push(`If the user seems unsure what to do, offer one of: ${this.opts.suggestions.slice(0, 6).join("; ")}.`);
    return lines.join("\n");
  }

  private toolSpecs() {
    return this.capabilities.map((c) => ({
      name: c.name,
      description: c.description + (c.confirm ? " (requires user confirmation)" : ""),
      parameters: { ...c.parameters, additionalProperties: false },
    }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const caller = req.caller ?? "user";
    const messages: ChatMessage[] = [...(req.history ?? []), { role: "user", content: req.message }];
    const invocations: ToolInvocation[] = [];
    const forced = forcedFactualTool(req.message, this.capabilities);
    let corrected = false;
    const usage = { promptTokens: 0, completionTokens: 0, provider: undefined as string | undefined };
    const window = historyWindow();

    // Memory is live, not decorative: recall facts relevant to this request into the prompt.
    let recalled: string[] = [];
    try {
      recalled = (await this.opts.memory.recall(req.message, 4)).map((f) => `${f.topic}: ${f.content}`);
    } catch {
      /* memory must never break a chat */
    }

    const accUsage = (u?: LLMTokenUsage, provider?: string) => {
      if (u?.promptTokens) usage.promptTokens += u.promptTokens;
      if (u?.completionTokens) usage.completionTokens += u.completionTokens;
      if (provider) usage.provider = provider;
    };
    const finalUsage = () =>
      usage.promptTokens || usage.completionTokens || usage.provider ? { ...usage } : undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const out = await this.opts.llm.complete({
        system: this.systemPrompt(req.page, recalled),
        messages: windowMessages(messages, window),
        tools: this.toolSpecs(),
        forceTool: round === 0 ? forced : undefined,
        temperature: forced ? 0 : 0.3,
      });
      accUsage(out.usage, out.provider);

      if (!out.toolCalls.length) {
        // Final text. Validate against everything the tools actually returned.
        const { text, wasCorrected } = validateFactualText(out.text, invocations);
        corrected = corrected || wasCorrected;
        return { message: text, invocations, corrected, usage: finalUsage() };
      }

      // Record the model's OWN tool-call turn verbatim (with stable ids) so the next round
      // sees a coherent call→result pairing. Without this the model gets results for calls
      // it has no record of making, re-calls the same tool, and burns the round budget.
      const turnCalls = out.toolCalls.map((c) => ({ id: c.id ?? genToolCallId(), name: c.name, args: c.args }));
      messages.push({ role: "assistant", content: out.text ?? "", toolCalls: turnCalls });

      for (const call of turnCalls) {
        const cap = this.caps.get(call.name);
        if (!cap) {
          invocations.push({ name: call.name, args: call.args, ok: false, error: "unknown capability" });
          messages.push({ role: "tool", toolName: call.name, toolCallId: call.id, content: `ERROR: no such capability` });
          continue;
        }
        // Confirm gate: stage instead of executing (user UI or external agent must approve).
        // `preview` spells out the action + args so a UI can show exactly what will happen.
        if (cap.confirm) {
          return {
            message: `Confirm this action? ${cap.description}`,
            invocations,
            pendingConfirmation: {
              name: cap.name,
              args: call.args,
              preview: `${cap.name}(${JSON.stringify(call.args)})`,
            },
            corrected,
            usage: finalUsage(),
          };
        }
        // Validate required args/types BEFORE run(), so a model call missing a required
        // field gets an actionable error fed back instead of a raw exception downstream.
        const problem = validateArgs(call.args, cap.parameters);
        if (problem) {
          invocations.push({ name: cap.name, args: call.args, ok: false, error: problem });
          messages.push({ role: "tool", toolName: cap.name, toolCallId: call.id, content: `ERROR: ${problem}` });
          continue;
        }
        const inv = await this.execute(cap, call.args, req.page, caller);
        invocations.push(inv);
        messages.push({
          role: "tool",
          toolName: cap.name,
          toolCallId: call.id,
          content: inv.ok ? inv.rendered ?? JSON.stringify(inv.result) : `ERROR: ${inv.error}`,
        });
      }
    }

    // Ran out of rounds — return the last trusted rendered result rather than guessing.
    const last = [...invocations].reverse().find((i) => i.ok && i.rendered);
    return {
      message: last?.rendered ?? "I could not complete that. Please try rephrasing.",
      invocations,
      corrected,
      usage: finalUsage(),
    };
  }

  /** Execute a confirmed capability (called after user approves a pendingConfirmation). */
  async confirmAndRun(name: string, args: Record<string, unknown>, page: PageContext): Promise<ChatResponse> {
    const cap = this.caps.get(name);
    if (!cap) return { message: "That action is no longer available.", invocations: [] };
    const inv = await this.execute(cap, args, page, "user");
    return { message: inv.ok ? inv.rendered ?? "Done." : `That failed: ${inv.error}`, invocations: [inv] };
  }

  private async execute(
    cap: Capability,
    rawArgs: Record<string, unknown>,
    page: PageContext,
    caller: "user" | "agent"
  ): Promise<ToolInvocation> {
    const args = coerceArgTypes(stripUnknownKeys(rawArgs, cap.parameters), cap.parameters);
    try {
      const result = await cap.run(args, { page, memory: this.opts.memory, caller });
      return {
        name: cap.name,
        args,
        ok: true,
        result,
        rendered: cap.render ? cap.render(result, args) : undefined,
        verbatim: cap.verbatim === true,
      };
    } catch (e) {
      return { name: cap.name, args, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/**
 * Coerce numeric strings to numbers for number/integer-typed params BEFORE run(). Models
 * often stringify numbers ("5"); validateArgs already ACCEPTS a numeric string, but without
 * this the host function would receive "5" (a string) and e.g. "5" * 2 or comparisons break.
 * Only touches params the schema types as number/integer and whose value is a clean numeric
 * string; everything else passes through untouched.
 */
export function coerceArgTypes(
  args: Record<string, unknown>,
  schema: JSONSchema
): Record<string, unknown> {
  const props = schema.properties;
  if (!props) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [k, spec] of Object.entries(props)) {
    const want = (spec as JSONSchema).type;
    const v = out[k];
    if ((want === "number" || want === "integer") && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      const num = Number(v);
      out[k] = want === "integer" ? Math.trunc(num) : num;
    }
  }
  return out;
}

/** Drop keys the schema didn't declare — mirrors strive's additionalProperties:false hardening. */
export function stripUnknownKeys(args: Record<string, unknown>, schema: { properties?: Record<string, unknown> }) {
  if (!schema.properties) return args;
  const allowed = new Set(Object.keys(schema.properties));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (allowed.has(k)) out[k] = v;
  return out;
}

/**
 * Check a model's tool args against the schema's `required` fields and declared types
 * BEFORE run() is called. Returns an actionable message (fed back to the model so it can
 * retry) or null when the args are acceptable. Without this a call missing a required arg
 * passes undefined into the host function and surfaces as a raw exception.
 */
export function validateArgs(args: Record<string, unknown>, schema: JSONSchema): string | null {
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length) {
    return `missing required argument(s): ${missing.join(", ")}. Provide ${missing
      .map((k) => `"${k}"`)
      .join(", ")} and call again.`;
  }
  for (const [k, spec] of Object.entries(props)) {
    if (args[k] === undefined || args[k] === null) continue; // optional & absent is fine
    const want = (spec as JSONSchema).type;
    if (!want) continue;
    const got = jsonType(args[k]);
    // Accept a numeric string where a number is wanted (models often stringify numbers).
    const coercible = want === "number" && got === "string" && args[k] !== "" && !Number.isNaN(Number(args[k]));
    if (!coercible && !typeMatches(want, got)) {
      return `argument "${k}" must be a ${want} (got ${got}). Fix it and call again.`;
    }
  }
  return null;
}

function jsonType(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function typeMatches(want: string, got: string): boolean {
  if (want === "integer") return got === "number";
  return want === got;
}

/**
 * Forced-factual tool selection. For unambiguous "give me a number / do X now"
 * intents we force the matching capability so the model can't answer from memory.
 * Heuristic and conservative: only fires on a confident keyword + a single
 * obviously-matching capability.
 */
export function forcedFactualTool(message: string, caps: Capability[]): string | undefined {
  const m = message.toLowerCase();
  const factualIntent = /\b(how many|how tall|what is the|simulate|run|calculate|predict|best|compare|show me)\b/.test(m);
  if (!factualIntent) return undefined;
  // Score capabilities by name/description keyword overlap with the message.
  const scored = caps
    .map((c) => ({ c, score: overlapScore(m, `${c.name} ${c.description}`.toLowerCase()) }))
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score);
  if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) return scored[0].c.name;
  return undefined;
}

function overlapScore(a: string, b: string): number {
  const words = new Set(a.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  let s = 0;
  for (const w of words) if (b.includes(w)) s++;
  return s;
}

/**
 * Factual text validator. If the model's prose contains numbers that do NOT appear
 * anywhere in the trusted rendered tool output, we don't trust the prose — we fall
 * back to concatenating the trusted renders. This is the "validator replaces LLM text
 * when it invents a count" guarantee from strive, generalized.
 */
export function validateFactualText(
  text: string,
  invocations: ToolInvocation[]
): { text: string; wasCorrected: boolean } {
  const rendered = invocations.filter((i) => i.ok && i.rendered).map((i) => i.rendered!) as string[];
  if (!rendered.length) return { text, wasCorrected: false };

  /* A capability may declare that its rendering IS the answer. The number
     check below only asks whether each figure appears somewhere in the trusted
     output, which a reordering satisfies: a model asked for withdrawals per
     partner returned both real amounts against the wrong names and passed.
     Where a figure only means something next to its label, the prose is not
     worth the risk and the rendering is shown as written. */
  if (invocations.some((i) => i.ok && i.rendered && i.verbatim)) {
    const joined = rendered.join("\n\n");
    return { text: joined, wasCorrected: joined !== text };
  }

  const trusted: number[] = [];
  const trustedNumbers = new Set<string>();
  for (const r of rendered)
    for (const n of r.replace(/(\d),(\d)/g, "$1$2").match(/\d+(\.\d+)?/g) ?? []) {
      trustedNumbers.add(n);
      trusted.push(Number(n));
    }

  // A claimed number is honest if a tool returned it exactly, or it's a reasonable
  // rounding of a trusted value (20.7 → "21", 1200 → "1,200"). Small ordinals (≤4)
  // are ignored — they're usually list numbering, not factual claims.
  const isHonest = (n: string) => {
    if (trustedNumbers.has(n)) return true;
    const num = Number(n);
    return trusted.some((t) => Math.round(t) === num || t.toFixed(1) === n || Math.abs(t - num) < 0.05);
  };

  // Numbers that live inside a URL, path, or identifier-like token are structural, not
  // factual claims — collect them so we don't flag "gpt-4o", "/v1/", "ISO-8601", etc.
  const structural = collectStructuralNumbers(text);

  const claimedNumbers = text.replace(/(\d),(\d)/g, "$1$2").match(/\d+(\.\d+)?/g) ?? [];
  const invented = claimedNumbers.filter(
    (n) => !isHonest(n) && Number(n) > 4 && !isWhitelisted(n, structural)
  );
  if (invented.length === 0) return { text, wasCorrected: false };

  // The model asserted numbers no tool produced. Replace prose with trusted renders.
  return { text: rendered.join("\n\n"), wasCorrected: true };
}

/**
 * Numbers a factual validator must NOT flag even when no tool returned them, because
 * they aren't quantitative claims about tool output:
 *  - ordinals: "top 10", "5th place" (trailing st/nd/rd/th)
 *  - version-like tokens: "v2.1", "2.11.0"
 *  - numbers embedded in URLs / ids / hyphenated tokens: "gpt-4o", "/v1/x", "SKU-9000"
 *  - 4-digit years, but ONLY in an explicit date context ("in 2024", "since 2020",
 *    "January 2024"). A bare "2000 units" is a quantity, not a year — it stays validated.
 *
 * Deliberately NOT whitelisted: a unit-fused quantity like "500g", "1200mg", "120ms",
 * "1950 grams", "2000 units". Those ARE factual claims about tool output and must be
 * checked against what the tools actually returned.
 */
function isWhitelisted(n: string, structural: Set<string>): boolean {
  return structural.has(n);
}

const ORDINAL_RE = /\b\d+(?:st|nd|rd|th)\b/gi;
// v2.1 / v3.11.0 (leading v) OR a dotted semantic version 2.11.0 (two+ dots so a bare
// "9.5" ratio is still a claim). A single-dot "2.11" is only whitelisted with the v prefix.
const VERSION_RE = /\bv\d+(?:\.\d+)+\b|\b\d+\.\d+\.\d+\b/gi;
const URL_RE = /\bhttps?:\/\/\S+/gi;
// "top 10", "first 5", "page 12", "#7" — a number qualified by a list/position word is a
// reference, not a claim about tool output.
const COUNT_CONTEXT_RE = /\b(?:top|first|last|next|page|chapter|step|no|number)\s+(\d+)\b|#(\d+)\b/gi;
// A number fused to LETTERS with a URL/id-like separator (dot, slash, hyphen, underscore)
// is part of an identifier/model/token ("gpt-4o", "ISO-8601", "s3", "/v1/x"), not a
// quantitative claim. A UNIT-fused quantity ("500g", "1200mg", "120ms") is a claim about
// tool output, so it must NOT match here — the separator requirement excludes bare
// digit+letter runs. A number joined only to other numbers by a slash ("9000/100") is a
// ratio the model may have invented and is likewise NOT whitelisted.
const TOKEN_NUM_RE = /\b(?:[A-Za-z][\w]*[./_-][\w./_-]*\d[\w./_-]*|\d[\w]*[./_-][\w./_-]*[A-Za-z][\w./_-]*|[A-Za-z]+[./_-]+\d[\w./_-]*)\b/g;
// A 4-digit year is only a non-claim in explicit date context: preceded by a date word
// ("in/year/since/by/during/from/until") or a month name, or part of a written date.
const YEAR_CONTEXT_RE =
  /\b(?:in|year|since|by|during|from|until|by the year|circa|©)\s+((?:19|20)\d{2})\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:\d{1,2},?\s+)?((?:19|20)\d{2})\b|\b\d{1,2}[/-]\d{1,2}[/-]((?:19|20)\d{2})\b|\b((?:19|20)\d{2})[/-]\d{1,2}[/-]\d{1,2}\b/gi;

function collectStructuralNumbers(text: string): Set<string> {
  const set = new Set<string>();
  const add = (s: string) => {
    for (const n of s.replace(/(\d),(\d)/g, "$1$2").match(/\d+(\.\d+)?/g) ?? []) set.add(n);
  };
  const addExact = (s: string) => {
    if (s) set.add(s);
  };
  for (const m of text.match(ORDINAL_RE) ?? []) add(m);
  for (const m of text.match(VERSION_RE) ?? []) add(m);
  for (const m of text.match(URL_RE) ?? []) add(m);
  for (const m of text.match(TOKEN_NUM_RE) ?? []) add(m);
  for (const m of text.matchAll(COUNT_CONTEXT_RE)) add(m[1] ?? m[2] ?? "");
  // Years: whitelist only the year digits captured in a date context, exactly (not a
  // substring pass that would also swallow "2000" from "2000 units").
  for (const m of text.matchAll(YEAR_CONTEXT_RE)) addExact(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
  return set;
}
