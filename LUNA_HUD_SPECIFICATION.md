# ARCHITECTURAL SPECIFICATION & MODULE ROADMAP
## Project: LunaCore HUD — Electron Dashboard for the Claude Code CLI

**Document Version:** 2.1.0 (2026-10-06 — inventory and idea record brought up to date)
**Target Environment:** Windows (primary, current release target) — Electron is cross-platform, so macOS/Linux are not blocked, just untested
**Core Ecosystem:** Electron 43, Node.js, `@lydell/node-pty`, `@xterm/xterm`, vanilla HTML/CSS/JS
**Integration Target:** Claude Code CLI (`claude`), run as a real child process — never reimplemented, never prompted

---

## 0. Why this document exists, and what it doesn't repeat

`README.md` and `FUTURE_PLAN.md` are the living source of truth for what LunaCore
*is right now* and what's next — this document does not restate their content.

- **`README.md`** — current features, exact IPC data flow, tech stack, install/build.
- **`FUTURE_PLAN.md`** — the short roadmap: next steps, owed live checks, known issues, kept ideas.
- **`reference/`** — one design/build record per shipped feature (God Mode v2 in
  `ORCHESTRATOR_PLAN.md`, sounds, heatmap, transparency, ...) plus
  `ENGINEERING_NOTES.md`, the widget-contract and phase history code comments cite.
- **This document** — §1–4 are a short orientation, §5 is the reusable recipe for
  adding a widget, §6 is the record of module ideas and what became of them.

---

## 1. Executive Summary & Vision

LunaCore HUD is an Electron desktop app that wraps the real `claude` CLI: live
interactive terminals in the center (genuine PTY sessions via `node-pty`, one per
tab), clickable action buttons on the left, and status widgets on the right. It
adds visibility and control **without spending a single extra token** — no hidden
prompts, no middleware model calls, no touching the `claude` binary itself.

The one rule every feature has to pass, restated from `README.md`:

- **Passive Observer** — reads `stdout`/transcript JSONL, extracts data on the
  Node.js backend. No round-trips to any model.
- **Action Injector** — writes plain text to a PTY's `stdin`, exactly as if Mati
  typed it himself.
- **Local-only feedback** (sound/voice) — no CLI data read, no network, no model.

The deliberate exceptions are all **user-initiated** model calls with a visible
trigger: `/ask` (Ctrl+B), and God Mode v2's planner, workers and merge-conflict
resolver (Mati arms a run and approves the plan). A background agent that decides
on its own to call a model still fails the spec by construction.

---

## 2. Real Tech Stack

| Layer | Technology | Notes |
| :--- | :--- | :--- |
| Desktop framework | Electron 43 | `contextIsolation: true`, `nodeIntegration: false`, CSP `default-src 'none'` |
| Terminal core | [`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty) + [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm) + `@xterm/addon-fit` | N-API prebuilt binaries — survives Electron's Node-ABI jumps without a rebuild |
| Frontend | Vanilla HTML / CSS / JS | CSS custom-property theming (32 themes incl. the `glass` family), PL/EN i18n, no framework, no bundler |
| Audio (optional) | [`mpv`](https://mpv.io/) | Persistent `--idle` process over a JSON IPC pipe; not bundled, every sound feature degrades silently without it |
| Voice synthesis (optional) | Windows SAPI via `System.Speech` | Fully offline — see `reference/SOUNDS_IMPLEMENTATION_PLAN.md` §2 |
| Git / GitHub | `git` (worktrees, push), `gh` (God Mode PRs) | Run via `execFile`, never a shell; `gh` only needed for PR mode |

---

## 3. Architecture (orientation only — see `README.md` for the full data-flow table)

```
┌─────────────────────┬───────────────────────────────┬─────────────────────┐
│  LEFT PANEL         │       CENTER (Terminals)      │   RIGHT PANEL       │
│  (Controls)         │                               │   (Status Monitor)  │
├─────────────────────┤  ● LED: working / waiting     ├─────────────────────┤
│ Action Injector      │  [tab][tab][⑂ tab]        [+] │  Passive Observer   │
│ buttons/switchers,   │  xterm.js render area         │  widgets (context,   │
│ To-Do + God Mode     │  ← node-pty ← real `claude`   │  tokens, tools,      │
│ (write to PTY stdin) │     child process per tab      │  files, usage...)   │
└─────────────────────┴───────────────────────────────┴─────────────────────┘

Main process (Node, full access)  <── contextBridge/IPC ──>  Renderer (sandboxed, no Node)
      │                                                              │
      ├─ node-pty session per tab ─────────────────────────────────►│ xterm.write()
      ├─ TranscriptWatcher per tab (pinned <uuid>.jsonl) ──────────►│ widget modules
      ├─ God Mode v2 run controller (orchestra*.js, git worktrees) ─►│ plan board
      ├─ soundManager (mpv --idle, JSON IPC)  ────────────────────► │ (via sound:play)
      └─ config/*.json + *.local.json (prefs, themes, profiles) ───►│ (via ui:get/set)
```

Two data sources feed every Passive-Observer widget: the PTY's raw `stdout` and
the transcript JSONL `claude` writes to disk. New widgets should prefer the
transcript — it's structured and doesn't break when the CLI's rendering changes.

---

## 4. Module inventory

A scan reference so a new idea can be checked against what's already built.

**Renderer (`src/renderer/modules/`), by area:**

- **Shell & widgets:** `host.js`, `registry.js`, `layout.js`, `layoutbuilder.js`,
  `panels.js`, `widgetarrange.js`, `feeds.js`, `bus.js`, `util.js`, `localize.js`,
  `motion.js`, `flip.js`, `boot.js`, `brand.js`, `moonphase.js`, `claudecheck.js`,
  `update.js`, `diagnostics.js`.
- **Terminals & tabs:** `terminal.js`, `terminals.js`, `termlinks.js`,
  `sessions.js`, `ptystatus.js`, `led.js`, `termcustom.js` (Ctrl+L Settings).
- **Left panel / injectors:** `actions.js`, `switchers.js`, `appearance.js`,
  `modifiers.js`, `surfacealpha.js`, `cheatsheets.js`, `skills.js`, `prompts.js`,
  `palette.js` (Ctrl+K), `shortcuts.js`, `shortcutspanel.js`, `gitquick.js` +
  `gitquick-format.js` (Ctrl+G), `scratchpad.js`, `clipboard.js`.
- **Right panel / observers:** `context.js`, `spark.js`, `usage.js`,
  `thresholds.js`, `skilltracker.js`, `activefiles.js`, `sessiontimeline.js`,
  `mcp.js`, `git.js`, `ports.js`, `telemetry.js`, `media.js`, `devices.js`.
- **Automation:** `todo.js`, `godmode.js` (v1 per-tab runs), `orchestra.js`
  (God Mode v2 plan board / run board), `orchestrasettings.js`, `autocompact.js`,
  `autoproceed.js`, `keepawake.js`, `notify.js`.
- **AI providers & tools:** `providersettings.js`, `providerform.js`,
  `ccrsettings.js`, `lmstudiomodels.js`, `lmstudioloadform.js`, `ask.js` /
  `askview.js` / `askcommand.js` (`/ask`), `highlights.js` / `highlightsview.js`
  / `highlightscommand.js`, `libraries.js` / `librariesview.js` / `libicons.js`.
- **Sound:** `sound.js`, `keysynth.js`.

**Backend (`src/`), by area:** process + IPC owner `main.js`, `preload.js`
(the `contextBridge` surface); transcripts `observer.js`, `filestat.js`,
`sessionExport.js`, `models.js`, `rates.js`; git `gitstation.js`, `gitfiles.js`,
`filediff.js`, `worktrees.js`; God Mode `todo.js`, `intake.js` (Luna MCP),
`overnight.js`, `orchestra.js`, `orchestraPlan.js`, `orchestraSupervisor.js`,
`orchestraFinish.js`, `orchestraFinalize.js`, `orchestraIntegrate.js`,
`orchestraReport.js`, `orchestraStore.js`; providers `profiles.js`,
`providers.js`, `profileinput.js`, `sessionenv.js`, `launch.js`, `locallaunch.js`,
`lmstudio*.js`, `ccr.js`, `ccrcontrol.js`, `usage.js`; sound `soundManager.js`,
`soundTriggers.js`, `sounds.js`, `tts.js`, `ttsExtract.js`, `voiceduck.js`;
system `telemetry.js`, `gpu.js`, `media.js`, `devices.js`, `ports.js`,
`keepawake.js`, `clipboard.js`, `screenshots.js`, `mcphealth.js`; config
`paths.js`, `uiprefs.js`, `theme.js`, `layouts.js`, `localized.js`,
`cheatsheets.js`, `prompts.js`, `skills.js`, `libraries.js`, `projects.js`.

---

## 5. How to add a new Passive-Observer widget

A repeatable recipe:

1. **Find the data.** Prefer the transcript JSONL over stdout scraping — it's
   structured. `observer.js`'s `TranscriptWatcher` already tails it per-session;
   extend its callback payload rather than opening a second watcher.
2. **Write a pure extractor.** A function that takes raw text/JSON lines and
   returns the data you need — no I/O, no side effects. This is what gets unit
   tested (`node --test`). Example: `ttsExtract.js`'s `extractSpokenText()`.
3. **Add a pref, if the feature should be opt-in.** `uiprefs.js`'s `DEFAULTS`
   object, plus the matching read/write branch — default to `false` for anything
   that changes behavior a user hasn't asked for yet (sound, voice, auto-anything).
4. **Wire it in `main.js`.** Call the extractor from the relevant
   `TranscriptWatcher`/PTY callback, gate it on the pref, push results over IPC.
   Keep the gate as narrow as the feature's actual purpose. `main.js` is far past
   the size guideline — prefer a new module with injected deps.
5. **Add the renderer widget module.** New file in `src/renderer/modules/`,
   registered via `registry.js`'s `defineWidget()`. Repaint from module state on
   mount (a remount must reflect truth, not the template's authored defaults —
   `reference/ENGINEERING_NOTES.md` §A2c).
6. **i18n.** Every user-facing string gets a PL and EN entry in `i18n.js`.
7. **Test the pure functions, not the OS wrappers.** Thin process/IPC wrappers
   (`soundManager.js`, `tts.js`) aren't tested; pure logic is.
8. **Check teardown** with `npx electron . --luna-probe`, then update
   `README.md`'s data-flow table — not this document.

---

## 6. Module ideas — what became of them

Scored originally against the zero-token rule and the real Electron/Windows
stack. Kept as a record so an idea is not proposed twice.

| Idea | Outcome |
| :--- | :--- |
| Session Timeline & Snapshot Scrubber | **Shipped** 2026-08-17; Markdown export 2026-08-27. |
| Active-Files Edit Heatmap | **Shipped** 2026-08-13 — [`reference/ACTIVE_FILES_HEATMAP_PLAN.md`](reference/ACTIVE_FILES_HEATMAP_PLAN.md). |
| Media Deck (now-playing + volume) | **Shipped** 2026-08-17 via Windows GSMTC + Core Audio (no Spotify API, no network). Voice ducking shipped later (`src/voiceduck.js`). |
| Terminal Appearance Customizer | **Shipped** 2026-08-13, grew into the Ctrl+L Settings overlay — [`reference/TERMINAL_CUSTOMIZER_PLAN.md`](reference/TERMINAL_CUSTOMIZER_PLAN.md). |
| Multi-Agent (Subagent) Stream Visualizer | **Kept** — on the roadmap, gated on a research spike (`FUTURE_PLAN.md`). |
| Parallel multi-model task routing | **Became God Mode v2** — explicit, user-approved planning + worktree workers, not a silent router — [`reference/ORCHESTRATOR_PLAN.md`](reference/ORCHESTRATOR_PLAN.md). |
| Local-LLM Hybrid Router (auto-route) | **Dropped** — a background routing decision breaks the zero-token rule. Explicit local models exist instead (AI providers, LM Studio profiles). |

---

## 7. What this document deliberately does not contain

No milestones, no schedule, no boilerplate. When an idea gets picked up it goes
into `FUTURE_PLAN.md` and, once real, its own short plan doc under `reference/`.
