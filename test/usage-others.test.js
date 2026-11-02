// The "other providers" part of the usage panel: the watcher throttles their
// reads (src/usage.js), and the renderer localizes the shared window names
// (src/renderer/modules/usage.js limitLabel).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { UsageWatcher } = require('../src/usage.js');
const { limitLabel } = require('../src/renderer/modules/usage.js');

test('readOthers re-reads at most every othersEveryMs, and refresh() forces it', async () => {
  const w = new UsageWatcher(() => {});
  let reads = 0;
  w.getAllProfiles = () => {
    reads += 1;
    return [];
  };
  await w.readOthers();
  await w.readOthers();
  assert.equal(reads, 1);
  w.othersAt = 0; // what refresh() does before its tick
  await w.readOthers();
  assert.equal(reads, 2);
});

test('every OK read is emitted even when the numbers did not change', async () => {
  const emitted = [];
  const w = new UsageWatcher((u) => emitted.push(u));
  w.running = false; // no follow-up timer
  w.getAllProfiles = () => [];
  let now = 1000;
  w.fetchPrimary = async () => ({
    status: 'ok',
    limits: [{ window: '5h', percentUsed: 12 }],
    updatedAt: (now += 90000),
  });
  await w.tick();
  await w.tick();
  // Same percentages twice - the UI still has to learn the read happened,
  // or its "updated Xs ago" label keeps growing until the next change.
  assert.equal(emitted.length, 2);
  assert.ok(emitted[1].updatedAt > emitted[0].updatedAt);
});

test('an unchanged error read is not re-emitted', async () => {
  const emitted = [];
  const w = new UsageWatcher((u) => emitted.push(u));
  w.running = false;
  w.getAllProfiles = () => [];
  w.fetchPrimary = async () => ({ status: 'error', limits: [], updatedAt: Date.now() });
  await w.tick();
  await w.tick();
  assert.equal(emitted.length, 1);
});

test('limitLabel localizes the generic windows and keeps provider labels', () => {
  const tr = (key) => `T:${key}`;
  assert.equal(limitLabel({ window: '5h', label: '5-hour window' }, tr), 'T:usage.window.5h');
  assert.equal(limitLabel({ window: 'weekly', label: 'Weekly limit' }, tr), 'T:usage.window.week');
  assert.equal(limitLabel({ window: 'daily', label: 'gemini-3-pro' }, tr), 'gemini-3-pro');
  assert.equal(limitLabel({ window: 'monthly', label: 'Tool calls (MCP)' }, tr), 'Tool calls (MCP)');
  assert.equal(limitLabel({ window: 'custom' }, tr), 'T:usage.window.custom');
});
