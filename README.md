# LunaCore

**Visual GUI wrapper (dashboard) for the Claude Code CLI.**

LunaCore wraps the real `claude` CLI in an Electron window: a live terminal in the
center, clickable action buttons on the left, and a status monitor on the right.
It adds control and visibility **without spending a single extra token** — it never
injects prompts or touches the `claude` binary.

> Status: **Phases 1–4 + full backlog implemented** — interactive terminal,
> Action Injector, live Passive Observer, runtime profile switching, localhost
> ports tracker, action cheat-sheets, skill cheat-sheet, a multi-line
> **prompt library**, a **working/waiting LED**, a local **scratchpad**, a
> **command palette (Ctrl+K)**, a **token burn-rate sparkline**, a swappable
> **theming system**, a **PL/EN language switch**, a live **usage-limits gauge**
> (5-hour + weekly subscription windows), an **armed auto-compact** toggle, a
> **CWD/project switcher**, a **cyberpunk boot sequence**, and a **Skill Tracker
> that shows how long each tool actually ran**.

---

## ⚠️ Core constraint: zero extra tokens

LunaCore **must not** inject hidden system prompts, middleware, or modify the
`claude` binary. Any "smart" context analysis by an extra agent would burn the
user's context window. It works only as:

- **Passive Observer** — listens to the CLI's `stdout` stream and extracts data via
  regex on the Node.js backend (no round-trips to any model).
- **Action Injector** — GUI buttons write plain text directly to the PTY `stdin`,
  exactly as if the user typed it.

---

## Architecture

```
┌─────────────────────┬───────────────────────────────┬─────────────────────┐
│  LEFT PANEL         │       CENTER (Terminal)       │   RIGHT PANEL       │
│  (Controls)         │                               │   (Status Monitor)  │
├─────────────────────┤  ● LED: working / waiting     ├─────────────────────┤
│ [⚡ COMPACT CONTEXT]│  [tab][tab][tab]          [+] │  Context Window bar │
│                     │  [Ctrl+K] command palette     │  (of the ACTIVE tab)│
│ Auto-compact toggle │     xterm.js render area      │  + burn sparkline   │
│ Theme/lang/boot     │                               │  Usage limits       │
│ Project (cwd)       │  Claude CLI interactive       │  Skill Tracker      │
│ Profile switcher    │  session (node-pty process)   │  tiles              │
│ Action cheat-sheets │                               │  Localhost ports    │
│ Prompt library      │                               │  Scratchpad         │
│ Skill cheat-sheet   │                               │                     │
│ (panel scrolls)     │                               │  (panel scrolls)    │
└─────────────────────┴───────────────────────────────┴─────────────────────┘
```

**Data flow:**

| Direction | Path |
|-----------|------|
| Passive Observer (terminal) | `session.proc.onData` → IPC `pty:data` `{sessionId, data}` → that tab's `xterm.write()` |
| Passive Observer (Skill Tracker) | `TranscriptWatcher` → `toolEventsFromLines()` + `foldToolEvents()` pair each `tool_use` id with the `tool_result` that closes it → IPC `metrics:tools` `{events:[{phase,id,tile,at}]}` → `skilltracker.js` sweeps a tile for the tool's **real duration**. The old `detectTools()` stdout scan (ANSI strip + `Name(` regex) stays as a backstop — it broke silently when the TUI changed how it renders a tool call — and still sends the flat `{tiles}` blink. |
| Passive Observer (Context %) | per-session `TranscriptWatcher` tails **one pinned** `~/.claude/projects/<cwd>/<session>.jsonl` → real `usage` tokens → IPC `metrics:context` → that tab's bar |
| Session control | `sessions:create` / `:close` / `:activate` → main owns the `sessions` Map → broadcast `sessions:update` → tab bar rebuilds |
| Action Injector (keyboard) | `xterm.onData` → IPC `pty:write` → `ptyProcess.write()` |
| Action Injector (button) | `runCommand('/compact')` → IPC `pty:command` → writes `/compact\r` |
| Action Injector (prompt) | `pastePrompt(text, submit)` → IPC `pty:paste` → writes `ESC[200~ text ESC[201~` (bracketed paste), then `\r` only if `submit` |
| Action Injector (palette) | Ctrl+K overlay aggregates actions/cheat-sheets/prompts/skills → fires the **existing** injector for the chosen row (no new PTY channel) |
| Passive Observer (sparkline) | second `metrics:context` listener buffers the same `usage` samples → SVG sparkline + tok/min + ETA to 85% |
| Passive Observer (usage gauge) | `UsageWatcher` reads the CLI's OAuth token from `~/.claude/.credentials.json` → **GET** `api.anthropic.com/api/oauth/usage` → IPC `usage:update` → 5h + weekly bars (read-only, never `/v1/messages`) |
| Prefs (theme/language/boot) | `getThemes()`/`getUiPrefs()`/`setUiPrefs()` → IPC `themes:list` / `ui:get` / `ui:set` → reads `config/themes.json`, persists `config/ui.local.json`; renderer writes CSS tokens + xterm palette live |
| Boot sequence | renderer-only overlay: CSS drives every pixel of motion, JS only stamps `animation-delay` on the log rows and removes the node. No IPC, no PTY, no tokens |

The Context Window % divides live `usage` tokens by the window
[`src/models.js`](src/models.js) reports for the detected model — **not** a fixed
constant. Current Claude models are 1M (Opus 5, Opus 4.8/4.7/4.6, Sonnet 5,
Sonnet 4.6, Fable 5); Haiku 4.5 is the 200k exception. A model missing from that
table falls back to 200k, so the bar reads far too high — see
[Keeping the model tables current](#keeping-the-model-tables-current).

Security: the renderer has **no** direct Node.js access. All IPC goes through a
`contextBridge` preload (`contextIsolation: true`, `nodeIntegration: false`).

---

## Tech stack

| Component | Technology |
|-----------|------------|
| Desktop framework | Electron |
| Terminal core | [`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty) + [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm) + `@xterm/addon-fit` |
| Frontend | Vanilla HTML / CSS / JS (swappable themes via CSS custom properties, PL/EN i18n) |

> **Why `@lydell/node-pty` instead of `node-pty`?** It ships prebuilt N-API
> binaries, so it installs **without** node-gyp / Visual Studio Build Tools — one
> binary works across Node and Electron versions. The original `node-pty` requires
> a working C++ toolchain and fails to detect very new Visual Studio releases.

---

## Getting started

Requirements: **Node.js 18+** (tested on 24) and **Git**. No C++ build tools needed.

```bash
git clone https://github.com/Kotsur69/Luna-Core-HUD.git
cd Luna-Core-HUD
npm install
npm start
```

On launch, LunaCore spawns your default shell (`powershell.exe` on Windows,
`$SHELL` elsewhere) and auto-runs `claude` (the active profile's `command`).
Make sure the Claude Code CLI is installed. If it was installed to
`~/.local/bin` (the native-installer default) and that directory isn't on your
`PATH`, LunaCore prepends it to the session `PATH` automatically — so `claude`,
the profile auto-start, and the cheat-sheet buttons all resolve without you
having to fix `PATH` by hand.

To start in a bare shell instead of auto-launching `claude`, pick the
**Sama powloka (bez claude)** profile in the left panel, or set the active
profile's `command` to `""` in [`config/profiles.json`](config/profiles.json).

---

## Project layout

```
Luna-Core-HUD/
├── package.json
├── src/
│   ├── main.js            # main process: window + PTY + IPC channels
│   ├── observer.js        # Passive Observer: tool detection + transcript tailing
│   ├── models.js          # context-window size + pretty model label (pure, no I/O)
│   ├── rates.js           # per-model price table → session cost estimate (pure + config read)
│   ├── profiles.js        # load/validate launch profiles from config/
│   ├── ports.js           # localhost port scanner (listen ports + PID→process)
│   ├── cheatsheets.js     # load/validate action cheat-sheets from config/
│   ├── skills.js          # scan skill dirs → categorized skill cheat-sheet
│   ├── prompts.js         # load/validate multi-line prompt library from config/
│   ├── scratchpad.js      # read/write the local scratchpad note file
│   ├── projects.js        # load/validate working directories (~ expansion)
│   ├── localized.js       # {pl,en} config values: validate/normalize + merge keys (never resolves)
│   ├── theme.js           # load/validate themes from config/ (FALLBACK cyberpunk)
│   ├── uiprefs.js         # read/write UI prefs (theme + language + boot + profile) → ui.local.json
│   ├── usage.js           # UsageWatcher: GET OAuth /usage endpoint → 5h + weekly limits
│   ├── preload.js         # secure contextBridge → window.lunacore
│   └── renderer/
│       ├── index.html     # 3-panel layout
│       ├── i18n.js        # PL/EN dictionary + t() (IIFE → window.i18n only)
│       ├── renderer.js    # entry point only: imports the modules, runs the initialisers
│       ├── styles.css     # LunaCore theme tokens (:root custom properties)
│       └── modules/       # one file per concern, ES modules (see A1 below)
│           ├── bus.js         # subscriber lists: context / language / per-tab view state
│           ├── feeds.js       # one IPC listener per process-wide channel, fanned out on the bus
│           ├── registry.js    # widget table + spec validation (DOM-free, unit-tested)
│           ├── host.js        # mounts a widget from its <template> into a slot, and back out
│           ├── thresholds.js  # the context-percentage thresholds every meter reads
│           ├── util.js        # t() shortcut + loc() for config values + pulse()
│           ├── localize.js    # pickLocalized(): resolve a {pl,en} config value (pure)
│           ├── terminals.js   # one xterm per tab + the `term` facade + fit/resize
│           ├── sessions.js    # tab bar + the ONLY place pty IPC is routed
│           ├── context.js     # Context Window bar, model badge, cost line
│           ├── spark.js       # burn-rate sparkline + tok/min + ETA
│           ├── usage.js       # 5h / weekly limit meter
│           ├── led.js         # working-vs-waiting LED
│           ├── ptystatus.js   # pty status line
│           ├── skilltracker.js# tool tiles
│           ├── actions.js     # the physical COMPACT button
│           ├── autocompact.js # armed auto-compact
│           ├── palette.js     # Ctrl+K command palette
│           ├── switchers.js   # profile + project selects
│           ├── ports.js       # localhost port tracker
│           ├── cheatsheets.js # config-driven command buttons
│           ├── prompts.js     # prompt library
│           ├── skills.js      # skill cheatsheet
│           ├── scratchpad.js  # local notepad
│           ├── appearance.js  # theme + language
│           └── boot.js        # startup sequence
├── config/
│   ├── profiles.json      # launch profiles (profiles.local.json overrides, gitignored)
│   ├── projects.json      # working directories (projects.local.json overrides, gitignored)
│   ├── cheatsheets.json   # action cheat-sheets (cheatsheets.local.json overrides)
│   ├── prompts.json       # prompt library (prompts.local.json overrides, gitignored)
│   ├── themes.json        # visual themes (themes.local.json overrides, gitignored)
│   ├── rates.json         # per-model token prices for the cost HUD (rates.local.json overrides)
│   ├── ui.local.json      # persisted theme + language + boot + last profile (gitignored)
│   └── scratchpad.local.md # your scratchpad notes (created on first save, gitignored)
├── test/                  # unit tests over the pure modules (`npm test`, node --test)
├── master_prompt.md       # original build brief
├── FUTURE_PLAN.md         # roadmap: themes, layout engine, feature shortlist
└── README.md
```

---

## Widgets

A panel block that can be mounted into any slot and taken back out:

```js
defineWidget({
  id: 'ports',
  titleKey: 'ports.title',   // i18n key — a literal would freeze the HUD into one language
  template: 'w-ports',       // <template> in index.html
  mount(root) {              // root.querySelector only — ids exist only once mounted
    const off = onPortsUpdate(render);
    return () => off();      // cleanup: undo every subscription and timer
  },
});
```

**A module that grabs its elements at import time cannot be a widget.** This is
the trap every remaining conversion will hit: `skilltracker.js` used to fill its
tile map from `document.querySelectorAll('.skill-tile')` at import, which matches
nothing once the markup lives in an inert `<template>` — no error, no console
output, the tiles just never light again. Look up elements in `mount(root)`, and
prefer leaving the collection **empty** rather than `null` while unmounted, so
the render loops degrade to no-ops instead of needing a guard each.

**Not every subscription belongs in `mount()`.** The rule that survived the
`context` conversion: *subscriptions that maintain state stay module-scope; only
DOM work is per-mount.* `activeContext` is a **non-replaying** channel, unlike
`portsUpdate` / `usageUpdate` — disposing it on unmount would drop samples for
good, and `spark.js` measures a rate across a 5-minute window, so a gap does not
just lose pixels, it makes the tok/min figure and the ETA **wrong**. Keep the
subscription, make the *render* a no-op. Same reasoning keeps `skilltracker`'s
`open` map alive while its tiles are gone.

**One section can be owned by two modules.** `context` is the first such widget:
`context.js` owns the bar, badge and cost line, `spark.js` owns the sparkline and
burn rate, both inside one `.panel__section`. The contract gives one root to one
`mount()`, so `context.js` composes it — `spark.js` exports `mountSpark(root)`
returning its own disposer. The failure mode to watch for is *half* a block going
inert: a bar that works perfectly above a permanently empty sparkline, which is
easy to skim straight past. The probe counts them separately (`rows.spark`) for
exactly that reason.

That composition is also why `CTX_WARN_HIGH` / `CTX_WARN_MID` now live in
**`modules/thresholds.js`** (no imports, no DOM) with four readers — `context`,
`spark`, `autocompact`, `sessions`. Left in `context.js`, importing `mountSpark`
would have closed a genuine import cycle that worked only by accident, and its
near-miss form is silent: thresholds arriving `undefined` mean a bar that never
turns red and an auto-compact that never fires, with nothing on screen saying so.

Markup stays authored as HTML inside `<template id="w-…">` and is cloned on
mount, so the live DOM is identical to what static markup produced — the
conversion needs no CSS changes. Each template holds **exactly one root
element**, which becomes the widget root.

**IPC listeners never live in a widget.** `preload.js` exposes subscriptions as
`ipcRenderer.on(...)` with no removal, so a remounted widget could never undo
one. `modules/feeds.js` owns one listener per process-wide channel and re-emits
on the bus, whose subscriptions *do* return disposers. The feed channels replay
their last payload, so a widget mounted between two polls paints immediately
instead of waiting up to 90 s for the next usage tick.

### Checking a widget really tears down

Nothing in normal use unmounts anything, so a forgotten disposer is invisible —
the widget simply renders twice per event forever. Two handles:

```
npx electron . --luna-probe     # remounts every widget 3×, prints bus
                                # subscriber counts before/after, quits
```

```js
__luna.stats()            // subscribers per bus channel (DevTools console)
__luna.remount('ports')   // then compare — counts that grew mean a leak
```

Equal counts mean clean teardown; `rows` carries one entry per converted widget,
and a `1` there means that widget mounted exactly once, neither missing nor
duplicated.

The probe has a blind spot worth remembering: it counts **bus subscribers**, so a
leaked `setInterval` is invisible to it. `usage` (a 30 s countdown) and
`skilltracker` (its reconcile loop) both own timers that cleanup has to clear —
the symptom of getting that wrong is a tile sweeping faster after a remount, not
a number the probe reports.

**A disposer cancels effects but commits pending user intent.** The probe cannot
catch the difference. The scratchpad autosaves on a 500 ms debounce, so a
cleanup that merely cleared the timer would silently drop whatever you typed last
if the widget unmounted mid-pause — it flushes the save instead. Rule of thumb:
if a timer's callback writes something the user typed, cleanup must flush it;
purely visual ticks just stop.

`src/renderer/package.json` marks the folder `"type": "module"`, which lets Node
load these files directly — `node --check src/renderer/modules/*.js` works, and
the test suite can reach renderer modules.

**A render may write to the DOM, never read from it.** The list builders
(`cheatsheets`, `prompts`) used to recover which groups you had expanded by
querying the live nodes just before replacing them. That is fine for a language
switch, where the old nodes are still there — and loses everything on a remount,
where they are not. If a render needs to know something, that something is state
and belongs at module scope; the DOM is an output. The corollary is worth keeping
too: **chosen state must be stored, derived state must not be.** The skill
filter's query is chosen (you typed it, so it survives a remount); which
categories are expanded is derived from it, so it rebuilds itself.

**Converted so far: `ports`, `scratchpad`, `usage`, `skilltracker`, `context`
(the entire right panel), plus `autocompact`, `cheatsheets`, `prompts` and
`skills` — 9 of ~13.** What is left is `switchers`, `actions`, `appearance` and
`terminal`. A `[data-slot]` placeholder is `display: contents`, so converted and
unconverted blocks sit side by side without disturbing the flex layout.
Conversion order and the reasoning behind the contract are in
[`FUTURE_PLAN.md`](FUTURE_PLAN.md) §A2a–§A2d.

---

## Roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | Electron + `node-pty` + `xterm.js` interactive terminal | ✅ done |
| 2 | IPC channel + working `⚡ COMPACT CONTEXT` button | ✅ done |
| 3 | Passive Observer → context % bar (real tokens) + Skill Tracker tiles | ✅ done |
| 4 | Profile management (LM Studio / Codex endpoints via JSON) | ✅ done |
| + | Backlog: localhost ports tracker, action cheat-sheets, skill cheat-sheet | ✅ done |
| + | Prompt library (multi-line reusable prompts, bracketed-paste injection) | ✅ done |
| + | Working/waiting LED + local scratchpad | ✅ done |
| + | Command palette (Ctrl+K), token burn-rate sparkline | ✅ done |
| + | Theming system (5 themes, live switch) + PL/EN language switch | ✅ done |
| + | Usage-limits gauge (5-hour + weekly windows, OAuth `/usage` read) | ✅ done |
| + | Armed auto-compact toggle + scrollable right panel | ✅ done |
| + | CWD / project switcher (per-repo working directory) | ✅ done |
| + | Cyberpunk boot sequence + global reduced-motion support | ✅ done |
| + | Multi-session tabs (N PTYs, per-tab profile / cwd / context) | ✅ done |
| A3 | Test harness — `npm test` → 71 unit tests over the pure modules | ✅ done |
| B1 | Persist active profile (relaunch into the last-used one) | ✅ done |
| B2 | Context-limit auto-detect (200k vs 1M, self-correcting) | ✅ done |
| B3 | Model badge — model + detected window, all 5 themes | ✅ done |
| B4 | Session cost/time HUD — elapsed time + token→$ estimate | ✅ done |
| A1 | Split `renderer.js` → 57-line entry point + 21 ES modules | ✅ done |
| B8 | Skill Tracker shows a tool's **real duration** (sweep, not a blink) | ✅ done |
| B5–B7 | Port filter toggle, copy-transcript-path, skill search box | ✅ done |
| A2 | Widget contract + teardown probe — whole **right panel** converted (`ports`, `scratchpad`, `usage`, `skilltracker`, `context`), plus `autocompact` and the left-panel list builders (`cheatsheets`, `prompts`, `skills`) | 🟡 9 of ~13 |
| + | PL/EN localization of `config/*.json`, not just the UI chrome | ✅ done |

That closes the whole approved shortlist and the first slice of the structural
plan. **A1 is done**: the 1554-line `renderer.js` is a 57-line entry point plus
21 modules under `src/renderer/modules/`, loaded as `<script type="module">`.
Worth knowing if you fork this: Chromium blocks ES modules over `file://`, but
**Electron does not** — so this needs no bundler and no build step.

**Next up** (see [`FUTURE_PLAN.md`](FUTURE_PLAN.md) §8, which opens with a
*START HERE* box): finish the **A2** conversions — **9 of ~13 blocks** are done
(the whole right panel, plus `autocompact` and the three left-panel list
builders); what is left is `switchers`/`actions`/`appearance`, then `terminal`,
which owns the xterm panes and goes last. After that **A5**, an async skill scan,
since `scanSkills()` blocks the main process ~2.4 s today. A2 is what unblocks layout presets and movable panels. §9 sketches the
bigger open question: turning LunaCore into a multi-model console (Claude / Kimi
/ local LM Studio) rather than a Claude-only HUD.

### Tests

```bash
npm test        # node --test — 168 tests, ~1.4s, no extra dependencies
```

Covers the side-effect-free modules only: context metrics, transcript-dir
encoding, tool detection, profile/project validation, port parsing, skill
categorisation, model/context-window inference, and the burn-rate sampler with
its ETA arithmetic.

Two of them are **data** tests rather than logic tests: they assert that the
shipped `config/rates.json` and the `MODEL_WINDOWS` table actually know every
current model. Logic can be green while the tables lag a model release — that is
a real bug this project shipped (see below), and it is invisible to the fixture-based
tests around it.

### Keeping the model tables current

A new Claude model needs **two** entries, or the HUD degrades quietly:

| File | Missing entry causes |
|---|---|
| [`src/models.js`](src/models.js) → `MODEL_WINDOWS` | window falls back to 200k → context bar reads ~5× too high, and armed auto-compact fires far too early |
| [`config/rates.json`](config/rates.json) | no rate → **no cost figure at all** (deliberate: a confident wrong number is worse than none) |

This bit on 2026-07-24: `claude-opus-5` was in neither table, so Opus 5 tabs showed
`200k` and no session cost while Sonnet 5 — which was in both — worked fine. The
`npm test` data tests above now fail loudly instead.

Prices and windows go stale, which is why they live in config, not code. Use
`config/rates.local.json` (gitignored) for local overrides rather than editing the
shipped table. Note the table carries **standard** list prices — introductory
promotional pricing is deliberately not tracked, so an estimate can run high while
a promo is active.

⚠️ **Passing tests do not mean the app boots.** Nothing here launches Electron,
and `node --check` cannot catch the failure mode that has actually bricked this
app before — a name collision between `renderer.js` and `i18n.js`, back when
both were plain `<script>`s sharing one global scope. The renderer is ES modules
now, so that specific trap is gone (each module has its own scope), but a bad
import path or a missing export still fails only at runtime. Launch it by hand
before trusting a renderer change:

```bash
npx electron . --enable-logging   # pipes the renderer console to your terminal
```

A clean log means every module resolved and executed. It does **not** mean the
click handlers are wired — that still needs clicking.

The right panel lights up live: the Context Window bar reflects real `usage`
tokens from the session transcript, and Skill Tracker tiles glow when Claude runs
the matching tool (Read, Edit, Write, Shell, Grep, Glob, Web, Task — the Shell tile covers both the Bash and PowerShell tools).

A tile **sweeps left→right for as long as the tool actually runs** and flashes
once when it returns, because the transcript pairs a `tool_use` id with the
`tool_result` that closes it. The sweep loops rather than filling to a
percentage: a tool's runtime is unknowable in advance, so a progress bar would
be inventing a total. Measured over one real session, 27 of 48 tool calls
finished in under 1.5 s while a `Bash` ran 23 s — which is exactly the spread
the old fixed-duration blink could not show.

## Multi-session tabs

Run more than one `claude` at a time. Each tab owns its **own PTY process,
profile, working directory, xterm buffer and context metrics**. Background tabs
keep running and keep their scrollback — only the active pane is rendered.

- `+` opens a new tab (inherits the current profile + project).
- `×` closes one. Closing the **last** tab spawns a fresh session rather than
  leaving an empty window.
- The profile and project switchers act on the **active tab only**; the others
  are untouched.
- Each tab shows its own context `%` in its label, so a background session
  filling up is visible without switching to it.

### Two scopes — the thing to understand

| Metric | Scope | With N tabs |
|--------|-------|-------------|
| Context window (%, tokens, sparkline) | **per process** — each `claude` has its own window (1M on current models) | N independent windows, one per tab |
| 5-hour / weekly usage limits | **per account** — one shared quota | one number, drained N× faster |

So the context bar follows the active tab, while the usage gauge stays a single
global readout and is never summed per tab — it counts sessions you run outside
LunaCore too.

**The trap:** every tab can show a calm green context bar while the shared quota
burns N times faster. Per-tab metrics structurally cannot warn you about this —
only the global usage gauge can. Watch it when running several tabs.

### How a tab finds its own transcript

Claude Code stores transcripts as `~/.claude/projects/<encoded-cwd>/<session>.jsonl`
— the **directory is keyed by folder, the file by session**. Two tabs on the same
repo therefore share one directory containing two files.

LunaCore therefore **names the session itself**: every spawn mints a UUID and
starts the CLI as `claude --session-id <uuid>`. A transcript is named after its
session id, so the watcher opens `<uuid>.jsonl` directly instead of inferring
ownership. Deterministic — there is nothing left to race.

Without this the bars lie, and armed auto-compact can read another session's 90%
and inject `/compact` into the tab you're looking at.

**Fallback:** when LunaCore doesn't issue the start command — a bare-shell
profile, a hand-typed `claude`, or a `--resume` that brings its own id — there is
no UUID to pin. Those sessions fall back to the older heuristic: snapshot the
directory at startup and claim the first file created (or grown) afterwards, with
a process-wide registry stopping two watchers taking the same file. With no
candidate it reports nothing rather than a neighbour's file — a session that
hasn't exchanged anything yet really is at 0%.

Because "which transcript is this tab actually on" is a real question, the
Context Window header carries a **copy-path button** (B6). The observer sends the
file it pinned along with the metrics, so the path is per tab for free — switching
tabs restores that tab's metrics and with them *its* transcript. The button hides
itself until a file is pinned (before that there is nothing to copy) and the full
path sits in its tooltip, which is often all you wanted.

That heuristic is what used to run for *every* session, and it had a race: two
watchers poll on independent 1.5 s timers, so whichever ticked first claimed any
new transcript, no matter which tab created it. An Opus tab and a Sonnet tab
opened on one folder showed each other's numbers. Pinning by UUID removes the
guess for every session LunaCore launches itself.

## Launch profiles

The left-panel switcher restarts the PTY session under a different profile,
defined in [`config/profiles.json`](config/profiles.json):

| Field | Meaning |
|-------|---------|
| `command` | what to run in the shell (`claude`, or empty for a bare shell) |
| `args` | extra CLI arguments appended to the command |
| `env` | environment overrides for the session (e.g. `ANTHROPIC_BASE_URL` for a local LM Studio endpoint) |

Ship-safe defaults: **Claude Cloud**, **LM Studio (local)**, **bare shell**.
Drop a `config/profiles.local.json` (gitignored) to add or override profiles
by `id` without touching the committed file — handy for machine-specific keys.
Switching a profile kills the current session and starts a fresh one with the
selected environment; no extra tokens are spent.

### What LunaCore does to the spawned environment

Three fixes are applied to the inherited env before `pty.spawn`, in this order —
then your profile's `env` is merged on top, so a profile always wins:

| Step | Why |
|---|---|
| `withColorSupport()` | drops `NO_COLOR` / `FORCE_COLOR=0` and sets `TERM=xterm-256color` + `COLORTERM=truecolor`. **Claude Code sets `NO_COLOR=1`**, so launching LunaCore from a Claude Code terminal otherwise produced a completely colourless HUD — a white Claude logo instead of orange. No theme can fix that: xterm receives plain text. |
| `stripClaudeSessionMarkers()` | removes `CLAUDE_CODE*`, `CLAUDECODE`, `CLAUDE_PID` etc. A nested `claude` that sees them starts as a *child session* and **disables transcript writing** — which silently kills the context bar, sparkline, and cost HUD, since all three read the JSONL. |
| `withClaudeOnPath()` | prepends `~/.local/bin` when `claude` lives there but is not on `PATH` (native-installer machines). |

## Localhost ports tracker

The right panel lists listening TCP ports (dev servers and everything else),
scanned every few seconds via `Get-NetTCPConnection` on Windows (`lsof` on
macOS/Linux), each mapped to its owning process and PID. Per row you can open
`http://localhost:PORT` in the browser, copy the URL, or kill the process (with
a confirm). Purely local, read-only observation — no tokens spent.

The ◉ button in the section header folds away **system noise** (B5): known OS
process names, the privileged range below 1024, and the ephemeral range from
49152 up, which on Windows is nearly all RPC. A short list of well-known dev
ports (80, 443, 3000, 5173, 8080, 11434 …) always wins over the range rules — a
heuristic that hides your own web server is worse than no heuristic. The
classifier is `isSystemPort()` in [`src/ports.js`](src/ports.js) (one place,
unit-tested) and ships as a `system` flag per row; hiding is a *view* decision in
the renderer, so nothing is re-scanned when you toggle. The line under the list
always reports how many rows were folded — the filter can hide things, but never
silently. The choice persists in `config/ui.local.json` (`hideSystemPorts`,
default on).

## Action cheat-sheets

Collapsible command groups in the left panel, defined in
[`config/cheatsheets.json`](config/cheatsheets.json). Each group is a `<details>`
section with a row of buttons; clicking one injects its command straight into the
session via the Action Injector — one click, one command. Defaults cover "Review
before commit", Git, Claude session, and test/build.

Convention: a command prefixed with `!` runs as a **shell** command inside the
Claude session (e.g. `!git diff`), while an unprefixed command is typed verbatim
(slash commands like `/compact`, `/code-review`). Add a
`config/cheatsheets.local.json` (gitignored) to override groups by `title` or add
your own.

## Skill cheat-sheet

The left panel also auto-scans your Claude Code skill directories
(`~/.claude/skills`, `~/.claude/plugins`) for `SKILL.md` files, reads each one's
`name`/`description` from frontmatter, and groups them into collapsible
categories (Frontend, Backend, Data/ML, DevOps, Tests, Security, Database,
Git/Review, Docs, Other). Click a category to expand its skills; click a skill
to copy its name. Categorisation is keyword-heuristic (rough by design) and the
scan result is cached per session. Read-only, zero tokens.

With 300+ skills the list is only useful if you can narrow it, so a filter box
sits above it (B7). A query matches the **name and the description** — half of
what you remember about a skill is what it does, not its slug — and every
surviving category expands, since a list of collapsed headers is not an answer.
The counter next to the title shows `12/339` while filtering, so you can always
tell you are looking at a subset. The list is already in memory, so this is a
local re-render: no IPC, no re-scan. Escape clears the box.

## Prompt library

Action cheat-sheets handle one-liners; the prompt library handles the **multi-line
prompts you retype constantly**. Groups live in
[`config/prompts.json`](config/prompts.json), each prompt being
`{ label, text, note }` where `text` is a string *or* an array of lines (easier to
read in JSON). Clicking a prompt **pastes it without sending**, so you can append
specifics before hitting Enter; the small `⏎` button pastes and sends immediately.

Injection uses **bracketed paste mode** (`ESC[200~ … ESC[201~`) rather than a raw
write. This matters: in the Claude TUI every newline is an Enter, so a raw
multi-line write would submit at the first line and scatter the rest across
several messages. Bracketed paste tells the terminal "this is a paste, not
keystrokes" — the whole block lands in the input buffer with its line breaks
intact and nothing is sent until you say so. Drop a `config/prompts.local.json`
(gitignored) for private prompts; it overrides base groups by `title`.

## Working/waiting LED

A small dot in the terminal bar: **amber and pulsing** while Claude works,
**steady green** once it's your turn, **red** when the session ends. It adds no
IPC and no new process — the signal was already in the stream you're rendering.
The TUI streams stdout continuously while it thinks and falls quiet when it wants
input, so *data = working* and *silence past 800 ms = waiting on you*. The
threshold sits deliberately above the spinner frame rate so the LED doesn't
strobe between states.

## Scratchpad

A notepad in the right panel for snippets, TODOs and fragments you want to keep
next to the session. It autosaves 500 ms after you stop typing to
`config/scratchpad.local.md` — a plain file (gitignored, 256 KB cap) rather than
`localStorage`, so you can open and grep it outside the app. **Wklej do sesji**
injects the notes through the same bracketed-paste channel as the prompt library,
without sending, so you can still add to them first.

## Command palette (Ctrl+K)

Press **Ctrl+K** (or the chip in the terminal bar) to open a fuzzy-search overlay
over everything injectable: the COMPACT action, every cheat-sheet command, every
prompt, and every scanned skill. Type to filter (subsequence match, matched
letters highlighted), `↑`/`↓` to move, `Enter` to fire, `Esc` to close. Firing
routes to the **existing** injector for that row — a command types itself into the
session, a prompt pastes (⇧`Enter` pastes *and* sends), a skill copies its name.
Pure renderer overlay: no new PTY channel, no tokens.

## Token burn-rate sparkline

Under the Context Window bar, a small SVG sparkline plots context % over time so
you can *see* the trend, not just the current number — plus a **tok/min** burn
rate and an **ETA to 85%** (the compact zone). It piggybacks on the same `usage`
samples the bar already receives (a second `metrics:context` listener), so it adds
no polling and no tokens. The dashed line marks the 85% threshold.

**The Y axis is relative, not 0–100%.** On a fixed axis a typical drift (4% → 7%)
is about one pixel in a 30-pixel box — technically correct and useless, which is
exactly how it looked. The axis now fits the samples on screen, with a **2
percentage-point minimum span** so a genuinely flat session stays flat instead of
magnifying rounding noise into a mountain range. Read the shape for the trend and
the **tok/min + ETA** text beside it for the absolute level — a steep-looking line
does not by itself mean the window is filling fast.

## Usage-limits gauge

A right-panel tile showing how much of your Claude **subscription** limits you've
burned: the **5-hour** window and the **weekly** window (plus Opus/Sonnet weekly
splits when present), each as a bar with a percentage and a "resets in …"
countdown. This is the one piece of data that is genuinely **not** in the session
transcript or stdout, so it needs an authenticated source — but it stays
**zero-token** by design.

How it stays token-safe: `src/usage.js` reads the CLI's own OAuth access token
from `~/.claude/.credentials.json` and makes a plain **GET** to
`api.anthropic.com/api/oauth/usage` — the same read-only usage endpoint the
account uses, **never** `/v1/messages`. No prompt, no model round-trip, nothing
that spends tokens or context. LunaCore never writes to the credentials file; it
just reads the token fresh on each poll, so when the `claude` CLI refreshes and
rewrites that file, LunaCore rides the refresh for free. If the token is missing
or expired the tile shows a **reauth** hint ("run `claude` to refresh it"); a 90 s
poll plus a manual ↻ button keep it current, and a live 30 s tick updates the
reset countdown between polls. Set `ENABLE_USAGE_METER = false` at the top of
[`src/main.js`](src/main.js) to disable the network call entirely (tile shows
"off"). The bars animate via `transform: scaleX(var(--usage))` — no layout thrash.

## Theming

The whole look is a set of CSS custom-property tokens, so a "theme" is just a
values file. Ships with **cyberpunk** (default), **synthwave**, **matrix**,
**nord**, and **light**, defined in [`config/themes.json`](config/themes.json);
`src/theme.js` loads and validates them (falling back to a built-in cyberpunk if
the file is broken, same as `profiles.js`). Pick one from the **Appearance**
section in the left panel — it applies live, rewriting the CSS tokens on
`documentElement` *and* the xterm terminal palette, no reload. Each theme sets
both the UI vars (`--bg`, `--neon-magenta`, `--btn-grad`, `--glow`…) and the
terminal's ANSI colours. Drop a `config/themes.local.json` (gitignored) to add or
override themes by `id`.

## Language (PL / EN)

An **Appearance → Language** switch flips the whole UI between Polish and English
live. Static labels carry `data-i18n` / `data-i18n-ph` / `data-i18n-title`
attributes filled from [`src/renderer/i18n.js`](src/renderer/i18n.js); dynamic
strings (LED state, token counts, burn rate, palette rows) go through `t()`.

**Your config follows the switch too.** Anything you write in `config/*.json`
that ends up on screen — cheat-sheet groups, prompt labels *and prompt bodies*,
profile and project names — can be given per language:

```jsonc
"title": "Git",                                      // plain string = same in every language
"title": { "pl": "Testy / Build", "en": "Tests / Build" },
"text":  { "pl": ["linia 1", "linia 2"],             // arrays still join with newlines,
           "en": ["line 1", "line 2"] }              // per language
```

A **plain string is language-neutral**, not "untranslated": `git status`,
`/compact` and `Cyberpunk` read the same either way, and every `*.local.json` you
wrote before this keeps working unchanged. Missing languages fall back
(requested → `pl` → `en`) rather than rendering blank. Resolution happens in the
renderer, so switching language re-renders in place — and a prompt clicked in EN
pastes the **English body**, not just an English button. Commands are never
translated. See [`src/renderer/modules/localize.js`](src/renderer/modules/localize.js).

The one thing this does not cover is the `claude` CLI output in the terminal —
that is whatever the CLI itself emits. Both the theme and language choice persist
to `config/ui.local.json` (gitignored) via `src/uiprefs.js`, so the app reopens
exactly how you left it.

## Boot sequence

A ~1.4-second themed overlay on launch: the wordmark resolves, a drifting grid
and a CRT scan sweep pass behind it, a five-line subsystem log fills in, and a
progress rule closes it out. Every colour comes from the theme tokens, so it
inherits all five themes for free, and the log is translated like the rest of the
chrome.

It is decoration, and it behaves like decoration. It **never blocks**: the PTY
launches and streams underneath while it plays, and a click or any keypress
dismisses it instantly. The keypress is deliberately not consumed — it travels on
to the terminal, so skipping the animation doesn't eat the first character you
type. All the motion is CSS (`transform`/`opacity` only, no layout thrash); the
renderer just stamps `animation-delay` on the log rows and removes the node.

Turn it off under **Appearance → Boot sequence**; the choice persists to
`ui.local.json` and applies from the next launch. If your OS asks for reduced
motion, it never runs at all.

> One deliberate oddity: a small **inline** `<script>` in `index.html` force-hides
> the overlay after 4 seconds. It's there because a renderer parse error would
> otherwise leave the overlay covering the entire HUD forever — that inline timer
> is the only code that survives such a crash. LunaCore has been bricked by
> exactly that class of bug before (an i18n global colliding with `renderer.js`).

## Reduced motion

LunaCore honours the system "reduce motion" setting. The boot sequence is skipped
entirely and the decorative pulses, blinks and glow alarms collapse to nothing.
The usage-refresh spinner is the one exemption — a loading indicator is the only
continuous motion worth keeping, because it's reporting real state.

Nothing is lost by turning motion off: every signal in the HUD carries its meaning
in **colour** — the working/waiting LED, the PTY dot, the context alarm — with
movement only ever as reinforcement.

---

## Inspiration

- [`claude-code-templates`](https://github.com/davila7/claude-code-templates) by davila7 — command center for a rich set of skills, MCP servers, and agents.

## License

MIT © Mateusz Mazur
