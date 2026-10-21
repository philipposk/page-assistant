// The app's real actions, as Agent mode tools. Each one runs on the server with a Supabase
// client acting as the signed-in user (ctx.app), so row-level security decides what it can
// touch — exactly as if the user clicked the button themselves.

import { defineTool, type AgentTool } from "@page-assistant/server/agent";
import type { SupabaseClient } from "@supabase/supabase-js";

type Ctx = SupabaseClient;
type Note = { id: string; title: string; body: string; updated_at: string };

const fail = (error: string) => ({ ok: false as const, error });

export const tools: AgentTool<any, any, Ctx>[] = [
  // read: runs at once, answers in its own words (no hallucination surface).
  defineTool<{ limit?: number }, { ok: true; count: number; notes: Note[] } | { ok: false; error: string }, Ctx>({
    name: "list_notes",
    description: "List the user's most recent notes.",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "How many, 1-20" } } },
    progress: "Looking at your notes…",
    async run({ limit }, ctx) {
      const { data, error } = await ctx.app
        .from("notes")
        .select("id,title,body,updated_at")
        .order("updated_at", { ascending: false })
        .limit(Math.min(Math.max(limit ?? 10, 1), 20));
      if (error) return fail("I couldn't read your notes just now.");
      return { ok: true, count: data.length, notes: data as Note[] };
    },
    render: (r) =>
      r.ok === false
        ? r.error
        : r.count === 0
          ? "You have no notes yet."
          : `Your latest **${r.count}** notes:\n\n${r.notes.map((n) => `- [${n.title.replace(/[[\]]/g, "")}](/?note=${n.id})`).join("\n")}`,
    factKeys: ["count"],
    uiActions: () => [{ type: "highlight", anchor: "notes.list", label: "Your notes" }],
    suggestions: () => [{ label: "Add a note", prompt: "Add a note called " }],
  }),

  // read, chained: the model reads the matches and writes the answer (numbers are fact-checked).
  defineTool<{ query: string }, unknown, Ctx>({
    name: "search_notes",
    description: "Find notes whose title or text contains a word or phrase. Returns id, title and the text.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    progress: "Searching your notes…",
    async run({ query }, ctx) {
      const q = query.replace(/[%_,()]/g, " ").trim().slice(0, 100);
      const { data, error } = await ctx.app
        .from("notes")
        .select("id,title,body")
        .or(`title.ilike.%${q}%,body.ilike.%${q}%`)
        .limit(10);
      if (error) return fail("I couldn't search your notes just now.");
      return { ok: true, matches: data };
    },
    chain: true,
  }),

  // write: a change the user can take back. Runs at once.
  defineTool<{ title: string; body?: string }, { ok: true; note: Note } | { ok: false; error: string }, Ctx>({
    name: "add_note",
    description: "Create a note.",
    risk: "write",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "Short title" }, body: { type: "string" } },
      required: ["title"],
    },
    async run({ title, body }, ctx) {
      const { data, error } = await ctx.app
        .from("notes")
        .insert({ title: title.slice(0, 200), body: (body ?? "").slice(0, 10_000) })
        .select("id,title,body,updated_at")
        .single();
      if (error) return fail("I couldn't save that note.");
      return { ok: true, note: data as Note };
    },
    render: (r) => (r.ok === false ? r.error : `Added **${r.note.title}**.`),
    // A custom view-only action the notes page listens for (usePaAction("select_note")).
    uiActions: (r) => (r.ok ? [{ type: "select_note", id: r.note.id }] : []),
  }),

  // write, but asks first in a turn that read text someone else wrote.
  defineTool<{ id: string; title: string }, { ok: true; id: string; title: string } | { ok: false; error: string }, Ctx>({
    name: "rename_note",
    description: "Rename a note.",
    risk: "write",
    parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id", "title"] },
    confirmWhenTainted: { title: "Rename this note?", labels: { id: "Note", title: "New title" }, where: "Open the note and edit its title." },
    async run({ id, title }, ctx) {
      const { error, count } = await ctx.app.from("notes").update({ title: title.slice(0, 200) }, { count: "exact" }).eq("id", id);
      if (error || !count) return fail("I couldn't find that note.");
      return { ok: true, id, title };
    },
    render: (r) => (r.ok === false ? r.error : `Renamed it to **${r.title}**.`),
  }),

  // confirm: can't be undone. A model call only shows a card; the click runs it.
  defineTool<{ id: string }, { ok: true; title: string } | { ok: false; error: string }, Ctx>({
    name: "delete_note",
    description: "Delete a note for good.",
    risk: "confirm",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    confirm: {
      button: "Delete",
      where: "Open the note and use Delete.",
      // A read-only check before the card: the note exists and the card names it.
      async prepare({ id }, ctx) {
        const { data } = await ctx.app.from("notes").select("id,title").eq("id", id).maybeSingle();
        if (!data) return { ok: false, error: "I couldn't find that note." };
        return { title: "Delete this note?", details: [`Note: ${data.title}`, "This can't be undone."] };
      },
    },
    async run({ id }, ctx) {
      const { data, error } = await ctx.app.from("notes").delete().eq("id", id).select("title").maybeSingle();
      if (error || !data) return fail("That note was already gone.");
      return { ok: true, title: data.title };
    },
    render: (r) => (r.ok === false ? r.error : `Deleted **${r.title}**.`),
  }),
];

/** Places the UI exposes with data-pa-anchor (the model may only point at these). */
export const anchors = [
  { name: "notes.list", description: "the list of notes" },
  { name: "notes.add", description: "the new-note form" },
  { name: "nav.settings", description: "the Settings link in the header" },
];

export const pages = [
  { path: "/", title: "Notes", description: "all notes" },
  { path: "/settings", title: "Settings", description: "account and assistant settings" },
];

export const walkthroughs = [
  {
    id: "basics",
    title: "Notes in 20 seconds",
    description: "first steps, how notes work",
    steps: [
      { type: "navigate", to: "/" },
      { type: "narrate", text: "This is your notes page. Everything you write lives here.", speak: true },
      { type: "highlight", anchor: "notes.add", label: "Write a note here" },
      { type: "wait", ms: 1800 },
      { type: "highlight", anchor: "notes.list", label: "Your notes, newest first" },
      { type: "wait", ms: 1800 },
      { type: "narrate", text: "You can also just ask me: “add a note called groceries”.", speak: true },
    ],
  },
];
