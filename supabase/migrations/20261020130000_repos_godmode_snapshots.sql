-- REMOTE_HOST_PLAN.md U2: each PC puts its git-station repo status as a
-- `repos` snapshot and its last God Mode runs as a `godmode` snapshot; the
-- phone shows both.
alter table public.snapshots drop constraint snapshots_kind_check;
alter table public.snapshots add constraint snapshots_kind_check
  check (kind in ('ledger', 'news', 'yazio', 'usage', 'repos', 'godmode'));
