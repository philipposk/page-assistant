// Conversation + appearance preferences (localStorage).

import { MODEL_CATALOG, type CatalogModel } from "@page-assistant/core";

export const ASSISTANT_SETTINGS_STORAGE_KEY = "page_assistant_settings";
export const ASSISTANT_SETTINGS_CHANGE_EVENT = "page-assistant-settings-change";

export type ThemeMode = "dark" | "light" | "system";

export interface AssistantSettings {
  /**
   * LLM model id passed to the server proxy, or "" to send no override at all and let the
   * server use whatever it is configured with. "" is the default: the widget has no way to
   * know which provider keys a server holds, and naming a model it cannot serve is a hard
   * error at send time.
   */
  model: string;
  theme: ThemeMode;
  /** Show chat sidebar by default when panel opens. */
  sidebarOpen: boolean;
  /** Send anonymous usage events to host analytics endpoint. */
  analyticsEnabled: boolean;
}

/**
 * Models offered in the picker, most capable first: core's MODEL_CATALOG, the one list of
 * model ids (checked weekly against the providers, so a retired id doesn't linger here).
 *
 * A server only serves a model it has the matching key for, so this list is a fallback:
 * `GET /v1/models` reports what the server can actually do and the picker prefers that.
 */
export const DEFAULT_MODELS: readonly CatalogModel[] = MODEL_CATALOG;

const DEFAULTS: AssistantSettings = {
  // "" = send no model override; the server picks. Previously "gpt-4o-mini", which meant
  // every widget named an OpenAI model even on an Anthropic-only server, and the router
  // rejects a model it has no key for.
  model: "",
  theme: "dark",
  sidebarOpen: true,
  analyticsEnabled: false,
};

export function getAssistantSettings(storageKey = ASSISTANT_SETTINGS_STORAGE_KEY): AssistantSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(storageKey) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setAssistantSettings(
  patch: Partial<AssistantSettings>,
  storageKey = ASSISTANT_SETTINGS_STORAGE_KEY
): AssistantSettings {
  const next = { ...getAssistantSettings(storageKey), ...patch };
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(storageKey, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(ASSISTANT_SETTINGS_CHANGE_EVENT, { detail: next }));
  }
  return next;
}
