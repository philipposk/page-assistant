// Voice proxy: TTS via ElevenLabs (falls back to OpenAI), STT via OpenAI Whisper.
// Ported in spirit from strive voice_handler + Daisy voice_service. Keys stay server-side.
import { fetchWithRetry, voiceTimeoutMs } from "./llm/fetchWithRetry.js";
import { HttpProviderError } from "./llm/errors.js";

export interface TTSRequest {
  text: string;
  voiceId?: string;
  provider?: "elevenlabs" | "openai";
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
        body: JSON.stringify({ text: req.text, model_id: "eleven_flash_v2_5" }),
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

/**
 * Whisper STT. Accepts raw audio bytes and an optional content-type hint (the browser's
 * MediaRecorder mimeType) so Safari's mp4 recordings are labelled correctly.
 */
export async function transcribe(audio: Buffer, contentTypeOrFilename?: string, env = process.env): Promise<string> {
  if (!env.OPENAI_API_KEY) throw new Error("STT needs OPENAI_API_KEY.");
  // Accept either a raw content-type ("audio/mp4") or an explicit filename ("clip.mp4").
  const filename =
    contentTypeOrFilename && /\.[a-z0-9]+$/i.test(contentTypeOrFilename)
      ? contentTypeOrFilename
      : whisperFilename(contentTypeOrFilename);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), filename);
  form.append("model", "whisper-1");
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
