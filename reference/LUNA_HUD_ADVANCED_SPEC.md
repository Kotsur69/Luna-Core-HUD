# Advanced Module Ideas (Reference)

**Note on origin:** this doc originally sketched four modules against a
Go/`bubbletea` TUI stack that was never built — the project pivoted to the
actual Electron/`node-pty` implementation described in `README.md` and
`LUNA_HUD_SPECIFICATION.md`. Kept because two of the four ideas shipped
(in the real stack, not the one sketched here) and two are still open
backlog. All Go-specific file paths below are dead references — do not
follow them. Compacted 2026-08-18.

---

## 1. Spotify Audio Deck & Voice Ducking — superseded

Sketched as a DBus MPRIS / AppleScript integration with a wavebar
visualizer. **What actually shipped is different**: Media Deck uses
Windows' own GSMTC + Core Audio COM interop (`src/media.js`) — works with
any player, no OAuth, no network. See `LUNACORE_HUD_WIDGET_PLAN.md` §2 and
`LUNA_HUD_SPECIFICATION.md` §6.3. Voice ducking (temporarily lowering
media volume while Luna's TTS speaks) was never built — still a valid idea,
listed in `FUTURE_PLAN.md`'s "Next action" backlog, now that Media Deck's
volume primitive exists to hook it off of.

## 2. Live File-State Heatmap & Per-File Context Weighting — shipped

Cited elsewhere by section number, so kept as §2. **Shipped**, in the real
stack — see `ACTIVE_FILES_HEATMAP_PLAN.md` for the heatmap itself and
`FUTURE_PLAN.md`'s "per-file context weight" entry for the token-weighting
half (measures what actually entered the model's context window, from a
Read's `toolUseResult.file.content`, not the file's on-disk size).

## 3. Multi-Agent Parallel Stream Visualizer — not built, open idea

Side-by-side execution tracker for parallel sub-agent/background-process
work (e.g. one pulsing card per active worker: refactor agent, test runner,
linter). Never scoped against the real Electron/observer architecture —
would need a real design pass (what counts as an "agent" in a single-PTY
app, how to detect parallel work from one transcript stream) before it's
buildable. Still on the idea list, not on any active roadmap phase.

## 4. Session Timeline & Snapshot Scrubber — shipped, differently

Sketched as a Go event-logger + TUI scrubber bar. **Shipped** in the real
stack instead: a compact scrollable strip of turn markers in the right
rail riding `TranscriptWatcher.onTurnEnd()` (zero new IPC/file read), click
opens a read-only preview modal. See `LUNA_HUD_SPECIFICATION.md` §6.1.

## 5. Other ideas, not built

- **Local LLM fallback/hybrid router** — auto-route small tasks (line
  edits, formatting) to a local Ollama/vLLM instance under latency
  pressure. Overlaps with `FUTURE_PLAN.md` §9's multi-model backlog, which
  is the more developed version of this idea (explicit, user-initiated
  provider switching rather than silent auto-routing — silent routing
  would violate the app's zero-token/observer-only rule anyway).
