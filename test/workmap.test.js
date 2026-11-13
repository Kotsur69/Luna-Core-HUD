// ============================================================================
// Live map, Sessions tab (src/renderer/modules/workmap.js): the pure helpers
// ----------------------------------------------------------------------------
// Station placement and spoke geometry, the context ring (and the 0..1 vs
// 0..100 percent the feeds disagree on), the per-frame call deltas that
// decide which pulses travel, the reduced-motion gate, the Memory station's
// extension point, and the pl / en strings the map builds at runtime.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const W = require('../src/renderer/modules/workmap.js');
const { STATIONS, createTabState } = require('../src/renderer/modules/workmapmodel.js');

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// --- station placement ----------------------------------------------------------

test('stationLayout puts the first station at 12 o\'clock and goes clockwise', () => {
  const pos = W.stationLayout(['a', 'b', 'c', 'd'], { cx: 100, cy: 100, r: 50 });
  assert.deepEqual(pos.map((p) => p.id), ['a', 'b', 'c', 'd']);
  assert.ok(near(pos[0].x, 100) && near(pos[0].y, 50), 'top');
  assert.ok(near(pos[1].x, 150) && near(pos[1].y, 100), 'right');
  assert.ok(near(pos[2].x, 100) && near(pos[2].y, 150), 'bottom');
  assert.ok(near(pos[3].x, 50) && near(pos[3].y, 100), 'left');
});

test('every work-map station sits on the orbit, evenly spaced, inside the view', () => {
  const pos = W.stationLayout(STATIONS);
  assert.equal(pos.length, STATIONS.length);
  // A text line needs about this much above its baseline, and a little below.
  const ascent = 12;
  const descent = 4;
  for (const p of pos) {
    assert.ok(near(Math.hypot(p.x - W.CENTER.x, p.y - W.CENTER.y), W.ORBIT_R, 0.05), p.id);
    assert.ok(p.x - W.STATION_R >= 0 && p.x + W.STATION_R <= W.VIEW.w, `${p.id} x`);
    // The disc and both text lines stay inside the viewBox.
    const ys = W.stationLabelY(p);
    const top = Math.min(p.y - W.STATION_R, ys.name - ascent);
    const bottom = Math.max(p.y + W.STATION_R, ys.status + descent);
    assert.ok(top >= 0 && bottom <= W.VIEW.h, `${p.id} y: ${top}..${bottom}`);
  }
  const steps = pos.slice(1).map((p, i) => p.angleDeg - pos[i].angleDeg);
  for (const s of steps) assert.ok(near(s, 360 / STATIONS.length));
});

test('stations never overlap the context ring or each other', () => {
  const pos = W.stationLayout(STATIONS);
  for (const p of pos) assert.ok(Math.hypot(p.x - W.CENTER.x, p.y - W.CENTER.y) - W.STATION_R > W.RING_R + 20, p.id);
  for (let i = 0; i < pos.length; i += 1) {
    const next = pos[(i + 1) % pos.length];
    assert.ok(Math.hypot(next.x - pos[i].x, next.y - pos[i].y) > W.STATION_R * 2 + 20, `${pos[i].id}/${next.id}`);
  }
});

test('station labels sit on the outer side, never on the spoke', () => {
  for (const p of W.stationLayout(STATIONS)) {
    const ys = W.stationLabelY(p);
    if (p.y < W.CENTER.y - 1) {
      // Upper half: the spoke leaves the disc downwards, the text goes above.
      assert.ok(ys.name < ys.status && ys.status < p.y - W.STATION_R, p.id);
    } else {
      assert.ok(ys.name > p.y + W.STATION_R && ys.status > ys.name, p.id);
    }
  }
});

test('stationLayout copes with no list, one station and junk options', () => {
  assert.deepEqual(W.stationLayout(undefined), []);
  assert.deepEqual(W.stationLayout([]), []);
  const [one] = W.stationLayout(['x'], { cx: 'a', r: NaN });
  assert.ok(near(one.x, W.CENTER.x) && near(one.y, W.CENTER.y - W.ORBIT_R));
});

// --- spokes --------------------------------------------------------------------

test('spokeOf runs between the two edges along the centre line', () => {
  const s = W.spokeOf({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20);
  assert.deepEqual(s, { x1: 10, y1: 0, x2: 80, y2: 0 });
  const d = W.spokeOf({ x: 0, y: 0 }, { x: 30, y: 40 }, 5, 5);
  assert.ok(near(d.x1, 3) && near(d.y1, 4) && near(d.x2, 27) && near(d.y2, 36));
});

test('spokeOf of two equal points does not divide by zero', () => {
  assert.deepEqual(W.spokeOf({ x: 5, y: 5 }, { x: 5, y: 5 }, 3, 3), { x1: 5, y1: 5, x2: 5, y2: 5 });
});

// --- context ring ---------------------------------------------------------------

test('ringDash fills the given share of the circumference, clamped', () => {
  const r = 10;
  const c = 2 * Math.PI * r;
  const half = W.ringDash(0.5, r);
  const [filled, gap] = half.dasharray.split(' ').map(Number);
  assert.ok(near(filled, c / 2) && near(gap, c));
  assert.ok(W.ringDash(2, r).dasharray.startsWith(`${Math.round(c * 100) / 100} `));
  assert.ok(W.ringDash(-1, r).dasharray.startsWith('0 '));
  assert.ok(W.ringDash(null, r).dasharray.startsWith('0 '));
});

test('contextFraction prefers tokens / limit and reads percent as 0..1 or 0..100', () => {
  assert.equal(W.contextFraction({ contextTokens: 50000, contextLimit: 200000, contextPercent: 99 }), 0.25);
  // observer.js sends a 0..1 share.
  assert.equal(W.contextFraction({ contextPercent: 0.4 }), 0.4);
  assert.equal(W.contextFraction({ contextPercent: 1 }), 1);
  // workmapmodel.js documents 0..100.
  assert.equal(W.contextFraction({ contextPercent: 62 }), 0.62);
  assert.equal(W.contextFraction({ contextTokens: 900, contextLimit: 100 }), 1);
  assert.equal(W.contextFraction({ contextTokens: 5, contextLimit: 0, contextPercent: null }), null);
  assert.equal(W.contextFraction(createTabState()), null);
  assert.equal(W.contextFraction(null), null);
  assert.equal(W.contextFraction('x'), null);
});

test('contextLevel uses the HUD thresholds', () => {
  const { CTX_WARN_MID, CTX_WARN_HIGH } = require('../src/renderer/modules/thresholds.js');
  assert.equal(W.contextLevel(null), 'none');
  assert.equal(W.contextLevel(0.1), 'calm');
  assert.equal(W.contextLevel(CTX_WARN_MID), 'mid');
  assert.equal(W.contextLevel(CTX_WARN_HIGH), 'high');
  assert.equal(W.contextLevel(1), 'high');
});

// --- call deltas (which pulses travel) ---------------------------------------------

function tabWith(patch) {
  const tab = createTabState();
  const stations = { ...tab.stations };
  for (const [id, p] of Object.entries(patch)) stations[id] = { ...stations[id], ...p };
  return { ...tab, stations };
}

test('callDeltas counts starts, ends and failures per station', () => {
  const prev = tabWith({ shell: { total: 2, inFlight: 1 }, mcp: { total: 1, inFlight: 1 } });
  const next = tabWith({ shell: { total: 4, inFlight: 1 }, mcp: { total: 1, inFlight: 0, errors: 1 } });
  const d = W.callDeltas(prev, next);
  // Two shell calls started; one of them (or the old one) finished in the same frame.
  assert.deepEqual(d.shell, { started: 2, ended: 2, failed: 0 });
  assert.deepEqual(d.mcp, { started: 0, ended: 1, failed: 1 });
  assert.deepEqual(d.files, { started: 0, ended: 0, failed: 0 });
  assert.deepEqual(Object.keys(d).sort(), [...STATIONS].sort());
});

test('callDeltas sends nothing on a first paint or a tab switch', () => {
  const next = tabWith({ files: { total: 9, inFlight: 3 } });
  const d = W.callDeltas(null, next);
  for (const id of STATIONS) assert.deepEqual(d[id], { started: 0, ended: 0, failed: 0 });
});

test('callDeltas never goes negative (a tab reset drops in-flight calls)', () => {
  const prev = tabWith({ agents: { total: 3, inFlight: 2 } });
  const next = tabWith({ agents: { total: 3, inFlight: 0 } });
  assert.deepEqual(W.callDeltas(prev, next).agents, { started: 0, ended: 2, failed: 0 });
  const weird = tabWith({ agents: { total: 1, inFlight: 0 } });
  assert.deepEqual(W.callDeltas(prev, weird).agents, { started: 0, ended: 2, failed: 0 });
});

// --- motion gate, counts ------------------------------------------------------------

test('travelAllowed: pulses only without reduced motion and outside the off / reduced axis', () => {
  assert.equal(W.travelAllowed(false, undefined), true);
  assert.equal(W.travelAllowed(false, 'full'), true);
  assert.equal(W.travelAllowed(true, undefined), false);
  assert.equal(W.travelAllowed(false, 'off'), false);
  assert.equal(W.travelAllowed(false, 'reduced'), false);
});

test('compactCount keeps a station count short', () => {
  assert.equal(W.compactCount(0), '0');
  assert.equal(W.compactCount(-3), '0');
  assert.equal(W.compactCount(NaN), '0');
  assert.equal(W.compactCount(7.9), '7');
  assert.equal(W.compactCount(999), '999');
  assert.equal(W.compactCount(1234), '1.2k');
  assert.equal(W.compactCount(45678), '45k');
});

// --- Memory station extension point -----------------------------------------------

test('memoryInfoOf keeps valid counts and the card mark, drops junk', () => {
  assert.deepEqual(W.memoryInfoOf({ memories: 3, cardLoaded: true }), { memories: 3, cardLoaded: true });
  assert.deepEqual(W.memoryInfoOf({ cardLoaded: false }), { memories: null, cardLoaded: false });
  assert.deepEqual(W.memoryInfoOf({ memories: 0 }), { memories: 0, cardLoaded: null });
  assert.equal(W.memoryInfoOf({ memories: -1, cardLoaded: 'yes' }), null);
  assert.equal(W.memoryInfoOf({ memories: 1.5 }), null);
  assert.equal(W.memoryInfoOf(null), null);
  assert.equal(W.memoryInfoOf('3'), null);
});

test('setMemoryStationInfo stores per session and clears on null', () => {
  W.setMemoryStationInfo('tab-a', { memories: 4, cardLoaded: true });
  W.setMemoryStationInfo('tab-b', { cardLoaded: false });
  assert.deepEqual(W.memoryStationInfo('tab-a'), { memories: 4, cardLoaded: true });
  assert.deepEqual(W.memoryStationInfo('tab-b'), { memories: null, cardLoaded: false });
  W.setMemoryStationInfo('tab-a', null);
  assert.equal(W.memoryStationInfo('tab-a'), null);
  // A bad session id is ignored, never thrown on.
  W.setMemoryStationInfo('', { memories: 1 });
  W.setMemoryStationInfo(42, { memories: 1 });
  assert.equal(W.memoryStationInfo(''), null);
  W.setMemoryStationInfo('tab-b', undefined);
  assert.equal(W.memoryStationInfo('tab-b'), null);
});

// --- strings --------------------------------------------------------------------

test('every work-map string exists in pl and en, without Polish diacritics', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/i18n.js'), 'utf8');
  const enAt = src.indexOf('\n  en: {');
  const pl = src.slice(0, enAt);
  const en = src.slice(enAt);
  const view = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/modules/workmap.js'), 'utf8');
  const keys = new Set([...view.matchAll(/'(lm\.wm\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]));
  // Built at runtime: one name per station.
  for (const id of STATIONS) keys.add(`lm.wm.station.${id}`);
  assert.ok(keys.size >= 20, `found only ${keys.size} keys`);
  for (const key of keys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en: ${key}`);
  }
  for (const line of pl.split('\n').filter((l) => /^\s*'lm\.wm\./.test(l))) assert.doesNotMatch(line, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, line);
});
