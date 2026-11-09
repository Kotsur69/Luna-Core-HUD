// ============================================================================
// Free God Mode v2 F5 (FREE_GODMODE_V2_PLAN.md Slice F5), opt-in: when a free
// build run settles with "Claude review of luna-free/ branches" ticked, ONE
// read-only headless Claude review per pushed luna-free/* branch (diff vs
// base), written to docs/plans/<slug>/REVIEW.md (the run's own folder when
// the work did not come from a plan). Waits for the Claude limit like the
// planner. Off by default.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fr = require('../src/orchestraFreeReview');
const sup = require('../src/orchestraSupervisor');
const { writeReviewDoc } = require('../src/orchestraWiring');
const { createOrchestra } = require('../src/orchestra');

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;
const PASS = { ok: true, verdict: 'pass', reasons: [] };
const SHA = { a: 'aaa00001', b: 'bbb00002', c: 'ccc00003', d: 'aaa00001', e: 'eee00005' };

const freePkg = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  state: 'pushed',
  branch: `luna-free/${id}-1`,
  headSha: SHA[id],
  baseSha: 'base0001',
  todoAts: [],
  ...extra,
});

function freePlan(extra = {}) {
  return {
    id: 'run-1',
    projectId: 'p1',
    repoPath: '/repo',
    baseBranch: 'main',
    freeMode: true,
    settled: true,
    killed: false,
    options: { freeReview: true },
    packages: [
      freePkg('a', { todoAts: [1] }),
      freePkg('b', { todoAts: [2] }),
      freePkg('c', { state: 'stalled' }),
      freePkg('d', { branch: 'luna-free/a-1', todoAts: [1] }),
      freePkg('e', { branch: 'main' }),
    ],
    ...extra,
  };
}

const TODOS = [
  { at: 1, text: 'from a plan', done: true, tags: ['plan:auth-flow'] },
  { at: 2, text: 'loose to-do', done: true, tags: [] },
];

function reviewer({ plan = freePlan(), reviews = [PASS, PASS], todos = TODOS, writeOk = true } = {}) {
  let clock = T0;
  const log = { states: [], reviews: [], diffs: [], docs: [], events: [] };
  const timers = [];
  const queue = [...reviews];
  const current = { plan };
  const r = fr.createFreeReviewer({
    getPlan: () => current.plan,
    setState: (state) => log.states.push(state),
    runReview: async (input) => {
      log.reviews.push(input);
      return queue.length ? queue.shift() : PASS;
    },
    reviewDiff: async (input) => {
      log.diffs.push(input);
      return { ok: true, diff: `diff for ${input.to}`, stat: ' x | 1 +' };
    },
    reviewEnv: () => ({ PATH: '/bin' }),
    usageLimits: () => [],
    readTodos: () => todos,
    writeDoc: (repoPath, relPath, text) => {
      log.docs.push({ repoPath, relPath, text });
      return writeOk;
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
    onRunEvent: (kind, data) => log.events.push([kind, data]),
  });
  const advance = (ms) => {
    clock += ms;
    for (const t of timers) {
      if (!t.done && t.at <= clock) {
        t.done = true;
        t.fn();
      }
    }
  };
  const flush = async (n = 6) => {
    for (let i = 0; i < n; i += 1) await new Promise((res) => setImmediate(res));
  };
  const last = () => log.states[log.states.length - 1];
  return { r, log, advance, flush, last, current };
}

// ---- pure rules --------------------------------------------------------------

test('targets: pushed luna-free/* branches only, each once, never a protected branch', () => {
  assert.deepEqual(fr.reviewTargets(freePlan()).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(fr.reviewTargets({ ...freePlan(), freeMode: false }), [], 'not a free run');
  assert.deepEqual(fr.reviewTargets(freePlan({ packages: [freePkg('a', { headSha: '--all' })] })), [], 'no real commit');
});

test('output path: docs/plans/<plan slug>/REVIEW.md, else the run\'s own docs/plans/free-run-<id>/', () => {
  const groups = fr.reviewGroups(freePlan(), TODOS);
  assert.deepEqual(
    groups.map((g) => [g.path, g.packages.map((p) => p.id)]),
    [
      ['docs/plans/auth-flow/REVIEW.md', ['a']],
      ['docs/plans/free-run-run-1/REVIEW.md', ['b']],
    ],
  );
  assert.equal(fr.runSlugFor('Run_2!'), 'free-run-run-2');
  assert.equal(fr.runSlugFor(''), 'free-run');
  assert.equal(fr.reviewDocPath('free-run-x'), 'docs/plans/free-run-x/REVIEW.md');
});

test('skipped when unchecked (the default), unsettled, killed or already reviewed', () => {
  assert.equal(fr.wantsReview(freePlan()), true);
  assert.equal(fr.wantsReview(freePlan({ options: {} })), false, 'off by default');
  assert.equal(fr.wantsReview(freePlan({ options: { freeReview: false } })), false);
  assert.equal(fr.wantsReview(freePlan({ settled: false })), false);
  assert.equal(fr.wantsReview(freePlan({ killed: true })), false);
  assert.equal(fr.wantsReview(freePlan({ freeMode: false })), false, 'a Claude run');
  assert.equal(fr.wantsReview(freePlan({ freeReview: { state: 'done' } })), false, 'once per run');
  assert.equal(fr.wantsReview(freePlan({ freeReview: { state: 'failed' } })), true, 'a failed one may run again');
});

test('the option is opt-in: off in a fresh run, stored only while on, a valid live switch', () => {
  assert.ok(!('freeReview' in sup.normalizeOptions({})));
  assert.ok(!('freeReview' in sup.normalizeOptions({ freeReview: false })));
  assert.equal(sup.normalizeOptions({ freeReview: true }).freeReview, true);
  assert.equal(sup.isOptionsPatch({ freeReview: true }), true);
  assert.equal(sup.isOptionsPatch({ freeReview: 'yes' }), false);
  assert.deepEqual(sup.optionsPatch({ freeReview: true, evil: 1 }), { freeReview: true });
});

test('a stored review state drops a run in flight and any odd file path', () => {
  assert.equal(fr.normalizeStoredFreeReview({ state: 'running' }), null);
  assert.equal(fr.normalizeStoredFreeReview({ state: 'waiting' }), null);
  const back = fr.normalizeStoredFreeReview({
    state: 'done',
    total: 2,
    done: 2,
    files: ['docs/plans/auth-flow/REVIEW.md', '../../etc/passwd', 'docs/plans/x/PLAN.md'],
    results: [{ branch: 'luna-free/a-1', verdict: 'pass' }, { branch: 'x', verdict: 'maybe' }],
  });
  assert.deepEqual(back.files, ['docs/plans/auth-flow/REVIEW.md']);
  assert.deepEqual(back.results, [{ branch: 'luna-free/a-1', verdict: 'pass' }]);
});

// ---- the review queue ----------------------------------------------------------

test('one read-only review per branch, diff vs base, one REVIEW.md per folder', async () => {
  const s = reviewer({ reviews: [PASS, { ok: true, verdict: 'fail', reasons: ['no tests for <b>'] }] });
  assert.equal(s.r.start(), true);
  await s.flush();
  assert.equal(s.log.reviews.length, 2, 'a and b; c not pushed, d same branch, e protected');
  assert.deepEqual(
    s.log.diffs.map((d) => [d.cwd, d.from, d.to, d.mergeBase]),
    [
      ['/repo', 'main', SHA.a, true],
      ['/repo', 'main', SHA.b, true],
    ],
  );
  assert.deepEqual(s.log.reviews[0].env, { PATH: '/bin' });
  assert.match(s.log.reviews[0].prompt, /luna-free\/a-1/);
  assert.deepEqual(
    s.log.docs.map((d) => [d.repoPath, d.relPath]),
    [
      ['/repo', 'docs/plans/auth-flow/REVIEW.md'],
      ['/repo', 'docs/plans/free-run-run-1/REVIEW.md'],
    ],
  );
  assert.match(s.log.docs[0].text, /## `luna-free\/a-1` - PASS/);
  assert.match(s.log.docs[1].text, /## `luna-free\/b-1` - NEEDS WORK/);
  assert.match(s.log.docs[1].text, /- no tests for <b>/);
  const end = s.last();
  assert.equal(end.state, 'done');
  assert.deepEqual(end.files, ['docs/plans/auth-flow/REVIEW.md', 'docs/plans/free-run-run-1/REVIEW.md']);
  assert.deepEqual(end.results, [
    { branch: 'luna-free/a-1', verdict: 'pass' },
    { branch: 'luna-free/b-1', verdict: 'fail' },
  ]);
  assert.equal(s.r.isRunning(), false);
});

test('skipped when unchecked: no review, no file', async () => {
  const s = reviewer({ plan: freePlan({ options: {} }) });
  assert.equal(s.r.start(), false);
  await s.flush();
  assert.equal(s.log.reviews.length, 0);
  assert.equal(s.log.docs.length, 0);
  assert.equal(s.log.states.length, 0);
});

test('waits on the Claude limit like the planner, then carries on', async () => {
  const resetSec = Math.floor((T0 + 2 * HOUR) / 1000);
  const s = reviewer({ reviews: [{ ok: false, error: 'limit', detail: `usage limit reached|${resetSec}` }, PASS, PASS] });
  s.r.start();
  await s.flush();
  assert.equal(s.last().state, 'waiting');
  assert.ok(s.last().resumeAt >= resetSec * 1000, 'not before the reset');
  assert.equal(s.log.reviews.length, 1);
  assert.equal(s.log.docs.length, 0);
  assert.equal(s.r.isRunning(), true);
  s.advance(HOUR);
  await s.flush();
  assert.equal(s.log.reviews.length, 1, 'still waiting');
  s.advance(HOUR + 2 * 60 * 1000);
  await s.flush();
  assert.equal(s.log.reviews.length, 3, 'the waiting branch again, then the next one');
  assert.equal(s.last().state, 'done');
  assert.deepEqual(s.last().results.map((r) => r.verdict), ['pass', 'pass']);
});

test('a review that cannot run is written as not reviewed; the queue goes on', async () => {
  const s = reviewer({ reviews: [{ ok: false, error: 'badVerdict' }, PASS] });
  s.r.start();
  await s.flush();
  assert.equal(s.log.reviews.length, 2);
  assert.match(s.log.docs[0].text, /NOT REVIEWED/);
  assert.equal(s.last().state, 'done');
});

test('a kill during the wait stops the queue and writes nothing', async () => {
  const resetSec = Math.floor((T0 + HOUR) / 1000);
  const s = reviewer({ reviews: [{ ok: false, error: 'limit', detail: `limit reached|${resetSec}` }] });
  s.r.start();
  await s.flush();
  s.current.plan = { ...s.current.plan, killed: true };
  s.advance(2 * HOUR);
  await s.flush();
  assert.equal(s.log.reviews.length, 1);
  assert.equal(s.log.docs.length, 0);
  assert.equal(s.r.isRunning(), false);
});

test('no file could be written: the review ends failed', async () => {
  const s = reviewer({ writeOk: false });
  s.r.start();
  await s.flush();
  assert.equal(s.last().state, 'failed');
  assert.equal(s.last().error, 'writeFailed');
});

// ---- end to end through the run controller -----------------------------------

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

async function freeRun({ tick }) {
  const log = { reviews: [], docs: [] };
  let seq = 0;
  const orch = createOrchestra({
    now: () => T0,
    readTodos: () => [{ at: 1, text: 't1', done: false, tags: ['plan:auth-flow'] }],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({
      ok: true,
      raw: { packages: [{ id: 'a', title: 'A', todoAts: [1], prompt: 'do a', files: ['src/a.js'], dependsOn: [], verify: 'npm test', model: 'sonnet' }], notes: '' },
      costUsd: 0,
    }),
    addWorktree: async (repo, name, opts) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `${opts.branchPrefix || 'luna/'}${name}` }),
    headSha: async () => 'base0001',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => {
      seq += 1;
      return { id: `s${seq}` };
    },
    finishPackage: async () => ({ ok: true, headSha: 'abc1234' }),
    writePty: () => true,
    sessionAlive: () => true,
    tickTodos: () => {},
    saveState: () => {},
    loadState: () => null,
    setTimer: () => ({}),
    clearTimer: () => {},
    freeProfileId: () => 'free-a',
    freshEnv: () => ({ PATH: '/bin' }),
    usageLimits: () => [],
    reviewDiff: async () => ({ ok: true, diff: 'diff', stat: '' }),
    runReview: async (input) => {
      log.reviews.push(input);
      return PASS;
    },
    writeReviewDoc: (repoPath, relPath) => {
      log.docs.push([repoPath, relPath]);
      return true;
    },
  });
  orch.restore();
  const { plan } = await orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} });
  const res = await orch.launch({ planId: plan.id, ids: null, prompts: {}, workers: 'free' });
  assert.equal(res.ok, true, `launch: ${res.error}`);
  if (tick) assert.equal(orch.setOptions({ freeReview: true }).ok, true);
  orch.onTurnEnd('s1', turn('LUNA_DONE a'));
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  return { orch, log };
}

test('a settled free run with the box ticked reviews its luna-free/ branch once and writes REVIEW.md', async () => {
  const { orch, log } = await freeRun({ tick: true });
  assert.equal(orch.view().packages[0].state, 'pushed');
  assert.ok(orch.view().packages[0].branch.startsWith('luna-free/'));
  assert.equal(log.reviews.length, 1);
  assert.deepEqual(log.docs, [['/repo', 'docs/plans/auth-flow/REVIEW.md']]);
  assert.equal(orch.view().freeReview.state, 'done');
});

test('a settled free run with the box unticked (the default) runs no review', async () => {
  const { orch, log } = await freeRun({ tick: false });
  assert.equal(orch.view().packages[0].state, 'pushed');
  assert.equal(orch.view().settled, true);
  assert.equal(log.reviews.length, 0);
  assert.equal(log.docs.length, 0);
  assert.equal(orch.view().freeReview, null);
});

// ---- the file it writes ----------------------------------------------------------

test('writeReviewDoc: only docs/plans/<slug>/REVIEW.md inside the repo', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-free-review-'));
  const errors = [];
  const ctx = { logError: (line) => errors.push(line) };
  try {
    assert.equal(writeReviewDoc(ctx, repo, 'docs/plans/free-run-x/REVIEW.md', '# r\n'), true);
    assert.equal(fs.readFileSync(path.join(repo, 'docs', 'plans', 'free-run-x', 'REVIEW.md'), 'utf8'), '# r\n');
    assert.equal(writeReviewDoc(ctx, repo, 'docs/plans/../../evil/REVIEW.md', 'x'), false);
    assert.equal(writeReviewDoc(ctx, repo, 'docs/plans/x/PLAN.md', 'x'), false);
    assert.equal(writeReviewDoc(ctx, repo, 'src/main.js', 'x'), false);
    assert.equal(writeReviewDoc(ctx, repo, 'docs/plans/Bad_Slug/REVIEW.md', 'x'), false);
    assert.equal(writeReviewDoc(ctx, repo, 'docs/plans/x/REVIEW.md', null), false);
    assert.ok(!fs.existsSync(path.join(repo, 'evil')));
  } finally {
    await fs.promises.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('writeReviewDoc: a docs/plans link out of the repo gets no folder and no file; a linked REVIEW.md is refused', async () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-free-review-link-'));
  const repo = path.join(box, 'repo');
  const outside = path.join(box, 'outside');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.mkdirSync(outside);
  const ctx = { logError: () => {} };
  try {
    // A junction needs no admin rights on Windows; a dir symlink elsewhere.
    fs.symlinkSync(outside, path.join(repo, 'docs', 'plans'), 'junction');
    assert.equal(writeReviewDoc(ctx, repo, 'docs/plans/free-run-x/REVIEW.md', 'x'), false);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing made outside the repo');

    fs.unlinkSync(path.join(repo, 'docs', 'plans'));
    fs.mkdirSync(path.join(repo, 'docs', 'plans', 'free-run-y'), { recursive: true });
    const target = path.join(outside, 'secret.md');
    fs.writeFileSync(target, 'keep');
    let linked = true;
    try {
      fs.symlinkSync(target, path.join(repo, 'docs', 'plans', 'free-run-y', 'REVIEW.md'), 'file');
    } catch {
      linked = false; // no symlink rights on this machine: nothing to check
    }
    if (linked) {
      assert.equal(writeReviewDoc(ctx, repo, 'docs/plans/free-run-y/REVIEW.md', 'x'), false);
      assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
    }
  } finally {
    await fs.promises.rm(box, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
