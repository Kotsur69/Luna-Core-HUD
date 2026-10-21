-- REMOTE_HOST_PLAN.md H4, Web Push.
--
-- 1. push_subscriptions: the phone's PushManager subscription (endpoint +
--    keys), written by the phone itself. The `push` edge function reads them
--    with the service role and drops the ones the push service answers 404/410.
-- 2. push_sent: one row per notification key, so each event fires once
--    (approval, session done/failed, host offline, usage 80 %/95 % per
--    window). Only the edge function (service role) touches it: RLS on, no
--    policy for logged-in users.
create table public.push_subscriptions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  endpoint   text        not null check (endpoint ~ '^https://' and length(endpoint) <= 1024),
  p256dh     text        not null check (length(p256dh) between 40 and 200),
  auth       text        not null check (length(auth) between 10 and 100),
  created_at timestamptz not null default now()
);
create unique index push_subscriptions_endpoint_idx on public.push_subscriptions (user_id, endpoint);

alter table public.push_subscriptions enable row level security;

create policy own on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.push_sent (
  user_id uuid        not null references auth.users on delete cascade,
  key     text        not null check (length(key) between 1 and 160),
  at      timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.push_sent enable row level security;
