// Phone Memory page model (mobile/src/memorymodel.js): which hosts take
// memory.* commands, the untrusted memory.inbox answer cleaned field by
// field, the decision payload, and the refusal codes the page translates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryHosts, pickMemoryHost, inboxFrom, decisionPayload, withoutItem, isGone, refusalKey, MAX_ITEMS } from '../mobile/src/memorymodel.js';

const host = (machine, extra = {}) => ({ machine, online: true, default: false, memory: true, ...extra });
const entry = (id, extra = {}) => ({
  key: `github.com/acme/hud/${id}`,
  project: 'github.com/acme/hud',
  id,
  type: 'gotcha',
  area: null,
  title: `Title of ${id}`,
  body: `Body of ${id}`,
  clipped: false,
  created: '2026-11-10',
  source: 'captured from session abc on PC1',
  usefulness: 80,
  suggestedGlobal: false,
  outside: 0,
  duplicates: 0,
  supersedes: [],
  similar: null,
  ...extra,
});

test('memoryHosts keeps only hosts whose heartbeat says memory: true', () => {
  const hosts = [host('A', { memory: false }), host('B'), host('C', { online: false }), null, { memory: true }];
  assert.deepEqual(memoryHosts(hosts).map((x) => x.machine), ['B', 'C']);
  assert.deepEqual(memoryHosts(undefined), []);
});

test('pickMemoryHost: the current pick, else default, else online, else first; null without one', () => {
  const hosts = [host('A', { online: false }), host('B', { default: true }), host('C')];
  assert.equal(pickMemoryHost(hosts, 'a').machine, 'A');
  assert.equal(pickMemoryHost(hosts, 'gone').machine, 'B');
  assert.equal(pickMemoryHost([host('A', { online: false }), host('C')], '').machine, 'C');
  assert.equal(pickMemoryHost([host('X', { memory: false })], 'X'), null);
});

test('inboxFrom keeps known fields and drops malformed or repeated entries', () => {
  const res = inboxFrom({
    status: 'listed',
    total: 7,
    items: [
      entry('one', { area: 'build', suggestedGlobal: true, outside: 3, duplicates: 2, supersedes: ['Old one', 5, ''], similar: 'A confirmed one', extra: '<img>' }),
      entry('one'),
      entry('Bad-Id'),
      entry('two', { project: '../../etc' }),
      entry('three', { title: '   ' }),
      entry('four', { usefulness: 101, type: 'x'.repeat(30), created: 'yesterday', outside: -1, duplicates: 1.5 }),
      'junk',
      null,
    ],
  });
  assert.equal(res.total, 7);
  assert.deepEqual(res.items.map((i) => i.id), ['one', 'four']);
  const [one, four] = res.items;
  assert.equal(one.key, 'github.com/acme/hud/one');
  assert.equal(one.area, 'build');
  assert.equal(one.suggestedGlobal, true);
  assert.equal(one.outside, 3);
  assert.equal(one.duplicates, 2);
  assert.deepEqual(one.supersedes, ['Old one']);
  assert.equal(one.similar, 'A confirmed one');
  assert.equal(Object.hasOwn(one, 'extra'), false);
  assert.equal(four.usefulness, null);
  assert.equal(four.type, '');
  assert.equal(four.created, '');
  assert.equal(four.outside, 0);
  assert.equal(four.duplicates, 0);
});

test('inboxFrom caps the list, caps strings, and never reports fewer than listed', () => {
  const many = Array.from({ length: MAX_ITEMS + 20 }, (_, i) => entry(`e${i}`, { body: 'b'.repeat(9000) }));
  const res = inboxFrom({ items: many, total: 3 });
  assert.equal(res.items.length, MAX_ITEMS);
  assert.equal(res.total, MAX_ITEMS);
  assert.ok(res.items.every((i) => i.body.length === 5000));
  assert.deepEqual(inboxFrom(null), { items: [], total: 0 });
  assert.deepEqual(inboxFrom({ items: 'x', total: 'many' }), { items: [], total: 0 });
});

test('decisionPayload sends only project and id, and refuses a bad one', () => {
  assert.deepEqual(decisionPayload(entry('one')), { project: 'github.com/acme/hud', id: 'one' });
  assert.deepEqual(decisionPayload(entry('keep', { project: 'global' })), { project: 'global', id: 'keep' });
  assert.equal(decisionPayload(entry('a/b')), null);
  assert.equal(decisionPayload(entry('one', { project: 'C:\\x' })), null);
  assert.equal(decisionPayload(null), null);
});

test('withoutItem returns a new inbox without the entry, total down by one', () => {
  const inbox = inboxFrom({ items: [entry('one'), entry('two')], total: 5 });
  const after = withoutItem(inbox, 'github.com/acme/hud/one');
  assert.deepEqual(after.items.map((i) => i.id), ['two']);
  assert.equal(after.total, 4);
  assert.equal(inbox.items.length, 2, 'the old inbox is untouched');
  assert.equal(withoutItem(after, 'nope').total, 4);
});

test('refusal codes: known ones get their own text, gone ones leave the list', () => {
  assert.equal(refusalKey('notWaiting'), 'memErr_notWaiting');
  assert.equal(refusalKey('needsHud'), 'memErr_needsHud');
  assert.equal(refusalKey('unknown-kind'), 'memErr_unknownKind');
  assert.equal(refusalKey('somethingElse'), null);
  assert.equal(refusalKey(42), null);
  assert.equal(isGone('notWaiting'), true);
  assert.equal(isGone('notFound'), true);
  assert.equal(isGone('failed'), false);
});
