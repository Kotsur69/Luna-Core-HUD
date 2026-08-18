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
> **CWD/project switcher** (now with a native "add repo folder" picker), a
> **cyberpunk boot sequence**, a **Skill Tracker that shows how long each
> tool actually ran**, an **Active-Files Edit Heatmap** (real diff-stat
> counts, live-edit pulse, deleted-file flag), **GPU usage** next to CPU/RAM,
> optional **sound & voice feedback** (mpv-based, degrades silently if mpv
> isn't installed), a **per-project pin-board todo list**, and opt-in **OS
> notifications** (busy→idle, 85% context) that focus the window and jump to
> the right tab when clicked.

---

## Download

**[Latest release →](https://github.com/Kotsur69/Luna-Core-HUD/releases/latest)** — Windows x64.

| File | What it is |
|------|------------|
| `LunaCore-Setup-0.9.2.exe` | Installer (NSIS). Installs **per-user, so there is no admin prompt**. Adds Start Menu and desktop shortcuts, and an uninstaller. |
| `LunaCore-0.9.2-portable.exe` | One file, no installation. Keeps its settings in a `LunaCore-config` folder **next to the `.exe`**, so it travels with a USB stick or a synced folder. |

You still need the **Claude Code CLI** installed and logged in — LunaCore runs the
real `claude`, it does not replace or reimplement it. If `claude` is not on your
`PATH`, LunaCore still opens a working shell and says so in the corner instead of
handing you a dead black rectangle.

### Windows will warn you on first launch

The binary is **not code-signed**, so SmartScreen shows *"Windows protected your
PC"*. That message means *unknown publisher*, not *malware found* — every
unsigned application gets it, and a signing certificate costs a few hundred a
year. To continue: **More info → Run anyway**.

If you would rather not trust a stranger's binary, don't: `npm install && npm run
dist` builds the exact same two files from this source tree.

---

## What LunaCore reads, writes and sends

LunaCore reads your Claude Code **credentials file**. An application that does
that without saying so plainly has no business on anyone's machine, so here is
the complete list — all of it verifiable in the linked source.

**Reads — never modifies:**

| Path | Why | Source |
|------|-----|--------|
| `~/.claude/.credentials.json` | Borrows the OAuth token the CLI already stores, to ask the API how much of your 5-hour and weekly limits are gone. A single `readFileSync`. LunaCore **never writes this file** and never refreshes the token — it rides whatever the CLI last put there. | [`src/usage.js`](src/usage.js) |
| `~/.claude/projects/**/*.jsonl` | The CLI's own transcripts. The context %, the cost estimate and the Skill Tracker durations all come from the `usage` numbers the API itself reported — measured, not guessed. | [`src/observer.js`](src/observer.js) |
| `~/.claude/skills`, `~/.claude/plugins` | Builds the skill cheat-sheet by scanning for `SKILL.md`. LunaCore **shows** what that machine has; it never installs, edits or removes a skill. | [`src/skills.js`](src/skills.js) |
| *(no file)* — node's own `os` module | Total/free RAM, per-core CPU tick counters, uptime, every 2 s, for the System widget. No file, no shell command, no process list — LunaCore can tell you the machine is at 80% RAM, never **what** is using it. Off switch: `ENABLE_TELEMETRY = false` in [`src/main.js`](src/main.js). | [`src/telemetry.js`](src/telemetry.js) |
| *(no file)* — `Get-Counter` via `powershell.exe` | GPU usage for the System widget, every 3 s. Windows-only, vendor-agnostic: the same DXGI "GPU Engine" counters Task Manager's own GPU column reads — no NVIDIA/AMD SDK. Resolves `null` (row shows `--`) off Windows or if the counter is unavailable. | [`src/gpu.js`](src/gpu.js) |
| Whatever paths the Active-Files Heatmap is currently tracking | `fs.existsSync` per file, every ~5 s, so a file deleted outside an Edit/Write (e.g. a terminal `rm`) shows as **deleted** instead of silently keeping its last diff stat. The renderer has no `fs` access itself (context isolation) — this is a narrow, read-only IPC round trip, not a directory scan. | [`src/main.js`](src/main.js) (`files:check-exist`) |
| *(no file)* — the **system clipboard** — **OFF by default, opt-in** | The Clipboard widget's history. This is the only thing in this table LunaCore does **not** read unless you switch it on, and the reason is that it is the only one that would see things you never showed it — anything you copy anywhere on the machine, password managers included. Unchecked, the watcher is not running at all, not merely hidden. Checked, it polls `clipboard.readText()` every 1.2 s and keeps the last 20 text clips (clips over 4000 characters are skipped entirely). Pref: `clipboardEnabled` in `ui.local.json`. | [`src/clipboard.js`](src/clipboard.js) |
| *(no file)* — the default **microphone's** mute flag via `powershell.exe` | The Devices widget reads whether your mic is muted — on mount, after you press the button, and when you press refresh. **No poller**, and nothing here can hear anything: it is the same Core Audio endpoint property Windows' own mic-mute key sets, not an audio stream. Mute is used precisely because it is reversible and readable; LunaCore never *disables* a device. | [`src/devices.js`](src/devices.js) |

**Writes — only inside one directory:**

| Build | Directory |
|-------|-----------|
| Installed | `%APPDATA%\LunaCore\config\` |
| Portable | `LunaCore-config\`, next to the `.exe` |
| Running from a clone | the repo's own `config/` |

- `ui.local.json` — theme, language, active profile, layout preset, boot toggle,
  which panels you folded shut and any column widths you dragged
  ([`src/uiprefs.js`](src/uiprefs.js))
- `scratchpad.local.md` — whatever you typed into the scratchpad
  ([`src/scratchpad.js`](src/scratchpad.js))
- `projects.local.json` — **only when you click the "+" next to the Project
  switcher**: opens a native OS folder-picker dialog and appends the folder
  you chose (label defaults to the folder's own name). Same
  base-then-`.local.json`-override merge as every other config file — never
  touches the shipped `config/projects.json`.
  ([`src/projects.js`](src/projects.js))
- `todo.local.json` — the pin-board todo list
  ([`src/todo.js`](src/todo.js))
- `clipboard.local.json` — **only while the Clipboard widget is switched on**:
  the last 20 text clips, in plain text. Switching the widget off stops the
  watcher; **Clear history** deletes this file.
  ([`src/clipboard.js`](src/clipboard.js))

Nothing else anywhere on your disk is written. The shipped `config/*.json`
defaults are read-only; your overrides live beside them as `*.local.json` and are
merged on top, which is why an update can still deliver a new theme or a
corrected rate table.

**Network — two endpoints, both reads:**

| Request | When | Why | Off switch |
|---------|------|-----|------------|
| `GET https://api.anthropic.com/api/oauth/usage` | every 90 s | Draws the usage gauge (5-hour + weekly limits). | `ENABLE_USAGE_METER = false` in [`src/main.js`](src/main.js) |
| `GET https://api.github.com/repos/Kotsur69/Luna-Core-HUD/releases/…` | **once, at launch** | Asks whether a newer LunaCore exists. | `ENABLE_AUTO_UPDATE = false` in [`src/main.js`](src/main.js) |

Set both to `false` and the app makes **no network requests at all**.

Neither request ever calls `/v1/messages`, which is precisely why LunaCore
**cannot spend your tokens** — see *Core constraint* below.

**About the update check specifically.** It only *asks*. Nothing is downloaded
until you click **Download**, and nothing is installed until you click **Install
and restart** — `autoDownload` and `autoInstallOnAppQuit` are both off
([`src/update.js`](src/update.js), [`src/main.js`](src/main.js)). That is
deliberate: the release binary is **unsigned**, so an 80 MB installer arriving in
the background would be exactly the behaviour this section exists to rule out.
When you do accept an update, it is verified against the SHA-512 in `latest.yml`
fetched over HTTPS — but understand that this is *not* the same as a
code-signing check. If you would rather not rely on that, turn the check off and
download releases by hand.

The **portable build never updates itself** and says so in the UI. It has no
installation to replace, so an in-place update would silently leave a *second*,
installed copy of LunaCore on your disk — it points you at the Releases page
instead.

The UI process is additionally locked down with a Content-Security-Policy of
`connect-src 'none'`: the renderer **structurally cannot** reach the network, no
matter what it is asked to display.

**Runs:** your default shell (`powershell.exe` on Windows, `$SHELL` elsewhere)
and, inside it, the active profile's command — normally `claude`. That is the
terminal in the middle of the window, and it is a real one. If `mpv` is on
`PATH`, LunaCore also spawns one persistent `mpv --idle` process for UI sound
feedback — entirely optional and entirely local, controlled over a JSON IPC
pipe (no per-event process spawn). Without `mpv`, the HUD is identical; every
sound call becomes a silent no-op.

---

## ⚠️ Core constraint: zero extra tokens

LunaCore **must not** inject hidden system prompts, middleware, or modify the
`claude` binary. Any "smart" context analysis by an extra agent would burn the
user's context window. It works only as:

- **Passive Observer** — listens to the CLI's `stdout` stream and extracts data via
  regex on the Node.js backend (no round-trips to any model).
- **Action Injector** — GUI buttons write plain text directly to the PTY `stdin`,
  exactly as if the user typed it.

Sound/voice feedback (below) is a third, purely local category: short UI cues
and TTS voice lines played by `mpv` on interaction/threshold events. It reads
nothing from the CLI and calls no API — zero tokens for a different reason than
the two categories above: there is no model or network involved at all.

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
| Passive Observer (Active-Files Heatmap) | rides the **same** `metrics:tools` events as the Skill Tracker (widened with `input.file_path` + the CLI's own `structuredPatch` diff stat) → `activefiles.js` folds `start`/`end` into per-file `+`/`-` counts and a live pulse. Two self-heal sweeps on its own 5 s timer: `clearStaleInProgress()` (a pulse can't outlive `MAX_LIVE_MS`) and `refreshDeleted()` (IPC `files:check-exist` → `fs.existsSync`, flags a row `.is-deleted` if the file is gone) |
| Project add (button) | "+" next to the Project switcher → IPC `projects:pick-folder` (native OS dialog, main process) → IPC `projects:add` (writes `config/projects.local.json`) → switcher re-renders and immediately restarts the active tab into the new folder |
| Session control | `sessions:create` / `:close` / `:activate` → main owns the `sessions` Map → broadcast `sessions:update` → tab bar rebuilds |
| Action Injector (keyboard) | `xterm.onData` → IPC `pty:write` → `ptyProcess.write()` |
| Action Injector (button) | `runCommand('/compact')` → IPC `pty:command` → writes `/compact\r` |
| Action Injector (prompt) | `pastePrompt(text, submit)` → IPC `pty:paste` → writes `ESC[200~ text ESC[201~` (bracketed paste), then `\r` only if `submit` |
| Action Injector (palette) | Ctrl+K overlay aggregates actions/cheat-sheets/prompts/skills → fires the **existing** injector for the chosen row (no new PTY channel) |
| Passive Observer (sparkline) | second `metrics:context` listener buffers the same `usage` samples → SVG sparkline + tok/min + ETA to 85% |
| Passive Observer (usage gauge) | `UsageWatcher` reads the CLI's OAuth token from `~/.claude/.credentials.json` → **GET** `api.anthropic.com/api/oauth/usage` → IPC `usage:update` → 5h + weekly bars (read-only, never `/v1/messages`) |
| Prefs (theme/language/boot) | `getThemes()`/`getUiPrefs()`/`setUiPrefs()` → IPC `themes:list` / `ui:get` / `ui:set` → reads `config/themes.json`, persists `config/ui.local.json`; renderer writes CSS tokens + xterm palette live |
| Settings overlay (Ctrl+L) | Ctrl+L / chip overlay (`termcustom.js`) → `getUiPrefs()`/`setUiPrefs()` (same `ui:get`/`ui:set` channel above). Two sections: **terminal appearance** — 10 `term*` keys, global not per-tab → `applyTerminalAppearance()` sets `term.options.*` on every tab (font/cursor/scrollback; needs `allowTransparency: true` at construction or alpha is ignored), composes background opacity into `theme.background`, writes CSS var `--term-blur` for the `backdrop-filter` on `.terminal__pane`, and a custom background image (`termBgImage`, a `data:` URI — CSP's `img-src` allows nothing else — via the new IPC `termcustom:pickBgImage`, which opens a native file dialog and reads the file **in main**, renderer never touches fs); and **sound & startup** — the sound toggle/volume/keystroke-variant/"all done"-minutes/read-output controls and the boot-sequence toggle, moved here from the left `appearance` panel (2026-08-13) to declutter it |
| Boot sequence | renderer-only overlay: CSS drives every pixel of motion, JS only stamps `animation-delay` on the log rows and removes the node. No IPC, no PTY, no tokens |
| Sound/voice feedback | UI event → `sfx.*()`/`voice.*()` (renderer, throttled) → IPC `sound:play` `{key, opts}` → `resolveSoundFile()` (`config/sounds.json`) → `soundManager.play()` (persistent `mpv --idle` process, JSON IPC socket) |

The Context Window % divides live `usage` tokens by the window
[`src/models.js`](src/models.js) reports for the detected model — **not** a fixed
constant. Current Claude models are 1M (Opus 5, Opus 4.8/4.7/4.6, Sonnet 5,
Sonnet 4.6, Fable 5); Haiku 4.5 is the 200k exception. A model missing from that
table falls back to 200k, so the bar reads far too high — see
[Keeping the model tables current](#keeping-the-model-tables-current).

Security: the renderer has **no** direct Node.js access. All IPC goes through a
`contextBridge` preload (`contextIsolation: true`, `nodeIntegration: false`), and
a Content-Security-Policy in `index.html` starts from `default-src 'none'`,
opening only what is genuinely needed — `script-src 'self'`, `connect-src 'none'`.
`style-src` keeps `'unsafe-inline'` because xterm.js injects its own `<style>`
elements; scripts need no such exemption, which is why the boot failsafe lives in
`boot-failsafe.js` rather than inline.

---

## Tech stack

| Component | Technology |
|-----------|------------|
| Desktop framework | Electron 43 |
| Terminal core | [`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty) + [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm) + `@xterm/addon-fit` |
| Frontend | Vanilla HTML / CSS / JS (swappable themes via CSS custom properties, PL/EN i18n) |
| Audio (optional) | [`mpv`](https://mpv.io/) — persistent `--idle` process, controlled over a JSON IPC socket. Not an npm dependency and not bundled; LunaCore just looks for it on `PATH` at launch. |

> **Why `@lydell/node-pty` instead of `node-pty`?** It ships prebuilt N-API
> binaries, so it installs **without** node-gyp / Visual Studio Build Tools — one
> binary works across Node and Electron versions. The original `node-pty` requires
> a working C++ toolchain and fails to detect very new Visual Studio releases.
>
> That "works across versions" claim was cashed in on 2026-08-09: the Electron
> 33 → 43 upgrade moved the Node ABI from **125 to 148**, which breaks any
> V8-bound addon. This one did not notice, because N-API is ABI-stable by
> contract — one prebuilt binary per *platform*, not per *ABI*.

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
│   ├── uiprefs.js         # read/write UI prefs (theme + language + boot + profile + sound) → ui.local.json
│   ├── usage.js           # UsageWatcher: GET OAuth /usage endpoint → 5h + weekly limits; nextUsageAnnounced() (pure)
│   ├── sounds.js          # load config/sounds.json → resolveSoundFile(key, opts) (pure + config read)
│   ├── soundManager.js    # persistent `mpv --idle` process + its JSON IPC socket
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
│           ├── appearance.js  # theme + language + sound prefs (toggle, volume, keystroke variant)
│           ├── sound.js       # sfx.*()/voice.*() triggers → window.lunacore.playSound(); owns keystroke throttle
│           └── boot.js        # startup sequence
├── config/
│   ├── profiles.json      # launch profiles (profiles.local.json overrides, gitignored)
│   ├── projects.json      # working directories (projects.local.json overrides, gitignored)
│   ├── cheatsheets.json   # action cheat-sheets (cheatsheets.local.json overrides)
│   ├── prompts.json       # prompt library (prompts.local.json overrides, gitignored)
│   ├── themes.json        # visual themes (themes.local.json overrides, gitignored)
│   ├── rates.json         # per-model token prices for the cost HUD (rates.local.json overrides)
│   ├── sounds.json        # sfx/voice event → file + volume (keystroke: 4-way variant list)
│   ├── ui.local.json      # persisted theme + language + boot + last profile + sound prefs (gitignored)
│   └── scratchpad.local.md # your scratchpad notes (created on first save, gitignored)
├── helpers/sounds/        # bundled audio: sfx/*.wav (placeholders), voice/*.mp3 (real, Edge-TTS)
├── test/                  # unit tests over the pure modules (`npm test`, node --test)
├── FUTURE_PLAN.md         # roadmap: themes, layout engine, feature shortlist
├── SOUNDS_IMPLEMENTATION_PLAN.md # sound & voice feature: what it does, which files, how to touch it
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

**Add a marker when you add a widget.** `rows` is a hand-written list, so it
degrades in the one direction nobody notices: it keeps proving the widgets that
were there when it was written, and says nothing about any added since. It had
drifted seven widgets behind by 2026-08-17 (`media`, `sessiontimeline`,
`devices`, `todo`, `clipboard`, `mcp`, `git`) — all fine, but none of them
checked. Last full run, with the list caught up: 23/23 widgets at `1`, bus counts
identical across three remount passes, four presets cycled twice back to
`classic`, and all 18 themes cycled with `themeTokensLeaked` and
`themeTokensLost` both empty.

One number is still open from that run: `langChange` goes 24 → 25 across the
*layout and theme* passes (not the remount passes, where a widget disposer leak
would show). Unattributed so far. Note that a worktree checkout cannot run the
probe without its own `npm install` — Electron fails to resolve
`@lydell/node-pty` and dies before the window paints.

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

**All 13/13 blocks converted (done 2026-08-03):** the entire right panel
(`ports`, `scratchpad`, `usage`, `skilltracker`, `context`), plus `autocompact`,
the left-panel list builders (`cheatsheets`, `prompts`, `skills`),
`switchers`/`actions`/`appearance`, and `terminal` last (it owns the xterm panes
and opts out of remounting — see §A2f). A `[data-slot]` placeholder is
`display: contents`, so converted and unconverted blocks sat side by side
without disturbing the flex layout during the migration. Conversion order and
the reasoning behind the contract are in [`FUTURE_PLAN.md`](FUTURE_PLAN.md)
§A2a–§A2f.

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
| A2 | Widget contract + teardown probe — all 13 blocks converted: **right panel** (`ports`, `scratchpad`, `usage`, `skilltracker`, `context`), `autocompact`, left-panel list builders (`cheatsheets`, `prompts`, `skills`), `switchers`/`actions`/`appearance`, and `terminal` last | ✅ done |
| + | PL/EN localization of `config/*.json`, not just the UI chrome | ✅ done |
| + | Optional sound & voice feedback (mpv-based sfx cues + TTS voice lines, Appearance panel controls) — click/keystroke sfx, usage-threshold voice cues, task-complete, approval-prompt and startup-greeting triggers, plus offline-SAPI read-output-aloud | ✅ done (see [`SOUNDS_IMPLEMENTATION_PLAN.md`](SOUNDS_IMPLEMENTATION_PLAN.md)) |
| + | Active-Files Edit Heatmap — real `+`/`-` diff-stat counts per file, live-edit pulse, self-heal, deleted-file indicator | ✅ done (see [`ACTIVE_FILES_HEATMAP_PLAN.md`](ACTIVE_FILES_HEATMAP_PLAN.md)) |
| + | Multi-repo project switching — "+" button, native folder picker, writes `projects.local.json` | ✅ done |
| + | GPU usage row in the System widget (Windows, Task-Manager-style counters) | ✅ done |

That closes the whole approved shortlist and the first slice of the structural
plan. **A1 is done**: the 1554-line `renderer.js` is a 57-line entry point plus
21 modules under `src/renderer/modules/`, loaded as `<script type="module">`.
Worth knowing if you fork this: Chromium blocks ES modules over `file://`, but
**Electron does not** — so this needs no bundler and no build step. Re-verified on
the Electron 43 upgrade, and verified *from the packaged build*, not just from
source — inside an asar is the case that would actually have broken.

**Phase A is done (5/5)**: A1 (renderer split), A2 (widget contract, all 13/13
blocks converted), A3 (test harness), A4 (dead-code cleanup) and A5 (async
skill scan — `scanSkills()` no longer blocks the main process). See
[`FUTURE_PLAN.md`](FUTURE_PLAN.md) §8, which opens with a *START HERE* box, for
current status and what's next. §9 sketches the bigger open question: turning
LunaCore into a multi-model console (Claude / Kimi / local LM Studio) rather
than a Claude-only HUD.

### Tests

```bash
npm test        # node --test — 350 tests, ~0.3s, no extra dependencies
```

Covers the side-effect-free modules only: context metrics, transcript-dir
encoding, tool detection, profile/project validation, port parsing, skill
categorisation, model/context-window inference, the burn-rate sampler with
its ETA arithmetic, sound-config resolution (`resolveSoundFile`, including the
keystroke variant lookup), and the usage-threshold voice announcer's state
machine (`nextUsageAnnounced`).

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

## Per-file context weight

Each row of the Active-Files Heatmap also shows what that file cost the context
window: `≈6.7k · 2.5%`.

The number comes from the `content` string in a Read's `toolUseResult` — the
exact text the CLI placed in the window. That beats the file's size on disk in
the two cases that matter: a partial read (`offset` + `limit`) charges only the
slice actually pasted, and **a file read three times charges three times**,
which is the truth and usually the surprise.

> **Only a Read counts.** A Write's `content` is what the *model* produced, so
> it was output tokens, not context weight. An Edit's result is a short
> confirmation snippet, and the `originalFile` sitting next to it is CLI
> bookkeeping the model never sees — charging that would bill a whole file for a
> one-line edit. `test/filestat.test.js` pins both.

**The `≈` is not decoration.** Every other token figure in LunaCore comes
straight from `message.usage` and is exact; the API reports usage per *message*,
never per tool result, so a per-file number cannot be. The row hovers to a
tooltip carrying the part that is not an estimate — the exact character count —
plus how many reads it took. The chars-per-token ratio (3.6 for code, 4.0 for
prose) lives in one place, `src/filestat.js`, and the estimate is computed once
in the main process; the renderer only ever sums what it is handed, so the two
halves of the HUD cannot drift into disagreeing.

The percentage is that estimate against the **real** context limit for the
active session's model, which the gauge already knows. Before a limit is known
the row prints the token figure alone rather than a percentage of a guess.

Measured on the session that built this feature: 41 files read, ≈63.6k tokens —
**23.4% of peak context**, with `uiprefs.js` (read twice) the single heaviest
file.

## MCP server health

Answers a question Claude Code does not: **which of my MCP servers am I actually
using?** Adding one is a single config line; noticing that it has been dead for
two months is not, and every configured server spends tool definitions in the
context window of every session you open.

Three layers, cheapest first ([`src/mcphealth.js`](src/mcphealth.js)):

| Layer | Source | Cost |
|---|---|---|
| **Config** | `~/.claude.json` (global + per project) and each project's `.mcp.json` | instant |
| **Usage** | mined from the session transcripts in `~/.claude/projects` | ~1 s, on request |
| **Probe** | one server spawned on click, real MCP `initialize` + `tools/list` | seconds, explicit |

Usage has to be mined because Claude Code records `skillUsage` and `pluginUsage`
in its config but **not** MCP usage — the only evidence that a server was ever
called is the call sitting in a transcript.

> A mention is not a call. Transcripts are full of server names that were never
> invoked: the tool definitions themselves, the deferred-tool listing, and
> documentation that spells the pattern out as `mcp__<server>__<tool>`. The miner
> is anchored on `"name":"mcp__…`, which only a `tool_use` block produces.
> Counting mentions instead made every server on a real machine read as "used
> today" and invented one called `<server>` — so both failures are pinned in
> [`test/mcphealth.test.js`](test/mcphealth.test.js).

Rows sort most-neglected first (never → stale → idle → fresh), and the header
line says how many of the total are earning nothing. Servers that usage finds but
config never mentions are listed too, labelled `plugin`, `connector` or
`not in config` — plugin-provided servers appear in no local config file and
would otherwise read as "not installed" while quietly costing context.

The ⟳ button on a row spawns **that one server** and handshakes it, reporting
whether it is alive, how many tools it contributes, and how long it took. It is
never automatic: probing everything means ~20 processes at once, several of which
authenticate against a network on boot. Remote (http/sse) servers say so rather
than offering a button that would measure something else.

> **Never `shell: true`.** The probe's first version used it, because a Windows
> `.cmd` shim (`npx`, `npm`, `uvx`) is the normal way MCP servers are launched
> and Node refuses to spawn one without a shell — `EINVAL`, not `ENOENT`, since
> CVE-2024-27980. But a shell turns the args array into a concatenated command
> line nobody escaped (Node's DEP0190), and those args can come from a
> `.mcp.json` inside a cloned repo. `spawnPlan()` runs the shim through
> `cmd.exe /c` with the arguments still passed as an **array**, so Node escapes
> each one: an arg of `x & echo PWNED` arrives as a single literal argv entry.

Two things it deliberately does not do. It **never writes to `~/.claude.json`** —
a bug in the HUD would break Claude Code itself, not just the panel. And it never
reads an `env` **value**: server specs are where API keys live, so only key
*names* leave the main process.

Read the verdict as evidence, not judgement. The transcripts are Claude Code's,
on this machine — a server called unused here may be busy in Codex, on your other
PC, or in sessions since cleaned up.

## Git station

One row per watched repo: branch, working-tree counts, ahead/behind, last commit
([`src/gitstation.js`](src/gitstation.js)). Rows needing attention sort to the
top — conflict, then diverged, then behind, then dirty.

> The number worth having on screen is **behind**, and after it **diverged**. A
> dirty tree you already know about; you made the mess. Two clones of one repo
> drifting apart is the failure that stays invisible until it costs an evening.

Which repos: an explicit list in `config/repos.local.json`, gitignored like every
other `config/*.local.*`. **Find repos** seeds it by walking a few usual roots
(`~/source/repos`, `~/repos`, `~/projects`, `~/dev`, `~/.local/bin`) two levels
deep, stopping at each repo rather than descending into it. Nothing is scanned on
a timer: an autodiscovered list changes under you, and a status board whose
contents move on their own is not a status board.

What it does: **read, plus fetch**. Fetch updates ahead/behind and cannot touch a
working tree, so it is safe from a panel you glance at. Pull, commit and push are
absent by design — those belong in a terminal where you can see what happened,
and this panel sits one stray click away from your afternoon. The path a fetch
runs in is checked against the configured list first; the renderer cannot name an
arbitrary directory.

A branch with no upstream reports **no upstream branch** rather than "clean":
ahead/behind are structurally unavailable there, not zero, and that is exactly
the state that hides divergence.

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

## Panels — folding and resizing

**Click any panel title to fold it shut**, chevron and all; click again to open
it. The whole title row is the handle, so controls that live in a title (the
ports filter, the copy-transcript-path button) still work — a click that lands
on a real control is left alone.

**Drag the line between two columns to resize them.** Double-click that line to
put the preset back where it started, and arrow keys nudge it 16px at a time
once the handle has focus. One rule governs what is draggable, and it is what
keeps a resized HUD from breaking the next time you resize the window:

> An elastic (`fr`) track never becomes a fixed one.

So a handle beside a fixed column drags that column and lets the elastic one
absorb it; a handle between two elastic columns shifts the ratio and keeps
their sum. A boundary that offers neither — nothing elastic left in the row, or
a track the parser can't describe — gets no handle at all rather than a handle
that does something surprising. Rows aren't resizable: presets stack regions by
name, so a row border is rarely one continuous line to grab.

Both are remembered in `ui.local.json`, widths per layout preset (a width
dragged in `classic` means nothing in `focus`). Change a preset's column count
in `config/layouts.json` and its saved widths are dropped rather than smeared
across the wrong columns. See
[`src/renderer/modules/panels.js`](src/renderer/modules/panels.js).

## Theming

The whole look is a set of CSS custom-property tokens, so a "theme" is just a
values file. **18 ship**, defined in [`config/themes.json`](config/themes.json):

| | |
|---|---|
| **Neon** | cyberpunk *(default)*, synthwave, vapor, crimson |
| **Terminal** | matrix, amber-crt, blueprint |
| **Editor** | nord, tokyo-night, dracula, gruvbox, solarized |
| **Quiet** | void, glacier |
| **Light** | light, paper, newsprint, e-ink |

`src/theme.js` loads and validates them (falling back to a built-in cyberpunk if
the file is broken, same as `profiles.js`). Pick one from the **Appearance**
section in the left panel — it applies live, rewriting the CSS tokens on
`documentElement` *and* the xterm terminal palette, no reload.

A theme is not just a palette. The ~45-token vocabulary also covers **form**
(radii, padding, panel gap), **typography** (three font stacks, letter spacing,
whether titles are uppercased), **depth** (glow sizes, panel shadow), **motion**
(four durations, three easings) and a full-screen **texture** layer — which is
what makes `matrix` a phosphor CRT rather than green text on black, `blueprint`
a drafting grid, `newsprint` a halftone print, and costs the flat themes
nothing (`--texture: none`). A theme can also `extend` another and restate only
what differs — `amber-crt` is `matrix` in amber, `vapor` is `synthwave` in
pastel, `e-ink` is `paper` with the colour taken out.

Drop a `config/themes.local.json` (gitignored) to add or override themes by
`id`. An unknown token there is dropped with a warning rather than taking the
whole theme down with it.

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

## Sound & voice feedback

Optional UI sound cues (tab actions, theme/lang/compact toggles, keystrokes)
and short TTS voice lines, driven by a **persistent `mpv --idle` process**
controlled over its JSON IPC socket — one process absorbs mpv's ~50–150 ms
startup cost once, at app launch, instead of spawning it per event (a keystroke
sound fired at typing speed would otherwise mean 10–20 new OS processes a
second).

**Fully optional and fails silent.** If `mpv` isn't on `PATH`, LunaCore logs one
warning line (visible with `--enable-logging`) and every sound call becomes a
no-op — the HUD is otherwise identical, nothing blocks, nothing errors. Install
it with `winget install mpv-player.mpv-CI.MSVC` (Windows), `brew install mpv`
(macOS), or your distro's package manager (Linux); no config changes needed
beyond having it on `PATH`.

Config-driven, same shape as `cheatsheets.json`/`themes.json`:
[`config/sounds.json`](config/sounds.json) maps each event key to a file under
`helpers/sounds/` plus a volume, [`src/sounds.js`](src/sounds.js) resolves and
validates it (no `*.local.json` override yet — unlike themes/cheatsheets, this
config has none). The four keystroke clips are a **variant list**, not a single
file — pick one in **Appearance → Dzwiek klawiszy**, previewed immediately on
change so choosing is by ear, not trial-and-error via actual typing.

**Appearance panel controls** (persisted to `ui.local.json`, live-applied with
no restart, same as theme/language): a sound on/off toggle, a volume slider,
and the keystroke-variant picker (Mechanical / Soft / Sci-fi / Typewriter).

**Currently wired:** new tab, tab switch, tab close, theme toggle, language
toggle, compact-mode toggle, keystrokes (throttled, single-character guard so
pasted bursts and arrow-key escape sequences don't fire it), and the usage
gauge's 50%/80% threshold crossings — the only two voice lines actually
triggered today, debounced both ways (re-arms only once usage drops back under
40%, so a five-hour window that never re-crosses 50% doesn't repeat the
announcement). `welcome`/`needYou`/`done` have real generated audio waiting but
nothing calls them yet — startup greeting, approval-prompt detection and
task-complete detection are still open build-order steps; see
[`SOUNDS_IMPLEMENTATION_PLAN.md`](SOUNDS_IMPLEMENTATION_PLAN.md).

The five voice lines are real, generated via
[Edge-TTS](https://github.com/rany2/edge-tts) (`en-US-AriaNeural`,
`--rate=+5% --pitch=+15Hz`) — free, offline-scriptable, easy to regenerate with
a different voice; see [`helpers/sounds/README.md`](helpers/sounds/README.md)
for the exact command and line text. The four keystroke `.wav` clips still ship
as silent placeholders and need real short (<80 ms) recordings before they're
audible.

Zero tokens, zero API calls: as noted under *Core constraint* above, this is a
third category alongside the Passive Observer / Action Injector split — it
reads nothing from the CLI and calls no network endpoint, it just plays a local
file when a UI event fires.

---

## Inspiration

- [`claude-code-templates`](https://github.com/davila7/claude-code-templates) by davila7 — command center for a rich set of skills, MCP servers, and agents.

## License

MIT © Mateusz Mazur
