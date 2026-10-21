-- REMOTE_HOST_PLAN.md H1: the phone asks a host to do something through a
-- signed row; the host claims it (new -> claimed in one update), runs it and
-- writes the result. The signature is checked on the host (src/hostauth.js):
-- the database only keeps rows apart per user.
create table public.host_commands (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  host       text        not null check (length(host) between 1 and 64),
  kind       text        not null check (length(kind) between 1 and 64),
  payload    jsonb       not null default '{}'::jsonb check (pg_column_size(payload) < 65536),
  nonce      text        not null check (length(nonce) between 8 and 128),
  expires_at timestamptz not null,
  sig        text        not null check (length(sig) between 1 and 4096),
  status     text        not null default 'new'
             check (status in ('new', 'claimed', 'done', 'refused', 'failed')),
  result     jsonb       check (result is null or pg_column_size(result) < 262144),
  created_at timestamptz not null default now()
);
-- A signed command can be stored once: a copied row (same nonce) is refused here.
create unique index host_commands_nonce_idx on public.host_commands (user_id, nonce);
create index host_commands_pending_idx on public.host_commands (user_id, host, status, created_at);

alter table public.host_commands enable row level security;

-- Only the logged-in owner sees or writes their rows.
create policy own on public.host_commands for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter publication supabase_realtime add table public.host_commands;
