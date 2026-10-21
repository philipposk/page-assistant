// The tool registry: risk tiers, the confirm gate and the tainted-turn guard in one place,
// so a tool body never contains consent or injection code of its own.

import {
  capabilitySchemaProblems,
  coerceArgTypes,
  stripUnknownKeys,
  validateArgs,
  type Capability,
} from "@page-assistant/core";
import { hashToken, newToken, DEFAULT_PENDING_TTL_MS, type PendingActionStore } from "./pending.js";
import { schemaProblem } from "./schema.js";
import {
  CARD_MESSAGE,
  CONFIRM_GONE_MESSAGE,
  TAINTED_CARD_MESSAGE,
  TAINT_NOTE,
  TOOL_TIMEOUT_MESSAGE,
  WRITE_REFUSAL,
  formatValue,
  labelFor,
  stripHidden,
} from "./text.js";
import type { AgentTool, ConfirmSpec, PendingActionCard, RiskTier, ToolContext } from "./types.js";

/** One tool call's outcome, normalised. */
export interface StepResult {
  ok: boolean;
  /** What the tool returned (or the failure object). Sent to the model as JSON. */
  value: unknown;
  error?: string;
  /** Set when the call stopped at a confirm card instead of running. */
  card?: PendingActionCard;
  /** The text under the card. */
  cardMessage?: string;
  /** Set when the tainted-turn guard refused the call. */
  refused?: boolean;
}

export class ToolRegistryError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid agent tools:\n- ${problems.join("\n- ")}`);
    this.name = "ToolRegistryError";
  }
}

export function riskOf(tool: AgentTool): RiskTier {
  return tool.risk ?? "read";
}

/** Whether the model writes the reply from this tool's result (vs the tool's own render). */
export function chains(tool: AgentTool): boolean {
  return tool.chain ?? !tool.render;
}

export class AgentToolRegistry<C = unknown> {
  private tools = new Map<string, AgentTool<any, any, C>>();

  constructor(
    tools: AgentTool<any, any, C>[],
    private store: PendingActionStore,
    private ttlMs = DEFAULT_PENDING_TTL_MS
  ) {
    const problems = toolProblems(tools);
    if (problems.length) throw new ToolRegistryError(problems);
    for (const t of tools) this.tools.set(t.name, t);
  }

  get(name: string): AgentTool<any, any, C> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AgentTool<any, any, C>[] {
    return [...this.tools.values()];
  }

  /** Available right now. A flag that throws counts as off. */
  isEnabled(tool: AgentTool<any, any, C>, ctx: ToolContext<C>): boolean {
    const e = tool.enabled;
    if (typeof e === "function") {
      try {
        return Boolean(e(ctx));
      } catch {
        return false;
      }
    }
    return e !== false;
  }

  /**
   * The tool list for one turn, in a stable order (sorted by name) so the prompt prefix stays
   * byte-identical between turns and caches.
   */
  specs(ctx: ToolContext<C>) {
    return this.list()
      .filter((t) => this.isEnabled(t, ctx))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        name: t.name,
        description: t.description + (riskOf(t) === "confirm" ? " (Shows the user a confirmation card; nothing happens until they confirm.)" : ""),
        parameters: { ...t.parameters, additionalProperties: false },
      }));
  }

  /** Check and clean model-supplied arguments. Returns the args or a message for the model. */
  prepareArgs(tool: AgentTool, raw: unknown): { args: Record<string, unknown> } | { problem: string } {
    const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const stripped = stripUnknownKeys(obj, tool.parameters as { properties?: Record<string, unknown> });
    const problem = validateArgs(stripped, tool.parameters);
    if (problem) return { problem };
    const args = coerceArgTypes(stripped, tool.parameters);
    // Enums, whole numbers, nested objects and array items too (core checks the top level only).
    const deep = schemaProblem(args, tool.parameters);
    if (deep) return { problem: `${deep} Fix it and call again.` };
    return { args };
  }

  /**
   * Run one model call through the gates, in this order: enabled, per-turn cap, the confirm
   * gate (`confirm` tier asks, always), then the tainted-turn guard (a `write` in a turn that
   * read untrusted text asks when it has `confirmWhenTainted`, else is refused). Reads always run.
   */
  async run(tool: AgentTool<any, any, C>, args: Record<string, unknown>, ctx: ToolContext<C>, calls: Map<string, number>): Promise<StepResult> {
    if (!this.isEnabled(tool, ctx)) return fail("That isn't available right now.");
    const n = (calls.get(tool.name) ?? 0) + 1;
    calls.set(tool.name, n);
    if (tool.maxCallsPerTurn !== undefined && n > tool.maxCallsPerTurn) return fail("I already did that in this turn.");

    const risk = riskOf(tool);
    if (!ctx.confirmed) {
      if (risk === "confirm") return this.offer(tool, tool.confirm ?? {}, args, ctx);
      if (risk === "write" && ctx.tainted) {
        if (tool.confirmWhenTainted) return this.offer(tool, tool.confirmWhenTainted, args, ctx);
        return { ok: false, value: { ok: false, error: WRITE_REFUSAL }, error: WRITE_REFUSAL, refused: true };
      }
    }
    const result = await invoke(tool, args, ctx);
    // Taints on any outcome: a failure's message can carry the stranger's text too.
    if (tool.taints) ctx.tainted = true;
    return result;
  }

  /**
   * Run the action a confirm card stood for, as stored when the card was issued (the client
   * sends only the token, never the arguments). The tool's enabled flag is checked again: up
   * to ten minutes pass between the card and the click.
   */
  async runConfirmed(name: string, args: Record<string, unknown>, ctx: ToolContext<C>): Promise<StepResult> {
    const tool = this.tools.get(name);
    if (!tool || !(riskOf(tool) === "confirm" || tool.confirmWhenTainted)) return fail(CONFIRM_GONE_MESSAGE);
    if (!this.isEnabled(tool, ctx)) return fail("That isn't available right now.");
    // Defence in depth: the stored arguments still have to fit the tool's schema.
    const checked = this.prepareArgs(tool, args);
    if ("problem" in checked) return fail(CONFIRM_GONE_MESSAGE);
    ctx.confirmed = true;
    const result = await invoke(tool, checked.args, ctx);
    // A confirmed read of someone else's text taints the reply like any other: the client tags
    // it and later turns stay guarded.
    if (tool.taints) ctx.tainted = true;
    return result;
  }

  private async offer(tool: AgentTool<any, any, C>, spec: ConfirmSpec, args: Record<string, unknown>, ctx: ToolContext<C>): Promise<StepResult> {
    try {
      let finalArgs = args;
      let title: string | undefined;
      let details: string[] | undefined;
      if (spec.prepare) {
        const prepared = await untilAborted(Promise.resolve(spec.prepare(args, ctx)), ctx.signal);
        if (prepared === ABORTED) return fail(TOOL_TIMEOUT_MESSAGE);
        if (prepared && (prepared as { ok?: boolean }).ok === false) {
          const error = String((prepared as { error?: unknown }).error || "That can't be done.");
          return fail(error);
        }
        const p = prepared as { args?: Record<string, unknown>; title?: string; details?: string[] };
        if (p?.args) {
          const checked = this.prepareArgs(tool, p.args);
          if ("problem" in checked) return fail(checked.problem);
          finalArgs = checked.args;
        }
        title = p?.title;
        details = p?.details;
      }
      title ??= typeof spec.title === "function" ? spec.title(finalArgs) : spec.title;
      // Capped to what the store keeps (the SQL allows 500 characters), so a long title built
      // from arguments can't fail the insert.
      // Hidden characters (bidi overrides, zero-width) go: the card must say what it shows.
      title = clip(stripHidden(title ?? "").trim(), MAX_TITLE_CHARS) || "Go ahead with this?";
      if (!details) details = spec.details ? await spec.details(finalArgs, ctx) : defaultDetails(tool, spec, finalArgs);
      details = (details ?? []).map((d) => clip(stripHidden(String(d)), MAX_DETAIL_CHARS)).filter(Boolean).slice(0, 20);
      // First, so it shows without scrolling the details.
      if (ctx.tainted && !details.includes(TAINT_NOTE)) details.unshift(TAINT_NOTE);

      const token = newToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
      await this.store.create({
        tokenHash: await hashToken(token),
        userId: ctx.user.id,
        tool: tool.name,
        args: finalArgs,
        title,
        details,
        createdAt: now.toISOString(),
        expiresAt,
      });
      const card: PendingActionCard = {
        token,
        tool: tool.name,
        title,
        details,
        confirmLabel: (spec.button ?? "Confirm").slice(0, 40),
        expiresAt,
      };
      const cardMessage = ctx.tainted ? TAINTED_CARD_MESSAGE : spec.message ?? CARD_MESSAGE;
      // What the model would see, were it handed back: never the token.
      return { ok: true, value: { needsConfirmation: true, title, details }, card, cardMessage };
    } catch {
      return fail("I couldn't prepare that confirmation. Ask me again in a new message.");
    }
  }
}

const MAX_TITLE_CHARS = 300;
const MAX_DETAIL_CHARS = 400;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fail(error: string): StepResult {
  return { ok: false, value: { ok: false, error }, error };
}

const ABORTED: unique symbol = Symbol("aborted");

/** `p`, or ABORTED once `signal` fires (the turn's deadline, or Stop). Never leaves a rejection unhandled. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/**
 * Run the tool body, bounded by the turn's signal (a query that ignores ctx.signal can't hold
 * the request past its deadline). A throw or `{ ok: false }` is a failure, anything else a
 * success. A thrown message goes to the model (it may explain a bad argument), but the user
 * sees a plain sentence: thrown errors are often a database's or library's own words.
 */
async function invoke<C>(tool: AgentTool<any, any, C>, args: Record<string, unknown>, ctx: ToolContext<C>): Promise<StepResult> {
  try {
    const value = await untilAborted(Promise.resolve().then(() => tool.run(args, ctx)), ctx.signal);
    if (value === ABORTED) return fail(TOOL_TIMEOUT_MESSAGE);
    if (value && typeof value === "object" && (value as { ok?: unknown }).ok === false) {
      const error = String((value as { error?: unknown }).error ?? "That did not work.");
      return { ok: false, value, error };
    }
    return { ok: true, value: value === undefined ? { ok: true } : value };
  } catch (e) {
    const detail = ((e instanceof Error ? e.message : String(e)) || "").slice(0, 300);
    return { ok: false, value: { ok: false, error: detail || THROWN_MESSAGE }, error: THROWN_MESSAGE };
  }
}

const THROWN_MESSAGE = "That action failed.";

function defaultDetails(tool: AgentTool, spec: ConfirmSpec, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(tool.parameters.properties ?? {})) {
    const v = args[key];
    if (v === undefined || v === null || v === "") continue;
    out.push(`${spec.labels?.[key] ?? labelFor(key)}: ${formatValue(v)}`);
  }
  return out;
}

/** Every problem with a tool list, as readable lines. Empty when all are usable. */
export function toolProblems(tools: AgentTool[]): string[] {
  // The schema rules are the capability rules: providers reject the same things.
  const problems = capabilitySchemaProblems(tools as unknown as Capability[]);
  for (const t of tools) {
    const risk = t.risk ?? "read";
    if (!["read", "write", "confirm"].includes(risk)) problems.push(`${t.name}: risk must be "read", "write" or "confirm".`);
    if (typeof t.run !== "function") problems.push(`${t.name}: run must be a function.`);
    if (t.confirmWhenTainted && risk !== "write") problems.push(`${t.name}: confirmWhenTainted is only for "write" tools.`);
    const title = t.confirm?.title ?? t.confirmWhenTainted?.title;
    if (typeof title === "string" && title && !title.trim().endsWith("?")) problems.push(`${t.name}: a confirm title is a question; end it with "?".`);
    if (t.chain === false && !t.render) problems.push(`${t.name}: chain: false needs a render (the step's answer).`);
  }
  return problems;
}
