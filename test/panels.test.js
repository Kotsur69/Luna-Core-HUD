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
