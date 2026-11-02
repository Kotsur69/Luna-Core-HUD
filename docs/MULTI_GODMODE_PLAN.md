# Implementation Plan: Multi God Mode v2, v1 removal, compact keep-awake chip

Status: CONFIRMED 2026-11-02 - turned into to-do cards. Nothing built yet.

## Overview
Three independent deliverables, smallest first:
- **C**: the "Don't sleep" switch becomes a small green/red chip in the terminal bar.
- **B**: the old to-do-list runner (God Mode v1) is deleted. v2's own "godmode"-named parts are left alone.
- **A**: God Mode v2 runs for several projects at once. This means one controller per project, per-project
  storage, a pause that knows about accounts, a power coordinator that looks at all runs, and a project
  switcher on the board.

### Corrections found while verifying the code
1. `godmodeLive` / `pokeGodmodeLive` (main.js:528-532, 2165-2171) belong to **v2**. They drive the
   phone's live view of a v2 run. Keep them.
2. `overnight.js` is started **only by v1**. The `godmode:run` handler (main.js:3376-3383) is the only
   caller of `startRun`, so a plain v2 run holds no keep-awake today. See decision D1.
3. The God Mode Settings pane (index.html:2094-2101) and `setup-hide-godmode` are **v2**. Keep them.
4. `godmodesummary.js` and the inbox kind `'godmode'` are **v2** run summaries. Keep them.

## Requirements
- **C**: compact chip, green = on, red = off. Not colour-only: icon, short label, aria-pressed and a
  title. Shows the unconfigured and failed states. Lives outside the to-do panel.
- **B**: v1 fully removed. v2, auto-proceed, auto-compact, Luna's Work, inbox and phone views keep
  working unchanged.
- **A**:
  - One live run per project, several projects at once.
  - The legacy `orchestra.local.json` is migrated.
  - IPC carries projectId and main validates it.
  - A limit hit pauses every run on the same Claude account.
  - A run can be pinned to an account.
  - shutdownWhenDone and sleepOnLimit consider ALL runs.
  - The same repo twice is refused.
  - Board, phone, mail, inbox and digest handle N runs.

## Slice 0 - Land the uncommitted claude-accounts work first (BLOCKER)
The working tree holds the claude-accounts feature, uncommitted:
- modified: launch, lunaswork, lunasworkWiring, main, orchestra, preload, i18n, index.html,
  providersettings, sessionenv;
- new: claudeaccounts*.js, claudeaccountsettings.js, test/claudeaccounts.test.js.

Every slice below edits main/preload/i18n/index.html, and A3 builds on claudeaccounts.js. So test and
commit that feature first. Check `git status` and `git log` before committing, and never `git add -A`.

---

## Slice C - Compact keep-awake chip (tiny, renderer only)

**Placement.** `w-terminal` (index.html:962-1033) is the `terminal` widget. It is
`remountable: false` and listed in `REQUIRED_WIDGETS` (src/layouts.js:44), so every layout has it and
it mounts once. layout.js only parks `#app-chrome`. Result: a chip next to `#update-chip`
(index.html:1028) is always visible, and the pattern is the same as `mountUpdateChip`
(update.js:104-123).

1. **index.html**
   - Delete `#keepawake-field` (620-634) from `w-todo`.
   - Add `<button type="button" id="keepawake-chip" class="palette-chip keepawake-chip" aria-pressed="false">`
     before line 1028, with:
     - an icon span (aria-hidden): sun when on, moon when off, `!` when failed;
     - a label span;
     - a `data-i18n-title`.
2. **src/renderer/modules/keepawake.js** (rewrite, about 80 lines)
   - Pure `chipView(status)` returns `{state: on|off|unconfigured|failed, labelKey, titleKey, pressed}`.
     It keeps the existing precedence: not available, then on, then error, then off.
   - `mountKeepAwakeChip(root)` reuses the existing `getKeepAwake` / `setKeepAwake` /
     `onKeepAwakeChanged` bridge. main and preload stay unchanged.
   - Unconfigured state: use `aria-disabled` plus an ignored click, not `disabled`. The tooltip has to
     keep showing the config hint.
   - Classes: `is-on` (green), `is-off` (red), `is-failed` (red + `!`), `is-unavailable` (muted, dashed).
3. **terminal.js**: mount it after `mountUpdateChip(root)` (line 59).
4. **todo.js**: drop the keep-awake import (31), the mount (822) and the cleanup (852).
5. **styles.css** (near `.update-chip`, 2718-2733)
   - The state styles, a focus ring, and no pulse under `prefers-reduced-motion`.
   - Route this through `ui-ux-pro-max`.
6. **i18n** (pl/en)
   - `keepawake.chip.on`: pl `Nie usypia`, en `Awake`.
   - `keepawake.chip.off`: pl `Usypia`, en `Sleep OK`.
   - `keepawake.chip.title.{on,off,unconfigured,failed}`.
   - Drop the old `keepawake.label/on/off` keys.
   - Fix the header of src/keepawake.js.

**Tests**: new test/keepawake-chip.test.js covering every branch of `chipView`.

**Acceptance**:
- The chip shows in every layout.
- On: green, "Awake", `aria-pressed=true`. Off: red, "Sleep OK".
- Tooltip text covers the unconfigured and failed states.
- Nothing left in the to-do widget.
- All tests green.

**Live check**:
- Toggle on and off while watching `powercfg /requests`.
- Quit while on: the script is killed.
- Without a config: the chip is muted.

---

## Slice B - Remove God Mode v1

**Delete (v1-only)**:
- src/renderer/modules/godmode.js
- src/godmodeconfirm.js
- main.js: the `godmode:run` handler (3367-3383), the `godmode:confirm` handler (3504-3520) and the
  smoke marker (837)
- preload.js: `confirmGodMode` and `setGodModeRun` (550-558)
- index.html: `#godmode-field` (605-619)
- i18n: the `godmode.label/hint/off/running/waiting*/stalled/others` keys
- styles.css: `.godmode-field` (1120), and only the `#godmode-field` selector at 5860

**Keep, edit only where noted**:
- The `godmode:signal` channel. autoproceed.js:378 uses it. Keep the name.
- autoproceed.js: drop the `isBoundSession` import and check (43, 352). It only ever covered v1, so v2
  behaviour does not change. Rewrite the header comments.
- Comment-only updates: autocompact.js:39/220, observer.js:635, main.js:1617-1618.
- Keep as v2: godmodesummary, godmodemail, godmodesnapshot, godmodelivepub, godmodeneeds, the inbox
  `'godmode'` kind, `hideGodMode`, the Settings pane, `snapshotPuts.godmode`, and the `manual` card
  flag (orchestra.js:588).
- todo.js: drop the import (30), the refresh (283), the mount (821) and the cleanup (851). This also
  removes an import cycle.

**D1 - overnight.js**:
- Recommended: retarget it to v2 workers. Call `overnight.startRun(session.id)` in orchestra's
  `createSession` dep (main.js:1037). Tab close already tears it down (main.js:1884).
- Result: v2 runs really keep the PC awake, `awake.release/restore` (main.js:1200) stops being a no-op,
  and local-model workers get the LM Studio watchdog.
- Either way, `otherRunsActive` (main.js:1204) must stop reading `overnight.current()`. Set it to
  `() => false` in B; A2 replaces it.

**Tests**:
- Delete: godmode-runs, godmode-queue, godmode-backend.
- Edit efforts.test.js: remove the `effortStep` import and test.
- Edit todo-manual.test.js: remove the v1 imports and the `pickNextItem` / `runnableCount` /
  `armCounts` / `confirmDetail` tests.
- If D1 is retarget, add a test that a worker launch calls `startRun`.
- Guard: grep src/ and test/ for `godmode.js`, `setGodModeRun`, `confirmGodMode`, `godmode:run`,
  `godmode:confirm`, `isBoundSession`. All must return zero hits.

**Acceptance**:
- No v1 switch.
- Auto-proceed still recovers a dropped connection.
- A 1-package v2 run finishes end to end.
- Smoke probe passes.
- All tests green.

---

## Slice A - Multi God Mode v2

**Design**:
- `createOrchestra` stays single-plan. The new `src/orchestraRegistry.js` holds one controller per
  projectId.
- `MAX_PARALLEL = 3` stays per run.
- Same repo twice is refused with `repoBusy`, comparing resolved, case-insensitive paths.
- Different repos cannot collide: worktree paths, the branch sweep and the overlap guard are already
  per repo or per plan.
- Ctrl+Shift+K kills ALL runs. The board's Kill button kills only the shown run.

### A1 - Per-project storage + migration
- orchestraStore:
  - `loadRun(projectId)`, `saveRun(projectId, data)`, `listStored()`.
  - Files: `config/orchestra/<sha1(projectId).slice(0,16)>.local.json`. Project ids are free strings,
    so they are never used as filenames.
  - Same contract as today: null on a broken file, false on a failed write, tmp + rename.
- `migrateLegacy`, run once at startup:
  - Read `projectId` from the legacy file. If it is null, match `repoPath` against registered projects.
  - Write the new file, then rename the legacy one to `orchestra.local.json.migrated`. Never delete it.
  - An unmatched or broken legacy file is left alone.
- main.js:1169-1178: bind projectId when the controller is created.
- Tests: new test/orchestra-store.test.js:
  - round trip;
  - two projects do not clobber each other;
  - evil ids (`..\x`, `CON`) map to hashed names;
  - migration with an explicit id and via repoPath;
  - unmatched legacy file left in place;
  - corrupt file reads as null.

### A2 - Registry + wiring/IPC extraction (main only, UI unchanged)
- **orchestraRegistry.js**:
  - `ensure`, `bySession`, `byPlanId`, `views`, `anyRunning`, `othersActive`;
  - fan-out: `tick`, `onSystemResume`, `restoreAll`, `killAll`;
  - `repoBusy`.
  - It routes `onTurnEnd`, `onUsageLimit`, `onApproval`, `onFiles` and `onSessionClosed` to the owning
    controller.
- **orchestraWiring.js**: holds the deps body moved out of main.js:1032-1230.
  - `orchestra:changed` now sends `{projectId, view}`.
  - `otherRunsActive` becomes `registry.othersActive(projectId)`.
- **orchestraIpc.js**: holds the handlers moved out of main.js:3385-3497.
  - Every payload carries `{projectId}`, validated as: a string, at most 200 chars, a registered
    project, and a controller exists.
  - planId-bearing calls are cross-checked against that controller's plan.
  - A missing projectId falls back to the active tab's project.
  - `orchestra:plan` still derives the project from the tab, never from the renderer.
  - New `orchestra:list` returns summaries of all runs.
- **Luna's Work facade**: the registry stands in for the single orchestra at:
  - main.js:1008-1016, 1265, 1321-1324, 1334-1337;
  - lunasworkWiring.js:229-230.
- main.js shrinks by about 300 lines.
- **Tests**:
  - orchestra-registry.test.js: routing by session and plan, `repoBusy`, `othersActive`, `killAll`,
    `restoreAll`.
  - orchestra-ipc.test.js: an unknown projectId, a planId mismatch, the fallback, and a bad payload.
- **Review**: `ecc:security-reviewer` on orchestraIpc.js and preload.js.

### A3 - Account-aware pause + shared power coordinator
- **Shared power flow**: the registry owns one `createPowerFlow`; orchestra.js:350-372 accepts
  `deps.powerFlow`. Rules:
  - **Sleep** only when every live run is paused, none has approvals pending, and every live run has
    sleepOnLimit on. A run with it off wins.
  - **Wake** at the earliest reset across runs.
  - **Shutdown** only when nothing is busy or active and at least one run that settled in this session
    has shutdownWhenDone on.
- **Automatic account switching (Mati, 2026-11-02 - NO per-run account pin)**:
  - Every worker of every run uses the existing claude-accounts failover (`failoverTab` in main's
    `onUsageLimit`). When one account hits its 5 h or weekly limit, the workers move to the other
    account and keep going.
  - When `failoverTab` fails because every account is limited, call `registry.pauseAll(until)`. Every
    controller with live workers runs `pauseExternal(until)`, where `until` is the EARLIEST reset
    across accounts, so the first account to come back resumes all runs.
  - The registry remembers which accounts are limited until their reset, so a worker launched later
    starts directly on an account that still has room.
- **Tests**:
  - Two-run combinations in godmode-power.test.js.
  - One account limited: workers fail over and nothing pauses.
  - Both accounts limited: every run pauses until the earliest reset.
  - A worker launched while one account is limited starts on the free account.

### A4 - Renderer board with a project switcher
- New pure `orchestraRuns.js`:
  - `summarize(list)`;
  - `defaultBoardProject(runs, activeTabProject)`: the active tab's project first, then the first live
    run.
- New `orchestraSwitcher.js`: a `role="tablist"` strip of chips (label, status dot, text state) with
  arrow-key navigation.
- orchestra.js (renderer):
  - keeps `runs: Map` plus `boardProjectId`;
  - every action passes `boardProjectId`;
  - planning still uses the active tab;
  - shows which account each worker is on and a "waiting for limit reset" state when both accounts
    are limited.
- preload: a `projectId` argument on each orchestra bridge, plus `listOrchestra()`.
- i18n: `orch.runs.*`, `orch.account.*`, `orch.err.repoBusy`.
- Tests: orchestra-runs.test.js.
- Review: `ecc:typescript-reviewer` and `ui-ux-pro-max`.

### A5 - Consumers of several runs
- **Phone**: `livesEntry(views)` in godmodesnapshot; main keeps the latest view per project; the
  publisher sends `lives`; the mobile app renders the list and falls back to `live`.
- **Verify only** (already per run): reports, godmodemail, snapshot history, inbox, nightly digest.
- Put the repo name in the morning toast and the power notices.

### A6 (optional) - Global worker cap
`deps.globalSlotsFree()` is checked in `pump`, against a total of about 6 workers across runs. Only
build this if live use shows contention.

## Risks
| Risk | Mitigation |
|---|---|
| Conflicts with the uncommitted accounts work | Slice 0 first |
| Luna's Work regression | Its tests, plus one live iteration in A2 |
| Wrong sleep or shutdown | Conservative rules, cancelable countdowns, two-run tests |
| Migration loses a run | Legacy file renamed, never deleted |
| IPC widening | Validated in main, security review |
| File size grows | New logic goes in new files; main.js shrinks |

## Decisions (confirmed by Mati 2026-11-02)
- **D1**: overnight.js is retargeted to v2 workers.
- **D2**: no per-run account pin. All runs switch between the two accounts automatically, and pause
  only when both are limited.
- **Ctrl+Shift+K** kills all runs, and it is listed FIRST in the Ctrl+/ shortcuts overlay as a
  highlighted row in a bigger font, so it is easy to remember.
- **Sleep rule**: the PC sleeps only when every live run is paused and all of them allow sleep.
- **Global worker cap**: left optional (A6).

## Success criteria
- [ ] C: green/red chip in the terminal bar with icon, label and aria-pressed; nothing left in the to-do widget
- [ ] B: zero references to v1; v2 and auto-proceed work
- [ ] A: two projects run at once; a restart restores both; the same repo twice is refused
- [ ] A: a limit pauses only same-account runs; a pinned run uses its own subscription
- [ ] A: sleep and shutdown consider all runs; phone, mail, inbox and digest show each run
- [ ] All `node --test` green after every slice
