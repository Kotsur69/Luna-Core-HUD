// ============================================================================
// LunaCore - lunar phase maths tests
// ----------------------------------------------------------------------------
// modules/moonphase.js is pure, so this file exercises it directly - no DOM,
// same shape as test/hotkeys.test.js. Two things it guards:
//
//   1. the cycle is anchored correctly - real new/full moon dates come back as
//      ~0% / ~100% lit;
//   2. the SVG path builder stays well formed at the awkward fractions (new,
//      the quarters, full), where an arc radius passes through zero.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SYNODIC_MONTH_MS,
  NEW_MOON_EPOCH_MS,
  PHASE_KEYS,
  phaseFraction,
  illumination,
  phaseName,
  terminatorGeometry,
  moonLitPath,
} = require('../src/renderer/modules/moonphase.js');

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
// Phase is cyclic: 0.9999999 and 0.0000001 are the same moment. Compare the
// shorter way round the circle.
const cyclic = (a, b) => {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
};

test('phaseFraction is 0 at the epoch and after a whole cycle', () => {
  assert.ok(cyclic(phaseFraction(NEW_MOON_EPOCH_MS), 0) < 1e-6);
  assert.ok(cyclic(phaseFraction(NEW_MOON_EPOCH_MS + SYNODIC_MONTH_MS), 0) < 1e-6);
  assert.ok(cyclic(phaseFraction(NEW_MOON_EPOCH_MS + SYNODIC_MONTH_MS / 2), 0.5) < 1e-6);
});

test('phaseFraction always lands in [0, 1), including before the epoch', () => {
  const samples = [
    Date.UTC(1970, 0, 1),
    Date.UTC(1999, 5, 15),
    NEW_MOON_EPOCH_MS - SYNODIC_MONTH_MS * 3.3,
    Date.now(),
    Date.UTC(2100, 11, 31),
  ];
  for (const ms of samples) {
    const f = phaseFraction(ms);
    assert.ok(f >= 0 && f < 1, `out of range for ${new Date(ms).toISOString()}: ${f}`);
  }
});

test('phaseFraction accepts a Date and rejects junk to 0', () => {
  assert.equal(typeof phaseFraction(new Date()), 'number');
  assert.equal(phaseFraction(NaN), 0);
  assert.equal(phaseFraction('not a date'), 0);
  assert.equal(phaseFraction(Infinity), 0);
});

test('illumination matches the known shape of the cycle', () => {
  assert.ok(approx(illumination(0), 0));
  assert.ok(approx(illumination(0.5), 1));
  assert.ok(approx(illumination(0.25), 0.5));
  assert.ok(approx(illumination(0.75), 0.5));
  assert.ok(approx(illumination(1), 0)); // wraps
});

test('real new and full moons come back at the right brightness', () => {
  // Full moon (Wolf Moon): 2024-01-25 17:54 UTC.
  assert.ok(illumination(phaseFraction(Date.UTC(2024, 0, 25, 17, 54))) > 0.95);
  // New moon: 2024-02-09 22:59 UTC.
  assert.ok(illumination(phaseFraction(Date.UTC(2024, 1, 9, 22, 59))) < 0.05);
  // Full moon: 2024-08-19 18:26 UTC.
  assert.ok(illumination(phaseFraction(Date.UTC(2024, 7, 19, 18, 26))) > 0.95);
});

test('phaseName picks the band a fraction sits in', () => {
  assert.equal(phaseName(0), 'brand.moon.new');
  assert.equal(phaseName(0.25), 'brand.moon.firstQuarter');
  assert.equal(phaseName(0.5), 'brand.moon.full');
  assert.equal(phaseName(0.75), 'brand.moon.lastQuarter');
  assert.equal(phaseName(0.125), 'brand.moon.waxingCrescent');
  assert.equal(phaseName(0.625), 'brand.moon.waningGibbous');
  assert.equal(phaseName(1), 'brand.moon.new'); // wraps
  assert.equal(phaseName(-0.01), 'brand.moon.new'); // wraps
});

test('phaseName only ever returns a known key', () => {
  for (let i = 0; i <= 200; i++) {
    assert.ok(PHASE_KEYS.includes(phaseName(i / 200)));
  }
});

test('terminatorGeometry reports the lit side and bow direction', () => {
  assert.equal(terminatorGeometry(0.2).litSide, 'right'); // waxing
  assert.equal(terminatorGeometry(0.8).litSide, 'left'); // waning
  assert.equal(terminatorGeometry(0.1).crescent, true); // < half lit
  assert.equal(terminatorGeometry(0.4).crescent, false); // gibbous
  for (let i = 0; i <= 100; i++) {
    const g = terminatorGeometry(i / 100);
    assert.ok(g.terminatorRx >= 0 && g.terminatorRx <= 1);
    assert.ok(approx(g.illum, illumination(i / 100)));
  }
});

test('moonLitPath is well formed at the awkward fractions', () => {
  for (const f of [0, 0.25, 0.5, 0.75, 0.999]) {
    const d = moonLitPath(40, f);
    assert.match(d, /^M 0 -40 /);
    assert.match(d, / Z$/);
    assert.ok(!/NaN|undefined/.test(d), `malformed path at ${f}: ${d}`);
  }
});

test('moonLitPath draws a full disc at full moon and a diameter at the quarters', () => {
  // Full: terminator arc has the disc's own radius (40) and closes the circle.
  assert.equal(moonLitPath(40, 0.5), 'M 0 -40 A 40 40 0 0 0 0 40 A 40 40 0 0 1 0 -40 Z');
  // First quarter: terminator radius collapses to 0 -> straight vertical edge.
  assert.match(moonLitPath(40, 0.25), /A 0 40 0 0 1 0 -40 Z$/);
});
