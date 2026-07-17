  LunaCore

  Visual GUI Wrapper for Claude Code CLI

  Status: Planning Phase (https://img.shields.io/badge/status-planning-blue)

  LunaCore is a desktop application that provides a visual dashboard overlay on top of the Claude Code
  CLI, enabling interactive control through clickable buttons and real-time visualization of active
  skills/MCP servers.

  Overview

  LunaCore solves two main problems:
  1. No interactive control - No way to click physical buttons instead of typing commands manually
  2. Poor visibility - Hard to visualize which of ~300 skills are currently being used by the model

  The application operates as a Passive Observer (monitors stdout via regex parsing) and Action
  Injector (simulates keyboard input to stdin).

  ---
  ⚠️ Critical Constraint: Zero Extra Tokens

  LunaCore MUST NOT inject any hidden system prompts, middleware, or modify the claude binary. Every
  attempt at "intelligent" context analysis by an additional agent burns the user's context window.

  The application works exclusively as:
  - Passive Observer: Listens to CLI stdout stream and extracts data via regex on Node.js backend
  - Action Injector: Physical GUI buttons simulate direct text input to the PTY stdin stream

  ---
  Tech Stack

  ┌───────────────────┬─────────────────────────────────────────────┐
  │     Component     │                 Technology                  │
  ├───────────────────┼─────────────────────────────────────────────┤
  │ Desktop Framework │ Electron (stable, well-configured) or Tauri │
  ├───────────────────┼─────────────────────────────────────────────┤
  │ Terminal Core     │ node-pty + xterm.js + xterm-addon-fit       │
  ├───────────────────┼─────────────────────────────────────────────┤
  │ Frontend          │ HTML/CSS/JS (Vanilla, React, or Svelte)     │
  └───────────────────┴─────────────────────────────────────────────┘

  Design Theme: Dark cyberpunk dashboard matching LunaCore branding

  ---
  Architecture

  ┌─────────────────────┬───────────────────────────────┬─────────────────────┐
  │  LEFT PANEL         │       CENTER (Terminal)       │   RIGHT PANEL       │
  │  (Controls)         │                               │   (Status Monitor)  │
  ├─────────────────────┤     xterm.js Render Area        ├─────────────────────┤
  │ [⚡ COMPACT CONTEXT]│  ┌─────────────────────────┐  │  Skill Tracker:     │
  │                     │  │ Claude CLI interaction  │  │  - Active skills  │
  │ Profile Switcher    │  │ (PTY process)           │  │  - MCP servers    │
  └─────────────────────┘  └─────────────────────────┘  └─────────────────────┘

  Panel Descriptions

  1. Left Panel (Controls)
    - ⚡ COMPACT CONTEXT button - sends /compact\n to PTY
    - Profile/Environment switcher (Claude Cloud vs LM Studio)
  2. Center (Terminal)
    - Rendered xterm.js window for normal Claude CLI conversation
  3. Right Panel (Status Monitor)
    - Skill Tracker: Tiles showing key skills/MCP servers; lights up green when regex detects Running
  tool: [name]
    - Context Window Indicator: Progress bar with color coding:
        - Green < 60%
      - Yellow 60-85%
      - Red > 85% (with "Compact this shit!" warning)

  ---
  Project Phases

  ┌─────────┬──────────────────────────────────────────────────────────────────────────────────────┐
  │  Phase  │                                        Focus                                         │
  ├─────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Phase 1 │ Initialize Electron project, set up PTY with node-pty, embed and style xterm.js      │
  ├─────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Phase 2 │ Implement IPC channel, add [Compact Context] button that writes to ptyProcess        │
  ├─────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Phase 3 │ Add stream parser (regex-based), extract metrics (tokens, active tools) in real-time │
  ├─────────┼──────────────────────────────────────────────────────────────────────────────────────┤
  │ Phase 4 │ Add profile management (LM Studio/Codex endpoints via JSON config)                   │
  └─────────┴──────────────────────────────────────────────────────────────────────────────────────┘

  ---
  Getting Started (Phase 1 & 2)

  To be implemented:
  1. Directory structure for Electron project
  2. Complete package.json with dependencies (node-pty, xterm, xterm-addon-fit, electron)
  3. Main process code (main.js) - PTY configuration and IPC handling
  4. Frontend code (index.html + renderer.js) - xterm.js display with functional [⚡ COMPACT CONTEXT]
  button

  ---
  Inspiration

  - claude-code-templates (https://github.com/davila7/claude-code-templates) by davila7
  - Current state: User already has advanced CLI dashboard showing metrics (context window %,
  operation time, active MCP servers, estimated cost)

  ---
