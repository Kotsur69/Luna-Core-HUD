-- Luna Core Memory, phase 1 (docs/untouched_docs/rag-stylememory.md, decision 7).
-- A fourth sync scope, `memory`: one unit per memory, key `<project>/<id>`,
-- value the memory record. Same table, same newest-wins rule, same RLS.
-- The only change is the list of allowed scopes, in the column check and in
-- push_units. Nothing existing is rewritten.

alter table public.sync_units drop constraint sync_units_scope_check;
alter table public.sync_units
  add constraint sync_units_scope_check check (scope in ('life', 'todos', 'config', 'memory'));

-- Same body as 20261014120000_cloud_sync.sql, with `memory` allowed.
create or replace function public.push_units(p_scope text, p_machine text, p_units jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_scope not in ('life', 'todos', 'config', 'memory') then
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
