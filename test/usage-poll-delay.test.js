// nextPollDelay() - pure decision behind the usage-meter heartbeat: fast
// retry (15 s) right after an error, normal cadence (90 s) once healthy.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextPollDelay } = require('../src/usage.js');

const INTERVAL = 90000;
const HEARTBEAT = 15000;

test('no error -> normal interval', () => {
  const usage = { fiveHour: { pct: 12, resetsAt: null } };
  assert.equal(nextPollDelay(usage, INTERVAL, HEARTBEAT), INTERVAL);
});

test('a read with an error -> faster heartbeat', () => {
  for (const error of ['reauth', 'unavailable']) {
    assert.equal(nextPollDelay({ error }, INTERVAL, HEARTBEAT), HEARTBEAT);
  }
});

test('missing/empty read (e.g. the tick has not run yet) -> normal interval', () => {
  assert.equal(nextPollDelay(undefined, INTERVAL, HEARTBEAT), INTERVAL);
  assert.equal(nextPollDelay(null, INTERVAL, HEARTBEAT), INTERVAL);
});
