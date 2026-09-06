// Browser voice I/O. Default to free built-in Web Speech APIs; optionally use the
// backend for higher-quality ElevenLabs TTS / Whisper STT. Supports barge-in (speaking
// stops the moment the user actually talks — real RMS voice-activity detection).

export type VoiceErrorReason =
  | "no-speech"
  | "not-allowed"
  /** No microphone device. */
  | "no-mic"
  /**
   * The speech SERVICE failed, as distinct from the microphone being refused: the
   * recogniser's network backend is unreachable, or the engine itself is unavailable
   * ("service-not-allowed"). This is the everyday iOS symptom — webkitSpeechRecognition
   * exists inside an installed PWA / WKWebView but does not work — and it is the one
   * failure worth retrying through server STT, because the mic itself is fine.
   */
  | "service"
  | "other";

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
   * BCP-47 language for speech recognition and speech synthesis, e.g. "el-GR", "en-GB".
   *
   * Resolution order, evaluated on every mic tap / every utterance (never cached at
   * module load, so a host that flips its `<html lang>` when the user switches language
   * is picked up on the next tap without a reload):
   *   1. this option, when the host sets it — ALWAYS wins;
   *   2. `document.documentElement.lang`;
   *   3. `navigator.language`;
   *   4. "en-US".
   *
   * Set it explicitly if you know the language. `<html lang>` is only a last resort: a
   * host can render a fully translated UI while its root element still says "en", and
   * then the recogniser is told the wrong language and returns nothing.
   */
  lang?: string;
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
  /** Fired once when server STT is unavailable and we transparently fall back to the browser. */
  onServerFallback?: () => void;
  /** Fired once when the browser recogniser is unusable and we fall back to server STT. */
  onBrowserFallback?: () => void;
}

const SILERO_CDN = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/index.js";

/**
 * Resolve the BCP-47 language to use for speech I/O. Called per utterance, never cached:
 * a host that swaps `<html lang>` on a language switch is honoured on the next mic tap.
 * An explicit value always wins — `<html lang>` can lie (a translated UI whose root
 * element still says "en"), so it is only consulted when the host said nothing.
 */
export function resolveVoiceLang(explicit?: string): string {
  const set = explicit?.trim();
  if (set) return set;
  if (typeof document !== "undefined") {
    const htmlLang = document.documentElement?.lang?.trim();
    if (htmlLang) return htmlLang;
  }
  if (typeof navigator !== "undefined" && navigator.language?.trim()) return navigator.language.trim();
  return "en-US";
}

/** "el-GR" → "el". Whisper and ElevenLabs want the bare ISO-639-1 code. */
export function baseLang(lang: string): string {
  return lang.toLowerCase().replace(/_/g, "-").split("-")[0];
}

/**
 * True when a mic tap could actually produce a transcript: the browser has
 * SpeechRecognition, or there is a server to send recorded audio to AND the browser can
 * record. Used to avoid rendering a mic button that can only ever do nothing.
 */
export function voiceInputAvailable(serverUrl?: string): boolean {
  if (typeof window === "undefined") return false;
  if ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) return true;
  return (
    !!serverUrl &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof (window as any).MediaRecorder !== "undefined"
  );
}

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

  /** The language for this utterance/listen. Resolved now, not at construction. */
  private lang(): string {
    return resolveVoiceLang(this.opts.lang);
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
      const lang = this.lang();
      u.lang = lang;
      const v = this.pickBrowserVoice(lang);
      if (v) {
        u.voice = v;
        u.lang = v.lang || lang;
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

  /**
   * Choose a synthesis voice for `lang`. Language beats the host's `browserVoice` name
   * hint, because a name like "Samantha" is an en-US voice and reading Greek with it is
   * unintelligible. The name still wins inside the same base language, so an app that
   * asked for "Daniel" keeps Daniel while the page is in English.
   */
  private pickBrowserVoice(lang: string): SpeechSynthesisVoice | undefined {
    let voices: SpeechSynthesisVoice[] = [];
    try {
      voices = speechSynthesis.getVoices() ?? [];
    } catch {
      return undefined;
    }
    if (!voices.length) return undefined; // Chrome populates async; leave u.lang to decide
    const want = lang.toLowerCase().replace(/_/g, "-");
    const wantBase = baseLang(lang);
    const named = this.opts.browserVoice
      ? voices.filter((v) => v.name.includes(this.opts.browserVoice!))
      : [];
    const vLang = (v: SpeechSynthesisVoice) => (v.lang ?? "").toLowerCase().replace(/_/g, "-");
    return (
      named.find((v) => vLang(v) === want) ??
      named.find((v) => baseLang(vLang(v)) === wantBase) ??
      voices.find((v) => vLang(v) === want) ??
      voices.find((v) => baseLang(vLang(v)) === wantBase) ??
      named[0]
    );
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
          lang: this.lang(),
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

  /**
   * Start barge-in — BUT never open the mic just to speak. Opening getUserMedia on every
   * TTS reply prompted TTS-only users for mic access, lit the mic indicator during all
   * speech, and let speaker echo trip the RMS threshold (the assistant barged in on
   * itself). So we only run barge-in when the mic is already available:
   *   - a live listen stream already exists (reuse it), or
   *   - mic permission was ALREADY granted (Permissions API says "granted").
   * Otherwise barge-in is silently skipped; tapping the mic button still interrupts TTS.
   */
  private startBargeIn() {
    this.stopBargeIn();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    if (this.opts.vad === "silero") {
      // Silero manages its own mic; gate it behind an already-granted permission too so it
      // doesn't surprise-prompt TTS-only users.
      this.ifMicAlreadyGranted(() => this.startSileroBargeIn());
      return;
    }
    this.ifMicAlreadyGranted(() => this.startAnalyserBargeIn());
  }

  /** Run `fn` only if the mic is already usable without a new permission prompt. */
  private ifMicAlreadyGranted(fn: () => void) {
    const perms = (navigator as any).permissions;
    if (!perms?.query) {
      // No Permissions API (Safari, older browsers): can't tell without prompting, so
      // skip barge-in rather than risk a surprise mic prompt. Mic-tap still interrupts.
      return;
    }
    perms
      .query({ name: "microphone" as PermissionName })
      .then((status: PermissionStatus) => {
        if (status.state === "granted") fn();
      })
      .catch(() => {
        /* query unsupported for "microphone" — skip barge-in silently */
      });
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
      // Echo cancellation + noise suppression so the speaker output doesn't feed back into
      // the analyser and trip barge-in on the assistant's own voice.
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } as MediaTrackConstraints })
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
          // Higher threshold + more sustained voiced frames so residual speaker echo (past
          // echo cancellation) and brief thumps don't self-interrupt.
          if (rms > 0.09) {
            if (++voicedFrames >= 6) {
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
        /* mic became unavailable — barge-in via VAD unavailable; mic-tap still stops TTS */
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
      try {
        return await this.listenServer(hooks);
      } catch (e) {
        // A saved "server STT" preference against a server that has no Whisper key made
        // every mic tap throw VoiceError("other") → the user saw "I couldn't access the
        // microphone." If the failure is server-side (not a mic/permission/no-speech
        // problem), transparently fall back to the free browser recognizer with a notice.
        if (e instanceof VoiceError && e.reason === "other") {
          const SRfb = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
          if (SRfb) {
            hooks?.onServerFallback?.();
            return this.listenBrowser(SRfb);
          }
        }
        throw e;
      }
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
      try {
        return await this.listenBrowser(SR);
      } catch (e) {
        // The reverse fallback, and the one that matters on iOS: webkitSpeechRecognition
        // is present inside an installed PWA / WKWebView but its service does not work,
        // so it fails with a network/service error while the mic is perfectly fine.
        // Retry ONCE through server STT. Never on "not-allowed" (mic refused — the server
        // path needs the same permission and would fail identically) and never on
        // "no-speech" (the user simply said nothing).
        if (e instanceof VoiceError && (e.reason === "service" || e.reason === "other") && this.canServerStt()) {
          hooks?.onBrowserFallback?.();
          return this.listenServer(hooks); // single retry — listenServer never re-enters here
        }
        throw e;
      }
    }
    // No recogniser at all (Firefox, some WKWebViews). Server STT is the only path.
    if (this.canServerStt()) {
      hooks?.onBrowserFallback?.();
      return this.listenServer(hooks);
    }
    // Nothing can transcribe. Fail loudly — a silent "" here is the original bug.
    throw new VoiceError("service");
  }

  /** True when recorded audio can actually be sent somewhere for transcription. */
  private canServerStt(): boolean {
    return (
      !!this.opts.serverUrl &&
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof (window as any).MediaRecorder !== "undefined"
    );
  }

  /** Browser SpeechRecognition path (free, instant). Extracted so server STT can fall back to it. */
  private listenBrowser(SR: any): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new SR();
        this.activeRecognition = r;
        // Told the wrong language, the recogniser returns nothing or nonsense — which used
        // to land on the silent empty-string path. Resolve it per tap.
        r.lang = this.lang();
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
          if (e?.error === "not-allowed") {
            // The USER refused the mic. Server STT needs the same permission, so this is
            // never worth retrying — say so instead.
            gotError = "not-allowed";
            return fail("not-allowed");
          }
          if (
            e?.error === "service-not-allowed" ||
            e?.error === "network" ||
            e?.error === "language-not-supported"
          ) {
            // The recogniser SERVICE failed, not the microphone. Retryable via the server.
            gotError = "service";
            return fail("service");
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
          if (gotError === "service") return fail("service");
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
    // Never resolve "" here: an empty resolve is invisible to the caller and was exactly
    // how a mic tap ended in no transcript, no error and no message.
    if (!this.opts.serverUrl) throw new VoiceError("service");
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
      const lang = this.lang();
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        // Give Whisper the language instead of letting it guess from a 4s clip.
        "x-audio-lang": lang,
      };
      if (this.opts.authToken) headers.authorization = `Bearer ${this.opts.authToken}`;
      let res: Response;
      try {
        res = await fetch(`${this.opts.serverUrl}/v1/voice/stt?lang=${encodeURIComponent(lang)}`, {
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
