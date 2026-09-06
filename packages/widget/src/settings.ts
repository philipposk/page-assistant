// Voice / read-aloud preferences stored in localStorage (host can override the key).

import type { VoiceOptions } from "./voice.js";

export type TtsMode = "browser" | "server";
export type TtsProvider = "elevenlabs" | "openai";
export type SttMode = "browser" | "server";

export type VoiceSettings = {
  /** When true, assistant reads replies aloud. Off by default (text only, free). */
  autoSpeak: boolean;
  ttsMode: TtsMode;
  ttsProvider: TtsProvider;
  elevenLabsVoiceId: string;
  openaiVoice: string;
  /** Mic input: browser SpeechRecognition (free) or server Whisper (paid). */
  sttMode: SttMode;
};

export const VOICE_SETTINGS_STORAGE_KEY = "page_assistant_voice_settings";
export const VOICE_SETTINGS_CHANGE_EVENT = "pa-voice-settings-change";

/**
 * What the server can actually do, reported by `GET {serverUrl}/v1/voice/capabilities`.
 * Lets the settings UI grey out options the server has no key for, so the user never
 * picks "Rachel" and silently hears the robotic browser voice.
 */
export type VoiceCapabilities = {
  tts: { server: boolean; providers: TtsProvider[] };
  stt: { server: boolean };
};

/** Assume browser-only when the endpoint is missing or unreachable — never crash. */
export const BROWSER_ONLY_CAPABILITIES: VoiceCapabilities = {
  tts: { server: false, providers: [] },
  stt: { server: false },
};

/**
 * Fetch server voice capabilities. Degrades gracefully: any failure (404, network,
 * bad JSON) resolves to browser-only rather than rejecting, so callers never need a
 * try/catch and the UI still renders.
 */
export async function fetchVoiceCapabilities(
  serverUrl: string | undefined,
  signal?: AbortSignal,
  authToken?: string
): Promise<VoiceCapabilities> {
  if (!serverUrl || typeof fetch === "undefined") return BROWSER_ONLY_CAPABILITIES;
  const base = serverUrl.replace(/\/$/, "");
  try {
    // The route is public, but send the bearer when we have one so it still works if a
    // deployment guards it.
    const headers: Record<string, string> = {};
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    const res = await fetch(`${base}/v1/voice/capabilities`, { signal, headers });
    if (!res.ok) return BROWSER_ONLY_CAPABILITIES;
    const raw = (await res.json()) as Partial<VoiceCapabilities>;
    return {
      tts: {
        server: Boolean(raw?.tts?.server),
        providers: Array.isArray(raw?.tts?.providers) ? (raw!.tts!.providers as TtsProvider[]) : [],
      },
      stt: { server: Boolean(raw?.stt?.server) },
    };
  } catch {
    return BROWSER_ONLY_CAPABILITIES;
  }
}

/**
 * Shipped defaults. Do NOT change these: apps rely on the free browser STT path being the
 * default and must not be moved onto a paid one by a version bump. A host that wants a
 * different starting point sets `voiceDefaults` instead.
 */
const DEFAULTS: VoiceSettings = {
  autoSpeak: false,
  ttsMode: "server",
  ttsProvider: "elevenlabs",
  elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM",
  openaiVoice: "nova",
  sttMode: "browser",
};

const SETTING_KEYS: (keyof VoiceSettings)[] = [
  "autoSpeak",
  "ttsMode",
  "ttsProvider",
  "elevenLabsVoiceId",
  "openaiVoice",
  "sttMode",
];

/**
 * The host's own starting point, layered between the shipped defaults and the user's
 * stored choices: DEFAULTS < voiceDefaults < stored.
 *
 * Module-level because the settings panel and the change listener call `getVoiceSettings()`
 * with no host context. Passing a full `VoiceOptions` object instead would bypass both, so
 * the user's own preferences would stop applying — which is the thing this exists to avoid.
 */
let hostDefaults: Partial<VoiceSettings> = {};

/** Set the host's defaults. Unknown or undefined keys are ignored. */
export function setVoiceDefaults(d?: Partial<VoiceSettings>): void {
  hostDefaults = {};
  if (!d) return;
  for (const k of SETTING_KEYS) {
    if (d[k] !== undefined) (hostDefaults as Record<string, unknown>)[k] = d[k];
  }
}

/** The effective defaults before the user's stored choices are applied. */
export function getVoiceDefaults(): VoiceSettings {
  return { ...DEFAULTS, ...hostDefaults };
}

/** Curated ElevenLabs voices — same API cost per character; voice id only changes sound. */
export const ELEVENLABS_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel — warm US" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah — soft US" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam — deep US" },
  { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh — young US" },
  { id: "VR6AewLTigWG4xSOukaG", label: "Arnold — crisp" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi — strong US" },
  { id: "MF3mGyEYCl7XYWbV9V6O", label: "Elli — young US" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni — warm" },
  { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel — British" },
  { id: "XB0fDUnXU5powFXDhCwa", label: "Charlotte — Swedish-English" },
];

export const OPENAI_VOICES = [
  { id: "nova", label: "Nova (natural)" },
  { id: "shimmer", label: "Shimmer (warm)" },
  { id: "alloy", label: "Alloy (neutral)" },
  { id: "echo", label: "Echo (male)" },
  { id: "fable", label: "Fable (British)" },
  { id: "onyx", label: "Onyx (deep)" },
];

export function getVoiceSettings(storageKey = VOICE_SETTINGS_STORAGE_KEY): VoiceSettings {
  const base = getVoiceDefaults();
  if (typeof localStorage === "undefined") return base;
  try {
    // Stored user choices win over the host's defaults, which win over the shipped ones.
    return { ...base, ...JSON.parse(localStorage.getItem(storageKey) || "{}") };
  } catch {
    return base;
  }
}

export function setVoiceSettings(
  patch: Partial<VoiceSettings>,
  storageKey = VOICE_SETTINGS_STORAGE_KEY
): VoiceSettings {
  const next = { ...getVoiceSettings(storageKey), ...patch };
  localStorage.setItem(storageKey, JSON.stringify(next));
  window.dispatchEvent(new Event(VOICE_SETTINGS_CHANGE_EVENT));
  return next;
}

/** Map stored settings to VoiceOptions for the widget Voice class. */
export function voiceOptionsFromSettings(
  serverUrl: string,
  settings = getVoiceSettings()
): VoiceOptions {
  const voiceId = settings.ttsProvider === "elevenlabs" ? settings.elevenLabsVoiceId : settings.openaiVoice;
  return {
    serverUrl,
    ttsMode: settings.ttsMode,
    ttsProvider: settings.ttsProvider,
    voiceId,
    sttMode: settings.sttMode,
  };
}
