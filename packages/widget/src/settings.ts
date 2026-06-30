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

const DEFAULTS: VoiceSettings = {
  autoSpeak: false,
  ttsMode: "server",
  ttsProvider: "elevenlabs",
  elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM",
  openaiVoice: "nova",
  sttMode: "browser",
};

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
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(storageKey) || "{}") };
  } catch {
    return DEFAULTS;
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
