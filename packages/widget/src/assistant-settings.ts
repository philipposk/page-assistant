// Conversation + appearance preferences (localStorage).

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
 * Models offered in the picker, newest and most capable first.
 *
 * Model ids are exact and carry NO date suffix — `claude-haiku-4-5`, not
 * `claude-haiku-4-5-20251001`. The previous list had drifted: Claude Sonnet 4 and Claude
 * 3.5 Haiku are superseded, and the whole Claude 5 family was missing.
 *
 * A server only serves a model it has the matching key for, so this list is a fallback:
 * `GET /v1/models` reports what the server can actually do and the picker prefers that.
 */
export const DEFAULT_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5 (most capable)", provider: "anthropic" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (balanced)", provider: "anthropic" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fast)", provider: "anthropic" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (deep reasoning)", provider: "anthropic" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini (fast)", provider: "openai" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (OpenRouter)", provider: "openrouter" },
] as const;

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
