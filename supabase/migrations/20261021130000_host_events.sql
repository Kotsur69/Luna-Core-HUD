-- REMOTE_HOST_PLAN.md H2: what a phone-driven claude session on a host does
-- (src/hostchat.js -> src/hostevents.js), read back by the phone's Host page.
-- One row per event, ordered by seq within a session. The host deletes the
-- events of sessions idle for 14 days (hostevents prune()).
create table public.host_events (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  session_id uuid        not null,
  seq        integer     not null check (seq >= 0),
  host       text        not null check (length(host) between 1 and 64),
  kind       text        not null
             check (kind in ('text', 'prompt', 'tool', 'tool_result', 'permission', 'decision', 'status', 'cost')),
  data       jsonb       not null check (pg_column_size(data) < 65536),
  at         timestamptz not null default now()
);
create unique index host_events_seq_idx on public.host_events (user_id, session_id, seq);
create index host_events_host_at_idx on public.host_events (user_id, host, at);

alter table public.host_events enable row level security;

-- Only the logged-in owner sees or writes their rows.
create policy own on public.host_events for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter publication supabase_realtime add table public.host_events;
