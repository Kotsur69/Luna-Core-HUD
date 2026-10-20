// Usage limits snapshot (src/usagesnapshot.js, REMOTE_HOST_PLAN U1): what a PC
// puts and what any reader accepts from another machine's row.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { usageSnapshot, parseUsagePeer, newestUsage, windowNow } = require('../src/usagesnapshot');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12);
const iso = (ms) => new Date(ms).toISOString();

const claudeRead = (over = {}) => ({
  providerId: 'claude',
  status: 'ok',
  isFallback: false,
  updatedAt: NOW - 1000,
  limits: [
    { window: '5h', percentUsed: 42, resetsAt: iso(NOW + 2 * HOUR) },
    { window: 'weekly', percentUsed: 17.6, resetsAt: iso(NOW + 72 * HOUR) },
  ],
  ...over,
});

const row = (machine, data) => ({ machine, data });

test('usageSnapshot keeps only the two windows as numbers', () => {
  assert.deepEqual(usageSnapshot(claudeRead(), NOW), {
    v: 1,
    at: NOW - 1000,
    fiveHour: { pct: 42, resetsAt: NOW + 2 * HOUR },
    sevenDay: { pct: 18, resetsAt: NOW + 72 * HOUR },
  });
});

test('usageSnapshot skips another provider, an error and an empty read', () => {
  assert.equal(usageSnapshot(claudeRead({ providerId: 'local', isFallback: true }), NOW), null);
  assert.equal(usageSnapshot(claudeRead({ status: 'error', limits: [] }), NOW), null);
  assert.equal(usageSnapshot(claudeRead({ limits: [] }), NOW), null);
  assert.equal(usageSnapshot(null, NOW), null);
});

test('usageSnapshot keeps one window when the other is missing, and a missing reset time', () => {
  const s = usageSnapshot(claudeRead({ limits: [{ window: '5h', percentUsed: 120, resetsAt: null }] }), NOW);
  assert.deepEqual(s.fiveHour, { pct: 100, resetsAt: null });
  assert.equal(s.sevenDay, null);
});

test('usageSnapshot drops a reset time the reader would refuse, not the row', () => {
  const s = usageSnapshot(claudeRead({ limits: [{ window: 'weekly', percentUsed: 5, resetsAt: iso(NOW + 30 * 24 * HOUR) }] }), NOW);
  assert.deepEqual(s.sevenDay, { pct: 5, resetsAt: null });
  assert.ok(parseUsagePeer(row('PC', s), NOW));
});

test('parseUsagePeer round-trips a snapshot', () => {
  const data = usageSnapshot(claudeRead(), NOW);
  assert.deepEqual(parseUsagePeer(row('KT-PC-LLM', data), NOW), { machine: 'KT-PC-LLM', at: data.at, fiveHour: data.fiveHour, sevenDay: data.sevenDay });
});

test('parseUsagePeer drops malformed rows', () => {
  const good = usageSnapshot(claudeRead(), NOW);
  assert.equal(parseUsagePeer(row('bad machine', good), NOW), null);
  assert.equal(parseUsagePeer(row('PC', { ...good, v: 2 }), NOW), null);
  assert.equal(parseUsagePeer(row('PC', { ...good, at: 'now' }), NOW), null);
  assert.equal(parseUsagePeer(row('PC', { ...good, fiveHour: { pct: '42' } }), NOW), null);
  assert.equal(parseUsagePeer(row('PC', { ...good, fiveHour: null, sevenDay: null }), NOW), null);
  // A reset a month out is not a 5 h or weekly window.
  assert.equal(parseUsagePeer(row('PC', { ...good, sevenDay: { pct: 1, resetsAt: NOW + 30 * 24 * HOUR } }), NOW), null);
});

test('parseUsagePeer clamps pct and a far-future clock', () => {
  const p = parseUsagePeer(row('PC', { v: 1, at: NOW + 99 * HOUR, fiveHour: { pct: -5, resetsAt: null }, sevenDay: null }), NOW);
  assert.equal(p.at, NOW);
  assert.equal(p.fiveHour.pct, 0);
});

test('newestUsage picks the newest valid row', () => {
  const older = usageSnapshot(claudeRead({ updatedAt: NOW - HOUR }), NOW);
  const newer = usageSnapshot(claudeRead({ updatedAt: NOW - 60 * 1000 }), NOW);
  const p = newestUsage([row('A', older), row('B', newer), row('C', { v: 1 })], NOW);
  assert.equal(p.machine, 'B');
  assert.equal(newestUsage([], NOW), null);
});

test('windowNow shows a window whose reset passed as empty', () => {
  assert.deepEqual(windowNow({ pct: 90, resetsAt: NOW - 1 }, NOW), { pct: 0, resetsAt: null, isReset: true });
  assert.deepEqual(windowNow({ pct: 90, resetsAt: NOW + HOUR }, NOW), { pct: 90, resetsAt: NOW + HOUR, isReset: false });
  assert.equal(windowNow(null, NOW), null);
});
