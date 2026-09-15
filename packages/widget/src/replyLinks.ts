// Assistant replies with links in them. The parser and the safety rule live in core
// (parseLinks, safeLinkHref); this builds the DOM for one reply and follows a click.
// Nodes are made with createElement/createTextNode and textContent only — reply text is
// never parsed as HTML.

import { parseLinks, safeLinkHref } from "@page-assistant/core";

export interface ReplyLinkOptions {
  /** Origins on which absolute http(s) links are allowed, besides same-origin paths. */
  linkOrigins?: string[];
  /** The host's navigation (an SPA router's push). Without it: `location.assign`. */
  onNavigate?: (href: string) => void | Promise<unknown>;
  /** Called after a link was followed in this page (not for new-tab clicks). */
  onFollowed?: (href: string) => void;
}

/** Append `text` to `parent`: plain text as text nodes, safe links as `<a>`, the rest as their label. */
export function renderReply(parent: HTMLElement, text: string, opts: ReplyLinkOptions = {}): void {
  const doc = parent.ownerDocument ?? document;
  const origin = typeof location !== "undefined" ? location.origin : undefined;
  for (const seg of parseLinks(text)) {
    if (seg.type === "text") {
      parent.appendChild(doc.createTextNode(seg.text));
      continue;
    }
    const href = safeLinkHref(seg.href, { origin, linkOrigins: opts.linkOrigins });
    if (!href) {
      parent.appendChild(doc.createTextNode(seg.label));
      continue;
    }
    const a = doc.createElement("a");
    a.href = href;
    a.textContent = seg.label;
    a.addEventListener("click", (e) => {
      // Cmd/Ctrl/Shift/middle click: the browser opens a new tab or window, as on any link.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      followLink(href, opts.onNavigate);
      opts.onFollowed?.(href);
    });
    parent.appendChild(a);
  }
}

/** Navigate with the host's handler; if it throws or rejects, do a normal page load. */
export function followLink(href: string, onNavigate?: (href: string) => void | Promise<unknown>): void {
  const load = () => window.location.assign(href);
  if (!onNavigate) return load();
  try {
    const r = onNavigate(href);
    if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch(load);
  } catch {
    load();
  }
}
