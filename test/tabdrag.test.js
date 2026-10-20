// ============================================================================
// LunaCore - session tab live-drag math tests (modules/tabdrag.js)
// ----------------------------------------------------------------------------
// tabdrag.js is pure and takes plain rect objects, so the whole reorder
// decision is testable with arrays. The important cross-check is the last one:
// the slot a live drag produces must be the same final index the old HTML5
// dropIndex() sent over `sessions:reorder`, because main.js was not changed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { targetSlot, siblingOffsets, clampDx } = require('../src/renderer/modules/tabdrag.js');

/** n tabs, 100px wide, 6px gap, starting at x=0. */
function bar(n, width = 100, gap = 6) {
  return Array.from({ length: n }, (_, i) => ({ left: i * (width + gap), width }));
}
const center = (r) => r.left + r.width / 2;

test('targetSlot: no movement stays in the same slot', () => {
  const rects = bar(4);
  for (let i = 0; i < 4; i++) assert.equal(targetSlot(rects, i, center(rects[i])), i);
});

test('targetSlot: right across one midpoint moves one slot', () => {
  const rects = bar(4);
  assert.equal(targetSlot(rects, 1, center(rects[2]) + 1), 2);
  assert.equal(targetSlot(rects, 1, center(rects[2]) - 1), 1, 'not past the midpoint yet');
});

test('targetSlot: right across several midpoints', () => {
  const rects = bar(5);
  assert.equal(targetSlot(rects, 0, center(rects[3]) + 1), 3);
});

test('targetSlot: left across one and several midpoints', () => {
  const rects = bar(5);
  assert.equal(targetSlot(rects, 3, center(rects[2]) - 1), 2);
  assert.equal(targetSlot(rects, 4, center(rects[1]) - 1), 1);
});

test('targetSlot: clamps at both ends', () => {
  const rects = bar(4);
  assert.equal(targetSlot(rects, 2, -10000), 0);
  assert.equal(targetSlot(rects, 1, 10000), 3);
});

test('targetSlot: a 1-tab bar only has slot 0', () => {
  const rects = bar(1);
  assert.equal(targetSlot(rects, 0, -500), 0);
  assert.equal(targetSlot(rects, 0, 500), 0);
});

test('clampDx: keeps the dragged tab inside the bar', () => {
  const rects = bar(3);
  assert.equal(clampDx(rects, 1, -1000), -106);
  assert.equal(clampDx(rects, 1, 1000), 106);
  assert.equal(clampDx(rects, 1, 20), 20);
  assert.equal(clampDx(bar(1), 0, 50), 0);
});

test('siblingOffsets: same slot moves nobody', () => {
  assert.deepEqual(siblingOffsets(bar(4), 1, 1, 106), [0, 0, 0, 0]);
});

test('siblingOffsets: dragging right pulls the tabs in between left', () => {
  assert.deepEqual(siblingOffsets(bar(5), 1, 3, 106), [0, 0, -106, -106, 0]);
});

test('siblingOffsets: dragging left pushes the tabs in between right', () => {
  assert.deepEqual(siblingOffsets(bar(5), 3, 0, 106), [106, 106, 106, 0, 0]);
});

test('siblingOffsets: 1-tab bar', () => {
  assert.deepEqual(siblingOffsets(bar(1), 0, 0, 106), [0]);
});

/** The old HTML5 code: drop beside `target`, on its left or right half. */
function oldDropIndex(from, target, after) {
  const slot = target + (after ? 1 : 0);
  return slot > from ? slot - 1 : slot;
}

test('final index matches the old dropIndex() semantics', () => {
  const n = 5;
  const rects = bar(n);
  for (let from = 0; from < n; from++) {
    for (let target = 0; target < n; target++) {
      if (target === from) continue;
      // Old: pointer in the target's right half -> after, left half -> before.
      // New: the dragged tab's centre at that same x.
      const rightHalf = center(rects[target]) + 10;
      const leftHalf = center(rects[target]) - 10;
      assert.equal(targetSlot(rects, from, rightHalf), oldDropIndex(from, target, true), `from ${from} after ${target}`);
      assert.equal(targetSlot(rects, from, leftHalf), oldDropIndex(from, target, false), `from ${from} before ${target}`);
    }
  }
});
