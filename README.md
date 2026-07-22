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
> **theming system**, and a **PL/EN language switch**.

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
│ [⚡ COMPACT CONTEXT]│  [Ctrl+K] command palette     │  Context Window bar │
│ Theme + language    │     xterm.js render area      │  + burn sparkline   │
│ Profile switcher    │                               │  Skill Tracker      │
│ Action cheat-sheets │  Claude CLI interactive        │  tiles              │
│ Prompt library      │  session (node-pty process)   │  Localhost ports    │
│ Skill cheat-sheet   │                               │  Scratchpad         │
│ (panel scrolls)     │                               │                     │
└─────────────────────┴───────────────────────────────┴─────────────────────┘
```

**Data flow:**

| Direction | Path |
|-----------|------|
| Passive Observer (terminal) | `ptyProcess.onData` → IPC `pty:data` → `xterm.write()` |
| Passive Observer (Skill Tracker) | `ptyProcess.onData` → `detectTools()` (ANSI strip + regex) → IPC `metrics:tools` → tiles light up |
| Passive Observer (Context %) | `TranscriptWatcher` tails `~/.claude/projects/**/*.jsonl` → real `usage` tokens → IPC `metrics:context` → bar |
| Action Injector (keyboard) | `xterm.onData` → IPC `pty:write` → `ptyProcess.write()` |
| Action Injector (button) | `runCommand('/compact')` → IPC `pty:command` → writes `/compact\r` |
| Action Injector (prompt) | `pastePrompt(text, submit)` → IPC `pty:paste` → writes `ESC[200~ text ESC[201~` (bracketed paste), then `\r` only if `submit` |
| Action Injector (palette) | Ctrl+K overlay aggregates actions/cheat-sheets/prompts/skills → fires the **existing** injector for the chosen row (no new PTY channel) |
| Passive Observer (sparkline) | second `metrics:context` listener buffers the same `usage` samples → SVG sparkline + tok/min + ETA to 85% |
| Prefs (theme/language) | `getThemes()`/`getUiPrefs()`/`setUiPrefs()` → IPC `themes:list` / `ui:get` / `ui:set` → reads `config/themes.json`, persists `config/ui.local.json`; renderer writes CSS tokens + xterm palette live |

The Context Window % divides live `usage` tokens by a `CONTEXT_LIMIT` constant
(200k default, in [`src/observer.js`](src/observer.js) — raise it for 1M-context
sessions).

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
`$SHELL` elsewhere) and auto-runs `claude`. Make sure the Claude Code CLI is
installed and on your `PATH`.

To disable auto-launch (start in a bare shell instead), set
`AUTO_LAUNCH_CLAUDE = false` at the top of [`src/main.js`](src/main.js).

---

## Project layout

```
Luna-Core-HUD/
├── package.json
├── src/
│   ├── main.js            # main process: window + PTY + IPC channels
│   ├── observer.js        # Passive Observer: tool detection + transcript tailing
│   ├── profiles.js        # load/validate launch profiles from config/
│   ├── ports.js           # localhost port scanner (listen ports + PID→process)
│   ├── cheatsheets.js     # load/validate action cheat-sheets from config/
│   ├── skills.js          # scan skill dirs → categorized skill cheat-sheet
│   ├── prompts.js         # load/validate multi-line prompt library from config/
│   ├── scratchpad.js      # read/write the local scratchpad note file
│   ├── theme.js           # load/validate themes from config/ (FALLBACK cyberpunk)
│   ├── uiprefs.js         # read/write UI prefs (theme + language) → ui.local.json
│   ├── preload.js         # secure contextBridge → window.lunacore
│   └── renderer/
│       ├── index.html     # 3-panel layout
│       ├── i18n.js        # PL/EN dictionary + t() (IIFE → window.i18n only)
│       ├── renderer.js    # xterm.js ↔ PTY wiring + COMPACT + profiles + palette + themes
│       └── styles.css     # LunaCore theme tokens (:root custom properties)
├── config/
│   ├── profiles.json      # launch profiles (profiles.local.json overrides, gitignored)
│   ├── cheatsheets.json   # action cheat-sheets (cheatsheets.local.json overrides)
│   ├── prompts.json       # prompt library (prompts.local.json overrides, gitignored)
│   ├── themes.json        # visual themes (themes.local.json overrides, gitignored)
│   ├── ui.local.json      # persisted theme + language (created on first change, gitignored)
│   └── scratchpad.local.md # your scratchpad notes (created on first save, gitignored)
├── master_prompt.md       # original build brief
├── FUTURE_PLAN.md         # roadmap: themes, layout engine, feature shortlist
└── README.md
```

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

Next up (see [`FUTURE_PLAN.md`](FUTURE_PLAN.md) §5.5): armed auto-compact toggle,
CWD/project switcher, cyberpunk boot sequence, session %/weekly-limit gauge.

The right panel lights up live: the Context Window bar reflects real `usage`
tokens from the session transcript, and Skill Tracker tiles glow when Claude runs
the matching tool (Read, Edit, Write, Bash, Grep, Glob, Web, Task).

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

## Localhost ports tracker

The right panel lists listening TCP ports (dev servers and everything else),
scanned every few seconds via `Get-NetTCPConnection` on Windows (`lsof` on
macOS/Linux), each mapped to its owning process and PID. Per row you can open
`http://localhost:PORT` in the browser, copy the URL, or kill the process (with
a confirm). Purely local, read-only observation — no tokens spent.

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
strings (LED state, token counts, burn rate, palette rows) go through `t()`. Note
this translates **LunaCore's own chrome** only — the `claude` CLI output in the
terminal is whatever the CLI itself emits. Both the theme and language choice
persist to `config/ui.local.json` (gitignored) via `src/uiprefs.js`, so the app
reopens exactly how you left it.

---

## Inspiration

- [`claude-code-templates`](https://github.com/davila7/claude-code-templates) by davila7 — command center for a rich set of skills, MCP servers, and agents.

## License

MIT © Mateusz Mazur
