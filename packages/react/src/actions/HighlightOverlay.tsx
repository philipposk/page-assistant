"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { HighlightTarget } from "./runner.js";

/**
 * The ring the assistant draws around whatever it is talking about, with a caption and a dimmed
 * page around it. Deliberately non-interactive (`pointer-events: none`): a spotlight, not a
 * control. The user keeps full command of the page and can interrupt at any time.
 */
type Rect = { top: number; left: number; width: number; height: number };

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function HighlightOverlay({ target }: { target: HighlightTarget | null }) {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }
    let observer: ResizeObserver | null = null;
    let poll = 0;
    const stop = () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer?.disconnect();
      window.clearInterval(poll);
    };
    function update() {
      // The page moved on (a navigation re-rendered it): the element is gone, so is the ring.
      if (!target!.element.isConnected) {
        stop();
        setRect(null);
        return;
      }
      setRect(rectOf(target!.element));
    }
    update();
    if (!target.element.isConnected) return;
    // Follow the element while the page settles: scrolling, late rows, a resizing panel.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(target.element);
    poll = window.setInterval(update, 250);
    return stop;
  }, [target]);

  if (!target || !rect || typeof document === "undefined") return null;
  // Keep the caption on screen when the target sits near the top edge.
  const captionBelow = rect.top < 48;

  return createPortal(
    <div className="pa-agent-overlay" aria-hidden="true" data-testid="pa-highlight-overlay">
      <div
        className="pa-agent-ring"
        style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
      />
      {target.label ? (
        <div
          className="pa-agent-caption"
          style={{ top: captionBelow ? rect.top + rect.height + 12 : rect.top - 36, left: Math.max(8, rect.left) }}
        >
          {target.label}
        </div>
      ) : null}
    </div>,
    document.body
  );
}
