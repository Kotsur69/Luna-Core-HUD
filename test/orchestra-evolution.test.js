// ============================================================================
// God Mode evolutions at the controller (src/orchestra.js) with git, tabs,
// the install, the critic and timers faked: self-healing workers, the
// predictive context guard and A/B parallel builds - each off by default,
// on only through its God Mode setting (fixed per plan).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createOrchestra } = require('../src/orchestra.js');
const { LOCK_RETRY_MS } = require('../src/orchestraHeal.js');
const { COMPACT_TEXT } = require('../src/orchestraContextGuard.js');
const { CRITIC_SCHEMA } = require('../src/orchestraVariants.js');
const { LOSER_CLEANUP_DELAY_MS } = require('../src/orchestraVariantRun.js');

const turn = (text) =>
  JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

const pkg = (id, todoAts, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'opus',
  ...extra,
});

const VARIANTS = [
  { label: 'use lib X', prompt: 'Build it on lib X.' },
  { label: 'use lib Y', prompt: 'Build it on lib Y.' },
];
// The head each package's verify passed on (a group pushes its winner's).
const HEADS = { 'a-a': 'aaa1111', 'a-b': 'bbb2222' };
// The fake worktree of a branch: luna/<name> lives in /wt/<name>.
const rootOf = (branch) => path.join('/wt', String(branch).replace(/^luna\//, ''));

function setup({ packages, settings = {}, review = null } = {}) {
  let clock = 1_000_000;
  let seq = 0;
  const log = {
    sessions: [], writes: [], events: [], briefs: new Map(), closed: [], finishes: [],
    installs: [], reviews: [], diffs: [], removed: [], plannerArgs: [],
  };
  const timers = [];
  const alive = new Set();
  const orch = createOrchestra({
    now: () => clock,
    readTodos: () => [1, 2, 3].map((at) => ({ at, text: `t${at}`, done: false })),
    dirtyCount: async () => 0,
    runPlanner: async (args) => {
      log.plannerArgs.push(args);
      return { ok: true, raw: { packages, notes: '' }, costUsd: 0 };
    },
    addWorktree: async (repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base000',
    briefDir: () => '/cfg/tasks',
    writeBrief: (file, text) => {
      log.briefs.set(file, text);
      return true;
    },
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => {
      log.closed.push(id);
      alive.delete(id);
    },
    finishPackage: async (p) => {
      log.finishes.push(p);
      return { ok: true, headSha: p.verifiedSha || HEADS[p.id] || 'ccc3333' };
    },
    installDeps: async (root, opts) => {
      log.installs.push([root, opts || null]);
      return { ok: true, output: '' };
    },
    runReview: async (args) => {
      log.reviews.push(args);
      return review ? review(args) : { ok: true, choice: 'b', reasons: ['smaller change'] };
    },
    reviewDiff: async (input) => {
      log.diffs.push(input);
      return { ok: true, stat: ' 1 file changed', diff: `+work up to ${input.to}` };
    },
    removeWorktree: async (repo, root) => {
      log.removed.push([repo, root]);
      return { ok: true };
    },
    writePty: (sessionId, text) => {
      log.writes.push([sessionId, text]);
      return alive.has(sessionId);
    },
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', permissionMode: 'bypassPermissions', ...settings }),
    onRunEvent: (kind, data) => log.events.push([kind, data]),
    sleep: async () => {},
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.done = true;
    },
  });
  const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {} };
  const advance = (ms) => {
    clock += ms;
    for (const t of [...timers]) {
      if (!t.done && t.at <= clock) {
        t.done = true;
        t.fn();
      }
    }
  };
  const flush = async (n = 12) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const view = (id) => orch.view().packages.find((p) => p.id === id);
  const briefOf = (sessionIndex) => log.briefs.get(log.sessions[sessionIndex].task.briefPath);
  const briefFor = (branch) => log.briefs.get(path.join('/cfg/tasks', `${path.basename(rootOf(branch))}.md`));
  const events = (kind) => log.events.filter(([k]) => k === kind);
  return { orch, log, ctx, advance, flush, alive, view, briefOf, briefFor, events };
}

async function started(opts) {
  const s = setup(opts);
  const { plan } = await s.orch.makePlan(s.ctx);
  const launched = await s.orch.launch({ planId: plan.id });
  assert.equal(launched.ok, true, JSON.stringify(launched));
  return { ...s, planId: plan.id };
}

const fresh = (s) => s.log.installs.filter(([, opts]) => opts && opts.fresh === true);

// ---- self-healing workers -------------------------------------------------------

test('self-heal: a worker blocked on a missing module gets a fresh install and one resume, told why', async () => {
  const s = await started({ packages: [pkg('a', [1])], settings: { selfHeal: true } });
  assert.equal(s.orch.view().options.selfHeal, true, 'fixed in the plan');
  s.orch.onTurnEnd('s1', turn("LUNA_BLOCKED a: Cannot find module 'lodash'"));
  assert.deepEqual(s.view('a').heal, { heals: ['deps'], healing: 'deps' });
  assert.equal(s.view('a').state, 'stalled');

  await s.flush();
  assert.deepEqual(fresh(s), [[rootOf(s.view('a').branch), { fresh: true }]], "the worktree's own install, fresh - never a link");
  const a = s.view('a');
  assert.deepEqual([a.state, a.sessionId, a.autoResumed], ['launched', 's2', false], 'the automatic resume is not spent');
  assert.deepEqual(a.heal, { heals: ['deps'], healing: null });
  const brief = s.briefOf(1);
  assert.match(brief, /RESUMING/);
  assert.match(brief, /## Self-heal \(LunaCore\)/);
  assert.match(brief, /Cannot find module 'lodash'/);
  assert.deepEqual(s.log.closed, ['s1']);
  assert.deepEqual(s.log.events.map(([k]) => k).filter((k) => /^heal/.test(k)), ['healing', 'healed']);
  assert.deepEqual(a.stallHistory.filter((e) => e.kind === 'heal').map((e) => e.detail), ["deps: Cannot find module 'lodash'", 'deps: resumed']);

  // The same error again: never a second heal - the usual ladder takes over.
  s.orch.onTurnEnd('s2', turn("LUNA_BLOCKED a: Cannot find module 'lodash'"));
  await s.flush();
  assert.equal(fresh(s).length, 1);
  assert.deepEqual([s.view('a').state, s.view('a').autoResumed], ['launched', true]);
  assert.doesNotMatch(s.briefOf(2), /## Self-heal/);
});

test('self-heal: a locked file waits LOCK_RETRY_MS, keeps the run open meanwhile, and a kill cancels it', async () => {
  const s = await started({ packages: [pkg('a', [1])], settings: { selfHeal: true } });
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: EBUSY: resource busy or locked, rename x'));
  await s.flush();
  assert.equal(s.events('needYou').length, 0, 'a heal under way keeps the run open');
  s.advance(LOCK_RETRY_MS - 1);
  assert.equal(s.log.sessions.length, 1);
  s.advance(1);
  assert.equal(s.log.sessions.length, 2);
  assert.match(s.briefOf(1), /waited 30 s/);
  assert.deepEqual(fresh(s), [], 'a lock is waited out, nothing is installed');

  const k = await started({ packages: [pkg('a', [1])], settings: { selfHeal: true } });
  k.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: EPERM: operation not permitted, unlink x'));
  assert.equal(k.orch.kill(), true);
  k.advance(10 * LOCK_RETRY_MS);
  await k.flush();
  assert.equal(k.log.sessions.length, 1, 'nothing resumes a killed run');
});

test('self-heal is off unless the setting was on when the plan was made', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  assert.equal('selfHeal' in s.orch.view().options, false);
  s.orch.onTurnEnd('s1', turn("LUNA_BLOCKED a: Cannot find module 'lodash'"));
  await s.flush();
  assert.deepEqual(fresh(s), []);
  assert.deepEqual([s.view('a').state, s.view('a').autoResumed], ['launched', true], 'the usual automatic resume');
  assert.equal('heal' in s.view('a'), false);
});

// ---- predictive context routing ---------------------------------------------------

const MIN = 60_000;
const usage = (s, sessionId, tokens) => {
  s.advance(MIN);
  return s.orch.onSessionUsage(sessionId, null, { tokens, limit: 200_000 });
};

test('context guard: a worker predicted to fill its context within 10 minutes gets /compact once', async () => {
  const s = await started({ packages: [pkg('a', [1])], settings: { contextGuard: true } });
  assert.equal(usage(s, 's1', 100_000), true);
  usage(s, 's1', 120_000);
  assert.equal(s.log.writes.some(([, text]) => text === COMPACT_TEXT), false);
  usage(s, 's1', 140_000);
  assert.deepEqual(s.log.writes.filter(([, text]) => text === COMPACT_TEXT), [['s1', COMPACT_TEXT]]);
  assert.deepEqual(s.view('a').context, { percent: 70, etaMs: 3 * MIN, compacted: true, resumeMarked: false });
  assert.equal(s.view('a').stallHistory.filter((e) => e.kind === 'compact').length, 1);
  usage(s, 's1', 160_000);
  usage(s, 's1', 180_000);
  assert.equal(s.log.writes.filter(([, text]) => text === COMPACT_TEXT).length, 1, 'at most one per window');
  assert.equal(s.view('a').state, 'launched', 'the worker carries on');
});

test("context guard: a tab that takes no input is marked, and the next resume brief carries the worker's progress", async () => {
  const s = await started({ packages: [pkg('a', [1])], settings: { contextGuard: true } });
  s.alive.delete('s1');
  for (const tokens of [100_000, 120_000, 140_000]) usage(s, 's1', tokens);
  assert.equal(s.view('a').context.resumeMarked, true);
  s.orch.onTurnEnd('s1', turn('LUNA_BLOCKED a: the context is full'));
  await s.flush();
  const brief = s.briefOf(1);
  assert.match(brief, /RESUMING/);
  assert.match(brief, /## Context \(LunaCore\)/);
  assert.match(brief, /70% used, predicted full within 3 min/);
  assert.match(brief, /git log --oneline -15/);
  assert.equal('context' in s.view('a'), false, 'the mark is spent by that resume');
});

test('context guard: a worker without bypassPermissions is never typed into - a prompt could be open', async () => {
  const s = await started({ packages: [pkg('a', [1])], settings: { contextGuard: true, permissionMode: 'acceptEdits' } });
  for (const tokens of [100_000, 120_000, 140_000]) usage(s, 's1', tokens);
  assert.equal(s.log.writes.some(([, text]) => text === COMPACT_TEXT), false);
  assert.deepEqual(s.view('a').context, { percent: 70, etaMs: 3 * MIN, compacted: true, resumeMarked: true });
});

test('context guard is off unless the setting was on when the plan was made', async () => {
  const s = await started({ packages: [pkg('a', [1])] });
  for (const tokens of [100_000, 150_000, 190_000]) assert.equal(usage(s, 's1', tokens), true, 'still booked as usage');
  assert.equal(s.log.writes.some(([, text]) => text === COMPACT_TEXT), false);
  assert.equal('context' in s.view('a'), false);
});

// ---- A/B parallel builds ------------------------------------------------------------

async function abStarted(extra = {}) {
  return started({
    packages: [pkg('a', [1], { variants: VARIANTS }), pkg('b', [2], { dependsOn: ['a'] })],
    settings: { abBuild: true },
    ...extra,
  });
}

test('A/B: two variants build in parallel, the critic picks one, only the winner is pushed and the loser cleaned up', async () => {
  const s = await abStarted();
  assert.equal(s.log.plannerArgs[0].abBuild, true, 'the planner is asked for variants');
  assert.equal(s.orch.view().options.abBuild, true);
  assert.deepEqual(s.orch.view().packages.map((p) => p.id), ['a', 'a-a', 'a-b', 'b']);
  assert.deepEqual(['a', 'a-a', 'a-b', 'b'].map((id) => s.view(id).state), ['pending', 'launched', 'launched', 'pending']);
  assert.deepEqual(s.view('a').ab, {
    role: 'group',
    variants: [{ key: 'a', label: 'use lib X' }, { key: 'b', label: 'use lib Y' }],
    winner: null,
    reviewing: false,
  });
  const va = s.view('a-a');
  const vb = s.view('a-b');
  assert.match(s.briefFor(va.branch), /## Variant A: use lib X/);
  assert.match(s.briefFor(vb.branch), /## Variant B: use lib Y/);

  s.orch.onTurnEnd(va.sessionId, turn('LUNA_DONE a-a'));
  await s.flush();
  assert.deepEqual([s.view('a-a').state, s.view('a-a').ab.built], ['finishing', true], 'parked, not pushed');
  assert.equal(s.log.finishes[0].skipPush, true);
  assert.deepEqual(s.log.reviews, []);

  s.orch.onTurnEnd(vb.sessionId, turn('LUNA_DONE a-b'));
  await s.flush(30);
  assert.equal(s.log.reviews.length, 1);
  assert.equal(s.log.reviews[0].schema, CRITIC_SCHEMA);
  assert.deepEqual(s.log.diffs.map((d) => [d.cwd, d.to]), [[rootOf(va.branch), 'aaa1111'], [rootOf(vb.branch), 'bbb2222']]);

  // The group adopted variant B and went through its own finish (with push).
  const groupFinish = s.log.finishes.find((p) => p.id === 'a');
  assert.deepEqual(
    [groupFinish.branch, groupFinish.root, groupFinish.verifiedSha, groupFinish.skipPush],
    [vb.branch, rootOf(vb.branch), 'bbb2222', undefined],
  );
  assert.deepEqual(s.orch.view().packages.map((p) => p.id), ['a', 'b'], 'the variants are gone from the board');
  const a = s.view('a');
  assert.deepEqual([a.state, a.branch, a.ab.winner, a.ab.by, a.ab.reasons], ['pushed', vb.branch, 'b', 'critic', ['smaller change']]);
  assert.deepEqual(a.ab.losers.map((l) => [l.key, l.branch, l.outcome, l.removed]), [['a', va.branch, 'lost', false]]);
  assert.equal(s.view('b').state, 'launched', 'its dependant starts once the winner is pushed');
  assert.ok(s.log.closed.includes(va.sessionId), "the loser's tab is closed");
  assert.deepEqual(s.log.events.map(([k]) => k).filter((k) => /^ab/.test(k)), ['abBuilt', 'abBuilt', 'abReview', 'abDecided']);

  s.advance(LOSER_CLEANUP_DELAY_MS);
  await s.flush();
  assert.deepEqual(s.log.removed.filter(([, root]) => root === rootOf(va.branch)), [['/repo', rootOf(va.branch)]]);
  assert.equal(s.view('a').ab.losers[0].removed, true, 'worktree removed, branch kept');
});

test('A/B: neither variant built - the group stalls, Retry of the group is refused, a variant Retry decides again', async () => {
  const s = await abStarted();
  for (const id of ['a-a', 'a-b']) {
    s.orch.onTurnEnd(s.view(id).sessionId, turn(`LUNA_BLOCKED ${id}: one`));
    s.orch.onTurnEnd(s.view(id).sessionId, turn(`LUNA_BLOCKED ${id}: two`));
  }
  await s.flush();
  const a = s.view('a');
  assert.deepEqual([a.state, a.error, a.terminal], ['stalled', 'abBothFailed', true]);
  assert.equal(s.view('b').blockedBy, 'a');
  assert.equal(s.events('needYou').length, 1);
  assert.deepEqual(await s.orch.retry({ planId: s.planId, id: 'a' }), { ok: false, error: 'abGroup' });

  // Morning: Mati retries variant A; it builds, and wins as the only one.
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a-a' })).ok, true);
  s.orch.onTurnEnd(s.view('a-a').sessionId, turn('LUNA_DONE a-a'));
  await s.flush(30);
  assert.deepEqual(s.log.reviews, [], 'one build needs no critic');
  const g = s.view('a');
  assert.deepEqual([g.state, g.ab.winner, g.ab.by, g.terminal], ['pushed', 'a', 'only', false]);
  assert.equal(s.view('b').state, 'launched');
});

test('A/B: a kill is a pause - the built variant keeps its build and waits for its twin, which decides', async () => {
  const s = await abStarted();
  s.orch.onTurnEnd(s.view('a-a').sessionId, turn('LUNA_DONE a-a'));
  await s.flush();
  assert.equal(s.view('a-a').ab.built, true);
  assert.equal(s.orch.kill(), true);
  assert.deepEqual(['a-a', 'a-b'].map((id) => s.view(id).state), ['killed', 'killed']);
  assert.equal(s.view('a-a').ab.built, true, 'the verified build is kept for the decision');
  // The killed twin is waited for, not judged: the built one's Retry says so.
  assert.deepEqual(await s.orch.retry({ planId: s.planId, id: 'a-a' }), { ok: false, error: 'abBuilt' });
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a-b' })).ok, true);
  assert.equal(s.view('a-b').state, 'launched');

  // While the twin runs, the built one parks again with its build: no new worker, no nudge.
  const before = [s.log.sessions.length, s.log.writes.length];
  assert.equal((await s.orch.retry({ planId: s.planId, id: 'a-a' })).ok, true);
  assert.deepEqual([s.view('a-a').state, s.view('a-a').ab.built], ['finishing', true]);
  assert.deepEqual([s.log.sessions.length, s.log.writes.length], before);
  assert.equal(s.log.finishes.filter((p) => p.id === 'a-a').length, 1, 'its verify is not run again');

  s.orch.onTurnEnd(s.view('a-b').sessionId, turn('LUNA_DONE a-b'));
  await s.flush(30);
  assert.equal(s.log.reviews.length, 1, 'the critic compares both builds');
  assert.deepEqual([s.view('a').state, s.view('a').ab.winner], ['pushed', 'b']);
});

test('A/B: a plan with variants is refused as a free run', async () => {
  const s = setup({ packages: [pkg('a', [1], { variants: VARIANTS })], settings: { abBuild: true } });
  const { plan } = await s.orch.makePlan(s.ctx);
  assert.deepEqual(await s.orch.launch({ planId: plan.id, workers: 'free' }), { ok: false, error: 'abNeedsClaude' });
  assert.equal(s.log.sessions.length, 0);
});

test('A/B is off unless the setting was on: variants from the planner are ignored', async () => {
  const s = await started({ packages: [pkg('a', [1], { variants: VARIANTS })] });
  assert.equal('abBuild' in s.log.plannerArgs[0], false);
  assert.deepEqual(s.orch.view().packages.map((p) => p.id), ['a']);
  assert.equal('ab' in s.view('a'), false);
  assert.equal(s.view('a').state, 'launched');
});

test('A/B is never asked of the free planner, even with the setting on', async () => {
  const s = setup({ packages: [pkg('a', [1], { variants: VARIANTS })], settings: { abBuild: true } });
  const made = await s.orch.makePlan({ ...s.ctx, planner: 'free' });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal('abBuild' in s.log.plannerArgs[0], false);
  assert.equal('abBuild' in made.plan.options, false);
  assert.deepEqual(made.plan.packages.map((p) => p.id), ['a']);
});
