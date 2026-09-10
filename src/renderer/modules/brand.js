// ============================================================================
// LunaCore - brand mark behaviour (the LunaCore moon)
// ----------------------------------------------------------------------------
// The static markup in index.html is just `<span class="brand__glyph">.</span>`.
// This module swaps that glyph for an inline SVG moon that:
//
//   * shows the REAL phase of the Moon for tonight (moonphase.js), refreshed
//     hourly and whenever the window regains focus;
//   * runs a fast time-lapse through a full lunation while the pointer is over
//     it, and follows the cursor a few pixels (parallax);
//   * blooms into a full-moon flare on click - glow burst, one spin, a chime,
//     then it settles back to tonight's phase. Pure decoration, no side effect;
//   * carries a "Waxing gibbous - 72% lit" tooltip.
//
// Motion budget. Every animated behaviour here is eye candy, so it only runs at
// data-motion="full" with prefers-reduced-motion unset (eyeCandyOn()). At the
// "reduced" and "off" tiers the moon still renders tonight's phase and keeps its
// tooltip - it just holds still. The one ambient loop (a slow vertical bob) is
// CSS, gated the same way in styles.css and paused while the window is blurred.
//
// The brand node is MOVED between regions by layout.js (appendChild), not
// recreated, so listeners wired here survive a layout rebuild. mountBrand() is
// called once from renderer.js after initAppearance().
// ============================================================================

'use strict';

import { phaseFraction, phaseName, illumination, moonLitPath } from './moonphase.js';
import { tokenMs } from './motion.js';
import { t, pulse } from './util.js';
import { onLangChange, onBusyIdle } from './bus.js';
import { sfx } from './sound.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Disc radius in SVG units. The viewBox is -50..50 so the glow has room. */
const DISC_R = 40;
/** One full hover time-lapse cycle (new -> full -> new), in ms. */
const LUNATION_MS = 1600;
/** How often the resting phase is recomputed. Tonight's phase barely moves in
 *  an hour; this is just so a machine left running overnight stays honest. */
const REST_REFRESH_MS = 60 * 60 * 1000;
/** Largest cursor-follow offset, in px. */
const PARALLAX_PX = 3;
/** clipPath id - single brand mark on the page, so a fixed id is fine. */
const CLIP_ID = 'luna-moon-clip';

const reduceMotionQuery =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** True only when the decorative motion tier is fully on. */
function eyeCandyOn() {
  const motion = document.documentElement.getAttribute('data-motion');
  if (motion === 'off' || motion === 'reduced') return false;
  return !(reduceMotionQuery && reduceMotionQuery.matches);
}

/** Small helper: an SVG element with attributes set. */
function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

/**
 * Wires the moon behaviour onto the brand mark. Safe to call once; a missing
 * `.brand` (no HUD) is a silent no-op.
 */
export function mountBrand() {
  const brandEl = document.querySelector('.brand');
  const glyphEl = brandEl && brandEl.querySelector('.brand__glyph');
  if (!brandEl || !glyphEl) return;

  // ---- Build the SVG, replacing the text glyph ------------------------------
  glyphEl.classList.add('brand__glyph--moon');
  glyphEl.textContent = '';

  const svg = svgEl('svg', {
    class: 'brand__moon',
    viewBox: '-50 -50 100 100',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const clip = svgEl('clipPath', { id: CLIP_ID });
  const clipPath = svgEl('path', { class: 'moon__lit-clip' });
  clip.append(clipPath);
  const defs = svgEl('defs', {});
  defs.append(clip);

  const disc = svgEl('circle', { class: 'moon__disc', r: String(DISC_R) });
  const lit = svgEl('path', { class: 'moon__lit' });
  const craters = svgEl('g', { class: 'moon__craters', 'clip-path': `url(#${CLIP_ID})` });
  for (const [cx, cy, r] of [
    [-13, -9, 6],
    [9, 15, 8],
    [17, -17, 4],
  ]) {
    craters.append(svgEl('circle', { cx: String(cx), cy: String(cy), r: String(r) }));
  }

  svg.append(defs, disc, lit, craters);
  glyphEl.append(svg);

  // ---- State --------------------------------------------------------------
  let restFraction = phaseFraction();
  let displayFraction = restFraction;
  let hovering = false;
  let hoverRAF = 0;
  let flareRAF = 0;
  let parallaxRAF = 0;

  /** Paint a phase. `moonLitPath` wraps its input, so values past 1 are fine. */
  function render(fraction) {
    displayFraction = fraction;
    const d = moonLitPath(DISC_R, fraction);
    lit.setAttribute('d', d);
    clipPath.setAttribute('d', d);
    svg.style.setProperty('--moon-illum', illumination(fraction).toFixed(3));
  }

  function updateTooltip() {
    glyphEl.title = t('brand.moon.tooltip', {
      name: t(phaseName(restFraction)),
      pct: Math.round(illumination(restFraction) * 100),
    });
  }

  /** Recompute tonight's phase; repaint only if nothing is animating. */
  function refreshRest() {
    restFraction = phaseFraction();
    if (!hovering && !flareRAF) render(restFraction);
    updateTooltip();
  }

  // ---- Cursor parallax -------------------------------------------------
  function setShift(x, y) {
    glyphEl.style.setProperty('--moon-shift-x', `${x}px`);
    glyphEl.style.setProperty('--moon-shift-y', `${y}px`);
  }

  // ---- Hover time-lapse --------------------------------------------------
  function startCycle() {
    hovering = true;
    if (!eyeCandyOn() || hoverRAF || flareRAF) return;
    const from = displayFraction;
    const start = performance.now();
    const step = (now) => {
      // Ease-in-out over each cycle so the sweep breathes rather than ticks.
      const raw = ((now - start) % LUNATION_MS) / LUNATION_MS;
      const eased = 0.5 - 0.5 * Math.cos(2 * Math.PI * raw);
      render(from + eased);
      hoverRAF = requestAnimationFrame(step);
    };
    hoverRAF = requestAnimationFrame(step);
  }

  function stopCycle() {
    hovering = false;
    if (hoverRAF) cancelAnimationFrame(hoverRAF);
    hoverRAF = 0;
    setShift(0, 0);
    if (!flareRAF) render(restFraction);
  }

  function onPointerMove(e) {
    if (!eyeCandyOn() || parallaxRAF) return;
    parallaxRAF = requestAnimationFrame(() => {
      parallaxRAF = 0;
      const r = glyphEl.getBoundingClientRect();
      if (!r.width) return;
      const nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const clamp = (v) => Math.max(-1, Math.min(1, v));
      setShift(clamp(nx) * PARALLAX_PX, clamp(ny) * PARALLAX_PX);
    });
  }

  // ---- Full-moon flare (click easter egg) -----------------------------
  function flare() {
    if (!eyeCandyOn() || flareRAF) return;
    const dur = tokenMs('--dur-slow', brandEl);
    if (!dur) return;

    // Restart the CSS glow/spin keyframe, then the chime.
    pulse(brandEl, 'brand--flare');
    sfx.moonFlare();

    // Hand the disc over from the hover loop for the duration of the flare.
    if (hoverRAF) cancelAnimationFrame(hoverRAF);
    hoverRAF = 0;

    // Morph the lit disc to the nearest full moon and back to tonight's phase.
    const from = displayFraction;
    const target = Math.round(from - 0.5) + 0.5; // closest 0.5 + integer turn
    const back = Math.round(target) + restFraction; // rest, same turn as target
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * p);
      // First half rushes to full, second half eases back down.
      render(
        p < 0.5
          ? from + (target - from) * (eased * 2)
          : target + (back - target) * (eased * 2 - 1)
      );
      if (p < 1) {
        flareRAF = requestAnimationFrame(step);
      } else {
        flareRAF = 0;
        // Resume the hover loop if the pointer never left, else settle.
        if (hovering) startCycle();
        else render(restFraction);
      }
    };
    flareRAF = requestAnimationFrame(step);
  }

  // ---- Success ripple (a session went working -> idle) ---------------
  // One expanding ring off the mark. Fires for the active tab or a background
  // bucket alike - led.js emits on either. Purely ambient, so it is gated on
  // eyeCandyOn() like the rest and simply skipped at the quieter tiers.
  function ripple() {
    if (!eyeCandyOn()) return;
    pulse(brandEl, 'brand--ripple');
  }

  function onAnimEnd(e) {
    if (e.animationName === 'brand-flare') brandEl.classList.remove('brand--flare');
    else if (e.animationName === 'brand-ripple') brandEl.classList.remove('brand--ripple');
  }

  // ---- Window focus: pause ambient loop, keep phase honest -----------
  function onBlur() {
    document.documentElement.classList.add('is-blurred');
  }
  function onFocus() {
    document.documentElement.classList.remove('is-blurred');
    refreshRest();
  }

  // ---- Wire up --------------------------------------------------------
  brandEl.addEventListener('pointerenter', startCycle);
  brandEl.addEventListener('pointerleave', stopCycle);
  brandEl.addEventListener('pointermove', onPointerMove);
  brandEl.addEventListener('click', flare);
  brandEl.addEventListener('animationend', onAnimEnd);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  onLangChange(updateTooltip);
  onBusyIdle(ripple);
  setInterval(refreshRest, REST_REFRESH_MS);

  render(restFraction);
  updateTooltip();
}
