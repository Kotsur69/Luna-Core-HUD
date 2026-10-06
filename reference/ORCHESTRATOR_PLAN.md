# LunaCore - God Mode v2 "Orchestrator" (multi-tab to-do runner)

Status: PLAN (2026-10-04). Slice 0 (task intake) BUILT 2026-10-04:
`src/intake.js`, card fields in `src/todo.js`, widget cards + live repaint,
Settings toggle, `~/.claude/commands/luna-plan.md`. Slice 1 (worktree tabs)
BUILT 2026-10-04: `src/worktrees.js`, `createSession` cwd/branch override,
tab-bar ⑂ button. node_modules is NOT junction-linked: `git worktree remove
--force` follows the junction and empties the main checkout's node_modules
(verified) - workers install their own. Slice 2 (per-tab v1) BUILT
2026-10-04: God Mode state per tab; runs sharing a list claim items, honour
`dependsOn`, serialize ticks, stall on deadlock; overnight guard takes a SET
of runs (one shared recovery per local server). Division is automatic, not
manual (tab ids don't survive a restart). Slice 3 (planner) BUILT
2026-10-04: `src/orchestraPlan.js` (headless `claude -p --json-schema`,
prompt on stdin, read-only tools, validation + estimate), `src/orchestra.js`
(plan held in main, Approve/Launch -> worktree + brief file + tab),
`withTaskBrief` in `src/launch.js`, `#orchestra` overlay
(`modules/orchestra.js`). Workers get their brief as the CLI's positional
first message pointing at `<userDir>/tasks/<slug>.md` + `--add-dir` (no
typing into a shell that may not run Claude yet; verified the read needs no
permission prompt). Approve launches dependency-free packages only (max 3);
dependents keep a manual Launch until the slice-4 supervisor. Plan is
in-memory (persistence = slice 4); workers run in default permission mode.
Slice 4 CORE (supervisor + finish) BUILT 2026-10-06: `src/orchestraSupervisor.js`
(pure rules: marker parsing, nudge/verify caps, ready-to-launch, restore),
`src/orchestraFinish.js` (commit leftovers -> refuse empty branch -> verify
ourselves -> `git push -u origin <branch>`), `src/orchestraStore.js`
(`config/orchestra.local.json`). Approve now STARTS the run: dependents launch
by themselves once their dependencies are pushed; to-dos tick on push. Turn
end without `LUNA_DONE` -> nudge (5 s delay, max 3) -> stalled; red verify ->
pasted back (max 2) -> stalled; approval prompt / 2 h working time ->
stalled; usage limit -> run-wide pause + one resume timer. A stalled worker
that later prints `LUNA_DONE` on its open tab still finishes. Kill switch:
board button + Ctrl+Shift+K (in-window, not a global OS hotkey) - Esc to
every worker, worktrees kept. Retry per package (nudge an open tab, or reopen
its worktree with a "resuming" brief). After a restart the run comes back
held, running packages stalled (`restarted`). Workers: Settings -> God Mode v2
- model (default **Opus everywhere**, or per plan) and permission mode
(default **bypassPermissions**, Mati 2026-10-06), frozen per run.
Slice 4 second pass BUILT 2026-10-06: #2 Approve can start now / at HH:MM /
when the 5 h window resets (re-armed after a restart if still ahead); #5 an
approval stall logs the tool it asked about (last open tool_use in the
transcript tail -> `Bash(npx tsc:*)`), the board offers "Allow" and main
accepts only rules the run logged -> `--allowedTools` for later workers; #6
a Sonnet worker stalled twice (noMarker/blocked/verify/timeout/noCommits) is
restarted once on Opus in its worktree with the reason in the brief; #7 each
worker's git status (GitFileWatcher) + its pushed diff feed `touched`, pairs
of non-dependent packages sharing a file warn once and land in PR bodies.
Dependents now branch from their dependency's pushed head (extra deps merged
in). Slice 5 BUILT 2026-10-06 (`src/orchestraIntegrate.js`,
`src/orchestraFinalize.js`, `src/orchestraReport.js`): when a run settles -
or "Finish run" on the board - integrate per mode (default **PRs**, Mati
2026-10-06; or merge into the base branch via an integration worktree from
origin/<base>, verify after each merge, one headless resolver per conflict,
push without force; or branches only), close pushed tabs + remove their
worktrees (stalled ones kept), note unfinished packages on their to-dos, write
`<userDir>/runs/<plan>.md` + an OS toast when notifications are on. Not
built: budget cap (§3), `config/orchestra.json` allowlist file (rules live in
ui prefs instead), per-worktree `npm ci` for workers (the worker installs).
Successor of `GODMODE_PLAN.md` (v1 = one tab, one list, sequential).

## Goal

Mati arms God Mode v2 on a project's to-do list. An **orchestrator** turns the
list into self-contained work packages, LunaCore **spawns one tab per package**
(the same tabs Ctrl+T makes), each worker session runs its package unattended,
and when everything is done **every session's work is committed and pushed** -
safely, without N sessions trampling one working tree or racing each other to
`main`.

## The four hard problems (why this is not "v1 x N")

1. **Shared working tree.** All tabs of a project today run in the SAME `cwd`
   (`createSession` -> `project.path`). N Claudes editing one checkout = edits
   interleave, `git add -A` from session A commits session B's half-written
   file, and "commit from every session" becomes meaningless.
   -> **one git worktree + branch per worker** is non-negotiable.
2. **Shared to-do list.** `todo.local.json` is keyed by **projectId**, not by
   tab, so every tab of a project sees the same list. v1's "tick item done on
   turn end" would let worker 2 tick worker 1's item.
   -> the orchestrator owns assignment; workers never read the list.
3. **Approval prompts.** An unattended worker that hits "Allow Bash(npm test)?"
   sits forever (v1 has the same hole - only the nudge suffix papers over
   clarifying questions, not permission dialogs).
   -> workers launch with a pre-approved permission profile scoped to their
   worktree, and `approvalPrompt` detection becomes a **stall** signal.
4. **Push races + merge conflicts.** N branches pushed straight to `main` =
   the 2nd push is rejected, the 3rd conflicts.
   -> workers push **their own branch**; integration into `main` is a separate,
   sequential, gated step run by LunaCore, not by the workers.

## Architecture

```
 To-do list (project) ──► ORCHESTRATOR (headless `claude -p`, no tab)
                              │  plan.json: packages[], deps, prompts, files
                              ▼
                     LunaCore run controller (main process, new src/orchestra.js)
          ┌───────────────┬───────────────┬───────────────┐
          ▼               ▼               ▼
   worktree A/tab A  worktree B/tab B  worktree C/tab C   (max N parallel)
   branch luna/run-x/a  …/b             …/c
   claude TUI (visible, watchable, takeover-able)
          │ turn end + DONE marker / verify
          ▼
   per-worker gate: tests green -> commit -> push branch
          ▼
   INTEGRATOR (sequential): rebase/merge branches into main in dep order,
   tests after each, push main  ──► report + cleanup worktrees
```

### Roles

| Role | Runs as | Why |
|---|---|---|
| Orchestrator (planner) | `claude -p --output-format json --json-schema plan.schema.json --max-budget-usd X` in the project root, read-only tools | Planning is one structured answer, not a conversation. Headless = parseable output, no TUI scraping, no tab wasted. |
| Workers | normal LunaCore tabs (`createSession` + new `cwd` override), interactive `claude` | Mati can watch any of them, click in, take over. All existing per-tab machinery (LED, context bar, onTurnEnd, autoproceed, notify) works for free. |
| Run controller | main process (`src/orchestra.js`), NOT the renderer | v1 lives in the renderer at module scope; a run that spans many tabs, git ops and hours belongs next to the PTYs and must survive a renderer reload. Renderer just shows status. |
| Integrator | deterministic git in main (+ optional `claude -p` only when a conflict appears) | Merging is mechanical 95% of the time; spend tokens only on real conflicts. |

## Flow, step by step

### 0. Arm (confirm-gated, as v1 decision #5)
Native dialog shows: N open to-dos, max parallel workers, budget cap,
target branch, "push to main at the end? yes/no". Refuse to arm if the project
working tree is dirty (or offer "stash first") and if `git` remote is missing.

### 1. Plan (orchestrator)
Input: open to-dos + repo map (CLAUDE.md, file tree, recent `git log`). Output
validated against a JSON schema:

```json
{
  "packages": [
    {
      "id": "a",
      "title": "Fix drag scroll in todo widget",
      "todoAts": [1727900000000],
      "prompt": "Self-contained instructions ... Definition of done: ...",
      "files": ["src/renderer/modules/todo.js", "test/todo.test.js"],
      "dependsOn": [],
      "verify": "npm test"
    }
  ],
  "notes": "why grouped this way"
}
```

Rules given to the planner: group to-dos that touch the same files into ONE
package (file overlap is the #1 conflict source); every prompt must be
self-contained (the worker has no other context); each package ends with a
concrete definition of done; mark real dependencies only.
LunaCore validates: every open to-do covered exactly once, no cycles in
`dependsOn`, `files` overlap between parallel packages -> warn or serialize.

**Plan review gate (recommended default ON):** show the plan in an overlay
(packages, prompts, file sets) - Approve / Edit / Cancel. This is the cheapest
place to catch a bad decomposition; everything after it costs N x tokens.

### 2. Spawn workers
For each ready package (deps satisfied), up to `maxParallel` (default 3):
1. `git worktree add <repo>/../.luna-worktrees/<run>/<pkg> -b luna/<run>/<pkg> <base>`
   (outside the repo so watchers/tests of the main checkout don't see it).
2. Copy what the worktree needs but git doesn't have: `.env*` the project
   lists, and run install if `package-lock`/`uv.lock` exists (`npm ci` / `uv sync`)
   - NOT a `node_modules` junction: `git worktree remove --force` follows it
   and wipes the main checkout's copy (verified in slice 1).
3. `createSession({ projectId, profileId, cwd: worktreePath, label: pkg.title, run })`
   - **new `cwd` override** in `createSession`, everything else unchanged.
4. Launch flags for the worker: `--permission-mode acceptEdits` +
   `--allowedTools` from a per-project allowlist (`config/orchestra.json`,
   e.g. `Bash(npm test:*)`, `Bash(git add:*)`, `Bash(git commit:*)`), plus
   `--append-system-prompt` with the worker contract (below).
5. Paste `pkg.prompt` (bracketed paste, existing `pty:paste`).

Worker contract (appended system prompt):
- you are in an isolated worktree on branch X; do not touch other branches,
  do not push, do not merge;
- finish by running `<verify>`, fix until green;
- then commit your work with a conventional message;
- print exactly `LUNA_DONE <pkg>` or `LUNA_BLOCKED <pkg>: <reason>` as the
  last line.

### 3. Supervise
Per worker, the controller listens to signals that ALREADY exist per session:
- `onTurnEnd` (transcript, structural) -> check last assistant text for
  `LUNA_DONE`/`LUNA_BLOCKED`. Turn ended with neither -> send ONE nudge
  ("continue until done, then print LUNA_DONE"), max K times -> stalled.
- `usageLimit` -> **run-wide** pause (the limit is per account, not per tab):
  all workers wait, one shared poll timer, resume all.
- `connectionError` -> v1 per-tab retry logic, reused unchanged.
- `approvalPrompt` -> worker `stalled: needs approval`, notify, keep others
  running.
- Budget: sum of per-session cost (telemetry/usage already parses tokens) vs
  the armed cap -> stop spawning new workers, let running ones finish.
- Wall-clock cap per worker (e.g. 90 min) -> stalled.

### 4. Per-worker finish (deterministic, LunaCore not Claude)
On `LUNA_DONE`:
1. `git status --porcelain` in the worktree; uncommitted leftovers -> commit
   them as `chore: luna wip <pkg>` (or nudge the worker once).
2. Run `verify` **ourselves** in the worktree. Red -> paste the failure back to
   the worker (max 2 rounds) -> else stalled.
3. `git push -u origin luna/<run>/<pkg>`.
4. Tick the package's to-dos done in `todo.local.json` (by `at`, like v1).
5. Close the tab (or keep it, setting) and free the slot -> spawn next ready
   package.

### 5. Integrate (after all packages done or stalled)
Mode chosen at arm time:
- **A. Branches only** - stop after step 4. Safest; Mati merges.
- **B. PRs** - `gh pr create` per branch with the plan's notes. Good for
  public repos (LunaCore itself is public).
- **C. Auto-merge to main** - integration branch `luna/<run>/integration`
  from `main`; merge packages in dependency order; `verify` after each merge;
  conflict -> one headless `claude -p` in an integration worktree to resolve,
  verify again, else stop and report. All green -> fast-forward `main`, push.
  Never force-push; never push `main` with a red verify.

### 6. Report + cleanup
Run summary overlay + markdown file in `config/runs/<run>.md`: per package
status, branch, commit SHAs, cost, duration, stall reasons. Remove worktrees
of merged/pushed packages (`git worktree remove`), keep stalled ones for
inspection. Voice cue: done / needs you (existing `voice.*`).

## State + persistence

`config/orchestra.local.json` holds the run: plan, per-package phase
(`queued | spawning | running | verifying | pushed | merged | stalled`), session
ids, worktree paths, branch names, cost. Written on every transition so a
crash/restart of LunaCore can **resume**: re-attach to live tabs, mark dead
ones stalled, offer "resume run". (v1 loses its run on reload - v2 shouldn't,
since runs are hours long and multi-tab.)

## Files (expected)

- `src/orchestra.js` - NEW, run controller state machine (pure step functions
  exported for tests, like `backendSignalStep`).
- `src/orchestraPlan.js` - NEW, headless planner call + schema validation +
  coverage/cycle/overlap checks (pure, heavily tested).
- `src/worktrees.js` - NEW, add/remove/list, env copy, install.
- `src/integrate.js` - NEW, merge/verify/push sequence.
- `src/main.js` - `createSession` `cwd`/`label`/`launchArgs` overrides; IPC
  `orchestra:*`; `godmode:run` overnight guard accepts a SET of sessions.
- `src/preload.js` - `orchestra.*` bridge.
- `src/renderer/modules/orchestra.js` - NEW, arm dialog, plan review overlay,
  run board (one row per package: LED, phase, cost, "jump to tab").
- `config/orchestra.json` - allowlist, maxParallel, budget, verify defaults.
- `config/plan.schema.json` - orchestrator output schema.
- tests: `test/orchestra*.test.js`, `test/worktrees.test.js` (temp git repos).

## Build order (each slice shippable)

0. **Task intake** - Luna MCP server + `luna_todo_add` + `/luna-plan` + task
   cards in the widget. Useful immediately with v1 God Mode, before any
   multi-tab work exists.
1. **Worktree tabs** - `createSession` cwd override + "New tab in worktree"
   (manual). Proves watchers, git widget, transcript lookup all work from a
   worktree cwd. Small, immediately useful on its own.
2. **Per-tab v1** - make v1 God Mode bindable to several tabs at once (state
   per session instead of module singletons) with a per-tab item list. Gives
   parallelism with manual assignment, reuses all tested v1 logic.
3. **Planner** - headless `claude -p --json-schema`, plan review overlay,
   no spawning yet (plan -> Approve -> creates the tabs + pastes prompts).
4. **Supervisor + finish** - DONE markers, verify, commit, push branch,
   run board, persistence/resume.
5. **Integrator** - modes A/B/C, conflict resolver, report.

## Task intake from the terminal ("describe it to Claude, it lands in To-do")

Mechanism: **LunaCore exposes a tiny MCP server** from the main process -
HTTP on `127.0.0.1`, random port, per-launch bearer token (same pattern as
`src/lmstudioshim.js`). Every tab LunaCore spawns gets it via
`--mcp-config <generated json>`, so only LunaCore tabs see it and no global
`.mcp.json` is touched. Tools:

- `luna_todo_add(tasks[])` - append task cards to THIS tab's project list.
- `luna_todo_list()` - read the list back (dedupe, "what's queued?").
- `luna_todo_update(at, patch)` - refine a card.

Main resolves the project from the calling session's token (one token per
session), so Claude never passes paths/ids it could get wrong.

Paired with a slash command `/luna-plan` (`~/.claude/commands/luna-plan.md`):
"Interview me briefly about what I want, split it into independent tasks,
read the code enough to name the files each touches, then call
luna_todo_add. Do not implement anything." Mati talks normally, Claude
writes the cards, the To-do widget repaints live (existing
`syncTodoProject`), Mati arms God Mode.

Cost: one MCP tool schema (~300 tokens) in LunaCore tabs only - the single
deliberate exception to the zero-extra-tokens rule, and opt-in (Settings
toggle "Expose to-do tools to Claude", default ON only for new tabs).

Rejected alternatives: scraping a `TODO:` marker from stdout (fragile under
TUI redraws, no structure); importing Claude's own `TodoWrite` from the
transcript (that is Claude's per-turn scratch plan, not Mati's intent -
could be an optional "import Claude's plan" button later).

### Task cards instead of one-line to-dos

Today an item is `{text, done, at}`. v2 card (all new fields optional, so old
lists keep working):

```json
{ "text": "...", "done": false, "at": 0,
  "details": "self-contained prompt", "acceptance": ["..."],
  "files": ["src/x.js"], "verify": "npm test",
  "size": "S|M|L", "model": "sonnet|opus", "dependsOn": [0] }
```

When intake already produced good cards, the orchestrator's job shrinks from
"invent the decomposition" to "validate + group + order" - cheaper, and the
plan matches what Mati actually described. Widget shows cards collapsed
(title + size chip + file count), expand for details.

## Improvement ideas (ranked by value / cost)

**Approved by Mati 2026-10-04: #2, #3, #5, #6, #7, #8, #9 - IN SCOPE.**
#1 (review gate) and #4 (takeover auto-pause) are NOT selected - parked, do
not build unless asked again.

| # | Idea | Status | Lands in build slice |
|---|---|---|---|
| 2 | Scheduled / window-aware start | approved | 4 (supervisor) |
| 3 | Cost + time estimate before arming | approved | 3 (planner / arm dialog) |
| 5 | Stall learning -> allowlist suggestions | approved | 4 + report |
| 6 | Escalation on stall (Sonnet -> Opus) | approved | 4 |
| 7 | Live file-overlap guard | approved | 4 (+ serialize merges in 5) |
| 8 | Morning report + re-add stalled as to-dos | approved | 5 |
| 9 | Kill switch (hotkey + run-board button) | approved | 4 (must exist before any unattended multi-tab run) |
| 1 | Review gate per package | parked | - |
| 4 | Takeover = auto-pause | parked | - |

1. **Review gate per package** *(parked)* - before pushing a branch, a fresh headless
   `claude -p` runs a code review on `git diff base..branch` (ECC
   code-reviewer prompt). CRITICAL/HIGH -> back to the worker once. Catches
   what the author-session is blind to; cheap compared to the work itself.
2. **Scheduled / window-aware start** - "Start at 01:00" or "start when the 5h
   window resets" (usage widget already knows the reset). Overnight runs
   begin with a full window instead of hitting the wall after 20 minutes.
3. **Cost + time estimate before arming** - from card sizes and models ->
   "≈ 3 workers, ~2 h, ~X% of the weekly limit". The confirm dialog then means
   something.
4. **Takeover = auto-pause** *(parked)* - if Mati types into a worker tab, the supervisor
   pauses THAT worker (no nudges fighting him); a "hand back" chip resumes it.
5. **Stall learning** - log every approval prompt that stalled a worker; at the
   end of the run: "Bash(npx tsc) stalled 3 workers - add to allowlist?" The
   allowlist grows from evidence instead of guesses.
6. **Escalation on stall** - a Sonnet worker stalled twice on the same package
   -> restart that package once on Opus with the stall reason appended.
7. **Live file-overlap guard** - Active-Files heatmap already sees which files
   each tab touches; two workers editing the same file at runtime -> warn, and
   serialize their merges.
8. **Morning report** - run summary as a markdown file + OS notification
   (existing `notify.js`): merged / PR links / stalled-with-reason / cost.
   Optionally re-add stalled packages as to-dos with the reason attached.
9. **Kill switch** - one global hotkey + run-board button: stop spawning,
   send Esc to all workers, keep worktrees for inspection.

## Risks / open decisions for Mati

- **Permission posture.** `acceptEdits` + allowlist (recommended) vs
  `bypassPermissions` (faster, but an unattended agent with full Bash in your
  user account). Worktree isolation limits git damage, not filesystem damage.
- **Cost.** N parallel Opus sessions burn the 5h window ~N x faster; the run
  will hit the usage wall sooner, and a run-wide pause is the right response.
  Consider Sonnet for workers, Opus for planner/integrator (profile per role).
- **Default integration mode.** Recommend B (PRs) for public repos, C only per
  project opt-in.
- **Max parallel.** 3 is a sane default (RAM: each `claude` + node + watchers;
  plus per-worktree `npm ci`).
- **Two-PC workflow.** Run branches are pushed, so the other PC sees them;
  `orchestra.local.json` is local-only - a run resumes only on the PC that
  started it.
- **usageLimit text is still a guess** (v1 note) - capture the real string
  before relying on the run-wide pause.
