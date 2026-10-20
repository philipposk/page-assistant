"use client";

// Small dock parts: thinking indicator, suggestion chips, message list, composer, history panel.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentStatus, ResultCard, Suggestion } from "../protocol.js";
import type { AccountChatSummary } from "../chat/history.js";
import type { ChatLine } from "../chat/lines.js";
import { Markdown } from "./Markdown.js";

export function ThinkingIndicator({ status }: { status: AgentStatus | null }) {
  const label = status?.label || (status?.phase === "tool" ? "Working on it…" : "Thinking…");
  return (
    <div className="pa-agent-thinking" role="status" aria-live="polite">
      <span className="pa-agent-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{label}</span>
    </div>
  );
}

export function SuggestionChips({ items, onPick, disabled }: { items: Array<Suggestion | { label: string; prompt: string }>; onPick: (s: Suggestion) => void; disabled?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="pa-agent-chips" role="list">
      {items.map((s, i) => (
        <button
          key={`${s.label}-${i}`}
          type="button"
          role="listitem"
          className="pa-agent-chip"
          disabled={disabled}
          onClick={() => onPick(s as Suggestion)}
          title={(s as Suggestion).risk && (s as Suggestion).risk !== "read" ? "This changes data" : undefined}
        >
          {s.label}
          {(s as Suggestion).risk === "confirm" ? <span className="pa-agent-chip-tag">asks first</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface MessageListProps {
  lines: ChatLine[];
  onNavigate?: (path: string) => void;
  onRetry: (lineId: string) => void;
  renderCard?: (card: ResultCard) => ReactNode;
  busy: boolean;
  footer?: ReactNode;
  empty?: ReactNode;
}

export function MessageList({ lines, onNavigate, onRetry, renderCard, busy, footer, empty }: MessageListProps) {
  const end = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [lines.length, busy]);
  // Re-render once a Retry-After wait is over, so the button enables itself.
  const waitUntil = Math.max(0, ...lines.map((l) => l.retry?.notBefore ?? 0));
  useEffect(() => {
    const ms = waitUntil - Date.now();
    if (ms <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), ms + 50);
    return () => clearTimeout(t);
  }, [waitUntil]);
  const lastId = lines[lines.length - 1]?.id;

  return (
    <div className="pa-agent-messages" role="log" aria-live="polite" aria-relevant="additions">
      {!lines.length && empty}
      {lines.map((l) => (
        <div key={l.id} className={`pa-agent-msg pa-agent-msg-${l.role} pa-agent-msg-${l.kind ?? "turn"}`}>
          <div className="pa-agent-bubble">
            {l.role === "user" ? <p className="pa-agent-user-text">{l.content}</p> : <Markdown text={l.content} onNavigate={onNavigate} />}
            {l.cards?.length && renderCard ? <div className="pa-agent-cards">{l.cards.map((c, i) => <div key={i}>{renderCard(c)}</div>)}</div> : null}
            {l.note ? <p className="pa-agent-note">{l.note}</p> : null}
            {l.retry && l.id === lastId ? (
              <button
                type="button"
                className="pa-agent-btn pa-agent-retry"
                disabled={busy || (l.retry.notBefore !== undefined && Date.now() < l.retry.notBefore)}
                onClick={() => onRetry(l.id)}
              >
                {l.retry.label}
              </button>
            ) : null}
          </div>
        </div>
      ))}
      {footer}
      <div ref={end} />
    </div>
  );
}

export interface ComposerProps {
  onSend: (text: string) => Promise<string | null>;
  onStop: () => void;
  busy: boolean;
  placeholder?: string;
  maxChars: number;
  mic?: { recording: boolean; available: boolean; onToggle: () => void; transcribing?: boolean };
  /** Text pushed in from outside (a transcription). */
  inject?: { text: string; n: number } | null;
}

export function Composer({ onSend, onStop, busy, placeholder, maxChars, mic, inject }: ComposerProps) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (inject?.text) {
      setText((t) => (t.trim() ? `${t.trim()} ${inject.text}` : inject.text));
      box.current?.focus();
    }
  }, [inject?.n]);
  const submit = async () => {
    const value = text;
    if (!value.trim() || busy) return;
    setText("");
    const restore = await onSend(value);
    if (restore) setText(restore);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <form
      className="pa-agent-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={box}
        className="pa-agent-input"
        value={text}
        rows={1}
        maxLength={maxChars}
        placeholder={placeholder ?? "Ask anything…"}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {mic?.available ? (
        <button
          type="button"
          className={`pa-agent-icon-btn${mic.recording ? " pa-agent-recording" : ""}`}
          aria-label={mic.recording ? "Stop recording" : "Speak"}
          aria-pressed={mic.recording}
          disabled={busy || mic.transcribing}
          onClick={mic.onToggle}
        >
          {mic.recording ? "■" : "🎙"}
        </button>
      ) : null}
      {busy ? (
        <button type="button" className="pa-agent-icon-btn" aria-label="Stop" onClick={onStop}>
          ■
        </button>
      ) : (
        <button type="submit" className="pa-agent-icon-btn pa-agent-send" aria-label="Send" disabled={!text.trim()}>
          ↑
        </button>
      )}
    </form>
  );
}

export interface HistoryPanelProps {
  chats: AccountChatSummary[];
  currentId: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function HistoryPanel({ chats, currentId, onOpen, onDelete, onNew, onClose }: HistoryPanelProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <div className="pa-agent-history" role="dialog" aria-label="Chats">
      <div className="pa-agent-history-head">
        <strong>Chats</strong>
        <span>
          <button type="button" className="pa-agent-btn" onClick={onNew}>
            New chat
          </button>
          <button type="button" className="pa-agent-icon-btn" aria-label="Close chats" onClick={onClose}>
            ×
          </button>
        </span>
      </div>
      {!chats.length ? <p className="pa-agent-note">No saved chats yet.</p> : null}
      <ul className="pa-agent-history-list">
        {chats.map((c) => (
          <li key={c.id} className={c.id === currentId ? "pa-agent-current" : undefined}>
            <button type="button" className="pa-agent-history-open" onClick={() => onOpen(c.id)}>
              <span>{c.title || "New chat"}</span>
              <small>{new Date(c.updatedAt).toLocaleDateString()}</small>
            </button>
            {confirmId === c.id ? (
              <button
                type="button"
                className="pa-agent-btn pa-agent-danger"
                onClick={() => {
                  setConfirmId(null);
                  onDelete(c.id);
                }}
              >
                Delete?
              </button>
            ) : (
              <button type="button" className="pa-agent-icon-btn" aria-label={`Delete ${c.title}`} onClick={() => setConfirmId(c.id)}>
                🗑
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
