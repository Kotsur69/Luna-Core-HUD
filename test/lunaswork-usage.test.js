// ============================================================================
// Luna's Work token accounting (src/lunasworkUsage.js, LW 2.17a): the usage
// of every `claude -p` JSON result, aggregated per role and iteration with
// the phase durations, kept with the run and booked by the controller.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  usageFromStdout,
  addUsage,
  emptyUsage,
  cleanLedger,
  closePhase,
  phaseTotals,
  cardsSeries,
  createUsageMeter,
} = require('../src/lunasworkUsage');
const { restoreRun } = require('../src/lunasworkRun');
const { createLunasWork } = require('../src/lunaswork');

const envelope = (usage, cost = 0.25, extra = {}) =>
  JSON.stringify({ type: 'result', is_error: false, result: '{}', total_cost_usd: cost, usage, ...extra });
const USAGE = { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
const usage = (n, cost = 0) => ({ calls: 1, inputTokens: n, outputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost });

// ---- usageFromStdout ------------------------------------------------------------------

test('usageFromStdout reads the JSON envelope usage and total_cost_usd', () => {
  assert.deepEqual(usageFromStdout(envelope(USAGE)), {
    calls: 1,
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 1000,
    cacheWriteTokens: 200,
    costUsd: 0.25,
  });
});

test('usageFromStdout takes the last result of a stream-json list', () => {
  const list = JSON.stringify([
    { type: 'system' },
    { type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01 },
    { type: 'result', usage: { input_tokens: 7, output_tokens: 3 }, total_cost_usd: 0.02 },
  ]);
  const u = usageFromStdout(list);
  assert.equal(u.inputTokens, 7);
  assert.equal(u.costUsd, 0.02);
});

test('usageFromStdout: junk, empty usage or negative numbers give null or zeros', () => {
  for (const bad of ['', 'not json', '42', 'null', JSON.stringify({ type: 'result' }), undefined]) {
    assert.equal(usageFromStdout(bad), null, String(bad));
  }
  const u = usageFromStdout(envelope({ input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: 3 }, -1));
  assert.deepEqual(u, { calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: 0 });
});

test('addUsage sums every field and never mutates its inputs', () => {
  const a = usage(10, 0.1);
  const b = usage(5, 0.05);
  const sum = addUsage(a, b);
  assert.equal(sum.calls, 2);
  assert.equal(sum.inputTokens, 15);
  assert.ok(Math.abs(sum.costUsd - 0.15) < 1e-9);
  assert.deepEqual(a, usage(10, 0.1));
  assert.deepEqual(addUsage(null, undefined), emptyUsage());
});

// ---- closePhase: the aggregation -------------------------------------------------------

test('closePhase books tokens per role into the iteration, the run totals and the phase time', () => {
  let ledger = closePhase(undefined, {
    iteration: 1,
    phase: 'directing',
    startedAt: 1000,
    at: 6000,
    entries: [{ role: 'director', usage: usage(100, 0.5) }],
  });
  ledger = closePhase(ledger, {
    iteration: 1,
    phase: 'playtesting',
    startedAt: 6000,
    at: 9000,
    entries: [{ role: 'playtester', usage: usage(40, 0.2) }, { role: 'playtester', usage: usage(10, 0.1) }],
  });
  ledger = closePhase(ledger, {
    iteration: 2,
    phase: 'directing',
    startedAt: 9000,
    at: 10000,
    entries: [{ role: 'director', usage: usage(1, 0) }],
  });

  assert.equal(ledger.total.calls, 4);
  assert.equal(ledger.total.inputTokens, 151);
  assert.ok(Math.abs(ledger.total.costUsd - 0.8) < 1e-9);
  assert.equal(ledger.byRole.director.inputTokens, 101);
  assert.equal(ledger.byRole.playtester.calls, 2);
  assert.equal(ledger.byRole.playtester.outputTokens, 50);
  assert.deepEqual(ledger.iterations.map((it) => it.n), [1, 2]);
  assert.deepEqual(ledger.iterations[0].phases, { directing: 5000, playtesting: 3000 });
  assert.equal(ledger.iterations[0].byRole.playtester.inputTokens, 50);
  assert.equal(ledger.iterations[1].byRole.director.inputTokens, 1);
  assert.deepEqual(phaseTotals(ledger), { directing: 6000, playtesting: 3000 });
});

test('closePhase ignores unknown roles, untimed phases and clock jumps, and does not mutate the ledger', () => {
  const start = closePhase(null, { iteration: 1, phase: 'building', startedAt: 0, at: 100, entries: [{ role: 'director', usage: usage(1) }] });
  const frozen = JSON.parse(JSON.stringify(start));
  const next = closePhase(start, {
    iteration: 1,
    phase: 'handed',
    startedAt: 0,
    at: 1e12,
    entries: [{ role: 'wizard', usage: usage(999) }, { role: 'critic' }, null],
  });
  assert.deepEqual(next, frozen, 'nothing booked');
  assert.deepEqual(start, frozen, 'input untouched');
  const jump = closePhase(start, { iteration: 1, phase: 'building', startedAt: 0, at: 30 * 24 * 3600 * 1000 });
  assert.equal(jump.iterations[0].phases.building, 100, 'a month-long phase is a clock jump');
});

test('cleanLedger re-validates a stored ledger and keeps the newest iterations', () => {
  const raw = {
    total: { calls: 2, inputTokens: 5.7, outputTokens: -1, costUsd: 'x' },
    byRole: { critic: { calls: 1, inputTokens: 5 }, hacker: { calls: 9 } },
    iterations: [{ n: 2, byRole: {}, phases: { building: 10, bogus: 5 } }, { n: 'x' }, { n: 1, phases: {} }, { n: 2, phases: { directing: 1 } }],
  };
  const clean = cleanLedger(raw);
  assert.deepEqual(clean.total, { calls: 2, inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
  assert.deepEqual(Object.keys(clean.byRole), ['critic']);
  assert.deepEqual(clean.iterations.map((it) => it.n), [1, 2]);
  assert.deepEqual(clean.iterations[1].phases, { directing: 1 }, 'the later duplicate wins');
  assert.deepEqual(cleanLedger('junk'), { total: emptyUsage(), byRole: {}, iterations: [] });
});

test('cardsSeries: opened and closed per iteration with totals', () => {
  const res = cardsSeries([
    { n: 1, cardsOpened: 3, cardsClosed: [11, 12] },
    { n: 2, cardsOpened: 1, cardsClosed: [] },
    { n: 'bad' },
  ]);
  assert.deepEqual(res, { series: [{ n: 1, opened: 3, closed: 2 }, { n: 2, opened: 1, closed: 0 }], opened: 4, closed: 2 });
  assert.deepEqual(cardsSeries(null), { series: [], opened: 0, closed: 0 });
});

// ---- the meter ---------------------------------------------------------------------------

test('meter.runner records the usage of a runClaude result and passes the result through', async () => {
  const meter = createUsageMeter();
  const run = meter.runner('director', async () => ({ stdout: envelope(USAGE) }));
  const res = await run({ args: [], prompt: 'p' });
  assert.equal(typeof res.stdout, 'string');
  await meter.runner('critic', async () => ({ error: 'timeout' }))({});
  const drained = meter.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].role, 'director');
  assert.equal(drained[0].usage.cacheReadTokens, 1000);
  assert.deepEqual(meter.drain(), [], 'drain clears');
});

test('meter.exec records only claude calls of an execFile-style function', async () => {
  const meter = createUsageMeter();
  const fakeExec = (file, _args, _opts, cb) => setImmediate(() => cb(null, file === 'claude' ? envelope(USAGE, 1) : envelope(USAGE, 9), ''));
  const exec = meter.exec('playtester', fakeExec);
  const out = await new Promise((resolve) => exec('claude', [], {}, (err, stdout) => resolve({ err, stdout })));
  assert.equal(out.err, null);
  assert.match(out.stdout, /total_cost_usd/);
  await new Promise((resolve) => exec('git', [], {}, resolve));
  const drained = meter.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].usage.costUsd, 1);
});

test('meter.add refuses unknown roles and empty usage', () => {
  const meter = createUsageMeter();
  meter.add('wizard', usage(5));
  meter.add('builder', {});
  meter.add('builder', { calls: 1, costUsd: 0.3 });
  assert.deepEqual(meter.drain().map((e) => e.role), ['builder']);
});

// ---- persistence + the controller --------------------------------------------------------

test('restoreRun keeps the usage ledger with the run, re-validated', () => {
  const ledger = closePhase(null, { iteration: 1, phase: 'critiquing', startedAt: 0, at: 50, entries: [{ role: 'critic', usage: usage(7, 0.07) }] });
  const base = { id: 'lwabc', projectId: 'p', repoPath: process.cwd(), phase: 'directing', iteration: 1, models: {}, history: [] };
  const run = restoreRun({ ...base, usage: ledger });
  assert.ok(run, 'restored');
  assert.deepEqual(run.usage, ledger);
  assert.deepEqual(restoreRun(base).usage, { total: emptyUsage(), byRole: {}, iterations: [] });
});

test('the controller books each phase: its time and the metered tokens of its role calls', async () => {
  let clock = 1_700_000_000_000;
  const meter = createUsageMeter();
  const saved = [];
  let directed = 0;
  const repo = process.cwd();
  const ctl = createLunasWork({
    store: { load: () => null, save: (d) => (saved.push(JSON.parse(JSON.stringify(d))), true) },
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => (id === 'game' ? { id, repoPath: repo } : null),
    profileFor: () => ({ adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' }),
    packStatus: () => ({ complete: true, missing: [] }),
    godModeActive: () => false,
    confirmStart: async () => true,
    todoStore: () => ({ read: () => [{ at: 1, text: 'card 1', done: false, tags: [] }], write: () => true }),
    // The Director "takes" 2 s and its claude -p call is metered; the second one stops the run.
    director: async () => {
      directed += 1;
      clock += 2000;
      await meter.runner('director', async () => ({ stdout: envelope(USAGE, 0.5) }))({});
      return directed === 1
        ? { ok: true, cards: [], model: 'opus', modelReason: 'setting' }
        : { ok: true, stop: true, cards: [], model: 'opus', modelReason: 'setting' };
    },
    build: async () => ({ ok: true, integration: { state: 'done', skipped: [] }, plan: { packages: [] } }),
    createAdapter: () => ({ evidenceDir: repo, start: async () => ({ url: 'http://localhost:3000' }), stop: async () => true, tools: () => ({}) }),
    playtest: async () => {
      clock += 3000;
      meter.add('playtester', usage(10, 0.1));
      return { ok: true, model: 'sonnet', report: { findings: [], scores: [], journeys: [], screens: [] } };
    },
    shipGate: () => ({ allPassed: false }),
    critic: async () => ({ ok: true, verdict: 'continue', model: 'sonnet', milestone: { name: 'm', passed: false, score: 40 }, next: 'm', allPassed: false }),
    usageMeter: meter,
    newRunId: () => 'lwusage1',
    now: () => clock,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  await ctl.start({ projectId: 'game' });
  for (let i = 0; i < 5; i += 1) await ctl.idle();

  const run = ctl.snapshot();
  assert.equal(run.phase, 'done');
  const { usage: ledger } = run;
  assert.equal(ledger.byRole.director.calls, 2, 'both Director calls');
  assert.equal(ledger.byRole.director.inputTokens, 200);
  assert.ok(Math.abs(ledger.byRole.director.costUsd - 1) < 1e-9);
  assert.equal(ledger.byRole.playtester.inputTokens, 10);
  assert.ok(Math.abs(ledger.total.costUsd - 1.1) < 1e-9, 'run total');
  const first = ledger.iterations.find((it) => it.n === 1);
  assert.equal(first.byRole.director.calls, 1, 'the first Director call belongs to iteration 1');
  assert.equal(first.phases.directing, 2000);
  assert.equal(first.phases.playtesting, 3000);
  // Persisted with the run: the last save carries the same ledger.
  assert.deepEqual(saved[saved.length - 1].usage, ledger);
  assert.deepEqual(meter.drain(), [], 'everything was booked');
});
