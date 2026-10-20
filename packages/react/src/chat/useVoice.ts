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

/** Markdown → something worth reading out loud. */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|~]/g, "")
    .replace(/^\s*-{3,}\s*$/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

type Recognition = { start(): void; stop(): void; lang: string; interimResults: boolean; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoice(voice: VoiceOptions | null, transport: AgentTransport) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [available, setAvailable] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const t = useRef(transport);
  t.current = transport;
  const lang = () => voice?.lang || (typeof document !== "undefined" ? document.documentElement.lang : "") || "en";

  useEffect(() => {
    if (!voice) return setAvailable(false);
    const canRecord = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
    setAvailable((!!voice.sttUrl && canRecord) || !!recognitionCtor());
  }, [voice?.sttUrl]);

  const headers = async (extra: Record<string, string>) => {
    const h: Record<string, string> = { ...(t.current.headers ?? {}), ...extra };
    const token = t.current.getAuthToken ? await t.current.getAuthToken() : null;
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  };

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
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          return; // permission refused
        }
        const rec = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onstop = async () => {
          stream.getTracks().forEach((tr) => tr.stop());
          setRecording(false);
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          if (!blob.size) return;
          setTranscribing(true);
          try {
            const res = await (t.current.fetch ?? fetch)(voice.sttUrl!, {
              method: "POST",
              credentials: "same-origin",
              headers: await headers({ "content-type": "application/octet-stream", "x-audio-content-type": blob.type, "x-audio-lang": lang() }),
              body: blob,
            });
            const data = res.ok ? ((await res.json()) as { text?: string }) : null;
            if (data?.text?.trim()) onText(data.text.trim());
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
            headers: await headers({ "content-type": "application/json" }),
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
