// ============================================================================
// LunaCore - cloud rows <-> sync peers (src/cloudrows.js)
// ----------------------------------------------------------------------------
// The cloud stores one row per unit; lifesync.js / todosync.js merge peers of
// a fixed shape. These mappings must be lossless both ways, keep tombstones,
// and never push a unit the cloud already has.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rows = require('../src/cloudrows.js');

test('cloud config: valid url + key, anything else is off', () => {
  const ok = { url: 'https://abc.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnop' };
  assert.deepEqual(rows.parseCloudConfig(ok), ok);
  assert.deepEqual(rows.parseCloudConfig({ ...ok, url: 'https://abc.supabase.co/' }), ok);
  assert.equal(rows.parseCloudConfig(null), null);
  assert.equal(rows.parseCloudConfig({ ...ok, url: 'http://abc.supabase.co' }), null);
  assert.equal(rows.parseCloudConfig({ ...ok, url: 'https://evil.example.com' }), null);
  assert.equal(rows.parseCloudConfig({ ...ok, url: 'https://abc.supabase.co/x?y' }), null);
  assert.equal(rows.parseCloudConfig({ url: ok.url }), null);
  assert.equal(rows.parseCloudConfig({ ...ok, publishableKey: 'has space in it 123456' }), null);
  assert.equal(rows.parseCloudConfig({ ...ok, publishableKey: 'short' }), null);
});

test('to-do key splits at the last colon', () => {
  assert.deepEqual(rows.splitTodoKey('local:home:1760000000000'), ['local:home', 1760000000000]);
  assert.deepEqual(rows.splitTodoKey('git:github.com/x/y:42'), ['git:github.com/x/y', 42]);
  assert.deepEqual(rows.splitTodoKey('local:a:b:7'), ['local:a:b', 7]);
  assert.equal(rows.splitTodoKey('local:home'), null);
  assert.equal(rows.splitTodoKey('local:home:0'), null);
  assert.equal(rows.splitTodoKey(':5'), null);
  assert.equal(rows.splitTodoKey('local:home:12x'), null);
});

test('applyRows: mirror + cursor + pushed advance, input untouched', () => {
  const state = { cursor: 3, mirror: { a: { v: { x: 1 }, u: 10, d: null } }, pushed: { a: 10 } };
  const frozen = JSON.stringify(state);
  const next = rows.applyRows(state, [
    { key: 'a', value: { x: 2 }, u: 20, deleted_at: null, rev: 5 },
    { key: 'b', value: null, u: 30, deleted_at: 30, rev: 4 },
  ]);
  assert.equal(JSON.stringify(state), frozen);
  assert.equal(next.cursor, 5);
  assert.deepEqual(next.mirror.a, { v: { x: 2 }, u: 20, d: null });
  assert.deepEqual(next.mirror.b, { v: null, u: 30, d: 30 });
  // The cloud has these now: pushing them back would be an echo.
  assert.deepEqual(next.pushed, { a: 20, b: 30 });
});

test('applyRows: an older row never lowers what we already pushed', () => {
  const next = rows.applyRows({ cursor: 0, mirror: {}, pushed: { a: 50 } }, [{ key: 'a', value: {}, u: 20, deleted_at: null, rev: 1 }]);
  assert.equal(next.pushed.a, 50);
});

test('applyRows: bigint columns arriving as strings still work, junk rows are skipped', () => {
  const next = rows.applyRows({ cursor: 0, mirror: {}, pushed: {} }, [
    { key: 'a', value: { y: 1 }, u: '20', deleted_at: null, rev: '7' },
    { key: 5, value: {}, u: 1, rev: 8 },
    { key: 'c', value: {}, u: 'nope', rev: 9 },
  ]);
  assert.deepEqual(Object.keys(next.mirror), ['a']);
  assert.equal(next.mirror.a.u, 20);
  assert.equal(next.cursor, 9);
});

test('life: mirror -> peer with tombstones in gone', () => {
  const peer = rows.lifePeer({
    'e:x1': { v: { id: 'x1' }, u: 10, d: null },
    'e:x2': { v: null, u: 20, d: 20 },
  });
  assert.deepEqual(peer, { units: [{ k: 'e:x1', v: { id: 'x1' }, u: 10 }], gone: { 'e:x2': 20 } });
});

test('life: published doc -> units incl. tombstones not shadowed by a live unit', () => {
  const units = rows.lifeUnits({
    units: [{ k: 'income', v: { amount: 1 }, u: 5 }],
    gone: { 'e:x2': 20, income: 3 },
  });
  assert.deepEqual(units, [
    { k: 'income', v: { amount: 1 }, u: 5, d: null },
    { k: 'e:x2', v: null, u: 20, d: 20 },
  ]);
});

test('to-dos: mirror -> peer grouped by project, key decides `at`', () => {
  const peer = rows.todoPeer({
    'local:home:100': { v: { text: 'milk', done: false, at: 999 }, u: 11, d: null },
    'local:home:200': { v: null, u: 12, d: 12 },
    'git:github.com/x/y:300': { v: { text: 'fix', done: true, at: 300 }, u: 13, d: null },
    junk: { v: { text: 'x' }, u: 1, d: null },
  });
  assert.deepEqual(peer, {
    'local:home': { items: [{ text: 'milk', done: false, at: 100, u: 11 }], gone: { 200: 12 } },
    'git:github.com/x/y': { items: [{ text: 'fix', done: true, at: 300, u: 13 }], gone: {} },
  });
});

test('to-dos: published doc -> units, `u` stripped from the value', () => {
  const units = rows.todoUnits({
    'local:home': { items: [{ text: 'milk', done: false, at: 100, u: 11 }], gone: { 200: 12 } },
  });
  assert.deepEqual(units, [
    { k: 'local:home:100', v: { text: 'milk', done: false, at: 100 }, u: 11, d: null },
    { k: 'local:home:200', v: null, u: 12, d: 12 },
  ]);
});

test('to-dos: a key too long for the cloud column is skipped', () => {
  const long = `local:${'a'.repeat(200)}`;
  assert.deepEqual(rows.todoUnits({ [long]: { items: [{ text: 'x', done: false, at: 1, u: 1 }], gone: {} } }), []);
});

test('unpushed: only newer than pushed, one per key (newest), input untouched', () => {
  const units = [
    { k: 'a', v: {}, u: 10, d: null },
    { k: 'b', v: {}, u: 5, d: null },
    { k: 'c', v: {}, u: 7, d: null },
    { k: 'c', v: null, u: 9, d: 9 },
  ];
  const out = rows.unpushed(units, { a: 10, b: 4 });
  assert.deepEqual(out, [
    { k: 'b', v: {}, u: 5, d: null },
    { k: 'c', v: null, u: 9, d: 9 },
  ]);
});

test('hostile keys from the server never crash or pollute the peers', () => {
  const mirror = rows.applyRows({ cursor: 0, mirror: {}, pushed: {} }, [
    { key: '__proto__:5', value: { text: 'x', done: false, at: 5 }, u: 1, deleted_at: null, rev: 1 },
    { key: 'constructor:6', value: { text: 'y', done: false, at: 6 }, u: 1, deleted_at: null, rev: 2 },
    { key: 'toString:7', value: null, u: 1, deleted_at: 1, rev: 3 },
    { key: '__proto__', value: { id: 'x' }, u: 1, deleted_at: null, rev: 4 },
  ]).mirror;
  assert.doesNotThrow(() => rows.todoPeer(mirror));
  assert.doesNotThrow(() => rows.lifePeer(mirror));
  assert.equal({}.text, undefined);
});

test('applyRows: a far-future or oversized row is dropped (it would block pushes forever)', () => {
  const now = 1_000_000;
  const next = rows.applyRows({ cursor: 0, mirror: {}, pushed: {} }, [
    { key: 'a', value: {}, u: now + 2 * 864e5, deleted_at: null, rev: 1 },
    { key: 'x'.repeat(201), value: {}, u: 1, deleted_at: null, rev: 2 },
    { key: 'b', value: {}, u: now, deleted_at: null, rev: 3 },
  ], now);
  assert.deepEqual(Object.keys(next.mirror), ['b']);
  assert.equal(next.pushed.a, undefined);
  assert.equal(next.cursor, 3);
});

test('fractional stamps (an old mtimeMs) go out as whole ms - the cloud column is bigint', () => {
  const [life] = rows.lifeUnits({ units: [{ k: 'income', v: {}, u: 1791972919873.1597 }], gone: { 'e:x': 5.5 } }).slice(0, 1);
  assert.equal(life.u, 1791972919873);
  const dead = rows.lifeUnits({ units: [], gone: { 'e:x': 5.5 } })[0];
  assert.deepEqual([dead.u, dead.d], [5, 5]);
  const [todo] = rows.todoUnits({ 'local:home': { items: [{ text: 'a', done: false, at: 1, u: 7.9 }], gone: {} } });
  assert.equal(todo.u, 7);
  // Already pushed as 1791972919873: the float local copy is not pending again.
  assert.deepEqual(rows.unpushed([life], { income: 1791972919873 }), []);
});
