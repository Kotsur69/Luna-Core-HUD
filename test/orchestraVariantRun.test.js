// ============================================================================
// God Mode A/B parallel builds, run side (src/orchestraVariantRun.js): a
// verified variant parks, the critic decides once both are done, the group
// adopts the winner and the loser is cleaned up - every effect faked. Plus
// the report's A/B section and the board strings in both languages.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { LOSER_CLEANUP_DELAY_MS, createVariantRunner, abReportLines } = require('../src/orchestraVariantRun.js');
const ab = require('../src/orchestraVariants.js');
const i18n = require('../src/lunasworkI18n.js');

const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

const GROUP_PROMPT = 'Parse the feed.';

function harness({ review, diff, remove, alive = true, runReview = true } = {}) {
  const plan = {
    killed: false,
    repoPath: '/repo',
    packages: [
      {
        id: 'a',
        title: 'Parse',
        prompt: GROUP_PROMPT,
        verify: 'npm test',
        state: 'pending',
        ab: { variants: [{ key: 'a', label: 'lib X' }, { key: 'b', label: 'lib Y' }], winner: null },
      },
      ...['a', 'b'].map((key, i) => ({
        id: `a-${key}`,
        title: `Parse [${key.toUpperCase()}]`,
        prompt: ab.variantPrompt(GROUP_PROMPT, { key, label: `lib ${key === 'a' ? 'X' : 'Y'}`, prompt: `Use lib ${key}.` }),
        abOf: 'a',
        abKey: key,
        abLabel: `lib ${key === 'a' ? 'X' : 'Y'}`,
        state: 'launched',
        terminal: false,
        root: `/wt/a-${key}-1`,
        cwd: `/wt/a-${key}-1`,
        branch: `luna/a-${key}-1`,
        baseSha: 'base000',
        sessionId: `s${i + 1}`,
      })),
    ],
  };
  const calls = { records: [], commits: 0, removed: [], finished: [], stalled: [], reviews: [], diffs: [], closed: [], worktrees: [], events: [], timers: [] };
  const findPkg = (id) => plan.packages.find((p) => p.id === id) || null;
  const patch = (id, fields) => {
    plan.packages = plan.packages.map((p) => (p.id === id ? { ...p, ...fields } : p));
  };
  const runner = createVariantRunner({
    getPlan: () => plan,
    findPkg,
    patch,
    record: (id, entry) => calls.records.push([id, entry]),
    commit: () => {
      calls.commits += 1;
    },
    removePackages: (ids) => {
      calls.removed.push(ids);
      plan.packages = plan.packages.filter((p) => !ids.includes(p.id));
    },
    finishGroup: (id) => calls.finished.push(id),
    stallGroup: (id, reason, detail) => calls.stalled.push([id, reason, detail]),
    runReview: runReview
      ? async (args) => {
          calls.reviews.push(args);
          return review ? review(args) : { ok: true, choice: 'b', reasons: ['smaller diff'] };
        }
      : null,
    reviewDiff: async (input) => {
      calls.diffs.push(input);
      return diff ? diff(input) : { ok: true, stat: ' 1 file changed', diff: `+diff up to ${input.to}` };
    },
    reviewEnv: () => ({ HOME: '/h' }),
    repoPath: () => plan.repoPath,
    closeSession: (id) => calls.closed.push(id),
    sessionAlive: () => alive,
    removeWorktree: async (repo, root) => {
      calls.worktrees.push([repo, root]);
      return remove ? remove(root) : { ok: true };
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      calls.timers.push(t);
      return t;
    },
    now: () => 9000,
    onEvent: (kind, data) => calls.events.push([kind, data]),
  });
  /** A variant's verify passed: finish() put it in 'finishing' and reports the build. */
  const build = (key, headSha) => {
    patch(`a-${key}`, { state: 'finishing' });
    return runner.onBuilt(`a-${key}`, { ok: true, headSha });
  };
  return { runner, plan, calls, findPkg, patch, build };
}

test('a verified variant parks; once both are, the critic reads both diffs and the group adopts its pick', async () => {
  const h = harness();
  assert.equal(h.runner.onBuilt('zzz', { ok: true }), false, 'not a variant');
  assert.equal(h.build('a', 'aaa1111'), true);
  assert.deepEqual(h.findPkg('a-a').abBuilt, { headSha: 'aaa1111', at: 9000 });
  assert.equal(ab.isParked(h.findPkg('a-a')), true);
  assert.deepEqual(h.calls.reviews, [], 'the twin is still building');
  assert.deepEqual(h.runner.view(h.findPkg('a-a')), { role: 'variant', of: 'a', key: 'a', label: 'lib X', built: true });

  h.build('b', 'bbb2222');
  assert.equal(h.runner.busy(), true, 'the critic is deciding');
  assert.equal(h.runner.view(h.findPkg('a')).reviewing, true);
  await flush();

  assert.deepEqual(h.calls.diffs, [
    { cwd: '/wt/a-a-1', from: 'base000', to: 'aaa1111' },
    { cwd: '/wt/a-b-1', from: 'base000', to: 'bbb2222' },
  ]);
  assert.equal(h.calls.reviews.length, 1);
  const call = h.calls.reviews[0];
  // The folder of both worktrees, never the main checkout ('/repo').
  assert.deepEqual([call.cwd, call.env, call.schema, call.validate], [path.dirname('/wt/a-a-1'), { HOME: '/h' }, ab.CRITIC_SCHEMA, ab.validateChoice]);
  assert.match(call.prompt, /### Variant A - lib X \(verify: passed\)/);
  assert.match(call.prompt, /\+diff up to bbb2222/);
  assert.match(call.prompt, /Use lib b\./, 'each variant approach is shown');

  const g = h.findPkg('a');
  assert.deepEqual(
    [g.state, g.branch, g.root, g.sessionId, g.headSha, g.verifiedSha],
    ['launched', 'luna/a-b-1', '/wt/a-b-1', 's2', 'bbb2222', 'bbb2222'],
  );
  assert.match(g.prompt, /## Variant B: lib Y/, 'the group runs on with its winner brief');
  assert.deepEqual(g.ab, {
    variants: [{ key: 'a', label: 'lib X' }, { key: 'b', label: 'lib Y' }],
    winner: 'b',
    by: 'critic',
    decidedAt: 9000,
    reasons: ['smaller diff'],
    losers: [{ key: 'a', label: 'lib X', branch: 'luna/a-a-1', headSha: 'aaa1111', outcome: 'lost', removed: false }],
  });
  assert.deepEqual(h.calls.removed, [['a-b', 'a-a']]);
  assert.deepEqual(h.plan.packages.map((p) => p.id), ['a'], 'only the group is left on the board');
  assert.deepEqual(h.calls.finished, ['a'], 'the group finishes: secret scan and push');
  assert.deepEqual(h.calls.closed, ['s1'], "the loser's tab closes");
  assert.equal(h.runner.busy(), false);
  assert.deepEqual(h.calls.events.map(([k]) => k), ['abBuilt', 'abBuilt', 'abReview', 'abDecided']);

  // The loser's worktree goes after a short settle; its branch stays.
  assert.deepEqual(h.calls.timers.map((t) => t.ms), [LOSER_CLEANUP_DELAY_MS]);
  assert.deepEqual(h.calls.worktrees, []);
  h.calls.timers[0].fn();
  await flush();
  assert.deepEqual(h.calls.worktrees, [['/repo', '/wt/a-a-1']]);
  assert.equal(h.findPkg('a').ab.losers[0].removed, true);
});

test('a dirty loser worktree is kept and stays marked so', async () => {
  const h = harness({ remove: () => ({ ok: false, error: 'dirty' }) });
  h.build('a', 'aaa1111');
  h.build('b', 'bbb2222');
  await flush();
  h.calls.timers[0].fn();
  await flush();
  assert.equal(h.findPkg('a').ab.losers[0].removed, false);
});

test('no usable critic answer keeps variant A and says why', async () => {
  for (const [opts, why] of [
    [{ review: () => ({ ok: false, error: 'timeout' }) }, 'timeout'],
    [{ review: () => ({ ok: false, error: 'badVerdict' }) }, 'badVerdict'],
    [{ review: () => { throw new Error('boom'); } }, 'failed'],
    [{ runReview: false }, 'noReview'],
  ]) {
    const h = harness(opts);
    h.build('a', 'aaa1111');
    h.build('b', 'bbb2222');
    await flush();
    const g = h.findPkg('a');
    assert.deepEqual([g.ab.winner, g.ab.by, g.branch], ['a', 'fallback', 'luna/a-a-1'], why);
    assert.deepEqual(g.ab.reasons, [`critic unavailable (${why}), variant A kept`]);
    assert.deepEqual(h.calls.finished, ['a']);
  }
});

test('a failed diff still lets the critic decide, with no diff shown', async () => {
  const h = harness({ diff: () => ({ ok: false, error: 'gitFailed' }) });
  h.build('a', 'aaa1111');
  h.build('b', 'bbb2222');
  await flush();
  assert.match(h.calls.reviews[0].prompt, /\(no diff available\)/);
  assert.equal(h.findPkg('a').ab.winner, 'b');
});

test('only one variant built: it wins without a review, the other is recorded with its error', async () => {
  const h = harness();
  h.patch('a-a', { state: 'stalled', terminal: true, error: 'blocked' });
  h.build('b', 'bbb2222');
  assert.deepEqual(h.calls.reviews, []);
  const g = h.findPkg('a');
  assert.deepEqual([g.ab.winner, g.ab.by, g.ab.reasons], ['b', 'only', []]);
  assert.deepEqual(g.ab.losers, [{ key: 'a', label: 'lib X', branch: 'luna/a-a-1', headSha: null, outcome: 'blocked', removed: false }]);
  assert.deepEqual(h.calls.finished, ['a']);
});

test('neither variant built: the group stalls once (abBothFailed); a killed variant is waited for', () => {
  const h = harness();
  h.patch('a-a', { state: 'stalled', terminal: true, error: 'blocked' });
  h.patch('a-b', { state: 'killed' });
  h.runner.evaluateAll();
  assert.deepEqual(h.calls.stalled, [], 'a kill is a pause: its Retry may still build it');
  h.patch('a-b', { state: 'closed' });
  h.runner.evaluateAll();
  assert.deepEqual(h.calls.stalled, [['a', 'abBothFailed', 'A: blocked; B: closed']]);
  h.patch('a', { state: 'stalled' });
  h.runner.evaluateAll();
  assert.equal(h.calls.stalled.length, 1, 'not again until a variant is retried');
});

test('a kill drops the pending verdict and stops parked variants with their build kept', async () => {
  const h = harness();
  h.build('a', 'aaa1111');
  h.build('b', 'bbb2222');
  h.plan.killed = true;
  h.runner.onKill();
  assert.equal(h.runner.busy(), false);
  await flush();
  assert.deepEqual([h.calls.finished, h.calls.removed], [[], []], 'the late answer is not used');
  assert.deepEqual(['a-a', 'a-b'].map((id) => [h.findPkg(id).state, !!h.findPkg(id).abBuilt]), [
    ['killed', true],
    ['killed', true],
  ]);
  assert.equal(h.findPkg('a').ab.winner, null);

  // Retry after the kill: the run is live again and the next pump decides.
  h.plan.killed = false;
  h.runner.evaluateAll();
  await flush();
  assert.equal(h.findPkg('a').ab.winner, 'b');
});

test('a variant whose verify ends after a kill stops with the run, its build kept', () => {
  const h = harness();
  h.plan.killed = true;
  assert.equal(h.build('a', 'aaa1111'), true);
  assert.deepEqual([h.findPkg('a-a').state, h.findPkg('a-a').abBuilt.headSha], ['killed', 'aaa1111'], 'Retry-able, not stuck in finishing');
  assert.deepEqual(h.calls.reviews, []);
});

test('a run paused at the usage limit or held decides nothing until it goes on', async () => {
  for (const stop of [{ pausedUntil: 123 }, { hold: { reason: 'noNodeModules' } }]) {
    const h = harness();
    Object.assign(h.plan, stop);
    h.build('a', 'aaa1111');
    h.build('b', 'bbb2222');
    await flush();
    assert.deepEqual([h.calls.reviews.length, h.findPkg('a').ab.winner], [0, null], JSON.stringify(stop));
    Object.assign(h.plan, { pausedUntil: null, hold: null });
    h.runner.evaluateAll();
    await flush();
    assert.equal(h.findPkg('a').ab.winner, 'b', JSON.stringify(stop));
  }
});

test('only a loser worktree beside the winner is removed, and only while its plan is the run', async () => {
  const far = harness();
  far.patch('a-a', { state: 'stalled', terminal: true, error: 'blocked', root: '/elsewhere/a-a-1' });
  far.build('b', 'bbb2222');
  assert.equal(far.findPkg('a').ab.winner, 'b');
  assert.deepEqual([far.calls.closed, far.calls.timers], [['s1'], []], 'its tab closes, its worktree is left alone');

  const gone = harness();
  gone.plan.id = 'p1';
  gone.build('a', 'aaa1111');
  gone.build('b', 'bbb2222');
  await flush();
  gone.plan.id = 'p2';
  gone.calls.timers[0].fn();
  await flush();
  assert.deepEqual(gone.calls.worktrees, [], 'a new plan: nothing is removed');
  assert.equal(gone.findPkg('a').ab.losers[0].removed, false);
});

test('variants that do not sit side by side get no critic: variant A is kept and the report says why', async () => {
  const h = harness();
  h.patch('a-b', { root: '/elsewhere/a-b-1' });
  h.build('a', 'aaa1111');
  h.build('b', 'bbb2222');
  await flush();
  assert.deepEqual(h.calls.reviews, []);
  assert.deepEqual([h.findPkg('a').ab.winner, h.findPkg('a').ab.reasons], ['a', ['critic unavailable (noWorktree), variant A kept']]);
});

test('a variant that runs again during the review is waited for, not judged on its old build', async () => {
  const h = harness();
  h.build('a', 'aaa1111');
  h.build('b', 'bbb2222');
  // Retried meanwhile: its build mark is spent (orchestra.js spentAbBuild).
  h.patch('a-a', { state: 'launched', abBuilt: null });
  await flush();
  assert.deepEqual([h.calls.finished, h.findPkg('a').ab.winner], [[], null]);
  h.build('a', 'aaa3333');
  await flush();
  assert.equal(h.calls.reviews.length, 2);
  assert.equal(h.findPkg('a').headSha, 'bbb2222');
});

test('view: a group shows its variants and the critic at work, a variant its role', () => {
  const h = harness();
  assert.deepEqual(h.runner.view(h.findPkg('a')), {
    role: 'group',
    variants: [{ key: 'a', label: 'lib X' }, { key: 'b', label: 'lib Y' }],
    winner: null,
    reviewing: false,
  });
  assert.equal(h.runner.view({ id: 'x' }), null);
});

// ---- the report ------------------------------------------------------------------

test('abReportLines: one row per group with winner, how, loser and its kept branch', () => {
  assert.deepEqual(abReportLines({ packages: [{ id: 'x' }] }), []);
  assert.deepEqual(abReportLines(null), []);
  const lines = abReportLines({
    packages: [
      {
        id: 'a',
        state: 'pushed',
        ab: {
          role: 'group',
          variants: [{ key: 'a', label: 'lib X' }, { key: 'b', label: 'lib|Y' }],
          winner: 'b',
          by: 'critic',
          reasons: ['smaller diff', 'keeps tests', 'third'],
          losers: [{ key: 'a', label: 'lib X', branch: 'luna/a-a-1', outcome: 'lost', removed: true }],
        },
      },
      { id: 'c', state: 'stalled', error: 'abBothFailed', ab: { role: 'group', variants: [], winner: null } },
      { id: 'c-a', ab: { role: 'variant' } },
    ],
  });
  assert.deepEqual(lines.slice(0, 5), ['', '## A/B builds', '', '| Package | Winner | Picked by | Loser | Loser branch (kept) |', '|---|---|---|---|---|']);
  assert.equal(lines[5], '| `a` | B: lib Y | critic: smaller diff: keeps tests | A: lib X (lost) | `luna/a-a-1`, worktree removed |', 'a pipe cannot break the table');
  assert.equal(lines[6], '| `c` | - | not decided (abBothFailed) | - | - |');
  assert.equal(lines.length, 7);
});

// ---- the board strings -----------------------------------------------------------

test('every A/B, self-heal and context string the board uses exists in Polish and English', () => {
  const layout = i18n.detectLayout(path.join(__dirname, '..'));
  const keys = [
    'orch.ab.building', 'orch.ab.reviewing', 'orch.ab.won', 'orch.ab.lost', 'orch.ab.variant', 'orch.ab.variantBuilt',
    'orch.ab.by.critic', 'orch.ab.by.only', 'orch.ab.by.fallback',
    'orch.heal.running', 'orch.heal.spent', 'orch.heal.kind.deps', 'orch.heal.kind.lock', 'orch.heal.kind.permission',
    'orch.ctx.compacted', 'orch.ctx.resume',
    'orch.pkgerr.abBothFailed', 'orch.fail.abNeedsClaude', 'orch.retryRefused.abGroup', 'orch.retryRefused.abBuilt', 'orch.warn.abDropped',
    'orchset.ab', 'orchset.ab.hint', 'orchset.heal', 'orchset.heal.hint', 'orchset.ctx', 'orchset.ctx.hint',
  ];
  for (const key of keys) {
    assert.ok(layout.keys.pl[key], `pl ${key}`);
    assert.ok(layout.keys.en[key], `en ${key}`);
  }
  // The board passes these placeholders (src/renderer/modules/orchestraEvolutionView.js).
  for (const [key, names] of [['orch.ab.building', ['a', 'b']], ['orch.ab.won', ['key', 'label', 'by']], ['orch.ab.lost', ['key', 'label', 'branch']], ['orch.heal.spent', ['kinds']]]) {
    for (const lang of ['pl', 'en']) {
      for (const name of names) assert.ok(layout.keys[lang][key].includes(`{${name}}`), `${lang} ${key} {${name}}`);
    }
  }
});
