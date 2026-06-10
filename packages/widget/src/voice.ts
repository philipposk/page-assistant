// Browser voice I/O. Default to free built-in Web Speech APIs; optionally use the
// backend for higher-quality ElevenLabs TTS / Whisper STT. Supports barge-in (speaking
// stops the moment the user starts talking), ported in spirit from Daisy's barge_in.

export interface VoiceOptions {
  serverUrl?: string;
  /** "browser" = SpeechSynthesis (free), "server" = ElevenLabs/OpenAI via backend. */
  ttsMode?: "browser" | "server";
  voiceId?: string;
  /** Preferred browser voice name substring, e.g. "Samantha". */
  browserVoice?: string;
}

export class Voice {
  private speaking = false;
  private currentAudio?: HTMLAudioElement;
  constructor(private opts: VoiceOptions = {}) {}

  get isSpeaking() {
    return this.speaking;
  }

  async speak(text: string, onWord?: (t: string) => void): Promise<void> {
    this.stop();
    if (this.opts.ttsMode === "server" && this.opts.serverUrl) {
      return this.speakServer(text);
    }
    return this.speakBrowser(text, onWord);
  }

  private speakBrowser(text: string, onWord?: (t: string) => void): Promise<void> {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      if (this.opts.browserVoice) {
        const v = speechSynthesis.getVoices().find((x) => x.name.includes(this.opts.browserVoice!));
        if (v) u.voice = v;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.speaking = false;
        resolve();
      };
      u.onstart = () => (this.speaking = true);
      u.onboundary = (e) => onWord?.(text.slice(e.charIndex, e.charIndex + 12));
      u.onend = done;
      u.onerror = done; // cancel() fires error in some browsers, end in others
      // Safety: some browsers drop events entirely (e.g. tab backgrounded) — never hang.
      setTimeout(done, Math.max(5000, text.length * 120));
      speechSynthesis.speak(u);
    });
  }

  private async speakServer(text: string): Promise<void> {
    const res = await fetch(`${this.opts.serverUrl}/v1/voice/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId: this.opts.voiceId }),
    });
    if (!res.ok) return this.speakBrowser(text);
    const blob = await res.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    this.currentAudio = audio;
    this.speaking = true;
    await audio.play().catch(() => {});
    return new Promise((resolve) => {
      audio.onended = () => {
        this.speaking = false;
        resolve();
      };
    });
  }

  stop() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = undefined;
    }
    this.speaking = false;
  }

  /**
   * Listen for one utterance. Uses the browser SpeechRecognition API when available
   * (instant, free); falls back to MediaRecorder + backend Whisper. Barge-in: if the
   * assistant is mid-speech, we stop it as soon as listening starts.
   */
  async listenOnce(): Promise<string> {
    this.stop(); // barge-in
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
      return new Promise((resolve) => {
        const r = new SR();
        r.lang = "en-US";
        r.interimResults = false;
        r.maxAlternatives = 1;
        let settled = false;
        const finish = (text: string) => {
          if (settled) return;
          settled = true;
          resolve(text);
        };
        r.onresult = (e: any) => finish(e.results[0][0].transcript);
        r.onerror = () => finish("");
        // Silence ends recognition with NO result and NO error — without this the
        // promise never resolves and the mic button is stuck forever.
        r.onend = () => finish("");
        setTimeout(() => {
          try {
            r.stop();
          } catch {
            /* already stopped */
          }
          finish("");
        }, 12000);
        r.start();
      });
    }
    return this.listenServer();
  }

  private async listenServer(): Promise<string> {
    if (!this.opts.serverUrl) return "";
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      // Attach onstop BEFORE stop() and race a timeout so a browser that never fires
      // the event can't hang us.
      const stopped = new Promise<void>((r) => {
        rec.onstop = () => r();
        setTimeout(r, 6000);
      });
      rec.start();
      await new Promise((r) => setTimeout(r, 4000)); // 4s capture window
      try {
        rec.stop();
      } catch {
        /* already inactive */
      }
      await stopped;
      const blob = new Blob(chunks, { type: "audio/webm" });
      if (!blob.size) return "";
      const res = await fetch(`${this.opts.serverUrl}/v1/voice/stt`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: await blob.arrayBuffer(),
      });
      if (!res.ok) return "";
      return (await res.json()).text ?? "";
    } finally {
      stream.getTracks().forEach((t) => t.stop()); // mic indicator must die even on errors
    }
  }
}
