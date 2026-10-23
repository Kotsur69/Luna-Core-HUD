// Phone to-do model (mobile/src/todomodel.js): what the phone writes must be
// accepted unchanged by a PC's todosync.validPeerProjects().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lists, addUnit, toggleUnit, toggleManualUnit, toggleTagUnit, hasTag, deleteUnit, projectName, STEER_TAG } from '../mobile/src/todomodel.js';

const require = createRequire(import.meta.url);
const rows = require('../src/cloudrows');
const { validPeerProjects } = require('../src/todosync');

const KEY = 'git:github.com/kotsur69/luna-core-hud';
const NOW = 1_760_000_000_000;

/** Units as the cloud would hand them back, folded into a mirror. */
const mirrorOf = (units) =>
  rows.applyRows({ cursor: 0, mirror: {}, pushed: {} }, units.map((x, i) => ({ key: x.k, value: x.v, u: x.u, deleted_at: x.d, rev: i + 1 })), NOW).mirror;

test('a unit added on the phone survives a PC peer validation unchanged', () => {
  const unit = addUnit(KEY, '  buy milk  ', NOW);
  assert.deepEqual(unit, { k: `${KEY}:${NOW}`, v: { text: 'buy milk', done: false, at: NOW }, u: NOW, d: null });
  const peer = validPeerProjects(rows.todoPeer(mirrorOf([unit])), NOW);
  assert.deepEqual(peer[KEY].items, [{ text: 'buy milk', done: false, at: NOW, u: NOW }]);
});

test('addUnit refuses empty text and keys a PC would drop', () => {
  assert.equal(addUnit(KEY, '   ', NOW), null);
  assert.equal(addUnit('other', 'x', NOW), null);
  assert.equal(addUnit('not a key', 'x', NOW), null);
});

test('lists validates, groups, names and orders open items first', () => {
  const mirror = mirrorOf([
    { k: `${KEY}:5`, v: { text: 'done one', done: true, at: 5 }, u: 10, d: null },
    { k: `${KEY}:7`, v: { text: 'open', done: false, at: 7 }, u: 10, d: null },
    { k: 'local:home:3', v: { text: 'home task', done: false, at: 3 }, u: 10, d: null },
    { k: `${KEY}:9`, v: null, u: 11, d: 11 },
    { k: `${KEY}:8`, v: { text: '' }, u: 10, d: null },
    { k: 'bad key:4', v: { text: 'x' }, u: 10, d: null },
  ]);
  const out = lists(mirror);
  assert.deepEqual(out.map((l) => l.name), ['home', 'luna-core-hud']);
  assert.deepEqual(out[1].items.map((i) => i.text), ['open', 'done one']);
});

test('toggle and delete stamp past the previous version, even with a clock behind', () => {
  const item = { text: 'x', done: false, at: 7, u: NOW + 5000, details: 'card' };
  const t = toggleUnit(KEY, item, NOW);
  assert.equal(t.u, NOW + 5001);
  assert.deepEqual(t.v, { text: 'x', done: true, at: 7, details: 'card' });
  const d = deleteUnit(KEY, item, NOW + 10_000);
  assert.deepEqual(d, { k: `${KEY}:7`, v: null, u: NOW + 10_000, d: NOW + 10_000 });
});

test('projectName shows the repo or bucket name', () => {
  assert.equal(projectName(KEY), 'luna-core-hud');
  assert.equal(projectName('local:safetyhub-bhp'), 'safetyhub-bhp');
});

test('toggleManualUnit sets and clears manual, and a PC peer accepts both', () => {
  const item = { text: 'call the bank', done: false, at: 7, u: 10 };
  const on = toggleManualUnit(KEY, item, NOW);
  assert.deepEqual(on, { k: `${KEY}:7`, v: { text: 'call the bank', done: false, at: 7, manual: true }, u: NOW, d: null });
  const peer = validPeerProjects(rows.todoPeer(mirrorOf([on])), NOW);
  assert.equal(peer[KEY].items[0].manual, true, 'the flag syncs to a PC');
  const off = toggleManualUnit(KEY, { ...on.v, u: on.u }, NOW);
  assert.deepEqual(off.v, { text: 'call the bank', done: false, at: 7 }, 'cleared = no key');
  const [list] = lists(mirrorOf([on]));
  assert.equal(list.items[0].manual, true, 'the phone reads a PC-set flag');
});

test('a steer card added on the phone reaches a PC peer with its tag', () => {
  const unit = addUnit(KEY, 'stop after this', NOW, [STEER_TAG]);
  assert.deepEqual(unit.v, { text: 'stop after this', done: false, at: NOW, tags: ['steer'] });
  const peer = validPeerProjects(rows.todoPeer(mirrorOf([unit])), NOW);
  assert.deepEqual(peer[KEY].items, [{ ...unit.v, u: NOW }]);
});

test('toggleTagUnit adds and removes steer, keeps other tags, and a PC peer accepts both', () => {
  // A HUD card with a run tag, as the phone lists it.
  const item = lists(mirrorOf([{ k: `${KEY}:7`, v: { text: 'x', done: false, at: 7, tags: ['run:r1'] }, u: NOW, d: null }]))[0].items[0];
  const on = toggleTagUnit(KEY, item, STEER_TAG, NOW + 1);
  assert.deepEqual(on.v.tags, ['run:r1', 'steer']);
  const back = lists(mirrorOf([on]))[0].items[0];
  assert.equal(hasTag(back, STEER_TAG), true);
  const off = toggleTagUnit(KEY, back, STEER_TAG, NOW + 2);
  assert.deepEqual(off.v, { text: 'x', done: false, at: 7, tags: ['run:r1'] });
  const bare = toggleTagUnit(KEY, { text: 'y', done: false, at: 8, u: NOW, tags: ['steer'] }, STEER_TAG, NOW + 3);
  assert.deepEqual(bare.v, { text: 'y', done: false, at: 8 });
  for (const unit of [on, off, bare]) {
    const peer = validPeerProjects(rows.todoPeer(mirrorOf([unit])), NOW + 10);
    assert.deepEqual(peer[KEY].items, [{ ...unit.v, u: unit.u }]);
  }
});
