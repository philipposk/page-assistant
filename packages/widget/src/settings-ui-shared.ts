// Shared CSS for settings panels (voice + assistant).
//
// These panels live in their OWN shadow roots, appended to document.body — not inside the
// widget's. They therefore need their own copy of the theme variables: the widget's
// `:host` block does not reach them. They used to sidestep that by hardcoding the dark
// palette (#e7f5ec on #0b1310, #244234 borders), which meant a light-themed app opened a
// black-green modal, and a host that set `theme: "light"` got one anyway.

import type { ThemeMode } from "./assistant-settings.js";
import { resolveTheme, themeCssVars } from "./themes.js";

export const CSS = `
* { box-sizing: border-box; font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; }
.wrap { color: var(--pa-text); font-size: 14px; line-height: 1.45; }
.hint { margin: 0 0 14px; font-size: 13px; color: var(--pa-text-muted); }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.label { width: 140px; flex-shrink: 0; color: var(--pa-text-muted); font-size: 13px; }
.field { flex: 1; min-width: 180px; }
select, label.field { display: block; width: 100%; max-width: 320px; }
select {
  background: var(--pa-bg-input); border: 1px solid var(--pa-border); color: var(--pa-text);
  border-radius: 8px; padding: 8px 10px; font-size: 14px;
}
.check { display: flex; align-items: center; gap: 8px; cursor: pointer; max-width: 320px; color: var(--pa-text); }
.modal-backdrop {
  position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.55);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.modal {
  width: min(520px, 100%); max-height: 90vh; overflow: auto;
  background: var(--pa-bg); border: 1px solid var(--pa-border); color: var(--pa-text);
  border-radius: 16px; padding: 18px 20px; box-shadow: 0 20px 60px rgba(0,0,0,.5);
}
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.modal-head h2 { margin: 0; font-size: 18px; font-weight: 600; color: var(--pa-text); }
.modal-foot { margin-top: 16px; display: flex; justify-content: flex-end; gap: 10px; align-items: center; }
.btn {
  border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 14px; font-weight: 500;
}
.btn-ghost { background: transparent; color: var(--pa-text-muted); }
.btn-ghost:hover { color: var(--pa-text); }
.btn-primary { background: var(--pa-accent); color: #fff; }
.btn-primary:hover { background: var(--pa-accent-hover); }
.link { color: var(--pa-text-muted); font-size: 13px; text-decoration: none; }
.link:hover { color: var(--pa-text); }
`;

/**
 * Full stylesheet for a settings shadow root, themed.
 *
 * `color-scheme` matters as much as the variables: without it the native `<select>` popup,
 * the checkbox and the focus ring keep the OS default appearance, so a dark modal renders
 * white dropdowns over dark rows.
 */
export function panelStyle(theme: ThemeMode, extra = ""): string {
  return `:host { ${themeCssVars(theme)}; color-scheme: ${resolveTheme(theme)}; } ${CSS}${extra}`;
}
