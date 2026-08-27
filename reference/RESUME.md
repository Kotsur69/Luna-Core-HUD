# RESUME — v0.10 fluidity & theming

Operational hand-off for the `feat/fluidity-theming` branch. Read this first,
then `FLUIDITY_THEMING_PLAN.md` for the design record and the locked decisions
(they live there, not here — one copy, no drift).

Last updated: 2026-08-27, end of day. Phases 1–3 done, 4–6 unstarted.

---

## Where things stand

Branch `feat/fluidity-theming`, pushed. `package.json` still says **0.9.6** —
the bump to `0.10.0` is phase 6, deliberately at the end, one build for the
whole release.

```
5a6ad6a  docs: mark phase 3 done, point at phase 4
62b2ae8  feat: fold direction + collapse a column to a rail   (3.4)
1bb5309  feat: keyed list motion                              (3.3)
f39e7ea  feat: crossfade theme/density, animate overlays out  (3.1 + 3.2)
4a4b393  docs: mark phase 2 done
d27e6fa  feat: wire the modifier axes into Settings           (phase 2)
bd4284e  feat: modifier axes                                  (phase 2, WIP)
e9fd3b0  feat: space + type scales on a density multiplier    (phase 1)
```

`npm test` → **916 pass, 0 fail**, ~0.8s. `npm start` runs the app.

---

## DO THIS FIRST: none of it has been looked at

Three phases are test-green with every token resolving, and **not one frame of
it has been seen in a running app**. That is the single biggest risk on this
branch. Phase 4 builds directly on top, so this comes before any new code.

`npm start`, then work down the list. Each line is something that could be
silently wrong in a way no test can catch.

**Phase 1 — the scales**
- [ ] Nothing looks misaligned. The normalization moved some elements by half a
      pixel on purpose (9.5→9, 15→14, 3→2, 7→6); look for anything that now
      reads as off-by-one rather than merely tighter.

**Phase 2 — the four axes** (Ctrl+L → *Interface*)
- [ ] `dense` — is the HUD still readable, or did something collapse?
- [ ] each font pack — `mono`, `display`, `system`. All bundled, no network.
- [ ] `glow: off` on a neon theme (`cyberpunk`) — is the glow actually gone?
- [ ] `motion: off` — everything below should become instant, not janky.

**Phase 3.1 — crossfade**
- [ ] Switch theme (left Appearance panel). The whole HUD should *dissolve*.
- [ ] **Watch the terminal while it does.** It must NOT freeze, tear, or
      double-print. It is excluded from the transition on purpose; if it
      misbehaves, the `#terminal` view-transition-name is the thing to look at.
- [ ] Switch density with the terminal streaming output. Same check.

**Phase 3.2 — overlay exit**
- [ ] Ctrl+K then Esc. Ctrl+L then Esc. A file in Active Files, then Esc.
      Each should fade and retreat, not vanish.
- [ ] Esc then *immediately* reopen the same overlay. It must stay open — that
      is `cancelExit()`; if it blinks shut a beat later, that call is missing.
- [ ] Close the file-diff modal: the text must not blank before it fades.

**Phase 3.3 — list motion**
- [ ] Leave the ports list alone through a rescan. It must be **completely
      still**. Any blink means a key is wrong or missing.
- [ ] Add/remove a repo so the git list changes — rows should slide, not jump.
- [ ] Watch the session timeline gain a turn. The new marker arrives from the
      side; the existing ones must NOT slide when it auto-scrolls.

**Phase 3.4 — fold + rail**
- [ ] Fold a panel. Closing should feel quicker than opening.
- [ ] Click the `«` / `»` button at the top of a side region. It should collapse
      to a 44px strip of letter glyphs, dissolving rather than snapping.
- [ ] Click a glyph — the region reopens AND scrolls that panel into view.
- [ ] Restart. The rail should still be collapsed.
- [ ] Drag a splitter, then collapse, then expand: the width you dragged to must
      come back **exactly**. This is the invariant the whole rail design rests
      on (`layoutSizes` holds unrailed widths; see `commitTracks()`).
- [ ] `config/ui.local.json` should now carry `railedRegions`.

---

## What's next

**Phase 4 — templates.** Five presets (`left-only`, `cockpit`, `ultrawide`,
`stacked`, `zen`) plus the layout builder writing `customLayouts` to
`ui.local.json`. It will be editing exactly the grid-track code 3.4 extended:
`regionColumn()`, `railTracks()`, `commitTracks()` in `panels.js` are the seam.

**Phase 5 — themes.** 8–10 new dark ones, plus a 4.5:1 contrast test over all
themes (expect it to flag 1–2 existing ones; fixing those is in scope).
Standing constraint, verbatim: **"dont make new 'light' modes"**.

**Phase 6 — release.** README, FUTURE_PLAN START-HERE box, bump to `0.10.0`,
merge, tag, one build.

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
