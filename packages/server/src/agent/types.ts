// Agent mode: the assistant's tool loop runs on the server, next to the app's own data and
// auth, instead of in the browser. Framework-agnostic types; nothing here imports Express.

import type { JSONSchema, LLMProvider, ScrubRule } from "@page-assistant/core";

/**
 * How much a tool may do without asking.
 *
 * - `read`: changes nothing. Runs at once.
 * - `write`: a change the user can take back (rename back, restore, re-add). Runs at once,
 *   except in a turn that read text someone else wrote (see `taints`): then it is refused,
 *   or turned into a confirm card when it has `confirmWhenTainted`.
 * - `confirm`: deletes, payments, sending, anything that can't be undone or reaches outside
 *   the app. A model call never runs it: the call returns a confirm card with a single-use
 *   token, and the work happens only when the user clicks the card's button.
 */
export type RiskTier = "read" | "write" | "confirm";

/** The signed-in user a turn acts for. Hosts may carry more fields. */
export interface AgentUser {
  id: string;
  [key: string]: unknown;
}

/** What the client says about the page the user is on. Treated as data, never as instructions. */
export interface AgentPage {
  path?: string;
  url?: string;
  title?: string;
  /** Host-provided structured view state (selected rows, open item, filters). */
  state?: Record<string, unknown>;
  /**
   * The page shows text someone else wrote (a shared document, another user's message), so this
   * turn is tainted from the start: writes need a card. Set it from `getPage` in the dock.
   */
  untrusted?: boolean;
}

/** One earlier line of the conversation, as the client sends it. */
export interface AgentHistoryTurn {
  role: "user" | "assistant";
  content: string;
  /** Local-only lines (a walkthrough's narration, an error bubble). Never resent to the model. */
  kind?: "narrate" | "error";
  /** Echo of `AgentTurnResponse.tainted` for this reply: it holds text someone else wrote. */
  tainted?: boolean;
}

/** What the dock can show. The server only sends what the client declared. */
export type ClientCapability = "pending_action" | "result_cards" | "guided";

export interface AgentTurnRequest {
  /** What the user typed. May be empty only with `confirmToken`. */
  message: string;
  history?: AgentHistoryTurn[];
  page?: AgentPage;
  /** The token of a confirm card the user clicked. Runs that stored action; no model call. */
  confirmToken?: string;
  /** A clicked suggestion chip's tool. Honoured only for `read` tools. */
  suggestionTool?: string;
  clientCapabilities?: string[];
  /** The client's chat id, echoed back. The server does not store chats itself. */
  chatId?: string;
}

/** Built-in view-only UI actions. None of them can change data. */
export type BuiltinUiAction =
  | { type: "navigate"; to: string }
  | { type: "narrate"; text: string; speak?: boolean }
  | { type: "highlight"; anchor: string; label?: string }
  | { type: "wait"; ms: number };

/** A host-registered action (`AgentConfig.uiActions`), e.g. `{ type: "select_rows", ids: [...] }`. */
export interface CustomUiAction {
  type: string;
  [key: string]: unknown;
}

export type UiAction = BuiltinUiAction | CustomUiAction;
export type UiActionMode = "immediate" | "guided";

/** A view-only action type the host adds. Its fields are checked against `schema`. */
export interface CustomUiActionSpec {
  description?: string;
  /** JSON schema of the action's fields (besides `type`). Undeclared fields are dropped. */
  schema: JSONSchema;
}

/** A confirm card: nothing has run yet. */
export interface PendingActionCard {
  token: string;
  tool: string;
  /** Plain-language question ending in "?". Shown as text, never as HTML or markdown. */
  title: string;
  details: string[];
  confirmLabel: string;
  /** ISO 8601 with a zone. Single use; expires 10 minutes after issue by default. */
  expiresAt: string;
}

/** A follow-up chip. Clicking it sends `prompt` (and `tool`, honoured for read tools only). */
export interface Suggestion {
  label: string;
  prompt: string;
  tool?: string;
  /** The tool's risk tier, so a chip that would change data can say so. */
  risk?: RiskTier;
}

/** A structured result the dock renders with the host's `renderCard` (a chart, a file, a list). */
export interface ResultCard {
  type: string;
  [key: string]: unknown;
}

/** Why a turn did not complete. `message` is always a readable reply. */
export type AgentErrorCode =
  | "llm_timeout"
  | "llm_busy"
  | "llm_unavailable"
  | "llm_error"
  | "llm_too_large"
  | "llm_not_configured"
  | "incomplete"
  | "internal_error";

export interface AgentTurnResponse {
  message: string;
  uiActions: UiAction[];
  uiActionMode: UiActionMode;
  /** Set when the requested action waits for the user's OK (and the client shows cards). */
  pendingAction: PendingActionCard | null;
  suggestions: Suggestion[];
  /** Only when the client declared "result_cards". */
  cards: ResultCard[];
  /**
   * null when the turn completed. llm_*: nothing changed, Retry is safe (except llm_too_large
   * and llm_not_configured, which fail the same way again). incomplete: some steps ran and
   * `message` reports them; never resend automatically. internal_error: unknown, Retry only
   * as a manual choice.
   */
  errorCode: AgentErrorCode | null;
  chatId: string | null;
  /**
   * This reply holds text someone else wrote (a `taints` tool ran, or the history already held
   * such text). The client tags the reply in the history it sends back, and while the model can
   * still read it, every turn of the chat is tainted: writes need a card or are refused.
   */
  tainted: boolean;
}

/** Everything a tool is given. */
export interface ToolContext<C = unknown> {
  user: AgentUser;
  /** Whatever the host's `context()` returned for this request (e.g. a DB client acting as the user). */
  app: C;
  request: AgentTurnRequest;
  page: AgentPage;
  /**
   * True once a tool with `taints: true` returned text someone else wrote in this turn. The
   * next message starts clean.
   */
  tainted: boolean;
  /** True only while running an action the user confirmed on a card. */
  confirmed: boolean;
  /** Aborted when the turn's deadline passes. Pass it to your own fetches. */
  signal: AbortSignal;
}

/** How a tool asks first. */
export interface ConfirmSpec<A = any, C = any> {
  /** The card's question: plain language, ends with "?". */
  title?: string | ((args: A) => string);
  /** The card's button. Default "Confirm". */
  button?: string;
  /** The card's lines. Default: one "Label: value" line per argument. */
  details?: (args: A, ctx: ToolContext<C>) => string[] | Promise<string[]>;
  /** Argument name → label of its default detail line. */
  labels?: Record<string, string>;
  /**
   * Where in the app a person does this by hand, for a client that shows no cards
   * ("To do it yourself: open Settings → Members."). Ends with ".".
   */
  where?: string;
  /**
   * A read-only check before the card is shown: look things up, normalise the arguments,
   * or refuse early (return `{ ok: false, error }`). The returned `args` are exactly what
   * the confirmed run gets.
   */
  prepare?: (
    args: A,
    ctx: ToolContext<C>
  ) => Promise<ConfirmPrepared<A> | { ok: false; error: string }> | ConfirmPrepared<A> | { ok: false; error: string };
  /** The reply under the card. Default "This needs your OK. Confirm on the card below." */
  message?: string;
}

export interface ConfirmPrepared<A> {
  ok?: true;
  args?: A;
  title?: string;
  details?: string[];
}

/**
 * One real action the host exposes. `run` calls the app's real API as the signed-in user and
 * must do its own permission checks: a tool bypasses the app's HTTP layer.
 *
 * Return any JSON-able value. Return `{ ok: false, error: "..." }` (or throw) for a failure
 * the model should tell the user about; never a fake success.
 */
export interface AgentTool<A = any, R = any, C = any> {
  /** snake_case, 1-64 chars. */
  name: string;
  description: string;
  /** JSON schema with `"type": "object"`. Unknown keys are dropped before `run`. */
  parameters: JSONSchema;
  /** Default "read". */
  risk?: RiskTier;
  run: (args: A, ctx: ToolContext<C>) => R | Promise<R>;
  /**
   * Trusted user-facing text for a result. When present the step answers in these words, not
   * the model's (no hallucination surface), unless `chain` is true.
   */
  render?: (result: R, args: A) => string;
  /**
   * true: the model reads the result and writes the reply (and may call more tools).
   * Default: false when there is a `render`, true otherwise.
   */
  chain?: boolean;
  /** Result keys holding numbers the model may quote. */
  factKeys?: string[];
  /** Result keys holding text (or nested values) whose numbers the model may quote. */
  factTextKeys?: string[];
  /** View-only UI actions to run after a successful call. */
  uiActions?: (result: R, args: A) => UiAction[];
  /** "guided" plays the actions one by one with the pointer and narration. */
  uiActionMode?: UiActionMode;
  /** For `risk: "confirm"`: what the card says. Optional; sensible defaults. */
  confirm?: ConfirmSpec<A, C>;
  /** For `risk: "write"`: ask on a card (instead of refusing) in a turn that read untrusted text. */
  confirmWhenTainted?: ConfirmSpec<A, C>;
  /** true for a tool that returns text someone else wrote (a document, a web page, a message). */
  taints?: boolean;
  /** Cap on calls per turn. */
  maxCallsPerTurn?: number;
  /** Follow-up chips after a successful answer. */
  suggestions?: (result: R, args: A) => Suggestion[];
  /** Structured result cards (only sent to a client that declared "result_cards"). */
  cards?: (result: R, args: A) => ResultCard[];
  /** Whether it is available now (feature flag, plan). Re-read every turn; throwing counts as off. */
  enabled?: boolean | ((ctx: ToolContext<C>) => boolean);
  /** Short status the dock may show while it runs ("Searching your chats…"). Never the tool name. */
  progress?: string;
}

/** A page the assistant may open for the user (built-in `open_page` tool). */
export interface AgentPageLink {
  path: string;
  title: string;
  description?: string;
}

/** A scripted guided tour (built-in `start_walkthrough` tool). View-only by construction. */
export interface Walkthrough {
  id: string;
  title: string;
  /** When to offer it ("how sharing works", "first steps"). */
  description: string;
  steps: UiAction[];
}

/** One line per turn for metering and logs. Never contains the user's text. */
export interface AgentTurnInfo {
  userId: string;
  outcome: string;
  tools: Array<{ name: string; ok: boolean; risk: RiskTier }>;
  rounds: number;
  model?: string;
  provider?: string;
  /**
   * `promptTokens` includes cached prompt tokens; `cacheReadTokens` / `cacheCreationTokens`
   * say how many of them (when the provider reports it), since providers bill those at
   * different rates.
   */
  usage: { promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  errorCode: AgentErrorCode | null;
  ms: number;
}

export interface AgentConfig<C = unknown> {
  tools: AgentTool<any, any, C>[];
  /** App name for the prompt. */
  appName?: string;
  /** The assistant's own name ("Ada"). */
  assistantName?: string;
  /** Extra prompt lines: tone, product rules. */
  persona?: string;
  /** Background about the product (README, docs). Cut at 6,000 characters. */
  knowledge?: string;
  /** Pages the assistant may open (adds the `open_page` tool). */
  pages?: AgentPageLink[];
  /** Guided tours (adds the `start_walkthrough` tool). */
  walkthroughs?: Walkthrough[];
  /**
   * `data-pa-anchor` names the UI exposes. A highlight may only name one of these (adds the
   * `point_at` tool). Without a list, any well-formed name is accepted — the client still
   * only resolves elements that opted in with `data-pa-anchor`.
   */
  anchors?: Array<string | { name: string; description?: string }>;
  /** Extra view-only UI action types tools may emit. */
  uiActions?: Record<string, CustomUiActionSpec>;
  /**
   * "untrusted": the page's title, state and path can hold someone else's text, so a turn sent
   * from a page with any of them (beyond "/") is tainted. Default "trusted" (per page, the
   * client can still send `page.untrusted`). Either way the query string never reaches the
   * model, and a path segment that isn't a plain word, short slug, number or UUID reaches it
   * as ":param".
   */
  pageContext?: "trusted" | "untrusted";
  /** Messages answered with a fixed refusal before the model (e.g. payments, deleting the account). */
  refusals?: Array<{ match: RegExp; message: string }>;
  /** Reply scrub rules. Default core DEFAULT_SCRUB_RULES; false turns it off. */
  scrub?: ScrubRule[] | false;
  /**
   * LLM provider. Default: the env router (Anthropic → OpenAI → OpenRouter, each a fallback for
   * the one before). Your own provider is called as it is: no router, no provider fallback.
   */
  llm?: LLMProvider;
  /**
   * Model. Default PA_AGENT_MODEL, else "claude-haiku-5-5" — or, with your own `llm`, no model
   * at all (the provider picks its own).
   */
  model?: string;
  /**
   * Used for the rest of 10 minutes when the provider refuses `model`. Default
   * "claude-haiku-4-5". Only applies when a model is set (`model` or PA_AGENT_MODEL).
   */
  fallbackModel?: string;
  /** Where confirm cards wait. Default in-memory (single process only — use a shared store on serverless). */
  pendingActions?: import("./pending.js").PendingActionStore;
  /** Confirm card lifetime. Default 10 minutes. */
  pendingActionTtlMs?: number;
  limits?: {
    /** Tool rounds per turn. Default 8. */
    maxRounds?: number;
    /** One model call. Default 25 s (PA_AGENT_CALL_TIMEOUT_MS). */
    callTimeoutMs?: number;
    /** Whole turn, tools included. Default 50 s (PA_AGENT_TURN_DEADLINE_MS). */
    turnDeadlineMs?: number;
    /** Retries of a busy/unreachable provider. Default 1, at most 3. */
    maxRetries?: number;
    /** History resent per call, in tokens. Default 4,000 (PA_AGENT_HISTORY_TOKENS). */
    historyTokens?: number;
    /** Output cap per call. Default 4,096; one redo at 8,192 when a reply is cut. */
    maxTokens?: number;
  };
  /** Reasoning effort for models that take it. Default: the model's own. */
  effort?: "low" | "medium" | "high";
  /** Cache the prompt prefix across rounds (Anthropic). Default true. */
  promptCache?: boolean;
  /** Called once per turn (also for confirms and refusals). Must not throw; errors are swallowed. */
  onTurn?: (info: AgentTurnInfo) => void | Promise<void>;
}
