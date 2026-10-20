"use client";

// <AgentDock>: the Agent mode chat panel. Ported from Egon's dock and split into parts:
// state (useAgentChat), UI actions (useActionRunner + HighlightOverlay), voice (useVoice),
// and presentational pieces (parts.tsx, PendingActionCard, Markdown).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { HighlightOverlay } from "../actions/HighlightOverlay.js";
import type { UiActionHandler } from "../actions/runner.js";
import { useActionRunner } from "../actions/useActionRunner.js";
import { fetchIntro } from "../chat/client.js";
import { localChatHistory, type ChatHistoryAdapter } from "../chat/history.js";
import { useAgentChat, type UseAgentChatOptions } from "../chat/useAgentChat.js";
import { useVoice, type VoiceOptions } from "../chat/useVoice.js";
import { MAX_MESSAGE_CHARS, type AgentTurnResponse, type ResultCard, type Suggestion } from "../protocol.js";
import { cardOnArrival, PendingActionCard } from "./PendingActionCard.js";
import { Composer, HistoryPanel, MessageList, SuggestionChips, ThinkingIndicator } from "./parts.js";
import { DOCK_CSS } from "./styles.js";

export interface AgentDockProps extends Omit<UseAgentChatOptions, "onReply" | "history"> {
  /**
   * Saved chats: a ChatHistoryAdapter (e.g. supabaseChatHistoryAdapter), "local" (this device,
   * the default) or false (this visit only).
   */
  history?: ChatHistoryAdapter | "local" | false;
  /** Keys device-only chats per user, so two people on one browser don't share them. */
  userId?: string | null;
  /** Your router's push (Next.js: `router.push`). Default: a full page load. */
  navigate?: (path: string) => void;
  /** Handlers for custom UI actions by type. Others go to the event bus (`usePaAction`). */
  actions?: Record<string, UiActionHandler>;
  /** Draw a tool's result card (a chart, a file). Without it cards are not shown. */
  renderCard?: (card: ResultCard) => ReactNode;
  title?: string;
  placeholder?: string;
  /** Starter text and chips before the first message. Default: what the route's GET returns. */
  intro?: string;
  suggestions?: Array<{ label: string; prompt: string }>;
  /** true = the server voice routes next to the agent route (…/voice/stt, …/voice/tts). */
  voice?: boolean | VoiceOptions;
  defaultOpen?: boolean;
  /** Controlled open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  position?: "bottom-right" | "bottom-left";
  theme?: "light" | "dark" | "auto";
  /** Shortcut for the --pa-accent CSS variable. */
  accentColor?: string;
  launcherLabel?: string;
  className?: string;
}

function voiceOptions(voice: AgentDockProps["voice"], endpoint: string): VoiceOptions | null {
  if (!voice) return null;
  if (voice === true) {
    const base = endpoint.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
    return { sttUrl: `${base}/voice/stt`, ttsUrl: `${base}/voice/tts` };
  }
  return voice;
}

export function AgentDock(props: AgentDockProps) {
  const {
    history = "local",
    userId,
    navigate,
    actions,
    renderCard,
    title,
    placeholder,
    intro,
    suggestions: starterChips,
    voice,
    defaultOpen = false,
    open: openProp,
    onOpenChange,
    position = "bottom-right",
    theme = "auto",
    accentColor,
    launcherLabel,
    className,
    ...transport
  } = props;

  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (v: boolean) => {
      if (openProp === undefined) setOpenState(v);
      onOpenChange?.(v);
    },
    [openProp, onOpenChange]
  );
  const [showHistory, setShowHistory] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [inject, setInject] = useState<{ text: string; n: number } | null>(null);
  const [remoteIntro, setRemoteIntro] = useState<{ name: string | null; text?: string; chips: Array<{ label: string; prompt: string }> } | null>(null);

  const adapter = useMemo<ChatHistoryAdapter | null>(
    () => (history === false ? null : history === "local" ? localChatHistory({ userId }) : history),
    [history, userId]
  );
  const voiceOpts = useMemo(() => voiceOptions(voice, transport.endpoint), [voice, transport.endpoint]);
  const v = useVoice(voiceOpts, transport);
  const vRef = useRef(v);
  vRef.current = v;

  // A stable callback over the host's (often inline) navigate, so memoized messages don't re-render.
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const stableNavigate = useCallback((path: string) => {
    if (navRef.current) navRef.current(path);
    else if (typeof window !== "undefined") window.location.assign(path);
  }, []);

  const chatRef = useRef<ReturnType<typeof useAgentChat> | null>(null);
  const runner = useActionRunner({
    navigate,
    handlers: actions,
    onNarrate: (text, speak) => {
      chatRef.current?.addNarration(text);
      if (speak) void vRef.current.speak(text);
    },
  });
  const runnerRef = useRef(runner);
  runnerRef.current = runner;

  const onReply = useCallback((reply: AgentTurnResponse) => {
    // A guided tour narrates its own beats; reading the reply on top would talk over it.
    if (reply.uiActionMode !== "guided" && reply.message) void vRef.current.speak(reply.message);
    void runnerRef.current.run(reply.uiActions, reply.uiActionMode);
  }, []);

  const chat = useAgentChat({ ...transport, history: adapter, onReply });
  chatRef.current = chat;
  const card = chat.pendingAction ? cardOnArrival(chat.pendingAction) : null;

  useEffect(() => {
    if (!open || remoteIntro || (intro && starterChips)) return;
    let alive = true;
    void fetchIntro(transport).then((r) => {
      if (alive && r) setRemoteIntro({ name: r.assistantName, text: r.intro?.text, chips: r.intro?.suggestions ?? [] });
    });
    return () => {
      alive = false;
    };
  }, [open]);

  // Escape stops a walkthrough first, then closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (runnerRef.current.running) runnerRef.current.cancel();
      else if (showHistory) setShowHistory(false);
      else setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, showHistory, setOpen]);

  const name = title ?? remoteIntro?.name ?? "Assistant";
  const introText = intro ?? remoteIntro?.text ?? `Hi! I can help you get things done in this app. What do you need?`;
  const chips: Array<Suggestion | { label: string; prompt: string }> = chat.lines.length ? chat.suggestions : starterChips ?? remoteIntro?.chips ?? [];
  const pick = (s: Suggestion) => void chat.send(s.prompt, { suggestionTool: s.tool });

  const rootStyle = accentColor ? ({ ["--pa-accent" as string]: accentColor } as CSSProperties) : undefined;

  return (
    <div className={`pa-agent-root${className ? ` ${className}` : ""}`} data-theme={theme} data-position={position} style={rootStyle}>
      <style href="page-assistant-agent-dock" precedence="default">
        {DOCK_CSS}
      </style>
      <HighlightOverlay target={runner.highlight} />
      {!open ? (
        <button type="button" className="pa-agent-launcher" aria-label={`Open ${name}`} onClick={() => setOpen(true)}>
          {launcherLabel ?? `Ask ${name}`}
        </button>
      ) : (
        <section className="pa-agent-panel" aria-label={name} data-expanded={expanded} data-pa-anchor="assistant.dock">
          <header className="pa-agent-header">
            {adapter ? (
              <button
                type="button"
                className="pa-agent-icon-btn"
                aria-label="Chats"
                aria-pressed={showHistory}
                onClick={() => {
                  setShowHistory((s) => !s);
                  void chat.refreshChats();
                }}
              >
                ☰
              </button>
            ) : null}
            <span className="pa-agent-title">{name}</span>
            {runner.running ? (
              <button type="button" className="pa-agent-btn" onClick={() => runner.cancel()}>
                Stop tour
              </button>
            ) : null}
            {v.enabled ? (
              <button
                type="button"
                className="pa-agent-icon-btn"
                aria-label={v.speakReplies ? "Stop reading replies aloud" : "Read replies aloud"}
                aria-pressed={v.speakReplies}
                onClick={() => {
                  if (v.speakReplies) v.stopSpeaking();
                  v.setSpeakReplies(!v.speakReplies);
                }}
              >
                {v.speakReplies ? "🔊" : "🔈"}
              </button>
            ) : null}
            <button type="button" className="pa-agent-icon-btn" aria-label="New chat" onClick={() => chat.newChat()}>
              ✎
            </button>
            <button type="button" className="pa-agent-icon-btn" aria-label={expanded ? "Smaller" : "Larger"} onClick={() => setExpanded((e) => !e)}>
              {expanded ? "⤡" : "⤢"}
            </button>
            <button type="button" className="pa-agent-icon-btn" aria-label="Close" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          {showHistory && adapter ? (
            <HistoryPanel
              chats={chat.chats}
              currentId={chat.chatId}
              onOpen={(id) => {
                void chat.openChat(id);
                setShowHistory(false);
              }}
              onDelete={(id) => void chat.deleteChat(id)}
              onNew={() => {
                chat.newChat();
                setShowHistory(false);
              }}
              onClose={() => setShowHistory(false)}
            />
          ) : null}
          <MessageList
            lines={chat.lines}
            busy={chat.busy}
            onNavigate={stableNavigate}
            onRetry={(id) => void chat.retry(id)}
            renderCard={renderCard}
            empty={
              <div className="pa-agent-empty">
                <p>{introText}</p>
              </div>
            }
            footer={chat.busy ? <ThinkingIndicator status={chat.status} /> : null}
          />
          <div className="pa-agent-footer">
            {card ? (
              <PendingActionCard action={card} loading={chat.busy} onConfirm={() => chat.confirm()} onDismiss={() => chat.dismiss()} />
            ) : null}
            {!chat.busy && !card ? <SuggestionChips items={chips} onPick={pick} /> : null}
            {chat.saveFailed ? <p className="pa-agent-note">This chat could not be saved just now.</p> : null}
            <Composer
              busy={chat.busy}
              placeholder={placeholder}
              maxChars={MAX_MESSAGE_CHARS}
              onSend={(t) => chat.send(t)}
              onStop={() => chat.stop()}
              inject={inject}
              mic={
                v.enabled
                  ? {
                      available: v.available,
                      recording: v.recording,
                      transcribing: v.transcribing,
                      onToggle: () => void v.toggle((text) => setInject((p) => ({ text, n: (p?.n ?? 0) + 1 }))),
                    }
                  : undefined
              }
            />
          </div>
        </section>
      )}
    </div>
  );
}
