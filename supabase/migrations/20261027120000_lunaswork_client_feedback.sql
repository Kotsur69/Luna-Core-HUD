-- LUNAS_WORK_PLAN.md B17, LW 3.28b: the client feedback widget on staging builds.
--
-- 1. lunaswork_widget_tokens: one row per Luna's Work run with a staging
--    widget. Written by the owner's LunaCore (its session): the SHA-256 hash
--    of the random token baked into the staging build - never the token -
--    the staging origin it is good for, an expiry, and revoked_at once the
--    run ended.
-- 2. lunaswork_client_feedback: what a client sent through the widget. Only
--    the `lunaswork-feedback` edge function writes it (service role, after
--    checking the token, the caps and the rate limit); the owner's LunaCore
--    reads its rows and deletes each one it took into the run.
-- 3. lunaswork_widget_hits: one row per accepted request, for the rate limit
--    per token and per (salted, hashed) client IP. Service role only.
create table public.lunaswork_widget_tokens (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  run_id     text        not null check (run_id ~ '^[a-z0-9]{1,40}$'),
  token_hash text        not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  origin     text        not null check (origin ~ '^https?://[^/[:space:]]+$' and length(origin) <= 300),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index lunaswork_widget_tokens_run_idx on public.lunaswork_widget_tokens (user_id, run_id);

alter table public.lunaswork_widget_tokens enable row level security;

create policy own_select on public.lunaswork_widget_tokens for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_insert on public.lunaswork_widget_tokens for insert to authenticated
  with check (user_id = (select auth.uid()));
-- Revoking (revoked_at) and extending (expires_at) a token of one's own.
create policy own_update on public.lunaswork_widget_tokens for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.lunaswork_client_feedback (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null references auth.users on delete cascade,
  token_id   uuid        not null references public.lunaswork_widget_tokens on delete cascade,
  run_id     text        not null check (run_id ~ '^[a-z0-9]{1,40}$'),
  text       text        not null check (length(text) between 1 and 800),
  page_url   text        check (page_url is null or (length(page_url) <= 500 and page_url ~ '^https?://')),
  screenshot text        check (screenshot is null or (length(screenshot) <= 700000 and screenshot ~ '^data:image/(jpeg|png);base64,')),
  created_at timestamptz not null default now()
);
create index lunaswork_client_feedback_run_idx on public.lunaswork_client_feedback (user_id, run_id, id);
create index lunaswork_client_feedback_token_idx on public.lunaswork_client_feedback (token_id);

alter table public.lunaswork_client_feedback enable row level security;

-- No insert / update policy: only the edge function (service role) writes.
create policy own_select on public.lunaswork_client_feedback for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_delete on public.lunaswork_client_feedback for delete to authenticated
  using (user_id = (select auth.uid()));

create table public.lunaswork_widget_hits (
  id       bigint      generated always as identity primary key,
  token_id uuid        not null references public.lunaswork_widget_tokens on delete cascade,
  ip_hash  text        not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  at       timestamptz not null default now()
);
create index lunaswork_widget_hits_token_idx on public.lunaswork_widget_hits (token_id, at);
create index lunaswork_widget_hits_ip_idx on public.lunaswork_widget_hits (ip_hash, at);
create index lunaswork_widget_hits_at_idx on public.lunaswork_widget_hits (at);

-- RLS on, no policy: the edge function (service role) only.
alter table public.lunaswork_widget_hits enable row level security;
