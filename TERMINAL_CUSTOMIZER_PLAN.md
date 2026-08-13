# Terminal Appearance Customizer — Implementation Plan

**Status: SHIPPED, 2026-08-13 — scope grew past this plan.** Source idea:
`LUNA_HUD_SPECIFICATION.md` §6.6. What's below is the original plan as written
before the build started; **§10 at the bottom records what actually shipped**,
including everything this plan didn't anticipate (it grew into a general
Settings overlay, not terminal-appearance-only). Read §10 first if you only
want current truth — the rest of this file is historical.

---

## 0. What's already decided (2026-08-12, with Mati)

| Question | Decision |
|---|---|
| Scope | **Full knob set in one pass** — font family, font size, line height, letter spacing, cursor style, cursor blink, scrollback size, AND terminal background opacity + blur. Not split into a later fast-follow. |
| UI home | **Dedicated modal**, not stuffed into the Appearance panel. Opened on demand, not a permanent visible section — "to save space." |
| Open trigger | **Ctrl+L**, global keybind, plus presumably a manual click target too (see §3). |
| Font input | **Both** — curated dropdown of known-good monospace fonts, with a "Custom…" option that reveals free text. |
| Control style | **Raw granular controls**, no presets layer — matches how the existing sound panel works. |
| Scope (global vs per-tab) | **Global**, not per-tab/per-profile — matches how theme and sound prefs already behave app-wide. Confirmed 2026-08-13. |

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

Confirmed live with Mati, 2026-08-13 unless noted:

- [x] Ctrl+L opens the modal from anywhere; manual chip trigger also works.
- [ ] Escape closes the modal, refocuses the terminal — not explicitly
      re-checked after later edits, low risk (unchanged code path).
- [x] Font family / font size / letter spacing change the **active** tab's
      terminal live ("font size works font family also eltter spacing also"
      — Mati). Cursor style/blink/scrollback share the exact same code path
      but weren't individually called out.
- [ ] Opening a **new** tab after customizing inherits the custom look —
      not explicitly re-checked.
- [ ] Switching **theme** after customizing keeps the custom opacity —
      not explicitly re-checked.
- [ ] Font-size/line-height/letter-spacing don't desync `cols`/`rows` from
      the pty — not explicitly re-checked.
- [ ] Restart the app — persistence not explicitly re-checked this session,
      though it's the same `ui.local.json` round-trip theme/lang already use.
- [x] Background opacity + blur — **found broken, root-caused, fixed**: xterm
      needs `allowTransparency: true` at construction (constructor-only, like
      `cols`/`rows`) or the canvas paints fully opaque regardless of alpha.
      Confirmed working after the fix ("ye it works" — Mati), including with
      a custom background image (§10).
- [x] `npm test` green — 362/362 (added `clampTermPrefs()` coverage for
      `termBgImage` too).

---

## 10. What actually shipped (2026-08-13) — current truth, read this first

The build followed §8's order faithfully through step 7 (i18n), then Mati's
live feedback while testing pushed the scope well past this plan. In order:

1. **Input styling bug** (pre-existing, not introduced here): `input[type=
   number]`/`input[type=range]` had zero CSS anywhere in the app — native
   white Chromium controls clashing with every dark theme. Fixed globally
   (`styles.css`), which also fixed the pre-existing sound-volume /
   "all done" minutes fields Mati screenshotted.
2. **No save feedback**: there's no Save button by design (matches how
   theme/lang/sound already apply live) — but nothing told Mati a change had
   landed, and Enter did nothing (no `<form>` in the modal). Added: Enter now
   commits + refocuses the field, and every change flashes a brief cyan pulse
   (`.is-confirmed`).
3. **Settings overlay consolidation**: Mati asked to declutter the left
   panel. Sound (toggle/volume/keystroke variant/"all done" minutes/
   read-output) and the boot-sequence toggle moved from `appearance.js`'s
   `w-appearance` template into this modal, as a second labelled section.
   File/module/element ids kept the historical "termcustom" name — only
   user-visible text changed (title → "Ustawienia"/"Settings", chip tooltip
   likewise). `appearance.js` now only owns theme/layout/language + the
   update notice.
4. **Leftover empty panel bug**: `#update-notice`'s `.update` class sets
   `display: flex` with no `.update[hidden] { display: none; }` override —
   a flex child ignores the `[hidden]` attribute's default UA style. Exact
   same bug class the codebase had already hit once for `.badge`. Fixed.
5. **Opacity/blur were actually broken, not just subtle**: xterm's canvas
   ignores any alpha channel in `theme.background` unless
   `allowTransparency: true` is set **at construction** (constructor-only,
   same category as `cols`/`rows`). This was never set. Root-caused and
   fixed in `terminals.js`'s `TERM_OPTIONS`.
6. **Custom background image** (new feature, not in the original plan):
   `termBgImage` pref (a `data:` URI — the renderer's CSP only allows
   `'self'`/`data:` for `img-src`, so a raw file path was never an option).
   New IPC `termcustom:pickBgImage` (`main.js`) opens a native file dialog,
   reads the chosen image (4MB cap), returns the encoded result — the
   renderer never touches the filesystem. Lives on `#terminal` (the
   *ancestor* of every `.terminal__pane`), not the panes themselves, so
   opacity (via the now-working transparent canvas) and blur (via
   `.terminal__pane`'s `backdrop-filter`) both compose with it correctly.
7. **Whole-app OS-level window transparency — explicitly deferred, not
   built.** Mati asked for the entire app (all panels, not just the
   terminal) to fade to the real desktop. Scoped and declined for this
   round: Electron's `transparent: true` needs `frame: false` on Windows too
   (loses the native title bar — minimize/maximize/close/drag/Snap — needs a
   custom-built replacement), the toggle itself would need to recreate the
   window (renderer reload → open tabs' *visible* scrollback resets, even
   though the underlying shell sessions survive in the main process), and
   "everything fades together" means reworking the ~45 color tokens across 9
   themes to carry an alpha channel. Real project, own session.

**Next session, in order:**
1. Finish §9's remaining unchecked manual-verification items (new tab
   inherits customization, theme switch preserves opacity, cols/rows don't
   desync, restart persists).
2. If Mati still wants it: scope and start the whole-app transparency project
   (§10.7) as its own plan doc, following this file's own shape.
3. Otherwise: back to `FUTURE_PLAN.md`'s "Next action" (cut `v0.9.1`, or pick
   the next `LUNA_HUD_SPECIFICATION.md` §6 idea).

Remaining unchecked items are believed low-risk (unchanged/well-established
code paths) but are the right place to start **next session**'s verification
pass if anything looks off.
