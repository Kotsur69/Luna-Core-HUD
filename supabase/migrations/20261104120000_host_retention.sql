-- REMOTE_HOST_PLAN.md "Security review", JS LOW: retention for host_commands
-- and push_sent (host_events already has its own prune in src/hostevents.js).
--
-- 1. host_commands: only finished rows (done / refused / failed) older than
--    the retention go. A row still pending ('new' or 'claimed') is never
--    removed, whatever its age: the host may still claim, run or finish it.
-- 2. push_sent: a dedupe key only has to outlive its event. A claim in
--    flight is seconds old; after the retention a key is history. A host that
--    stays offline longer than that may get its "offline" push once more.
--
-- Replay: a deleted row frees its nonce in host_commands_nonce_idx, but a
-- copy can't run again: every command carries a signed expires_at of at most
-- 2 min (src/hostcommands.js MAX_TTL_MS) and the host keeps its own nonce
-- store (src/hostauth.js), so the retention never reopens a replay.
--
-- prune_host_retention() is not callable by anon or logged-in users (a stolen
-- session can't wipe history with it); pg_cron runs it once a day as the
-- database owner. create or replace + cron.schedule() with a job name (which
-- replaces a job of that name) make re-running this file safe.
create or replace function public.prune_host_retention(p_days integer default 30)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cutoff   timestamptz;
  v_commands integer;
  v_push     integer;
begin
  if p_days is null or p_days < 7 or p_days > 3650 then
    raise exception 'retention must be 7..3650 days';
  end if;
  v_cutoff := now() - make_interval(days => p_days);

  delete from public.host_commands
  where status in ('done', 'refused', 'failed')
    and created_at < v_cutoff;
  get diagnostics v_commands = row_count;

  delete from public.push_sent
  where at < v_cutoff;
  get diagnostics v_push = row_count;

  return jsonb_build_object('host_commands', v_commands, 'push_sent', v_push);
end;
$$;

revoke execute on function public.prune_host_retention(integer) from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;

-- 03:17 UTC daily, off the full hour other jobs crowd.
select cron.schedule('lunacore-host-retention', '17 3 * * *', $$select public.prune_host_retention(30)$$);
