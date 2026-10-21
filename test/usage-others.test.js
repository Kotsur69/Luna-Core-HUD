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

test('limitLabel localizes the generic windows and keeps provider labels', () => {
  const tr = (key) => `T:${key}`;
  assert.equal(limitLabel({ window: '5h', label: '5-hour window' }, tr), 'T:usage.window.5h');
  assert.equal(limitLabel({ window: 'weekly', label: 'Weekly limit' }, tr), 'T:usage.window.week');
  assert.equal(limitLabel({ window: 'daily', label: 'gemini-3-pro' }, tr), 'gemini-3-pro');
  assert.equal(limitLabel({ window: 'monthly', label: 'Tool calls (MCP)' }, tr), 'Tool calls (MCP)');
  assert.equal(limitLabel({ window: 'custom' }, tr), 'T:usage.window.custom');
});
