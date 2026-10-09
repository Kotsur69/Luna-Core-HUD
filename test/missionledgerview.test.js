// ============================================================================
// LunaCore - Mission Control ledger view math (renderer/modules/missionledgerview.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ledgerView, nextClass, TOP_N } = require('../src/renderer/modules/missionledgerview.js');

const p = (key, usd, cls = null, share) => ({ key, name: key.split(/[:/]/).pop(), usd, share, cls, tokens: 1, unpricedTokens: 0 });

function report(projects) {
  const total = projects.reduce((s, x) => s + x.usd, 0);
  return { ok: true, totalUsd: total, unpricedTokens: 0, projects: projects.map((x) => ({ ...x, share: x.usd / total })) };
}

test('with a weekly reading, each project is its share of the used percentage', () => {
  const v = ledgerView(report([p('git:a', 30, 'work'), p('git:b', 10, 'fun')]), 40);
  assert.equal(v.basis, 'limit');
  assert.deepEqual(v.top.map((r) => [r.key, r.pct, r.cls]), [['git:a', 30, 'work'], ['git:b', 10, 'fun']]);
});

test('without a weekly reading, percentages are of the Claude spend', () => {
  const v = ledgerView(report([p('git:a', 30), p('git:b', 10)]), null);
  assert.equal(v.basis, 'spend');
  assert.deepEqual(v.top.map((r) => r.pct), [75, 25]);
});

test('"other" counts as class other; repos without a class are unassigned', () => {
  const v = ledgerView(report([p('git:a', 5), p('other', 3), p('local:toy', 2, 'fun')]), 50);
  assert.equal(v.top.find((r) => r.key === 'other').cls, 'other');
  assert.deepEqual(v.unassigned.map((r) => r.key), ['git:a']);
});

test('only the top N get rows; the rest are summed into one remainder', () => {
  const many = Array.from({ length: TOP_N + 3 }, (_, i) => p(`git:p${i}`, 10 - i));
  const v = ledgerView(report(many), 100);
  assert.equal(v.top.length, TOP_N);
  assert.equal(v.restCount, 3);
  const totalPct = v.top.reduce((s, r) => s + r.pct, 0) + v.restPct;
  assert.ok(Math.abs(totalPct - 100) < 1e-9);
});

test('segments are grouped by class in a fixed order for the stacked bar', () => {
  const v = ledgerView(report([p('git:a', 1, 'fun'), p('git:b', 1, 'work'), p('git:c', 1), p('other', 1)]), 80);
  assert.deepEqual(v.segments.map((s) => s.cls), ['work', 'fun', 'other', 'unassigned']);
  assert.ok(Math.abs(v.segments.reduce((s, x) => s + x.pct, 0) - 80) < 1e-9);
});

test('an empty or failed report is an empty view', () => {
  assert.deepEqual(ledgerView({ ok: true, totalUsd: 0, projects: [] }, 10).top, []);
  assert.equal(ledgerView(null, 10), null);
  assert.equal(ledgerView({ ok: false }, 10), null);
});

test('clicking a class chip cycles work -> fun -> other -> work', () => {
  assert.equal(nextClass('work'), 'fun');
  assert.equal(nextClass('fun'), 'other');
  assert.equal(nextClass('other'), 'work');
  assert.equal(nextClass('unassigned'), 'work');
  assert.equal(nextClass(undefined), 'work');
});

test('every row says whether its class can be changed (the "other" bucket cannot)', () => {
  const v = ledgerView(report([p('git:a', 5, 'work'), p('other', 3), p('git:b', 2)]), 50);
  assert.deepEqual(v.top.map((r) => [r.key, r.reclassable]), [['git:a', true], ['other', false], ['git:b', true]]);
});

test('pinned projects come first, even at zero, then the top spenders', () => {
  const r = report([p('git:big', 50), p('git:mid', 30)]);
  r.projects.push({ key: 'git:pin', name: 'pin', usd: 0, share: 0, cls: null, tokens: 0, unpricedTokens: 0, pinned: true });
  const v = ledgerView(r, 100);
  assert.deepEqual(v.top.map((x) => [x.key, x.pinned]), [['git:pin', true], ['git:big', false], ['git:mid', false]]);
  assert.deepEqual(v.unassigned.map((x) => x.key), ['git:pin', 'git:big', 'git:mid']);
});
