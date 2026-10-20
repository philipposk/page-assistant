"use client";

import { AgentDock, supabaseChatHistoryAdapter, type ChatHistoryAdapter } from "@page-assistant/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export function Assistant() {
  const router = useRouter();
  // Chats saved per user in the assistant_chats table (RLS: each user sees only their own).
  // Built in the browser only: the Supabase browser client must not run during prerender.
  const [history, setHistory] = useState<ChatHistoryAdapter | false>(false);
  useEffect(() => setHistory(supabaseChatHistoryAdapter(supabaseBrowser(), { app: "notes" })), []);
  return (
    <AgentDock
      endpoint="/api/pa/agent"
      navigate={(path) => router.push(path)}
      history={history}
      voice
      accentColor="#0f766e"
      // The page as data for the model: which note is open.
      getPageState={() => ({ openNote: new URLSearchParams(location.search).get("note") })}
    />
  );
}
