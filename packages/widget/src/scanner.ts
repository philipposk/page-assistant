import type { PageMap } from "@page-assistant/core";

/**
 * Read the current page: collect headings, links, and interactive controls with stable
 * selectors. This is the "blind" mode that lets the assistant understand an app it was
 * not explicitly integrated into. Integrated hosts also benefit: scan output seeds the
 * model's understanding of what's clickable.
 */
export function scanPage(doc: Document = document): PageMap["controls"] {
  const controls: PageMap["controls"] = [];
  const push = (kind: PageMap["controls"][number]["kind"], el: Element, label: string) => {
    const text = label.trim().slice(0, 80);
    if (text) controls.push({ kind, label: text, selector: cssPath(el) });
  };
  doc.querySelectorAll("a[href]").forEach((el) => push("link", el, el.textContent || el.getAttribute("aria-label") || ""));
  doc.querySelectorAll("button, [role=button]").forEach((el) => push("button", el, el.textContent || el.getAttribute("aria-label") || ""));
  doc.querySelectorAll("input, textarea").forEach((el) => {
    const i = el as HTMLInputElement;
    push("input", el, i.getAttribute("aria-label") || i.placeholder || i.name || i.type || "");
  });
  doc.querySelectorAll("select").forEach((el) => push("select", el, el.getAttribute("aria-label") || (el as HTMLSelectElement).name || ""));
  // de-dupe by label+kind
  const seen = new Set<string>();
  return controls.filter((c) => {
    const k = `${c.kind}:${c.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 60);
}

/** A first-visit full scan: this page plus same-origin nav links (one level deep). */
export async function fullScan(doc: Document = document, maxPages = 6): Promise<PageMap> {
  const here = {
    url: location.href,
    title: doc.title,
    headings: [...doc.querySelectorAll("h1, h2")].map((h) => (h.textContent || "").trim()).filter(Boolean).slice(0, 20),
    links: [...doc.querySelectorAll("a[href]")]
      .map((a) => ({ text: (a.textContent || "").trim(), href: (a as HTMLAnchorElement).href }))
      .filter((l) => l.text && sameOrigin(l.href))
      .slice(0, 40),
  };
  const pages: PageMap["pages"] = [here];
  // Fetch a few same-origin pages and extract their headings (best-effort, CORS-safe same-origin).
  const targets = dedupe(here.links.map((l) => l.href)).filter((u) => u !== location.href).slice(0, maxPages - 1);
  await Promise.all(
    targets.map(async (url) => {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        const html = await res.text();
        const d = new DOMParser().parseFromString(html, "text/html");
        pages.push({
          url,
          title: d.title,
          headings: [...d.querySelectorAll("h1, h2")].map((h) => (h.textContent || "").trim()).filter(Boolean).slice(0, 15),
          links: [],
        });
      } catch {
        /* ignore unreachable pages */
      }
    })
  );
  return { scannedAt: new Date().toISOString(), pages, controls: scanPage(doc) };
}

function sameOrigin(href: string): boolean {
  try {
    return new URL(href, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function dedupe(a: string[]): string[] {
  return [...new Set(a)];
}

/** A reasonably stable CSS selector for an element (id → data-testid → nth-of-type path). */
function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testid = el.getAttribute("data-testid");
  if (testid) return `[data-testid="${testid}"]`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    let sel = node.nodeName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.nodeName === node!.nodeName);
      if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    parts.unshift(sel);
    node = node.parentElement;
  }
  return parts.join(" > ");
}
