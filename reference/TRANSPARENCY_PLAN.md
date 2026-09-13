# LunaCore — Whole-app window transparency (v0.11.0)

Plan doc for the project Mati asked for on 2026-09-11: *"the whole transparent
thing that we previously planned … but I want to leave the current appearance
themes bcs I love them."*

Branch: `feat/window-transparency` → one `v0.11.0` release at the end.

**Supersedes** [`TERMINAL_CUSTOMIZER_PLAN.md`](TERMINAL_CUSTOMIZER_PLAN.md) §4
("Explicitly deferred, not built") and closes the open item in
[`../FUTURE_PLAN.md`](../FUTURE_PLAN.md)'s "Next action" row.

---

## Decisions locked 2026-09-11 (do not re-ask)

| Question | Answer |
|---|---|
| Mechanism | **Win11 `backgroundMaterial: 'acrylic'`** on the existing *framed* window. Not `transparent: true`. |
| Scope | **Everything** — root ground, panels and terminal all take alpha from one axis, with panels held more opaque than the gaps. |
| Themes | **Runtime alpha via `color-mix()`. `config/themes.json` is not edited. Zero changes to all 28 themes' colours.** |
| Control | ~~A 5th modifier axis~~ → **superseded 2026-09-11: transparency is its own THEME.** A 29th entry (`glass`) in the existing theme picker. |
| Default | Unchanged. Transparency exists only while the `glass` theme is selected; all 28 other themes render pixel-identical to v0.10. |

### Why "leave the themes alone" is a hard constraint, not a preference

Mati's themes are the thing he likes most about the HUD, and the original §4
deferral priced this project at *"reworking ~45 colour tokens across 9 themes to
carry an alpha channel"* — which is now 49 tokens across **28** themes. That
rework is what made it a project of its own, and it is also exactly the thing
that would have damaged what he wants kept.

`color-mix()` removes the whole line item. A theme keeps publishing opaque hex,
and the *stylesheet* decides how much of it to paint. The alpha lives in one
token, in one place, applied at paint time.

---

## Why this got cheap — what changed since §4

§4 named three blockers. Two are simply gone, and the third is the decision above.

| §4 blocker (2026-08-18) | Status 2026-09-11 |
|---|---|
| `transparent: true` needs `frame: false` on Windows → loses the native title bar, needs a hand-built replacement | **Gone.** `backgroundMaterial` is a *framed-window* feature. The native titlebar, its buttons, snap layouts and rounded corners all stay. Nothing is hand-built. |
| Toggling would have to recreate the window → open tabs' visible scrollback resets | **Gone.** `win.setBackgroundMaterial(m)` applies to a live window. No recreation, no reset, no reconnecting PTYs. |
| ~45 colour tokens × 9 themes reworked to carry alpha | **Gone by design.** `color-mix()` derives alpha from the theme's existing opaque colour. The `themes.json` diff is empty. |

`backgroundMaterial` has been in Electron since v26; this repo is on **Electron
43** (`package.json`), so the API is available today with no upgrade.

The trade accepted in exchange: acrylic shows a **blurred, DWM-tinted** version
of what is behind the window, not the sharp desktop, and it is **Windows 11
only**. Both were understood and chosen.

---

## Phase 0 — the spike. Do this before writing any real code.

Everything below assumes Win11 acrylic behaves on Mati's build (Windows 11 Home
10.0.26200). That is an assumption, not a fact, and it is cheap to test and
expensive to be wrong about. Two lines in `src/main.js`'s `createWindow()`
(~`:322`), run, look, revert:

```js
backgroundColor: '#00000000',   // was '#0a0710'
backgroundMaterial: 'acrylic',
```

Four checks, because each is a documented failure mode rather than paranoia:

1. **Does blur appear at all**, or only after the window is first moved/resized?
   (Known Chromium/DWM ordering issue — the material gets applied before the
   window has a composited surface.)
2. **Does it survive losing focus?** Win11 commonly drops acrylic to a flat
   fallback on inactive windows. If it does, the material becomes `mica` and the
   plan is otherwise unchanged.
3. **Are the native titlebar and rounded corners intact?**
4. **Does `setBackgroundMaterial('none')` restore solid, live, with no
   recreation?** This is the whole basis for the axis being togglable.

**Gate:** if 1 or 4 fails, this plan stops and we reopen `transparent: true`
with its full §4 price. If only 2 fails, switch to `mica` and continue.

---

## Phase 1 — main process

`src/main.js`:

- `createWindow()`: `backgroundColor: '#00000000'` and `backgroundMaterial` read
  from persisted prefs.
- **Restore the no-white-flash guard.** ✅ **Done.** A transparent
  `backgroundColor` gives up Electron's own guard, so `renderer/index.html` now
  carries `<style>html { background: #0a0710; }</style>` *before* the stylesheet
  link — it paints before `styles.css` parses, and `styles.css` wins by source
  order the moment it does. Without it a cold start flashes raw desktop.
- **No live toggle, no IPC** *(revised — see Phase 3)*. `backgroundMaterial` is
  set once and never changes, because acrylic is invisible under an opaque
  theme.
- **Platform gate:** `process.platform !== 'win32'` → force `solid` and never
  call the setter. Win10 also gets `solid` (the API is a no-op there, but the
  transparent `backgroundColor` is not — it would show black).

## Phase 2 — the surface layer in `styles.css`

One alpha token plus four derived surfaces, in `:root` beside the existing
modifier tokens:

```css
--surface-alpha: 100%;   /* 'solid' — byte-identical to v0.10 */
--surface-bg:      color-mix(in srgb, var(--bg)         var(--surface-alpha), transparent);
--surface-panel:   color-mix(in srgb, var(--bg-panel)   var(--surface-alpha), transparent);
--surface-panel-2: color-mix(in srgb, var(--bg-panel-2) var(--surface-alpha), transparent);
--surface-term:    color-mix(in srgb, var(--term-bg)    var(--surface-alpha), transparent);
```

**56 paint sites** get swapped from the raw token to its surface counterpart:

| Token | Sites |
|---|---|
| `var(--bg-panel-2)` | 42 |
| `var(--bg-panel)` | 7 |
| `var(--bg)` | 4 |
| `var(--term-bg)` | 2 |
| `var(--edge)` — **`.app` background only** | 1 |

### The `--edge` trap (found in Phase 0, 2026-09-11)

`--surface-edge` is a **fifth** surface, and it is the one that actually matters.
`.app` (`:431`) is a `height: 100vh` grid painted `background: var(--edge)` — an
opaque lid over the entire window, sitting above `body` and below every panel.
The hairlines between panels are not borders at all: they are `.app`'s background
showing through `gap: var(--space-hair)`.

Consequence: making `html, body` transparent achieves **nothing visible** on its
own. `.app` is the layer that has to open up, and it is also what turns the
hairline grid into the see-through gaps the "everything" scope is asking for.

The scoping is narrow and must stay that way. `var(--edge)` appears **59** times
in `styles.css`, but **40 of those are `border:` declarations** and exactly one
is a background. Only `.app`'s background gets the surface treatment. **Borders
stay fully opaque** — they are the structure that keeps panels legible as panels
once the ground behind them is moving desktop, and alpha-ing them would dissolve
the HUD's edges at precisely the moment it needs them most.

At `--surface-alpha: 100%` every one of those resolves to the identical colour it
paints today. That is the regression guard, and it is mechanically testable —
which matters more than it sounds: it means the risky-looking 56-site edit has a
provably empty visual diff in the default state.

**Panels are held above the ground.** Panels stay ~15pp more opaque than
`--surface-bg`, so as the axis opens up it is the *gaps between regions* that go
furthest through, not the surfaces carrying text. Transparency you notice,
readability you keep.

**Deliberately staying opaque**, each for a reason:

- `--btn-grad` / `--btn-grad-hover` — gradients don't `color-mix` cleanly, and a
  control that reads as solid is a control you trust you have hit.
- `.tab.is-active` (`:1105`) — the active tab earns contrast against its row.
- The modal scrim — its entire job is to occlude.

## Phase 3 — transparency as a theme (revised 2026-09-11)

**The modifier axis is cancelled.** Mati's call, and it is the better design:
*"i wanted to make transparency mode as a other thing so themes are untouched and
transparency is just a separate theme."*

Transparency ships as **one new theme, `glass`**, a 29th entry in the picker that
already exists. Picking it makes the HUD see-through; picking any other theme
makes it solid. You have Luna **or** Glass, never both — chosen deliberately over
the composable axis.

### Why this turned out to cost almost nothing

`applyThemeVars()` already writes *any* `--*` token a theme carries. So a theme
can set `--surface-alpha` itself, and the entire control problem disappears:

- **No modifier axis** — no `MODIFIER_AXES` row, no `SURFACE_LEVELS`, no
  `clampModifierPrefs()` change, no `[data-surface]` blocks.
- **No Settings UI** — the theme dropdown is the control.
- **No IPC, no window toggle.** `backgroundMaterial: 'acrylic'` is set once,
  unconditionally, and never changes. Acrylic is only ever *visible* where the
  stylesheet paints a surface with alpha, and only `glass` does that. Under the
  other 28 themes the app covers the material completely and it costs nothing.
  This is what removed Phase 1's live-toggle plumbing entirely.
- **`themes.json` gains a theme and edits none.** Verified: the diff is
  **+45 / −0**.

### The one piece of real machinery: the token dictionary

`src/theme.js` keeps a `KNOWN_TOKENS` allowlist, and `test/theme.test.js` fails
if it drifts from `:root`. Adding the surface tokens tripped it immediately,
which is the guard working exactly as designed.

The resolution is a genuine new distinction rather than a test edit:

| | |
|---|---|
| `--surface-alpha` | **added to `KNOWN_TOKENS`** — a theme *must* be able to set it; that is the whole mechanism |
| `--surface-bg/-edge/-panel/-panel-2/-term` | **new `DERIVED_TOKENS` set** — computed `color-mix()`es, deliberately *not* theme-settable |

A theme setting `--surface-panel` directly would hand itself a fixed colour and
silently opt out of the alpha system — precisely the drift the dictionary exists
to catch. The guard got **stronger**, not weaker: the `:root` cross-check now
excludes derived tokens, and a new test pins that every derived token is in
`:root`, is absent from `KNOWN_TOKENS`, and is dropped with a warning if a theme
tries to set one.

### The Glass palette

Cool neutral slate, restrained accents, `--surface-alpha: 62%`. Deliberately
`--texture: none` and `--text-glow: none` — both are overlays that composite
against transparency rather than an opaque ground, which is the blend-mode trap
in Phase 4 below. Glass wants clarity anyway.

**Borders stay opaque.** `--edge` is the structure that keeps a panel readable as
a panel once there is moving desktop behind it.

## Phase 4 — the three things that will actually look wrong

This is where the real time goes. Phases 1–3 are mechanical; this is not.

1. **The `body::after` texture overlay** (`:454`) uses `mix-blend-mode:
   var(--texture-blend)`. Blend modes composite against transparency differently
   than against an opaque ground, so the scanline themes — `amber-crt`,
   `matrix`, `tron` — will need the overlay clamped or dropped at `glass`.
   Expect this one to need a per-theme escape hatch.
2. **The four light themes** — `paper`, `light`, `newsprint`, `eink`. Acrylic is
   a dark-tinted material; a light theme over it goes grey and muddy, and no
   amount of alpha tuning fixes a tint pulling the wrong direction. Likely
   resolution: cap those four at `frosted`. Note this is *not* the "don't make
   new light modes" rule from the v0.10 doc — these four already exist and just
   need a ceiling.
3. **Terminal double-transparency.** `termBgOpacity` / `termBgBlur` already exist
   in Ctrl+L, `.terminal__pane` already carries a `backdrop-filter`, and
   `allowTransparency` is already on (§3 of the customizer doc — it was a real
   bug once). Terminal alpha now *multiplies* with surface alpha, and the
   terminal can disappear entirely at `glass` + low `termBgOpacity`. Needs an
   explicit compose rule and a line of Settings copy so the two systems visibly
   belong to each other.

## Phase 5 — verification

- `npm test` green, including a new assertion that `solid` resolves to the same
  computed tokens as before the change.
- **By hand: 28 themes × 3 surface levels, over both a bright desktop and a dark
  one.** Same eyes-on discipline `RESUME.md` demanded for v0.10, for the same
  reason — `npm test` is structurally incapable of seeing "muddy". This is the
  bulk of the wall-clock time in the whole project.
- PL/EN labels for the axis in `renderer/i18n.js`, under the existing
  `termcustom.*` key prefix (`:152+`).
- Docs: flip `TERMINAL_CUSTOMIZER_PLAN.md` §4 from "deferred" to shipped and
  point here; update `FUTURE_PLAN.md`'s "Next action" row.

---

## Honest risk register

| Risk | Severity | Handling |
|---|---|---|
| Acrylic misbehaves on this Win11 build | **Kills the plan** | Phase 0 gate, ~30 min, before any real code |
| Acrylic drops when the window is unfocused | Medium | Fall back to `mica`; plan otherwise unchanged |
| A theme looks bad and needs a bespoke override | **Likely — expect at least one** | Per-theme ceiling on `--surface-alpha`; still no colour edits |
| Cold-start white-flash regression | Low, easy to miss | Explicit Phase 1 item, checked on a cold start |
| Estimate for Phase 4 | Unknown | 28 themes is a lot of surface to eyeball; deliberately not estimated |

---

## Progress log

- **2026-09-11** — Plan written, branch `feat/window-transparency` cut from
  `main` at v0.10.0. Phase 0 spike applied and handed to Mati for the eyes-on
  check.
- **2026-09-11, design change** — Transparency became **a theme, not an axis**,
  at Mati's direction. Phases 1 and 2 shipped, Phase 3 rewritten and shipped as
  the `glass` theme. Full suite **1029/1029 green**. `themes.json` **+45 / −0**.
  Remaining: Phase 4's eyes-on pass and the contrast reality-check below.
- **2026-09-11, contrast finding** — The automated 4.5:1 gate measures a theme's
  **opaque** tokens, so it is structurally blind to what transparency actually
  produces. Modelled properly (Win11 acrylic applies a dark tint, so a white
  desktop composites to ~`#4d4d4d` behind the glass rather than to white), Glass
  holds: **12.67:1** body text and **6.49:1** dim text at 62% over the worst-case
  desktop. Worth re-deriving if the alpha ever moves.
- **2026-09-11, spike round 1** — **Acrylic confirmed working.** Mati: *"nothing
  really changes besides the top top tab with lunacore and controlls like x but
  the whole app seems untouched."* The titlebar and window controls picking up
  the material is exactly the non-client area rendering acrylic — so
  `backgroundMaterial` is live and **Phase 0 check 1 passes**. The client area
  stayed opaque because of the `.app` / `--edge` lid documented above, not
  because the mechanism failed. Spike extended to make `.app` transparent.
  Checks 2 (unfocused fallback), 3 (titlebar/corners) and 4 (live toggle via
  Ctrl+Alt+B) still open.
- **2026-09-13, the "glass looks like a normal theme" bug — FOUND AND FIXED.**
  Mati reported glass rendering opaque. It was not acrylic failing: measured
  off the live window, the client area *was* sitting on an acrylic base of
  ~`54,64,71`. **The alpha layers were stacking.** `html/body`, `.app` and
  `.panel` nest, so one shared `--surface-alpha: 62%` composited to
  `1 - 0.38³ = 94.5%` and left 5.5% of the acrylic visible. The arithmetic
  closed exactly: a panel pixel measured `22,29,37` against `19,26,34`
  predicted for three stacked layers over black, versus `9,12,17` for one.
  **Fix:** `--surface-alpha` keeps its headline role but is now only the
  DEFAULT for four absolute per-layer tokens — `--alpha-ground` /
  `--alpha-edge` / `--alpha-panel` / `--alpha-term`. Glass sets ground `0%`
  (nothing left to be the bottom of an opaque stack), edge `30%` (the 1px
  grid gaps stay the most see-through thing on screen), panel `62%`, term
  `55%`. At 100% all four collapse to the old single knob, so `solid` is
  still bit-for-bit. Measured after: panel `22,29,37` → `35,40,46`, terminal
  ground `11,17,22` → `37,42,47`.
- **2026-09-13, xterm was a fifth layer.** The terminal canvas paints its own
  ground from `terminal.background`, stacking on `.panel--center` for
  `1-(1-a)² = 80%`. xterm now paints none while `--alpha-term < 100%`, so the
  pane is the single ground. Note this **subsumes the `termBgOpacity` slider**
  under a see-through theme — the two controls would otherwise fight over the
  same pixel. `nord` is why this is conditional and not universal: it is the
  one theme whose `terminal.background` (`#2e3440`) deliberately differs from
  its `--term-bg` (`#232935`), so a blanket transparent xterm would regress it.
- **2026-09-13, still open.** Phase 0 checks 2 and 3 (unfocused acrylic
  fallback, titlebar/corners) remain eyes-on — automated foreground-activation
  kept losing to the Win11 foreground lock. **The release must renumber to
  v0.12.0**: the other machine shipped v0.11.0 (screenshot paste, auto-proceed
  drop recovery) while this branch was open, and `main` has been merged in.
- **2026-09-13, Phase 4 gets a control surface.** Mati: *"i actually love it
  … i want to mess with opacity transparent lvls."* Four sliders in the
  Settings overlay (Ctrl+L) over `--alpha-ground` / `--alpha-edge` /
  `--alpha-panel` / `--alpha-term`, in `modules/surfacealpha.js`. `null` per
  axis means FOLLOW THE THEME and is the default, so an untouched install
  still renders all 29 themes exactly as authored — verified live: `luna`
  reads `100%` on every axis while an override is active on glass.
  The override is re-applied after every theme switch (the compose-don't-race
  hook in `applyThemeVars`), and "Follow the theme" restores the theme's own
  numbers from a baseline snapshot rather than deleting the token — a plain
  `removeProperty()` would wipe the theme's value too, since both write the
  same inline block. This replaces eyeballing 28 themes against hardcoded
  numbers: the alphas are now tunable at runtime, which is what Phase 4
  actually needed.
- **2026-09-13, the stack had a fifth floor.** Mati screenshotted the top strip:
  *"this panel is not acrylic at all."* Correct, and the same bug one level
  down — `.terminal-bar` and `.tabs` sit INSIDE `.panel--center`, which is
  inside `.app`, so painting them `--surface-panel` made them a THIRD stacked
  ground: measured **90.5%** effective while the terminal beside them was
  see-through. New `--alpha-chrome` / `--surface-chrome` axis for exactly
  those in-pane rows, held lowest of all so the row reads as a TINT over the
  pane rather than a lid on it. Deliberately NOT `--surface-panel-2`: the
  palette, modals and this overlay use that token, and those are places you
  read and type, where the plan already says legibility beats atmosphere.
- **2026-09-13, glass loosened.** *"can we make it more see through… more
  glassy."* edge `30→22%`, panel `62→48%`, term `55→42%`, chrome `20%`.
  Measured: tab bar **0.905 → 0.638**, terminal body **0.548**. Five sliders
  now, and the fifth is the one that was making the chrome look painted on.
- **2026-09-13, clarity becomes a control, and glass becomes a family.**
  Mati wanted the *smear* itself adjustable. It is not: DWM exposes no blur
  radius, so the only real clarity lever Windows gives is WHICH MATERIAL -
  acrylic blurs live content behind, mica only tints the wallpaper (much
  cleaner), tabbed is a stronger mica, none turns the backdrop off. That is now
  a dropdown (`windowMaterial`), applied live through the existing `ui:set`
  write via `setBackgroundMaterial()` - no recreation, no lost scrollback,
  which is why it could be a dropdown and not a restart. Sharp unblurred
  see-through was considered and rejected again: it needs `transparent: true`,
  which is §4's original titlebar blocker.
  Three siblings via `extends: glass`, one axis - how much paint sits between
  you and the backdrop: **Clear** (terminal 0.316), **Glass** (0.548),
  **Noir** (0.600, near-black tint), **Frost** (0.736, cooler and most
  readable). 32 themes, 1079/1079 green.
- **2026-09-13, known UX trap.** Slider overrides are GLOBAL and outrank the
  theme, so switching between the four glass themes changes nothing on any axis
  the user has touched - measured live, all four reported an identical terminal
  stack while an override was active. "Follow the theme" is the way back. Worth
  a visible cue if it bites more than once.
- **2026-09-13, regression: the theme picker went light-on-light.** Mati:
  *"i can choose any mode cause i cant see what is written."* Caused by this
  branch. `.profile-select` painted `--surface-panel-2`, which is now alpha'd,
  and **Chromium only carries a control's background into the OS-drawn dropdown
  list when that background is opaque** - given an alpha it falls back to the
  system LIGHT popup, while the options still inherited our pale `--text`.
  Fixed by painting the control from the OPAQUE `--bg-panel-2` and setting the
  option rows from theme tokens as well. No `color-scheme` declaration to keep
  in sync: the tokens already flip for the four light themes. Verified live -
  `solarized` and `glass` come out light-on-dark, `paper` dark-on-light, all
  three at alpha 1.
  **Rule this establishes: a surface you READ YOUR WAY DOWN stays opaque.**
  Selects join the palette and the modals on that list. Worth auditing anything
  else native-drawn before the release.
- **2026-09-13, CORRECTION - sharp see-through works, and §4's blocker is**
  **wrong on this build.** I had twice told Mati the only clarity lever was
  which material, because DWM exposes no blur radius. Half right. A spike with
  a 20px black/white STRIPED backdrop (flat white cannot distinguish "blurred"
  from "sharp" - that is why the earlier flat-white tests kept reading as
  inconclusive) measured stripe contrast through four window configs:

  | config | stripe contrast | verdict |
  |---|---|---|
  | `transparent: true` **with frame** | 164 | sharp |
  | `transparent: true` + `frame: false` | 164 | sharp |
  | `backgroundMaterial: 'none'` | 164 | **sharp** |

  Two things follow. **(1) `none` does not mean "no backdrop", it means NO
  BLUR** - a clear pane onto the sharp desktop, native titlebar intact, and it
  was already in the dropdown, mislabelled by me as "no system backdrop".
  **(2) §4's premise that `transparent: true` costs the frame on Windows did
  not hold here** - the framed transparent window rendered sharp too. Not
  needed now that `none` does the job, but the deferral it justified should not
  be quoted as fact again without a re-test.
  The dropdown is now ordered as a real clarity axis - acrylic, tabbed, mica,
  clear - with `auto` last, since it is an abdication rather than a point on
  the scale.
- **2026-09-13, bug: `windowMaterial` was write-only.** The select kept reading
  `acrylic` while the prefs file said `none`. `readUiPrefs()` builds an EXPLICIT
  allowlist rather than spreading DEFAULTS, and the new key was added to
  DEFAULTS and to `writeUiPrefs()` but not there - so it round-tripped to disk
  and read back `undefined`, which also meant `createWindow()` was being handed
  `backgroundMaterial: undefined` on every start. Silent, because every
  consumer just sees a missing option. Fixed on the read path, and pinned with
  a test that fails on ANY undefined value coming out of `readUiPrefs()` rather
  than on this one key - the next person to add a pref gets caught by it too.
- **2026-09-13, the white flash-out, and what it says about `none`.** Mati:
  *"it worked for a second then it became like white mode."* The PAGE was fine
  throughout - dark theme, light text, panels at 66% dark, checked live. The
  white came from UNDER it: an alpha `backgroundColor` on a window that is not
  declared transparent leaves the base UNDEFINED. DWM holds a transparent
  surface while a material is painting, and Chromium falls back to its default
  WHITE when one is not - so `none` is a coin-flip, not a mode. It is total
  rather than subtle because `--alpha-ground: 0%` means the page paints nothing
  over the base. **My earlier spike caught `none` in the good moment and I
  generalised a mode out of it.**
  Fix: `transparent: true` on the window, unconditionally (it is
  construction-time only, so it cannot follow the dropdown). That gives the
  base a DEFINED value instead of a fallback, and the same spike had already
  shown it renders sharp WITH the frame. Measured after: panel pixels
  `34,37,61` held flat across 13s with the window unfocused, carrying the
  wallpaper's violet cast - no white at any point.
  **Still eyes-on: whether the native titlebar, rounded corners and snap
  layouts survive `transparent: true`.** That is Phase 0 check 3, and it is now
  load-bearing rather than incidental - if the frame suffers, §4's original
  objection comes back and the fallback is to drop `none` from the dropdown and
  keep only the blurred materials.
- **2026-09-13, "Clear pane" CUT. There is no stable sharp see-through on this**
  **build.** Mati pinned the trigger: *"works perfectly on launch but then on
  launch it goes white… when changing to another glass mode."* A theme switch
  forces a full repaint, and with no DWM material holding the window surface
  transparent the repaint lands on Chromium's default WHITE - total, because
  `--alpha-ground: 0%` means the page paints nothing over the base.
  `transparent: true` was tried first and did NOT hold it, so the option is
  removed rather than shipped as a coin-flip - and removing it also lifts the
  risk that declaring the window transparent had put on acrylic and mica, which
  never needed it.
  `none` is absent from `WINDOW_MATERIALS` rather than merely hidden in the UI,
  so a prefs file still carrying it fails validation and migrates to the
  default on next read (verified: a stored `none` now reads back `acrylic`).
  **Standing correction to the two entries above: `none` renders sharp only
  while DWM happens to still be holding the surface. The striped-backdrop spike
  measured a real moment, not a mode. A spike proves a mechanism CAN work; only
  use over time proves it HOLDS.**
  What survives is the honest range: acrylic, tabbed, mica, auto - three
  genuinely different amounts of smear, all stable, plus the five sliders for
  how much shows through. Verified across seven theme switches including out to
  an opaque theme and back.
