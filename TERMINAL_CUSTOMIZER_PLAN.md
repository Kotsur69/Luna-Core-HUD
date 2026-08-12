# Terminal Appearance Customizer — Implementation Plan

**Status: PLANNING ONLY. No code written yet.** Source idea: `LUNA_HUD_SPECIFICATION.md`
§6.6. This document is the "own short plan doc, same shape as
`SOUNDS_IMPLEMENTATION_PLAN.md`" that §7 of that spec calls for once a §6 idea
gets picked up.

---

## 0. What's already decided (2026-08-12, with Mati)

| Question | Decision |
|---|---|
| Scope | **Full knob set in one pass** — font family, font size, line height, letter spacing, cursor style, cursor blink, scrollback size, AND terminal background opacity + blur. Not split into a later fast-follow. |
| UI home | **Dedicated modal**, not stuffed into the Appearance panel. Opened on demand, not a permanent visible section — "to save space." |
| Open trigger | **Ctrl+L**, global keybind, plus presumably a manual click target too (see §3). |
| Font input | **Both** — curated dropdown of known-good monospace fonts, with a "Custom…" option that reveals free text. |
| Control style | **Raw granular controls**, no presets layer — matches how the existing sound panel works. |
| Scope (global vs per-tab) | **Assumed global**, not per-tab/per-profile — matches how theme and sound prefs already behave app-wide. Flagging this as an assumption, not a locked decision — say if you want per-tab instead. |

**Known tradeoff, not a new risk category:** Ctrl+L is the readline/shell
convention for "clear screen" and today reaches the shell exactly like any
other keystroke (Action Injector: `onData()` → `window.lunacore.write()`).
Capturing it globally, ahead of xterm, means the terminal stops receiving a
literal Ctrl+L while LunaCore is running. This is the *same* tradeoff already
made for Ctrl+K (which overrides readline's "kill line" binding) — see
`palette.js`'s `// Global Ctrl/Cmd+K (capture, to get ahead of xterm.js)`
comment. Following that exact precedent, not inventing a new one.

---

## 1. Zero-token compliance

Falls under the spec's third category — **local-only feedback**: no CLI data
read, no network call, no model involved. Doesn't even touch
`TranscriptWatcher`; it's pure rendering/config state, closer in spirit to the
theme system than to any Passive-Observer widget. No new IPC channel beyond
what `ui:get`/`ui:set` already carries (same as every other appearance pref).

---

## 2. Knob inventory

| Knob | Mechanism | Control | Default | Live-update note |
|---|---|---|---|---|
| Font family | `term.options.fontFamily` | Curated `<select>` (Cascadia Code, Consolas, JetBrains Mono, Fira Code, Courier New, System default) + "Custom…" free-text | `'Cascadia Code, Consolas, "Courier New", monospace'` (current `TERM_OPTIONS`) | Cell size changes → needs `fitAndResize()` + pty resize after |
| Font size | `term.options.fontSize` | Number input / stepper | `14` | Same as above |
| Line height | `term.options.lineHeight` | Number input (e.g. 1.0–2.0, step 0.1) | `1.0` (xterm default) | Same as above |
| Letter spacing | `term.options.letterSpacing` | Number input (px) | `0` (xterm default) | Same as above |
| Cursor style | `term.options.cursorStyle` | `<select>`: block / underline / bar | `'block'` (xterm default) | Live, no resize needed |
| Cursor blink | `term.options.cursorBlink` | Checkbox | `true` (current `TERM_OPTIONS`) | Live, no resize needed |
| Scrollback size | `term.options.scrollback` | Number input | `5000` (current `TERM_OPTIONS`) | Live per xterm 5.x — **verify during build**, not a certainty |
| Background opacity | `theme.background` alpha channel (xterm theme colors accept rgba) | Slider 0–100% | `100%` (opaque) | Live; converts current theme's background hex + alpha → rgba string fed through the same path as `applyTerminalTheme()` |
| Background blur | `backdrop-filter: blur()` on `.terminal__pane`, new CSS custom property `--term-blur` | Slider 0–20px | `0px` | Pure CSS, no xterm involvement |

**Open technical flag on the last two:** `.terminal__pane` sits over
`--bg-panel`, which is a mostly flat dark color in every theme today — there's
no strong texture/image behind it for blur to visibly act on. Recommend
building font/cursor/scrollback fully first, then eyeballing opacity/blur with
a couple of manual test values in `npm start` *before* polishing the slider
UI — if the visual payoff turns out to be near-invisible against a flat panel,
that's worth knowing before investing in the full control, not after.

---

## 3. UI: dedicated modal

Mirrors `palette.js`'s existing shape exactly — it's the only precedent for a
standalone (non-widget-registry) overlay in this codebase:

- New static markup block in `index.html`, e.g. `.termcustom__modal` with
  `role="dialog" aria-modal="true"`, same shape as `.palette__modal`.
- New module `src/renderer/modules/termcustom.js` — own open/close state,
  no `defineWidget()` registration (palette isn't a registry widget either).
- Global `Ctrl+L` keydown listener in the **capture phase** (`true`), ahead of
  xterm, same as palette.js's Ctrl+K handler — `preventDefault()` +
  `stopPropagation()`.
- A manual click target too, so the shortcut isn't the only way in — likely a
  small icon button in the terminal bar next to the existing palette chip
  (`mountPaletteChip()`'s pattern — `#palette-open` sibling, called once from
  `terminal.js`'s `mount()`).
- `Escape` closes it, refocuses the terminal — same as palette's close path.

---

## 4. Applying settings to live terminals

Parallels `applyTerminalTheme(palette)` in `terminals.js`:

- New `applyTerminalAppearance(prefs)` in `terminals.js`, looping over
  `termsBySession.values()` and setting each live-settable `term.options.*`
  key present in `prefs`.
- New module-scope `currentTermAppearance` (mirrors `currentTermTheme`) so a
  **newly created tab** (`ensureTerm()`) picks up the customized settings
  immediately instead of being born on the hardcoded `TERM_OPTIONS` defaults —
  same reasoning `currentTermTheme` already documents for theme colors.
- After any knob that changes cell size (font family/size, line height,
  letter spacing), call `fitAndResize()` and let it push the new `cols`/`rows`
  over `window.lunacore.resize()` — reusing the exact function already used
  on window resize, so the pty and xterm never disagree on dimensions.
- Background opacity: compute an rgba string from the **current theme's**
  `background` color + the opacity slider, and merge it into
  `term.options.theme` via the same `{ ...s.term.options.theme, ...palette }`
  spread `applyTerminalTheme()` already uses — so switching themes afterward
  doesn't lose the opacity override (needs re-applying the customizer's alpha
  on top of `applyThemeVars()`'s theme-change path in `appearance.js` — the
  two need to compose, not race).

---

## 5. Prefs schema (`uiprefs.js`)

New `DEFAULTS` entries, following the existing `sound*` naming convention:

```
termFontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
termFontSize: 14,
termLineHeight: 1.0,
termLetterSpacing: 0,
termCursorStyle: 'block',
termCursorBlink: true,
termScrollback: 5000,
termBgOpacity: 100,   // percent, 0-100
termBgBlur: 0,        // px, 0-20
```

Each needs the same read-validation branch pattern already used for
`soundVolume`/`soundEnabled` in `readUiPrefs()`, plus a `writeUiPrefs()`
partial-update branch per field. Global, not per-tab/per-profile (§0).

---

## 6. i18n

New keys in `i18n.js`, PL + EN, minimum set:

- Modal title (`termcustom.title`)
- One label per knob (9 labels)
- Cursor style option labels (block/underline/bar — 3 more)
- "Custom…" font option label
- Reset-to-defaults button label (a plain reset is worth including — cheap to
  add, saves someone from manually re-typing the default font string)

---

## 7. Testing

Matches the convention §5 step 7 of `LUNA_HUD_SPECIFICATION.md` already states:
test the pure functions, not the OS/DOM wrappers.

- **Pure & testable:** a validator/clamp function (e.g. `clampTermPrefs()`)
  that takes a raw prefs object and returns a sanitized one — clamps
  `termFontSize`/`termScrollback`/`termBgOpacity`/`termBgBlur` to sane ranges,
  validates `termCursorStyle` against the allowed enum, falls back to
  `DEFAULTS` on garbage input. Same shape as `resolveSoundFile`/`clampVolume`.
  This is what gets `node --test` coverage.
- **Not tested (thin wrappers):** the actual `term.options.*` assignments in
  `applyTerminalAppearance()`, the modal's DOM wiring, the keydown capture —
  same category as `soundManager.js`/`tts.js` today.

---

## 8. Build order (for when Mati says go — not now)

1. `uiprefs.js` — new `DEFAULTS` fields + read/write validation + the pure
   `clampTermPrefs()` validator, with its `node --test` coverage first (TDD,
   per the project's own workflow convention).
2. `index.html` — static `.termcustom__modal` markup block.
3. `termcustom.js` — open/close, Ctrl+L capture, Escape-to-close, manual
   trigger button, wiring reads/writes through `window.lunacore.getUiPrefs`/
   `setUiPrefs`.
4. `terminals.js` — `applyTerminalAppearance()` + `currentTermAppearance`
   module state + `ensureTerm()` picking it up on tab creation.
5. Wire font/size/lineHeight/letterSpacing/cursorStyle/cursorBlink/scrollback
   end to end; manual check in `npm start` (each knob visibly does what it
   says, new tabs inherit the customized look, switching themes doesn't
   reset it).
6. Wire opacity + blur last, per §2's flag — eyeball it before investing in
   full slider polish.
7. i18n — PL/EN for every new label.
8. `README.md` data-flow table + `FUTURE_PLAN.md` phase tracker update (per
   §5 step 8 of the spec) — propose it as a new backlog line item once this
   actually starts, not before.

---

## 9. Verification checklist (manual, `npm start`)

- [ ] Ctrl+L opens the modal from anywhere in the app; Ctrl+L **no longer**
      reaches the shell while LunaCore has focus (confirm this is the
      intended tradeoff, not a surprise, before shipping).
- [ ] Escape closes the modal, refocuses the terminal.
- [ ] Every knob changes the **active** tab's terminal live, no remount
      needed.
- [ ] Opening a **new** tab after customizing inherits the custom look
      immediately (not the hardcoded `TERM_OPTIONS` defaults).
- [ ] Switching **theme** after customizing keeps the custom opacity/font/etc
      (theme change and customizer change compose, don't race/overwrite).
- [ ] Font-size/line-height/letter-spacing changes don't desync `cols`/`rows`
      from the pty — type something long, resize the window, confirm reflow
      still matches what the shell thinks the terminal size is.
- [ ] Restart the app — every customized value persists (round-trips through
      `ui.local.json` via `ui:get`/`ui:set`, same file theme/sound prefs use).
- [ ] `npm test` green, new `clampTermPrefs()` tests included.
