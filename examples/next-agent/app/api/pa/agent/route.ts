// The whole Agent mode backend: auth, the app's tools, the model call, confirm cards.
import { createAgentRoute } from "@page-assistant/server/next";
import { supabasePendingActionStore } from "@page-assistant/server/agent";
import { currentUserId, supabaseForUser, supabaseService } from "@/lib/supabase/server";
import { anchors, pages, tools, walkthroughs } from "@/lib/agent/tools";

export const runtime = "nodejs";
// The agent ends every turn by 50 s (PA_AGENT_TURN_DEADLINE_MS); give the function a little more.
export const maxDuration = 60;

export const { GET, POST } = createAgentRoute({
  appName: "Notes",
  assistantName: "Ada",
  // Every request must be signed in: turns spend model credit and tools act as the user.
  getUser: () => currentUserId(),
  // Tools get a Supabase client acting as this user (ctx.app), so RLS applies.
  context: () => supabaseForUser(),
  tools,
  anchors,
  pages,
  walkthroughs,
  // Confirm cards must survive serverless instances: keep them in Postgres.
  pendingActions: supabasePendingActionStore(supabaseService(), { app: "notes" }),
  refusals: [{ match: /\b(delete|close) my account\b/i, message: "I can't do that one. Go to [Settings](/settings) → Account." }],
  intro: {
    text: "Hi, I'm Ada. I can find, add, rename and delete your notes, and show you around.",
    suggestions: [
      { label: "Show me around", prompt: "Give me a quick tour" },
      { label: "My notes", prompt: "What are my latest notes?" },
    ],
  },
});
