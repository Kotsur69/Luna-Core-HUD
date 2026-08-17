# ARCHITECTURAL SPECIFICATION & MODULE ROADMAP
## Project: LunaCore HUD — Electron Dashboard for the Claude Code CLI

**Document Version:** 2.0.0 (rewrite — v1.0.0 described a different, never-built stack)
**Target Environment:** Windows (primary, current release target) — Electron is cross-platform, so macOS/Linux are not blocked, just untested
**Core Ecosystem:** Electron 43, Node.js, `@lydell/node-pty`, `@xterm/xterm`, vanilla HTML/CSS/JS
**Integration Target:** Claude Code CLI (`claude`), run as a real child process — never reimplemented, never prompted

---

## 0. Why this document exists, and what it doesn't repeat

`README.md` and `FUTURE_PLAN.md` are the living source of truth for what LunaCore
*is right now* and what's scheduled next — this document does not restate their
content and will drift out of date the moment it tries to. Instead:

- **`README.md`** — current architecture, exact IPC data flow, tech stack, install/build instructions.
- **`FUTURE_PLAN.md`** — the phased roadmap, including its own §9 "Multi-model command center" backlog (explicit, user-initiated provider switching — a different idea from anything below).
- **`SOUNDS_IMPLEMENTATION_PLAN.md`** — the sound/voice feature reference (§3 event triggers, §2 read-output-aloud engine).
- **This document** — §1–4 are a short, accurate *orientation* (kept intentionally thin so it can't contradict README), and §5 onward is the actual payload: a reusable recipe for adding a new widget, plus a filtered, scored backlog of module ideas for future sessions to pick up.

**`LUNA_HARNESS_TREE_SPEC.md`** (multi-model task auto-routing across Kimi/Codex/LM
Studio) is a separate, parked document. It isn't referenced or folded in here —
left alone, per Mati's call.

---

## 1. Executive Summary & Vision

LunaCore HUD is an Electron desktop app that wraps the real `claude` CLI: a live
interactive terminal in the center (a genuine PTY session via `node-pty`, not a
scraped/simulated one), clickable action buttons on the left, and a status
monitor on the right. It adds visibility and control **without spending a single
extra token** — no hidden prompts, no middleware model calls, no touching the
`claude` binary itself.

The one rule every feature — existing or proposed — has to pass, restated from
`README.md`:

- **Passive Observer** — reads `stdout`/transcript JSONL, extracts data via regex
  on the Node.js backend. No round-trips to any model.
- **Action Injector** — writes plain text to the PTY `stdin`, exactly as if Mati
  typed it himself.
- **Local-only feedback** (sound/voice) — a third category: no CLI data read, no
  network call, no model involved at all.

Any module idea that needs a fourth category — a background agent, a "smart"
summarizer, silent auto-routing to another model — fails the spec by
construction. See §6 for ideas that got cut on exactly this basis.

---

## 2. Real Tech Stack

| Layer | Technology | Notes |
| :--- | :--- | :--- |
| Desktop framework | Electron 43 | `contextIsolation: true`, `nodeIntegration: false`, CSP `default-src 'none'` |
| Terminal core | [`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty) + [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm) + `@xterm/addon-fit` | N-API prebuilt binaries — survives Electron's Node-ABI jumps (e.g. 33→43 moved ABI 125→148) without a rebuild |
| Frontend | Vanilla HTML / CSS / JS | CSS custom-property theming (9 themes), PL/EN i18n, no framework, no bundler-required build step for the renderer |
| Audio (optional) | [`mpv`](https://mpv.io/) | Persistent `--idle` process controlled over a JSON IPC socket/pipe. Not bundled — looked up on `PATH`; every sound feature degrades silently if it's missing |
| Voice synthesis (optional) | Windows SAPI via `System.Speech`, driven by a fixed PowerShell script | Fully offline, no network, no npm dependency — see §2 in `SOUNDS_IMPLEMENTATION_PLAN.md` |

Go, Bubbletea, Lipgloss, `gopsutil`, and a tmux/zellij launcher — everything v1.0.0
of this document proposed — do not apply. They described a different project
that was never started.

---

## 3. Architecture (orientation only — see `README.md` for the full data-flow table)

```
┌─────────────────────┬───────────────────────────────┬─────────────────────┐
│  LEFT PANEL         │       CENTER (Terminal)       │   RIGHT PANEL       │
│  (Controls)         │                               │   (Status Monitor)  │
├─────────────────────┤  ● LED: working / waiting     ├─────────────────────┤
│ Action Injector      │  [tab][tab][tab]          [+] │  Passive Observer   │
│ buttons/switchers     │  xterm.js render area         │  widgets (context,   │
│ (write to PTY stdin) │  ← node-pty ← real `claude`   │  tokens, tools,      │
│                     │     child process              │  ports, usage...)   │
└─────────────────────┴───────────────────────────────┴─────────────────────┘

Main process (Node, full access)  <── contextBridge/IPC ──>  Renderer (sandboxed, no Node)
      │                                                              │
      ├─ node-pty session  ────────────────────────────────────────►│ xterm.write()
      ├─ TranscriptWatcher (tails ~/.claude/projects/**/*.jsonl) ───►│ widget modules
      ├─ soundManager (mpv --idle, JSON IPC)  ────────────────────► │ (via sound:play)
      └─ config/*.json + ui.local.json (prefs, themes, sounds)  ───►│ (via ui:get/set)
```

Two data sources feed every Passive-Observer widget: the PTY's raw `stdout`
(scraped for UI-level signals like tool names) and the transcript JSONL that
`claude` itself writes to disk (parsed for ground-truth token counts and
message structure). New widgets should prefer the transcript when the data
exists there — it's structured and doesn't break when the CLI's rendered output
changes, which is exactly what happened to the old stdout-based tool detector
(see the Skill Tracker row in `README.md`'s data-flow table).

---

## 4. Current Widget Inventory (`src/renderer/modules/`)

A scan reference so a new idea can be checked against what's already built
before it gets proposed twice.

| Module | Purpose |
| :--- | :--- |
| `actions.js` | Left-panel Action Injector buttons |
| `appearance.js` | Theme / language / boot-sequence / sound prefs switchers |
| `autocompact.js` | Armed auto-compact toggle |
| `boot.js` | Cyberpunk boot animation overlay |
| `bus.js` | Cross-module event bus (lang change, etc.) |
| `cheatsheets.js` | Action cheat-sheet panel |
| `claudecheck.js` | Detects whether `claude` is on `PATH` at launch |
| `context.js` | Context-window % bar (active tab) |
| `feeds.js` | (shared feed-rendering helper) |
| `host.js` | App shell / panel mounting |
| `layout.js` | Layout preset switcher (moves widgets between regions) |
| `led.js` | Working/waiting LED indicator |
| `localize.js` | i18n apply/broadcast helpers |
| `palette.js` | Ctrl+K command palette |
| `ports.js` | Localhost ports tracker |
| `prompts.js` | Prompt library (multi-line, Action Injector) |
| `ptystatus.js` | PTY session status |
| `registry.js` | Widget definition/registration |
| `scratchpad.js` | Local scratchpad notes |
| `sessions.js` | Tab bar / multi-session management |
| `skills.js` | Skill cheat-sheet panel |
| `skilltracker.js` | Per-tool real-duration tiles |
| `sound.js` | SFX/voice trigger helpers (renderer side) |
| `spark.js` | Token burn-rate sparkline |
| `switchers.js` | Profile/project switchers |
| `telemetry.js` | (metrics plumbing shared across widgets) |
| `terminal.js` / `terminals.js` | xterm.js instance management, theme application |
| `thresholds.js` | Usage-limit threshold logic |
| `update.js` | App update notice |
| `usage.js` | 5h/weekly usage-limit gauges |
| `util.js` | Shared helpers (`loc()`, etc.) |

Backend (`src/`): `main.js` (process + IPC owner), `observer.js`
(`TranscriptWatcher`), `soundManager.js` / `soundTriggers.js` / `tts.js` /
`ttsExtract.js` (sound & voice pipeline), `uiprefs.js`, `profiles.js`,
`layouts.js`, `ports.js`, `usage.js`, `models.js`, `paths.js`, `preload.js`
(the `contextBridge` surface).

---

## 5. How to add a new Passive-Observer widget

A repeatable recipe, worked from the read-output-aloud feature (§11.2) that was
just built:

1. **Find the data.** Prefer the transcript JSONL over stdout scraping — it's
   structured. `observer.js`'s `TranscriptWatcher` already tails it per-session;
   extend its callback payload rather than opening a second watcher.
2. **Write a pure extractor.** A function that takes raw text/JSON lines and
   returns the data you need — no I/O, no side effects. This is what gets unit
   tested (`node --test`). Example: `ttsExtract.js`'s `extractSpokenText()`.
3. **Add a pref, if the feature should be opt-in.** `uiprefs.js`'s `DEFAULTS`
   object, plus the matching read/write branch — default to `false` for
   anything that changes behavior a user hasn't asked for yet (sound, voice,
   auto-anything).
4. **Wire it in `main.js`.** Call the extractor from the relevant
   `TranscriptWatcher`/PTY callback, gate it on the pref, push results over IPC.
   Keep the gate as narrow as the feature's actual purpose — don't inherit an
   unrelated existing gate just because one is nearby (§11.2 deliberately did
   *not* reuse the long-task-only gate from the `voice.done` chime, because
   "read back what was said" and "you can stop watching now" answer different
   questions).
5. **Add the renderer widget module.** New file in `src/renderer/modules/`,
   registered via `registry.js`'s `defineWidget()`. Repaint from module state on
   mount (see `appearance.js`'s comment on why: a remount must reflect truth,
   not the template's authored defaults).
6. **i18n.** Every user-facing string gets a PL and EN entry in `i18n.js`.
7. **Test the pure functions, not the OS wrappers.** Matches the existing
   convention — `soundManager.js` and `tts.js` are thin process/IPC wrappers and
   aren't tested; `ttsExtract.js` has 16 tests because it's pure logic.
8. **Update `README.md`'s data-flow table and `FUTURE_PLAN.md`'s phase
   tracker** — not this document, which stays a stable reference.

---

## 6. Future Module Ideas

Filtered and reframed from `LUNA_HUD_ADVANCED_SPEC.md` for the real Electron/
Windows stack. Each is scored: zero-token compliance, rough complexity, and a
priority read. "Realistic" means: buildable today with data LunaCore already
has access to, no native dependency risk beyond what's already accepted (mpv).

### 6.1 Session Timeline & Snapshot Scrubber — SHIPPED 2026-08-17
Shipped close to as sketched, with one simplification: instead of a diff/JSONL
reader, it rides `TranscriptWatcher.onTurnEnd({startedAt, endedAt, text})`
directly (`src/observer.js`) — the same fragment `ttsExtract.js` already reads
for read-aloud, so zero new IPC round trip and zero new file read. Renders as a
compact, horizontally-scrollable strip of small markers (a narrow right-rail
slot can't fit a wide visual timeline) in `src/renderer/modules/sessiontimeline.js`;
clicking one opens a read-only preview modal (`#stimeline-modal` in
`index.html`, same overlay skeleton as the palette/Settings modals) showing
that turn's captured text, truncated past `MAX_TEXT_CHARS = 4000` with an
honest "truncated" note, capped at the last `MAX_TURNS = 100`. Pure Passive
Observer — the modal only ever displays already-captured text, nothing here
writes to the PTY. Per-tab isolated via `registerSessionView` (each tab keeps
its own timeline). 438 tests.

### 6.2 Active-Files Edit Heatmap — SHIPPED 2026-08-13
Extends the Skill Tracker's existing `tool_use`/`tool_result` pairing
(`toolEventsFromLines()` / `foldToolEvents()` in `observer.js`) with
file-path granularity: for `Read`/`Edit`/`Write` tool calls, extract the
`input.file_path` and tally recency/frequency per file. Renders as a small
list in the right panel with real git-diff-stat `+`/`-` counts, a live
"currently being edited" pulse, and a deleted-file indicator. Full build
record, including two same-day amendments from manual-test feedback, in
[`ACTIVE_FILES_HEATMAP_PLAN.md`](ACTIVE_FILES_HEATMAP_PLAN.md).

### 6.3 Media Deck (now-playing + system volume) — SHIPPED 2026-08-17, reframed again
The original idea (`LUNA_HUD_ADVANCED_SPEC.md` Idea 1) assumed DBus MPRIS /
AppleScript; a first Windows reframe (kept below for the record) proposed the
**Spotify Web API**. What actually shipped drops that entirely in favor of
Windows' own **GlobalSystemMediaTransportControlsSessionManager** (GSMTC —
the API behind Win11's own media flyout/lock-screen widget), reached from
PowerShell via the standard WinRT `Await` helper
(`helpers/media/now-playing.ps1`). This is strictly better for the goal: it
targets whatever Windows itself considers the *current* session — any app
(Spotify, a browser tab, anything), not just Spotify — needs **no OAuth, no
stored credential, and no network call at all**, staying inside the strict
"zero tokens = no network at all" framing instead of stepping outside it.
System volume is a separate OS subsystem (Core Audio), read/written via the
standard `IAudioEndpointVolume` COM interop snippet
(`helpers/media/volume.ps1`). `src/media.js` wraps both the same way
`gpu.js`/`tts.js` wrap their own OS shell-outs (args array, never a string,
bounded timeout, degrade-to-null never-throw); polls now-playing every 2s and
pushes only on change. Backend Windows caveat found and fixed during build:
Windows PowerShell 5.1 needs an explicit
`Add-Type -AssemblyName System.Runtime.WindowsRuntime` before the WinRT
`Await` helper's types resolve — without it the script silently reports
"nothing playing" forever, even with media active.
**Not built: voice ducking.** Still a real idea (lower system volume while
`narrationManager` speaks, restore after) but is now a much smaller lift than
originally scoped, since the volume primitive (`setVolume`/`getVolume`) this
shipped is exactly what ducking would call — no Spotify auth flow needed.
Left as an open follow-up, not a blocker. 438 tests.

### 6.4 Multi-Agent (Subagent) Stream Visualizer — Needs a research spike first
Side-by-side cards for concurrently running subagents (Task-tool spawns).
Blocked on an open question: does the transcript JSONL expose subagent
execution in a way that's cleanly attributable per-subagent (separate
transcript file? nested tool_use ids?), or would this require scraping
something less stable? Don't commit to a build estimate until that's checked
against a real multi-agent session's JSONL.

### 6.5 RGB / Backlight Sync (OpenRGB) — Backlog, novelty
Pulse keyboard/peripheral RGB with the working/waiting LED state via OpenRGB's
local SDK/API. Zero-token compliant (pure local, no CLI data needed beyond
what the LED already has), but it's a nice-to-have with a real dependency
(OpenRGB installed and running) for a cosmetic payoff. Low priority — fine as
a someday item, not worth scheduling.

### 6.6 Terminal Appearance Customizer — Realistic, good fit, low complexity
Extend the existing theme switcher rather than build a new subsystem:
`@xterm/xterm` exposes live-settable `term.options` for font family/size, line
height, letter spacing, cursor style/blink, and scrollback size, plus a CSS-layer
opacity/blur knob. `terminals.js`'s `applyTerminalTheme()` already proves the
pattern — it pushes color changes straight onto a live terminal with no
remount. A few new controls on the Appearance panel (or a small dedicated
modal, if it should feel like its own feature rather than buried under
Appearance) is the whole scope. New prefs go in `uiprefs.js`'s `DEFAULTS`
exactly like `soundReadOutputEnabled` did. No new data source, no IPC channel
beyond what `ui:get`/`ui:set` already carries.

### 6.7 Local-LLM Hybrid Router — Dropped
The original idea (auto-route small/cheap tasks to a local Ollama/vLLM
instance) fails §1's rule by construction: it's a background agent making a
routing decision LunaCore itself would have to reason about, which is exactly
the "hidden middleware" the zero-token rule exists to forbid. If local-model
support is wanted, it already exists in a form that respects the rule: manual,
explicit profile switching via `config/profiles.json`'s `ANTHROPIC_BASE_URL`
mechanism, tracked as its own idea in `FUTURE_PLAN.md` §9 ("Multi-model
command center") — Kimi and LM Studio already work today with zero new code.
Not duplicated here; see that section for the real backlog.

---

## 7. What this document deliberately does not contain

No implementation plan/milestones, no boilerplate code, no directory-structure
proposal. The real project already has `FUTURE_PLAN.md` for phase sequencing —
duplicating that here would just be a second place for the schedule to go
stale. When one of §6's ideas gets picked up, it should get a section in
`FUTURE_PLAN.md`'s roadmap (or its own short plan doc, same shape as
`SOUNDS_IMPLEMENTATION_PLAN.md`), not an expansion of this file.
