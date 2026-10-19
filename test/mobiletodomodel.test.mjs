// Phone to-do model (mobile/src/todomodel.js): what the phone writes must be
// accepted unchanged by a PC's todosync.validPeerProjects().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lists, addUnit, toggleUnit, deleteUnit, projectName } from '../mobile/src/todomodel.js';

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
