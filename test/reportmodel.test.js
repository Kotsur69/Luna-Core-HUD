// ============================================================================
// LunaCore - report models (src/reportmodel.js): which model writes the
// weekly review and the brief, stored as {provider, model}
// ----------------------------------------------------------------------------
// Pins: old plain-string stores load as {provider, model}; main refuses an
// unknown provider or model (agy ids against the live `agy models` list);
// an agy pick routes the one prompt through execAgy with `--model <id>`,
// a Claude pick through `claude -p`; an unreachable or unknown agy model
// fails visibly with a reason naming agy, never retried on Claude.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rm = require('../src/reportmodel.js');
const { runJob } = require('../src/missionrunner.js');
const { createWeeklyStore, createWeeklyReview } = require('../src/weeklyreview.js');
const { createBrief, createBriefStore } = require('../src/missionbrief.js');

const HYDROGEN = 'gemini-4-hydrogen-low';
const AGY_ENV = { PATH: '/agy/bin', LUNA_MARK: 'agy-profile' };
const CLAUDE_ENV = { LUNA_MARK: 'claude' };

/** A fake live `agy models` cache holding only HYDROGEN. */
function fakeAgyModels() {
  const ensured = [];
  return {
    ensured,
    ensure: async () => {
      ensured.push(true);
      return [];
    },
    isKnownId: (id) => id === HYDROGEN,
    choices: () => [
      { id: 'agy', name: 'Antigravity' },
      { id: `agy:${HYDROGEN}`, name: 'Antigravity - Gemini 4 Hydrogen (Low)' },
    ],
  };
}

/** child_process.execFile stand-in: records each spawn, answers from `reply`. */
function fakeExec(reply) {
  const spawns = [];
  const exec = (file, args, opts, cb) => {
    const call = { file, args, opts, stdin: null };
    spawns.push(call);
    const finish = () => {
      const [error, stdout, stderr] = reply(call);
      cb(error, stdout, stderr);
    };
    if (file !== 'agy') {
      // claude -p with the prompt as an argument: no stdin.
      setImmediate(finish);
      return null;
    }
    return {
      stdin: {
        on: () => {},
        end: (text) => {
          call.stdin = text;
          finish();
        },
      },
    };
  };
  return { exec, spawns };
}

const tempFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reportmodel-')), name);

// --- normalize / migration ---------------------------------------------------------

test('normalizeReportModel: old plain strings load as {provider, model}', () => {
  assert.deepEqual(rm.normalizeReportModel('haiku'), { provider: 'claude', model: 'haiku' });
  assert.deepEqual(rm.normalizeReportModel('opus'), { provider: 'claude', model: 'opus' });
  assert.deepEqual(rm.normalizeReportModel('agy'), { provider: 'agy', model: null });
  assert.deepEqual(rm.normalizeReportModel(`agy:${HYDROGEN}`), { provider: 'agy', model: HYDROGEN });
  assert.deepEqual(rm.normalizeReportModel({ provider: 'agy', model: HYDROGEN }), { provider: 'agy', model: HYDROGEN });
  // Missing or unreadable -> the default (Haiku), or null when asked for no fallback.
  assert.deepEqual(rm.normalizeReportModel(undefined), { provider: 'claude', model: 'haiku' });
  assert.equal(rm.normalizeReportModel('gpt-5', null), null);
});

test('normalizeReportModel refuses unknown providers, models and argv-shaped ids', () => {
  for (const junk of [
    { provider: 'openai', model: 'gpt-5' },
    { provider: 'claude', model: 'fable' },
    { provider: 'claude', model: 'agy' },
    { provider: 'agy', model: '--print' },
    { provider: 'agy', model: 'a b' },
    { provider: 'agy', model: 'x'.repeat(81) },
    'AGY',
    'agy:',
    'agy:--model',
    ['haiku'],
    42,
  ]) {
    assert.equal(rm.normalizeReportModel(junk, null), null, JSON.stringify(junk));
  }
});

test('weekly store: an old plain-string file still loads, entries included', () => {
  const file = tempFile('mission-weekly.local.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, model: 'agy', weeks: { '2026-W43': { at: 1, model: 'sonnet', review: null, failure: 'bad-json', data: {} } } }));
  const s = createWeeklyStore({ file }).load();
  assert.deepEqual(s.model, { provider: 'agy', model: null });
  assert.deepEqual(s.weeks['2026-W43'].model, { provider: 'claude', model: 'sonnet' });
});

test('choiceOf / runModelOf / reportModelLabel', () => {
  const hydro = { provider: 'agy', model: HYDROGEN };
  assert.equal(rm.choiceOf({ provider: 'claude', model: 'sonnet' }), 'sonnet');
  assert.equal(rm.choiceOf({ provider: 'agy', model: null }), 'agy');
  assert.equal(rm.choiceOf(hydro), `agy:${HYDROGEN}`);
  assert.equal(rm.runModelOf(hydro), `agy:${HYDROGEN}`);
  assert.equal(rm.reportModelLabel({ provider: 'claude', model: 'haiku' }), 'Haiku');
  assert.equal(rm.reportModelLabel(hydro), `Antigravity - ${HYDROGEN}`);
  assert.equal(rm.reportModelLabel(hydro, { [HYDROGEN]: 'Gemini 4 Hydrogen (Low)' }), 'Antigravity - Gemini 4 Hydrogen (Low)');
});

// --- validation against the real lists -----------------------------------------------

test('reportModelChoices: Claude models, then agy and its live models', () => {
  const ids = rm.reportModelChoices(fakeAgyModels()).map((c) => c.id);
  assert.deepEqual(ids, ['haiku', 'sonnet', 'opus', 'agy', `agy:${HYDROGEN}`]);
  // No cache: plain agy is still on offer.
  assert.deepEqual(rm.reportModelChoices(null).map((c) => c.id), ['haiku', 'sonnet', 'opus', 'agy']);
});

test('parseChoice: agy ids are checked against the live list, never trusted', async () => {
  const cache = fakeAgyModels();
  assert.deepEqual(await rm.parseChoice('opus', cache), { provider: 'claude', model: 'opus' });
  assert.deepEqual(await rm.parseChoice('agy', cache), { provider: 'agy', model: null });
  assert.deepEqual(await rm.parseChoice(`agy:${HYDROGEN}`, cache), { provider: 'agy', model: HYDROGEN });
  assert.equal(cache.ensured.length, 1);
  for (const junk of ['agy:gemini-9-made-up', 'gpt-5', { provider: 'agy', model: HYDROGEN }, null, `agy:${HYDROGEN} `]) {
    assert.equal(await rm.parseChoice(junk, cache), null, JSON.stringify(junk));
  }
  // An agy id without a cache to check it against is refused.
  assert.equal(await rm.parseChoice(`agy:${HYDROGEN}`, null), null);
});

// --- routing --------------------------------------------------------------------------

test('runJob on agy:<id>: one `agy --print --model <id>` with the agy env, never claude', async () => {
  const f = fakeExec(() => [null, '{"headline":"H"}', '']);
  const res = await runJob({ prompt: 'review', model: `agy:${HYDROGEN}`, lean: true, env: CLAUDE_ENV, agyEnv: AGY_ENV, exec: f.exec, agyModels: fakeAgyModels() });
  assert.deepEqual(res, { ok: true, answer: { headline: 'H' }, costUsd: null });
  assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0].file, 'agy');
  const args = f.spawns[0].args;
  assert.equal(args[args.indexOf('--model') + 1], HYDROGEN);
  assert.equal(f.spawns[0].opts.env, AGY_ENV);
  assert.match(f.spawns[0].stdin, /^review\n\n/);
});

test('runJob on a Claude model runs `claude -p --model <m>`, never agy', async () => {
  const f = fakeExec(() => [null, JSON.stringify({ result: '{"headline":"H"}', total_cost_usd: 0.01 }), '']);
  const res = await runJob({ prompt: 'review', model: 'sonnet', lean: true, env: CLAUDE_ENV, agyEnv: AGY_ENV, exec: f.exec });
  assert.equal(res.ok, true);
  assert.equal(f.spawns[0].file, 'claude');
  assert.equal(f.spawns[0].args[f.spawns[0].args.indexOf('--model') + 1], 'sonnet');
  assert.equal(f.spawns[0].opts.env, CLAUDE_ENV);
});

test('weekly review on hydrogen: the next run uses it and the stored entry names it', async () => {
  const store = createWeeklyStore({ file: tempFile('mission-weekly.local.json') });
  store.setModel(await rm.parseChoice(`agy:${HYDROGEN}`, fakeAgyModels()));
  const runs = [];
  const review = createWeeklyReview({
    collect: async (week) => ({ week, from: '2026-10-19', to: '2026-10-25' }),
    run: async (job) => {
      runs.push(job);
      return { ok: true, answer: { headline: 'A week.' }, costUsd: null };
    },
    getEnv: () => CLAUDE_ENV,
    getAgyEnv: () => AGY_ENV,
    store,
    now: () => new Date(2026, 9, 25, 21).getTime(),
  });
  const res = await review.generate('2026-W43');
  assert.equal(res.ok, true);
  assert.equal(runs[0].model, `agy:${HYDROGEN}`);
  assert.equal(runs[0].agyEnv, AGY_ENV);
  assert.equal(runs[0].lean, true);
  assert.deepEqual(res.entry.model, { provider: 'agy', model: HYDROGEN });
});

/** A brief over a fresh store on `model`, with the given run. */
function briefOn(model, run) {
  const store = createBriefStore({ file: tempFile('mission-brief.local.json') });
  store.setModel(model);
  const sources = {
    range: async () => ({ ok: true, hours: [], projects: [], totalUsd: 0 }),
    commits: async () => [],
    calendar: async () => ({ events: [], weather: {} }),
    todos: async () => ({ totalOpen: 0, projects: [] }),
    goals: async () => [],
    review: async () => null,
  };
  return createBrief({ store, run, getEnv: () => CLAUDE_ENV, getAgyEnv: () => AGY_ENV, sources, now: () => new Date(2026, 9, 26, 9).getTime() });
}

test('daily brief on agy: lean, no Gmail tools, no mail in the prompt or the answer', async () => {
  const runs = [];
  const brief = briefOn({ provider: 'agy', model: HYDROGEN }, async (job) => {
    runs.push(job);
    return { ok: true, answer: { headline: 'Today.', mail: [{ threadId: 'abc', from: 'x', subject: 'y', why: 'z' }] }, costUsd: null };
  });
  const res = await brief.generate('daily');
  assert.equal(runs[0].model, `agy:${HYDROGEN}`);
  assert.equal(runs[0].lean, true);
  assert.equal(runs[0].allowed, undefined);
  assert.equal(runs[0].agyEnv, AGY_ENV);
  assert.doesNotMatch(runs[0].prompt, /mcp__claude_ai_Gmail/);
  assert.deepEqual(res.entry.brief.mail, []);
  assert.deepEqual(res.entry.model, { provider: 'agy', model: HYDROGEN });
});

test('daily brief on Claude keeps the Gmail tools and never asks for agy', async () => {
  const runs = [];
  const brief = briefOn({ provider: 'claude', model: 'sonnet' }, async (job) => {
    runs.push(job);
    return { ok: true, answer: { headline: 'Today.' }, costUsd: 0.02 };
  });
  await brief.generate('daily');
  assert.equal(runs[0].model, 'sonnet');
  assert.equal(runs[0].agyEnv, undefined);
  assert.ok(runs[0].allowed.length > 0);
  assert.match(runs[0].prompt, /mcp__claude_ai_Gmail__search_threads/);
});

// --- visible failures -------------------------------------------------------------------

test('an agy model the live list lacks is refused before any spawn (agy-bad-model)', async () => {
  const f = fakeExec(() => [null, '{}', '']);
  const res = await runJob({ prompt: 'p', model: 'agy:gemini-9-made-up', lean: true, agyEnv: AGY_ENV, exec: f.exec, agyModels: fakeAgyModels() });
  assert.deepEqual(res, { ok: false, reason: 'agy-bad-model', costUsd: null });
  assert.equal(f.spawns.length, 0);
});

test('an unreachable agy fails with a reason naming agy, never a Claude retry', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const err = (props) => Object.assign(new Error('x'), props);
    for (const [error, reason] of [
      [err({ code: 'ENOENT' }), 'no-agy'],
      [err({ killed: true }), 'agy-timeout'],
      [err({ code: 1 }), 'agy-failed'],
    ]) {
      const f = fakeExec(() => [error, '', 'down']);
      const res = await runJob({ prompt: 'p', model: `agy:${HYDROGEN}`, lean: true, env: CLAUDE_ENV, agyEnv: AGY_ENV, exec: f.exec, agyModels: fakeAgyModels() });
      assert.equal(res.reason, reason);
      assert.deepEqual(f.spawns.map((s) => s.file), ['agy']);
    }
  } finally {
    console.error = quiet;
  }
});

test('a weekly review whose agy model is unreachable is saved with the failure and the model', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const store = createWeeklyStore({ file: tempFile('mission-weekly.local.json') });
    store.setModel({ provider: 'agy', model: HYDROGEN });
    const f = fakeExec(() => [Object.assign(new Error('x'), { code: 'ENOENT' }), '', '']);
    const review = createWeeklyReview({
      collect: async (week) => ({ week }),
      run: (job) => runJob({ ...job, exec: f.exec, agyModels: fakeAgyModels() }),
      getEnv: () => CLAUDE_ENV,
      getAgyEnv: () => AGY_ENV,
      store,
      now: () => new Date(2026, 9, 25, 21).getTime(),
    });
    const res = await review.generate('2026-W43');
    assert.equal(res.entry.review, null);
    assert.equal(res.entry.failure, 'no-agy');
    assert.deepEqual(res.entry.model, { provider: 'agy', model: HYDROGEN });
    assert.deepEqual(f.spawns.map((s) => s.file), ['agy']);
  } finally {
    console.error = quiet;
  }
});
