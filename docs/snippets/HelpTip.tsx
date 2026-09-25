/**
 * Copy into your React host app. Requires `help-tip.css` (map variables to your theme).
 * Renders the panel in a document portal with fixed positioning so tips near the top
 * of the page are not clipped.
 */
"use client";

import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const GAP = 6;
const VIEWPORT_PAD = 8;

export function HelpTip({ text }: { text: string }) {
  const id = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  const reposition = useCallback(() => {
    const btn = btnRef.current;
    const panel = panelRef.current;
    if (!btn || !panel) return;

    const rect = btn.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;

    let top = rect.bottom + GAP;
    const spaceBelow = window.innerHeight - rect.bottom - GAP;
    const spaceAbove = rect.top - GAP;
    if (ph > spaceBelow && spaceAbove >= ph) top = rect.top - ph - GAP;
    else if (ph > spaceBelow && spaceAbove < ph) top = VIEWPORT_PAD;

    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - pw - VIEWPORT_PAD));

    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onMove = () => reposition();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, text, reposition]);

  const show = () => {
    const btn = btnRef.current;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      setCoords({ top: rect.bottom + GAP, left: Math.max(VIEWPORT_PAD, rect.left) });
    }
    setOpen(true);
  };
  const hide = () => setOpen(false);

  return (
    <span className="help-tip">
      <button
        ref={btnRef}
        type="button"
        className="help-tip-btn"
        aria-describedby={open ? id : undefined}
        tabIndex={0}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open
        ? createPortal(
            <span
              ref={panelRef}
              id={id}
              role="tooltip"
              className="help-tip-panel help-tip-panel--open"
              style={{ top: coords.top, left: coords.left }}
            >
              {text}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

export function FieldLabel({
  htmlFor,
  children,
  tip,
}: {
  htmlFor?: string;
  children: ReactNode;
  tip?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="field-label-with-tip">
      {children}
      {tip ? <HelpTip text={tip} /> : null}
    </label>
  );
}
