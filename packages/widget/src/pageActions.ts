import type { Capability, PageMap } from "@page-assistant/core";

/**
 * Built-in "blind mode" capabilities: real actions on any page using the scan map,
 * so the assistant can DO things even on apps that registered no custom capabilities.
 * Conservative by design — it only touches controls the scanner actually found.
 */
export function pageActionCapabilities(getMap: () => PageMap | undefined, rescan: () => Promise<PageMap>): Capability[] {
  return [
    {
      name: "open_page_link",
      description:
        "Navigate to a link or click a button that exists on the current page, identified by its visible label (from the page scan).",
      tags: ["page"],
      confirm: true,
      parameters: {
        type: "object",
        properties: { label: { type: "string", description: "Visible text of the link/button, e.g. 'Pricing' or 'Sign in'." } },
        required: ["label"],
      },
      run: ({ label }: { label: string }) => {
        const map = getMap();
        if (!map) throw new Error("The page hasn't been scanned yet.");
        const want = label.trim().toLowerCase();
        const exact = map.controls.filter((c) => c.label.trim().toLowerCase() === want);
        if (exact.length > 1) {
          throw new Error(`Multiple controls match "${label}" — be more specific.`);
        }
        const hit = exact[0];
        if (!hit) {
          throw new Error(`No link or button labelled "${label}" on this page.`);
        }
        const el = document.querySelector(hit.selector) as HTMLElement | null;
        if (!el) throw new Error(`"${hit.label}" was on the page at scan time but is gone now.`);
        el.click();
        return { clicked: hit.label, kind: hit.kind };
      },
      render: (r: any) => `Opened "${r.clicked}".`,
    },
    {
      name: "rescan_page",
      description: "Re-read the current page (after navigation or when content changed) and refresh the map of links, buttons and inputs.",
      tags: ["page"],
      parameters: { type: "object", properties: {} },
      run: async () => {
        const map = await rescan();
        return { pages: map.pages.length, controls: map.controls.length };
      },
      render: (r: any) => `Re-read the page: ${r.pages} pages, ${r.controls} interactive controls mapped.`,
    },
  ];
}
