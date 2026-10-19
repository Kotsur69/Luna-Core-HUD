// Phone offline queue (mobile/src/outbox.js): queued writes show at once,
// stay until the server holds them, and never shadow a newer server row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { enqueue, overlay, prune, without, isRejected } from '../mobile/src/outbox.js';
import { lists, addUnit, toggleUnit } from '../mobile/src/todomodel.js';

const require = createRequire(import.meta.url);
const rows = require('../src/cloudrows');

const KEY = 'git:github.com/kotsur69/luna-core-hud';
const NOW = 1_760_000_000_000;

/** What a pull would fold in after the server stored `units`. */
const pulled = (state, units, rev0) =>
  rows.applyRows(state, units.map((x, i) => ({ key: x.k, value: x.v, u: x.u, deleted_at: x.d, rev: rev0 + i + 1 })), NOW);

test('enqueue keeps the newest unit per key and leaves the input untouched', () => {
  const box = enqueue({}, [{ k: 'a', v: 1, u: 5, d: null }]);
  const next = enqueue(box, [
    { k: 'a', v: 2, u: 4, d: null },
    { k: 'b', v: null, u: 7, d: 7 },
  ]);
  assert.deepEqual(box, { a: { k: 'a', v: 1, u: 5, d: null } });
  assert.deepEqual(next, { a: { k: 'a', v: 1, u: 5, d: null }, b: { k: 'b', v: null, u: 7, d: 7 } });
  assert.deepEqual(enqueue(next, [{ k: 'a', v: 3, u: 6, d: null }]).a.v, 3);
});

test('enqueue skips prototype keys, bad stamps and units a pull could never confirm', () => {
  const box = enqueue(
    {},
    [
      { k: '__proto__', v: 1, u: 1, d: null },
      { k: 'constructor', v: 1, u: 1, d: null },
      { k: 'x', v: 1, u: 1.5, d: null },
      { k: 'y'.repeat(201), v: 1, u: 1, d: null },
      { k: 'ahead', v: 1, u: NOW + 2 * 24 * 3600e3, d: null },
    ],
    NOW,
  );
  assert.deepEqual(Object.keys(box), []);
  assert.equal(Object.getPrototypeOf(box), Object.prototype);
});

test('overlay shows queued units but never hides a newer server row', () => {
  const mirror = { a: { v: 'server', u: 10, d: null }, b: { v: 'old', u: 1, d: null } };
  const box = enqueue({}, [
    { k: 'a', v: 'phone', u: 9, d: null },
    { k: 'b', v: null, u: 2, d: 2 },
    { k: 'c', v: 'new', u: 3, d: null },
  ]);
  assert.deepEqual(overlay(mirror, box), {
    a: { v: 'server', u: 10, d: null },
    b: { v: null, u: 2, d: 2 },
    c: { v: 'new', u: 3, d: null },
  });
  assert.equal(mirror.b.v, 'old');
});

test('prune drops what the server holds at the same or a newer stamp', () => {
  const box = enqueue({}, [
    { k: 'a', v: 1, u: 5, d: null },
    { k: 'b', v: 1, u: 5, d: null },
    { k: 'c', v: 1, u: 5, d: null },
  ]);
  const left = prune(box, { a: { v: 1, u: 5, d: null }, b: { v: 2, u: 9, d: null }, c: { v: 0, u: 4, d: null } });
  assert.deepEqual(Object.keys(left), ['c']);
  assert.equal(prune(left, {}), left);
});

test('without drops sent units but keeps an edit queued after the send', () => {
  const sent = [
    { k: 'a', v: 1, u: 5, d: null },
    { k: 'b', v: 1, u: 5, d: null },
  ];
  const box = enqueue(enqueue({}, sent), [{ k: 'b', v: 2, u: 6, d: null }]);
  assert.deepEqual(Object.keys(without(box, sent)), ['b']);
  assert.equal(without(box, []), box);
});

test('only a refusal of the data itself drops a batch', () => {
  for (const s of [400, 409, 413]) assert.equal(isRejected(s), true);
  for (const s of [0, 401, 403, 408, 429, 500, 503]) assert.equal(isRejected(s), false);
});

test('an offline add then tick shows at once, and clears once the server has it', () => {
  let state = { cursor: 0, mirror: {}, pushed: {} };
  state = pulled(state, [{ k: `${KEY}:1`, v: { text: 'seed', done: false, at: 1 }, u: 1, d: null }], 0);

  const add = addUnit(KEY, 'buy milk', NOW);
  let box = enqueue({}, [add]);
  const item = lists(overlay(state.mirror, box))[0].items.find((i) => i.text === 'buy milk');
  // The tick stamps from the queued copy, so it orders after the add.
  const tick = toggleUnit(KEY, item, NOW);
  assert.ok(tick.u > add.u);
  box = enqueue(box, [tick]);
  assert.equal(Object.keys(box).length, 1);
  assert.equal(lists(overlay(state.mirror, box))[0].items.find((i) => i.text === 'buy milk').done, true);

  // Back online: the push landed, the next pull folds it in, the outbox empties.
  state = pulled(state, [tick], state.cursor);
  box = prune(box, state.mirror);
  assert.deepEqual(box, {});
  assert.equal(lists(state.mirror)[0].items.find((i) => i.text === 'buy milk').done, true);
});
