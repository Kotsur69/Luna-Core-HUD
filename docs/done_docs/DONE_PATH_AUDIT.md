# Path audit - machine-specific paths

> **✅ DONE (2026-10-21).** Every finding fixed or kept on purpose, with regression tests in `test/pathaudit.test.js`. Released in v0.17.0.

Two PCs (`C:\Users\Kotsur69`, `C:\Users\mmazur`), cloud-synced config. Goal:
no path written on one PC breaks the other, and a missing folder is reported
as a missing folder - never as "claude / gh not found".

Shared helpers, all in `src/projects.js` (nothing duplicated elsewhere):
`expandHome` (now takes an injectable home), `rehomePath`, `toPortablePath`,
`resolveProjectDir`, `normalizeProject`, plus two new ones built on them:

- `resolveStoredPath(p, exists, home)` - "~" expanded; another user's home
  re-homed when the original does not exist here; else the expanded path
  (so the caller can still say "missing").
- `checkCwd(dir, isDir)` - `{ok}` or `{ok:false, error:'missingCwd'}`, called
  BEFORE a spawn/execFile that would otherwise fail with ENOENT.

Regression tests: `test/pathaudit.test.js` (injected `exists`/`isDir`), which
also scans `src/`, `config/`, `scripts/` for literal user-home paths.

## 1. Literal user-home paths in code and config

Scanned `src/`, `config/`, `scripts/`, `test/`, `package.json` for
`[A-Za-z]:\Users\<name>`, `/Users/`, `/home/`, `Kotsur69`, `mmazur`,
`AppData`, `Desktop`, `source\repos`.

| Where | Finding | Status |
|---|---|---|
| `src/**` | No literal home path in code. Mentions are comments only (`observer.js`, `projects.js`, `missionrepokey.js`). | Kept - comments, documentation of the formats handled. |
| `src/update.js` `REPO_OWNER = 'Kotsur69'`, `package.json` `publish.owner` | GitHub owner of the release feed, not a path. | Kept - the updater must name the repo; allow-listed in the scan test. |
| `src/gitstation.js` `DEFAULT_ROOTS` | Built from `os.homedir()` at runtime. | Kept - computed per machine. |
| `config/projects.json` `lunacore` | `~/Desktop/repos/Luna-Core-HUD` only - the repo lives in `~/source/repos` on the other PC. | **Fixed** - candidate list `["~/Desktop/repos/...", "~/source/repos/..."]` (`normalizeProject` picks the first that exists). |
| `config/*.json` (others) | No paths. | OK. |
| `scripts/*.ps1`, `*.sh`, `*.mjs`, `*.js` | No home paths (all relative / `$HOME`). | OK. |
| `test/**` fixtures | `C:\Users\mmazur\...`, `/home/mati/...`, `Kotsur69` as INPUTS to path / git / GitHub parsers. | Kept - they are the cases under test; nothing reads them as real folders. |

## 2. Code that writes absolute paths into persisted / synced files

| File (writer) | Synced? | Finding | Status |
|---|---|---|---|
| `projects.local.json` (`projects.js addProject`, `projectsync.js`) | yes (cloud `config`) | Already stores `~\...` and re-homes on read. | OK (previous commit 380be03). |
| `repos.local.json` (`gitstation.js saveRepoList`) | no, but copied with the config folder | Stored absolute repo paths and absolute default roots. | **Fixed** - written home-relative (`portableRepoList`), re-homed on load (`localPaths` -> `resolveStoredPath`), duplicates dropped. |
| `orchestra.local.json` (`orchestraStore.js`) | no | God Mode run: `repoPath`, per-package worktree `root`/`cwd`, `briefPath` - absolute. A run saved under the other user name was silently dropped by `loadState` (repo not a registered project). | **Fixed** - re-homed on read: `loadState` matches the re-homed repo, `restore()` runs `rehomePlanPaths` (repo, roots, cwds, briefs). Kept absolute on write: worktrees are per-machine by nature. |
| `keepawake.local.json` (hand-written) | no | Absolute `.bat` path only. | **Fixed** - `~\...` accepted, another user's home re-homed on read; still validated (absolute, `.bat/.cmd`, no cmd metacharacters). |
| `todo.local.json`, todo sync | yes | Keyed by project id, no paths. | OK. |
| `ui.local.json` (`uiprefs.js`) | no | No path fields. | OK. |
| `prompts/libraries/rates/missioncontrol.local.json` (docsync) | yes | URLs and text, no paths. | OK. |
| `mission-projects.local.json` | yes | Repo keys from the git remote (`missionrepokey.js`), not folders; the old `sharedDir` is dropped on read. | OK. |
| `profiles.local.json` / provider templates | no | Env values are the user's own; `gatewayHome` is a boolean, the overlay home is computed from userData per spawn. | Kept - nothing LunaCore writes is a path. |
| `lunasync.local.json` | no | Picked skill ids only. | OK. |
| Luna overlay (`<userData>/luna-overlay/*`, `lunasyncio.js`) | no | MCP server commands copied from `~/.claude.json` may be absolute. | Kept - rebuilt from the local `~/.claude.json` on every spawn, lives in this PC's userData. |
| Worktree records (`.luna-worktrees/<repo>/<slug>`) | no | Derived from the repo path at creation. | Kept - per machine; see the God Mode row for restored runs. |
| Session export / screenshots / TTS / scratchpad | no | Files at a chosen or userData location; no path stored for later. | OK. |

## 3. Spawns / execFile / fs on a persisted cwd

| Site | Finding | Status |
|---|---|---|
| `main.js spawnInto` (tabs, `cwd: project.path`, `activeCwd`) | Already `safeCwd` -> re-homed dir or start dir, with a "folder missing" notice in the tab. | OK. |
| `main.js orchestra:plan` | Already `resolveProjectDir` -> `noRepo`. | OK. |
| `orchestraPlan.js runPlanner` | Missing `cwd` -> ENOENT -> `noClaude`. | **Fixed** - `checkCwd` first -> `noRepo` (own message). |
| `orchestraIntegrate.js createPr` (gh in `repoPath`) | ENOENT -> `noGh`. | **Fixed** - `missingCwd` (pl/en message on the board). |
| `orchestraIntegrate.js runResolver` (claude in worktree) | ENOENT -> "claude not found". | **Fixed** - "working folder missing: <path>". |
| `orchestraFinish.js finishPackage` (git + verify in worktree) | git/verify on a deleted worktree. | **Fixed** - "worktree folder missing: <path>" before any git call. |
| `main.js sessions:createWorktree` (`project.path`) | Missing folder read as `notRepo`. | **Fixed** - `resolveProjectDir`, own `noFolder` error (pl/en). |
| `gitstation.js readRepoStatus` (configured repos) | Missing folder shown as "not a repo". | **Fixed** - `missingDir` (pl/en). |
| `gitstation.js` quick actions (`commitAll`, `pushCurrent`, `fetchDir`) | Run in the tab's cwd, which `spawnInto` already made safe. | Kept. |
| `missionrunner.js` | `cwd: os.tmpdir()` on purpose. | OK. |
| `ask.js runAsk` | No cwd (inherits the main process). | OK. |
| `launch.js`, `lunasync*.js`, `projectsync.js` | No spawn with a persisted cwd (projectsync is file I/O through the projects helpers). | OK. |
| `main.js` editor open (`session.cwd`) | Safe cwd from `spawnInto`; paths resolved inside it (`resolveInRoot`). | OK. |

## Config-loader contract

Unchanged everywhere it applies: safe read, validation at the boundary, a
broken file yields an empty list (`loadRepoList`, `normalizeStoredPlan`,
`resolveScript`, the new `freechains.js` loader).
