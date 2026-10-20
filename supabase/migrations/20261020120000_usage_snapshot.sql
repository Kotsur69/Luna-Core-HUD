-- REMOTE_HOST_PLAN.md U1: each PC puts its Claude usage limits (5 h + weekly)
-- as a `usage` snapshot; the phone shows the newest one.
alter table public.snapshots drop constraint snapshots_kind_check;
alter table public.snapshots add constraint snapshots_kind_check
  check (kind in ('ledger', 'news', 'yazio', 'usage'));
