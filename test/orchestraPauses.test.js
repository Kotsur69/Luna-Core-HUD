// ============================================================================
// God Mode per-backend usage-limit pauses (src/orchestraPauses.js): pure
// helpers over plan.pauses - holding, opening / extending, the run-level
// summary and the pausedMs credit that never counts an overlap twice.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pr = require('../src/orchestraPauses.js');

const HOUR = 60 * 60 * 1000;
const T0 = 1700000000000;
// Fake backend membership: the package's `backend` field.
const runsOn = (pkg, backend) => pkg.backend === backend;
const claudePkg = { id: 'c', backend: 'claude' };
const agyPkg = { id: 'g', backend: 'agy' };
const freePkg = { id: 'f', backend: 'free' };

test('keyOf: known backends keep their key, anything else is the whole run', () => {
  for (const b of ['claude', 'agy', 'free']) assert.equal(pr.keyOf(b), b);
  for (const v of [null, undefined, '', 'opus', 'all']) assert.equal(pr.keyOf(v), pr.ALL);
});

test('normalizePauses keeps valid entries of known keys only', () => {
  const raw = {
    claude: { until: T0 + HOUR, startedAt: T0 },
    agy: { until: 'soon', startedAt: T0 },
    free: { until: T0 + HOUR },
    bogus: { until: T0 + HOUR, startedAt: T0 },
    all: { until: T0 + 2 * HOUR, startedAt: T0, extra: 1 },
  };
  assert.deepEqual(pr.normalizePauses(raw), {
    all: { until: T0 + 2 * HOUR, startedAt: T0 },
    claude: { until: T0 + HOUR, startedAt: T0 },
  });
  for (const v of [null, undefined, 'x', 7, []]) assert.deepEqual(pr.normalizePauses(v), {});
  assert.deepEqual(pr.pausesOf(null), {});
  assert.deepEqual(pr.pausesOf({ pauseScope: 'agy', pausedUntil: T0 }), {}, 'legacy single-pause fields are not pauses');
});

test('holdingKeys / heldSince: a backend pause holds only its own packages, the whole-run pause holds all', () => {
  const pauses = { agy: { until: T0 + 2 * HOUR, startedAt: T0 }, claude: { until: T0 + HOUR, startedAt: T0 + 10 } };
  assert.deepEqual(pr.holdingKeys(pauses, claudePkg, runsOn), ['claude']);
  assert.deepEqual(pr.holdingKeys(pauses, agyPkg, runsOn), ['agy']);
  assert.deepEqual(pr.holdingKeys(pauses, freePkg, runsOn), [], 'free never held by other backends');
  assert.equal(pr.heldSince(pauses, freePkg, runsOn), null);
  assert.equal(pr.heldSince(pauses, claudePkg, runsOn), T0 + 10);

  const all = { ...pauses, all: { until: T0 + 3 * HOUR, startedAt: T0 + 5 } };
  assert.deepEqual(pr.holdingKeys(all, freePkg, runsOn), ['all']);
  assert.deepEqual(pr.holdingKeys(all, claudePkg, runsOn), ['all', 'claude']);
  assert.equal(pr.heldSince(all, claudePkg, runsOn), T0 + 5, 'earliest holding pause');
});

test('withPause opens, extends to a later reset only, and never mutates', () => {
  const empty = Object.freeze({});
  const opened = pr.withPause(empty, 'agy', T0 + 2 * HOUR, T0);
  assert.equal(opened.changed, true);
  assert.deepEqual(opened.pauses, { agy: { until: T0 + 2 * HOUR, startedAt: T0 } });
  assert.deepEqual(empty, {});

  const second = pr.withPause(opened.pauses, 'claude', T0 + HOUR, T0 + 10);
  assert.equal(second.changed, true, 'another backend gets its own, earlier reset');
  assert.equal(second.pauses.agy.until, T0 + 2 * HOUR, 'the open agy pause is untouched');
  assert.equal(second.pauses.claude.until, T0 + HOUR);

  const same = pr.withPause(second.pauses, 'claude', T0 + HOUR, T0 + 20);
  assert.equal(same.changed, false);
  assert.equal(same.pauses, second.pauses);
  const shorter = pr.withPause(second.pauses, 'agy', T0 + HOUR, T0 + 20);
  assert.equal(shorter.changed, false, 'a shorter reset of the same backend changes nothing');
  const longer = pr.withPause(second.pauses, 'claude', T0 + 3 * HOUR, T0 + 30);
  assert.equal(longer.changed, true);
  assert.deepEqual(longer.pauses.claude, { until: T0 + 3 * HOUR, startedAt: T0 + 10 }, 'extension keeps its start');
  assert.equal(pr.withPause({}, 'agy', NaN, T0).changed, false);
});

test('withoutPause drops one key without touching the input', () => {
  const pauses = Object.freeze({ agy: { until: 2, startedAt: 1 }, claude: { until: 3, startedAt: 1 } });
  assert.deepEqual(pr.withoutPause(pauses, 'agy'), { claude: { until: 3, startedAt: 1 } });
  assert.deepEqual(Object.keys(pauses), ['agy', 'claude']);
});

test('withRunPauses: summary is the earliest reset (whole-run pause wins), the span counts once', () => {
  const agy = { agy: { until: T0 + 2 * HOUR, startedAt: T0 } };
  const r1 = pr.withRunPauses({ pausedTotalMs: 5 }, agy, T0);
  assert.deepEqual(r1, { pauses: agy, pausedUntil: T0 + 2 * HOUR, pauseStartedAt: T0, pausedTotalMs: 5 });

  const both = { ...agy, claude: { until: T0 + HOUR, startedAt: T0 + 10 } };
  const r2 = pr.withRunPauses(r1, both, T0 + 10);
  assert.equal(r2.pausedUntil, T0 + HOUR, 'the earliest backend reset');
  assert.equal(r2.pauseStartedAt, T0, 'the span started with the first pause');

  const withAll = { ...both, all: { until: T0 + 90 * 60 * 1000, startedAt: T0 + 20 } };
  assert.equal(pr.withRunPauses(r2, withAll, T0 + 20).pausedUntil, T0 + 90 * 60 * 1000, 'nothing resumes before the whole-run pause ends');

  const r3 = pr.withRunPauses(r2, { claude: both.claude }, T0 + 2 * HOUR);
  assert.equal(r3.pausedTotalMs, 5, 'the span is still open');
  const r4 = pr.withRunPauses(r3, {}, T0 + 3 * HOUR);
  assert.deepEqual(r4, { pauses: {}, pausedUntil: null, pauseStartedAt: null, pausedTotalMs: 5 + 3 * HOUR });
  assert.equal(pr.withRunPauses({}, {}, T0).pausedTotalMs, 0, 'no span open: nothing to count');
});

test('latestUntil: the latest open reset, null without pauses', () => {
  assert.equal(pr.latestUntil({ agy: { until: 9, startedAt: 1 }, claude: { until: 5, startedAt: 1 } }), 9);
  assert.equal(pr.latestUntil({}), null);
  assert.equal(pr.latestUntil(undefined), null);
});

test('resumeCredit: only the paused span after the package started, overlaps counted once', () => {
  const ended = { startedAt: T0 + 10, until: T0 + HOUR };
  assert.equal(pr.resumeCredit(ended, [], T0, T0 + HOUR), HOUR - 10);
  assert.equal(pr.resumeCredit(ended, [], T0 + 100, T0 + HOUR), HOUR - 100, 'started during the pause');
  assert.equal(pr.resumeCredit(ended, [], null, T0 + HOUR), 0, 'never started: nothing');
  assert.equal(pr.resumeCredit(ended, [T0], T0, T0 + HOUR), 0, 'an earlier pause still holds it: that one credits');
  assert.equal(pr.resumeCredit(ended, [T0 + 1000], T0, T0 + HOUR), 990, 'up to where the later pause took over');

  // Two overlapping pauses on one package: the union, never the sum.
  const a = { startedAt: T0, until: T0 + 2 * HOUR };
  const b = { startedAt: T0 + HOUR, until: T0 + 3 * HOUR };
  const first = pr.resumeCredit(a, [b.startedAt], T0, T0 + 2 * HOUR);
  const second = pr.resumeCredit(b, [], T0, T0 + 3 * HOUR);
  assert.equal(first + second, 3 * HOUR);
});
