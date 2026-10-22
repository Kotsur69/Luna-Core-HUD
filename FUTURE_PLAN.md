# LunaCore - Roadmap

Short and current on purpose. What LunaCore *is* lives in `README.md`; how it
got here (widget contract, layout engine, packaging, the lessons each phase
cost) lives in [`reference/ENGINEERING_NOTES.md`](reference/ENGINEERING_NOTES.md).
Cleaned up 2026-10-06: ideas Mati did not keep were deleted, not parked.

**Doc naming:** a plan whose feature is fully built and live-checked is
renamed with a `DONE_` prefix (`DONE_MISSION_CONTROL_ROADMAP.md`,
`docs/DONE_CLOUD_SYNC_PLAN.md`, ...). Files without the prefix still have
open work. Leftover small items of a `DONE_` plan live as cards in the
LunaCore to-do list, not in the file.

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
  ([`DONE_MISSION_CONTROL_ROADMAP.md`](DONE_MISSION_CONTROL_ROADMAP.md)),
  cloud sync + iPhone PWA ([`docs/DONE_CLOUD_SYNC_PLAN.md`](docs/DONE_CLOUD_SYNC_PLAN.md)),
  free providers + Luna sync ([`docs/DONE_FREE_PROVIDERS_SYNC_PLAN.md`](docs/DONE_FREE_PROVIDERS_SYNC_PLAN.md)),
  the path audit ([`docs/DONE_PATH_AUDIT.md`](docs/DONE_PATH_AUDIT.md)) and
  the first God Mode run report ([`docs/DONE_GODMODE_RUN_2026-10-20.md`](docs/DONE_GODMODE_RUN_2026-10-20.md)).
  Mati's live checks of all of it passed 2026-10-22; push notifications,
  Gmail and the Google OAuth app are set up.
- **Still open:** Luna host + phone pairing
  ([`docs/REMOTE_HOST_PLAN.md`](docs/REMOTE_HOST_PLAN.md)), and the cards in
  the to-do list (LM Studio via CCR, FreeLLMAPI port + status row, overlay
  copy skip, `js-yaml` audit, cloud "forget this PC", host security M1 / M2 /
  M4).

## Next

1. **Pair the phone with a host** (`[Mati]` card) - the only part of the
   host plan nobody has run yet.
2. **Work the to-do cards** above (a God Mode night run can take them; the
   `[Mati]` cards are marked manual and stay out of it).
3. **Notification hub** - face icon + badge, a vertical "Needs you" drawer,
   the God Mode summary on every PC, the brief moved out of Mission Control.
   Plan: [`docs/NOTIFICATION_HUB_PLAN.md`](docs/NOTIFICATION_HUB_PLAN.md)
   (open questions first).
4. **Release prep for friends** - decided 2026-10-22: **option B**, every
   new user brings their **own** Supabase project (Mati's stays single-user,
   sign-ups off). Cards: Setup Center in Ctrl+L (status + guide for every
   integration) and a first-launch getting-started guide that never shows
   again once dismissed.
5. **Think through ideas 3 + 4 together** (polish batch + local transcript
   archive) - see *Ideas kept*.

## Owed live checks (unit tests cannot clear these)

- The usage-limit message text God Mode pauses on is a pattern
  (`src/orchestraPlanWait.js` `LIMIT_TEXT_RE`) - confirm it the first time
  the wall is hit during a run, then check the planner resumes on its own at
  the reset time (the board shows the resume time + Cancel meanwhile).
- Auto-proceed against a real dropped connection in the wild.
- The packaged-build spawn check (§D2a in the engineering notes) was last done
  on Electron 33; redo it on the current Electron 43 build.
- **Luna host + phone pairing** on KT-PC-LLM, KT-NO-MMAZUR and the MacBook,
  then a signed `news.scan`, `repo.clone` and a chat with Allow / Deny /
  Always, Stop, End, Resume; "Forget all phones" must refuse the next
  command. Steps: [`docs/REMOTE_HOST_PLAN.md`](docs/REMOTE_HOST_PLAN.md)
  "Resume here". The claude CLI on a Windows host must be the native install
  (`~/.local/bin/claude.exe`).

## Known issues

- **Usage panel lists every provider at once** - Mati wants only the active
  tab's profile provider (Claude limits on a Claude tab, Codex on a Codex
  tab). Card in the to-do list.
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
