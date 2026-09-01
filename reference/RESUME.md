# RESUME — v0.10 fluidity & theming

Operational hand-off for the `feat/fluidity-theming` branch. Read this first,
then `FLUIDITY_THEMING_PLAN.md` for the design record and the locked decisions
(they live there, not here — one copy, no drift).

Last updated: 2026-08-31. Phases 1–3 done AND verified in a running app; phases
4 and 5 done and test-green but NOT yet walked; 6 unstarted.

---

## Where things stand

Branch `feat/fluidity-theming`, pushed. **Phase 6 doc pass done 2026-08-31**:
`package.json` + lockfile are at **`0.10.0`** (which also closed a pre-existing
drift - the lockfile had been left at `0.9.5` while `package.json` said `0.9.6`),
and README + FUTURE_PLAN are current for v0.10. What is deliberately NOT done:
**merge, tag, build, publish** - all four wait on the walkthrough below, because
an unseen release is the one thing `npm test` cannot clear.

```
91fd999  feat: wire the layout builder into Appearance     (4.2 complete)
de17ba5  feat: the layout builder's pure half              (4.2, WIP)
9ff0800  feat: saved layouts stored and loaded             (4.2, data half)
f46d5c6  feat: five more layout presets                    (4.1)
bbd6a4c  docs: record the phase 1-3 walkthrough as done
5a6ad6a  docs: mark phase 3 done, point at phase 4
62b2ae8  feat: fold direction + collapse a column to a rail   (3.4)
1bb5309  feat: keyed list motion                              (3.3)
f39e7ea  feat: crossfade theme/density, animate overlays out  (3.1 + 3.2)
4a4b393  docs: mark phase 2 done
d27e6fa  feat: wire the modifier axes into Settings           (phase 2)
bd4284e  feat: modifier axes                                  (phase 2, WIP)
e9fd3b0  feat: space + type scales on a density multiplier    (phase 1)
```

`npm test` → **982 pass, 0 fail**, ~1.1s. `npm start` runs the app.

---

## DONE: walked in a running app, 2026-08-31

Every line below was checked by Mati against a live app, in the order written,
and **all of it passed** — no artifact, no stall, nothing to fix. This was the
branch's single biggest risk (three phases test-green that no one had watched
run); it is now spent. Phase 4 is unblocked.

Two things were confirmed from outside the app rather than by eye:

- `config/ui.local.json` gained its `railedRegions` key, so the persistence
  path in 3.4 really did fire.
- `layoutSizes` still held the unrailed widths afterwards, with `44px` nowhere
  in it — the invariant in note 3 below, verified rather than assumed.

Kept ticked rather than deleted: this is the record of what the pass covered,
and phase 4 edits the same grid-track code, so it doubles as the regression
list to re-walk when 4 lands.

**Phase 1 — the scales**
- [x] Nothing looks misaligned. The normalization moved some elements by half a
      pixel on purpose (9.5→9, 15→14, 3→2, 7→6); look for anything that now
      reads as off-by-one rather than merely tighter.

**Phase 2 — the four axes** (Ctrl+L → *Interface*)
- [x] `dense` — is the HUD still readable, or did something collapse?
- [x] each font pack — `mono`, `display`, `system`. All bundled, no network.
- [x] `glow: off` on a neon theme (`cyberpunk`) — is the glow actually gone?
- [x] `motion: off` — everything below should become instant, not janky.

**Phase 3.1 — crossfade**
- [x] Switch theme (left Appearance panel). The whole HUD should *dissolve*.
- [x] **Watch the terminal while it does.** It must NOT freeze, tear, or
      double-print. It is excluded from the transition on purpose; if it
      misbehaves, the `#terminal` view-transition-name is the thing to look at.
- [x] Switch density with the terminal streaming output. Same check.

**Phase 3.2 — overlay exit**
- [x] Ctrl+K then Esc. Ctrl+L then Esc. A file in Active Files, then Esc.
      Each should fade and retreat, not vanish.
- [x] Esc then *immediately* reopen the same overlay. It must stay open — that
      is `cancelExit()`; if it blinks shut a beat later, that call is missing.
- [x] Close the file-diff modal: the text must not blank before it fades.

**Phase 3.3 — list motion**
- [x] Leave the ports list alone through a rescan. It must be **completely
      still**. Any blink means a key is wrong or missing.
- [x] Add/remove a repo so the git list changes — rows should slide, not jump.
- [x] Watch the session timeline gain a turn. The new marker arrives from the
      side; the existing ones must NOT slide when it auto-scrolls.

**Phase 3.4 — fold + rail**
- [x] Fold a panel. Closing should feel quicker than opening.
- [x] Click the `«` / `»` button at the top of a side region. It should collapse
      to a 44px strip of letter glyphs, dissolving rather than snapping.
- [x] Click a glyph — the region reopens AND scrolls that panel into view.
- [x] Restart. The rail should still be collapsed.
- [x] Drag a splitter, then collapse, then expand: the width you dragged to must
      come back **exactly**. This is the invariant the whole rail design rests
      on (`layoutSizes` holds unrailed widths; see `commitTracks()`).
- [x] `config/ui.local.json` should now carry `railedRegions`.

---

## What's next

**Phase 4 — DONE** (`f46d5c6` + `9ff0800` + `de17ba5` + `91fd999`), 966 tests
green. Five presets plus the builder. See the plan for the three decisions that
departed from the original sketch. **Not yet seen running** — the checklist below
is the outstanding work on it.

### Phase 4 needs a walk, and part of it cannot be seen without a restart

The DOM half is untested by `node --test` (the same line `layouts.test.js` and
`panels.test.js` already draw), so this is its only verification.

**The five presets** — pick each from Appearance → Layout.
- [ ] `left-only`, `cockpit`, `ultrawide`, `stacked`, `zen` each render without a
      collapsed or overlapping region.
- [ ] In each, the `«`/`»` rail button appears only where a column can actually
      shrink. `stacked` should offer it on `side` and nowhere else; `cockpit`
      should NOT offer it on `dock`, whose column is the only elastic one.
- [ ] `zen` is a thin side strip, not auto-hiding. Current-correct, not a bug —
      auto-hide was never built.

**The builder** — the name box and four buttons under the layout select.
- [ ] With a preset selected, only `+` lights up once you type a name. Rename,
      duplicate and delete stay disabled: a preset is not yours to change.
- [ ] Drag a splitter somewhere odd, move a widget to another region, then type a
      name and press `+`. The picker gains your layout and switches to it.
- [ ] The widths and widget placement are the ones you had, not the preset's.
- [ ] Rail a column, then save. The new layout opens with that column railed, and
      un-railing it gives the width you dragged to, **not** 44px. That is the
      `currentUnrailedColumns()` invariant.
- [ ] With your own layout selected, all four buttons are usable.
- [ ] Rename it: the label changes in the picker and the HUD does **not** rebuild.
- [ ] Duplicate it: a second entry appears, and editing one must not change the
      other (that is the deep copy).
- [ ] Delete the one you are standing on. The HUD must land on another layout, not
      sit on one nothing can name.
- [ ] Name one `Classic`. It must save as `classic-2`, and the shipped `Classic`
      must still be in the list.
- [ ] Name one with Polish letters (`Mój Układ`). It should save fine, with the id
      becoming `moj-uklad`.
- [ ] `config/ui.local.json` carries `customLayouts` with your entries.

**Restart-only** (do this last):
- [ ] Saved layouts survive a restart and still apply.
- [ ] The five new presets appear in the picker — they cannot show up before a
      restart, since `layouts:list` is read once at startup.

**Phase 5 — DONE**, 982 tests green. Ten new dark themes, the contrast audit, and
the light-group reorder. Details and the three families are in the plan; what is
outstanding is the walk below.

### Phase 5 needs a walk, and one part of it needs a restart

Less exposed than phase 4, because a palette is data and two automated passes
already cover the mechanical half:

* `npm test` measures contrast over all 28 themes — body text, dim text and the
  terminal foreground. **Contrast is deliberately NOT on the list below**; there
  is no point squinting at what a test measures exactly.
* `npx electron . --luna-probe` ran the real app against these themes and came
  back `themes: 28`, `themeTokensLeaked: []`, `themeTokensLost: []`, equal
  subscriber counts and `rows: 1`. So every new theme's tokens genuinely apply
  and genuinely clean up on switch away — that is the failure this probe exists
  to catch, and it did not fire.

What is left is the half no probe can reach: **whether each theme actually looks
like the thing it is named after**, and whether the shape-changing tokens landed
where they were aimed.

**The ordering** — open the theme picker (left Appearance panel).
- [ ] 28 entries. The first 24 are dark; `Paper`, `Light (daylight)`, `Newsprint`
      and `E-Ink` are the last four, in that order, with no dark below them.

**The ten new themes** — switch to each. The question for every one is the C3
thesis: does it change *shape*, or is it the same HUD in a new hue?
- [ ] `EVA-01` — square corners, visibly **thicker** borders (2px), very wide
      title tracking, purple panels with acid-green accents.
- [ ] `Tron` — the whole HUD in mono, 0 radius, a faint cyan **grid** over the
      background. Rows should NOT rise on hover and controls should NOT sink on
      press: it sets `--lift: 0` and `--press-scale: 1` on purpose. If it still
      moves, those two tokens are not reaching the interaction rules.
- [ ] `Holo` — the largest glow in the app (30px) with soft 12px corners, and
      motion noticeably slower than cyberpunk's.
- [ ] `Luna` — moon-silver on near-black, wide brand tracking, a soft top-centre
      radial wash. This is the namesake theme; it should feel like the app's own.
- [ ] `Aurora` — a green→violet diagonal wash across the background, 14px radius,
      the slowest stagger of the set (70ms) on a layout switch.
- [ ] `Abyss` — almost no glow, **no** text glow, and a heavy dark vignette at the
      edges. Deliberately the quietest neon-family theme.
- [ ] `Magma` — basalt panels, ember accents, sharp 4px corners.
- [ ] `Catppuccin Mocha`, `Rose Pine`, `Everforest Dark` — the calm family. All
      three must be **completely flat**: no box glow, no text glow, and panel
      titles in mixed case rather than uppercase (`--case-title: none`). A glow
      on any of these is a bug, not a preference.

**Cross-checks that have bitten before**
- [ ] Switch between two of the calm themes with the terminal streaming output —
      the 3.1 crossfade check, re-run because 10 new themes now go through it.
- [ ] Set `glow: off` (Ctrl+L → Interface) on `Holo`, the highest-glow theme in
      the app. The bloom must actually go.
- [ ] Set `motion: off`, then switch to `Abyss` (900ms `--dur-slow`). The state
      must land instantly rather than crawl — that is the token-layer zeroing.
- [ ] Each new theme's terminal palette applies, not just the HUD: the xterm
      background should match the panel it sits in.

**Restart-only** (do this last):
- [ ] Pick one of the new themes, restart. It comes back.
- [ ] `config/ui.local.json` carries the chosen theme id.

**Phase 6 — release.** README (theme/layout/modifier tables + download table —
the theme table now has 28 rows, not 18), FUTURE_PLAN START-HERE box, bump to
`0.10.0`, merge, tag, one build.

---

## Release notes draft — v0.10.0 (paste into the GitHub release)

Written 2026-08-31, before the walkthrough. **Do not publish until the phase 4
and 5 checklists above are walked** — every claim here is test- and probe-backed,
none of it is eyeball-backed.

---

### LunaCore v0.10.0 — "Fluidity & Theming"

The biggest visual release since `v0.9.0`. Nothing about the terminal, the token
accounting or the zero-extra-tokens guarantee changed; this is entirely about how
the HUD looks, moves and fits your screen.

**Ten new dark themes — 18 to 28.** Three new families: sci-fi HUD (`eva-01`,
`tron`, `holo`, `luna`), atmospheric (`aurora`, `abyss`, `magma`) and calm
(`catppuccin-mocha`, `rose-pine`, `everforest-dark`). They use the whole ~45-token
vocabulary rather than just swapping hexes, so `tron` is a square-cornered cyan
wireframe with no hover lift and `abyss` is a slow vignette with the glow taken
out. The calm family is the one that was missing: 14 of the previous 18 themes
were neon. The picker now lists all darks first and groups the four light themes
at the bottom.

**Four look-and-feel axes** in the Ctrl+L Settings overlay, independent of the
theme: **density** (comfortable to dense), **font pack**, **glow** and **motion**.
Every default is a no-op, so an existing install renders exactly as it did
before upgrading — nothing is written until you change something. `glow: off`
finally makes the neon themes readable on a bad panel without leaving them.

**Nine layout presets, plus a builder.** Five new presets (`monitor-heavy`,
`bottom-dock`, `left-only`, `cockpit`, `ultrawide`, `stacked`, `zen` joining
`classic` and `focus`), and you can now arrange the HUD yourself and save it
under a name — rename, duplicate and delete it too. Switching a preset *moves*
widgets rather than remounting them, so a running `claude` session survives it.

**Motion.** Theme and density changes crossfade (via view transitions, with the
terminal deliberately excluded so a canvas mid-write cannot tear), overlays now
animate out as well as in, list rows slide when they are added, removed or
reordered, and a whole region can collapse to a 44px rail of glyphs.

**Accessibility.** All 28 themes are now contrast-tested at **4.5:1** in CI,
which caught and fixed two long-standing offenders (`tokyo-night` and `void` had
dim text at 3.81:1 and 4.12:1). The system `prefers-reduced-motion` setting also
now actually works on the 12 themes that set their own motion tokens — it had
been silently doing nothing on those since the theme vocabulary landed.

**Under the hood:** 212 hardcoded CSS declarations moved onto a space/type scale
so one multiplier reaches every gap and font size, with a drift guard in CI to
keep it that way. 982 tests (up from 966).

---

## Waiting on Mati

Two Impeccable hook findings, both on **pre-existing** lines, deliberately not
suppressed because a waiver needs an explicit say-so:

- `var(--ease-bounce)` — flagged as dated. It is a documented token, used
  sparingly for arm/confirm.
- C2's `transition: height` fold — flagged as layout animation. Deliberate,
  shipped, measured; §0 of the plan excludes re-opening it.

Either can be waived with `/impeccable hooks ignore-value …` once you decide.

---

## Environment gotchas that cost real time

- **This shell mangles heredocs.** A quoted `<<'EOF'` heredoc failed with an
  unbalanced-quote parse error, and on another occasion silently stripped one
  level of backslash escaping — turning a test's regex into a valid-but-wrong
  one. Use the Write/Edit tools for any multi-line content, and
  `git commit -F <file>` rather than `-m` with a heredoc.
- **A concurrent Claude session shares this git index. Never `git add -A`.**
  Stage explicit paths only. At the time of writing the tree also holds that
  session's `.gitignore`, `config/profiles.json`, `setup.md`,
  `.env.luna.example` and six `scripts/*` — all untouched by this branch.
  `.env.luna.example` and the `env-setup` scripts want a security read before
  anyone commits them.
- **The GateGuard hook blocks the first edit of each file** until importers,
  affected API, data schemas and the verbatim instruction are stated in the same
  message as the retry. `ECC_GATEGUARD=off` disables it.

---

## The four details in phase 3 that are not obvious from the diff

1. **The view-transition name is on `#terminal`, not `.xterm`.** A name must be
   unique in the document, and tabs mean several `.xterm` exist. It is excluded
   at all because a view transition shows *snapshots*, and cross-dissolving two
   snapshots of a canvas mid-write freezes a torn line on screen.
2. **`flip.js` measures against the list's own content box, not the viewport.**
   The session timeline auto-scrolls on every render; in viewport coordinates
   that reads as "every marker moved", and FLIP would animate a slide that never
   happened.
3. **The rail is a *view* over the widths, never a width.** `layoutSizes` always
   holds the UNRAILED columns and the 44px track is derived at apply time. Break
   this and un-railing has nothing to restore.
4. **`EXIT_RATIO` (motion.js) and `FOLD_EXIT_SCALE` (panels.js) are both 0.65
   and deliberately NOT shared.** Two different gestures that happen to agree;
   welding them would mean retuning a panel fold retunes every modal in the app.

Plus the one rule the whole motion layer runs on: **no duration is ever
hardcoded.** Every one is read from the live computed style, which is what makes
the motion axis and `prefers-reduced-motion` free — both zero `--dur-*` at the
token layer, a resolved 0 means "land the state, skip the movement", and there
is no second accessibility branch to keep in step.
