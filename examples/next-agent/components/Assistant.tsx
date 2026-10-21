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
  // Who is signed in. The dock clears its open chat when this changes, so the next person to
  // sign in on this tab never sees the last one's conversation.
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    const supabase = supabaseBrowser();
    setHistory(supabaseChatHistoryAdapter(supabase, { app: "notes" }));
    void supabase.auth.getUser().then(({ data }: { data: { user: { id: string } | null } }) => setUserId(data.user?.id ?? null));
    const { data } = supabase.auth.onAuthStateChange((_event: string, session: { user: { id: string } } | null) => setUserId(session?.user.id ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  return (
    <AgentDock
      endpoint="/api/pa/agent"
      navigate={(path) => router.push(path)}
      history={history}
      userId={userId}
      voice
      accentColor="#0f766e"
      // The page as data for the model: which note is open.
      getPageState={() => ({ openNote: new URLSearchParams(location.search).get("note") })}
    />
  );
}
