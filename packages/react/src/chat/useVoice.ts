"use client";

// Voice for the dock: the mic (server Whisper through `sttUrl`, else the browser's own
// speech recognition) and read-aloud (server TTS through `ttsUrl`, else speechSynthesis).
// Keys never reach the browser: the server routes hold them (createVoiceRoutes).

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTransport } from "./client.js";

export interface VoiceOptions {
  /** POST raw audio → { text }. Without it the browser's speech recognition is used, when it has one. */
  sttUrl?: string;
  /** POST { text, lang } → audio. Without it the browser's speechSynthesis is used. */
  ttsUrl?: string;
  /** BCP-47, e.g. "el-GR". Default: the page's language. */
  lang?: string;
}

/** Most of a reply that is looked at; only the first 2000 characters of what is left are read. */
const MAX_SPEAKABLE_INPUT = 20_000;

/** Markdown → something worth reading out loud. */
export function speakableText(md: string): string {
  // Cut first and keep every pattern bounded: a reply of 40k "[" must not cost seconds.
  return String(md ?? "")
    .slice(0, MAX_SPEAKABLE_INPUT)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\][\n]{0,500}\]\([^)\n]{0,2048}\)/g, "")
    .replace(/\[([^\][\n]{0,500})\]\([^)\n]{0,2048}\)/g, "$1")
    .replace(/[*_`#>|~]/g, "")
    .replace(/^\s*-{3,}\s*$/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

/**
 * Whether the bearer token may go to `url`: this page's own origin, or the agent route's (a
 * dock talking to an API on another origin already sends it there). Nowhere else.
 */
function tokenMayGo(url: string, endpoint: string): boolean {
  if (typeof location === "undefined") return false;
  try {
    const origin = new URL(url, location.href).origin;
    return origin === location.origin || origin === new URL(endpoint, location.href).origin;
  } catch {
    return false;
  }
}

type Recognition = { start(): void; stop(): void; abort?(): void; lang: string; interimResults: boolean; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * `active` is whether the dock is on screen. When it goes false (or the dock unmounts) the mic
 * is let go and whatever was recorded is thrown away, not sent.
 */
export function useVoice(voice: VoiceOptions | null, transport: AgentTransport, active: boolean = true) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [available, setAvailable] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  // Bumped each time capture is thrown away; a recording from an older count never uploads.
  const epoch = useRef(0);
  const t = useRef(transport);
  t.current = transport;
  const lang = () => voice?.lang || (typeof document !== "undefined" ? document.documentElement.lang : "") || "en";

  useEffect(() => {
    if (!voice) return setAvailable(false);
    const canRecord = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
    setAvailable((!!voice.sttUrl && canRecord) || !!recognitionCtor());
  }, [voice?.sttUrl]);

  const headers = async (url: string, extra: Record<string, string>) => {
    const h: Record<string, string> = { ...(t.current.headers ?? {}), ...extra };
    // The token is for this app's own routes; a voice URL on any other origin never gets it.
    const token = t.current.getAuthToken && tokenMayGo(url, t.current.endpoint) ? await t.current.getAuthToken() : null;
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  };

  /** Stop listening, release the mic, and drop what was heard. Nothing is uploaded. */
  const discardCapture = useCallback(() => {
    epoch.current++;
    const rec = recorder.current;
    recorder.current = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    stream.current?.getTracks().forEach((tr) => tr.stop());
    stream.current = null;
    const r = recognition.current;
    recognition.current = null;
    if (r) {
      r.onresult = null;
      r.onend = null;
      r.onerror = null;
      try {
        (r.abort ?? r.stop).call(r);
      } catch {
        /* already stopped */
      }
    }
    setRecording(false);
  }, []);

  useEffect(() => {
    if (!active) discardCapture();
  }, [active, discardCapture]);
  useEffect(
    () => () => {
      discardCapture();
      audio.current?.pause();
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    },
    [discardCapture]
  );

  /** Start or stop listening. `onText` gets the transcription. */
  const toggle = useCallback(
    async (onText: (text: string) => void) => {
      if (!voice) return;
      if (recording) {
        recorder.current?.stop();
        recognition.current?.stop();
        return;
      }
      const canRecord = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
      if (voice.sttUrl && canRecord) {
        const startedAt = epoch.current;
        let media: MediaStream;
        try {
          media = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          return; // permission refused
        }
        if (epoch.current !== startedAt) {
          // The panel closed while the browser was asking: let the mic go straight away.
          media.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream.current = media;
        const rec = new MediaRecorder(media);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onstop = async () => {
          media.getTracks().forEach((tr) => tr.stop());
          if (stream.current === media) stream.current = null;
          if (epoch.current !== startedAt) return; // thrown away, not sent
          setRecording(false);
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          if (!blob.size) return;
          setTranscribing(true);
          try {
            const res = await (t.current.fetch ?? fetch)(voice.sttUrl!, {
              method: "POST",
              credentials: "same-origin",
              headers: await headers(voice.sttUrl!, { "content-type": "application/octet-stream", "x-audio-content-type": blob.type, "x-audio-lang": lang() }),
              body: blob,
            });
            const data = res.ok ? ((await res.json()) as { text?: string }) : null;
            if (data?.text?.trim() && epoch.current === startedAt) onText(data.text.trim());
          } catch {
            /* nothing heard */
          } finally {
            setTranscribing(false);
          }
        };
        recorder.current = rec;
        rec.start();
        setRecording(true);
        return;
      }
      const Ctor = recognitionCtor();
      if (!Ctor) return;
      const r = new Ctor();
      r.lang = lang();
      r.interimResults = false;
      r.onresult = (e: any) => {
        const text = Array.from(e.results ?? [])
          .map((x: any) => x[0]?.transcript ?? "")
          .join(" ")
          .trim();
        if (text) onText(text);
      };
      r.onend = () => setRecording(false);
      r.onerror = () => setRecording(false);
      recognition.current = r;
      r.start();
      setRecording(true);
    },
    [voice, recording]
  );

  /** Read a reply out loud (when the user turned read-aloud on, or `force`). */
  const speak = useCallback(
    async (markdown: string, force = false) => {
      if (!voice || (!speakReplies && !force)) return;
      const text = speakableText(markdown);
      if (!text) return;
      audio.current?.pause();
      if (voice.ttsUrl) {
        try {
          const res = await (t.current.fetch ?? fetch)(voice.ttsUrl, {
            method: "POST",
            credentials: "same-origin",
            headers: await headers(voice.ttsUrl!, { "content-type": "application/json" }),
            body: JSON.stringify({ text, lang: lang() }),
          });
          if (res.ok) {
            const url = URL.createObjectURL(await res.blob());
            const el = new Audio(url);
            el.onended = () => URL.revokeObjectURL(url);
            audio.current = el;
            await el.play();
            return;
          }
        } catch {
          /* fall back to the browser's voice */
        }
      }
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang();
        window.speechSynthesis.speak(u);
      }
    },
    [voice, speakReplies]
  );

  const stopSpeaking = useCallback(() => {
    audio.current?.pause();
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  return { enabled: !!voice, available, recording, transcribing, toggle, speak, stopSpeaking, speakReplies, setSpeakReplies };
}
