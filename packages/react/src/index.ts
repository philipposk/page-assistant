// @page-assistant/react — the Agent mode dock for React 19 / Next.js.
//
//   <AgentDock endpoint="/api/pa/agent" navigate={router.push} history={supabaseChatHistoryAdapter(supabase)} />
//
// Everything the dock uses is exported too, for a host that wants its own UI.

export { AgentDock } from "./components/AgentDock.js";
export type { AgentDockProps } from "./components/AgentDock.js";
export { PendingActionCard, hasExpired, cardOnArrival, CARD_TTL_MS } from "./components/PendingActionCard.js";
export { Markdown, parseBlocks } from "./components/Markdown.js";
export { MessageList, Composer, SuggestionChips, HistoryPanel, ThinkingIndicator } from "./components/parts.js";
export { DOCK_CSS } from "./components/styles.js";

export { useAgentChat, DOCK_CAPABILITIES } from "./chat/useAgentChat.js";
export type { UseAgentChatOptions, AgentChat, SendOptions } from "./chat/useAgentChat.js";
export { useVoice, speakableText } from "./chat/useVoice.js";
export type { VoiceOptions } from "./chat/useVoice.js";
export { postTurn, readEvents, fetchIntro, normaliseReply, AgentRequestError } from "./chat/client.js";
export type { AgentTransport, PostTurnOptions } from "./chat/client.js";
export { localChatHistory, supabaseChatHistoryAdapter } from "./chat/history.js";
export type { ChatHistoryAdapter, AccountChat, AccountChatSummary, SupabaseChatHistoryOptions, SupabaseClientLike } from "./chat/history.js";
export { toHistoryTurns, toSavable, linesFromSaved, failureFromError, retryForReply, isFailureReply } from "./chat/lines.js";
export type { ChatLine, ChatLineRetry } from "./chat/lines.js";

export { createActionRunner } from "./actions/runner.js";
export type { ActionRunner, ActionRunnerDeps, HighlightTarget, UiActionHandler } from "./actions/runner.js";
export { useActionRunner } from "./actions/useActionRunner.js";
export { HighlightOverlay } from "./actions/HighlightOverlay.js";
export { emitPaAction, onPaAction, usePaAction, clearPendingPaActions, REPLAY_WINDOW_MS } from "./actions/events.js";
export { paAnchor, resolveAnchor, waitForAnchor, isAnchorName } from "./actions/anchors.js";
export { isSafeInAppPath, isSafeNavigationPath, isExternalHttpUrl } from "./actions/safeNavigate.js";

export * from "./protocol.js";
