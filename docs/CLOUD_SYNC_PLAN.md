# Cloud sync + iPhone companion — plan

Status: **confirmed by Mati 2026-10-14. Phase 1 database applied 2026-10-14. Released in v0.15.0 (2026-10-15).
Phases 2a–2c shipped 2026-10-15 (v0.15.0 → v0.16.1) and proven live on two PCs.
Phase 3 (folder transport removed) released in v0.16.2 (2026-10-19)**
(KT-PC-LLM + laptop KT-NO-MMAZUR), against Supabase
project `phkigyuhvbanadwmxqqs` ("Kotsur69's Project", `eu-west-1`,
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
| `mission-projects.local.json` | `config` | `proj:class:<projectKey>`, `proj:pinned` | `classes` (work/fun/other) + `pinned`. `sharedDir` was removed in phase 3 (a leftover key is dropped on the next save). |

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
| `ledger` | This PC's transcripts (`missionledger.js`: hourly token rows + focus blocks; validated by `missionledgersync.js`) | Every PC (combined weekly limit), phone |
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

Follow-up fix (2026-10-15, shipped in v0.15.0): a project's **first** to-do
sync on a PC stamps its local items `u = 0` (`todosync.js` `stamp(..., base)`),
so an old copy of an item (e.g. unticked) can't beat the cloud's newer
version. Items only that PC has still upload. Same idea as `lifesync`'s mtime base.

**Gap found: the project list doesn't sync.** To-dos sync per project, and
`syncAll` only walks the projects in *this* PC's list (`projects.json` +
`projects.local.json`: `{id, label, path}`). A fresh install only knows
`home` + `lunacore`, so the to-dos of every other project stay in the cloud
but don't show up there. Nothing is lost or deleted. Workaround for the
second-PC test: copy `projects.local.json` too (a missing folder is fine: the
to-dos meet under the `local:<id>` alias; only opening a terminal there fails).
Fix in **2b**: unit `proj:entry:<id>` = `{label, path}` (newest wins,
tombstone on remove). A PC adds the projects it lacks, and paths under the home dir are
stored as `~/...` so they fit another user name. Phone: to-dos grouped by project
id, no paths needed.

**Build rule (v0.15.0):** `build.files` packs only `config/**/*.json` (minus
`*.local.json`), so a stray note in `config/` can never ship inside the `.exe`.

## Phase 2b, slice 1 — project list (2026-10-15)

| File | Role |
|---|---|
| `src/configsync.js` | Engine for the `config` scope: one **provider** per kind of setting (`owns`, `valid`, `read`, `resolve?`, `write`). Reuses `lifesync`'s `stamp` / `merge` (newest wins, tombstones). Cloud only, no folder transport. A provider that can't read or write is skipped that round. State `config-sync.local.json` = `{v, providers: {<name>: {snap, u, gone}}}`. `startConfigSync({cloud, onChanged})`. |
| `src/projectsync.js` | Provider `projects`: `proj:entry:<id>` = `{label, path}`, paths under home as `~/...`. A PC **adds** projects it lacks and **drops** ones deleted elsewhere, but a project it already has **keeps its own path/label**. `removedIds` seed tombstones on the first sync (a removed default can't come back). Cloud paths: only `~`, `~/...`, absolute; no UNC; ids `[A-Za-z0-9._-]{1,80}` minus `__proto__` & co. |
| `src/cloudsync.js` | `SCOPES` += `config` (same `{units, gone}` mapping as `life`). |
| `src/main.js` / `preload.js` / `switchers.js` | `configSync.soon()` after add/remove; cloud change -> `reloadProjects()` -> `projects:changed` (no payload) -> switcher re-fetches; to-do sync runs soon so new projects bring their to-dos. |

Security review (`ecc:security-reviewer`): no CRITICAL/HIGH. Fixed: Windows
device paths (`\??\UNC\...`, `\\.\...`) slipped past the UNC check — now only
`~`, `~/`, `X:\`, plain `/x`; `removedIds` seeds stamped with the file mtime
(floored to now − 30 days) instead of now, so a later re-add elsewhere wins;
arrivals capped at 200 projects; temp files match `*.local.json`; meta written
atomically; unparseable local entries kept. **Accepted trust assumption:** a
row in Mati's own cloud can add a project whose folder becomes a terminal cwd
— anyone able to write it already holds his Supabase session.
`npm test` 2079/2079. Not yet smoke-tested live.

## Phase 2b, slice 2 — whole settings files (2026-10-15)

`src/docsync.js`: one provider per file, unit value = the parsed file, newest wins:
`doc:prompts`, `doc:libraries`, `doc:rates` (`<name>.local.json`)
and `mc:rules` (`missioncontrol.local.json`). First sync stamps from the file
mtime (a fresh PC's older file loses to the cloud). Deleting the file deletes it
on the other PCs; whatever the cloud replaces or deletes is kept as
`<name>.bak.local.json`. A file over 7000 UTF-8 bytes of JSON (the server's
16 KiB jsonb cap, with room for jsonb's ~2x overhead; one refused row would
fail its whole push batch forever) or unparseable is skipped: never published,
never overwritten (only a console line says so). Cloud values only need to be
a plain object within the cap — every loader re-validates its file on each
read. Tests: `test/docsync.test.js` (fake cloud reorders keys like jsonb to
prove there is no rewrite loop).

Security review (`ecc:security-reviewer`): no CRITICAL. Fixed: chars-vs-bytes
cap (HIGH), `.bak` copy against a wrong fleet-wide delete (MEDIUM).
Reviewer HIGH on synced cheatsheet commands (typed into the terminal on
click) -> Mati dropped `doc:cheatsheets` from the sync. **Accepted trust
assumption** (same as the project list): Mission Control mail rules
go into the Haiku mail prompt (trash still needs preview + approval) — anyone
able to write those rows already holds Mati's Supabase session. Not done
(LOW): oversize warning in the Cloud card; `{}` accepted as a doc.
**Cheatsheets are not synced** (Mati, 2026-10-15): a cheatsheet command is
typed into the terminal on click, so no cloud row may change one.
Known gap: the prompts panel fetches once at start and libraries
on first open, so a change from another PC shows after a restart.

## Phase 2b, slice 3 — Mission Control settings (2026-10-15)

`src/missionsync.js`, two providers:
- `news` (`mission-news.local.json`): `news:source:<id>` = `{platform, target, label}`,
  `news:topic:<id>` = `{query, platforms}`. Cloud values pass the store's own
  `normalizeSource` / `normalizeTopic`; arrivals capped at 50 sources / 30 topics.
  Items without a valid id stay in the file, unsynced.
- `missionProjects` (`mission-projects.local.json`): `proj:class:<projectKey>` =
  `{class}`, `proj:pinned` = `{list}` (through `normalizePinned`). **`sharedDir`
  never leaves the PC.**
Tests: `test/missionsync.test.js`. `npm test` 2103/2103.

Security review (`ecc:security-reviewer`): no CRITICAL/HIGH, `sharedDir` never
leaks. Fixed (MEDIUM): `configsync` now keeps any unit with a key > 200 chars
or a value > 7000 bytes local (one refused row would fail its whole push batch
forever — a long `git:` project key or a big pinned list could do it); the
topic dash guard strips `- -x` too (`/^[\s-]+/`). Not done (LOW): local news
items with a valid id that fail normalisation are dropped on the next cloud
write (the loader ignores them anyway); bidi/zero-width characters in labels.

**2b is complete** — every file in inventory section A now syncs.

## Phase 2c, slice 1 — ledger snapshot (2026-10-15)

| File | Role |
|---|---|
| `src/cloudsnapshots.js` | `put(kind, data)` upserts this PC's `snapshots` row (`onConflict: user_id,kind,machine`), skipped while the JSON is unchanged, 512 KiB cap; `list(kind)` = the other machines' rows (machine name + plain-object checked), 60 s cache, a failed read keeps the last good answer. Reset on logout. `startCloud().snapshots`; `SNAPSHOTS_OFF` without config. |
| `src/missionledgersync.js` | `parsePeer(data, machine, now)` split out of `readPeer`: a cloud snapshot gets exactly the peer-file validation. |
| `src/missionledgerservice.js` | Optional `cloud` dep (object or getter). Each report puts `{v, machine, rows, blocks}` — **last 8 days only**, no `updatedAt` (the row's `updated_at` says when, so the same rows don't re-upload) — and merges cloud peers with folder peers: one per machine (case-insensitive), the newer copy wins, cap 8. Works with no `sharedDir`. |
| `main.js` / `missioncontrolipc.js` | `cloudSnapshots: () => cloud.snapshots`, read on the ledger's first use. |

Security review (`ecc:security-reviewer`): no CRITICAL/HIGH. Fixed: an
oversize week is cut to the newest 3 days, then 1 (MEDIUM; `put` logs once per
kind); `reset()` bumps a generation so a list/put in flight at logout can't
fill the next user's cache or skip their first put, and any auth change resets
(MEDIUM); a far-future `updated_at` is clamped to now; `list()` orders newest
first and skips our own row server-side; puts of one kind run one at a time;
a cloud peer with nothing in range is not listed. **Accepted (same as the
folder transport):** project keys/names (`git:host/owner/repo`,
`local:<folder>`) leave the PC — no paths, prompts or text. Not done (LOW):
parse cache for cloud peers; machine-name collisions (`PC_1` = `PC-1`); a
"forget this PC" action for a retired PC's row.

`npm test` 2126/2126. ✅ Live on two PCs since v0.16.0 (check
`select kind, machine, updated_at from snapshots` after the first ledger refresh).

## Phase 2c, slice 2 — news briefing snapshot (2026-10-15)

`missionnews.js` `newsSnapshot()` builds `{v, at, lang, briefing, sections:
[{label, platform, kind, summary, entries: [{title, published, url, pick}]}]}`
and `mission:news-scan` puts it as `news` after a successful summary,
fire-and-forget (a throw anywhere never fails the scan or loses the paid
summary). **Quick searches are not pushed**, so a one-off search never replaces the
briefing. Unlike the renderer, the snapshot carries links (the phone has no
main process to resolve keys) but never the fetched text. Links go through
`safeUrl()`: http(s) only, no credentials, no quote/angle bracket/space,
no secret-looking query parameter (`token|key|auth|sig|session|secret|password|code`),
fragment dropped, ≤ 2048 chars. Labels are clipped to 120 chars, with at most 100 sections. Too big
→ picked entries only → no entries → `put` refuses and logs once.

Security review (`ecc:security-reviewer`): no CRITICAL. Fixed: snapshot built
inside the guard (HIGH); strict `safeUrl` (MEDIUM); label/section caps
(MEDIUM). **Accepted:** topic queries / source labels and the LLM summary leave
the PC (same trust as the ledger's project names). **Reader requirements
(phone, phase 4; other PCs):** treat the row as untrusted. Check `v === 1`,
field types, `lang` ∈ {pl, en} and a sane `at`. Apply its own length caps.
Re-parse every URL with `new URL()` (http(s), no credentials) and open it with
`noopener noreferrer`. Render every string as text only (no `innerHTML`,
markdown or auto-linking: briefing/summary are LLM output over untrusted pages).
Show the link host before opening it, show "from HH:MM, <machine>" from `at`, and
take the newest `at` across machines. Desktop reader: slice 3 (`missionnewspeers.js`).

`npm test` 2135/2135. ✅ Live, read on the laptop since v0.16.1 (`select machine, updated_at from
snapshots where kind = 'news'` after a scan).

## Phase 2c, slice 3 — readers + YAZIO (2026-10-15)

Mati on the laptop: "when i click ctrl shift m on my laptop i cant see reports
from this pc". Slice 2 only uploaded the briefing, so this slice adds the reader,
plus a sweep of every synced item for an upload with no reader.

| File | Role |
|---|---|
| `src/missionnewspeers.js` | `news` rows of the other PCs → read-only reports (v/lang/at checked, every string capped, links re-validated with `safeUrl`, kept in main behind keys). `mission:news-peers`; `mission:news-open` resolves these keys too. Renderer: "Ready reports" lists them as "Report from <PC>" next to the local ones, with no delete. |
| `src/lifeyaziopeers.js` | `yazio` snapshot = Body numbers only (whitelisted fields, ranges checked; never the login). `life:body` puts it after each successful fetch. On a PC not logged in to YAZIO, it returns the newest other PC's copy with `from: {machine}`. The Body tab shows it read-only above the login form. |

Security review (`ecc:security-reviewer`): no CRITICAL/HIGH. Fixed:
- MEDIUM: peer links to loopback, private, link-local or single-label hosts are dropped (`isPublicHost`), so a row can't aim a click at the LAN.
- MEDIUM: the Body tab waits at most 4 s for another PC's copy.
- LOW: a body that fails its own check is never uploaded over a good row.
- LOW: the key table is sized above one list's worst case, and sections are capped at 30.

**Accepted:** Body numbers (weight, kcal, steps) go to the cloud behind the cloud login, as decided in section B. Any PC on the account can label its row with any machine name.

`npm test` 2154/2154.

**Audit of everything that syncs (2026-10-15, live table + code):**

| Item | Up | Read/apply | State |
|---|---|---|---|
| Budget (`life`) | ✅ | ✅ pull → `lifebudget` | Live on both PCs. The laptop's default categories `home`/`eatout`/`snacks` sit at `u=0` (same values as KT-PC-LLM's), so they never override anything. |
| To-dos (`todos`) | ✅ | ✅ | Live on both PCs |
| Project list (`proj:entry`) | ✅ | ✅ | Live (laptop) |
| Project classes / pinned, news sources/topics | ✅ | ✅ | Live (KT-PC-LLM) |
| `doc:rates` | ✅ | ✅ | Live |
| `doc:prompts`, `doc:libraries`, `mc:rules` | ✅ | ✅ | Nothing in the cloud yet: no PC has a `*.local.json` of these (shipped defaults only). The first edit on any PC syncs. |
| Cheatsheets | — | — | Never synced, by decision (2b) |
| Ledger snapshot | ✅ | ✅ merged into the ledger | The laptop's row is empty (no Claude Code transcripts there in 8 days) |
| News snapshot | ✅ | ✅ **this slice** | |
| YAZIO snapshot | ✅ **this slice** | ✅ **this slice** | |

## Phase 3 — folder transport removed (2026-10-15)

The Syncthing / SyncTrayzor shared folder is gone; the cloud is the only way
PCs share data. Useful code stays: merge/stamp/validation in `lifesync.js`,
`todosync.js`, `parsePeer` / `validKey` / `machineName` in
`missionledgersync.js`.

| File | Change |
|---|---|
| `src/lifesync.js`, `src/todosync.js` | No `sharedDir` dep, no peer files. Cloud off → sync is a no-op. A lost local budget file still comes back: the cloud mirror holds this PC's own rows. |
| `src/missionledgersync.js` | Folder I/O removed (`writeOwn`, `readPeers`, `writeSharedJson`, `readSharedJson`). Keeps validation + shared checks. |
| `src/missionledgerservice.js` | Cloud peers only (one per machine, newer wins, cap 8). Report no longer has `sharedDir` / `syncError`. Cloud off → this PC only. |
| `src/missionprojects.js`, `src/missionsync.js` | `sharedDir` / `setSharedDir` removed; a leftover `sharedDir` key is dropped on read and on the next save. |
| `src/missioncontrolipc.js`, `src/preload.js` | `mission:ledger-pick-dir` / `mission:ledger-clear-dir` and the folder dialog removed (smaller IPC surface). |
| Renderer (`missionledger.js`, `i18n.js`, `styles.css`) | Ctrl+Shift+M ledger footer: "Share with other PCs…", "Change folder…", "Stop sharing", the folder path and the write-error line are gone. "Data from: this PC · other PCs" stays. |

Tests ported to an in-memory fake cloud; `npm test` 2142/2142.

**Mati, by hand on each PC (optional cleanup):** uninstall / delete
SyncTrayzor (`%LOCALAPPDATA%\SyncTrayzorPortable\` on KT-PC-LLM) and the
`%USERPROFILE%\LunaLedger` folder; old `todo-sync` / `life-sync` meta files
stay in use by the cloud path, don't delete them.

## Phase 4 — detailed plan (2026-10-19, not built yet)

Probed before planning:

- **CommonJS maths in Vite: works.** A real `vite build` (6.4) of
  `src/lifebudgetcalc.js` from outside the root fails by default, and passes
  with `build.commonjsOptions.include: [/src[\\/]lifebudget/, /node_modules/]`
  (12 kB, no `require` left). `vite dev` doesn't convert out-of-root CJS, so
  local testing runs `vite build --watch` + `vite preview`.
- **Validators aren't browser-safe yet.** `lifebudget.normalize()` and
  `todo.normalizeTodo()` are pure, but their files load `fs` / `crypto` /
  `paths` at the top. A PC drops any pulled unit that doesn't survive
  `normalize()` unchanged, so the phone must write rows that are already
  normalised, using the same code.
- **Row format is ready.** To-dos: scope `todos`, key `<projectKey>:<at>`,
  value = the item without `u`. `local:<id>` buckets sync too, so the phone
  sees home / safetyhub-bhp lists. Budget: scope `life`, keys as in section A.
  A phone write = `push_units` with `u = Date.now()`, so the server decides newest-wins.

Slices (each one is usable on the phone when it ships):

| Slice | What | Needs from Mati |
|---|---|---|
| **4a** | Split pure validators into `src/lifebudgetrows.js` and `src/todorows.js` (no `fs`); the old modules re-export them, `npm test` stays green. `mobile/` scaffold: Vite + `vite-plugin-pwa`, dark HUD look (`ui-ux-pro-max` pass), slide-out nav, GitHub login (Supabase PKCE, redirect back to the PWA origin), pull `sync_units` into an IndexedDB mirror (same cursor rule: `rev > cursor`). **To-dos:** lists per project, add, tick, delete (tombstone). | Vercel account (GitHub); add `http://localhost:4173/**` and the Vercel URL to Supabase → Auth → URL configuration → Redirect URLs. |
| **4b** | **Life:** quick add expense (main action), overview + charts (reuse `lifebudgetcalc.js`), bills (mark paid = `p:<YYYY-MM>:<billId>`), savings (edit/add goal, deposit). Units are written per row, never the whole budget. | — |
| **4c** | Snapshot readers: **News** (latest `news` row, with "from HH:MM, <machine>"; follows the slice 2 reader rules: `safeUrl`, caps), **Claude ledger** (all `ledger` rows, combined weekly view), **Body** (`yazio`). **Today:** hourly weather from Open-Meteo. Calendar + mail are placeholders until phase 5. | — |
| **4d** | Offline: writes queue in IndexedDB and push on reconnect. Realtime subscription triggers a pull. iOS install hint, icons, `ecc:security-reviewer` + `ecc:typescript-reviewer` pass. | Add to Home Screen on the iPhone. |

**4a built and proven live 2026-10-19 (committed; not on Vercel yet).**
GitHub login on `localhost:4173` works; Mati's real lists show; add / tick /
delete round-trips phone ↔ PC ("works perfectly"). Files: `src/todorows.js`
(validators out of `todo.js`), `mobile/` (Vite 6.4.4 + vite-plugin-pwa 1.3.0,
supabase-js 2.117.3 pinned), `test/mobiletodomodel.test.mjs` (a phone unit
passes `todosync.validPeerProjects` unchanged); `npm test` 2147/2147.
Security + JS review done; fixed: pulls of a scope are chained (a write's pull
never reuses one that started before the push), logout wipes IndexedDB even
offline and on a sign-out elsewhere, CSP `connect-src` is pinned to the
project origin at build time (**4d must add its `wss://` origin for
realtime**), bidi characters stripped from list names. Local test:
`cd mobile && npm run build && npm run preview` → `http://localhost:4173`
(`.env.local` from `cloud.local.json`, gitignored). After the Vercel URL is
live, remove `http://localhost:4173/**` from the Supabase redirect list.

Rules for the phone, same as the PCs: pulled rows are untrusted, so validate
with the shared validators before rendering. Never apply a realtime payload
directly (it only triggers a pull). Compare by `u`, never by JSON text. The
publishable key goes in Vercel env (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`),
never in the repo. Audit rule from 2c: each phone write must show up on a PC
(and vice versa) before its slice counts as done.

## Next session: start here

**State on 2026-10-19: phase 4a (phone PWA shell + to-dos) is built,
committed and proven against the real cloud from `localhost:4173`. Not
deployed yet.** Supabase Auth URL config now: Site URL `http://localhost:4173`,
Redirect URLs `http://localhost:4173/**` + `http://127.0.0.1:*/callback`
(the PC entry had gone missing from the list and was re-added).

Earlier: **phases 1, 2a, 2b and 2c are done, released (latest
v0.16.1) and proven live on two PCs. Phase 3 is released in v0.16.2
(2026-10-19)** — check on both PCs that the Ctrl+Shift+M ledger still lists
the other PC and to-dos/budget still merge. KT-PC-LLM is cleaned up
(SyncTrayzor + LunaLedger deleted); the laptop's cleanup is Mati's. Mati, on the laptop with v0.16.1: "checked it
works perfect" (news reports from KT-PC-LLM show up in "Gotowe raporty").

1. Re-read this file and check `git log` for anything newer touching `cloud*.js`,
   `configsync.js`, `docsync.js`, `missionsync.js`, `lifesync.js`, `todosync.js`,
   `*peers.js`.
2. **Rule learned in 2c:** a sync slice is not done until some PC *reads*
   what it uploads. The audit table in slice 3 is the checklist; add a row for
   every new synced item.
3. **Next:**
   - **Deploy 4a to Vercel (Mati, with help):** Add New → Project →
     Luna-Core-HUD, **Root Directory `mobile`**, preset **Vite** (not the
     Python preset / `luna-core-hud-agent-reach` name it guessed on
     2026-10-19), env `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (values
     of `cloud.local.json`), "Include files outside the root directory" on.
     Then in Supabase: add `https://<vercel-domain>/**` to Redirect URLs, set
     Site URL to `https://<vercel-domain>`, remove `http://localhost:4173/**`.
     On the iPhone: Safari → the URL → Share → Add to Home Screen → log in.
     Optional: rename the Vercel team (currently "ArcelorMittal", Hobby =
     personal use).
   - **Then 4b**: Life on the phone (quick add, overview + charts, bills,
     savings). Starts with splitting `lifebudget.normalize()` and its row
     validators into a pure `src/lifebudgetrows.js`, the same way 4a did
     `todorows.js`. See "Phase 4 — detailed plan" above.
4. Small open items:
   - The laptop's ledger snapshot is empty (no Claude Code transcripts there
     in 8 days). Fine unless Mati uses Claude Code on the laptop.
   - `doc:prompts`, `doc:libraries` and `mc:rules` aren't in the cloud
     yet: no PC has edited them. The first edit should be watched once.
   - The YAZIO snapshot uploads when a logged-in PC opens the Body tab. It's not live-checked
     yet (`select machine, updated_at from snapshots where kind = 'yazio'`).
   - LOW review notes not done: a "forget this PC" action for a retired PC's
     rows; machine-name collisions (`PC_1` = `PC-1`).
   - Still owed: `npm audit` high on `js-yaml` 4.3.1 via `electron-updater`.
5. **Setting up another PC:** install the latest release, copy `cloud.local.json`
   (values in the 2a table above) and `projects.local.json` into its config dir
   (`%APPDATA%\LunaCore\config\` for the installer, `LunaCore-config\` next to
   the portable `.exe`), then log in. Its first sync can't overwrite the cloud
   (no peers before the first pull, stamps from the file mtime / 0).
