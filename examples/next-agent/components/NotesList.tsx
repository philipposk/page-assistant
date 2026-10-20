"use client";

import { paAnchor, usePaAction } from "@page-assistant/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

type Note = { id: string; title: string; body: string; updated_at: string };

export function NotesList({ notes }: { notes: Note[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [selected, setSelected] = useState<string | null>(params.get("note"));

  // A custom, view-only UI action from the add_note tool. Replayed if it fired just before
  // this page mounted (after a navigate).
  usePaAction<{ id: string }>("select_note", ({ id }) => {
    setSelected(id);
    router.refresh();
  });

  return (
    <>
      <form {...paAnchor("notes.add")} action="#" style={{ marginBottom: 16 }}>
        <em>New notes: ask the assistant, e.g. “add a note called groceries”.</em>
      </form>
      <ul {...paAnchor("notes.list")} style={{ listStyle: "none", padding: 0 }}>
        {notes.map((n) => (
          <li key={n.id} style={{ padding: 8, borderRadius: 8, background: n.id === selected ? "#ecfdf5" : undefined }}>
            <strong>{n.title}</strong>
            <div style={{ color: "#6b7280", fontSize: 13 }}>{n.body.slice(0, 120)}</div>
          </li>
        ))}
      </ul>
    </>
  );
}
