# Agent mode example — Next.js + Supabase

A notes app with an assistant ("Ada") that lists, searches, adds, renames and deletes notes,
points at controls and gives a guided tour. Everything the assistant does runs on the server as
the signed-in user (Supabase row-level security), and deleting a note needs a click on a
confirm card.

| File | What |
|---|---|
| `app/api/pa/agent/route.ts` | The whole backend: `createAgentRoute({ getUser, context, tools, ... })` |
| `lib/agent/tools.ts` | The tools, one per risk tier, plus anchors, pages and a walkthrough |
| `components/Assistant.tsx` | `<AgentDock>` with the router, Supabase chat history and voice |
| `components/NotesList.tsx` | `data-pa-anchor` places and a custom UI action (`usePaAction`) |
| `app/api/pa/voice/*` | Signed-in mic and read-aloud routes |
| `supabase/migrations/0001_notes.sql` | The notes table (plus the SDK's two SQL files, see the end of it) |
| `app/login/page.tsx` | A minimal sign-in so the example runs end to end |

Run it (from the SDK checkout):

```bash
npm ci && npm run build            # at the repo root: builds the packages this links to
cd examples/next-agent
cp .env.example .env.local         # fill in a model key and your Supabase project
npm install
npx next dev
```

Apply `supabase/migrations/0001_notes.sql`, `packages/widget/supabase/assistant_chats.sql` and
`packages/server/supabase/assistant_pending_actions.sql` to your Supabase project, then sign up
at `/login` (email + password; turn off "Confirm email" in Supabase Auth for a quick local try).
