# Cloud sync + iPhone companion — plan

Status: **confirmed by Mati 2026-10-14, nothing implemented yet.** Start at
"Next session: start here". Decisions below are settled — don't re-ask them.

## Goal

1. Replace the Syncthing / SyncTrayzor shared folder with Supabase, so a to-do or
   expense added on one LunaCore shows up on every other one within seconds.
2. An iPhone companion (installable web app on Vercel) with Mission Control and
   Life, working even when every PC is off.

## Settled decisions

| Topic | Decision |
|---|---|
| Backend | **Supabase free tier** (Postgres, access rules, live updates, server functions). Not Neon: no built-in login or live updates. |
| Google Drive | Not the live store. Optional nightly JSON backup to Drive later (narrow "files this app created" permission). |
| Login | **GitHub** via Supabase Auth, both desktop and phone. Supabase account itself also via GitHub. |
| Who can log in | Only Mati. Turn **off** "Allow new users to sign up" after the first login. |
| Conflicts | Mati never uses two PCs at once (work PC 7–15, home PC ~18, phone in between). Newest change wins **per unit**; deletes leave a marker. Same rules as `lifesync.js` / `todosync.js`. |
| News | **Stays PC-only** (same Claude subscription on every PC, `claude -p --model haiku`). A PC pushes the last briefing; the phone shows it with "from HH:MM, <machine>". No Anthropic API key. |
| Calendar on phone | View **and add** events. |
| Phone hosting | Vercel. |
| Phone stack | Plain JS + Vite + PWA plugin in `mobile/`, reusing the budget maths files. |
| Phone scope | Kept: calendar, hourly weather, news, Claude ledger, mail summary, to-dos (add/tick), budget (full: quick add, buckets, charts), bills (mark paid), savings (edit/add), YAZIO Body. Not on phone: GitHub panel, focus/commits, mission projects, everything system/dev (devices, ports, GPU, LM Studio, MCP health, diagnostics, repos, git, worktrees, orchestra, skills, profiles, cheatsheets, prompts, scratchpad, clipboard, screenshots, sounds). |
| Tailscale | Not needed. |

## What gets synced — file inventory

Local config lives in `config/` in a dev clone and in the user config dir in a
packaged build (`src/paths.js` → `paths.local()`).

### A. Synced items (`sync_units` table, newest wins per unit)

| File | Scope | Unit key | Notes |
|---|---|---|---|
| `life-budget.local.json` | `life` | as in `src/lifesync.js`: `income`, `c:/e:/b:/g:/d:<id>`, `p:<YYYY-MM>:<billId>` | Unit model already written and committed (`ed6efaa`). Only the transport changes. |
| `todo.local.json` | `todos` | `<projectKey>:<at>` | Project key = normalised git remote (`missionrepokey.js`). **Change from `todosync.js`:** `local:*` buckets (home, safetyhub-bhp, …) sync too, keyed by name — the phone has no repos. |
| `mission-news.local.json` | `config` | `news:source:<id>`, `news:topic:<id>` | Sources (18) and topics. Briefing/articles are a snapshot (section B). |
| `missioncontrol.local.json` | `config` | `mc:rules` (whole doc) | Inbox / Mission Control rules. Not on KT-PC-LLM yet; create on first write. |
| `mission-projects.local.json` | `config` | `proj:class:<projectKey>`, `proj:pinned` | `classes` (work/fun/other) + `pinned`. **`sharedDir` stays per machine** and is removed in phase 3. |

**Candidates — ask Mati at the start of phase 2** (machine-independent content,
whole-doc newest-wins in scope `config`): `prompts.local.json`,
`cheatsheets.local.json`, `layouts.local.json`, `themes.local.json`,
`libraries.local.json`, `rates.local.json`, `scratchpad.local.md`, and a whitelist of `ui.local.json` keys (`theme`, `lang`,
sound/voice settings — not `windowMaterial`, `boot`, `layout`).
`projects.local.json` holds launcher paths: per machine unless Mati says otherwise.

### B. Snapshots (`snapshots` table, one row per machine, written only by that PC)

| Kind | Source today | Who reads it |
|---|---|---|
| `ledger` | `<sharedDir>/ledger-<machine>.json` (`missionledgersync.js`: hourly token rows + focus blocks) | Every PC (combined weekly limit), phone |
| `news` | Latest briefing + articles (`missionnews.js`, `missionnewsstore.js`, `news-links.json` in userData) | Phone, other PCs |
| `yazio` | Body tab data fetched by `lifeyazio.js` | Phone, other PCs |

### C. Never synced

- **Secrets:** `gcal-token.local.json`, `google-oauth.local.json`,
  `yazio-cred.local.json`, legacy `yazio.local.json`, `profiles.local.json`
  (provider keys), the cloud session file. Each PC logs in to these itself.
  The phone's Google access comes from a server-side token (phase 5), never from these.
- **Machine-bound:** `repos.local.json` (paths, roots), `editor.local.json`,
  `keepawake.local.json`, `mcp-intake-*.local.json`, `orchestra.local.json`,
  `agent-reach-venv/`, Electron caches.
- **Clipboard history** (`clipboard.local.json`): may contain passwords. Never.
- **Sync bookkeeping:** `todo-sync.local.json`, `life-sync.local.json`. Replaced
  by the cloud cursor/queue file once the folder transport is gone.

## Database (phase 1)

```sql
create sequence sync_rev;

create table sync_units (
  user_id    uuid   not null default auth.uid() references auth.users on delete cascade,
  scope      text   not null check (scope in ('life', 'todos', 'config')),
  key        text   not null check (length(key) between 1 and 200),
  value      jsonb,
  u          bigint not null,          -- client change time, ms
  deleted_at bigint,                   -- tombstone, ms
  machine    text   not null check (length(machine) <= 64),
  rev        bigint not null default nextval('sync_rev'),  -- server order, pull cursor
  primary key (user_id, scope, key),
  check (pg_column_size(value) < 16384)
);
create index on sync_units (user_id, scope, rev);

create table snapshots (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  kind       text not null check (kind in ('ledger', 'news', 'yazio')),
  machine    text not null check (length(machine) <= 64),
  data       jsonb not null check (pg_column_size(data) < 1048576),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, machine)
);

alter table sync_units enable row level security;
alter table snapshots  enable row level security;
create policy own on sync_units for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on snapshots  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Newest wins, decided on the server. security invoker -> RLS applies.
create function push_units(p_scope text, p_machine text, p_units jsonb)
returns void language sql security invoker as $$
  insert into sync_units (scope, key, value, u, deleted_at, machine)
  select p_scope, x->>'k', x->'v', (x->>'u')::bigint, (x->>'d')::bigint, p_machine
  from jsonb_array_elements(p_units) x
  on conflict (user_id, scope, key) do update
    set value = excluded.value, u = excluded.u, deleted_at = excluded.deleted_at,
        machine = excluded.machine, rev = nextval('sync_rev')
    where excluded.u > sync_units.u;
$$;

alter publication supabase_realtime add table sync_units, snapshots;
```

- Pull: `select … where scope = $1 and rev > $cursor order by rev limit 1000`, repeat until empty.
- Live updates only trigger a pull. Don't apply the event payload directly; the pull is the single path.
- Compare units by `u`, never by `JSON.stringify` of jsonb. Postgres reorders object keys.
- Pulled values are still untrusted: run them through `lifebudget.normalize()` /
  the to-do validators, exactly as peer files are today.

## Desktop (phase 2–3)

| Piece | What |
|---|---|
| `config/cloud.local.json` | Supabase project URL + public key. **Not** in a shipped `config/*.json`: the repo is public. No cloud file = cloud sync off, folder sync as today. |
| `src/cloudauth.js` | GitHub login: Supabase PKCE, system browser, loopback redirect `http://127.0.0.1:<random port>/callback`. Session encrypted with `safeStorage` in `cloud-session.local.json` (same pattern as `lifeyazio.js`). |
| `src/cloudsync.js` | Transport: push pending units (`push_units`), pull since cursor, live subscription, offline queue. State in `cloud-sync.local.json` (`{cursor: {life, todos, config}, pending: [...]}`). |
| Refactor `lifesync.js` / `todosync.js` | Split "diff local vs last snapshot → changed units" and "apply merged units to local file" away from the folder I/O, so both transports share them. Existing tests must stay green. |
| Snapshot push | `missionledgerservice.js`, news store, YAZIO → `snapshots` upsert after each local refresh. Ledger readers merge cloud rows of other machines. |
| IPC (`preload.js`) | `cloud:status`, `cloud:login`, `cloud:logout`, `cloud:syncNow`. No tokens ever reach the renderer; validate in main. **Security review required.** |
| UI | "Cloud" card: logged in as, last sync, pending count, Sync now, Log out. New strings in `pl` + `en`. |
| Dependency | `@supabase/supabase-js` in main. **Probe first:** live updates need `WebSocket` in Electron's Node; if missing, pass `ws` as the transport. Verify with a real connection before building on it. |

**Migration:** Syncthing was never paired with the other two PCs (only
KT-PC-LLM writes to `C:\Users\mmazur\LunaLedger`), so there is no multi-PC
history to reconcile. The first PC that logs in uploads all its units with their
existing `u` stamps (from `life-sync.local.json` / `todo-sync.local.json`).
The second PC pulls and merges. Syncthing keeps running in parallel for about a
week. Phase 3 then removes the folder transport, `sharedDir`, and SyncTrayzor.

## Phone (phase 4)

- `mobile/` — Vite + `vite-plugin-pwa`, plain JS, `@supabase/supabase-js`.
  Vercel project root `mobile/`, env `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- **Risk:** `lifebudgetcalc.js`, `lifebudgetdates.js` and `lifebudgettrend.js`
  are CommonJS. Check how Vite bundles them from outside `mobile/`. If that's
  messy, give them an ESM-compatible shape without breaking `node --test`.
- Navigation: slide-out side bar.
  - **Mission:** Today (calendar + hourly weather), News (snapshot), Claude
    ledger, Mail summary.
  - **To-dos**
  - **Life:** Quick add (main action), Overview + charts, Bills, Savings, Body.
- Offline: writes queue in IndexedDB and push on reconnect, with the same unit model.
- iOS: Add to Home Screen (needed for reliable storage and, later, notifications).
- Weather: Open-Meteo directly from the phone (free, no key).
- Design pass with the `ui-ux-pro-max` skill when phase 4 starts. Dark HUD look.

## Google server function (phase 5)

- Supabase Edge Function `google`: list events (range), create event, mail
  summary (unread count + latest subjects). It checks the Supabase login token on every call.
- Google refresh token stored as a Supabase secret, obtained once.
- **Before this:** switch the Google OAuth app to "In production". In "Testing"
  status, refresh tokens expire after 7 days. Use Mati's personal Google
  account, not the company Workspace.

## What Mati does himself (can't be done from here)

1. Create the Supabase account with GitHub. Next session: check what the
   connected Supabase tools see (`list_organizations`) and create the project there.
2. Create a GitHub OAuth App (github.com/settings/developers), callback
   `https://<project-ref>.supabase.co/auth/v1/callback`, and paste the
   client ID/secret into Supabase → Auth → Providers → GitHub.
3. Phase 4: Vercel account via GitHub.
4. Phase 5: Google OAuth app → "In production".

## Next session: start here

1. Re-read this file. Check `git log` for anything newer touching `lifesync.js` / `todosync.js`.
2. Phase 1: create the Supabase project, apply the SQL above as a migration, run
   `get_advisors` (security), and check the project's `*.supabase.co` address is
   reachable from the work PC.
3. Probe `@supabase/supabase-js` inside Electron main: login, `push_units`, pull, live event.
4. Ask the candidates question (section A), then `/plan` phase 2 in detail.
