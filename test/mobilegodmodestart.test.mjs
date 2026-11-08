// Phone God Mode B (mobile/src/godmodestart.js): which hosts can run God Mode,
// the preselected host, a to-do list -> the host's project id, the card
// picker (manual cards shown but not pickable) and the godmode.plan payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  godmodeHosts,
  pickGodmodeHost,
  hostForMachine,
  projectIdFor,
  pickableCards,
  defaultSelection,
  toggleSelection,
  planPayload,
  refusalKey,
  MAX_TODO_ATS,
} from '../mobile/src/godmodestart.js';

const host = (machine, extra = {}) => ({ machine, online: true, default: false, godmode: true, repos: [], ...extra });

test('godmodeHosts keeps only hosts that run God Mode, order kept', () => {
  const hosts = [host('A', { godmode: false }), host('B'), host('C', { online: false }), null, { godmode: true }];
  assert.deepEqual(godmodeHosts(hosts).map((x) => x.machine), ['B', 'C']);
  assert.deepEqual(godmodeHosts(null), []);
});

test('pickGodmodeHost: current pick, then the default host, then online, then first', () => {
  const hosts = [host('A', { online: false }), host('B', { default: true }), host('C'), host('D', { godmode: false, default: true })];
  assert.equal(pickGodmodeHost(hosts, 'c').machine, 'C', 'current pick, any casing');
  assert.equal(pickGodmodeHost(hosts, 'D').machine, 'B', 'a pick that cannot run God Mode is not kept');
  assert.equal(pickGodmodeHost(hosts, '').machine, 'B');
  assert.equal(pickGodmodeHost([host('A', { online: false }), host('B')], '').machine, 'B');
  assert.equal(pickGodmodeHost([host('A', { online: false })], '').machine, 'A');
  assert.equal(pickGodmodeHost([host('X', { godmode: false })], 'X'), null);
  assert.equal(pickGodmodeHost([], 'X'), null);
});

test('hostForMachine matches case-insensitively', () => {
  const hosts = [host('KT-PC'), host('Other')];
  assert.equal(hostForMachine(hosts, 'kt-pc').machine, 'KT-PC');
  assert.equal(hostForMachine(hosts, 'nope'), null);
  assert.equal(hostForMachine(null, 'KT-PC'), null);
});

test('projectIdFor: a git list by repo key, a local list by project name', () => {
  const h = host('A', {
    repos: [
      { id: 'p-luna', key: 'git:github.com/kotsur69/luna-core-hud', name: 'Luna Core' },
      { id: 'p-home', key: null, name: 'Home' },
      { id: 'bad id!', key: 'git:github.com/o/bad', name: 'bad' },
    ],
  });
  assert.equal(projectIdFor(h, 'git:github.com/kotsur69/luna-core-hud'), 'p-luna');
  assert.equal(projectIdFor(h, 'local:home'), 'p-home');
  assert.equal(projectIdFor(h, 'git:github.com/o/other'), null);
  assert.equal(projectIdFor(h, 'git:github.com/o/bad'), null, 'an off-shape id is never sent');
  assert.equal(projectIdFor(h, 'local:Luna Core'), null, 'a local list never matches a git project by name');
  assert.equal(projectIdFor(null, 'local:home'), null);
});

const items = [
  { at: 100, text: 'one', done: false },
  { at: 200, text: 'manual', done: false, manual: true },
  { at: 300, text: 'done', done: true },
  { at: 400, text: 'two', done: false },
  { at: -1, text: 'bad', done: false },
];

test('pickableCards: open cards only, manual ones disabled', () => {
  const cards = pickableCards(items);
  assert.deepEqual(cards, [
    { at: 100, text: 'one', manual: false, disabled: false },
    { at: 200, text: 'manual', manual: true, disabled: true },
    { at: 400, text: 'two', manual: false, disabled: false },
  ]);
  assert.deepEqual(defaultSelection(cards), [100, 400]);
});

test('toggleSelection ignores disabled and unknown cards and never mutates', () => {
  const cards = pickableCards(items);
  const sel = [100, 400];
  assert.deepEqual(toggleSelection(sel, 100, cards), [400]);
  assert.deepEqual(toggleSelection([400], 100, cards), [400, 100]);
  assert.equal(toggleSelection(sel, 200, cards), sel, 'manual card');
  assert.equal(toggleSelection(sel, 999, cards), sel, 'unknown card');
  assert.deepEqual(sel, [100, 400]);
});

test('planPayload: picked open non-manual cards, unique and sorted', () => {
  const cards = pickableCards(items);
  assert.deepEqual(planPayload('p-luna', [400, 100, 400, 200, 300], cards), { projectId: 'p-luna', todoAts: [100, 400] });
  assert.equal(planPayload('p-luna', [200], cards), null, 'only a manual card');
  assert.equal(planPayload('p-luna', [], cards), null);
  assert.equal(planPayload(null, [100], cards), null, 'no project on the host');
  assert.equal(planPayload('bad id!', [100], cards), null);
});

test('planPayload refuses a pick over the list cap', () => {
  const many = Array.from({ length: MAX_TODO_ATS + 1 }, (_, i) => ({ at: i + 1, text: `t${i}`, done: false }));
  const cards = pickableCards(many);
  assert.equal(planPayload('p', defaultSelection(cards), cards), null);
  assert.equal(planPayload('p', defaultSelection(cards).slice(0, MAX_TODO_ATS), cards).todoAts.length, MAX_TODO_ATS);
});

test('refusalKey names the codes the phone has words for', () => {
  assert.equal(refusalKey('needsHud'), 'gmErr_needsHud');
  assert.equal(refusalKey('busy'), 'gmErr_busy');
  assert.equal(refusalKey('weird'), null);
  assert.equal(refusalKey(undefined), null);
});
