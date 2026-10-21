// Runs the assistant's UI actions. Plain functions (no React), so the rules are testable.
//
// Two modes:
//  - "immediate" applies everything at once: a normal answer ("show my overdue items" →
//    navigate and done).
//  - "guided" plays the beats in order with the pointer ring and narration, so the user
//    watches the product being operated instead of reading about it (walkthroughs).
//
// Nothing here can change data: the vocabulary is view-only by construction, and every change
// goes through a server tool that runs as the user. The worst a bad action can do is point at
// the wrong box.

import type { UiAction, UiActionMode } from "../protocol.js";
import { waitForAnchor as defaultWaitForAnchor } from "./anchors.js";
import { dropPendingPaAction, emitPaAction } from "./events.js";
import { normalizeNavigationPath } from "./safeNavigate.js";

export interface HighlightTarget {
  element: HTMLElement;
  label?: string | null;
}

/** A host handler for a custom action type. Gets the whole action. */
export type UiActionHandler = (action: UiAction) => void | Promise<void>;

export interface ActionRunnerDeps {
  navigate: (path: string) => void;
  /** A narration beat: show it as its own bubble, and speak it when `speak` and voice is on. */
  narrate: (text: string, speak: boolean) => void;
  setHighlight: (target: HighlightTarget | null) => void;
  setRunning?: (running: boolean) => void;
  /** Custom action handlers by type. A type without one is emitted on the event bus (usePaAction). */
  handlers?: Record<string, UiActionHandler>;
  waitForAnchor?: (name: string, timeoutMs: number) => Promise<HTMLElement | null>;
  emit?: (type: string, detail: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between guided beats when the script has no explicit wait. Default 450 ms. */
  beatMs?: number;
  /** How long the last ring stays up after a run (guided or not). Default 2500 ms. */
  lingerMs?: number;
}

export interface ActionRunner {
  run(actions: UiAction[] | undefined, mode?: UiActionMode): Promise<void>;
  /** Stop a running walkthrough, clear the ring, and drop actions still waiting for their page. */
  cancel(): void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createActionRunner(deps: ActionRunnerDeps): ActionRunner {
  const sleep = deps.sleep ?? defaultSleep;
  const wait = deps.waitForAnchor ?? defaultWaitForAnchor;
  const emit = deps.emit ?? ((type: string, detail: unknown) => emitPaAction(type, detail));
  // Bumping this cancels an in-flight sequence: each beat checks its run is still current.
  let runId = 0;
  // Whether the current run put a ring up, so a run that never did has nothing to clear later.
  let lit = false;
  // What this runner put on the event bus. Cancelling drops only these, never another
  // component's buffered action.
  let owned: Array<{ type: string; detail: unknown }> = [];

  async function applyOne(action: UiAction, guided: boolean): Promise<void> {
    switch (action.type) {
      case "navigate": {
        // Follow the resolved path, not the text the model wrote.
        const to = normalizeNavigationPath((action as { to?: unknown }).to);
        if (to) deps.navigate(to);
        return;
      }
      case "narrate": {
        const a = action as { text?: unknown; speak?: unknown };
        if (typeof a.text === "string" && a.text.trim()) deps.narrate(a.text, a.speak === true);
        return;
      }
      case "highlight": {
        const a = action as { anchor?: unknown; label?: unknown };
        if (typeof a.anchor !== "string") return;
        const el = await wait(a.anchor, guided ? 3000 : 500);
        if (!el) {
          // Not on this page (wrong route, or the section did not render): skip the beat.
          deps.setHighlight(null);
          return;
        }
        try {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        } catch {
          /* old engines */
        }
        lit = true;
        deps.setHighlight({ element: el, label: typeof a.label === "string" ? a.label : null });
        return;
      }
      case "wait": {
        const ms = Number((action as { ms?: unknown }).ms ?? 0);
        if (guided) await sleep(Math.min(Math.max(Number.isFinite(ms) ? ms : 0, 0), 10_000));
        return;
      }
      default: {
        const handler = deps.handlers?.[action.type];
        if (handler) {
          await handler(action);
          return;
        }
        const { type, ...detail } = action;
        owned = [...owned.slice(-49), { type, detail }];
        emit(type, detail);
      }
    }
  }

  return {
    async run(actions, mode = "immediate") {
      if (!actions?.length) return;
      const guided = mode === "guided";
      const mine = ++runId;
      // A new answer starts with a clean page: the last ring is about the last answer.
      lit = false;
      deps.setHighlight(null);
      // The ring a run leaves behind fades after a moment, so it never outstays the answer.
      const fade = () => {
        if (!lit) return;
        setTimeout(() => {
          if (runId === mine) deps.setHighlight(null);
        }, deps.lingerMs ?? 2500);
      };
      if (!guided) {
        for (const action of actions) {
          if (runId !== mine) return;
          try {
            await applyOne(action, false);
          } catch {
            /* one bad action never stops the rest */
          }
        }
        if (runId === mine) fade();
        return;
      }
      deps.setRunning?.(true);
      try {
        for (const action of actions) {
          if (runId !== mine) return; // superseded or cancelled
          try {
            await applyOne(action, true);
          } catch {
            /* skip the beat */
          }
          if (action.type !== "wait" && action.type !== "narrate") await sleep(deps.beatMs ?? 450);
        }
      } finally {
        if (runId === mine) {
          deps.setRunning?.(false);
          fade();
        }
      }
    },
    cancel() {
      runId++;
      deps.setHighlight(null);
      deps.setRunning?.(false);
      for (const o of owned) dropPendingPaAction(o.type, o.detail);
      owned = [];
    },
  };
}
