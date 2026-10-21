"use client";

// Cross-component bus for the assistant's custom UI actions (select rows, open a panel...).
//
// Window CustomEvents, so the page component that owns the state listens without a store.
// Every event is view-only: it changes what is shown, never the data.
//
// REPLAY — what a plain CustomEvent cannot do. These actions almost always follow a
// `navigate`, and the destination route has not mounted its listener when the next beat
// fires. A dispatch into an empty room is lost silently ("nothing happens"). So the last
// emission of each event is kept briefly, and a listener mounting inside that window picks it
// up. It is cleared the moment any listener handles it, so a remount never replays something
// already acted on.

import { useEffect, useRef } from "react";

/** Long enough for a route change plus its first render; short enough never to surprise. */
export const REPLAY_WINDOW_MS = 5000;

const pending = new Map<string, { detail: unknown; at: number }>();

export function paEventName(type: string): string {
  return `pa:${type}`;
}

/** Emit a UI action to whatever page component listens for `type`. */
export function emitPaAction<T = unknown>(type: string, detail: T, now: number = Date.now()): void {
  pending.set(type, { detail, at: now });
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<T>(paEventName(type), { detail }));
}

/** Drop every buffered action without running it. */
export function clearPendingPaActions(): void {
  pending.clear();
}

/**
 * Drop one buffered action, only if it is still the very emission `detail` came from. A
 * cancelled walkthrough drops what it emitted and leaves anything else on the bus alone.
 */
export function dropPendingPaAction(type: string, detail: unknown): void {
  if (pending.get(type)?.detail === detail) pending.delete(type);
}

/**
 * Subscribe outside React. Returns the unsubscribe. A recent unhandled emission is delivered
 * at once.
 */
export function onPaAction<T = unknown>(type: string, handler: (detail: T) => void, now: () => number = Date.now): () => void {
  const run = (detail: T) => {
    pending.delete(type); // handled — never replay it to a later mount
    handler(detail);
  };
  const onEvent = (e: Event) => run((e as CustomEvent<T>).detail);
  if (typeof window !== "undefined") window.addEventListener(paEventName(type), onEvent);
  const buffered = pending.get(type);
  if (buffered) {
    if (now() - buffered.at <= REPLAY_WINDOW_MS) run(buffered.detail as T);
    else pending.delete(type);
  }
  return () => {
    if (typeof window !== "undefined") window.removeEventListener(paEventName(type), onEvent);
  };
}

/**
 * React hook: run `handler` for each `type` action, including one emitted just before this
 * component mounted (after a navigate). The handler is read from a ref, so an inline closure
 * does not re-subscribe (which would replay the action again on every render).
 *
 *   usePaAction<{ ids: string[] }>("select_rows", ({ ids }) => setSelected(ids));
 */
export function usePaAction<T = unknown>(type: string, handler: (detail: T) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onPaAction<T>(type, (d) => ref.current(d)), [type]);
}
