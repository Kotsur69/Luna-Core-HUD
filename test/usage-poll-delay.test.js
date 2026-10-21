// nextPollDelay() - pure decision behind the usage-meter heartbeat: fast
// retry (15 s) right after an error, normal cadence (90 s) once healthy.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextPollDelay, parseRetryAfter, MAX_BACKOFF_MS } = require('../src/usage.js');

const INTERVAL = 90000;
const HEARTBEAT = 15000;

test('no error -> normal interval', () => {
  const usage = { fiveHour: { pct: 12, resetsAt: null } };
  assert.equal(nextPollDelay(usage, INTERVAL, HEARTBEAT), INTERVAL);
});

test('a read with an error -> faster heartbeat', () => {
  // Provider-aware readers report failures as status: 'error' (+ errorMessage).
  for (const errorMessage of ['reauth', 'Network error']) {
    assert.equal(
      nextPollDelay({ status: 'error', errorMessage }, INTERVAL, HEARTBEAT),
      HEARTBEAT
    );
  }
});

test('a healthy provider read -> normal interval', () => {
  assert.equal(nextPollDelay({ status: 'ok' }, INTERVAL, HEARTBEAT), INTERVAL);
});

test('missing/empty read (e.g. the tick has not run yet) -> normal interval', () => {
  assert.equal(nextPollDelay(undefined, INTERVAL, HEARTBEAT), INTERVAL);
  assert.equal(nextPollDelay(null, INTERVAL, HEARTBEAT), INTERVAL);
});

test('a 429 waits Retry-After, at least the normal interval and at most the cap', () => {
  const limited = (retryAfterMs) => ({ status: 'error', rateLimited: true, retryAfterMs });
  assert.equal(nextPollDelay(limited(300000), INTERVAL, HEARTBEAT, 1), 300000);
  assert.equal(nextPollDelay(limited(1000), INTERVAL, HEARTBEAT, 1), INTERVAL);
  assert.equal(nextPollDelay(limited(10 * 60 * 60 * 1000), INTERVAL, HEARTBEAT, 1), MAX_BACKOFF_MS);
});

test('a 429 without Retry-After doubles the interval per consecutive 429', () => {
  const limited = { status: 'error', rateLimited: true, retryAfterMs: null };
  assert.equal(nextPollDelay(limited, INTERVAL, HEARTBEAT, 1), INTERVAL);
  assert.equal(nextPollDelay(limited, INTERVAL, HEARTBEAT, 2), INTERVAL * 2);
  assert.equal(nextPollDelay(limited, INTERVAL, HEARTBEAT, 3), INTERVAL * 4);
  assert.equal(nextPollDelay(limited, INTERVAL, HEARTBEAT, 50), MAX_BACKOFF_MS);
});

test('parseRetryAfter reads delta-seconds and HTTP dates, null for junk or the past', () => {
  const now = Date.UTC(2026, 9, 20, 12);
  assert.equal(parseRetryAfter('120', now), 120000);
  assert.equal(parseRetryAfter(['30'], now), 30000);
  assert.equal(parseRetryAfter(new Date(now + 60000).toUTCString(), now), 60000);
  assert.equal(parseRetryAfter(new Date(now - 60000).toUTCString(), now), null);
  assert.equal(parseRetryAfter('0', now), null);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(undefined, now), null);
});
