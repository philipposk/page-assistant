// The view-only UI action contract.
//
// An action may navigate, narrate, highlight a registered anchor, wait, or do something the
// host registered (select rows, open a panel). None can change data: every change goes
// through a real tool that runs as the signed-in user. That split is what makes it safe to
// let the model drive the browser during a guided walkthrough.
//
// `highlight` takes an anchor NAME, never a CSS selector: the client resolves it only
// against elements that opted in with `data-pa-anchor`, so the model can only point at
// places the UI deliberately exposed.

import { stripUnknownKeys, validateArgs } from "@page-assistant/core";
import { schemaProblem } from "./schema.js";
import type { CustomUiActionSpec, UiAction } from "./types.js";

const ANCHOR_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ACTION_TYPE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const BUILTIN = new Set(["navigate", "narrate", "highlight", "wait"]);
/** Most actions one turn may carry. */
export const MAX_UI_ACTIONS = 40;

/** True when the string contains a C0 control character or DEL. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Only same-app absolute paths: the path comes from a model turn, and nothing should be able
 * to talk the app into sending a user off-site. The React runner checks the same rule again.
 */
export function isSafeInAppPath(to: unknown): to is string {
  if (typeof to !== "string") return false;
  const path = to.trim();
  if (!path.startsWith("/")) return false; // no absolute URLs, no relative escapes
  if (path.startsWith("//")) return false; // protocol-relative resolves off-site
  // Browsers read a backslash as "/" in http URLs, so "/\host" is "//host".
  if (path.includes("\\")) return false;
  if (hasControlChars(path)) return false;
  if (/^\/*[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.length <= 2048;
}

const NAV_BASE = "http://in-app.invalid";

/**
 * A `navigate` target, normalised, or null when it may not be followed. Navigation happens
 * without a click, so it must never land on a GET with side effects: an API route or a
 * sign-out. The path is resolved first (`/notes/../api/x`, `/./logout`, `/%2e/api/x` all point
 * somewhere else than they read), and the result is what gets followed.
 */
export function normalizeNavigationPath(to: unknown): string | null {
  if (!isSafeInAppPath(to)) return null;
  let url: URL;
  try {
    url = new URL(to.trim(), NAV_BASE);
  } catch {
    return null;
  }
  if (url.origin !== NAV_BASE) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return null;
  }
  // An encoded slash or dot segment that only a decoding server would resolve.
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded) || decoded.includes("\\")) return null;
  if (/^\/+api(?:\/|$)/.test(decoded)) return null;
  if (/(?:^|\/)(?:sign[-_]?out|log[-_]?out|log[-_]?off|sign[-_]?off)(?:\/|$|\.)/.test(decoded)) return null;
  return url.pathname + url.search + url.hash;
}

export function isSafeNavigationPath(to: unknown): to is string {
  return normalizeNavigationPath(to) !== null;
}

export interface UiActionRules {
  /** Allowed anchor names; undefined = any well-formed name. */
  anchors?: ReadonlySet<string>;
  custom?: Record<string, CustomUiActionSpec>;
}

/**
 * Loose tool output → validated UI actions. Anything malformed or of an unknown type is
 * dropped: a bad action must never fail a turn that otherwise produced a good answer.
 */
export function coerceUiActions(raw: unknown, rules: UiActionRules = {}): UiAction[] {
  const out: UiAction[] = [];
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const item of items) {
    if (out.length >= MAX_UI_ACTIONS) break;
    const action = coerceOne(item, rules);
    if (action) out.push(action);
  }
  return out;
}

function coerceOne(item: unknown, rules: UiActionRules): UiAction | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const a = item as Record<string, unknown>;
  const type = typeof a.type === "string" ? a.type : "";
  switch (type) {
    case "navigate":
      {
        const to = normalizeNavigationPath(a.to);
        return to ? { type, to } : null;
      }
    case "narrate": {
      if (typeof a.text !== "string" || !a.text.trim()) return null;
      const action: UiAction = { type, text: a.text.slice(0, 2000) };
      if (a.speak === true) action.speak = true;
      return action;
    }
    case "highlight": {
      if (typeof a.anchor !== "string" || !ANCHOR_NAME_RE.test(a.anchor)) return null;
      if (rules.anchors && !rules.anchors.has(a.anchor)) return null;
      const action: UiAction = { type, anchor: a.anchor };
      if (typeof a.label === "string" && a.label.trim()) action.label = a.label.slice(0, 120);
      return action;
    }
    case "wait": {
      const ms = typeof a.ms === "number" && Number.isFinite(a.ms) ? Math.round(a.ms) : 800;
      return { type, ms: Math.min(Math.max(ms, 0), 10_000) };
    }
    default: {
      const spec = rules.custom?.[type];
      if (!spec || BUILTIN.has(type) || !ACTION_TYPE_RE.test(type)) return null;
      const { type: _t, ...fields } = a;
      const clean = stripUnknownKeys(fields, spec.schema as { properties?: Record<string, unknown> });
      if (validateArgs(clean, spec.schema) || schemaProblem(clean, spec.schema)) return null;
      return { ...clean, type };
    }
  }
}

/** Whether a custom action name can be registered. */
export function customActionProblems(custom: Record<string, CustomUiActionSpec> | undefined): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(custom ?? {})) {
    if (BUILTIN.has(name)) problems.push(`uiActions.${name}: "${name}" is a built-in action.`);
    else if (!ACTION_TYPE_RE.test(name)) problems.push(`uiActions.${name}: names are lower snake_case, 1-40 chars.`);
    if (!spec?.schema || spec.schema.type !== "object") problems.push(`uiActions.${name}: schema must be { type: "object", ... }.`);
  }
  return problems;
}

export { ANCHOR_NAME_RE };
