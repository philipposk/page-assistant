import { supabaseForUser } from "@/lib/supabase/server";
import { NotesList } from "@/components/NotesList";

export const dynamic = "force-dynamic";

export default async function NotesPage() {
  const supabase = await supabaseForUser();
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return <p><a href="/login">Sign in</a> to see your notes.</p>;
  const { data } = await supabase.from("notes").select("id,title,body,updated_at").order("updated_at", { ascending: false }).limit(50);
  return <NotesList notes={data ?? []} />;
}
