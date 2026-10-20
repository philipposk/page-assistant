-- The example's own table: notes, one row per note, each user sees only their own.
create table if not exists public.notes (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  title       text        not null check (char_length(title) between 1 and 200),
  body        text        not null default '' check (char_length(body) <= 10000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists notes_user_updated_idx on public.notes (user_id, updated_at desc);

alter table public.notes enable row level security;
create policy "notes select own" on public.notes for select to authenticated using ((select auth.uid()) = user_id);
create policy "notes insert own" on public.notes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "notes update own" on public.notes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "notes delete own" on public.notes for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.notes from anon;
grant select, insert, update, delete on table public.notes to authenticated;

-- Also apply, from the SDK:
--   packages/widget/supabase/assistant_chats.sql            (saved chats)
--   packages/server/supabase/assistant_pending_actions.sql  (confirm cards)
