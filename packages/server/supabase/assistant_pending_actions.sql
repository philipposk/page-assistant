-- page-assistant Agent mode: confirm cards that wait for the user's OK — reference migration
-- for Supabase.
--
-- Copy this file into your app's supabase/migrations/ (rename it with a timestamp) and apply it
-- the way you apply every other migration. It pairs with supabasePendingActionStore() from
-- @page-assistant/server/agent.
--
-- Access: server only. Row-level security is on with no policies, so the anon and
-- authenticated roles can neither read nor write a row; only the service role (which bypasses
-- RLS) can. Pass supabasePendingActionStore() a service-role client created in the route —
-- never one that reaches the browser. Why not "users own their rows": a user who could insert
-- a row could mint their own card (any tool, any arguments) and confirm it, skipping the
-- checks the server makes before it shows a card. Every query the store makes still filters
-- on the user id, so one user's click can never run another user's card.
--
-- Rows: one per card. The token itself is never stored, only its SHA-256 hash. A row is
-- deleted when its card is confirmed (DELETE ... RETURNING, so two clicks get one run), when
-- the client can't show it, or by the sweep below once it has expired.

create table if not exists public.assistant_pending_actions (
  token_hash  text        primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id     text        not null check (char_length(user_id) between 1 and 200),
  -- Keeps apps that share one table apart. The store's `app` option.
  app         text        not null default '' check (char_length(app) <= 128),
  tool        text        not null check (char_length(tool) between 1 and 64),
  args        jsonb       not null default '{}'::jsonb
                          check (jsonb_typeof(args) = 'object')
                          check (octet_length(args::text) <= 100000),
  title       text        not null check (char_length(title) <= 500),
  details     jsonb       not null default '[]'::jsonb check (jsonb_typeof(details) = 'array'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  check (expires_at > created_at and expires_at <= created_at + interval '1 day')
);

-- The sweep.
create index if not exists assistant_pending_actions_expires_idx
  on public.assistant_pending_actions (expires_at);

alter table public.assistant_pending_actions enable row level security;
-- No policies on purpose: see "Access" above.
revoke all on table public.assistant_pending_actions from anon, authenticated;
-- The store's only caller. Supabase grants this by default; said here so a project that
-- tightened its defaults still works.
grant select, insert, delete on table public.assistant_pending_actions to service_role;

-- Delete expired cards. Returns how many went.
create or replace function public.assistant_pending_actions_sweep()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.assistant_pending_actions where expires_at < now();
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke execute on function public.assistant_pending_actions_sweep() from public, anon, authenticated;
grant execute on function public.assistant_pending_actions_sweep() to service_role;

-- Every 15 minutes with pg_cron, when it is enabled (Supabase: Database → Extensions →
-- pg_cron). Re-running this file updates the same job. Without pg_cron nothing breaks:
-- an expired card is refused on confirm anyway; the rows just linger until a sweep runs.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'assistant-pending-actions-sweep',
      '*/15 * * * *',
      'select public.assistant_pending_actions_sweep()'
    );
  else
    raise notice 'pg_cron is not enabled: expired assistant_pending_actions rows stay until public.assistant_pending_actions_sweep() runs.';
  end if;
end;
$$;
