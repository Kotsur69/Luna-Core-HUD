-- REMOTE_HOST_PLAN.md H1: a PC in host mode puts a `host` snapshot every 30 s
-- (its heartbeat + what the phone may pick from). Re-adds the kind check with
-- every existing kind plus 'host'.
alter table public.snapshots drop constraint snapshots_kind_check;
alter table public.snapshots add constraint snapshots_kind_check
  check (kind in ('ledger', 'news', 'yazio', 'usage', 'repos', 'godmode', 'host'));
