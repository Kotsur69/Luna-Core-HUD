# Luna host + phone control — plan

Status: **confirmed by Mati 2026-10-20. U1 built 2026-10-20 (migration
applied; live check pending: restart the HUD, open the phone). Next: U2.** Builds on `CLOUD_SYNC_PLAN.md` (Supabase project
`phkigyuhvbanadwmxqqs`, phone at `https://luna-core-hud.vercel.app`). Same
rules apply: pulled rows are untrusted, realtime only triggers a read, every
slice is done only when the other side *reads* what one side writes.

## Goal

1. On the phone: **usage limits** (5 h + weekly) and **repo status** of every PC.
2. A **Luna host**: a machine running 24/7 that the phone app drives like a
   terminal at home — pick a repo, type to Claude Code, use skills, slash
   commands and MCP servers, approve tool calls live, push. "`/rc`, but
   better": several hosts, repo status, usage bars, push notifications,
   session history, cloning from the phone. Plus small fixed actions (Haiku
   news scan, fetch all repos).

## Settled (Mati, 2026-10-20)

| Topic | Decision |
|---|---|
| Hosts | Any machine can be a host. **KT-NO-MMAZUR** (company laptop, on 24/7, no admin, same setup as KT-PC-LLM), **KT-PC-LLM** (home PC: Unity / Blender MCP, desktop apps) and Mati's **private MacBook**. |
| Switching the main host | **One click on the machine itself**: `Luna Host.bat` (Windows) / `Luna Host.command` (Mac) starts host mode there **and makes it the default host**. The phone can still pick any online host per session. |
| What a task may do | **Work directly in the repo**, like a terminal at home, including push to main. No forced worktree/branch. |
| Who may command a host | **Passkey on the phone**, Face ID **once per session**: it signs a short-lived session key (12 h, non-extractable, on the phone), which signs every message and approval. A Supabase login alone can never run anything. |
| Interaction | **Full live chat with approvals, inside the LunaCore phone app.** Streamed output, reply, approve / deny / always allow, interrupt, resume. |
| Unanswered approval | **Waits forever by default**; per session the phone can choose "deny after N min" instead. |
| Repos on a host | Every project in the synced project list (`projects.local.json` → `proj:entry`) that has a git remote is **cloned automatically** on a host that lacks it. Any other repo: **clone by link from the phone** into the host's repos folder. |
| Notifications | **Yes, all**: approval needed, session done / failed, host offline, usage limit warnings. |
| Order | U1 → U2 → H1 → H2 → H3 → H4. |

## Probed 2026-10-20

- `claude` 2.1.304 on KT-PC-LLM: `--print` with `--input-format stream-json
  --output-format stream-json --include-partial-messages`, `--resume <id>` /
  `--session-id <uuid>`, `--permission-mode`, `--setting-sources`, and
  `--permission-prompts host` (default): **permission prompts are answered by
  the program that runs `claude`**, so the host forwards them to the phone and
  writes the answer back on stdin. No screen scraping, no PTY. The exact
  control-message shapes are probed live at the start of H2.
- LunaCore builds for **Windows only** (`package.json` → `build.win`: nsis +
  portable). → The host is a **headless mode of the same codebase**, not a
  second app (see "Host runtime").
- A synced project is `proj:entry:<id>` = `{label, path}` — **no remote URL**,
  so another host can't clone it yet (fixed in H1).
- Already in the repo: `usage.js` (5 h + weekly from
  `api.anthropic.com/api/oauth/usage`, a GET, no tokens), `gitstation.js`
  (branch / dirty / ahead-behind / fetch over `repos.local.json`), `skills.js`,
  keep-awake, `cloudauth.js` (GitHub PKCE login, `safeStorage` session).

## Host runtime

- `LunaCore --host`: Electron starts **without the HUD window** (tray icon
  only: "Luna host · <machine> · default", Stop, Open log). Entry
  `src/hostmain.js` loads only cloud auth/sync, snapshots, usage, git
  station, and the host modules — none of the Windows-only HUD code, so the
  same entry runs on macOS. Electron (not plain Node) keeps `safeStorage`
  for the cloud session on both systems.
- **Windows** (`scripts/Luna Host.bat`): runs the installed / portable
  `LunaCore.exe --host --make-default`. No admin, no Node install needed.
  When the full HUD is already running on that PC, it switches the running
  app into host mode instead of starting a second copy (single-instance lock).
- **Mac** (`scripts/Luna Host.command`, double-click): `git pull` in a clone
  of this repo, `npm ci` when `package-lock.json` changed, then
  `npx electron . --host --make-default`. Needs git, Node, Claude Code and
  `gh auth login` once on the Mac. No `.dmg` build, no signing.
- **`--make-default`** writes the sync unit `host:default` = `{machine}`
  (scope `config`, newest wins). The phone preselects it. A host started
  without it just shows as online.
- Keep-awake while host mode is on. The Mac needs "Prevent automatic
  sleeping when the display is off" (or `caffeinate`, started by the
  `.command`).
- First run on a new host: GitHub login in the browser (same flow as the HUD)
  and the **passkey pairing** (H1).

## Slices

Each slice ships on its own and is usable on the phone when it lands.

### U1 — usage limits on the phone

- New snapshot kind **`usage`** (migration: extend the `snapshots.kind` check).
  The PC puts `{v, at, fiveHour: {pct, resetsAt}, sevenDay: {pct, resetsAt}}`
  after each usage refresh; skipped while unchanged (existing `put` rule).
- All PCs share one account → the phone shows the row with the newest `at`,
  "from HH:MM, <machine>". Two bars + reset countdowns on **Today** and in
  the Mission → Claude tab, next to the ledger week.
- Reader: `v === 1`, pct 0–100 (clamped), sane timestamps. Strings: none.
- **Built:** `src/usagesnapshot.js` (writer + reader, shared with the phone),
  `main.js` puts on every usage change and re-offers every 5 min (late
  login), migration `20261020120000_usage_snapshot.sql`, phone card
  `mobile/src/views/usage.js`. A window whose reset passed shows 0 %
  "reset" until a PC reads again.

### U2 — repo status on the phone

- Snapshot kind **`repos`**: per repo `{key, name, branch, dirty, ahead,
  behind, lastCommit: {subject, at}, fetchedAt}`. **No paths.** `key` = the
  normalised remote (`missionrepokey.js`), so the same repo on two PCs lines up.
- Pushed after each git-station refresh (and after a fetch).
- Phone page **Repos**: one card per repo, a row per PC; flags "needs push"
  (ahead > 0), "behind", "dirty", and "**diverged across PCs**".
- Accepted: commit subjects + repo names leave the PC (same trust as the ledger).

### H1 — host mode, signed commands, repos

- Host runtime above (`--host`, `.bat`, `.command`, `host:default`, tray).
- Snapshot kind **`host`** = `{v, at, version, os, default, repos: [{id,
  key, name, cloned}], skills, commands, mcp, sessions}`: what the phone may
  pick from. Online = `updated_at` < 90 s old (heartbeat every 30 s).
- Table **`host_commands`**: `{id, user_id, host, kind, payload, nonce,
  expires_at, sig, status, result}`. RLS: own rows only. The host claims a
  row (`new → claimed`, one `update … where status = 'new'`), runs it,
  writes `result`.
- **Passkey + session key:**
  - **Pairing on the host's own screen** (or tray window): the phone creates
    a passkey (WebAuthn, rp = the Vercel domain) and sends its public key
    through the cloud. Host and phone both show a 6-digit code; Mati confirms
    on the host. The key goes into `host-keys.local.json` on that host only
    and is never read from the cloud afterwards. A stolen Supabase session
    can't pair its own key. Pair once per host.
  - **Once per session:** Face ID signs a WebAuthn assertion over
    `{sessionKeyPub, host, expires_at ≤ 12 h, nonce}`. The session key is a
    WebCrypto ECDSA P-256 key generated on the phone as **non-extractable**,
    kept in IndexedDB, wiped on logout / expiry.
  - Every command is signed with the session key over the canonical command
    (`host, kind, payload, nonce, expires_at ≤ 2 min`). The host checks the
    session grant (passkey signature, `rpIdHash`, `origin`, user-verified
    flag, sign count, expiry) and then the command signature, expiry and
    nonce (never seen). Anything else is refused and logged, never run.
  - Panic: "Forget all phones" in the host's tray drops every key and grant.
- **Repos on the host:**
  - `proj:entry` gains an optional **`remote`** (normalised https URL of
    `origin`, filled by any PC that has the repo). `projectsync.js` keeps
    accepting old entries without it.
  - The host **clones every synced project with a remote that it doesn't
    have** into its repos root (`~/source/repos/<name>`), using the host's own
    git credentials. Only `https://github.com/<owner>/<repo>` with an owner
    on the host's allow-list (`host.local.json` → `owners`, default
    `["Kotsur69"]`): a synced row alone can't make a host fetch a stranger's
    repo. A folder that already exists is never touched; the result shows on
    the phone ("cloned", "skipped: folder exists", "failed: auth").
  - Command **`repo.clone {url}`** (signed): same URL rules, any owner (it's
    your Face ID), folder `<repos root>/<repo>`, refuses an existing folder,
    then adds the project entry (which syncs to the other machines).
- First fixed actions (prove signing end to end with low risk):
  `news.scan` (the existing Haiku briefing; result = the `news` snapshot),
  `git.fetchAll` (refreshes `repos`), `repo.clone`.

### H2 — live Claude Code chat (the core)

- **Probe first:** a throwaway script runs `claude -p --input-format
  stream-json --output-format stream-json --include-partial-messages` in a
  repo, triggers a tool that needs permission, and records the exact control
  request/response messages, "always allow", interrupt, and `--resume`.
  Details below are adjusted to what it shows.
- `src/hostchat.js`: one `claude` child per session, cwd = the chosen repo
  (only repos in the host's own list; the phone sends a repo **id**, never a
  path). Uses the host's normal Claude Code login, settings, CLAUDE.md,
  skills, plugins and MCP servers. Max 2 sessions at once per host.
- Table **`host_events`** `{session_id, seq, host, kind, data, at}`: assistant
  text (partial chunks batched every ~300 ms), tool calls + short results,
  permission requests, status (working / waiting / done / error), cost line.
  Big tool outputs are clipped (4 KB) with "full output on the host".
  Retention: the host deletes events of sessions older than 14 days.
- Phone → host goes **only** through signed `host_commands`:
  `chat.start {repoId, prompt, model?, mode?, approvalTimeout?}`, `chat.send`,
  `chat.approve {requestId, decision: allow | deny | always}`,
  `chat.interrupt`, `chat.end`, `chat.resume {sessionId}`.
- **Approvals:** the host's existing allow-lists still auto-allow what they
  allow today; real prompts reach the phone as cards (tool, command or file,
  diff preview for edits). "Always" = the CLI's own "don't ask again" for that
  rule, same as on a PC. Unanswered: waits forever, unless the session was
  started with "deny after N min".
- Phone page **Host**: host picker (online dot, default star), repo picker
  (cloned / not cloned → Clone), session list (all hosts), chat view (text
  only, no `innerHTML`: everything is model output over untrusted files),
  approval cards, Stop, usage bars from U1 on top.
- On a Windows host running the full HUD, the session also shows as a
  read-only tab, so you can sit down and see what happened.

### H3 — skills, commands, MCP, models

- The `host` snapshot lists skills, slash commands and MCP servers of that
  host. The phone offers them as a picker that inserts `/name` into the
  message (the CLI resolves it; nothing new runs on the host).
- Per-session model (Sonnet / Opus) and permission mode (default /
  acceptEdits / plan).
- KT-PC-LLM's Unity / Blender MCP servers simply show up when it is the host.

### H4 — notifications + hardening

- Web Push (installed PWA, iOS 16.4+). Sender = a Supabase Edge Function
  with a VAPID key, called by the host. Events: **approval needed**,
  **session done / failed**, **host offline** (the edge function notices a
  stale heartbeat of the default host: a scheduled check), **usage** at 80 %
  and 95 % of the 5 h and weekly limits. Text in a notification is generic
  ("Approval needed on KT-NO-MMAZUR"), never command text or code.
- `ecc:security-reviewer` on the whole command path (it is remote code
  execution by design: the passkey is the gate), `ecc:typescript-reviewer`,
  live checks on all three hosts.

## Risks

- **Remote code execution by design.** Anyone who can sign a command owns the
  host. Mitigations: passkey pairing only on the host's screen, 12 h session
  keys, 2 min command expiry, nonces, host mode off unless started, panic
  button.
- **Company laptop:** Mati's call (same rules as KT-PC-LLM, no admin). The
  work network's Zscaler proxy may break the realtime WebSocket; if it does,
  the host falls back to polling `host_commands` every 3 s.
- Same subscription for everything: host sessions eat the same 5 h / weekly
  limit (U1 + usage notifications make that visible).
- Working directly in a repo: a push from a host can diverge a clone with
  unpushed work elsewhere — U2's "diverged" flag shows it.
- A host runs for days: memory growth in the headless Electron process,
  watched in H2.
- macOS: Electron from a clone (not a signed app) may need "allow" for
  network / keychain once; probed when the Mac is first set up.

## Mati, by hand (later)

1. Mac: install git, Node LTS, Claude Code (log in), `gh auth login`; clone
   this repo; enable "prevent sleep".
2. Each host: first `--host` run → GitHub login in the browser, pair the
   phone's passkey (Face ID).
3. iPhone: install the PWA (Add to Home Screen) and allow notifications (H4).
