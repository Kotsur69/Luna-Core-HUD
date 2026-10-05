# ARCHITECTURAL SPECIFICATION: ADVANCED LUNA-CORE-HUD MODULES

**Document Version:** 1.1.0  
**Target Environment:** macOS / Linux / WSL2  
**Ecosystem:** Go 1.22+, `charmbracelet/bubbletea`, `charmbracelet/lipgloss`, `shirou/gopsutil`  
**Integration Scope:** Spotify Audio Engine, File Heatmap \& Token Weighting, Parallel Agent Execution Streamer, Session Timeline Scrubber.

\---

## 1\. Module 1: Spotify Audio Deck \& Smart Voice Ducking Engine

### Architectural Overview

A native TUI audio panel running asynchronously in the Bubble Tea loop. It controls Spotify via **DBus MPRIS** (Linux) or **AppleScript / Spotify Web API** (macOS) and synchronizes audio levels with Luna's voice announcements.

### Key Technical Components

1. **IPC Media Bridge (`internal/media/spotify.go`):**

   * Connects to local Spotify daemon / client (`org.mpris.MediaPlayer2.spotify`).
   * Polls metadata (`Track`, `Artist`, `PlaybackStatus`, `ProgressMs`).
2. **Dynamic Audio Wavebar Visualizer (`internal/ui/widgets/audio\_wave.go`):**

   * Uses a pseudo-FFT sine spectrum rendered via Unicode block elements (` `, `▂`, `▃`, `▄`, `▅`, `▆`, `▇`, `█`).
   * Ticks every 80ms using `tea.Every` to animate smoothly alongside music playback.
3. **Smart Voice Ducking Manager (`internal/audio/ducker.go`):**

   * Listens to internal voice event dispatchers (`OnVoiceStart`, `OnVoiceEnd`).
   * Sends DBus/AppleScript commands to temporarily reduce Spotify volume to 20% when Luna speaks, returning to 100% after speech completion + 300ms buffer.

\---

## 2\. Module 2: Live File-State Heatmap \& Per-File Context Weighting

### Architectural Overview

A visual monitoring panel tracking up to $N$ target files in the active project scope, showing token consumption per file and rendering status glows based on agent interactions.

### Key Technical Components

1. **File Token Evaluator (`internal/collector/file\_weight.go`):**

   * Reads target files in active context.
   * Calculates exact token usage per file and displays percentage ratio against Claude's max context limit (e.g., `main.go \[14.2k tokens | 18%]`).
2. **File State Machine (`internal/ui/widgets/file\_heatmap.go`):**

   * **State: IDLE:** Rendered with faint gray border and text.
   * **State: AGENT\_EDITING:** Triggers a **glowing orange pulsing animation** (`#FF8700`) with live line edit counters (`+14 / -2`).
   * **State: ON\_SAVE:** Intercepts file system write events via `fsnotify`. Triggers a **bright neon green blink** (`#00FF5F`) for 800ms before returning to `IDLE`.
   * **State: SYNTAX\_ERROR / FAIL:** Triggers a **flashing crimson border** (`#FF005F`) if a post-save build check fails.

\---

## 3\. Module 3: Multi-Agent Parallel Stream Visualizer

### Architectural Overview

A side-by-side execution tracker designed for multi-agent workflows (e.g., Claude sub-agents, background linter, auto-test runner).

### Key Technical Components

1. **Multi-Process Ticker (`internal/collector/agent\_stream.go`):**

   * Scrapes active sub-processes and standard output streams.
2. **Parallel Process Cards (`internal/ui/widgets/agent\_matrix.go`):**

   * Renders active parallel channels side-by-side:

     * `\[Agent-1: Refactoring UI]` -> `Pulsing Cyan`
     * `\[Agent-2: Generating Unit Tests]` -> `Pulsing Purple`
     * `\[Background: Test Suite Watcher]` -> `Solid Green`
   * Displays single-line scrolling output tickers for each worker thread.

\---

## 4\. Module 4: Interactive Session Timeline \& Snapshot Scrubber

### Architectural Overview

A visual timeline bar positioned at the bottom of the HUD that logs key session milestones and lets you scrub backwards to inspect prior project states.

### Key Technical Components

1. **State Event Logger (`internal/timeline/store.go`):**

   * Stores structured event snapshots:

     * `TIMESTAMP` | `EVENT\_TYPE` | `ACTIVE\_FILES` | `TOKEN\_USAGE` | `BUILD\_STATUS`
   * Key milestones: `Session Start`, `Major Edit`, `Auto-Compact Triggered`, `Test Suite Passed`.
2. **TUI Scrubber Bar (`internal/ui/widgets/timeline\_scrubber.go`):**

   * Renders a horizontal timeline bar with milestone nodes (`●───●───────▲───●`).
   * Arrow key scrubbing highlights previous session snapshots and displays historical diff snapshots in a modal overlay.

\---

### Idea B: Terminal Hardware RGB \& Backlight Sync Engine

* **Ambient Workspace Lighting:** Intercepts HUD state changes (Error, Success, Edit, Compact) and sends commands via OpenRGB or local hardware APIs to synchronize your physical keyboard/desk LED colors with terminal status.

### Idea C: Local LLM Fallback \& Hybrid Router

* **Model Failover Gauge:** If Claude API latency spikes or rate limits approach, the HUD automatically flags the switch and routes small tasks (like line edits or formatting) to a local Ollama/vLLM instance.

### 

