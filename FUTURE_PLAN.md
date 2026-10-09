# LunaCore - Roadmap

Short and current on purpose. What LunaCore *is* lives in `README.md`; how it
got here (widget contract, layout engine, packaging, the lessons each phase
cost) lives in [`reference/ENGINEERING_NOTES.md`](reference/ENGINEERING_NOTES.md).
Cleaned up 2026-10-06: ideas Mati did not keep were deleted, not parked.

## Where things stand (2026-10-09)

- **START HERE for Mission Control:**
  [`MISSION_CONTROL_ROADMAP.md`](MISSION_CONTROL_ROADMAP.md) - decisions,
  build order W1-W8 and a copy-paste starting prompt.
- **Released:** `v0.14.0` (2026-10-09) - Mission Control (Ctrl+Shift+M: mail
  cleanup, Google Calendar API, GitHub / Claude-budget telemetry, Agent-Reach
  News) and God Mode v2 below. Before it: `v0.13.0` (2026-09-25) - AI
  providers, provider-aware usage, God Mode overnight guard, "Don't sleep".
- **Shipped in v0.14.0 without its live run:** God Mode v2 - task intake (Luna MCP +
  `/luna-plan`), worktree tabs, per-tab runs, the headless planner + plan
  board, the supervisor (DONE markers, verify, push, Retry, kill switch,
  persistence), scheduled start, Sonnet->Opus escalation, file-overlap guard,
  allow-rule learning, and the integrator (PRs / merge / branches, cleanup,
  run report). Design + status: [`reference/ORCHESTRATOR_PLAN.md`](reference/ORCHESTRATOR_PLAN.md).
  Also: the usage gauge shows the real reset time, and the observer follows a
  tab across `/clear`.

## Next

1. **Live test of God Mode v2** on a small plan (2-3 to-dos, PR mode, `gh`
   logged in). Watch: workers printing `LUNA_DONE`, the first
   bypassPermissions / folder-trust prompt in a new worktree, PRs + worktree
   cleanup + `runs/<plan>.md` at the end.
2. **Mission Control W1-W8** - see [`MISSION_CONTROL_ROADMAP.md`](MISSION_CONTROL_ROADMAP.md).

## Owed live checks (unit tests cannot clear these)

- The usage-limit message text God Mode (v1 and v2) pauses on is still a
  guess - capture the real string the first time the wall is hit.
- Auto-proceed against a real dropped connection in the wild.
- The packaged-build spawn check (§D2a in the engineering notes) was last done
  on Electron 33; redo it on the current Electron 43 build.

## Known issues

- **LM Studio through claude-code-router returns HTTP 400** (AI providers
  phase 5c) - root-caused but not fixed; direct LM Studio tabs work.
- **CCR settings never clicked through with a real provider** - confirm the
  Router section and a CCR template work end to end.
- **Auto-update from `v0.9.0`** does not work (from `v0.9.1` onward it does) -
  known, not being chased.

## Ideas kept (Mati, 2026-10-06)

| Idea | What it is | First step |
|---|---|---|
| **Subagent stream visualizer** | Cards for subagents (Task spawns) running in parallel inside one tab. | Research spike: does a real multi-agent session's JSONL attribute subagent work cleanly (separate file? nested ids)? No estimate before that. |
| **Google Calendar agenda widget** | Read-only Today / Tomorrow agenda tile, colour per calendar; later a small quick-add. | Main-process `src/calendar.js` polling with the existing Google OAuth refresh token; expect an expired token on first run. Native tile, not an embedded webview. |
| **Small polish batch** | Skill search box (filter the skill list as you type), in-app cheat-sheet editor, recent-injections history, skill category override (drag a skill into the right group). | Each is small; one PR per item. |
| **Local transcript archive + search** | Index your own `~/.claude/projects/**/*.jsonl` into a searchable history ("when did I solve this before?"). Read-only, zero tokens. | Needs a real store (SQLite), not JSON; decide index refresh (on start + on turn end). |
| **Cross-provider usage ledger** | One view of Claude 5h/weekly limits + Codex / GLM / Kimi spend + local runtime. | Extends the provider-aware usage gauge; "unavailable" is a first-class state per vendor. |

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
