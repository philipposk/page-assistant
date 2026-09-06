// Voice proxy: TTS via ElevenLabs (falls back to OpenAI), STT via OpenAI Whisper.
// Ported in spirit from strive voice_handler + Daisy voice_service. Keys stay server-side.
import { fetchWithRetry, voiceTimeoutMs } from "./llm/fetchWithRetry.js";
import { HttpProviderError } from "./llm/errors.js";

export interface TTSRequest {
  text: string;
  voiceId?: string;
  provider?: "elevenlabs" | "openai";
  /** BCP-47 hint, e.g. "el-GR". Optional; providers auto-detect when it is absent. */
  lang?: string;
}

/** "el-GR" → "el". Whisper and ElevenLabs both want the bare ISO-639-1 code. */
export function toIso639(lang?: unknown): string | undefined {
  if (typeof lang !== "string") return undefined;
  const base = lang.trim().toLowerCase().replace(/_/g, "-").split("-")[0];
  return /^[a-z]{2,3}$/.test(base) ? base : undefined;
}

export async function synthesize(req: TTSRequest, env = process.env): Promise<{ audio: Buffer; contentType: string }> {
  const provider = req.provider ?? (env.ELEVENLABS_API_KEY ? "elevenlabs" : "openai");
  if (provider === "elevenlabs" && env.ELEVENLABS_API_KEY) {
    const voice = req.voiceId ?? env.PA_ELEVENLABS_VOICE ?? "21m00Tcm4TlvDq8ikWAM"; // Rachel
    const res = await fetchWithRetry(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY, accept: "audio/mpeg" },
        // eleven_flash_v2_5 is multilingual; language_code pins it instead of letting it
        // guess from the text (short Greek strings were being read as English).
        body: JSON.stringify({
          text: req.text,
          model_id: "eleven_flash_v2_5",
          ...(toIso639(req.lang) ? { language_code: toIso639(req.lang) } : {}),
        }),
      },
      { timeoutMs: voiceTimeoutMs() }
    );
    if (!res.ok) throw new HttpProviderError("elevenlabs", res.status, await safeText(res));
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: "audio/mpeg" };
  }
  if (!env.OPENAI_API_KEY) throw new Error("No TTS provider configured (ELEVENLABS_API_KEY or OPENAI_API_KEY).");
  const res = await fetchWithRetry(
    "https://api.openai.com/v1/audio/speech",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: req.voiceId ?? "nova", input: req.text }),
    },
    { timeoutMs: voiceTimeoutMs() }
  );
  if (!res.ok) throw new HttpProviderError("openai tts", res.status, await safeText(res));
  return { audio: Buffer.from(await res.arrayBuffer()), contentType: "audio/mpeg" };
}

/**
 * Map a browser MIME type (or filename) to a filename+extension Whisper accepts. Safari
 * records mp4/m4a, Chrome/Firefox record webm/ogg; sending the wrong extension makes
 * Whisper reject the upload, so iOS STT silently failed. We derive the extension from the
 * content type when given, defaulting to a broadly-supported one.
 */
export function whisperFilename(contentType?: string): string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("mp4") || ct.includes("m4a") || ct.includes("aac")) return "audio.mp4";
  if (ct.includes("mpeg") || ct.includes("mp3")) return "audio.mp3";
  if (ct.includes("wav")) return "audio.wav";
  if (ct.includes("ogg") || ct.includes("opus")) return "audio.ogg";
  if (ct.includes("webm")) return "audio.webm";
  return "audio.webm";
}

export interface TranscribeOptions {
  /** Browser MediaRecorder mimeType ("audio/mp4") or an explicit filename ("clip.mp4"). */
  hint?: string;
  /** BCP-47 or ISO-639-1 language of the speech, e.g. "el-GR" / "el". */
  lang?: string;
}

/**
 * Whisper STT. Accepts raw audio bytes plus an optional hint (the browser's MediaRecorder
 * mimeType) so Safari's mp4 recordings are labelled correctly.
 *
 * The second argument accepts either the plain hint string it always took, or an options
 * object that can also carry the language — existing callers passing a string (or nothing)
 * are unaffected.
 */
export async function transcribe(
  audio: Buffer,
  hintOrOptions?: string | TranscribeOptions,
  env = process.env
): Promise<string> {
  if (!env.OPENAI_API_KEY) throw new Error("STT needs OPENAI_API_KEY.");
  const opts: TranscribeOptions =
    typeof hintOrOptions === "string" ? { hint: hintOrOptions } : hintOrOptions ?? {};
  const contentTypeOrFilename = opts.hint;
  // Accept either a raw content-type ("audio/mp4") or an explicit filename ("clip.mp4").
  const filename =
    contentTypeOrFilename && /\.[a-z0-9]+$/i.test(contentTypeOrFilename)
      ? contentTypeOrFilename
      : whisperFilename(contentTypeOrFilename);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), filename);
  form.append("model", "whisper-1");
  // Whisper guesses the language from the audio when not told. On a 4s clip that guess is
  // often wrong, and a Greek speaker got English gibberish back.
  const iso = toIso639(opts.lang);
  if (iso) form.append("language", iso);
  const res = await fetchWithRetry(
    "https://api.openai.com/v1/audio/transcriptions",
    { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form },
    { timeoutMs: voiceTimeoutMs() }
  );
  if (!res.ok) throw new HttpProviderError("whisper", res.status, await safeText(res));
  const data: any = await res.json();
  return data.text ?? "";
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
