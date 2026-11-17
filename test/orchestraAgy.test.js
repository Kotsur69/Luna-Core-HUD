// God Mode on the Antigravity CLI (src/orchestraAgy.js): the allow-lists,
// which packages and helper jobs route to agy, the Approve profile check and
// the agy planner's headless call.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const agy = require('../src/orchestraAgy.js');
const workers = require('../src/orchestraWorkers.js');
const plan = require('../src/orchestraPlan.js');
const { PLANNERS: BUILD_PLANNERS } = require('../src/orchestraPlanBuild.js');
const { PLANNERS: RUN_PLANNERS } = require('../src/orchestraPlanRunStart.js');

const TODOS = [{ at: 1, text: 'Fix the header colour', done: false }];
const PLAN_JSON = { packages: [{ id: 'hdr', title: 'Header', todoAts: [1], prompt: 'Fix it', files: ['a.css'], dependsOn: [], verify: 'npm test', model: 'sonnet', effort: 'medium' }], notes: 'n' };

/** A fake execFile: records the call, answers with `stdout` (or `error`). */
function fakeExec({ stdout = '', error = null } = {}) {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    const call = { file, args, opts, stdin: '' };
    calls.push(call);
    setImmediate(() => cb(error, stdout, ''));
    return { stdin: { on() {}, end: (text) => { call.stdin = text; } } };
  };
  return { calls, exec };
}

// ---- allow-lists ----------------------------------------------------------------

test('allow-lists: agy is a planner and a Workers choice everywhere; junk is refused', () => {
  assert.deepEqual([...agy.PLANNERS], ['claude', 'agy', 'free']);
  assert.deepEqual([...BUILD_PLANNERS], ['claude', 'agy', 'free']);
  assert.deepEqual([...RUN_PLANNERS], ['claude', 'agy', 'free']);
  assert.deepEqual([...workers.WORKERS], ['claude', 'agy', 'hybrid', 'free']);
  assert.equal(agy.normalizePlanner('agy'), 'agy');
  for (const bad of ['Agy', 'gemini', '', null, undefined, 1, {}]) assert.equal(agy.normalizePlanner(bad), null);
  assert.equal(workers.normalizeWorkers('agy'), 'agy');
  assert.equal(workers.normalizeWorkers('AGY'), null);
});

test('Workers rules: agy plans, approves and is stored like any other choice', () => {
  assert.equal(workers.planWorkers('agy', 'claude'), 'agy');
  assert.equal(workers.planWorkers('agy', 'agy'), 'agy');
  assert.equal(workers.planWorkers('agy', 'free'), 'free', 'a free planner still plans free-only');
  assert.equal(workers.approveWorkers({}, { workers: 'agy' }), 'agy');
  assert.equal(workers.approveWorkers({ workers: 'agy' }, {}), 'agy');
  assert.equal(workers.approveWorkers({ buildPlanner: 'free' }, { workers: 'agy' }), 'free');
  assert.equal(workers.storedWorkers({ workers: 'agy' }), 'agy');
});

// ---- routing --------------------------------------------------------------------

test('packageRunsAgy: workers agy, hybrid agy packages and worker model agy route to the agy profile', () => {
  assert.equal(agy.packageRunsAgy({ workers: 'agy' }, { id: 'a' }), true);
  assert.equal(agy.packageRunsAgy({ workers: 'agy' }, { id: 'a', modelOverride: 'opus' }), true, 'an agy run stays on agy');
  assert.equal(agy.packageRunsAgy({ workers: 'hybrid' }, { model: 'agy' }), true);
  assert.equal(agy.packageRunsAgy({ workers: 'hybrid' }, { model: 'agy', modelOverride: 'sonnet' }), false, 'a hand-over goes to Claude');
  assert.equal(agy.packageRunsAgy({ workers: 'hybrid' }, { model: 'free' }), false);
  assert.equal(agy.packageRunsAgy({ workerModel: 'agy' }, { model: 'opus' }), true);
  assert.equal(agy.packageRunsAgy({}, { modelOverride: 'agy' }), true);
  // Claude-only, free and plan runs never go to agy.
  assert.equal(agy.packageRunsAgy({}, { model: 'agy' }), false);
  assert.equal(agy.packageRunsAgy({ workers: 'free', workerModel: 'agy' }, {}), false);
  assert.equal(agy.packageRunsAgy({ freeMode: true, workers: 'agy' }, {}), false);
  assert.equal(agy.packageRunsAgy({ workers: 'agy', planRun: {} }, {}), false);
  assert.equal(agy.packageRunsAgy(null, {}), false);
});

test('runUsesAgy: agy workers, an agy planner or worker model agy put the helper jobs on agy', () => {
  assert.equal(agy.runUsesAgy({ workers: 'agy' }), true);
  assert.equal(agy.runUsesAgy({ buildPlanner: 'agy' }), true);
  assert.equal(agy.runUsesAgy({ workerModel: 'agy' }), true);
  assert.equal(agy.runUsesAgy({}), false);
  assert.equal(agy.runUsesAgy({ workers: 'hybrid', packages: [{ model: 'agy' }] }), false, 'one agy package keeps Claude helpers');
  assert.equal(agy.runUsesAgy({ freeMode: true, workers: 'agy' }), false);
  assert.equal(agy.runUsesAgy(null), false);
});

test('approveAgyProfile: an agy run gets the agy profile; none configured is a clear refusal', () => {
  const pkgs = { packages: [{ id: 'a', model: 'agy' }, { id: 'b', model: 'sonnet' }] };
  assert.deepEqual(agy.approveAgyProfile(pkgs, { workers: 'agy', agyProfileId: 'agy-1' }), { ok: true, profileId: 'agy-1' });
  assert.deepEqual(agy.approveAgyProfile(pkgs, { workers: 'agy', agyProfileId: null }), { ok: false, error: 'noAgyProfile' });
  assert.deepEqual(agy.approveAgyProfile(pkgs, { workers: 'hybrid', agyProfileId: '' }), { ok: false, error: 'noAgyProfile' });
  assert.deepEqual(agy.approveAgyProfile(pkgs, { workers: 'claude', workerModel: 'agy', agyProfileId: null }), { ok: false, error: 'noAgyProfile' });
  // Nothing on agy needs no profile.
  assert.deepEqual(agy.approveAgyProfile(pkgs, { workers: 'claude', workerModel: 'opus', agyProfileId: null }), { ok: true, profileId: null });
  assert.deepEqual(agy.approveAgyProfile(pkgs, { workers: 'free', workerModel: 'agy', agyProfileId: null }), { ok: true, profileId: null });
  assert.deepEqual(agy.approveAgyProfile({ packages: [{ model: 'sonnet' }] }, { workers: 'hybrid', agyProfileId: null }), { ok: true, profileId: null });
});

// ---- headless agy -----------------------------------------------------------------

test('extractJsonObject: bare, fenced or wrapped in prose; junk is null', () => {
  assert.deepEqual(agy.extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(agy.extractJsonObject('Here:\n```json\n{"a":2}\n```\nDone.'), { a: 2 });
  assert.deepEqual(agy.extractJsonObject('Plan follows {"a":3} end'), { a: 3 });
  assert.equal(agy.extractJsonObject('no json here'), null);
  assert.equal(agy.extractJsonObject('[1,2]'), null);
  assert.equal(agy.extractJsonObject(''), null);
  assert.deepEqual(agy.parseAgyJson('nothing'), { ok: false, error: 'badJson' });
});

test('runAgyPrint: argv is --print (plus accept-edits), prompt on stdin; a missing agy is noAgy', async () => {
  const { calls, exec } = fakeExec({ stdout: 'ok' });
  const res = await agy.runAgyPrint({ cwd: 'C:/repo', env: { E: '1' }, prompt: 'hello', timeout: 1000, execImpl: exec });
  assert.deepEqual(res, { ok: true, stdout: 'ok' });
  assert.equal(calls[0].file, 'agy');
  assert.deepEqual(calls[0].args, ['--print']);
  assert.equal(calls[0].stdin, 'hello');
  assert.equal(calls[0].opts.windowsHide, true);
  const edits = fakeExec({ stdout: '' });
  await agy.runAgyPrint({ cwd: 'C:/repo', env: {}, prompt: 'x', timeout: 1000, edits: true, execImpl: edits.exec });
  assert.deepEqual(edits.calls[0].args, ['--print', '--mode', 'accept-edits']);
  const missing = fakeExec({ error: Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }) });
  assert.equal((await agy.runAgyPrint({ cwd: '.', env: {}, prompt: 'x', timeout: 1, execImpl: missing.exec })).error, 'noAgy');
  const killed = fakeExec({ error: Object.assign(new Error('killed'), { killed: true }) });
  assert.equal((await agy.runAgyPrint({ cwd: '.', env: {}, prompt: 'x', timeout: 1, execImpl: killed.exec })).error, 'timeout');
  const failed = fakeExec({ error: new Error('exit 1') });
  const f = await agy.runAgyPrint({ cwd: '.', env: {}, prompt: 'x', timeout: 1, execImpl: failed.exec });
  assert.equal(f.error, 'failed');
  assert.match(f.detail, /exit 1/);
});

test('runPlanner agy: one headless agy call with the JSON contract in the prompt, parsed for validatePlan', async () => {
  const { calls, exec } = fakeExec({ stdout: `Sure.\n\`\`\`json\n${JSON.stringify(PLAN_JSON)}\n\`\`\`` });
  const res = await plan.runPlanner({ cwd: __dirname, env: { G: '1' }, openTodos: TODOS, planner: 'agy', model: 'sonnet', execImpl: exec });
  assert.equal(res.ok, true);
  assert.deepEqual(res.raw, PLAN_JSON);
  assert.equal(res.costUsd, null);
  assert.equal(calls[0].file, 'agy');
  assert.deepEqual(calls[0].args, ['--print']);
  assert.deepEqual(calls[0].opts.env, { G: '1' });
  assert.match(calls[0].stdin, /You are the planner for LunaCore God Mode/);
  assert.match(calls[0].stdin, /exactly ONE JSON object/);
  assert.ok(calls[0].stdin.includes(JSON.stringify(plan.PLAN_SCHEMA)));
  // The answer goes through the same validator as a Claude plan.
  assert.equal(plan.validatePlan(res.raw, TODOS).packages[0].id, 'hdr');
});

test('runPlanner agy: a hybrid run gets the hybrid schema; a non-JSON answer is badJson; a missing agy is noAgy', async () => {
  const hybrid = fakeExec({ stdout: JSON.stringify(PLAN_JSON) });
  await plan.runPlanner({ cwd: __dirname, env: {}, openTodos: TODOS, planner: 'agy', hybrid: true, execImpl: hybrid.exec });
  assert.ok(hybrid.calls[0].stdin.includes(JSON.stringify(plan.HYBRID_PLAN_SCHEMA)));
  assert.match(hybrid.calls[0].stdin, /"model": "agy" is also allowed/);
  const prose = fakeExec({ stdout: 'I could not plan this.' });
  assert.deepEqual(await plan.runPlanner({ cwd: __dirname, env: {}, openTodos: TODOS, planner: 'agy', execImpl: prose.exec }), { ok: false, error: 'badJson' });
  const missing = fakeExec({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
  const res = await plan.runPlanner({ cwd: __dirname, env: {}, openTodos: TODOS, planner: 'agy', execImpl: missing.exec });
  assert.equal(res.error, 'noAgy');
});

// ---- helper jobs on agy ------------------------------------------------------------

test('runReview cli agy: one agy call with the schema in the prompt, the caller validator decides', async () => {
  const { runReview } = require('../src/orchestraReview.js');
  const schema = { type: 'object', properties: { choice: { type: 'string' } } };
  const validate = (raw) => (raw && typeof raw.choice === 'string' ? { choice: raw.choice } : null);
  const ok = fakeExec({ stdout: 'Verdict:\n{"choice":"a"}' });
  const res = await runReview({ cwd: __dirname, env: { G: '1' }, prompt: 'review this', schema, validate, cli: 'agy', execImpl: ok.exec });
  assert.deepEqual(res, { ok: true, choice: 'a', costUsd: null });
  assert.equal(ok.calls[0].file, 'agy');
  assert.deepEqual(ok.calls[0].args, ['--print']);
  assert.match(ok.calls[0].stdin, /^review this/);
  assert.ok(ok.calls[0].stdin.includes(JSON.stringify(schema)));
  const bad = fakeExec({ stdout: '{"other":1}' });
  assert.deepEqual(await runReview({ cwd: __dirname, env: {}, prompt: 'p', schema, validate, cli: 'agy', execImpl: bad.exec }), { ok: false, error: 'badVerdict' });
  // Without cli the review is the Claude call, unchanged.
  const claude = fakeExec({ stdout: JSON.stringify({ structured_output: { choice: 'b' }, total_cost_usd: 0 }) });
  await runReview({ cwd: __dirname, env: {}, prompt: 'p', schema, validate, execImpl: claude.exec });
  assert.equal(claude.calls[0].file, 'claude');
});

test('runResolver cli agy: agy --print with accept-edits and the resolver prompt; claude stays the default', async () => {
  const { runResolver } = require('../src/orchestraIntegrate.js');
  const agyCall = fakeExec({ stdout: 'done' });
  const res = await runResolver({ cwd: __dirname, env: { G: '1' }, branch: 'luna/x', files: ['a.js'], cli: 'agy' }, agyCall.exec);
  assert.equal(res.ok, true);
  assert.equal(agyCall.calls[0].file, 'agy');
  assert.deepEqual(agyCall.calls[0].args, ['--print', '--mode', 'accept-edits']);
  assert.match(agyCall.calls[0].stdin, /resolving a git merge conflict/);
  const missing = fakeExec({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
  const failed = await runResolver({ cwd: __dirname, env: {}, branch: 'luna/x', files: ['a.js'], cli: 'agy' }, missing.exec);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /agy not found/);
});

test('createMergeRunDeps: an agy run asks the integration for the agy resolver; a Claude run does not', async () => {
  const { createMergeRunDeps } = require('../src/orchestraMergeRun.js');
  const seen = [];
  for (const run of [{ id: 'p1', repoPath: '/r', workers: 'agy' }, { id: 'p2', repoPath: '/r' }]) {
    const mr = createMergeRunDeps({
      getPlan: () => run,
      integrateMerge: async (_args, extra) => {
        seen.push(extra.cli);
        return { ok: true };
      },
      runFixup: async () => ({ ok: true }),
    });
    await mr.integrateMerge({ packages: [], checkOnly: true }, {});
  }
  assert.deepEqual(seen, ['agy', undefined]);
});

test('runTopicSplit agy: Plan only splits on agy with the topics schema in the prompt', async () => {
  const { runTopicSplit } = require('../src/orchestraPlanRunStart.js');
  const split = fakeExec({ stdout: '```json\n{"topics":[{"id":"a"}]}\n```' });
  const res = await runTopicSplit({ cwd: __dirname, env: { G: '1' }, request: 'Plan the login', planner: 'agy', execImpl: split.exec });
  assert.deepEqual(res, { ok: true, raw: { topics: [{ id: 'a' }] }, costUsd: null });
  assert.equal(split.calls[0].file, 'agy');
  assert.deepEqual(split.calls[0].args, ['--print']);
  assert.match(split.calls[0].stdin, /exactly ONE JSON object/);
  const claude = fakeExec({ stdout: JSON.stringify({ structured_output: { topics: [] } }) });
  await runTopicSplit({ cwd: __dirname, env: {}, request: 'x', planner: 'claude', execImpl: claude.exec });
  assert.equal(claude.calls[0].file, 'claude');
});

test('validatePlan: "agy" is a valid package model (hybrid pick and manual card pick)', () => {
  const raw = { packages: [{ ...PLAN_JSON.packages[0], model: 'agy' }] };
  assert.equal(plan.validatePlan(raw, TODOS).packages[0].model, 'agy');
  assert.equal(plan.validatePlan(raw, TODOS, { hybrid: true }).packages[0].model, 'agy');
  assert.equal(plan.validatePlan({ packages: [{ ...PLAN_JSON.packages[0], model: 'gemini' }] }, TODOS).packages[0].model, null);
});
