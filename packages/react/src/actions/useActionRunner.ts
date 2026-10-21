"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { UiAction, UiActionMode } from "../protocol.js";
import { createActionRunner, type HighlightTarget, type UiActionHandler } from "./runner.js";
import { isSafeNavigationPath } from "./safeNavigate.js";

export interface UseActionRunnerOptions {
  /** Your router's push (Next.js: `router.push`). Default: a full page load. */
  navigate?: (path: string) => void;
  onNarrate: (text: string, speak: boolean) => void;
  /** Custom action handlers by type; others go to the event bus (usePaAction). */
  handlers?: Record<string, UiActionHandler>;
}

/** The action runner as a hook: `run`, `cancel`, the current ring, and whether a tour is playing. */
export function useActionRunner(opts: UseActionRunnerOptions) {
  const [highlight, setHighlight] = useState<HighlightTarget | null>(null);
  const [running, setRunning] = useState(false);
  // Latest callbacks through a ref, so the runner (and a playing tour) survives re-renders.
  const ref = useRef(opts);
  ref.current = opts;

  const runner = useMemo(
    () =>
      createActionRunner({
        navigate: (path) => {
          const nav = ref.current.navigate;
          if (nav) nav(path);
          else if (typeof window !== "undefined" && isSafeNavigationPath(path)) window.location.assign(path);
        },
        narrate: (text, speak) => ref.current.onNarrate(text, speak),
        setHighlight,
        setRunning,
        handlers: new Proxy({} as Record<string, UiActionHandler>, {
          get: (_t, key: string) => ref.current.handlers?.[key],
        }),
      }),
    []
  );

  useEffect(() => () => runner.cancel(), [runner]);

  return {
    run: (actions: UiAction[] | undefined, mode?: UiActionMode) => runner.run(actions, mode),
    cancel: () => runner.cancel(),
    highlight,
    running,
  };
}
