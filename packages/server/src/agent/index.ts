// Agent mode: the server-side tool loop. Import from "@page-assistant/server/agent" (no Express)
// or "@page-assistant/server/next" (plus the App Router helper).

export { createAgent } from "./loop.js";
export type { Agent, TurnHooks } from "./loop.js";
export { createAgentHandler, memoryLimiter, MAX_MESSAGE_CHARS } from "./handler.js";
export type { AgentHandlerOptions, RateDecision } from "./handler.js";
export { toNodeHandler } from "./node.js";
export { createVoiceRoutes } from "./voice.js";
export type { VoiceRouteOptions } from "./voice.js";
export { AgentToolRegistry, ToolRegistryError, toolProblems, riskOf } from "./registry.js";
export type { StepResult } from "./registry.js";
export { MemoryPendingActionStore, hashToken, newToken, isTokenShaped, DEFAULT_PENDING_TTL_MS } from "./pending.js";
export type { PendingActionRecord, PendingActionStore } from "./pending.js";
export { supabasePendingActionStore } from "./supabase.js";
export type { SupabasePendingActionOptions } from "./supabase.js";
export { coerceUiActions, isSafeInAppPath, isSafeNavigationPath, normalizeNavigationPath } from "./actions.js";
export { schemaProblem } from "./schema.js";
export { readLimited, crossSiteRefusal, isJsonRequest } from "./http.js";
export { historyForLlm, selectHistory, classifyLlmError, DEFAULT_AGENT_MODEL, DEFAULT_FALLBACK_MODEL, resetModelUnavailable } from "./llm.js";
export { validateAgentText } from "./validator.js";
export { cleanMarkdown, canonicalUrl, urlsIn, FAILURE_MESSAGES, WRITE_REFUSAL } from "./text.js";
export * from "./types.js";

import type { AgentTool } from "./types.js";
/** Identity helper that types a tool's args and result. */
export function defineTool<A = Record<string, unknown>, R = unknown, C = unknown>(tool: AgentTool<A, R, C>): AgentTool<A, R, C> {
  return tool;
}
