// Tests for the pure half of C2: the grid-track math behind the splitters, and
// the boundary validation on the sizes that get persisted. The DOM half (drag
// wiring, splitter placement, fold decoration) is left to the manual checklist,
// the same line test/layouts.test.js draws around modules/layout.js.
//
// The rule every test here is really defending: A DRAG MUST NEVER TURN AN
// ELASTIC TRACK INTO A FIXED ONE. That is what would make a resized HUD stop
// responding to the window being resized - a bug that only shows up later, on
// someone else's monitor.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTracks,
  serializeTracks,
  trackPx,
  trackFr,
  isSafeColumns,
  splitterPlan,
  resizeFixed,
  resizeFlex,
  MIN_TRACK_PX,
  MAX_TRACK_PX,
  foldDurationMs,
  FOLD_REF_PX,
  FOLD_MIN_SCALE,
  FOLD_MAX_SCALE,
  FOLD_EXIT_SCALE,
  RAIL_PX,
  regionColumn,
  railTracks,
} = require('../src/renderer/modules/panels.js');

const { loadLayouts } = require('../src/layouts.js');

// ---- parseTracks / serializeTracks -----------------------------------------

test('parseTracks splits the shipped presets', () => {
  assert.deepEqual(parseTracks('260px 1fr 280px'), ['260px', '1fr', '280px']);
  assert.deepEqual(parseTracks('  1fr   250px '), ['1fr', '250px']);
});

// A function value holds spaces of its own, so splitting on whitespace would
// tear it in half and produce a grid template that means something else.
// Refusing costs that layout its splitters, which is the honest outcome.
test('parseTracks refuses anything containing a function', () => {
  assert.equal(parseTracks('minmax(200px, 1fr) 1fr'), null);
  assert.equal(parseTracks('repeat(3, 1fr)'), null);
});

test('parseTracks rejects non-strings and empties', () => {
  for (const junk of [null, undefined, 42, [], '', '   ']) {
    assert.equal(parseTracks(junk), null);
  }
});

test('serializeTracks round-trips', () => {
  const s = '210px 1fr 380px';
  assert.equal(serializeTracks(parseTracks(s)), s);
});

// ---- trackPx / trackFr ------------------------------------------------------

test('trackPx and trackFr read only their own unit', () => {
  assert.equal(trackPx('260px'), 260);
  assert.equal(trackPx('1fr'), null);
  assert.equal(trackPx('auto'), null);
  assert.equal(trackFr('1.5fr'), 1.5);
  assert.equal(trackFr('260px'), null);
  assert.equal(trackFr(null), null);
});

// ---- isSafeColumns ----------------------------------------------------------
//
// ui.local.json is hand-editable and this value is written straight into an
// inline style, so it is a whitelist, not a parse.

test('isSafeColumns accepts the track forms we produce', () => {
  assert.equal(isSafeColumns('260px 1fr 280px'), true);
  assert.equal(isSafeColumns('0.5fr 1.5fr'), true);
  assert.equal(isSafeColumns('30% 1fr auto'), true);
});

test('isSafeColumns rejects anything else', () => {
  assert.equal(isSafeColumns('260px; background: url(http://x)'), false);
  assert.equal(isSafeColumns('minmax(10px, 1fr)'), false);
  assert.equal(isSafeColumns('var(--x) 1fr'), false);
  assert.equal(isSafeColumns('260 1fr'), false, 'a unitless track is not a track');
  assert.equal(isSafeColumns(''), false);
  assert.equal(isSafeColumns(null), false);
});

// ---- splitterPlan -----------------------------------------------------------

test('splitterPlan drags the fixed track and lets the fr track absorb it', () => {
  const t = ['260px', '1fr', '280px'];
  // Left handle: the px track is on its left, so dragging right grows it.
  assert.deepEqual(splitterPlan(t, 0), { mode: 'fixed', index: 0, sign: 1 });
  // Right handle: the px track is on its right, so dragging right shrinks it.
  assert.deepEqual(splitterPlan(t, 1), { mode: 'fixed', index: 2, sign: -1 });
});

test('splitterPlan redistributes when both neighbours are elastic', () => {
  assert.deepEqual(splitterPlan(['1fr', '1fr', '1fr'], 0), { mode: 'flex', index: 0 });
  assert.deepEqual(splitterPlan(['1fr', '1fr', '1fr'], 1), { mode: 'flex', index: 1 });
});

// The one that keeps a resized HUD honest: with nothing elastic in the row,
// growing a fixed track has nowhere to take the space from, so no handle.
test('splitterPlan offers nothing when no track can absorb the change', () => {
  assert.equal(splitterPlan(['260px', '280px'], 0), null);
});

test('splitterPlan offers nothing next to a track it cannot describe', () => {
  assert.equal(splitterPlan(['auto', 'auto'], 0), null);
  assert.equal(splitterPlan(['auto', '1fr', 'auto'], 0), null);
});

test('splitterPlan rejects out-of-range boundaries', () => {
  const t = ['260px', '1fr'];
  for (const b of [-1, 1, 2, 1.5, '0', null]) {
    assert.equal(splitterPlan(t, b), null);
  }
  assert.equal(splitterPlan(null, 0), null);
});

// ---- resizeFixed ------------------------------------------------------------

test('resizeFixed moves the track by the drag distance', () => {
  const t = ['260px', '1fr', '280px'];
  assert.deepEqual(resizeFixed(t, 0, 260, 40, 1), ['300px', '1fr', '280px']);
  // sign -1: the handle is on the track's LEFT, so a rightward drag shrinks it.
  assert.deepEqual(resizeFixed(t, 2, 280, 40, -1), ['260px', '1fr', '240px']);
});

test('resizeFixed clamps to the minimum', () => {
  const out = resizeFixed(['260px', '1fr'], 0, 260, -5000, 1);
  assert.equal(trackPx(out[0]), MIN_TRACK_PX);
});

test('resizeFixed clamps to the caller-supplied maximum', () => {
  // The DOM half passes the point at which the elastic neighbour would itself
  // fall under MIN_TRACK_PX - this is what stops a drag squeezing the terminal
  // down to nothing.
  const out = resizeFixed(['260px', '1fr'], 0, 260, 5000, 1, { max: 400 });
  assert.equal(trackPx(out[0]), 400);
});

test('resizeFixed never lets the caller exceed the hard cap', () => {
  const out = resizeFixed(['260px', '1fr'], 0, 260, 5000, 1, { max: 99999 });
  assert.equal(trackPx(out[0]), MAX_TRACK_PX);
});

test('resizeFixed leaves the other tracks untouched, and does not mutate', () => {
  const t = ['260px', '1fr', '280px'];
  const out = resizeFixed(t, 0, 260, 40, 1);
  assert.deepEqual(t, ['260px', '1fr', '280px']);
  assert.equal(out[1], '1fr');
  assert.equal(out[2], '280px');
});

test('resizeFixed refuses a track that is not fixed', () => {
  const t = ['260px', '1fr'];
  assert.equal(resizeFixed(t, 1, 100, 40, 1), t);
});

// ---- resizeFlex -------------------------------------------------------------

test('resizeFlex keeps the flex sum constant', () => {
  // Two 1fr tracks 500px wide each; drag the boundary 100px right.
  const out = resizeFlex(['1fr', '1fr'], 0, 500, 500, 100);
  assert.equal(trackFr(out[0]) + trackFr(out[1]), 2);
  assert.equal(trackFr(out[0]), 1.2);
  assert.equal(trackFr(out[1]), 0.8);
});

// The whole reason this mode exists rather than writing two px tracks.
test('resizeFlex leaves both tracks elastic', () => {
  const out = resizeFlex(['1fr', '1fr'], 0, 500, 500, 100);
  assert.ok(out.every((t) => trackFr(t) !== null), `expected fr tracks, got ${out}`);
});

test('resizeFlex respects an uneven starting ratio', () => {
  const out = resizeFlex(['2fr', '1fr'], 0, 600, 300, 0);
  assert.equal(trackFr(out[0]), 2);
  assert.equal(trackFr(out[1]), 1);
});

test('resizeFlex clamps so neither side falls under the minimum', () => {
  const out = resizeFlex(['1fr', '1fr'], 0, 500, 500, -5000);
  const total = 1000;
  assert.equal(trackFr(out[0]), Math.round((2 * MIN_TRACK_PX) / total * 1000) / 1000);
  assert.ok(trackFr(out[1]) > trackFr(out[0]));
});

test('resizeFlex refuses when there is no room for two panels', () => {
  const t = ['1fr', '1fr'];
  assert.equal(resizeFlex(t, 0, 100, 100, 40), t);
});

test('resizeFlex refuses a boundary that is not fr on both sides', () => {
  const t = ['260px', '1fr'];
  assert.equal(resizeFlex(t, 0, 260, 700, 40), t);
});

test('resizeFlex only touches its own two tracks', () => {
  const out = resizeFlex(['1fr', '1fr', '1fr'], 0, 400, 400, 80);
  assert.equal(out[2], '1fr');
});

// ---- the shipped presets ----------------------------------------------------
//
// A preset whose columns this file cannot parse silently loses its splitters,
// which is exactly the kind of regression nobody notices until they try to drag
// one. Pin the shipped four.

test('config/layouts.json - every preset yields parseable tracks', () => {
  for (const l of loadLayouts().layouts) {
    const tracks = parseTracks(l.columns);
    assert.notEqual(tracks, null, `layout "${l.id}" has unparseable columns: ${l.columns}`);
    assert.equal(isSafeColumns(l.columns), true, `layout "${l.id}" columns not whitelisted`);
  }
});

test('config/layouts.json - every preset offers at least one splitter', () => {
  for (const l of loadLayouts().layouts) {
    const tracks = parseTracks(l.columns);
    const usable = tracks.map((_t, i) => splitterPlan(tracks, i)).filter(Boolean);
    assert.ok(usable.length > 0, `layout "${l.id}" has no resizable boundary`);
  }
});

// ---- foldDurationMs ---------------------------------------------------------
// A fold's duration scales with how far the panel actually travels, so the
// two-line status widget and the fourteen-row skill list do not share one
// timing that is wrong for both.

const BASE = 350;

test('a fold of the reference distance takes exactly the base duration', () => {
  assert.equal(foldDurationMs(FOLD_REF_PX, BASE), BASE);
  assert.equal(foldDurationMs(-FOLD_REF_PX, BASE), BASE, 'direction must not matter');
});

test('four times the distance takes twice as long, not four times', () => {
  // Both distances sit inside the unclamped band on purpose - the clamp is a
  // safety rail for extremes, and testing through it would measure the rail
  // instead of the curve.
  const near = foldDurationMs(125, BASE);
  const far = foldDurationMs(500, BASE);
  // Approximate because the function rounds to whole milliseconds: 485/243 is
  // the ratio a caller actually gets, and it is 2 for every purpose motion has.
  assert.ok(Math.abs(far / near - 2) < 0.01, `${near}ms -> ${far}ms`);
});

test('duration is monotonic in distance', () => {
  let prev = 0;
  for (const px of [0, 60, 120, 260, 400, 700, 1200]) {
    const ms = foldDurationMs(px, BASE);
    assert.ok(ms >= prev, `${px}px gave ${ms}ms after ${prev}ms`);
    prev = ms;
  }
});

test('the clamp keeps every fold inside a believable range', () => {
  // A one-line panel must not feel instant, and a full-height one must not
  // turn into an event you sit through.
  assert.equal(foldDurationMs(1, BASE), Math.round(BASE * FOLD_MIN_SCALE));
  assert.equal(foldDurationMs(100000, BASE), Math.round(BASE * FOLD_MAX_SCALE));
});

test('a zero base duration means do not animate', () => {
  // This is the whole of the reduced-motion path: the token layer zeroes
  // --dur-normal, the caller resolves 0, and the fold becomes a plain jump.
  for (const base of [0, -1, NaN, undefined, null]) {
    assert.equal(foldDurationMs(300, base), 0, `base ${base}`);
  }
});

test('a nonsense distance degrades to the shortest fold, never to NaN', () => {
  for (const delta of [NaN, undefined, null, 'tall', {}]) {
    const ms = foldDurationMs(delta, BASE);
    assert.ok(Number.isFinite(ms), `${String(delta)} gave ${ms}`);
    assert.equal(ms, Math.round(BASE * FOLD_MIN_SCALE));
  }
});

test('the result is always a whole number of milliseconds', () => {
  for (const px of [7, 33, 261, 999]) {
    assert.equal(foldDurationMs(px, 333), Math.round(foldDurationMs(px, 333)));
  }
});

test('a theme that speeds the HUD up speeds the fold up proportionally', () => {
  assert.equal(foldDurationMs(FOLD_REF_PX, 120), 120);
  assert.equal(foldDurationMs(FOLD_REF_PX, 600), 600);
});

// ---- v0.10 3.4: fold direction ---------------------------------------------

test('a fold closes faster than it opens', () => {
  // Opening is a reveal and you are waiting on what is behind it; closing is a
  // dismissal. Pinned as a band rather than a single number so a retune stays
  // possible, but drifting out of "exit is shorter" would be a regression.
  const open = foldDurationMs(FOLD_REF_PX, 350);
  assert.ok(open > 0);
  assert.ok(Math.round(open * FOLD_EXIT_SCALE) < open, 'closing must be shorter');
  assert.ok(FOLD_EXIT_SCALE >= 0.6 && FOLD_EXIT_SCALE <= 0.7, 'stay in the 60-70% band');
});

// ---- v0.10 3.4: region rail -------------------------------------------------

test('regionColumn locates a region in the preset grid', () => {
  assert.equal(regionColumn(['left main right'], 'left'), 0);
  assert.equal(regionColumn(['left main right'], 'main'), 1);
  assert.equal(regionColumn(['left main right'], 'right'), 2);
});

test('regionColumn: the same column across several rows is fine', () => {
  assert.equal(regionColumn(['left main', 'left dock'], 'left'), 0);
});

test('regionColumn: a region spanning columns has no single track to shrink', () => {
  // Shrinking both would move the neighbours in ways nothing in panels.js can
  // predict, so it offers no handle at all - splitterPlan()'s answer, reached
  // from the other direction.
  assert.equal(regionColumn(['dock dock main'], 'dock'), null);
});

test('regionColumn: a region that changes column between rows is refused', () => {
  assert.equal(regionColumn(['left main', 'main left'], 'left'), null);
});

test('regionColumn: junk in, null out', () => {
  assert.equal(regionColumn(['left main'], 'nope'), null);
  assert.equal(regionColumn(['left main'], ''), null);
  assert.equal(regionColumn(null, 'left'), null);
  assert.equal(regionColumn([42], 'left'), null);
});

test('railTracks pins exactly one track to the rail width', () => {
  assert.deepEqual(railTracks(['260px', '1fr', '280px'], 2), ['260px', '1fr', `${RAIL_PX}px`]);
  assert.deepEqual(railTracks(['260px', '1fr', '280px'], 0), [`${RAIL_PX}px`, '1fr', '280px']);
});

test('railTracks refuses to rail the LAST elastic track', () => {
  // A row of nothing but fixed widths stops filling the window, and un-railing
  // something else cannot bring the slack back - there is nothing to bring.
  assert.equal(railTracks(['260px', '1fr'], 1), null);
  // Two elastic tracks: railing one still leaves something to absorb it.
  assert.deepEqual(railTracks(['1fr', '1fr'], 0), [`${RAIL_PX}px`, '1fr']);
  // A fixed track is always safe to rail, whatever else the row holds.
  assert.deepEqual(railTracks(['260px', '1fr'], 0), [`${RAIL_PX}px`, '1fr']);
});

test('railTracks refuses an index that is not a track', () => {
  assert.equal(railTracks(['1fr', '200px'], -1), null);
  assert.equal(railTracks(['1fr', '200px'], 2), null);
  assert.equal(railTracks(['1fr', '200px'], 1.5), null);
  assert.equal(railTracks(null, 0), null);
});

test('railTracks does not mutate the row it was handed', () => {
  const tracks = ['260px', '1fr'];
  railTracks(tracks, 0);
  assert.deepEqual(tracks, ['260px', '1fr'], 'applyRailState() re-derives from this');
});

test('every shipped preset can collapse at least one region', () => {
  // The guard that earns its place. A preset whose only non-terminal region
  // spans two columns, or holds the last elastic track, would ship a rail
  // toggle that never appears - and nothing else in the suite would say so.
  const { layouts } = loadLayouts();
  for (const layout of layouts) {
    const tracks = parseTracks(layout.columns);
    if (!tracks) continue; // this preset gets no splitters either; see splitterPlan()
    const termEntry = Object.entries(layout.slots).find(([, ids]) => ids.includes('terminal'));
    const termRegion = termEntry ? termEntry[0] : null;

    let railable = 0;
    for (const name of layout.regionOrder) {
      // The terminal region is bare - it has no panels to reduce to glyphs.
      if (name === termRegion) continue;
      const col = regionColumn(layout.areas, name);
      if (col !== null && railTracks(tracks, col)) railable += 1;
    }
    assert.ok(railable > 0, `${layout.id} offers no region that can be collapsed`);
  }
});
