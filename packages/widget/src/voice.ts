// Browser voice I/O. Default to free built-in Web Speech APIs; optionally use the
// backend for higher-quality ElevenLabs TTS / Whisper STT. Supports barge-in (speaking
// stops the moment the user actually talks — real RMS voice-activity detection).

export type VoiceErrorReason = "no-speech" | "not-allowed" | "no-mic" | "other";

export class VoiceError extends Error {
  constructor(public reason: VoiceErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "VoiceError";
  }
}

export interface VoiceOptions {
  serverUrl?: string;
  /** Bearer token when the backend requires PA_AUTH_TOKEN. */
  authToken?: string;
  /** "browser" = SpeechSynthesis (free), "server" = ElevenLabs/OpenAI via backend. */
  ttsMode?: "browser" | "server";
  voiceId?: string;
  ttsProvider?: "elevenlabs" | "openai";
  /** "browser" = SpeechRecognition (free), "server" = Whisper via backend. */
  sttMode?: "browser" | "server";
  /** Preferred browser voice name substring, e.g. "Samantha". */
  browserVoice?: string;
  /**
   * Voice-activity detection engine for barge-in. "builtin" (default) uses a
   * zero-dependency AnalyserNode RMS meter. "silero" lazy-loads @ricky0123/vad-web
   * from a CDN at runtime (opt-in, not bundled — no bundle-size impact when unused).
   */
  vad?: "builtin" | "silero";
}

/** Progress callbacks for the server-STT capture window (visible countdown + cancel). */
export interface ListenHooks {
  /** Fired for the 4s server-capture window: ms remaining, updated ~4×/sec. */
  onCountdown?: (msRemaining: number, totalMs: number) => void;
  /** Fired once when capture actually starts. */
  onCaptureStart?: () => void;
}

const SILERO_CDN = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/index.js";

export class Voice {
  private speaking = false;
  private currentAudio?: HTMLAudioElement;
  private currentUtterance?: SpeechSynthesisUtterance;
  private activeRecognition?: any;
  private listenAbort?: AbortController;
  private bargeCleanup?: () => void;

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
      this.currentUtterance = u;
      if (this.opts.browserVoice) {
        const v = speechSynthesis.getVoices().find((x) => x.name.includes(this.opts.browserVoice!));
        if (v) u.voice = v;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.speaking = false;
        this.currentUtterance = undefined;
        this.stopBargeIn();
        resolve();
      };
      u.onstart = () => {
        this.speaking = true;
        this.startBargeIn(); // stop TTS the moment the user actually speaks
      };
      u.onboundary = (e) => onWord?.(text.slice(e.charIndex, e.charIndex + 12));
      u.onend = done;
      u.onerror = done; // cancel() fires error in some browsers, end in others
      // Safety: some browsers drop events entirely (e.g. tab backgrounded) — never hang.
      setTimeout(done, Math.max(5000, text.length * 120));
      speechSynthesis.speak(u);
    });
  }

  private async speakServer(text: string): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.authToken) headers.authorization = `Bearer ${this.opts.authToken}`;
    let res: Response;
    try {
      res = await fetch(`${this.opts.serverUrl}/v1/voice/tts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          text,
          voiceId: this.opts.voiceId,
          provider: this.opts.ttsProvider,
        }),
      });
    } catch {
      return this.speakBrowser(text);
    }
    if (!res.ok) return this.speakBrowser(text);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.currentAudio = audio;
    this.speaking = true;
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.speaking = false;
        this.currentAudio = undefined;
        this.stopBargeIn();
        URL.revokeObjectURL(url); // free the blob once playback is over/aborted
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      // Safari can block autoplay: play() rejects and onended never fires. Resolve on
      // rejection instead of hanging forever with the mascot stuck "talking".
      audio.play().then(
        () => this.startBargeIn(),
        () => done()
      );
    });
  }

  stop() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.currentUtterance = undefined;
    if (this.currentAudio) {
      this.currentAudio.pause();
      const src = this.currentAudio.src;
      this.currentAudio = undefined;
      if (src.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(src);
        } catch {
          /* ignore */
        }
      }
    }
    this.speaking = false;
    this.stopBargeIn();
  }

  // ---- Barge-in: real voice-activity detection ------------------------------

  /** Start listening on the mic and stop TTS the moment the user actually speaks. */
  private startBargeIn() {
    this.stopBargeIn();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    if (this.opts.vad === "silero") {
      this.startSileroBargeIn();
      return;
    }
    this.startAnalyserBargeIn();
  }

  private startAnalyserBargeIn() {
    let cancelled = false;
    let stream: MediaStream | undefined;
    let ctx: AudioContext | undefined;
    let raf = 0;
    const cleanup = () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    };
    this.bargeCleanup = cleanup;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
        ctx = new AC();
        const source = ctx!.createMediaStreamSource(s);
        const analyser = ctx!.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        let voicedFrames = 0;
        const tick = () => {
          if (cancelled || !this.speaking) return;
          analyser.getByteTimeDomainData(buf);
          // RMS of the centred waveform (0..~1). Speech spikes well above room noise.
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          if (rms > 0.05) {
            // require a few consecutive voiced frames so a click/thump doesn't trigger
            if (++voicedFrames >= 3) {
              this.stop(); // user is talking — cut the assistant off (barge-in)
              return;
            }
          } else {
            voicedFrames = 0;
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      })
      .catch(() => {
        /* no mic permission — barge-in via VAD unavailable; mic-tap still stops TTS */
      });
  }

  /** Optional Silero VAD via lazy CDN import. Never bundled; opt-in via `vad:"silero"`. */
  private startSileroBargeIn() {
    let cancelled = false;
    let vadInstance: any;
    this.bargeCleanup = () => {
      cancelled = true;
      try {
        vadInstance?.destroy?.();
      } catch {
        /* ignore */
      }
    };
    // Build the specifier at runtime so bundlers (esbuild/vite) don't statically pull the
    // CDN module into the bundle — this stays truly optional and zero bundle-size.
    let dynImport: Promise<any>;
    try {
      dynImport = new Function("s", "return import(s)")(SILERO_CDN) as Promise<any>;
    } catch {
      // CSP without 'unsafe-eval' blocks new Function — fall back to the built-in path.
      this.startAnalyserBargeIn();
      return;
    }
    dynImport
      .then(async (mod: any) => {
        if (cancelled) return;
        const MicVAD = mod?.MicVAD ?? (window as any).vad?.MicVAD;
        if (!MicVAD) return this.startAnalyserBargeIn();
        vadInstance = await MicVAD.new({
          onSpeechStart: () => {
            if (this.speaking) this.stop();
          },
        });
        if (cancelled) {
          vadInstance?.destroy?.();
          return;
        }
        vadInstance.start();
      })
      .catch(() => {
        // CDN unreachable / blocked — fall back to the built-in path so barge-in still works.
        if (!cancelled) this.startAnalyserBargeIn();
      });
  }

  private stopBargeIn() {
    const c = this.bargeCleanup;
    this.bargeCleanup = undefined;
    c?.();
  }

  /**
   * Listen for one utterance. Uses the browser SpeechRecognition API when available
   * (instant, free); falls back to MediaRecorder + backend Whisper. Distinguishes
   * no-speech / permission-denied / other errors so the caller can surface a message.
   */
  async listenOnce(hooks?: ListenHooks): Promise<string> {
    this.stop(); // barge-in
    if (this.opts.sttMode === "server" && this.opts.serverUrl) {
      return this.listenServer(hooks);
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
      return new Promise((resolve, reject) => {
        const r = new SR();
        this.activeRecognition = r;
        r.lang = "en-US";
        r.interimResults = false;
        r.maxAlternatives = 1;
        let settled = false;
        let gotError: VoiceErrorReason | null = null;
        const finish = (text: string) => {
          if (settled) return;
          settled = true;
          this.activeRecognition = undefined;
          resolve(text);
        };
        const fail = (reason: VoiceErrorReason) => {
          if (settled) return;
          settled = true;
          this.activeRecognition = undefined;
          reject(new VoiceError(reason));
        };
        r.onresult = (e: any) => finish(e.results[0][0].transcript);
        r.onerror = (e: any) => {
          // "aborted" is our own cancel() — resolve empty, no error surfaced.
          if (e?.error === "aborted") return finish("");
          if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
            gotError = "not-allowed";
            return fail("not-allowed");
          }
          if (e?.error === "no-speech") {
            gotError = "no-speech";
            return; // let onend resolve/reject below
          }
          gotError = "other";
        };
        // Silence ends recognition with NO result — surface "no-speech" (I didn't catch that)
        // rather than silently resolving "".
        r.onend = () => {
          if (settled) return;
          if (gotError === "no-speech" || gotError === null) return fail("no-speech");
          if (gotError === "other") return fail("other");
          finish("");
        };
        this.listenAbort = new AbortController();
        this.listenAbort.signal.addEventListener("abort", () => {
          try {
            r.abort();
          } catch {
            /* already stopped */
          }
          finish("");
        });
        setTimeout(() => {
          try {
            r.stop();
          } catch {
            /* already stopped */
          }
        }, 12000);
        try {
          r.start();
        } catch {
          fail("other");
        }
      });
    }
    return this.listenServer(hooks);
  }

  /** Cancel an in-flight listen (second mic tap). Resolves the pending listenOnce with "". */
  cancelListen() {
    if (this.activeRecognition) {
      try {
        this.activeRecognition.abort();
      } catch {
        /* ignore */
      }
    }
    this.listenAbort?.abort();
  }

  private async listenServer(hooks?: ListenHooks): Promise<string> {
    if (!this.opts.serverUrl) return "";
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e: any) {
      if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
        throw new VoiceError("not-allowed");
      }
      if (e?.name === "NotFoundError" || e?.name === "NotReadableError") {
        throw new VoiceError("no-mic");
      }
      throw new VoiceError("other");
    }
    const abort = new AbortController();
    this.listenAbort = abort;
    let cancelled = false;
    abort.signal.addEventListener("abort", () => (cancelled = true));
    try {
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise<void>((r) => {
        rec.onstop = () => r();
        setTimeout(r, 6000);
      });
      rec.start();
      hooks?.onCaptureStart?.();
      // 4s capture window with a visible countdown and tap-to-cancel.
      const CAPTURE_MS = 4000;
      const start = Date.now();
      await new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          const remaining = CAPTURE_MS - (Date.now() - start);
          if (cancelled || remaining <= 0) {
            clearInterval(iv);
            hooks?.onCountdown?.(0, CAPTURE_MS);
            resolve();
          } else {
            hooks?.onCountdown?.(remaining, CAPTURE_MS);
          }
        }, 250);
        abort.signal.addEventListener("abort", () => {
          clearInterval(iv);
          resolve();
        });
      });
      try {
        rec.stop();
      } catch {
        /* already inactive */
      }
      await stopped;
      if (cancelled) return "";
      const blob = new Blob(chunks, { type: "audio/webm" });
      if (!blob.size) throw new VoiceError("no-speech");
      const headers: Record<string, string> = { "content-type": "application/octet-stream" };
      if (this.opts.authToken) headers.authorization = `Bearer ${this.opts.authToken}`;
      let res: Response;
      try {
        res = await fetch(`${this.opts.serverUrl}/v1/voice/stt`, {
          method: "POST",
          headers,
          body: await blob.arrayBuffer(),
        });
      } catch {
        throw new VoiceError("other");
      }
      if (!res.ok) throw new VoiceError("other");
      const text = (await res.json()).text ?? "";
      if (!text.trim()) throw new VoiceError("no-speech");
      return text;
    } finally {
      this.listenAbort = undefined;
      stream.getTracks().forEach((t) => t.stop()); // mic indicator must die even on errors
    }
  }
}
