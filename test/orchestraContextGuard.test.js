// ============================================================================
// God Mode predictive context routing (src/orchestraContextGuard.js): the
// pure sample window, the time-to-full prediction, the compact decision, the
// resume brief's progress summary, and the guard with the run faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTEXT_HORIZON_MS,
  SAMPLE_WINDOW_MS,
  MIN_SAMPLES,
  MIN_SPAN_MS,
  MIN_FILL_PERCENT,
  COMPACT_TEXT,
  withSample,
  isNewWindow,
  NEW_WINDOW_DROP_PERCENT,
  predictContext,
  shouldCompact,
  normalizeContextResume,
  contextResumeSection,
  createContextGuard,
} = require('../src/orchestraContextGuard.js');

const MIN = 60_000;
const LIMIT = 200_000;
const s = (at, tokens, limit = LIMIT) => ({ at, tokens, limit });

test('the named constants: a 10-minute horizon, read from at least 3 samples over 2 minutes', () => {
  assert.equal(CONTEXT_HORIZON_MS, 10 * MIN);
  assert.equal(SAMPLE_WINDOW_MS, 15 * MIN);
  assert.equal(MIN_SAMPLES, 3);
  assert.equal(MIN_SPAN_MS, 2 * MIN);
  assert.equal(MIN_FILL_PERCENT, 50);
  assert.equal(COMPACT_TEXT, '/compact\r');
});

// ---- withSample ---------------------------------------------------------------

test('withSample appends to a new array and drops samples older than the window', () => {
  const first = [s(0, 1000)];
  const next = withSample(first, s(MIN, 2000));
  assert.deepEqual(next, [s(0, 1000), s(MIN, 2000)]);
  assert.deepEqual(first, [s(0, 1000)], 'the input is not changed');
  const late = withSample([s(0, 1000), s(10 * MIN, 2000)], s(20 * MIN, 3000));
  assert.deepEqual(late, [s(10 * MIN, 2000), s(20 * MIN, 3000)]);
  assert.deepEqual(withSample(undefined, s(0, 5)), [s(0, 5)]);
});

test('withSample: a new context window or a clock that stepped back start a new history', () => {
  assert.deepEqual(withSample([s(0, 50_000), s(MIN, 90_000)], s(2 * MIN, 30_000)), [s(2 * MIN, 30_000)]);
  assert.deepEqual(withSample([s(5 * MIN, 5000)], s(MIN, 6000)), [s(MIN, 6000)]);
  // A dip under NEW_WINDOW_DROP_PERCENT of the limit is noise: the history goes on.
  assert.deepEqual(withSample([s(0, 50_000), s(MIN, 90_000)], s(2 * MIN, 85_000)), [s(0, 50_000), s(MIN, 90_000), s(2 * MIN, 85_000)]);
});

test('isNewWindow: only a drop of at least NEW_WINDOW_DROP_PERCENT of the limit', () => {
  assert.equal(NEW_WINDOW_DROP_PERCENT, 10);
  assert.equal(isNewWindow(s(0, 150_000), s(MIN, 130_000)), true, 'exactly 10% of 200k');
  assert.equal(isNewWindow(s(0, 150_000), s(MIN, 130_001)), false);
  assert.equal(isNewWindow(s(0, 100_000), s(MIN, 120_000)), false, 'growth');
  for (const [a, b] of [[null, s(0, 1)], [s(0, 1), null], [s(0, NaN), s(0, 1)], [s(0, 90_000), s(0, 1, Infinity)], [s(0, 90_000), s(0, 1, 0)]]) {
    assert.equal(isNewWindow(a, b), false, JSON.stringify([a, b]));
  }
});

test('withSample ignores an unusable reading and keeps at most 120 samples', () => {
  const list = [s(0, 1000)];
  for (const bad of [null, s(MIN, NaN), s(MIN, -1), s(MIN, 10, 0), s(MIN, 10, Infinity), s(-1, 10), { at: MIN, tokens: '5', limit: LIMIT }]) {
    assert.equal(withSample(list, bad), list, JSON.stringify(bad));
  }
  let many = [];
  for (let i = 0; i < 130; i += 1) many = withSample(many, s(i * 1000, i));
  assert.equal(many.length, 120);
  assert.equal(many[many.length - 1].tokens, 129);
});

// ---- predictContext / shouldCompact ------------------------------------------

test('predictContext: null until there is enough history', () => {
  assert.equal(predictContext([]), null);
  assert.equal(predictContext([s(0, 1), s(5 * MIN, 2)]), null, 'fewer than MIN_SAMPLES');
  assert.equal(predictContext([s(0, 1), s(30_000, 2), s(MIN, 3)]), null, 'spanning less than MIN_SPAN_MS');
  assert.equal(predictContext(undefined), null);
});

test('predictContext: fill percent, tokens per minute and the time until the context is full', () => {
  assert.deepEqual(predictContext([s(0, 100_000), s(MIN, 120_000), s(2 * MIN, 140_000)]), {
    percent: 70,
    tokensPerMin: 20_000,
    etaMs: 3 * MIN,
  });
  assert.deepEqual(predictContext([s(0, 100_000), s(MIN, 100_000), s(2 * MIN, 100_000)]), { percent: 50, tokensPerMin: 0, etaMs: null });
  const over = predictContext([s(0, 150_000), s(MIN, 190_000), s(2 * MIN, 210_000)]);
  assert.deepEqual([over.percent, over.etaMs], [100, 0], 'past the limit: 100% and due now');
});

test('shouldCompact: past MIN_FILL_PERCENT and full within the horizon, once per window', () => {
  const p = (percent, etaMs) => ({ percent, tokensPerMin: 1, etaMs });
  assert.equal(shouldCompact(p(70, 3 * MIN), false), true);
  assert.equal(shouldCompact(p(70, CONTEXT_HORIZON_MS), false), true, 'the horizon itself counts');
  assert.equal(shouldCompact(p(70, CONTEXT_HORIZON_MS + 1), false), false);
  assert.equal(shouldCompact(p(49, MIN), false), false, 'a mostly empty context is left alone');
  assert.equal(shouldCompact(p(90, null), false), false, 'not growing');
  assert.equal(shouldCompact(p(70, 3 * MIN), true), false, 'already compacted in this window');
  assert.equal(shouldCompact(null, false), false);
  assert.equal(shouldCompact(p(70, 20 * MIN), false, 30 * MIN), true, 'the horizon is a parameter');
});

// ---- the stored mark and the resume brief --------------------------------------

test('normalizeContextResume shape-checks the stored mark', () => {
  for (const bad of [null, undefined, 'x', 5, {}, { at: -1, percent: 50 }, { at: 1, percent: 'x' }]) {
    assert.equal(normalizeContextResume(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(normalizeContextResume({ at: 5, percent: 87.4, etaMs: 'soon' }), { at: 5, percent: 87, etaMs: null });
  assert.deepEqual(normalizeContextResume({ at: 5, percent: 150, etaMs: 1000 }), { at: 5, percent: 100, etaMs: 1000 });
});

test('contextResumeSection: the progress summary of a marked package, nothing otherwise', () => {
  assert.equal(contextResumeSection({ touched: ['a.js'] }), '');
  assert.equal(contextResumeSection(null), '');
  const text = contextResumeSection({
    contextResume: { at: 1, percent: 87, etaMs: 3 * MIN },
    touched: ['src/a.js', 'src/b.js'],
    lastWords: 'Wired the  parser;\nnext the tests.',
  });
  assert.match(text, /^## Context \(LunaCore\)\n/);
  assert.match(text, /87% used, predicted full within 3 min/);
  assert.match(text, /- files changed in this worktree: src\/a\.js, src\/b\.js/);
  assert.match(text, /- your last message: Wired the parser; next the tests\./);
  assert.match(text, /git log --oneline -15/);

  const bare = contextResumeSection({ contextResume: { at: 1, percent: 91, etaMs: null }, touched: null });
  assert.match(bare, /\(91% used\)/);
  assert.match(bare, /- no changed files recorded yet/);
  assert.doesNotMatch(bare, /last message/);

  const files = Array.from({ length: 30 }, (_, i) => `f${i}.js`);
  const capped = contextResumeSection({ contextResume: { at: 1, percent: 80 }, touched: files });
  assert.match(capped, /f19\.js$/m);
  assert.doesNotMatch(capped, /f20\.js/);
});

// ---- createContextGuard ---------------------------------------------------------

function guardHarness({ enabled = true, live = true, accepts = true, canType = true, state = 'launched', awaitingDeps = false } = {}) {
  let clock = 0;
  const box = { pkg: { id: 'a', state, sessionId: 's1', awaitingDeps, contextResume: null } };
  const calls = { writes: [], patches: [], records: [], events: [], commits: 0 };
  const guard = createContextGuard({
    enabled: () => enabled,
    live: () => live,
    pkgBySession: (sessionId) => (sessionId === box.pkg.sessionId ? box.pkg : null),
    canType: () => canType,
    writePty: (sessionId, text) => {
      calls.writes.push([sessionId, text]);
      return accepts;
    },
    patch: (id, fields) => {
      calls.patches.push([id, fields]);
      box.pkg = { ...box.pkg, ...fields };
    },
    record: (id, entry) => calls.records.push([id, entry]),
    commit: () => {
      calls.commits += 1;
    },
    onEvent: (kind, data) => calls.events.push([kind, data]),
    now: () => clock,
  });
  /** One reading a minute later than the last. */
  const feed = (tokens, stepMs = MIN) => {
    clock += stepMs;
    return guard.onSample('s1', { tokens, limit: LIMIT });
  };
  return { guard, calls, box, feed };
}

test('a worker predicted to fill its context within 10 minutes gets /compact once', () => {
  const h = guardHarness();
  assert.equal(h.feed(100_000), true);
  h.feed(120_000);
  assert.deepEqual(h.calls.writes, [], 'not before MIN_SAMPLES over MIN_SPAN_MS');
  h.feed(140_000);
  assert.deepEqual(h.calls.writes, [['s1', COMPACT_TEXT]]);
  assert.deepEqual(h.calls.records, [['a', { at: 3 * MIN, kind: 'compact', reason: 'contextCompact', detail: '70% used, full in ~3 min' }]]);
  assert.deepEqual(h.calls.events, [['contextCompact', { id: 'a', percent: 70, etaMs: 3 * MIN }]]);
  assert.equal(h.calls.commits, 1);
  assert.deepEqual(h.calls.patches, [], 'a compact that was sent marks nothing');
  assert.deepEqual(h.guard.view(h.box.pkg), { percent: 70, etaMs: 3 * MIN, compacted: true, resumeMarked: false });

  // Still growing in the same window: never a second /compact.
  h.feed(160_000);
  h.feed(180_000);
  assert.equal(h.calls.writes.length, 1);

  // The compact landed (fewer tokens): a new window gets its own one compact.
  h.feed(40_000);
  assert.equal(h.guard.view(h.box.pkg).compacted, false);
  h.feed(100_000);
  h.feed(150_000);
  assert.equal(h.calls.writes.length, 2);
});

test('a slow-growing or mostly empty context is left alone', () => {
  const slow = guardHarness();
  for (const tokens of [100_000, 102_000, 104_000, 106_000]) slow.feed(tokens);
  assert.deepEqual(slow.calls.writes, [], 'full in ~47 min');
  const empty = guardHarness();
  for (const tokens of [10_000, 40_000, 70_000]) empty.feed(tokens);
  assert.deepEqual(empty.calls.writes, [], 'fast, but only 35% used');
});

test('a session that takes no input is marked for a resume with a progress summary instead', () => {
  const h = guardHarness({ accepts: false });
  for (const tokens of [100_000, 120_000, 140_000]) h.feed(tokens);
  assert.deepEqual(h.calls.writes, [['s1', COMPACT_TEXT]], 'tried once');
  assert.deepEqual(h.calls.patches, [['a', { contextResume: { at: 3 * MIN, percent: 70, etaMs: 3 * MIN } }]]);
  assert.equal(h.calls.records[0][1].reason, 'contextResume');
  assert.deepEqual(h.calls.events.map(([k]) => k), ['contextResume']);
  assert.deepEqual(h.guard.view(h.box.pkg), { percent: 70, etaMs: 3 * MIN, compacted: true, resumeMarked: true });
  assert.match(contextResumeSection(h.box.pkg), /70% used, predicted full within 3 min/);
  h.feed(160_000);
  assert.equal(h.calls.patches.length, 1, 'once per window');

  // A small dip is noise: same window, the mark stays.
  h.feed(150_000);
  assert.deepEqual([h.calls.patches.length, h.guard.view(h.box.pkg).compacted], [1, true]);
  // The worker compacted after all (a new window): the mark is stale and goes.
  h.feed(30_000);
  assert.deepEqual(h.calls.patches[1], ['a', { contextResume: null }]);
  assert.equal(h.guard.view(h.box.pkg).resumeMarked, false);
  assert.equal(contextResumeSection(h.box.pkg), '');
});

test('a worker that could be at a permission prompt is never typed into: it is marked instead', () => {
  const h = guardHarness({ canType: false });
  for (const tokens of [100_000, 120_000, 140_000]) h.feed(tokens);
  assert.deepEqual(h.calls.writes, [], 'Enter would answer an open prompt blindly');
  assert.deepEqual(h.calls.patches, [['a', { contextResume: { at: 3 * MIN, percent: 70, etaMs: 3 * MIN } }]]);
  assert.equal(h.calls.records[0][1].reason, 'contextResume');
  assert.equal(h.guard.view(h.box.pkg).resumeMarked, true);
});

test('without a canType the guard never types (the conservative default)', () => {
  const writes = [];
  let clock = 0;
  const pkg = { id: 'a', state: 'launched', sessionId: 's1' };
  const guard = createContextGuard({
    enabled: () => true,
    live: () => true,
    pkgBySession: () => pkg,
    writePty: (...args) => {
      writes.push(args);
      return true;
    },
    patch: () => {},
    record: () => {},
    commit: () => {},
    now: () => clock,
  });
  for (const tokens of [100_000, 120_000, 140_000]) {
    clock += MIN;
    guard.onSample('s1', { tokens, limit: LIMIT });
  }
  assert.deepEqual(writes, []);
});

test('off, another tab, or a worker that is not running: readings change nothing', () => {
  const off = guardHarness({ enabled: false });
  for (const tokens of [100_000, 120_000, 140_000]) assert.equal(off.feed(tokens), false);
  assert.equal(off.guard.view(off.box.pkg), null);

  const other = guardHarness();
  assert.equal(other.guard.onSample('s9', { tokens: 1, limit: LIMIT }), false);
  assert.equal(other.guard.onSample('s1', null), false);

  for (const opts of [{ state: 'finishing' }, { state: 'stalled' }, { awaitingDeps: true }, { live: false }]) {
    const h = guardHarness(opts);
    for (const tokens of [100_000, 120_000, 140_000]) assert.equal(h.feed(tokens), true, 'the reading is kept');
    assert.deepEqual(h.calls.writes, [], JSON.stringify(opts));
    assert.equal(h.guard.view(h.box.pkg).compacted, false);
  }
});

test('forget / clear drop the history of a session', () => {
  const h = guardHarness();
  for (const tokens of [100_000, 110_000]) h.feed(tokens);
  assert.notEqual(h.guard.view(h.box.pkg), null);
  h.guard.forget('s1');
  assert.equal(h.guard.view(h.box.pkg), null);
  h.feed(120_000);
  h.guard.clear();
  assert.equal(h.guard.view(h.box.pkg), null);
});
