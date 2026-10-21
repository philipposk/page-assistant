// How agent mode calls the model: one timeout per call, a bounded retry of a busy or
// unreachable provider, a deadline for the whole turn, one fallback model when the provider
// refuses the chosen one, and history cut to a token budget.
//
// The turn deadline exists because a serverless function (or a proxy in front of a server)
// gives up on the request after a fixed time, and a 504 tells the user nothing. Ending the
// turn first lets it answer in words.

import { MODEL_DEFAULTS, type ChatMessage, type LLMCompletionInput, type LLMCompletionOutput, type LLMProvider } from "@page-assistant/core";
import { AllProvidersFailedError, BILLING_PROBLEM, HttpProviderError, MODEL_REFUSED } from "../llm/errors.js";
import { routerFromEnv } from "../llm/router.js";
import { stripFailureLines } from "./text.js";
import type { AgentErrorCode, AgentHistoryTurn } from "./types.js";

export const DEFAULT_AGENT_MODEL: string = MODEL_DEFAULTS.agent;
export const DEFAULT_FALLBACK_MODEL: string = MODEL_DEFAULTS.agentFallback;

const MIN_CALL_MS = 3_000;
/** Time a redo with the bigger output cap needs to be worth starting. */
const MIN_REDO_MS = 15_000;
const HARD_STOP_MARGIN_MS = 1_000;
const RETRY_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const MODEL_UNAVAILABLE_TTL_MS = 10 * 60 * 1000;

/** A call that failed for good. `code` becomes the reply's errorCode. */
export class LlmCallFailed extends Error {
  constructor(public readonly code: Exclude<AgentErrorCode, "incomplete" | "internal_error">, public readonly cause?: unknown) {
    super(code);
    this.name = "LlmCallFailed";
  }
}

/** (error code, worth retrying, the provider refused the model itself). */
export function classifyLlmError(e: unknown): { code: LlmCallFailed["code"]; retry: boolean; modelUnavailable: boolean } {
  if (e instanceof LlmCallFailed) return { code: e.code, retry: false, modelUnavailable: false };
  // A router's whole chain failed: read it as its first provider's failure (the one that was
  // asked for this model), worth retrying when any provider's failure was passing.
  if (e instanceof AllProvidersFailedError && e.errors.length) {
    return { ...classifyLlmError(e.errors[0]), retry: e.errors.some((x) => classifyLlmError(x).retry) };
  }
  if (e instanceof HttpProviderError) {
    const detail = (e.detail || "").toLowerCase();
    if (e.status === 429 || e.status === 529) return { code: "llm_busy", retry: true, modelUnavailable: false };
    if (e.status >= 500) return { code: "llm_unavailable", retry: true, modelUnavailable: false };
    if (e.status === 413 || /request too large|maximum context|context_length|prompt is too long|too many tokens/.test(detail)) {
      return { code: "llm_too_large", retry: false, modelUnavailable: false };
    }
    // Only a message about the model itself: a 400 for a bad parameter often names the model
    // too ("invalid_request_error: max_tokens … for claude-…-model"), and must not put it aside.
    if (e.status === 404 || (e.status === 400 && MODEL_REFUSED.test(detail))) {
      return { code: "llm_not_configured", retry: false, modelUnavailable: true };
    }
    if (e.status === 401 || e.status === 403) return { code: "llm_not_configured", retry: false, modelUnavailable: e.status === 403 && MODEL_REFUSED.test(detail) };
    if (e.status === 402 || BILLING_PROBLEM.test(detail)) return { code: "llm_not_configured", retry: false, modelUnavailable: false };
    return { code: "llm_error", retry: false, modelUnavailable: false };
  }
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  // A timeout is never retried: the request may have reached the provider and be billing.
  if (/aborted due to timeout|timed? ?out|timeouterror|deadline/.test(msg)) return { code: "llm_timeout", retry: false, modelUnavailable: false };
  if (/no llm key set|has no configured provider/.test(msg)) return { code: "llm_not_configured", retry: false, modelUnavailable: false };
  if (/all llm providers failed|network error|econnrefused|enotfound|socket|fetch failed/.test(msg)) {
    return { code: "llm_unavailable", retry: true, modelUnavailable: false };
  }
  return { code: "llm_error", retry: false, modelUnavailable: false };
}

/** Models the provider refused recently, per process: skipped until the entry lapses. */
const unavailableUntil = new Map<string, number>();

export function markModelUnavailable(model: string, now = Date.now()): void {
  unavailableUntil.set(model, now + MODEL_UNAVAILABLE_TTL_MS);
}

export function modelRecentlyUnavailable(model: string, now = Date.now()): boolean {
  const until = unavailableUntil.get(model);
  if (until === undefined) return false;
  if (until <= now) {
    unavailableUntil.delete(model);
    return false;
  }
  return true;
}

export function resetModelUnavailable(): void {
  unavailableUntil.clear();
}

export interface AgentLlmSettings {
  /** Explicit provider; when absent, two env routers are built (model and fallback). */
  llm?: LLMProvider;
  model?: string;
  fallbackModel?: string;
  callTimeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  maxTokensRetry: number;
  effort?: string;
  promptCache: boolean;
}

/**
 * The provider for a model. With the host's own `llm`, the model rides along as `input.model`.
 * Without one, an env router is built with the model as its Anthropic default, so a busy
 * Anthropic still falls through to OpenAI / OpenRouter (the router's chain).
 */
export function providerFor(settings: AgentLlmSettings, model: string | undefined): { provider: LLMProvider; passModel: boolean } {
  if (settings.llm) return { provider: settings.llm, passModel: !!settings.model };
  return { provider: envRouter(model), passModel: false };
}

const routers = new Map<string, LLMProvider>();
function envRouter(model: string | undefined): LLMProvider {
  const key = model ?? "";
  let r = routers.get(key);
  if (!r) {
    let inner: LLMProvider | null = null;
    // Built on first use so the app boots without keys and fails only on a turn.
    r = {
      name: "router",
      complete: (input) => {
        inner ??= routerFromEnv({ ...process.env, ...(model ? { PA_ANTHROPIC_MODEL: model } : {}) });
        return inner.complete(input);
      },
    };
    routers.set(key, r);
  }
  return r;
}

export interface CallState {
  /** The model this turn is on; switches to the fallback once if the first is refused. */
  model: string | undefined;
  deadline: number;
  promptTokens: number;
  completionTokens: number;
  provider?: string;
  servedModel?: string;
  /** The turn's signal (Stop, client gone, deadline). Cancels the HTTP request in flight. */
  signal?: AbortSignal;
}

/** Waits `ms`, or less when `signal` fires (Stop must not wait out a backoff). */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal?.aborted) return r();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      r();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * One model call under the turn's policy. Raises LlmCallFailed when it gives up. A reply cut
 * at the output cap is not returned cut: it is made once more with the bigger cap, if the
 * turn has time.
 */
export async function callModel(
  settings: AgentLlmSettings,
  state: CallState,
  input: Omit<LLMCompletionInput, "timeoutMs" | "maxTokens" | "model">,
  now: () => number = Date.now
): Promise<LLMCompletionOutput> {
  const out = await callWithFallback(settings, state, { ...input, maxTokens: settings.maxTokens }, now);
  const cut = out.stopReason === "max_tokens" || out.stopReason === "length";
  if (cut && settings.maxTokensRetry > settings.maxTokens && state.deadline - now() >= MIN_REDO_MS) {
    // A redo that fails (or runs out of time) leaves the cut reply, which is better than none.
    try {
      return await callWithFallback(settings, state, { ...input, maxTokens: settings.maxTokensRetry }, now);
    } catch {
      return out;
    }
  }
  return out;
}

async function callWithFallback(
  settings: AgentLlmSettings,
  state: CallState,
  input: Omit<LLMCompletionInput, "timeoutMs" | "model">,
  now: () => number
): Promise<LLMCompletionOutput> {
  for (;;) {
    try {
      return await callWithRetry(settings, state, input, now);
    } catch (e) {
      const c = classifyLlmError(e instanceof LlmCallFailed ? e.cause ?? e : e);
      const fallback = settings.fallbackModel;
      if (c.modelUnavailable && state.model && fallback && state.model !== fallback) {
        // The provider refused the model itself (unknown, retired, no access): every turn
        // would fail. Retry this call on the fallback and skip the refused one for a while.
        console.error(JSON.stringify({ level: "error", route: "agent", msg: "model unavailable; using fallback", model: state.model, fallback }));
        markModelUnavailable(state.model);
        state.model = fallback;
        // Blocks only the first model can read (its thinking) must not reach the fallback.
        for (const m of input.messages) delete m.providerContent;
        continue;
      }
      throw e instanceof LlmCallFailed ? e : new LlmCallFailed(c.code, e);
    }
  }
}

async function callWithRetry(
  settings: AgentLlmSettings,
  state: CallState,
  input: Omit<LLMCompletionInput, "timeoutMs" | "model">,
  now: () => number
): Promise<LLMCompletionOutput> {
  let failures = 0;
  let last: unknown;
  const maxRetries = Math.min(Math.max(settings.maxRetries, 0), 3);
  for (;;) {
    const remaining = state.deadline - now();
    if (remaining < MIN_CALL_MS) {
      throw last !== undefined ? new LlmCallFailed(classifyLlmError(last).code, last) : new LlmCallFailed("llm_timeout");
    }
    if (state.signal?.aborted) throw new LlmCallFailed("llm_timeout", state.signal.reason);
    const timeoutMs = Math.min(settings.callTimeoutMs, remaining);
    const { provider, passModel } = providerFor(settings, state.model);
    // One controller per call: the hard stop below cancels the request itself (so it stops
    // billing and the router doesn't start it again elsewhere), and so does the turn's signal.
    const callAbort = new AbortController();
    const onTurnAbort = () => callAbort.abort(state.signal?.reason);
    state.signal?.addEventListener("abort", onTurnAbort, { once: true });
    const call: LLMCompletionInput = {
      ...input,
      signal: callAbort.signal,
      timeoutMs,
      ...(passModel && state.model ? { model: state.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.promptCache ? { promptCache: true } : {}),
    };
    try {
      const out = await withHardStop(provider.complete(call), timeoutMs + HARD_STOP_MARGIN_MS, callAbort);
      state.promptTokens += out.usage?.promptTokens ?? 0;
      state.completionTokens += out.usage?.completionTokens ?? 0;
      if (out.provider) state.provider = out.provider;
      if (out.model) state.servedModel = out.model;
      return out;
    } catch (e) {
      last = e;
      failures++;
      if (state.signal?.aborted) throw new LlmCallFailed("llm_timeout", e);
      const c = classifyLlmError(e);
      if (c.modelUnavailable) throw e;
      if (!c.retry || failures > maxRetries) throw new LlmCallFailed(c.code, e);
      const delay = Math.min(RETRY_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
      if (state.deadline - now() - delay < MIN_CALL_MS) throw new LlmCallFailed(c.code, e);
      await sleep(delay, state.signal);
      if (state.signal?.aborted) throw new LlmCallFailed("llm_timeout", e);
    } finally {
      state.signal?.removeEventListener("abort", onTurnAbort);
    }
  }
}

/** The provider's own timeout covers the HTTP exchange; this is the stop if anything else hangs. */
function withHardStop<T>(p: Promise<T>, ms: number, abort: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        // Settle the race as a timeout first, then cancel the request (its own rejection,
        // "aborted", would otherwise win and read as a generic failure).
        reject(new Error("deadline: the model call timed out"));
        abort.abort(new Error("deadline"));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// --- History -----------------------------------------------------------------------------

export const HISTORY_MAX_TURNS = 24;
/** Errs towards sending less: English runs nearer 4 characters a token. */
const CHARS_PER_TOKEN = 3;
const MAX_TURN_CHARS = 32_000;
export const TRUNCATED_MARK = "[earlier part cut] ";

/**
 * The history turns worth resending, oldest first. Narration beats and error bubbles are
 * dropped first (the model would read them as its own words and apologise for, or repeat,
 * them), then the newest turns are kept while they fit the budget. The first one that does
 * not fit ends the history — older turns without the ones in between would read as a
 * different conversation — except that the newest is always kept, cut to its last part.
 */
export function historyForLlm(turns: AgentHistoryTurn[] | undefined, maxTokens: number): ChatMessage[] {
  return selectHistory(turns, maxTokens).messages;
}

/**
 * `historyForLlm`, plus whether any turn the model will read again holds text someone else
 * wrote (`tainted`). Such a turn starts tainted: the injected words are back in front of the
 * model, so a "new message" is not a clean slate — only a chat where that text has aged out is.
 */
export function selectHistory(turns: AgentHistoryTurn[] | undefined, maxTokens: number): { messages: ChatMessage[]; tainted: boolean } {
  const usable: ChatMessage[] = [];
  for (const t of turns ?? []) {
    if (!t || (t.role !== "user" && t.role !== "assistant")) continue;
    if (t.kind === "narrate" || t.kind === "error") continue;
    let content = String(t.content ?? "").slice(0, MAX_TURN_CHARS).trim();
    if (t.role === "assistant") content = stripFailureLines(content);
    if (content) usable.push({ role: t.role, content, ...(t.tainted === true ? { tainted: true } : {}) });
  }
  const budget = Math.max(maxTokens, 1) * CHARS_PER_TOKEN;
  const kept: ChatMessage[] = [];
  let used = 0;
  for (const turn of usable.slice(-HISTORY_MAX_TURNS).reverse()) {
    const size = turn.content.length;
    if (used + size > budget) {
      if (!kept.length) {
        const room = Math.max(budget - TRUNCATED_MARK.length, 0);
        // slice(-0) would be the whole string.
        kept.push({ ...turn, content: TRUNCATED_MARK + (room > 0 ? turn.content.slice(-room) : "") });
      }
      break;
    }
    kept.push(turn);
    used += size;
  }
  kept.reverse();
  const tainted = kept.some((m) => m.tainted === true);
  return { messages: kept.map(({ tainted: _t, ...m }) => m), tainted };
}
