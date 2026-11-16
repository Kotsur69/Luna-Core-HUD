// ============================================================================
// LunaCore - God Mode "run finished" screen rules (renderer orchestraFinished.js)
// ----------------------------------------------------------------------------
// A finished run swaps the board (and its misleading "Discard plan") for a
// summary with "Plan another God Mode run". Covers when a run counts as
// finished and the summary numbers: counts, merge, release, duration.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRunFinished, finishedSummary } = require('../src/renderer/modules/orchestraFinished.js');

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** A run view that finished cleanly: two pushed packages, merged, released. */
function finishedView(over = {}) {
  return {
    id: 'run-1',
    started: true,
    killed: false,
    settled: true,
    interrupted: null,
    scheduledAt: null,
    planRun: null,
    integrationMode: 'merge',
    baseBranch: 'main',
    runStartedAt: T0,
    packages: [
      { id: 'a', state: 'pushed', merged: true, startedAt: T0 + MIN, finishedAt: T0 + 20 * MIN, prUrl: null },
      { id: 'b', state: 'pushed', merged: true, startedAt: T0 + 2 * MIN, finishedAt: T0 + 30 * MIN, prUrl: null },
    ],
    integration: {
      state: 'done',
      running: false,
      at: T0 + 45 * MIN,
      skipped: [],
      headSha: 'abcdef0123456789',
      postMerge: { release: { released: true, tag: 'v0.32.0', version: '0.32.0', url: 'https://example.invalid/r' } },
    },
    ...over,
  };
}

test('a settled, integrated run is finished', () => {
  assert.equal(isRunFinished(finishedView()), true);
});

test('a run with nothing to merge (all stalled, integration done) is finished', () => {
  const view = finishedView({
    packages: [{ id: 'a', state: 'stalled' }, { id: 'b', state: 'failed' }],
    integration: { state: 'done', running: false, skipped: [] },
  });
  assert.equal(isRunFinished(view), true);
});

test('not finished: no plan, not started, killed, not settled', () => {
  assert.equal(isRunFinished(null), false);
  assert.equal(isRunFinished({}), false);
  assert.equal(isRunFinished(finishedView({ started: false })), false);
  assert.equal(isRunFinished(finishedView({ killed: true })), false);
  assert.equal(isRunFinished(finishedView({ settled: false })), false);
  assert.equal(isRunFinished(finishedView({ packages: [] })), false);
});

test('not finished while a package runs or waits', () => {
  for (const state of ['launched', 'finishing', 'pending']) {
    const view = finishedView();
    const packages = [{ ...view.packages[0], state }, view.packages[1]];
    assert.equal(isRunFinished({ ...view, packages }), false, state);
  }
});

test('not finished while integration runs, failed or never ran', () => {
  const base = finishedView();
  assert.equal(isRunFinished({ ...base, integration: { ...base.integration, running: true } }), false);
  assert.equal(isRunFinished({ ...base, integration: { ...base.integration, state: 'running' } }), false);
  assert.equal(isRunFinished({ ...base, integration: { ...base.integration, state: 'failed' } }), false);
  assert.equal(isRunFinished({ ...base, integration: {} }), false);
  assert.equal(isRunFinished({ ...base, integration: null }), false);
});

test('not finished: cut by a shutdown, scheduled, or a plan run not yet approved', () => {
  assert.equal(isRunFinished(finishedView({ interrupted: { at: T0, by: 'shutdown' } })), false);
  assert.equal(isRunFinished(finishedView({ scheduledAt: T0 })), false);
  assert.equal(isRunFinished(finishedView({ hold: { reason: 'noNodeModules', at: T0 } })), false);
  assert.equal(isRunFinished(finishedView({ planRun: { approved: null } })), false);
  assert.equal(isRunFinished(finishedView({ planRun: { approved: { at: T0, created: 2, skipped: 0 } } })), true);
});

test('summary: counts, merge result, release and duration', () => {
  const s = finishedSummary(finishedView());
  assert.deepEqual(s, {
    total: 2,
    done: 2,
    failed: 0,
    closed: 0,
    skipped: 0,
    merged: 2,
    mode: 'merge',
    base: 'main',
    sha: 'abcdef0',
    prs: [],
    release: { tag: 'v0.32.0', url: 'https://example.invalid/r' },
    durationMs: 45 * MIN,
  });
});

test('summary: failed / closed / merge-skipped packages and PR links', () => {
  const s = finishedSummary(
    finishedView({
      integrationMode: 'pr',
      packages: [
        { id: 'a', state: 'pushed', prUrl: 'https://example.invalid/pr/1' },
        { id: 'b', state: 'stalled' },
        { id: 'c', state: 'killed' },
        { id: 'd', state: 'failed' },
        { id: 'e', state: 'closed' },
      ],
      integration: { state: 'done', skipped: [{ id: 'a', stage: 'merge' }], at: T0 + 10 * MIN },
    }),
  );
  assert.equal(s.total, 5);
  assert.equal(s.done, 1);
  assert.equal(s.failed, 3);
  assert.equal(s.closed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.merged, 0);
  assert.equal(s.mode, 'pr');
  assert.equal(s.sha, null);
  assert.equal(s.release, null);
  assert.deepEqual(s.prs, [{ id: 'a', url: 'https://example.invalid/pr/1' }]);
  assert.equal(s.durationMs, 10 * MIN);
});

test('summary: release from the version when no tag; none when not released', () => {
  const tagless = finishedView({ integration: { state: 'done', postMerge: { release: { released: true, version: '1.2.3' } } } });
  assert.deepEqual(finishedSummary(tagless).release, { tag: 'v1.2.3', url: null });
  const skipped = finishedView({ integration: { state: 'done', postMerge: { release: { skipped: 'noChanges' } } } });
  assert.equal(finishedSummary(skipped).release, null);
});

test('summary: duration falls back to the packages, null when unknown', () => {
  const view = finishedView({ runStartedAt: null, integration: { state: 'done' } });
  assert.equal(finishedSummary(view).durationMs, 29 * MIN);
  const unknown = finishedView({ runStartedAt: null, integration: { state: 'done' }, packages: [{ id: 'a', state: 'pushed' }] });
  assert.equal(finishedSummary(unknown).durationMs, null);
});

test('summary survives a malformed view', () => {
  const s = finishedSummary(null);
  assert.equal(s.total, 0);
  assert.equal(s.durationMs, null);
  assert.equal(s.mode, 'pr');
});
