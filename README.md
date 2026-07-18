# LunaCore

**Visual GUI wrapper (dashboard) for the Claude Code CLI.**

LunaCore wraps the real `claude` CLI in an Electron window: a live terminal in the
center, clickable action buttons on the left, and a status monitor on the right.
It adds control and visibility **without spending a single extra token** — it never
injects prompts or touches the `claude` binary.

> Status: **Phase 1 & 2 implemented** (interactive terminal + Action Injector).
> Phases 3–4 (metrics parser, profile switching) are scaffolded, not yet wired.

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
├─────────────────────┤     xterm.js render area      ├─────────────────────┤
│ [⚡ COMPACT CONTEXT]│  Claude CLI interactive        │  Context Window bar │
│                     │  session (node-pty process)   │  Skill Tracker      │
│ Profile switcher    │                               │  tiles              │
└─────────────────────┴───────────────────────────────┴─────────────────────┘
```

**Data flow (Phase 1 & 2):**

| Direction | Path |
|-----------|------|
| Passive Observer | `ptyProcess.onData` → IPC `pty:data` → `xterm.write()` |
| Action Injector (keyboard) | `xterm.onData` → IPC `pty:write` → `ptyProcess.write()` |
| Action Injector (button) | `runCommand('/compact')` → IPC `pty:command` → writes `/compact\r` |

Security: the renderer has **no** direct Node.js access. All IPC goes through a
`contextBridge` preload (`contextIsolation: true`, `nodeIntegration: false`).

---

## Tech stack

| Component | Technology |
|-----------|------------|
| Desktop framework | Electron |
| Terminal core | [`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty) + [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm) + `@xterm/addon-fit` |
| Frontend | Vanilla HTML / CSS / JS (dark cyberpunk theme) |

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
│   ├── preload.js         # secure contextBridge → window.lunacore
│   └── renderer/
│       ├── index.html     # 3-panel layout
│       ├── renderer.js    # xterm.js ↔ PTY wiring + COMPACT button
│       └── styles.css     # LunaCore cyberpunk theme
├── master_prompt.md       # original build brief
└── README.md
```

---

## Roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | Electron + `node-pty` + `xterm.js` interactive terminal | ✅ done |
| 2 | IPC channel + working `⚡ COMPACT CONTEXT` button | ✅ done |
| 3 | Regex stdout parser → context % bar + Skill Tracker tiles | 🔜 scaffolded |
| 4 | Profile management (LM Studio / Codex endpoints via JSON) | 🔜 planned |

The right panel (Context Window bar, Skill Tracker tiles) is present in the layout
as placeholders; it lights up once the Phase 3 parser is wired.

---

## Inspiration

- [`claude-code-templates`](https://github.com/davila7/claude-code-templates) by davila7 — command center for a rich set of skills, MCP servers, and agents.

## License

MIT © Mateusz Mazur
