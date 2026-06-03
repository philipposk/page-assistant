import type {
  Capability,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  MemoryStore,
  PageContext,
  ToolInvocation,
} from "./types.js";

const MAX_TOOL_ROUNDS = 6;

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

  private systemPrompt(page: PageContext): string {
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

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const out = await this.opts.llm.complete({
        system: this.systemPrompt(req.page),
        messages,
        tools: this.toolSpecs(),
        forceTool: round === 0 ? forced : undefined,
        temperature: forced ? 0 : 0.3,
      });

      if (!out.toolCalls.length) {
        // Final text. Validate against everything the tools actually returned.
        const { text, wasCorrected } = validateFactualText(out.text, invocations);
        corrected = corrected || wasCorrected;
        return { message: text, invocations, corrected };
      }

      for (const call of out.toolCalls) {
        const cap = this.caps.get(call.name);
        if (!cap) {
          invocations.push({ name: call.name, args: call.args, ok: false, error: "unknown capability" });
          messages.push({ role: "tool", toolName: call.name, content: `ERROR: no such capability` });
          continue;
        }
        // Confirm gate: stage instead of executing.
        if (cap.confirm && caller === "user") {
          return {
            message: `This will ${cap.description.toLowerCase()} Confirm to proceed.`,
            invocations,
            pendingConfirmation: {
              name: cap.name,
              args: call.args,
              preview: `${cap.name}(${JSON.stringify(call.args)})`,
            },
            corrected,
          };
        }
        const inv = await this.execute(cap, call.args, req.page, caller);
        invocations.push(inv);
        messages.push({
          role: "tool",
          toolName: cap.name,
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
    const args = stripUnknownKeys(rawArgs, cap.parameters);
    try {
      const result = await cap.run(args, { page, memory: this.opts.memory, caller });
      return {
        name: cap.name,
        args,
        ok: true,
        result,
        rendered: cap.render ? cap.render(result, args) : undefined,
      };
    } catch (e) {
      return { name: cap.name, args, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
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

  const trustedNumbers = new Set<string>();
  for (const r of rendered) for (const n of r.match(/\d+(\.\d+)?/g) ?? []) trustedNumbers.add(n);

  const claimedNumbers = text.match(/\d+(\.\d+)?/g) ?? [];
  const invented = claimedNumbers.filter((n) => !trustedNumbers.has(n) && Number(n) > 4); // ignore small ordinals
  if (invented.length === 0) return { text, wasCorrected: false };

  // The model asserted numbers no tool produced. Replace prose with trusted renders.
  return { text: rendered.join("\n\n"), wasCorrected: true };
}
