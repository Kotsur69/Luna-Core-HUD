# LunaCore - Roadmap

Short and current on purpose. What LunaCore *is* lives in `README.md`; how it
got here (widget contract, layout engine, packaging, the lessons each phase
cost) lives in [`docs/reference/ENGINEERING_NOTES.md`](docs/reference/ENGINEERING_NOTES.md).
Cleaned up 2026-10-06: ideas Mati did not keep were deleted, not parked.

**Doc naming:** a plan whose feature is fully built and live-checked is
renamed with a `DONE_` prefix (`docs/done_docs/DONE_MISSION_CONTROL_ROADMAP.md`,
`docs/done_docs/DONE_CLOUD_SYNC_PLAN.md`, ...). Files without the prefix still have
open work. Leftover small items of a `DONE_` plan live as cards in the
LunaCore to-do list, not in the file. Plans in `docs/` sit in one of three
folders: `docs/done_docs/` (finished), `docs/tbc_docs/` (to be continued:
partly built or built with live checks owed) and `docs/untouched_docs/`
(planned, no work started). Reference guides that are not plans go in
`docs/reference/`. Move a plan with `git mv` when its state changes.

## Where things stand (2026-10-22)

- **Released:** `v0.17.0` (2026-10-22) - phone, Luna host and a sturdier God
  Mode: everything the first God Mode run built (Life check-in / habits /
  goals / weekly review, weekly + daily brief, Gmail sender + run email, bills
  into Google Calendar, Codex / Gemini / GLM / Kimi usage rows, free-provider
  fallback chains, path audit, Luna host + phone control), plus **God Mode
  never blocks** (self-healing dependency merge, integration skips bad
  packages, retry ladder, end-of-run self-check + fix-up worker, morning
  report with "Needs you"), sleep at the usage limit with a wake task,
  standalone HTML reports, usage limits for the active tab's provider only,
  tab status lights and the grouped Ctrl+L settings dialog.
  Before it: `v0.16.2` (2026-10-19) - cloud sync phase 3 (cloud is the only
  transport). `v0.16.0` / `v0.16.1` (2026-10-15) - cloud sync 2b + 2c.
  `v0.15.0` (2026-10-15) - Life dashboard + cloud sync 2a. `v0.14.0`
  (2026-10-09) - Mission Control + God Mode v2. `v0.13.0` (2026-09-25) - AI
  providers, provider-aware usage, overnight guard, "Don't sleep".
- **Done (`DONE_` docs):** Mission Control W1-W8
  ([`docs/done_docs/DONE_MISSION_CONTROL_ROADMAP.md`](docs/done_docs/DONE_MISSION_CONTROL_ROADMAP.md)),
  cloud sync + iPhone PWA ([`docs/done_docs/DONE_CLOUD_SYNC_PLAN.md`](docs/done_docs/DONE_CLOUD_SYNC_PLAN.md)),
  free providers + Luna sync ([`docs/done_docs/DONE_FREE_PROVIDERS_SYNC_PLAN.md`](docs/done_docs/DONE_FREE_PROVIDERS_SYNC_PLAN.md)),
  the path audit ([`docs/done_docs/DONE_PATH_AUDIT.md`](docs/done_docs/DONE_PATH_AUDIT.md)) and
  the first God Mode run report ([`docs/done_docs/DONE_GODMODE_RUN_2026-10-20.md`](docs/done_docs/DONE_GODMODE_RUN_2026-10-20.md)).
  Mati's live checks of all of it passed 2026-10-22; push notifications,
  Gmail and the Google OAuth app are set up.
- **Still open (re-checked 2026-11-05, v0.23.0):** every plan in
  `docs/tbc_docs/` is built and on `main`; each owes Mati's live checks
  (its "Resume here" lists them): Luna host + phone pairing
  ([`docs/tbc_docs/REMOTE_HOST_PLAN.md`](docs/tbc_docs/REMOTE_HOST_PLAN.md)),
  Claude account failover + per-account meter, plus the usage-login refresh fix
  ([`docs/tbc_docs/CLAUDE_ACCOUNTS_PLAN.md`](docs/tbc_docs/CLAUDE_ACCOUNTS_PLAN.md)),
  multi God Mode ([`docs/tbc_docs/MULTI_GODMODE_PLAN.md`](docs/tbc_docs/MULTI_GODMODE_PLAN.md)),
  the notification hub ([`docs/tbc_docs/NOTIFICATION_HUB_PLAN.md`](docs/tbc_docs/NOTIFICATION_HUB_PLAN.md))
  and Luna's Work ([`docs/tbc_docs/LUNAS_WORK_PLAN.md`](docs/tbc_docs/LUNAS_WORK_PLAN.md)).
  The cards in the to-do list cover the rest.
- **Built since (moved out of "Still open" / "Known issues"):** LM Studio via
  CCR (`2fa07c5`), the `js-yaml` audit fix (`5e5eb4e`), cloud "forget this PC"
  (`ee209e9`), host security M1 / M2 (`30f4e77`) and M4 phone CSP, the
  FreeLLMAPI port + gateway status row + overlay copy skip and the Setup
  Center + getting-started guide (all `e9a385f`), and usage limits for the
  active tab's provider only (`696a870`).

## Next

1. **Pair the phone with a host** (`[Mati]` card) - the only part of the
   host plan nobody has run yet.
2. **Work the to-do cards** above (a God Mode night run can take them; the
   `[Mati]` cards are marked manual and stay out of it).
3. **Notification hub** - built (N1-N6, released in v0.23.0); live check
   owed, then fold the old '!' inbox into it.
   Plan: [`docs/tbc_docs/NOTIFICATION_HUB_PLAN.md`](docs/tbc_docs/NOTIFICATION_HUB_PLAN.md).
4. **Release prep for friends** - decided 2026-10-22: **option B**, every
   new user brings their **own** Supabase project (Mati's stays single-user,
   sign-ups off). The Setup Center in Ctrl+L and the first-launch
   getting-started guide are built (`e9a385f`).
5. **Think through ideas 3 + 4 together** (polish batch + local transcript
   archive) - see *Ideas kept*.

## Owed live checks (unit tests cannot clear these)

- The usage-limit message text God Mode pauses on is a pattern
  (`src/orchestraPlanWait.js` `LIMIT_TEXT_RE`) - confirm it the first time
  the wall is hit during a run, then check the planner resumes on its own at
  the reset time (the board shows the resume time + Cancel meanwhile).
- ~~Auto-proceed against a real dropped connection in the wild.~~ - **PASS 2026-11-06** (Mati).
- ~~The packaged-build spawn check (§D2a) on Electron 43~~ - **PASS
  2026-11-04** on a `v0.20.0` `npm run dist` build (Electron 43.7.5, Node
  24.21, ABI 148). (1) An in-process check ran the packaged `LunaCore.exe`
  as Node (`ELECTRON_RUN_AS_NODE`). It loaded `@lydell/node-pty` from
  `app.asar` (native addon from `app.asar.unpacked`), spawned the default
  shell in a real ConPTY, and `claude --version` printed `2.1.318 (Claude
  Code)`. (2) `--luna-probe` on the packaged exe ran with
  `PORTABLE_EXECUTABLE_DIR` and `--user-data-dir` in a temp folder, so the
  live config was untouched. Results: 25 widgets mounted and remounted, 9
  presets and 28 themes from inside the asar, equal bus counts, every `rows`
  1. Terminal tab `s1` was created with its intake MCP config. (3) The asar
  holds 0 `*.local.json`. The `helpers/` that are rewritten to
  `app.asar.unpacked` (agent-reach, playtest-bridge) resolve. **Failed:**
  the three `.ps1` helpers do not resolve (see *Known issues*). Still
  eyes-only: the HUD fonts, theme persistence across a restart and the
  taskbar icon.
- **Luna host + phone pairing** on KT-PC-LLM, KT-NO-MMAZUR and the MacBook,
  then a signed `news.scan`, `repo.clone` and a chat with Allow / Deny /
  Always, Stop, End, Resume; "Forget all phones" must refuse the next
  command. Steps: [`docs/tbc_docs/REMOTE_HOST_PLAN.md`](docs/tbc_docs/REMOTE_HOST_PLAN.md)
  "Resume here". The claude CLI on a Windows host must be the native install
  (`~/.local/bin/claude.exe`).

## Known issues

- **Packaged build: mic state, now playing / volume and TTS cannot find
  their scripts** (found by the 2026-11-04 spawn check). `src/devices.js`,
  `src/media.js` and `src/tts.js` hand PowerShell
  `-File <resources>\app.asar\helpers\...\*.ps1`. That path exists only
  inside the archive, so an external process cannot open it (`Test-Path`
  False). The files do ship unpacked. Fix: apply the same
  `.replace('app.asar' + sep, 'app.asar.unpacked' + sep)` that
  `src/missionnews.js` / `src/lunasworkBridge.js` use. `npm start` is not
  affected.
- **CCR settings never clicked through with a real provider** - confirm the
  Router section and a CCR template work end to end. `[Mati]` card in the
  to-do list.
- **Auto-update from `v0.9.0`** does not work (from `v0.9.1` onward it does) -
  known, not being chased.

## Ideas kept (Mati, 2026-10-06; reviewed 2026-10-22)

| Idea | What it is | Status / first step |
|---|---|---|
| **Local transcript archive + search** | Index your own `~/.claude/projects/**/*.jsonl` into a searchable history ("when did I solve this before?"). Read-only, zero tokens. | **Next to think about (productivity), together with the polish batch below.** Needs a real store (SQLite), not JSON; decide index refresh (on start + on turn end). |
| **Small polish batch** | Skill search box (filter the skill list as you type), in-app cheat-sheet editor, recent-injections history, skill category override (drag a skill into the right group). | Planned together with the transcript archive (recent-injections history and search overlap with it). |
| **Subagent stream visualizer** | Cards for subagents (Task spawns) running in parallel inside one tab. | Parked. Research spike first: does a real multi-agent session's JSONL attribute subagent work cleanly (separate file? nested ids)? |
| **Cross-provider usage ledger** | One view of Claude 5h/weekly limits + Codex / GLM / Kimi spend + local runtime. | Parked (Mati, 2026-10-22). The per-provider usage rows (v0.17.0) cover the day-to-day need. |
| ~~**Google Calendar agenda widget**~~ | Today / Tomorrow agenda with quick add. | ✅ Done - Mission Control's calendar (`src/renderer/modules/missioncalendar.js`: agenda + month + quick add + click-to-edit, `src/gcal.js`). No separate HUD tile planned. |

## Rules every idea must keep

- **Zero extra tokens.** A feature is a Passive Observer (reads stdout /
  transcripts / files) or an Action Injector (types into the PTY). The only
  deliberate exceptions are user-initiated: `/ask`, the God Mode planner,
  workers and the merge-conflict resolver.
- **Config-driven, degrade gracefully.** Shipped `config/*.json` + your
  `*.local.json` overrides; a broken file falls back, never a blank window.
- **Widgets tear down cleanly.** Run `npx electron . --luna-probe` after any
  widget change - equal subscriber counts before/after and `rows: 1` means
  clean (engineering notes §A2a / §A2b).

## Verification commands

```bash
npm test                      # all unit tests, a few seconds, no extra deps
npx electron . --luna-probe   # remounts every widget, cycles every layout, prints bus counts
npm start                     # the only way to check anything interactive
npm run dist                  # NSIS installer + portable .exe -> dist/
```
