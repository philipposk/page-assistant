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
      u.onstart = () => (this.speaking = true);
      u.onboundary = (e) => onWord?.(text.slice(e.charIndex, e.charIndex + 12));
      u.onend = () => {
        this.speaking = false;
        resolve();
      };
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
        r.onresult = (e: any) => resolve(e.results[0][0].transcript);
        r.onerror = () => resolve("");
        r.onend = () => {};
        r.start();
      });
    }
    return this.listenServer();
  }

  private async listenServer(): Promise<string> {
    if (!this.opts.serverUrl) return "";
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    await new Promise((r) => setTimeout(r, 4000)); // 4s window
    rec.stop();
    stream.getTracks().forEach((t) => t.stop());
    await new Promise((r) => (rec.onstop = () => r(null)));
    const blob = new Blob(chunks, { type: "audio/webm" });
    const res = await fetch(`${this.opts.serverUrl}/v1/voice/stt`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: await blob.arrayBuffer(),
    });
    if (!res.ok) return "";
    return (await res.json()).text ?? "";
  }
}
