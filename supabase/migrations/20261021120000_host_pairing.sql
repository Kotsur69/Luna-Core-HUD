-- REMOTE_HOST_PLAN.md H1, "Passkey + session key".
--
-- 1. host_pairings: the phone offers a passkey to one host (commit-reveal,
--    see src/hostcanon.js). The cloud only carries the request: the host
--    stores the key in host-keys.local.json after Mati confirms the 6-digit
--    code on its own screen, and never reads it from here again.
-- 2. host_commands.grant: the passkey-signed session grant that goes with a
--    command (src/hostauth.js verifies both). The database checks only size.
create table public.host_pairings (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users on delete cascade,
  host          text        not null check (length(host) between 1 and 64),
  label         text        check (label is null or length(label) <= 64),
  credential_id text        not null check (length(credential_id) between 16 and 1400),
  public_key    text        not null check (length(public_key) between 64 and 400),
  commitment    text        not null check (length(commitment) = 43),
  host_nonce    text        check (host_nonce is null or length(host_nonce) between 22 and 64),
  phone_nonce   text        check (phone_nonce is null or length(phone_nonce) between 22 and 64),
  status        text        not null default 'pending'
                check (status in ('pending', 'confirmed', 'rejected')),
  created_at    timestamptz not null default now()
);
create index host_pairings_pending_idx on public.host_pairings (user_id, host, status, created_at);

alter table public.host_pairings enable row level security;

create policy own on public.host_pairings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter publication supabase_realtime add table public.host_pairings;

alter table public.host_commands
  add column "grant" jsonb check ("grant" is null or pg_column_size("grant") < 16384);
