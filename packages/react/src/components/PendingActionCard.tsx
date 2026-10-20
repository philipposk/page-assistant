"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PendingActionCard as Card } from "../protocol.js";

/**
 * The confirm card. Nothing has run yet when it shows: the button confirms, typing in chat
 * never does. Generic on purpose — it never looks at `action.tool` — so a tool the server adds
 * tomorrow renders with no change here. Every detail line is plain text (never markdown or
 * HTML), and a long list scrolls inside the card.
 */

// setTimeout keeps its delay in a signed 32-bit int; a longer one fires at once.
const MAX_TIMER_MS = 2_147_483_647;
/** How long a card lives on the server by default. */
export const CARD_TTL_MS = 10 * 60 * 1000;

/** Parse expiresAt; a string without a zone is read as UTC. Invalid → NaN. */
export function expiryTime(expiresAt: string): number {
  let iso = String(expiresAt ?? "").trim();
  if (iso && !iso.includes("T")) iso = iso.replace(" ", "T");
  if (iso.includes("T") && !/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(iso.slice(iso.indexOf("T") + 1))) iso += "Z";
  return new Date(iso.replace(/(\.\d{3})\d+/, "$1")).getTime();
}

/** Expired at `now`? An unreadable time is NOT expired: the server decides on Confirm. */
export function hasExpired(expiresAt: string, now: number = Date.now()): boolean {
  const at = expiryTime(expiresAt);
  return !Number.isNaN(at) && now >= at;
}

/**
 * A card that already reads as expired when it arrives means this browser's clock runs ahead of
 * the server's, not that the token lapsed (it was issued a moment ago). Give it a local expiry
 * of arrival + TTL instead of locking the user out; the server still decides on Confirm.
 */
export function cardOnArrival(card: Card, now: number = Date.now()): Card {
  return hasExpired(card.expiresAt, now) ? { ...card, expiresAt: new Date(now + CARD_TTL_MS).toISOString() } : card;
}

export interface PendingActionCardProps {
  action: Card;
  /** May return a promise; the button stays disabled while it runs, so a double click confirms once. */
  onConfirm: () => void | Promise<void>;
  onDismiss: () => void;
  /** A turn or a confirm is in flight. */
  loading?: boolean;
}

export function PendingActionCard({ action, onConfirm, onDismiss, loading = false }: PendingActionCardProps) {
  const titleId = useId();
  const [expired, setExpired] = useState(() => hasExpired(action.expiresAt));
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guard: state is not updated until the next render, and a second click can land first.
  const inFlight = useRef(false);

  useEffect(() => {
    const at = expiryTime(action.expiresAt);
    if (Number.isNaN(at)) return setExpired(false);
    const remaining = at - Date.now();
    if (remaining <= 0) return setExpired(true);
    setExpired(false);
    if (remaining > MAX_TIMER_MS) return;
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [action.expiresAt, action.token]);

  const busy = loading || submitting;
  const handleConfirm = async () => {
    if (inFlight.current || busy || expired) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      await onConfirm();
    } catch {
      // The parent shows the failure; the card must not stay stuck.
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };
  const details = Array.isArray(action.details) ? action.details : [];

  return (
    <div role="group" aria-labelledby={titleId} className="pa-agent-card">
      <p id={titleId} className="pa-agent-card-title">
        {action.title}
      </p>
      {details.length > 0 && (
        <ul tabIndex={0} aria-label="Details" className="pa-agent-card-details">
          {details.map((line, i) => (
            <li key={i}>{String(line)}</li>
          ))}
        </ul>
      )}
      {expired && (
        <p role="status" className="pa-agent-card-expired">
          This confirmation has expired. Ask again to get a new one.
        </p>
      )}
      <div className="pa-agent-card-buttons">
        <button type="button" className="pa-agent-btn pa-agent-btn-primary" disabled={busy || expired} onClick={() => void handleConfirm()}>
          {action.confirmLabel || "Confirm"}
        </button>
        <button type="button" className="pa-agent-btn" disabled={busy} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <p className="pa-agent-card-hint">Typing in chat does not confirm — use this button.</p>
    </div>
  );
}
