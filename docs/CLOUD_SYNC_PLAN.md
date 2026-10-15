# Cloud sync + iPhone companion — plan

Status: **confirmed by Mati 2026-10-14. Phase 1 database applied 2026-10-14.
Phase 2a (login + budget + to-dos over the cloud) shipped 2026-10-15**, live on
KT-PC-LLM only so far
to project `phkigyuhvbanadwmxqqs` ("Kotsur69's Project", `eu-west-1`,
`https://phkigyuhvbanadwmxqqs.supabase.co`) — schema in
`supabase/migrations/`. Security advisor: clean (RPC execute on Supabase's own
`rls_auto_enable()` event-trigger helper revoked). Start at "Next session: start here". Decisions below are settled
— don't re-ask them.

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

**Candidates — answered 2026-10-14:** sync `prompts.local.json`,
`cheatsheets.local.json`, `libraries.local.json`, `rates.local.json` (whole
doc, newest wins, scope `config`, keys `doc:<file>`). **Not synced:** layouts,
themes, scratchpad, and no `ui.local.json` keys at all. Original question
kept below for reference.

~~Candidates — ask Mati at the start of phase 2~~ (machine-independent content,
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

## Phase 1 results (2026-10-14) ✅

- Steps 1–2 of "What Mati does himself" are done: GitHub OAuth App "LunaCore",
  provider enabled in Supabase, redirect allow-list `http://127.0.0.1:*/callback`.
  Mati's account exists (first login 2026-10-14); **sign-ups are off**
  (`disable_signup: true` verified), anonymous sign-ins and manual linking off.
- Applied SQL = `supabase/migrations/` (differs from the sketch above:
  policies `to authenticated` with `(select auth.uid())`, `push_units` is
  plpgsql with `search_path = ''`, rejects unknown scopes and > 500 units,
  execute revoked from `anon`). Advisors: security clean.
- **Live probe in Electron 43 main (Node 24), all green:** global `WebSocket`
  exists (no `ws` needed); GitHub login with PKCE + system browser + loopback
  on a **random port** works (the `*` port wildcard is accepted); `push_units`
  ok; pull by `rev` ok; an older `u` is ignored server-side; realtime
  `postgres_changes` delivers the UPDATE after login; anonymous `push_units`
  → `42501 permission denied`. Probe pattern: in-memory `auth.storage` Map
  (holds the PKCE verifier), `signInWithOAuth({skipBrowserRedirect: true})`
  → `shell.openExternal` → `exchangeCodeForSession(code)`.
- `@supabase/supabase-js` ^2.117.3 added to `dependencies`.
- Supabase project → Settings → Integrations → GitHub repo deploy must stay
  **off**: migrations are applied via MCP, a deploy would re-run them.
- Unrelated, owed: `npm audit` high on `js-yaml` 4.3.1 via `electron-updater`.

## Phase 2 — detailed plan (2026-10-14; 2a built 2026-10-15, see results below)

Key finding: `lifesync.js` and `todosync.js` already merge **peers** of a fixed
shape — life: `{units: [{k, v, u}], gone: {k: t}}`; to-dos:
`{<projectKey>: {items: [todo + u], gone: {<at>: t}}}`. The cloud only has to
produce that same shape from pulled rows, so the merge rules stay untouched.

**Split (each shippable):**
- **2a — login + budget + to-dos** (the core).
- **2b — config scope:** `mc:rules`, `news:source:<id>` / `news:topic:<id>`,
  `proj:class:<key>` / `proj:pinned`, and whole docs `doc:prompts`,
  `doc:cheatsheets`, `doc:libraries`, `doc:rates`.
- **2c — snapshots:** ledger (combined weekly limit), news briefing, YAZIO.

**2a pieces:**

| Piece | What |
|---|---|
| `src/cloudauth.js` | `createClient` with `flowType: 'pkce'`; storage adapter backed by `cloud-session.local.json`, encrypted with `safeStorage` (pattern: `lifeyazio.js`); `autoRefreshToken` on. Login = the probed flow (loopback `127.0.0.1:0/callback`, 3 min timeout, server closed after). Logout clears the file. |
| `src/cloudsync.js` | Async shell around the existing **synchronous** `syncOnce` / `syncAll`: pull (`rev > cursor`, pages of 1000) → in-memory + on-disk mirror of rows → run the sync with the mirror as an extra peer → push what it published. Realtime event → debounced pull. Fallback poll 60 s. |
| State file | `cloud-sync.local.json` = `{v, cursor: {life, todos, config}, pushed: {scope: {key: u}}, mirror: {scope: {key: {v, u, d, machine}}}}`. |
| Push = diff, no queue | After each local sync: push every unit whose `u` > `pushed[key]`; mark pushed only after the RPC succeeds. Offline → the next run pushes what is still missing. Batches of ≤ 500 (server cap) — the first upload of the whole budget takes several calls. |
| Row ↔ peer mapping | life: row key = unit key; tombstone = `{v: null, u: t, d: t}` → `gone[k] = d`. to-dos: row key = `<projectKey>:<at>` (split at the **last** `:`, `at` is digits). All rows, own machine included, form one peer (merge takes max `u`; own rows restore a lost local file). |
| `lifesync.js` / `todosync.js` | Smallest change: new deps `extraPeers()` and `onPublish(doc)`; `sharedDir` empty no longer returns early when the cloud is on. Existing tests stay green. |
| `src/cloudipc.js` + `preload.js` | `cloud:status`, `cloud:login`, `cloud:logout`, `cloud:syncNow`. No token ever reaches the renderer; validate in main. **`ecc:security-reviewer` before commit.** Wire in `main.js` with one `register` call (file is past the size guideline). |
| UI | "Cloud" card: logged in as, last sync, units not yet pushed, Sync now, Log out. `pl` + `en` strings. |
| Config | `config/cloud.local.json` = `{url, publishableKey}` (gitignored). No file → cloud off, folder sync as today. Values: `https://phkigyuhvbanadwmxqqs.supabase.co`, `sb_publishable_ovwDzfpECqXNVyME9FMrhQ_7uSaZovy` (public by design). |

**Changed from the original plan:** no week of Syncthing in parallel — it was
never paired with another PC, so there is nothing to protect. The folder code
keeps working until phase 3 removes it once the cloud is proven on two PCs.

**Tests first (TDD):** rows → life peer / to-do peer; doc → units-to-push diff
against `pushed`; tombstones both ways; to-do key split with `local:home` and
`github.com/x/y`; paging pull with a fake client; cursor + `pushed` persisted
only after success; `cloud.local.json` validation (bad URL / missing key →
off); `lifesync` / `todosync` with `extraPeers`; future-dated `u` (> now + 1
day) from the cloud rejected by the existing `validStamp`.

**Risks:** device clock far ahead wins every conflict (mitigated by
`validStamp`); first upload size (batched); `safeStorage` unavailable → no
login, show why.

## Phase 2a results (2026-10-15) ✅

Built TDD-first as planned; `npm test` 2057/2057 (46 new cloud tests).
Smoke-tested in the real app on KT-PC-LLM: GitHub login, first upload of 29
budget units + 120 to-do units, card shows 0 waiting.

| File | Role |
|---|---|
| `src/cloudrows.js` | Pure mapping: rows <-> life / to-do peers, published doc -> units, `unpushed()`, `parseCloudConfig()`. Rejects hostile keys (`__proto__`, `constructor`...), keys > 200, far-future `u`. Floors `u` (bigint column). |
| `src/cloudsync.js` | `createCloudSync` (pull by `rev` in pages of 1000, push in batches of 500, cursor / `pushed` move only after success, state bound to the user id, `reset()` cancels an in-flight run) + `startCloud` (realtime -> debounced pull, 60 s poll, push 1 s after a publish, `CLOUD_OFF` without config). |
| `src/cloudauth.js` | PKCE login, loopback `127.0.0.1:<random>/callback` (Host-checked, ignores stray requests, 3 min timeout), authorize URL checked before `openExternal`, session encrypted with `safeStorage` (no plaintext fallback). |
| `src/cloudipc.js` | `cloud:status/login/logout/syncNow`, no payloads, whitelisted answers, rate limits. |
| `src/renderer/modules/lifecloud.js` | "Cloud sync" card in Life -> Settings (`life.cloud.*` strings, pl + en). |
| `lifesync.js` / `todosync.js` | New deps `extraPeers()` (null = cloud off) and `onPublish(doc)`; work with no `sharedDir` when the cloud is on. `startLifeSync({cloud})`, `startTodoSync({..., cloud})`. |

Runtime files (user config dir / `config/` in a dev clone, all `*.local.json`):
`cloud.local.json` `{url, publishableKey}`, `cloud-session.local.json`
(encrypted), `cloud-sync.local.json` `{v, user, scopes: {life|todos: {cursor, pushed, mirror}}}`.

Lessons:
- Old first-sync stamps were `mtimeMs` floats (`1791972919873.1597`);
  `push_units` casts `u` to bigint and refused every batch (22P02). Fixed by
  flooring in `cloudrows` and in `lifesync`'s first-sync base.
- Failures now log PostgREST code + message (`[cloudsync] push-failed: ...`).
- The dev app has no single-instance lock: don't run two copies on one `config/`.

Security review (`ecc:security-reviewer`): no CRITICAL/HIGH. Fixed: hostile
row keys, user binding + logout race, loopback hardening, far-future stamps,
`persist()` never throws, logout rate limit. Deliberately skipped (LOW):
sender-frame check on IPC (no other handler does it; no webviews), per-entry
mirror validation on load (peers go through `validPeer` anyway), one save per
page during a pull.

Not done in 2a: snapshots (2c), config scope (2b), a second PC.

## Next session: start here

1. Re-read this file; `git log` for anything newer touching `cloud*.js`,
   `lifesync.js`, `todosync.js`.
2. **Prove 2a on a second PC** (work PC or home PC): update LunaCore, copy
   `cloud.local.json` (values in the 2a table above) into its config dir, log
   in, check the budget + to-dos arrive and an edit on either PC shows up on
   the other within seconds. Its first sync must not overwrite the cloud with
   default categories (guarded: no peers before the first pull, stamps from
   the file mtime / 0).
3. Then **2b — config scope** (`mc:rules`, `news:source|topic:<id>`,
   `proj:class:<key>` / `proj:pinned`, `doc:prompts|cheatsheets|libraries|rates`)
   and **2c — snapshots** (ledger, news briefing, YAZIO), same TDD + security
   review routine.
4. Phase 3 (remove the folder transport, `sharedDir`, SyncTrayzor) only after
   the cloud is proven on two PCs.
5. Still owed: `npm audit` high on `js-yaml` 4.3.1 via `electron-updater`.
