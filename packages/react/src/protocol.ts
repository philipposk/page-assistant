// The wire contract with @page-assistant/server's agent route. Kept in sync with
// packages/server/src/agent/types.ts by hand: the dock must not depend on the server package.

/** View-only UI actions. None of them can change data. */
export type UiAction =
  | { type: "navigate"; to: string }
  | { type: "narrate"; text: string; speak?: boolean }
  | { type: "highlight"; anchor: string; label?: string }
  | { type: "wait"; ms: number }
  | { type: string; [key: string]: unknown };

export type UiActionMode = "immediate" | "guided";
export type RiskTier = "read" | "write" | "confirm";

/** A confirm card: nothing has run yet. Title and details are plain text, never HTML. */
export interface PendingActionCard {
  token: string;
  tool: string;
  title: string;
  details: string[];
  confirmLabel: string;
  /** ISO 8601. Single use. */
  expiresAt: string;
}

export interface Suggestion {
  label: string;
  prompt: string;
  tool?: string;
  risk?: RiskTier;
}

export interface ResultCard {
  type: string;
  [key: string]: unknown;
}

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
  pendingAction: PendingActionCard | null;
  suggestions: Suggestion[];
  cards: ResultCard[];
  errorCode: AgentErrorCode | null;
  chatId: string | null;
  /** The reply holds text someone else wrote; send it back tagged so later turns stay guarded. */
  tainted: boolean;
}

export interface AgentHistoryTurn {
  role: "user" | "assistant";
  content: string;
  kind?: "narrate" | "error";
  /** Echo of the reply's `tainted`. */
  tainted?: boolean;
}

export interface AgentPage {
  path?: string;
  url?: string;
  title?: string;
  state?: Record<string, unknown>;
  /**
   * The page shows text someone else wrote (a shared document, another user's message), so the
   * turn is tainted from the start: writes need a card. Return it from `getPage`.
   */
  untrusted?: boolean;
}

export interface AgentTurnBody {
  message: string;
  history?: AgentHistoryTurn[];
  page?: AgentPage;
  confirmToken?: string;
  suggestionTool?: string;
  clientCapabilities?: string[];
  chatId?: string;
}

/** What GET on the agent route returns. */
export interface AgentIntro {
  ok: boolean;
  assistantName: string | null;
  intro: { text?: string; suggestions?: Array<{ label: string; prompt: string }> } | null;
}

/** Progress while a turn runs (streaming only). */
export interface AgentStatus {
  phase: "thinking" | "tool";
  label?: string;
}

/** Longest typed message the server takes. */
export const MAX_MESSAGE_CHARS = 12_000;
