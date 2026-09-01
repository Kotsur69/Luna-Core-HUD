# LunaCore — Fluidity & Theming (v0.10.0)

Plan doc for the update Mati asked for on 2026-08-27: *"whole app has to have more
fluidity like folding in folding out animations, more templates, more schemes."*

Branch: `feat/fluidity-theming` → one `v0.10.0` release at the end.

---

## RESUME HERE — state as of 2026-08-27, end of day

Written because the work moves to a different machine and the work PC will be
off for a week, so the session transcript on it is unreachable. Everything
needed to pick this up cold is in this section, in the repo, on the branch.

> **Start at [`RESUME.md`](RESUME.md)**, not here. That file is the operational
> entry point — what to do first, how to run it, what to actually look at, and
> the environment gotchas. This section is the design record: the locked
> decisions and what each phase landed. Decisions live here and only here.

### Decisions already locked (do not re-ask)

| Question | Answer |
|---|---|
| Stack | **Stay dep-free, port patterns by hand.** shadcn/Radix as an *interaction reference* only — no React, no Tailwind, no bundler, strict CSP, `file://` |
| Templates | More presets **+ a user layout builder** (save/rename/delete) |
| Schemes | **Modifiers + more themes** — modifier axes × 8–10 new themes |
| Motion scope | **All four**: theme/density crossfade · overlay enter *and* exit · list row add/remove/reorder FLIP · fold polish + icon rails |
| Token depth | **Full scale extraction** — every hardcoded px onto `--space-*`/`--fs-*`, drift-guarded |
| Theme vibe | Neon/sci-fi HUD + Seasonal/high-concept + Calm professional (IDE-like). **Verbatim: "dont make new 'light' modes"** |
| Transparency (§10.7) | **Out** — stays its own future project |
| Workflow | Feature branch, **one** `v0.10.0` release, phase-by-phase commits, **check in with Mati after each phase** |

### Phase 1 — DONE, committed (`e9fd3b0`)

Space + type scales driven by a density multiplier. 212 declarations moved onto
the scales, 0 unmapped. New drift guard in `test/theme.test.js` fails on any px
literal in a scaled property outside `:root`. 852 tests green.

Two things still owed on it:

* **Needs an eyeball at `npm start`.** Normalizing 15 type sizes → 10 and 14
  spacing values → 9 moves some elements by half a pixel (9.5→9, 15→14, 3→2,
  7→6). Deliberate, but unverified visually — nobody has looked at it yet.
* **Two open Impeccable hook findings, both on pre-existing lines**, deliberately
  NOT suppressed: `var(--ease-bounce)` (flagged "dated"; it is a documented token
  used sparingly for arm/confirm) and C2's `transition: height` fold (deliberate,
  shipped, measured; §0 of this plan excludes re-opening it). Suppressing either
  needs Mati to say so.

### Phase 2 — DONE, committed (`bd4284e` + `d27e6fa`)

The four modifier axes, end to end. 869 tests green.

| Axis | Values | Mechanism |
|---|---|---|
| Density | comfortable · **cozy** · compact · dense | `--density-space` / `--density-text` at `1.15/1.05`, `1/1`, `0.85/0.95`, `0.72/0.9` |
| Font pack | **per theme** · mono · display · system | Overrides the three `--font-*`; bundled faces only, no network |
| Glow | **full** · reduced · off | Scales `--glow-size*`, `--text-glow`, `--shadow-panel` |
| Motion | **full** · reduced · off | Scales the four `--dur-*`, `--stagger`, `--lift`, `--press-scale` |

Bold is the default, and every default is the no-op value: an existing install
renders exactly as it did before v0.10, and `modifiers.js` writes no attribute
at all until someone changes something.

Files: `styles.css` (the `MODIFIERS (v0.10)` block + a rewritten
`prefers-reduced-motion` block), `src/uiprefs.js` (`clampModifierPrefs`),
`modules/modifiers.js` (**new**), `modules/termcustom.js`, `renderer.js`,
`index.html`, `i18n.js`, `test/modifiers.test.js` (**new**), `test/uiprefs.test.js`.

**Not visually verified.** Same standing caveat as phase 1: the axes are
test-green and the tokens resolve, but nobody has opened `npm start` and
actually looked at `dense`, the font packs, or `glow: off` on a neon theme.
That is the first thing to do at the next sitting, before phase 3 builds on it.
### Why the modifier CSS uses `!important` everywhere

Not sloppiness — it is the only mechanism available. `applyThemeVars()` writes
theme tokens as **inline styles** on `<html>`; normal author rules lose to an
inline style at any specificity, and the important-author tier is the one thing
in the cascade above it. Precedence bought, deliberately:
`:root` defaults → theme vars (inline) → modifier blocks.

The same change fixed a **real pre-existing bug**: the `prefers-reduced-motion`
block was written before C3 let themes reach the motion tokens, so on the 12 of
18 themes that set `--dur-fast`/`--dur-normal` it had been silently doing
nothing. It is now `!important`, and its selector list carries
`:root[data-motion]` so that an OS accessibility setting still out-ranks the
in-app motion preference.

### Phase 3 — DONE, committed (`f39e7ea` + `1bb5309` + `62b2ae8`)

The motion layer, all four items. 916 tests green (+47 over phase 2).

| Item | Landed as |
|---|---|
| 3.1 Theme / density crossfade | `modules/motion.js` (**new**) — `crossfade()` over `document.startViewTransition()`, feature-detected, terminal opted out |
| 3.2 Overlay exit | `closeWithExit()` / `cancelExit()` on all six overlays; **enter untouched** |
| 3.3 List row enter / move / leave | `modules/flip.js` (**new**) — keyed FLIP across six lists |
| 3.4 Fold direction + region rail | `FOLD_EXIT_SCALE`, and `[data-railed]` collapse-to-glyphs in `panels.js` |

Four things worth knowing before touching any of it:

* **The terminal's view-transition name goes on `#terminal`, not `.xterm`.** A
  name must be unique in the document and tabs mean several `.xterm` exist. It
  is excluded at all because a view transition shows *snapshots*, and
  cross-dissolving two snapshots of a canvas mid-write is how you get a torn
  line frozen on screen for a third of a second.
* **`flip.js` measures against the list's own content box, not the viewport.**
  `sessiontimeline` auto-scrolls to the newest turn on every render; in viewport
  coordinates that reads as "every marker moved" and FLIP would faithfully
  animate a slide that never happened.
* **The rail is a *view* over the widths, never a width.** `layoutSizes` always
  holds the UNRAILED columns; the 44px track is derived at apply time from
  `railedRegions`. Every write goes through `commitTracks()`. Break this and
  un-railing has nothing to restore.
* **`EXIT_RATIO` (motion.js) and `FOLD_EXIT_SCALE` (panels.js) are both 0.65 and
  deliberately NOT shared.** Two different gestures that happen to agree.

Two items the plan named that this deliberately does not do, and why:

* **`todo.js` got no FLIP.** It already has bespoke drag-reorder motion
  (`TODO_DRAG_REORDER_PLAN.md`); a second animation system on top of a live
  pointer gesture would fight it for the same transform.
* **`skilltracker` got no FLIP.** It turned out to have no list at all — it
  toggles classes on a fixed set of tiles. The plan assumed otherwise.

**Still not visually verified.** The caveat from phases 1 and 2 now covers this
one too, and it has grown: nobody has run `npm start` and looked at the
sub-pixel normalization, the four axes, the theme crossfade, the overlay exits,
the list motion, or the rail. Everything is test-green and every token resolves,
but *none of it has been seen*. That is the first thing to do at the next
sitting, before phase 4 builds on top.

### Phase 4 — DONE, committed (`f46d5c6` + `9ff0800` + `de17ba5` + `91fd999`)

Five presets, plus the builder: save the arrangement on screen under a name, then
rename, duplicate, delete. `customLayouts` in `ui.local.json`, merged by
`loadLayouts()`.

Three decisions that departed from what this section originally said:

* **The merge happens in MAIN, not in the renderer's `getLayouts()`.**
  `normalizeLayout()` is the only thing that knows the deep rules, and it is CJS
  in main — merging renderer-side would mean a second validator that has to agree
  with the first forever. `loadLayouts()` already had a `collect(src)` pipeline,
  so custom is a third source and `modules/layout.js` changed not at all.
* **`zen` ships as a thin side region, not auto-hiding.** Auto-hide is behaviour,
  not data, so 4.1 could not deliver it; today the 3.4 rail collapses it by hand.
  Still open if Mati wants the real thing.
* **Folds are not stored in a saved layout.** `collapsed` is global rather than
  per-layout and already survives a layout switch, so recording it would mean a
  saved layout silently re-folding panels the user had opened since. Rails ARE
  carried over, by copying `railedRegions` to the new id rather than adding a
  field to the spec.

Two things worth knowing before touching this code again. `normalizeLayout` now
carries a `custom` flag, and `widgetarrange.js` uses it to append widgets a saved
layout places nowhere — without that, a layout freezes the widget list as it stood
the day it was saved and a widget added later would be invisible in it forever.
And a preset must give each RAILABLE region a column of its own; `stacked` was
written single-column first and two existing tests caught it.

### Phase 5 — DONE, code + audit. Phase 6 unstarted

Ten new dark themes, all three families the plan named, plus the contrast audit
it asked for. `npm test` → **982 pass, 0 fail**.

| Family | Shipped |
|---|---|
| Neon / sci-fi HUD | `eva-01` (0 radius, 2px borders, 4.5px tracking, purple + EVA green), `tron` (mono everywhere, 0 radius, cyan grid texture, no lift/press), `holo` (30px glow, soft 12px radius, slow smooth motion), `luna` (moon-silver on ink — the namesake finally has a theme) |
| Seasonal / high-concept | `aurora` (green→violet gradient texture, 14px radius, 800ms slow), `abyss` (5px glow, no text-glow, heavy radial vignette, 900ms), `magma` (basalt + ember, warm `--bad: #ff6b3d`) |
| Calm / professional | `catppuccin-mocha`, `rose-pine`, `everforest-dark` — all `--glow-size: 0`, `--text-glow: none`, `--case-title: none`, radius 12–14px |

That last family is the point of the phase: 14 of the 18 pre-v0.10 themes were
neon, so a long session had nowhere quiet to sit. All three turn the glow off at
the token layer rather than picking duller colours, which is exactly what C3's
vocabulary exists for.

**The audit came back better than this plan predicted.** It expected 1–2 existing
themes to fail 4.5:1 on body text; **none did** — the worst was `tokyo-night` at
9.63:1. The real gap was `--text-dim`, which nothing had ever checked:

* `tokyo-night` `#787c99` → `#8b90b5` (3.81:1 → 5.00:1)
* `void` `#6e6e6e` → `#7d7d7d` (4.12:1 → 5.10:1)

Held to 4.5:1 rather than 3:1 on purpose: 3:1 only ever covered large type and UI
chrome, and a HUD's metadata rows are neither. Both were lifted with headroom
instead of to the bare minimum, so a later half-step nudge does not re-break them.

Five tests were added to `test/theme.test.js` — the WCAG helper's own reference
anchors, a parse-coverage guard (so a theme written in `oklch()` fails loudly
instead of silently opting out of every contrast check), text-on-surfaces,
terminal foreground-on-background, and the light-group ordering below.

**Also done, asked for mid-phase:** *"segregate light modes so every light mode
i mean the whites would be on the bottom and rest from the top"*. The picker
renders in `themes.json` array order (`appearance.js` walks the Map's insertion
order), so this was a pure data reorder — `paper` and `light` had been sitting
mid-list. Now 24 darks, then the 4 lights. A test measures the group boundary by
`--bg` luminance rather than listing ids, so a new theme lands in the right group
without anyone remembering to update an array; the darks top out at 0.026 and the
lights start at 0.694, so the 0.5 threshold is nowhere near delicate.

**Not yet seen running** — same standing caveat as phase 4. See RESUME.md for the
walkthrough.

See the phase sections below — written out in full and unchanged.

### House rules that bit us this session

* **Never `git add -A`.** A concurrent Claude session shares this git index; at
  the time of writing the tree also holds `.gitignore`, `config/profiles.json`,
  `setup.md`, `.env.luna.example` and six `scripts/*` files that belong to it.
  Commit explicit paths only.
* Comments in English always, but do **not** touch the `pl`/`en` values in
  `src/localized.js`, `src/renderer/i18n.js`, `modules/localize.js`, or the
  `data-i18n*` fallbacks in `index.html` — those are genuine UI text.

---

## 0. What this is NOT

This is the point where `FUTURE_PLAN.md`'s **§2.3 "Presets beyond colour"** finally
gets built. It was written in July, deferred on 2026-08-05 (*"lets scratch the
animations and templates work and lets proceed to make this as a working
product"*), and everything that deferral was protecting has since shipped —
`v0.9.0` through `v0.9.6`, installer, auto-update, 678 tests. The fun stuff is
now the work.

So the honest framing: **most of what the request names already exists.**

| Asked for | State before this plan |
|---|---|
| "folding in folding out animations" | **Built.** C2, height-animated per widget, persisted per widget id — `panels.js` + `styles.css` §C2 |
| "more templates" | 4 layout presets, data-driven, live-switchable, staggered region enter |
| "more schemes" | 18 themes over a ~45-token vocabulary (colour, radius, type, glow, texture, motion) |
| "more fluidity" | Motion tokens (4 durations, 3 curves, `--stagger`, `--lift`, `--press-scale`), reduced-motion at the token layer, 16 keyframes |

The update is therefore **not** "add animations". It is the four things that
vocabulary cannot currently express, plus the two axes §2.3 promised and never
delivered. Anything that would only re-do shipped work is out.

**Explicit non-goals:**

- **No React, no Tailwind, no bundler, no shadcn components.** Decided
  2026-08-27. shadcn is React + Tailwind + TS; this renderer is vanilla ES
  modules over `file://` under a strict CSP with no build step. shadcn/Radix are
  used here as an *interaction reference* to hand-port, nothing more. Adding a
  build step would mean rewriting the widget contract (§A2a) and most of 678
  tests to buy components this app cannot load.
- **No new light themes.** Mati, 2026-08-27: *"dont make new 'light' modes."*
  The four that exist (`paper`, `light`, `newsprint`, `eink`) stay; every new
  theme is dark.
- **No whole-app OS transparency.** §10.7 stays its own project — frameless
  window + custom titlebar + window-recreation-on-toggle + a rework of every
  theme's backgrounds is a release of its own and would swallow this one.
- **No retro/CRT theme family.** Not picked. The texture axis is already carried
  by `matrix` and `amber-crt`.

---

## 1. Motion doctrine

Per the motion skill's context mapping, LunaCore is a **productivity tool**:
primary lens **Emil Kowalski** (restraint, speed, "should this animate at all"),
secondary **Jakub Krehel** (production polish, invisible enhancement). Jhey's
playful register is wrong for a thing that sits open all day next to a terminal.

The frequency gate, applied to LunaCore's actual interactions — this is what
decides each item below, and it is why two of the four requested motion areas
get *less* motion rather than more:

| Interaction | Frequency | Verdict |
|---|---|---|
| Theme switch | Rare | **Animate.** Crossfade earns its 300ms — this is the one place a transition carries meaning. |
| Density / font-pack switch | Rare | **Animate**, same path as theme. |
| Layout preset switch | Rare | Already staggered. Leave it. |
| Panel fold / unfold | Occasional | Already animated. **Polish easing only**, do not lengthen. |
| Overlay open (Ctrl+K / Ctrl+L / Ctrl+G) | Frequent **and keyboard-initiated** | Emil: *never animate keyboard-initiated*. **Do not add enter motion.** The bug is the missing *exit* — elements vanish. Add a fast exit (~120ms), shorter than the enter. |
| List row add / remove | Occasional, not user-initiated | **Animate**, subtly. Rows currently pop; the pop is what makes the HUD read as a printout. |
| Row reorder (todo drag) | Occasional | Already FLIP. **Generalize the helper**, don't re-do the feature. |
| Hover / press | Constant | Already token-driven (`--lift`, `--press-scale`). Leave it. |
| Terminal output | Constant | **Never.** |

**Accepted deviation from the skill's anti-checklist.** The cookbook says no
looping pulses (`.dot--live`, `.led--working`, `afile-pulse`, `skill-sweep`).
Those stay: in a HUD a blinking indicator *is* the state readout, not an
attention grab, and each already has an explicit reduced-motion substitution
(`styles.css` §1097-1103, §1248-1250). They are functional motion under the
skill's own functional/decorative test.

**Rules every animation in this update follows:**

1. `transform` / `opacity` / `filter` only. The one exception is C2's existing
   `height` fold, which is already built and measured — not re-opened.
2. Transitions, not keyframes, for anything re-triggerable (Emil §11:
   keyframes cannot retarget mid-flight).
3. Enter uses `--ease-smooth`; exit uses `--ease-sharp` at ~60-70% of the enter
   duration (Jakub: the user's attention has already moved on).
4. Never start from `scale(0)` — `0.96` minimum.
5. Origin-aware: overlays scale from their trigger, not from centre.
6. No new hardcoded duration or curve. Ever. `styles.css` §156 already calls a
   hardcoded `0.3s` "the same class of bug as a hardcoded colour"; that holds.
7. Reduced motion is handled at the token layer and must stay that way — a new
   animation that needs its own `@media` block is a design smell to fix, not to
   exempt.

---

## Phase 1 — The scale layer (the enabler)

**Why first:** density is impossible today. `--pad-panel` and `--panel-gap` are
the only spacing tokens; everything else is literal px, so a `--density`
multiplier would reach about 4% of the HUD. The audit:

| | Distinct values | Declarations |
|---|---|---|
| `font-size` | 15 (9 → 40px, incl. 9.5 / 10.5 / 11.5) | 97 |
| `padding` px | 14 (1 → 22px) | 108 |
| `gap` | 12 (1 → 22px) | 67 |

**Deliverable:** two scales in `:root`, both density-driven.

```css
/* Space - 9 steps, normalized from the 14 values in use. */
--space-1: calc(2px  * var(--density-space));
--space-2: calc(4px  * var(--density-space));
--space-3: calc(6px  * var(--density-space));
--space-4: calc(8px  * var(--density-space));
--space-5: calc(10px * var(--density-space));
--space-6: calc(12px * var(--density-space));
--space-7: calc(14px * var(--density-space));
--space-8: calc(16px * var(--density-space));
--space-9: calc(22px * var(--density-space));
--space-hair: 1px;   /* grid lines and hairlines - deliberately NOT scaled */

/* Type - 10 steps. max() floors it so `dense` cannot make a label unreadable. */
--fs-3xs:  max(9px,  calc(9px  * var(--density-text)));
--fs-2xs:  max(9px,  calc(10px * var(--density-text)));
--fs-xs:   max(10px, calc(11px * var(--density-text)));
--fs-sm:   max(10px, calc(12px * var(--density-text)));
--fs-md:   max(11px, calc(13px * var(--density-text)));
--fs-base: max(12px, calc(14px * var(--density-text)));
--fs-lg:   max(13px, calc(16px * var(--density-text)));
--fs-xl:   max(14px, calc(18px * var(--density-text)));
--fs-2xl:  max(16px, calc(22px * var(--density-text)));
--fs-3xl:  max(24px, calc(40px * var(--density-text)));
```

**The one visual change this makes, stated up front:** normalizing 15 type sizes
to 10 moves a handful of elements by half a pixel (9.5→9, 10.5→10, 11.5→11,
15→14, 24→22), and 14 spacing values to 9 rounds 3→2, 5→6, 7→6, 9→10. That is
the *point* of a scale, but it is a real (tiny) change to the current look and
should be eyeballed once at `npm start` before Phase 2 builds on it.

`--space-hair` not scaling is deliberate: `.app { gap: 1px }` is the panel
border, and a 0.72px border on `dense` renders as a grey smear.

**Files:** `src/renderer/styles.css` (the mechanical pass), `src/theme.js`
(`KNOWN_TOKENS`), `test/theme.test.js`.

**Test (the thing that keeps this honest):** extend the existing drift guard so
it fails on any `font-size:`, `padding:`, `gap:` or `margin:` px literal outside
the `:root` block, with a small allowlist for genuine one-offs. Without it the
scale rots back into literals within three features — the same reasoning that
made `KNOWN_TOKENS` drift-guarded in the first place.

**Done when:** `npm test` green, `--luna-probe` clean, HUD renders identically
apart from the sub-pixel normalization above.

---

## Phase 2 — Modifiers: density, font pack, glow, motion

Four axes that multiply across all 18 themes (and every future one) instead of
adding to them. This is §2.3, finally.

| Axis | Values | Mechanism |
|---|---|---|
| **Density** | comfortable · cozy (default) · compact · dense | `--density-space` / `--density-text` pairs: `1.15/1.05`, `1/1`, `0.85/0.95`, `0.72/0.9` |
| **Font pack** | Per theme (default) · JetBrains Mono · Chakra Petch · System · Terminal-only-mono | Overrides `--font-ui` / `--font-display` / `--font-mono`; already-bundled faces only, no network |
| **Glow** | full · reduced · off | Scales `--glow-size*`, `--text-glow`, `--shadow-panel` |
| **Motion** | full · reduced · off | Scales the four `--dur-*` plus `--lift` / `--press-scale` — an **in-app** control, independent of the OS `prefers-reduced-motion` path, which stays |

All four are token-only, so they compose with any theme and cost every future
theme nothing. Applied as `data-*` attributes on `documentElement` with the
token overrides living in `styles.css`, *not* as JS-written inline styles —
inline would fight `appearance.js`'s `applyThemeVars()` bookkeeping, which
removes tokens the outgoing theme set.

**Precedence** (must be documented in the file, it is the first thing that will
confuse someone): `:root` defaults → theme `vars` (inline, from JSON) →
modifier `data-*` blocks. Modifiers deliberately win over themes so a theme
authored with heavy glow still respects "glow: off".

**UI:** the Settings overlay (Ctrl+L, `termcustom.js`) — it is already the home
for terminal/sound/boot knobs, and `appearance.js` was deliberately decluttered
down to theme/layout/language on 2026-08-13. Do not re-clutter the left rail.

**Persist:** `ui.local.json` via `src/uiprefs.js`, validated as a whitelist of
ids like every other pref (reject-don't-repair).

**Files:** `styles.css`, `src/uiprefs.js`, `src/renderer/modules/termcustom.js`,
`src/renderer/modules/appearance.js`, `src/renderer/i18n.js` (PL/EN labels),
`test/uiprefs.test.js`, new `test/modifiers.test.js`.

---

## Phase 3 — The motion layer

Four items, each justified by the frequency gate in §1.

### 3.1 Theme / density crossfade

The single most visible "not fluid" moment: switching theme slams ~45 tokens in
one frame. Electron 43 is Chromium 13x, so **the View Transitions API is
available** — `document.startViewTransition()` gives a real cross-dissolve of
the entire HUD with no snapshot machinery, no dependency, and nothing for the
CSP to block. Feature-detected, with the current instant swap as the fallback
path.

```js
if (!document.startViewTransition) { applyThemeVars(theme); return; }
document.startViewTransition(() => applyThemeVars(theme));
```

Tuned via `::view-transition-old/new(root)` to `--dur-normal` / `--ease-smooth`.
Terminal excluded (`view-transition-name: none` on the xterm root) — snapshotting
a live canvas mid-write is exactly the kind of thing that produces a torn frame.

### 3.2 Overlay exit

Palette, Settings, git quick-menu, diff viewer, timeline preview all animate in
(`palette-in`) and then simply cease to exist. Add a shared
`closeWithExit(el, done)` helper: `opacity → 0`, `scale(0.98)`, `--dur-fast`
× 0.65, `--ease-sharp`, `transitionend`-driven with a timeout fallback.

**Enter stays exactly as it is.** These are keyboard-triggered and frequent;
Emil's rule is explicit, and the existing 180ms enter is already at the edge of
what is defensible.

Also: `transform-origin` on the palette so it scales from the chip that opened
it rather than from the middle of the screen.

### 3.3 List row enter / exit / reorder

Generalize the FLIP already shipped for todo drag (`TODO_DRAG_REORDER_PLAN.md`)
into `src/renderer/modules/flip.js` — a pure `measure → apply → play` helper with
no DOM at module scope, so it is `require()`-able from a plain CJS test like
`panels.js` and `widgetarrange.js` are.

Applied to the list builders that currently pop: `ports`, `activefiles`, `mcp`,
`sessiontimeline`, `git`, `skilltracker`. Enter is Jakub's recipe (opacity +
6px translateY + 2px blur); exit is opacity only. Capped — a list re-rendering
40 rows animates the first ~12 and the rest appear instantly, because a
40-row stagger at 45ms is 1.8s of nonsense.

### 3.4 Fold polish + collapse-to-rail

- Retune the existing fold: it is correct but linear-feeling. Exit shorter than
  enter, per §1 rule 3.
- **New: collapse a whole region to an icon rail.** This is the `focus` preset's
  original promise in `FUTURE_PLAN.md` §3.2 (*"panels collapse to a thin icon
  rail, terminal reclaims the space"*) — C2 shipped per-widget folding but never
  the per-region rail. A region collapses to ~40px showing one glyph per widget;
  clicking a glyph expands the region and scrolls that widget into view.
  Persisted per layout id alongside C2's column widths.

**Files:** `appearance.js`, `palette.js`, `termcustom.js`, `gitquick.js`,
`filediff`-side module, `panels.js`, `layout.js`, new `modules/flip.js`,
`styles.css`; `test/flip.test.js`, `test/panels.test.js`.

---

## Phase 4 — Templates

**4.1 New presets** (data only, `config/layouts.json`) — the two §3.1 sketched
and never built, plus three that earn their place on real hardware:

| id | Shape | For |
|---|---|---|
| `left-only` | everything left, terminal fills the rest | muscle memory / one-handed |
| `cockpit` | narrow rails both sides + a bottom strip | maximum instruments visible |
| `ultrawide` | 4 columns, terminal centre-left | 34"+ monitors |
| `stacked` | terminal top, two widget rows below | vertical / portrait displays |
| `zen` | terminal only, one thin auto-hiding rail | screenshots, demos, deep work |

**4.2 Layout builder** — save the current arrangement (columns from C2's
splitters, widget placement from C4's drag, folds, region rails) as a **named
custom layout**. Rename, duplicate, delete. Stored under a new `customLayouts`
key in `ui.local.json`, merged over the bundled presets by `layout.js`'s
existing `getLayouts()`, healed the same way `widgetarrange.js`'s
`effectiveSlots()` already heals a stale slot map (drop unknown widgets, append
new ones, pin `terminal`).

Caps mirror the existing ones in `uiprefs.js` (`MAX_ARRANGED_LAYOUTS` etc.) —
a hand-editable JSON file gets a whitelist, not a parse.

**Files:** `config/layouts.json`, `src/uiprefs.js`, `modules/layout.js`,
`modules/appearance.js` (the picker), `i18n.js`, `test/layouts.test.js`,
`test/uiprefs.test.js`.

---

## Phase 5 — Themes

8-10 new **dark** themes across the three families Mati picked. Every one is a
`{ id, label, vars, terminal }` entry in `config/themes.json`, and every one must
use the full C3 vocabulary — radius, typography, glow, texture, motion — not just
swap 15 hexes. §C1b is explicit about why: *"every theme looks like the same HUD
in a different hue"* is what the 45-token vocabulary exists to prevent.

| Family | Candidates |
|---|---|
| Neon / sci-fi HUD | `eva-01` (purple/green, chamfered, heavy tracking), `tron` (cyan on near-black, 0 radius), `holo` (pale blue, high glow, low texture), `luna` (moon-silver on ink — the app's own namesake, and it does not have a theme) |
| Seasonal / high-concept | `aurora` (green→violet gradient edges), `abyss` (deep-sea teal, near-zero glow, heavy vignette texture), `magma` (basalt + ember, warm `--bad`) |
| Calm / professional | `catppuccin-mocha`, `rose-pine`, `everforest-dark` — low glow, flat, `--radius` up, for long sessions. This family is the gap: 14 of the 18 existing themes are neon. |

Each ships a matching xterm ANSI palette (the `terminal` block), and each is
checked for **4.5:1 body-text contrast** against its own `--bg-panel` — the
existing 18 were never audited for this, so Phase 5 also adds a contrast check
to `test/theme.test.js` that runs over every theme, old and new. Expect it to
flag one or two of the existing ones; fixing those is in scope.

---

## Phase 6 — Release

`README.md` (theme/layout/modifier tables + the download table), `FUTURE_PLAN.md`
START-HERE box, `package.json` + lockfile to `0.10.0`, merge to `main`, tag,
publish. Per memory: batch the commits, one build at the end — not a build per
bump.

---

## Verification, every phase

```bash
npm test                         # must stay green, count only goes up
npx electron . --luna-probe      # equal subscriber counts, rows: 1
npm start                        # the only way to check anything interactive
```

Plus, specific to this update, a manual pass that automation cannot do:

- Every modifier combination against at least 3 themes (density × glow × motion).
- **Reduced motion on** — every new animation must degrade to an instant, legible
  state change, not to a frozen half-state.
- The `dense` preset at the smallest window size the app allows.
- Theme crossfade with the terminal actively printing (§3.1's torn-frame risk).

---

## Order and why

1 → 2 → 3 → 4 → 5 → 6, and the dependency is real, not bookkeeping: Phase 2's
density does nothing without Phase 1's scale, and Phase 3.1's crossfade is the
transition Phase 2's switches ride on. Phases 4 and 5 are independent of each
other and could swap.

Check in with Mati after each phase.
