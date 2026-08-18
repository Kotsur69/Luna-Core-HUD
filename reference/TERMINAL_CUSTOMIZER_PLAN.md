# Terminal Appearance Customizer → Settings Overlay (Reference)

**Status: shipped, done.** This used to be a 275-line build plan (a decision
table, a knob inventory, a modal spec written before the build started).
That's all history now — the code is the source of truth. This is the
compact version: what actually shipped (scope grew past the original plan,
into a general Settings overlay), which files implement it, and the gotchas
worth remembering. Compacted 2026-08-18.

---

## 1. What it does

**Ctrl+L** opens a modal ("Ustawienia" / "Settings") — global, not per-tab —
covering two sections:

- **Terminal appearance**: font family (curated list + "Custom…" free
  text), font size, line height, letter spacing, cursor style/blink,
  scrollback size, background opacity, background blur, and a **custom
  background image**.
- **Sound & boot sequence** (moved here from the left panel's Appearance
  section to declutter it — Mati's call mid-build): sound toggle/volume,
  keystroke variant, "all done" minutes, read-output-aloud, boot-sequence
  toggle.

Every knob applies live to the active terminal (and any new tab created
after) via `applyTerminalAppearance(prefs)` in `terminals.js`, mirroring how
`applyTerminalTheme()` already works. Persists to `ui.local.json`, global
across the whole app (matches theme/lang/sound scoping).

## 2. Files

| Path | Role |
|---|---|
| `src/renderer/modules/termcustom.js` | Modal open/close, Ctrl+L capture (capture phase, ahead of xterm — same pattern as palette.js's Ctrl+K), Escape-to-close |
| `src/renderer/modules/terminals.js` | `applyTerminalAppearance()` + `currentTermAppearance` module state so new tabs inherit the customized look |
| `src/uiprefs.js` | `DEFAULTS` fields (`termFontFamily`, `termFontSize`, `termLineHeight`, `termLetterSpacing`, `termCursorStyle`, `termCursorBlink`, `termScrollback`, `termBgOpacity`, `termBgBlur`, `termBgImage`) + `clampTermPrefs()` validator (pure, tested) |
| `src/main.js` | `termcustom:pickBgImage` IPC — native file dialog, reads chosen image (4MB cap), returns a `data:` URI (CSP only allows `'self'`/`data:` for `img-src`) |

## 3. Gotchas found during the build (all fixed, worth remembering)

- **`allowTransparency: true` is constructor-only.** Opacity/blur looked
  broken until this was set at `TERM_OPTIONS` construction time (same
  category as `cols`/`rows` — can't be toggled after the terminal exists).
  Without it, xterm's canvas paints fully opaque regardless of any alpha in
  `theme.background`.
- **`[hidden]` doesn't override `display: flex`.** `#update-notice`'s
  `.update` class set `display: flex` with no `.update[hidden] { display:
  none; }` override — the same bug class the codebase had already hit once
  for `.badge`. Watch for this pattern anywhere a flex child gets
  conditionally hidden.
- **Native number/range inputs had zero CSS anywhere in the app** — white
  Chromium controls clashing with every dark theme. Fixed globally in
  `styles.css`, which incidentally also fixed pre-existing sound-volume
  fields.
- **Custom background image lives on `#terminal`** (the ancestor of every
  `.terminal__pane`), not the panes themselves — so opacity (via the
  transparent canvas) and blur (via `backdrop-filter` on the panes) both
  compose with it correctly.

## 4. Explicitly deferred, not built

**Whole-app OS-level window transparency** (all panels fading to the real
desktop, not just the terminal) was requested and scoped, then declined for
this round: Electron's `transparent: true` needs `frame: false` on Windows
too (loses the native title bar — needs a custom-built replacement), the
toggle would need to recreate the window (open tabs' visible scrollback
resets, though the underlying shell sessions survive), and it means
reworking ~45 color tokens across 9 themes to carry an alpha channel. If
revisited, it's a project of its own — see `FUTURE_PLAN.md`'s "Next action"
for current status.
