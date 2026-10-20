// Built-in view-only tools, added from the config: open a page, point at a control, play a
// guided walkthrough. They read nothing and write nothing; their whole output is UI actions.

import { coerceUiActions, isSafeNavigationPath, type UiActionRules } from "./actions.js";
import type { AgentConfig, AgentTool } from "./types.js";

export const OPEN_PAGE_TOOL = "open_page";
export const POINT_AT_TOOL = "point_at";
export const WALKTHROUGH_TOOL = "start_walkthrough";

export function builtinTools<C>(config: AgentConfig<C>, rules: UiActionRules): AgentTool<any, any, C>[] {
  const tools: AgentTool<any, any, C>[] = [];

  const pages = (config.pages ?? []).filter((p) => isSafeNavigationPath(p.path));
  if (pages.length) {
    tools.push({
      name: OPEN_PAGE_TOOL,
      description:
        "Open one of the app's pages for the user (only changes what they see). Pages: " +
        pages.map((p) => `${p.path} — ${p.title}${p.description ? ` (${p.description})` : ""}`).join("; ") +
        ".",
      parameters: {
        type: "object",
        properties: { path: { type: "string", enum: pages.map((p) => p.path), description: "Which page" } },
        required: ["path"],
      },
      run: ({ path }: { path: string }) => {
        const page = pages.find((p) => p.path === path);
        return page ? { ok: true, path: page.path, title: page.title } : { ok: false, error: "There is no such page." };
      },
      uiActions: (r: { path: string }) => [{ type: "navigate", to: r.path }],
      chain: true,
    });
  }

  const anchors = (config.anchors ?? []).map((a) => (typeof a === "string" ? { name: a } : a));
  if (anchors.length) {
    tools.push({
      name: POINT_AT_TOOL,
      description:
        "Point at a control on the current page with an on-screen ring and a short caption, when the user asks where something is. " +
        "Places: " +
        anchors.map((a) => `${a.name}${a.description ? ` (${a.description})` : ""}`).join("; ") +
        ". Only changes what they see.",
      parameters: {
        type: "object",
        properties: {
          anchor: { type: "string", enum: anchors.map((a) => a.name) },
          label: { type: "string", description: "Caption next to the ring, at most 10 words" },
          // Only a registered page: a free path could send the user to any GET route.
          ...(pages.length ? { path: { type: "string", enum: pages.map((p) => p.path), description: "The page it is on, if not the current one" } } : {}),
        },
        required: ["anchor"],
      },
      run: (args: { anchor: string; label?: string; path?: string }) => {
        if (args.path !== undefined && !pages.some((p) => p.path === args.path)) return { ok: false, error: "There is no such page." };
        return { ok: true, ...args };
      },
      uiActions: (r: { anchor: string; label?: string; path?: string }) => [
        ...(r.path && pages.some((p) => p.path === r.path) ? [{ type: "navigate" as const, to: r.path }] : []),
        { type: "highlight" as const, anchor: r.anchor, ...(r.label ? { label: r.label.slice(0, 120) } : {}) },
      ],
      chain: true,
    });
  }

  const tours = (config.walkthroughs ?? []).filter((w) => w.id && w.steps?.length);
  if (tours.length) {
    tools.push({
      name: WALKTHROUGH_TOOL,
      description:
        "Show the user how part of the app works by demonstrating it: opens the page, points at the controls and narrates each step. " +
        "Changes no data. Use it for 'show me how', 'give me a tour', 'I am new here'. Never instead of actually doing what the user asked. Tours: " +
        tours.map((w) => `${w.id} — ${w.title}: ${w.description}`).join("; ") +
        ".",
      parameters: {
        type: "object",
        properties: { id: { type: "string", enum: tours.map((w) => w.id) } },
        required: ["id"],
      },
      run: ({ id }: { id: string }) => {
        const tour = tours.find((w) => w.id === id);
        return tour ? { ok: true, id: tour.id, title: tour.title, steps: coerceUiActions(tour.steps, rules) } : { ok: false, error: "There is no such tour." };
      },
      render: (r: { ok?: boolean; title?: string; error?: string }) => (r.ok === false ? String(r.error) : `Here's a quick tour: **${r.title}**. Watch the page.`),
      uiActions: (r: { steps: unknown[] }) => coerceUiActions(r.steps, rules),
      uiActionMode: "guided",
    });
  }
  return tools;
}
