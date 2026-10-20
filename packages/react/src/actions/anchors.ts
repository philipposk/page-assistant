// Places the assistant may point at.
//
// The assistant never sends a CSS selector. It sends an anchor NAME, resolved only against
// elements that opted in with `data-pa-anchor`. So the model can only highlight places the UI
// deliberately exposed, and markup changes can never hand it something it was not meant to touch.

const ANCHOR_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Spread onto any element the assistant may highlight:
 *   <button {...paAnchor("items.add")}>Add</button>
 * List the same names in the server's `anchors` option so the model knows them.
 */
export function paAnchor(name: string): { "data-pa-anchor": string } {
  return { "data-pa-anchor": name };
}

export function isAnchorName(name: unknown): name is string {
  return typeof name === "string" && ANCHOR_NAME_RE.test(name);
}

/** The live element for an anchor, or null when it is not on this page. */
export function resolveAnchor(name: string, root: ParentNode | null = typeof document !== "undefined" ? document : null): HTMLElement | null {
  if (!root || !isAnchorName(name)) return null;
  // The name is checked above, so it cannot break out of the attribute selector.
  return root.querySelector<HTMLElement>(`[data-pa-anchor="${name}"]`);
}

/**
 * Wait for an anchor to appear — a highlight usually follows a navigate and the destination
 * has not rendered yet. Resolves null on timeout so the runner skips the beat instead of hanging.
 */
export function waitForAnchor(name: string, timeoutMs = 3000): Promise<HTMLElement | null> {
  const existing = resolveAnchor(name);
  if (existing || !isAnchorName(name) || typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (el: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    };
    const observer = new MutationObserver(() => {
      const el = resolveAnchor(name);
      if (el) finish(el);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-pa-anchor"] });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
