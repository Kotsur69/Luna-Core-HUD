// Tests for the pure half of C4: effectiveSlots() - merging a stored
// per-layout arrangement back over a preset - and arrangementFromEntries(),
// the shape that gets persisted. The drag wiring, grip decoration and FLIP are
// left to the manual checklist, the same line panels.test.js / layouts.test.js
// draw around their DOM halves.
//
// The rules every test here defends:
//   * a stored arrangement can reorder and re-home widgets, but never conjure
//     one the preset does not place, and never lose one it does (HEAL);
//   * `terminal` is pinned - it can never be moved by a stored map.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  effectiveSlots,
  arrangementFromEntries,
  PINNED,
} = require('../src/renderer/modules/widgetarrange.js');

/** A stand-in for a normalized layout (see src/layouts.js normalizeLayout). */
function layout(slots, regionOrder) {
  return {
    id: 'test',
    regionOrder: regionOrder || Object.keys(slots),
    slots,
  };
}

const PRESET = {
  left: ['actions', 'appearance', 'project'],
  main: ['terminal'],
  right: ['context', 'usage', 'media', 'ports'],
};

// ---- effectiveSlots: no override -----------------------------------------

test('no override returns the preset arrangement, region for region', () => {
  const out = effectiveSlots(layout(PRESET), null);
  assert.deepEqual(out, PRESET);
});

test('no override returns a fresh object, not the preset itself', () => {
  const l = layout(PRESET);
  const out = effectiveSlots(l, null);
  assert.notEqual(out, l.slots);
  assert.notEqual(out.right, l.slots.right);
});

test('every region in regionOrder is a key in the result, even if empty', () => {
  const out = effectiveSlots(layout({ left: [], main: ['terminal'], right: [] }), {});
  assert.deepEqual(Object.keys(out), ['left', 'main', 'right']);
  assert.deepEqual(out.left, []);
});

// ---- effectiveSlots: reorder + re-home ---------------------------------------

test('an override reorders widgets within a region', () => {
  const out = effectiveSlots(layout(PRESET), {
    right: ['ports', 'context', 'usage', 'media'],
  });
  assert.deepEqual(out.right, ['ports', 'context', 'usage', 'media']);
});

test('an override moves a widget to another region and drops it from the first', () => {
  const out = effectiveSlots(layout(PRESET), {
    left: ['actions', 'media', 'appearance', 'project'],
    right: ['context', 'usage', 'ports'],
  });
  assert.deepEqual(out.left, ['actions', 'media', 'appearance', 'project']);
  assert.deepEqual(out.right, ['context', 'usage', 'ports']);
});

// ---- effectiveSlots: heal -------------------------------------------------

test('a preset widget the override never mentions is appended to its region', () => {
  // override forgets `ports` entirely
  const out = effectiveSlots(layout(PRESET), {
    right: ['media', 'context', 'usage'],
  });
  assert.deepEqual(out.right, ['media', 'context', 'usage', 'ports']);
});

test('a widget added to the preset in a newer build lands in its authored region', () => {
  const withNew = { ...PRESET, right: [...PRESET.right, 'weather'] };
  // stored map was written before `weather` existed
  const out = effectiveSlots(layout(withNew), {
    right: ['ports', 'media', 'context', 'usage'],
    left: ['actions', 'appearance', 'project'],
  });
  assert.deepEqual(out.right, ['ports', 'media', 'context', 'usage', 'weather']);
});

test('a stale id in the override - not placed by the preset - is dropped', () => {
  const out = effectiveSlots(layout(PRESET), {
    right: ['context', 'ghost', 'usage', 'media', 'ports'],
  });
  assert.deepEqual(out.right, ['context', 'usage', 'media', 'ports']);
});

test('an id repeated across two override regions is kept once, first region wins', () => {
  const out = effectiveSlots(layout(PRESET), {
    left: ['actions', 'media', 'appearance', 'project'],
    right: ['context', 'media', 'usage', 'ports'],
  });
  assert.deepEqual(out.left, ['actions', 'media', 'appearance', 'project']);
  assert.deepEqual(out.right, ['context', 'usage', 'ports']);
});

test('an override region the preset does not define is ignored, its valid ids healed home', () => {
  const out = effectiveSlots(layout(PRESET), {
    sidebar: ['media', 'usage'],
    right: ['context', 'ports'],
  });
  assert.equal(out.sidebar, undefined);
  // media + usage were only named under the bogus region, so heal puts them
  // back in `right` (their preset home), after the ids the override did order.
  assert.deepEqual(out.right, ['context', 'ports', 'usage', 'media']);
});

// ---- effectiveSlots: terminal is pinned ----------------------------------

test('PINNED lists terminal', () => {
  assert.ok(PINNED.includes('terminal'));
});

test('an override cannot move terminal out of its authored region', () => {
  const out = effectiveSlots(layout(PRESET), {
    main: [],
    right: ['terminal', 'context', 'usage', 'media', 'ports'],
  });
  assert.deepEqual(out.main, ['terminal']);
  assert.deepEqual(out.right, ['context', 'usage', 'media', 'ports']);
});

test('an override that simply omits terminal still gets it healed back', () => {
  const out = effectiveSlots(layout(PRESET), { main: [] });
  assert.deepEqual(out.main, ['terminal']);
});

// ---- arrangementFromEntries -----------------------------------------------

test('arrangementFromEntries keeps DOM order and drops pinned + empty regions', () => {
  const out = arrangementFromEntries([
    { region: 'left', ids: ['actions', 'appearance'] },
    { region: 'main', ids: ['terminal'] },
    { region: 'right', ids: ['media', 'context'] },
  ]);
  assert.deepEqual(out, {
    left: ['actions', 'appearance'],
    right: ['media', 'context'],
  });
});

test('arrangementFromEntries tolerates junk entries', () => {
  const out = arrangementFromEntries([
    { region: '', ids: ['x'] },
    { region: 'left', ids: 'nope' },
    { region: 'right', ids: ['media', 42, null, 'context'] },
    null,
  ]);
  assert.deepEqual(out, { right: ['media', 'context'] });
});
