// Signed-in voice routes on the web-standard Request/Response, for the Agent dock's mic and
// read-aloud: text-to-speech (ElevenLabs, else OpenAI) and speech-to-text (Whisper). Keys
// stay on the server. In Next.js:
//
//   // app/api/pa/voice/tts/route.ts
//   export const { POST } = createVoiceRoutes({ getUser }).tts;
//   // app/api/pa/voice/stt/route.ts
//   export const { POST } = createVoiceRoutes({ getUser }).stt;

import { synthesize, transcribe } from "../voice.js";
import { memoryLimiter, type RateDecision } from "./handler.js";
import { crossSiteRefusal, readLimited } from "./http.js";
import type { AgentUser } from "./types.js";

export interface VoiceRouteOptions {
  getUser: (req: Request) => Promise<AgentUser | string | null | undefined> | AgentUser | string | null | undefined;
  /** Per-user calls a minute (in memory). Default 20; false turns it off. */
  perMinute?: number | false;
  /** Largest recording in bytes. Default 5 MB. */
  maxAudioBytes?: number;
}

export function createVoiceRoutes(opts: VoiceRouteOptions) {
  const limit = opts.perMinute === false ? null : memoryLimiter(opts.perMinute ?? 20, 0);
  const maxBytes = opts.maxAudioBytes ?? 5 * 1024 * 1024;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

  async function gate(req: Request): Promise<Response | null> {
    const crossSite = crossSiteRefusal(req);
    if (crossSite) return json({ error: crossSite }, 403);
    let user: AgentUser | string | null | undefined;
    try {
      user = await opts.getUser(req);
    } catch {
      user = null;
    }
    const id = typeof user === "string" ? user : user?.id;
    if (!id) return json({ error: "Sign in to use voice." }, 401);
    if (limit) {
      const d: RateDecision = await limit({ id });
      if (!d.ok) return json({ error: "Too many voice requests. Try again in a minute." }, 429, { "retry-after": String(d.retryAfterSeconds ?? 60) });
    }
    return null;
  }

  const tts = async (req: Request): Promise<Response> => {
    const denied = await gate(req);
    if (denied) return denied;
    let body: { text?: unknown; lang?: unknown; voiceId?: unknown };
    try {
      const raw = await readLimited(req, 16 * 1024);
      if (!raw) return json({ error: "text too long (max 2000 chars)" }, 400);
      body = (JSON.parse(new TextDecoder().decode(raw) || "{}") ?? {}) as typeof body;
    } catch {
      return json({ error: "The request body must be JSON." }, 400);
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text required" }, 400);
    if (text.length > 2000) return json({ error: "text too long (max 2000 chars)" }, 400);
    try {
      const { audio, contentType } = await synthesize({
        text,
        lang: typeof body.lang === "string" ? body.lang : undefined,
        voiceId: typeof body.voiceId === "string" ? body.voiceId : undefined,
      });
      return new Response(new Uint8Array(audio), { status: 200, headers: { "content-type": contentType, "cache-control": "no-store" } });
    } catch {
      return json({ error: "Voice is unavailable right now." }, 502);
    }
  };

  const stt = async (req: Request): Promise<Response> => {
    const denied = await gate(req);
    if (denied) return denied;
    const raw = await readLimited(req, maxBytes);
    if (!raw) return json({ error: `audio too large (max ${maxBytes} bytes)` }, 400);
    const buf = Buffer.from(raw);
    if (!buf.length) return json({ error: "audio body required" }, 400);
    try {
      const text = await transcribe(buf, {
        hint: req.headers.get("x-audio-content-type") ?? undefined,
        lang: req.headers.get("x-audio-lang") ?? undefined,
      });
      return json({ text });
    } catch {
      return json({ error: "Voice is unavailable right now." }, 502);
    }
  };

  return { tts: { POST: tts }, stt: { POST: stt } };
}
