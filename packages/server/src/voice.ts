// Voice proxy: TTS via ElevenLabs (falls back to OpenAI), STT via OpenAI Whisper.
// Ported in spirit from strive voice_handler + Daisy voice_service. Keys stay server-side.

export interface TTSRequest {
  text: string;
  voiceId?: string;
  provider?: "elevenlabs" | "openai";
}

export async function synthesize(req: TTSRequest, env = process.env): Promise<{ audio: Buffer; contentType: string }> {
  const provider = req.provider ?? (env.ELEVENLABS_API_KEY ? "elevenlabs" : "openai");
  if (provider === "elevenlabs" && env.ELEVENLABS_API_KEY) {
    const voice = req.voiceId ?? env.PA_ELEVENLABS_VOICE ?? "21m00Tcm4TlvDq8ikWAM"; // Rachel
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY, accept: "audio/mpeg" },
      body: JSON.stringify({ text: req.text, model_id: "eleven_flash_v2_5" }),
    });
    if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${await res.text()}`);
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: "audio/mpeg" };
  }
  if (!env.OPENAI_API_KEY) throw new Error("No TTS provider configured (ELEVENLABS_API_KEY or OPENAI_API_KEY).");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: req.voiceId ?? "nova", input: req.text }),
  });
  if (!res.ok) throw new Error(`openai tts ${res.status}: ${await res.text()}`);
  return { audio: Buffer.from(await res.arrayBuffer()), contentType: "audio/mpeg" };
}

/** Whisper STT. Accepts raw audio bytes; returns the transcript text. */
export async function transcribe(audio: Buffer, filename: string, env = process.env): Promise<string> {
  if (!env.OPENAI_API_KEY) throw new Error("STT needs OPENAI_API_KEY.");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), filename || "audio.webm");
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data.text ?? "";
}
