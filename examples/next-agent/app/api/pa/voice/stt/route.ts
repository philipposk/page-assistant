import { createVoiceRoutes } from "@page-assistant/server/next";
import { currentUserId } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const { POST } = createVoiceRoutes({ getUser: () => currentUserId() }).stt;
