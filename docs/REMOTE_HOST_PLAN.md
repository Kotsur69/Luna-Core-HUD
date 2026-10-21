# Luna host + phone control — plan

Status: **confirmed by Mati 2026-10-20. U1, U2, H1, H2, H3 and H4 built
(2026-10-20 - 2026-10-21); security + JS review of the whole command path
done 2026-10-21, every CRITICAL/HIGH fixed with a test (see "Security
review"). Nothing past U1 is live-checked yet.** Builds on `CLOUD_SYNC_PLAN.md`
(Supabase project `phkigyuhvbanadwmxqqs`, phone at
`https://luna-core-hud.vercel.app`). Same rules apply: pulled rows are
untrusted, realtime only triggers a read, every slice is done only when the
other side *reads* what one side writes.

## Resume here

**Built (code + unit tests, `npm test` green):** U1 usage card, U2 Repos page,
God Mode page, H1 host runtime (`--host`, `--make-default`, launchers, tray,
heartbeat, auto-clone, `host_commands` loop, passkey pairing, session-key
gate, `news.scan` / `git.fetchAll` / `repo.clone`), H2 live chat
(`hostchat.js`, `host_events`, Host page, read-only HUD tabs), H3 pickers +
model / mode, H4 Web Push (edge function, phone subscription) and the review
fixes below.

**Needs a live check (Mati; also in `FUTURE_PLAN.md`):**

1. **U1** (open): restart the HUD on a PC on the new build, open the phone →
   Today and Mission → Claude show "Limity Claude" with two bars. Empty card:
   `select kind, machine, updated_at from snapshots where kind = 'usage'` - no
   row means the PC side (`[cloudsnapshots] put usage failed` in the HUD
   log), a row means the phone side.
2. **Apply the migrations** not yet in the project, in order:
   `20261020130000_repos_godmode_snapshots`, `20261020160000_host_snapshot`,
   `20261020170000_host_commands`, `20261021120000_host_pairing`,
   `20261021130000_host_events`, `20261021140000_push`.
3. **Deploy the edge function:** `supabase functions deploy push
   --no-verify-jwt`, its secrets and the 2-min cron (H4 below), Vercel env
   `VITE_VAPID_PUBLIC_KEY`, then redeploy the phone.
4. **Real phone pairing** on each host (KT-PC-LLM, KT-NO-MMAZUR, MacBook):
   first `--host` run → login → pairing window → codes match → confirm; then
   one `news.scan`, one `repo.clone`, one chat with an approval (Allow,
   Deny, Always), Stop, End, Resume; "Forget all phones" refuses the next
   command.
5. **Push on iOS:** PWA installed from Safari, "Enable notifications", then an
   approval, a session done, the default host stopped > 5 min, a usage alert.
6. Gotcha: a `src/*.js` module the phone imports must be added to the
   `SHARED` regex in `mobile/vite.config.js`, or the build fails with
   `"default" is not exported`.

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
- **Built (pairing + first actions):** `src/hostpairing.js` + phone
  `mobile/src/hostpair.js` / `views/pair.js` (menu → "Pair a host"), table
  `host_pairings` (migration `20261021120000_host_pairing.sql`, which also adds
  `host_commands.grant`). Pairing is **commit-reveal** so a stolen session
  can't grind a matching code: the phone sends its key + `sha256(commit)`,
  the host snapshots that and writes a random `host_nonce`, the phone reveals
  its nonce, both show `pairingCode(sha256(canonicalPairing))`
  (`src/hostcanon.js`). The host only acts while its 10 min pairing window is
  open and only on its own snapshot. First run (`src/hostsetup.js`): login →
  pairing window → ready; until then the tray says "Needs setup", no
  heartbeat, no clones, no command claims. Handlers in `src/hostactions.js`;
  `repo.clone` lowercases a pasted `https://github.com/…(.git)` URL first.

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
  `chat.approve {requestId, decision: allow | deny | always, card: {tool,
  summary, preview}}` (the card the phone showed; the host refuses any other,
  see "Security review" S-H1),
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

### H2 protocol (probed)

Probed 2026-10-21 with `scripts/probe-claude-stream.js` (claude 2.1.306,
Haiku, scratch git repo; `--dry-run` prints the invocation). Ids, paths and
long strings redacted.

- **Invocation:** `claude -p --input-format stream-json --output-format
  stream-json --include-partial-messages --verbose --permission-prompts host
  --permission-prompt-tool stdio --model <m> [--permission-mode <mode>]
  (--session-id <uuid> | --resume <uuid>)`. Without `--permission-prompt-tool
  stdio` nothing reaches the host: every prompt is denied
  (`system/permission_denied`, tool result "…you haven't granted it yet").
  `--permission-mode` choices are `acceptEdits | auto | bypassPermissions |
  manual | dontAsk | plan` — there is **no `default`**: the phone's "default"
  means "no flag". One child serves many turns; it stays up until stdin ends.
- **User turn (stdin):** `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`
- **Per turn (stdout):** `system/init` (`session_id`, `cwd`, `model`,
  `permissionMode`, `tools`, `mcp_servers[{name,status}]`, `slash_commands`,
  `skills`), `system/status {status:"requesting"}`, then `stream_event`s
  (`message_start`, `content_block_start`, `content_block_delta` with
  `delta.type` = `text_delta {text}` | `thinking_delta` | `input_json_delta`,
  `content_block_stop`, `message_delta`, `message_stop`), whole `assistant`
  messages (`content[]` of `text` / `thinking` / `tool_use {id,name,input}`),
  `user` messages carrying `tool_result {tool_use_id, content, is_error}`,
  `rate_limit_event {rate_limit_info: {unifiedWindows: {five_hour, seven_day:
  {utilization, resetsAt}}}}`, and last `result`.
- **Result:** `{"type":"result","subtype":"success"|"error_during_execution","is_error":bool,"result":"<final text>","session_id":"<uuid>","total_cost_usd":0.0105,"num_turns":2,"duration_ms":9201,"permission_denials":[{tool_name,tool_use_id,tool_input}],"terminal_reason":"completed"}`
  — `total_cost_usd` is **cumulative for the child**, not per turn.
- **Permission prompt (stdout):**
  `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"<path>","content":"allow"},"description":"probe-allow.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_…"}}`
- **Allow (stdin):** `{"type":"control_response","response":{"subtype":"success","request_id":"<same>","response":{"behavior":"allow","updatedInput":<request.input>}}}`
  → tool runs, `permission_decision.source = "user_temporary"`.
- **Deny:** `… "response":{"behavior":"deny","message":"Denied from the phone"}` → the
  tool result is that message with `is_error: true`; the result lists it in
  `permission_denials`; the model carries on.
- **Always:** allow plus `"updatedPermissions": <request.permission_suggestions>`
  (the CLI's own "don't ask again"). For Write it was `setMode acceptEdits` for
  the session: the next write ran with `source: "config", reason_type: "mode"`,
  no prompt.
- **Interrupt (stdin):** `{"type":"control_request","request_id":"<own id>","request":{"subtype":"interrupt"}}`
  → `{"type":"control_response","response":{"subtype":"success","request_id":"<own id>","response":{"still_queued":[]}}}`,
  a `user` message "[Request interrupted by user]", and
  `result {subtype:"error_during_execution", is_error:true}`. The child stays
  usable for the next turn.
- **Resume:** a new child with `--resume <session_id>` remembered the first
  turn (answered "probe-allow.txt"); `--session-id <uuid>` pins the id up front.
- Hooks of the host's own settings run (`system/hook_started|hook_response`),
  and user/project skills, MCP servers and plugins load as in a terminal.

- **Built (H2):** `src/hostchat.js` (one child per session, the flags above,
  max 2, handlers `chat.*` merged with hostactions in `src/hostmain.js`;
  repo id -> folder only through the host's own synced project list; model
  `sonnet|opus`, mode `default|acceptEdits|plan`, `approvalTimeout` 0-1440 min,
  all checked on the host; "always" = allow + the request's
  `permission_suggestions` as `updatedPermissions`). `src/hostevents.js`
  (writer: text batched 300 ms, tool output clipped 4 KB, prune of sessions
  idle 14 days every 6 h; reader shared with the phone), migration
  `20261021130000_host_events.sql`. Full HUD switched into host mode:
  `src/hostchattabs.js` opens a read-only tab per phone session ("Driven from
  phone", stdin disabled, stays after the end until closed); headless hosts
  attach nothing. Phone page **Host** (`mobile/src/views/host.js`,
  `hostmodel.js`, `hostsend.js`).

### H3 — skills, commands, MCP, models

- The `host` snapshot lists skills, slash commands and MCP servers of that
  host. The phone offers them as a picker that inserts `/name` into the
  message (the CLI resolves it; nothing new runs on the host).
- Per-session model (Sonnet / Opus) and permission mode (default /
  acceptEdits / plan).
- KT-PC-LLM's Unity / Blender MCP servers simply show up when it is the host.
- **Built:** the heartbeat fills `skills` (the `src/skills.js` scan),
  `commands` (`~/.claude/commands/*.md`) and `mcp` (server names from
  `~/.claude.json` via `mcphealth.collectServers`), names only, capped at 300
  each by `hostSnapshot`; `sessions` = hostchat's live sessions. The Host
  page's picker inserts `/name`; model and mode are chosen per session.

### H4 — notifications + hardening

- Web Push (installed PWA, iOS 16.4+). Sender = a Supabase Edge Function
  with a VAPID key, called by the host. Events: **approval needed**,
  **session done / failed**, **host offline** (the edge function notices a
  stale heartbeat of the default host: a scheduled check), **usage** at 80 %
  and 95 % of the 5 h and weekly limits. Text in a notification is generic
  ("Approval needed on KT-NO-MMAZUR"), never command text or code.
- **Built (H4 push):** migration `20261021140000_push.sql`
  (`push_subscriptions` own rows; `push_sent` = one row per notification key,
  service role only), edge function `supabase/functions/push` (core.mjs +
  Deno entry with `npm:web-push`; bodies built from the event alone; 404/410
  subscriptions dropped; `{"event":"offline-check"}` with `x-cron-secret`
  fires once per outage of the default host, > 5 min without heartbeat),
  `src/hostpush.js` (approval / done / failed from hostchat; usage 80 % /
  95 % per window from every PC's usage put), phone `mobile/src/push.js` +
  `public/push-sw.js` (button "Enable notifications" on the Host page).
- **Not applied / deployed (Mati):** run the two migrations; `supabase
  functions deploy push --no-verify-jwt`; secrets `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` (`npx web-push generate-vapid-keys`), `VAPID_SUBJECT`,
  `OWNER_USER_ID`, `CRON_SECRET`, `PUSH_LANG`; Vercel env
  `VITE_VAPID_PUBLIC_KEY`; a dashboard cron every 2 min posting
  `{"event":"offline-check"}` with the `x-cron-secret` header.
- `ecc:security-reviewer` + `ecc:typescript-reviewer` on the whole command
  path: **done 2026-10-21**, see "Security review". Live checks on all three
  hosts: open ("Resume here").

## Security review (2026-10-21)

`ecc:security-reviewer` and `ecc:typescript-reviewer` over the whole path:
phone signing (`mobile/src/hostkey.js`, `src/hostcanon.js`), `host_commands`
RLS + claim, `hostauth.js`, `hostpairing.js`, dispatch (`hostactions.js`,
`hostmain.js`), `hostchat.js`, `hostrepos.js`, `hostevents.js` +
`host_events` RLS, the push function. Threat model: a **stolen Supabase
session** (the owner's JWT) must never make a host run anything, pair a key
or read secrets; the passkey is the gate.

**Held up (no change):** grant checks (paired key only from
`host-keys.local.json`, P-256 SPKI only, type / origin / crossOrigin /
challenge / rpIdHash / UP + UV / signature / sign count; the keys file is
re-read per command, so "Forget all phones" kills live grants); command
checks (P1363 64-byte signature over the row's own columns, so a row whose
host or kind differs from the signed bytes fails; nonce persisted before the
handler runs; no re-read between verify and run); canonical JSON (fixed
field sets, sorted keys, non-plain values throw); commit-reveal pairing
(key swap fails the commitment, a `phone_nonce` swap gives different codes,
the host dialog defaults to Reject); `git clone` (`^https://github.com/o/r$`,
`--`, absolute target: no `ext::`, no leading dash, no traversal); `claude`
flags (allow-listed model / mode, UUID session id, prompt on stdin); push
function (constant-time cron secret, session checked against
`/auth/v1/user`, `OWNER_USER_ID` scope, bodies from validated fields);
claim race (`update … where status = 'new'`, serial handling).

**Fixed (each with a test):**

| # | Sev | Finding | Fix | Test |
|---|---|---|---|---|
| S-H1 | HIGH | A stolen session can UPDATE a `permission` row of `host_events` (or pre-insert the next `seq`, so the host's real row hits the unique index) and show the phone "ls" while the host waits on `curl … sh`; `chat.approve {requestId, decision}` signed only the id, so Face ID approved the hidden tool. | The host keeps the card it emitted per pending request (`cleanCard`, the exact form the phone parses back); `chat.approve` must carry `card {tool, summary, preview}` equal to it, else `refused: card mismatch` and nothing reaches the child. The phone signs the card it showed. `cleanShort` made idempotent so a re-cleaned card still matches. | `hostchat.test.js` S-H1 ×2, `hostevents.test.js` cleanCard |
| S-M3 | HIGH (raised) | `spawn('claude', …, {cwd: repo})`: on Windows a bare name is looked up in the child's cwd before PATH, so a `claude.exe` committed to a cloned repo (`repo.clone` accepts any owner) would run on `chat.start` with no prompt. | `claudePath(env, cwd)` resolves the absolute CLI path from absolute PATH entries only and skips entries inside the repo; none → `failed: no claude`. | `hostchat.test.js` S-M3 ×2 |
| J-H1 | HIGH | No `error` listener on the child's stdin: an EPIPE from a dying child, or a `chat.send` in the 5 s grace after `chat.end` (write after end), is an uncaught exception in the headless host. | stdin `error` listener (logged); `write()` refuses once an end was requested or stdin ended; `send` emits the prompt only after a successful write. | `hostchat.test.js` J-H1 |
| J-H2 | HIGH | `chat.resume` reuses the session id but `seq` restarted at 0: every new row hit `host_events_seq_idx` and was dropped, so a resumed session showed no text, status or approval cards. | `hostevents.continueSession(id)` reads the highest stored seq before the resumed child starts. | `hostchat.test.js` J-H2, `hostevents.test.js` continueSession ×2 |
| J-H3 | HIGH | Push keys `done:<sid>:<turn>` restarted at turn 0 on resume, and the function fires a key once: a resumed session never notified done / failed. | Keys carry a per-launch id: `<kind>:<sid>:<launch>:<turn>`. | `hostchat.test.js` J-H3 |
| J-H4 | HIGH | The push function claimed the dedupe key before delivery: a send that reached no phone (push service down, subscriptions read failed) spent the key for good; `offline-check` had no try/catch. | `sendOnce`: claim → send → release the claim when nothing was sent or the send threw; `offline-check` answers 502 on failure. | `pushfn.test.mjs` ×2 |
| J-M6 | MED | A throwing `onSessionsChanged` (the heartbeat) inside `onExit` skipped `cleanup`, so the session held one of the 2 slots until restart. | `notify` / `onSessionsChanged` guarded inside hostchat. | `hostchat.test.js` J-M6 |

**Open (MEDIUM / LOW, accepted for now; no CRITICAL or HIGH left):**

- **M1 tool output in the cloud** (security): tool results (4 KB), previews
  and prompts sit in `host_events` / `host_commands` for 14 days, readable
  with a stolen session (a session that reads `.env` puts it there). Next:
  secret scrub (`sk-`, `ghp_`, `AKIA`, `-----BEGIN`, `KEY=`), shorter
  results, drop `chat.*` payloads once done.
- **M2 synced path redirect** (security): a stolen session can rewrite
  `proj:entry.path` to another existing folder; a later `chat.start` on that
  repo id runs `claude` there with that folder's project settings / hooks.
  Needs Mati to start the chat. Next: on a host, resolve repo ids only under
  the repos root or a host-local list.
- **M4 phone CSP** (security): only `frame-ancestors` is set; a future XSS on
  the phone origin could sign commands for 12 h. No `innerHTML` today. Next:
  `script-src 'self'; object-src 'none'; base-uri 'none'; connect-src` the
  Supabase project.
- **L1-L6** (security): push endpoints not allow-listed to push services and
  sent without a timeout; caller-chosen push keys can be pre-claimed or used
  for "approval needed" spam by a stolen session; `host_commands` status /
  result writable by the owner's session (denial of service, fake results,
  never a run); a host restart refuses a hardware passkey's cached grant once
  (sign count; the phone re-asks Face ID); pairing silently replaces a key
  with the same credential id; auto-clone pulls any repo of an allow-listed
  owner named by a synced row.
- **J-M5, J-M7 - J-M13** (JS): finalize on `exit` may drop the child's last
  stdout lines; a failed final `finish` strands a command in `claimed` until
  the next start (and a stop/start can fail a running one); one hung event
  insert stalls every session's feed; a cancelled approval after the final
  status re-opens a HUD tab; `host.log` rotates only at start; two
  concurrent first `signCommand`s on the phone can race to two session keys;
  prune can stall on one long session; a timed-out clone leaves a partial
  folder that counts as present.
- **JS LOW:** interrupt flag set when idle; `child.kill()` on Windows leaves
  grandchildren; an npm-installed `claude.cmd` is not found (native installer
  only); `storeSignCount` drops the keys file's 0600 mode; no retention for
  `host_commands` / `push_sent`.

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
