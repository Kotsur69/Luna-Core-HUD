-- Cloud sync, phase 1 (docs/DONE_CLOUD_SYNC_PLAN.md).
-- sync_units: one row per synced unit, newest client change wins per unit.
-- snapshots: one row per (kind, machine), written only by that machine.

create sequence public.sync_rev;

create table public.sync_units (
  user_id    uuid   not null default auth.uid() references auth.users on delete cascade,
  scope      text   not null check (scope in ('life', 'todos', 'config')),
  key        text   not null check (length(key) between 1 and 200),
  value      jsonb,
  u          bigint not null,          -- client change time, ms
  deleted_at bigint,                   -- tombstone, ms
  machine    text   not null check (length(machine) between 1 and 64),
  rev        bigint not null default nextval('public.sync_rev'),  -- server order, pull cursor
  primary key (user_id, scope, key),
  check (pg_column_size(value) < 16384)
);
create index sync_units_pull_idx on public.sync_units (user_id, scope, rev);

create table public.snapshots (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  kind       text not null check (kind in ('ledger', 'news', 'yazio')),
  machine    text not null check (length(machine) between 1 and 64),
  data       jsonb not null check (pg_column_size(data) < 1048576),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, machine)
);

alter table public.sync_units enable row level security;
alter table public.snapshots  enable row level security;

-- Only the logged-in owner sees or writes their rows. (select auth.uid())
-- is evaluated once per statement instead of once per row.
create policy own on public.sync_units for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own on public.snapshots for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Newest wins, decided on the server. security invoker -> RLS still applies.
create function public.push_units(p_scope text, p_machine text, p_units jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_scope not in ('life', 'todos', 'config') then
    raise exception 'bad scope';
  end if;
  if jsonb_typeof(p_units) <> 'array' or jsonb_array_length(p_units) > 500 then
    raise exception 'units must be an array of at most 500';
  end if;

  insert into public.sync_units (scope, key, value, u, deleted_at, machine)
  select p_scope, x->>'k', x->'v', (x->>'u')::bigint, (x->>'d')::bigint, p_machine
  from jsonb_array_elements(p_units) x
  on conflict (user_id, scope, key) do update
    set value = excluded.value, u = excluded.u, deleted_at = excluded.deleted_at,
        machine = excluded.machine, rev = nextval('public.sync_rev')
    where excluded.u > public.sync_units.u;
end;
$$;

revoke execute on function public.push_units(text, text, jsonb) from public, anon;
grant execute on function public.push_units(text, text, jsonb) to authenticated;

alter publication supabase_realtime add table public.sync_units, public.snapshots;
