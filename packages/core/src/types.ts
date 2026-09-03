// Core shared types for the page assistant. Framework-agnostic, no DOM/Node deps.

/** A JSON-Schema-ish parameter spec for a capability. Kept loose on purpose. */
export interface JSONSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JSONSchema;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown;
}

/**
 * A Capability is one real action the host app exposes to the assistant.
 * The assistant can ONLY do what the host registers here — this is the grounding
 * boundary that stops the model from inventing actions. `run` executes the real
 * host function; `render` turns its result into trusted, user-facing prose so the
 * model never paraphrases (and so never hallucinates) the numbers.
 */
export interface Capability<A = any, R = any> {
  /** snake_case identifier the model calls, e.g. "simulate_cross". */
  name: string;
  /** One sentence the model (and external agents) read to decide when to use it. */
  description: string;
  /** JSON schema of the arguments. additionalProperties is forced false at call time. */
  parameters: JSONSchema;
  /** The real host function. Throwing produces { ok:false, error } — never a fake success. */
  run: (args: A, ctx: CapabilityRunContext) => Promise<R> | R;
  /**
   * Turn a successful result into trusted user-facing text. When present, this text
   * is the source of truth: the grounding layer prefers it over free-form model prose
   * for any factual claim. Omit for actions whose result needs no narration.
   */
  render?: (result: R, args: A) => string;
  /**
   * If true, render() IS the answer: the model's prose is discarded and the
   * rendered text is shown as written.
   *
   * The factual validator checks that every number the model states appears
   * somewhere in the trusted output. That catches an invented figure, but not
   * a correctly-copied figure attached to the wrong label — asked to report
   * withdrawals per partner, a model reproduced both real amounts and swapped
   * whose was whose, and the validator passed it because both numbers were
   * present. Set this wherever a figure only means something together with the
   * name, date or category beside it: per-person splits, per-bank breakdowns,
   * anything a reader would act on.
   */
  verbatim?: boolean;
  /** If true, the assistant must get explicit user confirmation before run() (writes, deletes). */
  confirm?: boolean;
  /** Optional tags for grouping in llm.txt / docs. */
  tags?: string[];
  /** If false, capability is hidden from the external agent endpoint (llm.txt). Default true. */
  exposeToAgents?: boolean;
}

export interface CapabilityRunContext {
  /** Current page context supplied by the widget. */
  page: PageContext;
  /** Per-user memory store (facts the assistant remembered). */
  memory: MemoryStore;
  /** Who is calling: the on-page user, or an external agent via the agent endpoint. */
  caller: "user" | "agent";
}

/** What the widget knows cheaply about the current page (sent every turn). */
export interface PageContext {
  url: string;
  path: string;
  title?: string;
  /** Optional host-provided structured state (selected items, current view, etc). */
  state?: Record<string, unknown>;
  /** Optional scan map produced by the page scanner on first visit. */
  map?: PageMap;
}

/** Output of a blind DOM/site scan for un-integrated pages. */
export interface PageMap {
  scannedAt: string;
  pages: Array<{ url: string; title?: string; headings: string[]; links: { text: string; href: string }[] }>;
  /** Interactive elements found on the current page. */
  controls: Array<{ kind: "link" | "button" | "input" | "select" | "form"; label: string; selector: string }>;
}

export interface MemoryFact {
  id?: string;
  topic: string;
  content: string;
  createdAt?: string;
}

export interface MemoryStore {
  remember(fact: MemoryFact): Promise<void> | void;
  recall(query: string, limit?: number): Promise<MemoryFact[]> | MemoryFact[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** present on assistant tool-call turns */
  toolName?: string;
}

export interface ChatRequest {
  message: string;
  page: PageContext;
  history?: ChatMessage[];
  caller?: "user" | "agent";
}

export interface ToolInvocation {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  rendered?: string;
  /** The capability asked for its render() to be shown as written. */
  verbatim?: boolean;
  error?: string;
}

export interface ChatResponse {
  /** The trusted, user-facing answer. */
  message: string;
  /** Capabilities that were actually executed this turn, with their real results. */
  invocations: ToolInvocation[];
  /** If a confirm-required capability is staged, this holds it until the user approves. */
  pendingConfirmation?: { name: string; args: Record<string, unknown>; preview: string };
  /** True if the grounding validator had to override invented model text. */
  corrected?: boolean;
}

/** Minimal interface an LLM provider must satisfy for the grounding loop. */
export interface LLMProvider {
  name: string;
  /** Single tool-calling round. Returns either tool calls or final text. */
  complete(input: LLMCompletionInput): Promise<LLMCompletionOutput>;
}

export interface LLMCompletionInput {
  system: string;
  messages: ChatMessage[];
  tools: Array<{ name: string; description: string; parameters: JSONSchema }>;
  /** force a specific tool (grounding: forced-factual selection) */
  forceTool?: string;
  temperature?: number;
}

export interface LLMCompletionOutput {
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  text: string;
}
