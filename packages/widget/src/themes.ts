import type { ThemeMode } from "./assistant-settings.js";

export const THEME_VARS: Record<Exclude<ThemeMode, "system">, Record<string, string>> = {
  dark: {
    "--pa-bg": "#0f1715",
    "--pa-bg-head": "#12211a",
    "--pa-bg-sidebar": "#0b1310",
    "--pa-bg-input": "#0b1310",
    "--pa-bg-msg-user": "#1f6f43",
    "--pa-bg-msg-asst": "#1a2a22",
    "--pa-text": "#e7f5ec",
    "--pa-text-muted": "#9ab4a6",
    "--pa-border": "#1f3a2c",
    "--pa-accent": "#16a34a",
    "--pa-launcher-from": "#5eead4",
    "--pa-launcher-to": "#0d9488",
  },
  light: {
    "--pa-bg": "#ffffff",
    "--pa-bg-head": "#f4f7f5",
    "--pa-bg-sidebar": "#f0f4f2",
    "--pa-bg-input": "#ffffff",
    "--pa-bg-msg-user": "#059669",
    "--pa-bg-msg-asst": "#f0fdf4",
    "--pa-text": "#0f172a",
    "--pa-text-muted": "#64748b",
    "--pa-border": "#e2e8f0",
    "--pa-accent": "#059669",
    "--pa-launcher-from": "#34d399",
    "--pa-launcher-to": "#059669",
  },
};

export function resolveTheme(mode: ThemeMode): Exclude<ThemeMode, "system"> {
  if (mode === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  if (mode === "light") return "light";
  return "dark";
}

export function themeCssVars(mode: ThemeMode): string {
  const resolved = resolveTheme(mode);
  const vars = THEME_VARS[resolved];
  return Object.entries(vars)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}
