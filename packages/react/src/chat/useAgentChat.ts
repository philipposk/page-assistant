"use client";

// The dock's state: the conversation, a turn in flight, the confirm card, follow-up chips and
// saved chats. Headless: build your own UI on it, or use <AgentDock>.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentPage, AgentStatus, AgentTurnResponse, PendingActionCard, Suggestion } from "../protocol.js";
import { MAX_MESSAGE_CHARS } from "../protocol.js";
import { postTurn, type AgentTransport } from "./client.js";
import type { AccountChatSummary, ChatHistoryAdapter } from "./history.js";
import {
  STOPPED_FAILURE,
  failureFromError,
  isFailureReply,
  linesFromSaved,
  newId,
  retryForReply,
  titleFrom,
  toHistoryTurns,
  toSavable,
  type ChatLine,
} from "./lines.js";

/** What this dock can render; the server only sends what is declared. */
export const DOCK_CAPABILITIES = ["pending_action", "result_cards", "guided"];

export interface UseAgentChatOptions extends AgentTransport {
  /**
   * The page as data for the model. Default: path (no query string) and title, plus
   * `getPageState()`. Return `untrusted: true` when the page shows text someone else wrote.
   */
  getPage?: () => AgentPage;
  /** Host view state (selected rows, open item). Ignored when `getPage` is given. */
  getPageState?: () => Record<string, unknown> | undefined;
  /** Saved chats. null = none (this visit only). */
  history?: ChatHistoryAdapter | null;
  /**
   * Who the saved chats belong to (the signed-in user's id). When it changes the chat is reset
   * and the list is read again, so one person never sees another's conversation. Without it
   * the list is read once, not on every new `history` object.
   */
  historyKey?: string | null;
  /** Server-Sent Events with progress. Default true. */
  stream?: boolean;
  /** Called with every reply, after it is shown (the dock runs its UI actions here). */
  onReply?: (reply: AgentTurnResponse) => void;
  clientCapabilities?: string[];
}

export interface SendOptions {
  suggestionTool?: string;
}

function defaultPage(getState?: () => Record<string, unknown> | undefined): AgentPage {
  if (typeof window === "undefined") return {};
  let state: Record<string, unknown> | undefined;
  try {
    state = getState?.();
  } catch {
    state = undefined;
  }
  return {
    // The query string can hold tokens and search terms; the model gets the route only.
    path: window.location.pathname,
    title: typeof document !== "undefined" ? document.title : undefined,
    ...(state ? { state } : {}),
  };
}

export function useAgentChat(opts: UseAgentChatOptions) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingActionCard | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [chatId, setChatId] = useState<string>(() => newId());
  const [chats, setChats] = useState<AccountChatSummary[]>([]);
  const [saveFailed, setSaveFailed] = useState(false);

  const ref = useRef(opts);
  ref.current = opts;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const createdAt = useRef(new Date().toISOString());
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  // Bumped by every new or reset chat. A reply that belongs to an older one is dropped.
  const generation = useRef(0);
  const listSeq = useRef(0);

  const setAll = (next: ChatLine[]) => {
    linesRef.current = next;
    setLines(next);
  };
  const append = (...add: ChatLine[]) => setAll([...linesRef.current, ...add]);

  const page = () => (ref.current.getPage ? ref.current.getPage() : defaultPage(ref.current.getPageState));
  const caps = () => ref.current.clientCapabilities ?? DOCK_CAPABILITIES;

  const persist = useCallback(async () => {
    const adapter = ref.current.history;
    const messages = toSavable(linesRef.current);
    if (!adapter || !messages.length) return;
    const first = messages.find((m) => m.role === "user");
    try {
      await adapter.save({
        id: chatIdRef.current,
        title: titleFrom(first?.content ?? ""),
        messages,
        createdAt: createdAt.current,
        updatedAt: new Date().toISOString(),
      });
      setSaveFailed(false);
    } catch {
      setSaveFailed(true);
    }
  }, []);

  const refreshChats = useCallback(async () => {
    const adapter = ref.current.history;
    const seq = ++listSeq.current;
    if (!adapter) return setChats([]);
    try {
      const list = await adapter.list();
      if (seq === listSeq.current) setChats(list); // not a list from before a reset
    } catch {
      if (seq === listSeq.current) setChats([]);
    }
  }, []);

  // Keyed on whether there is an adapter and whose it is, not on the object: a host that builds
  // a new adapter every render would otherwise re-list (and re-run retention) on each one.
  const historyKey = useRef(opts.historyKey);
  useEffect(() => {
    if (historyKey.current !== opts.historyKey) {
      historyKey.current = opts.historyKey;
      reset();
    }
    void refreshChats();
  }, [!!opts.history, opts.historyKey]);

  const finishTurn = (reply: AgentTurnResponse, retryMessage?: string, suggestionTool?: string) => {
    if (isFailureReply(reply)) {
      const retry = retryForReply(reply);
      append({
        id: newId(),
        role: "assistant",
        content: reply.message,
        kind: "error",
        ...(retry && retryMessage !== undefined ? { retry: { label: retry.label, message: retryMessage, suggestionTool } } : {}),
      });
    } else {
      append({
        id: newId(),
        role: "assistant",
        content: reply.message,
        ...(reply.cards.length ? { cards: reply.cards } : {}),
        ...(reply.tainted ? { tainted: true } : {}),
      });
    }
    setPendingAction(reply.pendingAction);
    setSuggestions(reply.suggestions);
    try {
      ref.current.onReply?.(reply);
    } catch {
      /* a host callback must not break the chat */
    }
    if (!isFailureReply(reply)) void persist().then(refreshChats);
  };

  /** Send a typed message. Returns the text to put back in the box when the turn was refused. */
  const send = useCallback(async (text: string, sendOpts: SendOptions = {}): Promise<string | null> => {
    const message = text.trim();
    if (!message || busyRef.current) return null;
    if (message.length > MAX_MESSAGE_CHARS) {
      append({ id: newId(), role: "assistant", kind: "error", content: `That message is too long (max ${MAX_MESSAGE_CHARS} characters). Shorten it and try again.` });
      return text;
    }
    // Typing never confirms a card; a new message leaves it behind (the token just lapses).
    setPendingAction(null);
    setSuggestions([]);
    const prior = linesRef.current;
    const userLine: ChatLine = { id: newId(), role: "user", content: message };
    append(userLine);
    busyRef.current = true;
    setBusy(true);
    setStatus({ phase: "thinking" });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const mine = generation.current;
    try {
      const reply = await postTurn(
        ref.current,
        {
          message,
          history: toHistoryTurns(prior),
          page: page(),
          clientCapabilities: caps(),
          chatId: chatIdRef.current,
          ...(sendOpts.suggestionTool ? { suggestionTool: sendOpts.suggestionTool } : {}),
        },
        { signal: ctrl.signal, stream: ref.current.stream !== false, onStatus: (s) => mine === generation.current && setStatus(s) }
      );
      if (mine !== generation.current) return null; // the chat was replaced while this ran
      finishTurn(reply, message, sendOpts.suggestionTool);
      return null;
    } catch (err) {
      if (mine !== generation.current) return null;
      const aborted = ctrl.signal.aborted;
      const failure = aborted ? STOPPED_FAILURE : failureFromError(err);
      let base = linesRef.current;
      if (failure.rollback) base = base.filter((l) => l.id !== userLine.id);
      const notBefore = failure.retry?.waitSeconds ? Date.now() + failure.retry.waitSeconds * 1000 : undefined;
      setAll([
        ...base,
        {
          id: newId(),
          role: "assistant",
          kind: "error",
          content: failure.content,
          ...(failure.retry ? { retry: { label: failure.retry.label, message, suggestionTool: sendOpts.suggestionTool, notBefore } } : {}),
        },
      ]);
      return failure.rollback ? text : null;
    } finally {
      if (mine === generation.current) {
        busyRef.current = false;
        setBusy(false);
        setStatus(null);
        abortRef.current = null;
      }
    }
  }, []);

  /** Confirm the card. The only way a confirm-tier action runs; no model call. */
  const confirm = useCallback(async (): Promise<void> => {
    const card = pendingAction;
    if (!card || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus({ phase: "tool" });
    const mine = generation.current;
    try {
      const reply = await postTurn(ref.current, { message: "", confirmToken: card.token, page: page(), clientCapabilities: caps(), chatId: chatIdRef.current }, { stream: false });
      if (mine !== generation.current) return;
      setPendingAction(null);
      finishTurn(reply);
    } catch (err) {
      if (mine === generation.current) append({ id: newId(), role: "assistant", kind: "error", content: failureFromError(err).content });
      throw err;
    } finally {
      if (mine === generation.current) {
        busyRef.current = false;
        setBusy(false);
        setStatus(null);
      }
    }
  }, [pendingAction]);

  /** Drop the card. No network: the token simply expires. */
  const dismiss = useCallback(() => setPendingAction(null), []);

  /** Stop waiting for the reply in flight. Steps the server already ran stay done. */
  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** Resend the message of an error bubble. */
  const retry = useCallback(
    async (lineId: string) => {
      const all = linesRef.current;
      const idx = all.findIndex((l) => l.id === lineId);
      const r = all[idx]?.retry;
      if (!r || (r.notBefore && Date.now() < r.notBefore)) return;
      // Drop the bubble, and the question it answered so the resend does not show it twice.
      let next = all.filter((l) => l.id !== lineId);
      const before = idx > 0 ? all[idx - 1] : undefined;
      if (before?.role === "user" && before.content === r.message) next = next.filter((l) => l.id !== before.id);
      setAll(next);
      await send(r.message, { suggestionTool: r.suggestionTool });
    },
    [send]
  );

  /** Add a walkthrough narration beat as its own bubble (not saved, not resent to the model as its words). */
  const addNarration = useCallback((text: string) => {
    append({ id: newId(), role: "assistant", kind: "narration", content: text });
  }, []);

  const newChat = useCallback(() => {
    generation.current++; // whatever is still in flight belongs to the chat being left
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setStatus(null);
    setAll([]);
    setPendingAction(null);
    setSuggestions([]);
    setChatId(newId());
    createdAt.current = new Date().toISOString();
  }, []);

  /** A new chat that also forgets the saved-chat list: the account behind it changed. */
  function reset() {
    newChat();
    listSeq.current++;
    setChats([]);
    setSaveFailed(false);
  }

  const openChat = useCallback(async (id: string) => {
    const adapter = ref.current.history;
    if (!adapter || busyRef.current) return;
    try {
      const chat = await adapter.get(id);
      if (!chat) return void refreshChats();
      setAll(linesFromSaved(chat.messages ?? []));
      setPendingAction(null);
      setSuggestions([]);
      chatIdRef.current = chat.id;
      setChatId(chat.id);
      createdAt.current = chat.createdAt;
    } catch {
      /* the list stays; nothing else to do */
    }
  }, [refreshChats]);

  const deleteChat = useCallback(async (id: string) => {
    const adapter = ref.current.history;
    if (!adapter) return;
    try {
      await adapter.delete(id);
    } finally {
      if (id === chatIdRef.current) newChat();
      await refreshChats();
    }
  }, [newChat, refreshChats]);

  return { lines, busy, status, pendingAction, suggestions, chatId, chats, saveFailed, send, confirm, dismiss, stop, retry, addNarration, newChat, openChat, deleteChat, refreshChats };
}

export type AgentChat = ReturnType<typeof useAgentChat>;
