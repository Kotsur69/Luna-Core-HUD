// ============================================================================
// LunaCore - collapsible + resizable panels (C2)
// ----------------------------------------------------------------------------
// Two features that both edit the shell C1 built, which is why they share a
// file: folding a widget away, and dragging a region border.
//
// FOLD. Every widget root is a `.panel__section` whose first child is an
// `<h2 class="panel__title">` - that invariant is what makes this generic
// rather than 20 per-widget implementations. The title becomes the handle; the
// rest of the section is hidden with `display: none`. Which sections are folded
// persists as a list of widget ids in ui.local.json.
//
// RESIZE. A splitter is an absolutely-positioned strip parked over a grid line.
// It edits the `grid-template-columns` of `.app`, and it obeys ONE rule that
// keeps a resized HUD from breaking the moment the window changes size:
//
//   NEVER convert an elastic track into a fixed one.
//
// So a splitter next to a `px` track drags that track and lets the `fr` track
// absorb it; a splitter between two `fr` tracks redistributes the ratio and
// keeps their sum. A boundary that offers neither (`auto`, `minmax(...)`, or a
// row with nothing elastic left to absorb the change) simply gets no splitter -
// see splitterPlan(). Rows are not resizable at all: presets stack regions into
// rows by name, so a row border is rarely one continuous line to grab.
//
// Two deliberate non-dependencies, both so the pure half of this file stays
// require()-able from a plain CJS test:
//   * no import of terminals.js - after a drag we dispatch a window `resize`,
//     which renderer.js has already wired to fitAndResize();
//   * nothing touches `document` at module scope. `.app` is resolved lazily.
// ============================================================================

'use strict';

import { onLangChange } from './bus.js';

/** Narrowest a panel may be dragged, and the widest a fixed track may grow. */
export const MIN_TRACK_PX = 140;
export const MAX_TRACK_PX = 760;

/** Keyboard nudge per arrow press on a focused splitter. */
const NUDGE_PX = 16;

// ---- Pure track math --------------------------------------------------------

/**
 * Splits a `grid-template-columns` value into its tracks.
 *
 * Bails on anything containing a function (`minmax()`, `repeat()`): those hold
 * spaces of their own, so a naive split would corrupt them. The cost of bailing
 * is that such a layout gets no splitters, which is the correct outcome anyway -
 * this file has no idea how to resize a track it cannot describe.
 *
 * @returns {string[]|null}
 */
export function parseTracks(columns) {
  if (typeof columns !== 'string') return null;
  const s = columns.trim();
  if (!s || s.includes('(')) return null;
  return s.split(/\s+/);
}

export function serializeTracks(tracks) {
  return Array.isArray(tracks) ? tracks.join(' ') : '';
}

/** Pixel size of a `240px` track, or null for anything else. */
export function trackPx(track) {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(typeof track === 'string' ? track : '');
  return m ? Number(m[1]) : null;
}

/** Flex factor of a `1fr` track, or null for anything else. */
export function trackFr(track) {
  const m = /^(\d+(?:\.\d+)?)fr$/.exec(typeof track === 'string' ? track : '');
  return m ? Number(m[1]) : null;
}

/**
 * Whether a stored columns string is safe to write into an inline style.
 *
 * ui.local.json is a plain file a user can hand-edit, and this value goes
 * straight onto `.app`'s style attribute - so it is validated as a whitelist of
 * track forms, not merely parsed. Same reject-don't-repair boundary as every
 * other config in this app.
 */
export function isSafeColumns(str) {
  const tracks = parseTracks(str);
  if (!tracks || tracks.length === 0) return false;
  return tracks.every((t) => /^(\d+(?:\.\d+)?(px|fr|%)|auto)$/.test(t));
}

/**
 * What a splitter at `boundary` (the line between track b and b+1) can do.
 *
 * @returns {{mode:'fixed', index:number, sign:1|-1}|{mode:'flex', index:number}|null}
 *   `fixed` drags one px track (sign says which way the pointer moves it);
 *   `flex` redistributes two fr tracks; null means "do not offer a handle here".
 */
export function splitterPlan(tracks, boundary) {
  if (!Array.isArray(tracks)) return null;
  if (!Number.isInteger(boundary) || boundary < 0 || boundary >= tracks.length - 1) return null;

  const a = tracks[boundary];
  const b = tracks[boundary + 1];
  if (trackFr(a) !== null && trackFr(b) !== null) return { mode: 'flex', index: boundary };

  // Dragging a fixed track only works if something else can give way; in a row
  // of nothing but px tracks the grid would just overflow or leave a gap.
  if (!tracks.some((t) => trackFr(t) !== null)) return null;
  if (trackPx(a) !== null) return { mode: 'fixed', index: boundary, sign: 1 };
  if (trackPx(b) !== null) return { mode: 'fixed', index: boundary + 1, sign: -1 };
  return null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Moves one fixed track by `dxPx`.
 * @param {number} startPx the track's width when the drag began
 * @param {1|-1} sign +1 when the track sits left of the handle, -1 when right
 * @param {{max?:number}} [opts] upper bound; the caller passes the point at
 *   which the elastic neighbour would itself fall under MIN_TRACK_PX
 */
export function resizeFixed(tracks, index, startPx, dxPx, sign, { max = MAX_TRACK_PX } = {}) {
  if (!Array.isArray(tracks) || trackPx(tracks[index]) === null) return tracks;
  const next = [...tracks];
  const upper = Math.max(MIN_TRACK_PX, Math.min(max, MAX_TRACK_PX));
  next[index] = `${Math.round(clamp(startPx + sign * dxPx, MIN_TRACK_PX, upper))}px`;
  return next;
}

/**
 * Shifts the boundary between two fr tracks, keeping their flex sum constant.
 *
 * Constant sum is the whole point: it is what stops a drag from stealing space
 * from a third track elsewhere in the row, and what keeps both tracks elastic.
 *
 * @param {number} aPx current used width of tracks[index]
 * @param {number} bPx current used width of tracks[index + 1]
 */
export function resizeFlex(tracks, index, aPx, bPx, dxPx) {
  if (!Array.isArray(tracks)) return tracks;
  const aFr = trackFr(tracks[index]);
  const bFr = trackFr(tracks[index + 1]);
  if (aFr === null || bFr === null) return tracks;

  const total = aPx + bPx;
  // Too narrow for two usable panels - refuse rather than produce a 0fr track
  // the user then cannot grab again.
  if (!(total > MIN_TRACK_PX * 2)) return tracks;

  const sum = aFr + bFr;
  const newA = clamp(aPx + dxPx, MIN_TRACK_PX, total - MIN_TRACK_PX);
  const round = (n) => Math.round(n * 1000) / 1000;

  const next = [...tracks];
  next[index] = `${round((sum * newA) / total)}fr`;
  next[index + 1] = `${round((sum * (total - newA)) / total)}fr`;
  return next;
}

// ---- Preference state -------------------------------------------------------

/** Widget ids currently folded. */
const collapsed = new Set();
/** layoutId -> a `grid-template-columns` string the user dragged to. */
const sizes = new Map();

let appEl = null;
let currentLayout = null;
let currentTracks = null;
let splitters = [];

function app() {
  if (!appEl) appEl = document.querySelector('.app');
  return appEl;
}

function persistCollapsed() {
  try {
    window.lunacore.setUiPrefs({ collapsed: [...collapsed] });
  } catch {
    /* a HUD that cannot remember a folded panel still works as a HUD */
  }
}

function persistSizes() {
  try {
    window.lunacore.setUiPrefs({ layoutSizes: Object.fromEntries(sizes) });
  } catch {
    /* as above */
  }
}

/**
 * Loads the persisted fold/size state. Must run before initLayout(), which is
 * what triggers the first applyPanels().
 */
export async function initPanels() {
  try {
    const prefs = (await window.lunacore.getUiPrefs()) || {};
    if (Array.isArray(prefs.collapsed)) {
      for (const id of prefs.collapsed) if (typeof id === 'string' && id) collapsed.add(id);
    }
    if (prefs.layoutSizes && typeof prefs.layoutSizes === 'object') {
      for (const [id, cols] of Object.entries(prefs.layoutSizes)) {
        if (typeof id === 'string' && id && isSafeColumns(cols)) sizes.set(id, cols);
      }
    }
  } catch {
    /* no preferences - every panel open, every preset at its authored widths */
  }
}

// ---- Fold -------------------------------------------------------------------

/** Travel, in px, that a fold takes exactly the base duration to cover. */
export const FOLD_REF_PX = 260;
/** Duration multipliers a fold is clamped between, whatever its height. */
export const FOLD_MIN_SCALE = 0.55;
export const FOLD_MAX_SCALE = 1.4;

/**
 * How long a fold of `delta` px should take, given the theme's base duration.
 *
 * A single duration for every panel is what makes a folding UI feel wrong: the
 * two-line PTY status and the fourteen-row skill list are not the same gesture,
 * and giving them the same 350ms makes the small one feel sticky and the big
 * one feel yanked. Scaling by sqrt rather than linearly is the point - four
 * times the distance takes twice the time, which is roughly how a real object
 * covering that distance would behave, and it keeps the range narrow enough to
 * clamp without the clamp doing all the work.
 *
 * `base` is passed in rather than read here so this stays a pure function: the
 * caller resolves it from the live computed style, which is also what makes
 * reduced motion free - the token layer zeroes the duration, base arrives as 0,
 * and this returns 0, which the caller reads as "do not animate at all".
 */
export function foldDurationMs(delta, base, ref = FOLD_REF_PX) {
  if (!(base > 0) || !(ref > 0)) return 0;
  const travel = Math.abs(Number(delta)) || 0;
  const scale = Math.min(FOLD_MAX_SCALE, Math.max(FOLD_MIN_SCALE, Math.sqrt(travel / ref)));
  return Math.round(base * scale);
}

function setFolded(section, folded) {
  const title = section.querySelector(':scope > .panel__title');
  if (folded) section.setAttribute('data-collapsed', '');
  else section.removeAttribute('data-collapsed');
  if (title) title.setAttribute('aria-expanded', folded ? 'false' : 'true');
}

/** section -> the function that ends its in-flight fold early. */
const folding = new WeakMap();

/**
 * Folds a section with the body sliding, rather than blinking out of layout.
 *
 * The measure-apply-measure shape is the same one the to-do drag uses: put the
 * DOM in its FINAL state, read what that costs, then animate from where things
 * actually were. Reading `to` while the children are display:none is the whole
 * trick - it is the only way to learn the collapsed height without a wrapper
 * element, and the browser never paints the intermediate state because nothing
 * yields between the two reads.
 *
 * Only the click/keyboard toggle comes through here. decorate() still calls
 * setFolded() directly, because a layout switch re-folds every section on
 * screen at once and eighteen simultaneous height animations is not a
 * transition, it is a seizure.
 */
function animateFold(section, folded) {
  folding.get(section)?.();

  // Measure the destination by actually going there and coming back. Two extra
  // layout reads on a click is nothing, and it buys a `to` that is correct for
  // both directions without this function needing to know a single thing about
  // how a section is built - no title arithmetic, no assumptions about padding.
  const from = section.getBoundingClientRect().height;
  setFolded(section, folded);
  const to = section.getBoundingClientRect().height;
  setFolded(section, !folded);

  // Enter the animating state BEFORE the real attribute change, and force a
  // layout read while still in it. This ordering is the whole fade: a
  // transition cannot start from `display: none`, so the body has to already
  // be in flow AND have its starting opacity computed at least once before the
  // rule that moves it engages. Setting the attribute first - which is what
  // this did originally - made the body snap to its end state instead, and the
  // panel read as being guillotined rather than closed.
  section.classList.add('is-folding');
  // Resolved from the live style rather than a constant, so a theme retuning
  // --dur-normal retunes the fold with it, and prefers-reduced-motion (which
  // zeroes it at the token layer) lands here as a plain 0.
  const base = (parseFloat(getComputedStyle(section).transitionDuration) || 0) * 1000;
  const ms = foldDurationMs(to - from, base);

  const finish = () => {
    folding.delete(section);
    section.classList.remove('is-folding');
    section.style.height = '';
    section.style.removeProperty('--fold-ms');
    // A folded panel changes how much room the terminal region has, and xterm
    // only refits on a resize. Fired at the END: refitting against a height
    // that is still moving just makes it refit against the wrong one.
    window.dispatchEvent(new Event('resize'));
  };

  if (!ms || from === to) {
    // Reduced motion, or a section whose height does not change. Either way the
    // state still has to land - it is only the movement that is skipped.
    setFolded(section, folded);
    finish();
    return;
  }

  section.style.setProperty('--fold-ms', `${ms}ms`);
  section.style.height = `${from}px`;
  // Without this read the browser coalesces every style change below into one
  // and there is nothing for either property to transition FROM.
  section.getBoundingClientRect();
  setFolded(section, folded);
  section.style.height = `${to}px`;

  // Timer rather than transitionend: `height` on a flex child is not always the
  // property that ends up animating (a --grow section can be sized by its
  // parent instead), and a fold that never cleans up leaves an inline height
  // welded to the panel.
  const timer = setTimeout(() => finish(), ms + 40);
  folding.set(section, () => {
    clearTimeout(timer);
    finish();
  });
}

/**
 * Puts the chevron back in a title.
 *
 * Separate from the wiring below, and re-run on every language change, because
 * i18n's applyStatic() translates by assigning `el.textContent` - and a dozen
 * titles carry `data-i18n` on the <h2> itself. That assignment drops every
 * child the element had, so switching PL<->EN would quietly strip the chevron
 * out of exactly those panels while leaving the ones with a nested <span>
 * alone. The element's own attributes and listeners survive it, which is why
 * only this half needs repeating.
 */
function ensureChevron(title) {
  if (title.querySelector('.panel__fold')) return;
  // Decorative, not a <button>: several titles already carry real buttons
  // (ports' filter, context's copy-path), and a button inside a button is both
  // invalid and unclickable. The h2 itself carries the semantics.
  const chevron = document.createElement('span');
  chevron.className = 'panel__fold';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';
  title.prepend(chevron);
}

/**
 * Turns one widget section's title into a fold handle. Idempotent: a layout
 * switch MOVES widget roots rather than remounting them, so most sections
 * arrive here already decorated.
 */
function decorate(section) {
  const id = section.dataset.widget;
  const title = section.querySelector(':scope > .panel__title');
  // No title, no handle. `autocompact` is the real case: its "root" is the
  // toggle's own <label> nested inside w-actions, with nothing to fold.
  if (!id || !title) return;

  ensureChevron(title);

  if (!title.dataset.foldWired) {
    title.dataset.foldWired = '1';
    title.classList.add('panel__title--fold');
    title.setAttribute('role', 'button');
    title.tabIndex = 0;

    const toggle = () => {
      const folded = !section.hasAttribute('data-collapsed');
      animateFold(section, folded);
      if (folded) collapsed.add(id);
      else collapsed.delete(id);
      persistCollapsed();
    };

    title.addEventListener('click', (e) => {
      // Let the controls that live IN the title do their own job.
      if (e.target.closest('button, input, select, textarea, a')) return;
      toggle();
    });
    title.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('button, input, select, textarea, a')) return;
      e.preventDefault();
      toggle();
    });
  }

  setFolded(section, collapsed.has(id));
}

/** Re-decorates every section on screen. */
function decorateAll() {
  const el = app();
  if (!el) return;
  for (const section of el.querySelectorAll('.panel__section[data-widget]')) decorate(section);
}

// ---- Resize -----------------------------------------------------------------

/** Used pixel width of every column, plus the gap between them. */
function usedColumns() {
  const cs = getComputedStyle(app());
  const cols = cs.gridTemplateColumns.split(/\s+/).map(parseFloat);
  const gap = parseFloat(cs.columnGap);
  return { cols, gap: Number.isFinite(gap) ? gap : 0 };
}

function positionSplitters() {
  if (splitters.length === 0) return;
  const { cols, gap } = usedColumns();
  for (const el of splitters) {
    const b = Number(el.dataset.boundary);
    if (!Number.isFinite(cols[b])) continue;
    // Centre of the gap that follows track b: every track up to and including
    // it, plus the b gaps already passed, plus half of this one. The handle
    // itself is centred on that line by translateX(-50%) in CSS.
    let x = gap / 2 + b * gap;
    for (let i = 0; i <= b; i++) x += cols[i];
    el.style.left = `${x}px`;
  }
}

function removeSplitters() {
  for (const el of splitters) el.remove();
  splitters = [];
}

/** Writes tracks to the grid and keeps the handles on their lines. */
function applyTracks(tracks) {
  currentTracks = tracks;
  app().style.gridTemplateColumns = serializeTracks(tracks);
  positionSplitters();
  // xterm measures against a fixed box and only re-measures when told to.
  // renderer.js already listens for this; see the header on why we go the long
  // way round rather than importing terminals.js.
  window.dispatchEvent(new Event('resize'));
}

/**
 * How far a fixed track may grow before the elastic track beside it would fall
 * under MIN_TRACK_PX. Without this a drag can squeeze the terminal to nothing.
 */
function maxForFixed(plan) {
  const { cols } = usedColumns();
  let slack = 0;
  currentTracks.forEach((t, i) => {
    if (i !== plan.index && trackFr(t) !== null && Number.isFinite(cols[i])) {
      slack += Math.max(0, cols[i] - MIN_TRACK_PX);
    }
  });
  return (cols[plan.index] || MIN_TRACK_PX) + slack;
}

function beginDrag(el, boundary, startX, pointerId) {
  const plan = splitterPlan(currentTracks, boundary);
  if (!plan) return null;
  const { cols } = usedColumns();
  return {
    plan,
    startX,
    pointerId,
    startTracks: [...currentTracks],
    startPx: cols[plan.index] || 0,
    aPx: cols[boundary] || 0,
    bPx: cols[boundary + 1] || 0,
    max: plan.mode === 'fixed' ? maxForFixed(plan) : 0,
  };
}

function dragTo(drag, boundary, dx) {
  const { plan, startTracks } = drag;
  return plan.mode === 'fixed'
    ? resizeFixed(startTracks, plan.index, drag.startPx, dx, plan.sign, { max: drag.max })
    : resizeFlex(startTracks, boundary, drag.aPx, drag.bPx, dx);
}

function wireSplitter(el, boundary) {
  let drag = null;
  let frame = 0;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = beginDrag(el, boundary, e.clientX, e.pointerId);
    if (!drag) return;
    el.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    // Coalesce to one paint per frame: every move otherwise re-measures xterm.
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (drag) applyTracks(dragTo(drag, boundary, dx));
    });
  });

  const end = () => {
    if (!drag) return;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    try {
      el.releasePointerCapture(drag.pointerId);
    } catch {
      /* the capture is already gone on a cancel */
    }
    drag = null;
    el.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing');
    if (currentLayout) {
      sizes.set(currentLayout.id, serializeTracks(currentTracks));
      persistSizes();
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // Double-click resets THIS layout to the widths its preset was authored with.
  el.addEventListener('dblclick', () => {
    if (!currentLayout) return;
    const preset = parseTracks(currentLayout.columns);
    if (!preset) return;
    sizes.delete(currentLayout.id);
    persistSizes();
    applyTracks(preset);
  });

  el.addEventListener('keydown', (e) => {
    const dx = e.key === 'ArrowLeft' ? -NUDGE_PX : e.key === 'ArrowRight' ? NUDGE_PX : 0;
    if (!dx) return;
    const step = beginDrag(el, boundary, 0, -1);
    if (!step) return;
    e.preventDefault();
    applyTracks(dragTo(step, boundary, dx));
    sizes.set(currentLayout.id, serializeTracks(currentTracks));
    persistSizes();
  });
}

function splitterLabel() {
  return window.i18n ? window.i18n.t('panel.resize') : '';
}

function buildSplitters() {
  removeSplitters();
  if (!currentTracks) return;
  const label = splitterLabel();
  for (let b = 0; b < currentTracks.length - 1; b++) {
    if (!splitterPlan(currentTracks, b)) continue;
    const el = document.createElement('div');
    el.className = 'splitter';
    el.dataset.boundary = String(b);
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'vertical');
    el.title = label;
    el.tabIndex = 0;
    // Absolutely positioned, so it is out of flow and cannot claim a grid cell
    // of its own - see .splitter in styles.css.
    app().appendChild(el);
    splitters.push(el);
    wireSplitter(el, b);
  }
  positionSplitters();
}

// ---- Entry point ------------------------------------------------------------

/**
 * Re-applies fold state and rebuilds the splitters for a freshly drawn layout.
 * Called by layout.js at the end of every applyLayout(), which is also the only
 * moment the shell exists in its final shape.
 */
export function applyPanels(layout) {
  currentLayout = layout;
  const el = app();
  if (!el) return;

  const preset = parseTracks(layout.columns);
  const saved = sizes.get(layout.id);
  const savedTracks = isSafeColumns(saved) ? parseTracks(saved) : null;
  // A stored size only survives while it still describes the same preset. Edit
  // a layout's column count in layouts.json and the old widths are dropped
  // rather than smeared across the wrong tracks.
  currentTracks =
    savedTracks && preset && savedTracks.length === preset.length ? savedTracks : preset;

  if (currentTracks) el.style.gridTemplateColumns = serializeTracks(currentTracks);

  decorateAll();
  buildSplitters();
}

/**
 * App-lifetime listeners: keep the handles on their grid lines as the window
 * changes size, and put both the chevrons and the handle tooltips back after a
 * language switch. Splitters and chevrons are otherwise only built on a layout
 * switch, so without this a language change in between would leave every handle
 * describing itself in the old language - and, for titles translated by
 * assigning textContent, no chevron at all. See ensureChevron().
 */
export function initPanelResizeTracking() {
  window.addEventListener('resize', positionSplitters);
  onLangChange(() => {
    decorateAll();
    const label = splitterLabel();
    for (const el of splitters) el.title = label;
  });
}
