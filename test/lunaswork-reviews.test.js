// ============================================================================
// Luna's Work scheduled specialist reviews (LW 2.15): security every 3rd
// iteration, performance every 5th, cleanup at each milestone gate; findings
// become cards through the Critic's validation (bug cards get a repro test)
// tagged run:<id> and review:<type>; the calls are read-only; a failing
// reviewer never throws. `claude` is a fake runner.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../src/lunasworkReviews.js');
const { REPRO_ACCEPTANCE } = require('../src/lunasworkCritic.js');

const RUN_ID = 'steel-7';
const REPO = __dirname;

/** The `claude -p --output-format json` envelope around a structured answer. */
const envelope = (structured, cost = 0.25) => JSON.stringify({ structured_output: structured, total_cost_usd: cost });

/** Fake runner: records each call, answers per agent. */
function fakeClaude(answers) {
  const calls = [];
  const run = async (call) => {
    calls.push(call);
    const agent = call.args[call.args.indexOf('--agent') + 1];
    const answer = answers[agent];
    if (typeof answer === 'function') return answer(call);
    return answer || { stdout: envelope({ cards: [] }) };
  };
  return { run, calls };
}

const baseOpts = (extra) => ({ runId: RUN_ID, repoPath: REPO, diff: 'diff --git a/x.js b/x.js', ...extra });

test('reviewsDue: security every 3rd, performance every 5th, cleanup at gates', () => {
  assert.deepEqual(R.reviewsDue(1, false), []);
  assert.deepEqual(R.reviewsDue(3, false), ['security']);
  assert.deepEqual(R.reviewsDue(5, false), ['performance']);
  assert.deepEqual(R.reviewsDue(6, false), ['security']);
  assert.deepEqual(R.reviewsDue(15, false), ['security', 'performance']);
  assert.deepEqual(R.reviewsDue(2, true), ['cleanup']);
  assert.deepEqual(R.reviewsDue(15, true), ['security', 'performance', 'cleanup']);
});

test('reviewsDue: bad iterations have nothing due', () => {
  assert.deepEqual(R.reviewsDue(0, true), []);
  assert.deepEqual(R.reviewsDue(-3, false), []);
  assert.deepEqual(R.reviewsDue(3.5, false), []);
  assert.deepEqual(R.reviewsDue('3', false), []);
});

test('buildReviewArgs: read-only tools, the ECC agent, the json schema', () => {
  const args = R.buildReviewArgs({ type: 'security', model: 'sonnet' });
  assert.equal(args[args.indexOf('--agent') + 1], 'ecc:security-reviewer');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.deepEqual(tools, ['Read', 'Grep', 'Glob']);
  for (const banned of ['Edit', 'Write', 'Bash']) assert.equal(tools.includes(banned), false);
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), R.REVIEW_SCHEMA);
  assert.equal(args.includes('-p'), true);
  assert.equal(R.buildReviewArgs({ type: 'performance' }).includes('ecc:performance-optimizer'), true);
  assert.equal(R.buildReviewArgs({ type: 'cleanup' }).includes('ecc:refactor-cleaner'), true);
});

test('REVIEW_SCHEMA: a reviewer only files new cards', () => {
  const props = R.REVIEW_SCHEMA.properties.cards.items.properties;
  assert.equal('updatesCardId' in props, false);
  assert.equal('splitsCardId' in props, false);
  assert.deepEqual(R.REVIEW_SCHEMA.required, ['cards']);
});

test('reviewCards: findings become validated, tagged cards', () => {
  const out = R.reviewCards({
    cards: [
      { kind: 'feel', severity: 'low', text: 'Rename helper', details: '', acceptance: [], files: [] },
      { kind: 'bug', severity: 'high', text: 'Path traversal in export', details: 'user path joined raw', acceptance: [], files: ['src/x.js'] },
      { kind: 'nonsense', severity: 'high', text: 'dropped', details: '', acceptance: [], files: [] },
      { kind: 'idea', severity: 'low', text: 'idea before the gate', details: '', acceptance: [], files: [] },
    ],
  }, { type: 'security', runId: RUN_ID });
  assert.deepEqual(out.errors, []);
  assert.equal(out.cards.length, 2);
  // The Critic's ordering: bugs first.
  const [bug, feel] = out.cards;
  assert.equal(bug.text, 'Path traversal in export');
  assert.equal(bug.acceptance[0], REPRO_ACCEPTANCE);
  assert.match(bug.details, /repro test/i);
  assert.deepEqual(bug.tags, ['run:steel-7', 'kind:bug', 'sev:high', 'review:security']);
  assert.deepEqual(bug.extraTags, ['review:security']);
  assert.equal(bug.review, 'security');
  assert.deepEqual(feel.tags, ['run:steel-7', 'kind:feel', 'sev:low', 'review:security']);
  const codes = out.warnings.map((w) => w.code);
  assert.ok(codes.includes('badCard'));
  assert.ok(codes.includes('ideaBeforeGate'));
  assert.ok(codes.includes('reproAdded'));
});

test('reviewCards: a malformed reply or run id is an error, never a throw', () => {
  assert.equal(R.reviewCards(null, { type: 'security', runId: RUN_ID }).errors[0].code, 'badReview');
  assert.equal(R.reviewCards({ cards: 'x' }, { type: 'security', runId: RUN_ID }).errors[0].code, 'badReview');
  assert.equal(R.reviewCards({ cards: [] }, { type: 'security', runId: '' }).errors[0].code, 'badRunId');
});

test('runReviews: runs each due review with the reviewer model and tags cards by type', async () => {
  const bug = { kind: 'bug', severity: 'blocker', text: 'SQL built by string concat', details: '', acceptance: [], files: [] };
  const slow = { kind: 'missing', severity: 'medium', text: 'Cache the parsed config', details: '', acceptance: [], files: [] };
  const claude = fakeClaude({
    'ecc:security-reviewer': { stdout: envelope({ cards: [bug] }, 0.5) },
    'ecc:performance-optimizer': { stdout: envelope({ cards: [slow] }, 0.25) },
  });
  const roles = [];
  const out = await R.runReviews(baseOpts({
    iteration: 15,
    isGate: true,
    pickModel: (role) => { roles.push(role); return { model: 'haiku', reason: 'setting' }; },
    runClaude: claude.run,
  }));
  assert.deepEqual(out.due, ['security', 'performance', 'cleanup']);
  assert.equal(claude.calls.length, 3);
  assert.deepEqual(roles, ['reviewer']);
  for (const call of claude.calls) {
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'haiku');
    assert.equal(call.cwd, REPO);
    assert.match(call.prompt, /diff --git a\/x\.js/);
    assert.match(call.prompt, /READ-ONLY/);
  }
  assert.deepEqual(out.cards.map((c) => c.review), ['security', 'performance']);
  assert.ok(out.cards[0].tags.includes('review:security'));
  assert.ok(out.cards[1].tags.includes('review:performance'));
  assert.ok(out.cards.every((c) => c.tags.includes('run:steel-7')));
  assert.deepEqual(out.notes, []);
  // 0.5 + 0.25 + the cleanup reviewer's empty answer at 0.25.
  assert.equal(out.costUsd, 1);
});

test('runReviews: nothing due means no call', async () => {
  const claude = fakeClaude({});
  const out = await R.runReviews(baseOpts({ iteration: 1, isGate: false, runClaude: claude.run }));
  assert.equal(claude.calls.length, 0);
  assert.deepEqual(out.cards, []);
  assert.deepEqual(out.notes, []);
  assert.equal(out.costUsd, null);
});

test('runReviews: a pickModel returning a string or nothing still yields a model', async () => {
  const claude = fakeClaude({});
  await R.runReviews(baseOpts({ iteration: 3, isGate: false, pickModel: () => 'opus', runClaude: claude.run }));
  await R.runReviews(baseOpts({ iteration: 3, isGate: false, pickModel: () => null, runClaude: claude.run }));
  const models = claude.calls.map((c) => c.args[c.args.indexOf('--model') + 1]);
  assert.deepEqual(models, ['opus', 'sonnet']);
});

test('runReviews: a failing reviewer never throws and leaves a note', async () => {
  const feel = { kind: 'feel', severity: 'low', text: 'Remove unused helper', details: '', acceptance: [], files: [] };
  const claude = fakeClaude({
    'ecc:security-reviewer': async () => { throw new Error('spawn exploded'); },
    'ecc:performance-optimizer': { error: 'timeout' },
    'ecc:refactor-cleaner': { stdout: envelope({ cards: [feel] }) },
  });
  const logs = [];
  const out = await R.runReviews(baseOpts({
    iteration: 15, isGate: true, runClaude: claude.run, log: (m) => logs.push(m),
  }));
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].review, 'cleanup');
  assert.equal(out.notes.length, 2);
  assert.match(out.notes[0], /^security review failed: crashed \(spawn exploded\)/);
  assert.equal(out.notes[1], 'performance review failed: timeout');
  assert.equal(logs.length, 2);
});

test('runReview: bad JSON or a malformed reply resolve to no cards and a note', async () => {
  const badJson = await R.runReview('security', { ...baseOpts(), iteration: 3, runClaude: async () => ({ stdout: 'not json' }) });
  assert.deepEqual(badJson.cards, []);
  assert.deepEqual(badJson.notes, ['security review failed: badJson']);
  const malformed = await R.runReview('cleanup', { ...baseOpts(), iteration: 3, runClaude: async () => ({ stdout: envelope({ nope: 1 }) }) });
  assert.deepEqual(malformed.notes, ['cleanup review failed: badReview']);
  const nothing = await R.runReview('performance', { ...baseOpts(), iteration: 5, runClaude: async () => undefined });
  assert.deepEqual(nothing.notes, ['performance review failed: failed']);
  const unknown = await R.runReview('style', { ...baseOpts(), iteration: 5 });
  assert.deepEqual(unknown.notes, ['style review failed: unknownType']);
});

test('runReviews: a bad run id or missing repo fails every due review without a call', async () => {
  const claude = fakeClaude({});
  const badId = await R.runReviews({ iteration: 15, isGate: false, runId: '', repoPath: REPO, runClaude: claude.run });
  assert.deepEqual(badId.notes, ['security review failed: badRunId', 'performance review failed: badRunId']);
  const noRepo = await R.runReviews(baseOpts({ iteration: 3, isGate: false, runClaude: claude.run, isDir: () => false }));
  assert.deepEqual(noRepo.notes, ['security review failed: noRepo']);
  assert.equal(claude.calls.length, 0);
});

test('runReviews: garbage options never throw', async () => {
  const out = await R.runReviews(undefined);
  assert.deepEqual(out, { due: [], cards: [], notes: [], warnings: [], costUsd: null, durationMs: out.durationMs });
});
