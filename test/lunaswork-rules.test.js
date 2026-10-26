// ============================================================================
// Luna's Work (docs/LUNAS_WORK_PLAN.md, slice 1): the pure rules in
// lunasworkRules.js - models per role, phases, card order, milestone gate,
// plateau / red / rollback / stop verdicts and stored-run validation.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/lunasworkRules.js');

/** One finished iteration as the run history keeps it. */
const rec = (n, score, extra = {}) => ({
  n,
  score,
  cardsClosed: 0,
  selfCheck: 'green',
  coreJourneysOk: true,
  rolledBack: false,
  ...extra,
});

// ---- models per role ----------------------------------------------------------

test('normalizeModels keeps valid choices and fills the rest from the defaults', () => {
  assert.deepEqual(rules.normalizeModels(null), rules.DEFAULT_MODELS);
  assert.deepEqual(rules.normalizeModels({ builder: 'sonnet', playtester: 'gpt-9', critic: 'auto', extra: 'opus' }), {
    ...rules.DEFAULT_MODELS,
    builder: 'sonnet',
    critic: 'auto',
  });
});

test('the default models are Mati\'s standard: director + builders opus, playtester sonnet', () => {
  assert.equal(rules.DEFAULT_MODELS.director, 'opus');
  assert.equal(rules.DEFAULT_MODELS.builder, 'opus');
  assert.equal(rules.DEFAULT_MODELS.playtester, 'sonnet');
});

test('pickModel uses a fixed setting as is', () => {
  const models = rules.normalizeModels({ builder: 'haiku' });
  assert.deepEqual(rules.pickModel('builder', models, { size: 'L' }), { model: 'haiku', reason: 'setting' });
});

test('pickModel auto: builders get opus for large or risky cards, sonnet otherwise', () => {
  const models = rules.normalizeModels({ builder: 'auto' });
  assert.equal(rules.pickModel('builder', models, { size: 'L' }).model, 'opus');
  assert.equal(rules.pickModel('builder', models, { size: 'S', risky: true }).model, 'opus');
  assert.equal(rules.pickModel('builder', models, { size: 'M' }).model, 'sonnet');
  assert.equal(rules.pickModel('builder', models, {}).model, 'sonnet');
});

test('pickModel auto: the SHIP confirmation playtest always gets opus', () => {
  const models = rules.normalizeModels({ playtester: 'auto' });
  assert.equal(rules.pickModel('playtester', models, { shipConfirm: true }).model, 'opus');
  assert.equal(rules.pickModel('playtester', models, {}).model, 'sonnet');
});

test('pickModel auto: director and critic get opus at gates and step-backs', () => {
  const models = rules.normalizeModels({ director: 'auto', critic: 'auto' });
  assert.equal(rules.pickModel('director', models, { gate: true }).model, 'opus');
  assert.equal(rules.pickModel('critic', models, { stepBack: true }).model, 'opus');
  assert.equal(rules.pickModel('critic', models, {}).model, 'sonnet');
  assert.ok(rules.pickModel('critic', models, {}).reason.length > 0, 'auto choices carry a reason for the report');
});

test('pickModel returns null for an unknown role', () => {
  assert.equal(rules.pickModel('janitor', rules.DEFAULT_MODELS, {}), null);
});

// ---- phases ---------------------------------------------------------------------

test('nextPhase walks one iteration and wraps back to directing', () => {
  assert.equal(rules.nextPhase('directing'), 'building');
  assert.equal(rules.nextPhase('building'), 'launching');
  assert.equal(rules.nextPhase('launching'), 'playtesting');
  assert.equal(rules.nextPhase('playtesting'), 'critiquing');
  assert.equal(rules.nextPhase('critiquing'), 'directing');
  assert.equal(rules.nextPhase('nonsense'), null);
});

test('isStepBack is every 5th iteration, never the first', () => {
  assert.equal(rules.isStepBack(0), false);
  assert.equal(rules.isStepBack(4), false);
  assert.equal(rules.isStepBack(5), true);
  assert.equal(rules.isStepBack(10), true);
});

// ---- cards ------------------------------------------------------------------------

test('orderCards: steer first, then bugs by severity, ideas only after the gate', () => {
  const cards = [
    { id: 1, kind: 'idea', severity: 'high' },
    { id: 2, kind: 'feel', severity: 'low' },
    { id: 3, kind: 'bug', severity: 'medium' },
    { id: 4, kind: 'missing', severity: 'high' },
    { id: 5, kind: 'bug', severity: 'blocker' },
    { id: 6, kind: 'feel', severity: 'low', steer: true },
  ];
  assert.deepEqual(rules.orderCards(cards, { gatePassed: false }).map((c) => c.id), [6, 5, 3, 4, 2]);
  assert.deepEqual(rules.orderCards(cards, { gatePassed: true }).map((c) => c.id), [6, 5, 3, 4, 2, 1]);
});

test('orderCards keeps input order for equal cards, caps the count and does not mutate', () => {
  const cards = [
    { id: 'a', kind: 'bug', severity: 'high' },
    { id: 'b', kind: 'bug', severity: 'high' },
    { id: 'c', kind: 'bug', severity: 'high' },
  ];
  const copy = JSON.parse(JSON.stringify(cards));
  assert.deepEqual(rules.orderCards(cards, { limit: 2 }).map((c) => c.id), ['a', 'b']);
  assert.deepEqual(cards, copy);
});

test('orderCards treats unknown kinds and severities as the lowest rank', () => {
  const cards = [{ id: 'x', kind: '???' }, { id: 'y', kind: 'bug', severity: 'low' }];
  assert.deepEqual(rules.orderCards(cards).map((c) => c.id), ['y', 'x']);
});

test('orderCards never cuts a steer card, even past the limit', () => {
  const steer = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, kind: 'feel', steer: true }));
  const out = rules.orderCards([{ id: 'b', kind: 'bug', severity: 'blocker' }, ...steer]);
  assert.deepEqual(out.map((c) => c.id), steer.map((c) => c.id), 'all 8 steer cards, no room for the rest');
  const two = rules.orderCards([...steer.slice(0, 2), { id: 'b', kind: 'bug' }, { id: 'c', kind: 'bug' }], { limit: 3 });
  assert.deepEqual(two.map((c) => c.id), ['s0', 's1', 'b'], 'the rest fills the remaining room');
});

test('orderCards: a steered idea passes the gate, stuck cards are left out, case does not matter', () => {
  const cards = [
    { id: 'i', kind: 'idea', steer: true },
    { id: 's', kind: 'bug', severity: 'blocker', failCount: 2 },
    { id: 'B', kind: 'Bug', severity: 'HIGH' },
    { id: 'f', kind: 'feel', severity: 'low' },
  ];
  assert.deepEqual(rules.orderCards(cards, { gatePassed: false }).map((c) => c.id), ['i', 'B', 'f']);
});

test('pickModel auto: card size is not case-sensitive; the researcher role defaults to sonnet', () => {
  const models = rules.normalizeModels({ builder: 'auto' });
  assert.equal(rules.pickModel('builder', models, { size: 'l' }).model, 'opus');
  assert.equal(rules.DEFAULT_MODELS.researcher, 'sonnet');
});

test('isStuck after two failed iterations', () => {
  assert.equal(rules.isStuck({ failCount: 1 }), false);
  assert.equal(rules.isStuck({ failCount: 2 }), true);
  assert.equal(rules.isStuck({}), false);
});

test('gatePassed needs at least one criterion and every criterion passed', () => {
  assert.equal(rules.gatePassed(null), false);
  assert.equal(rules.gatePassed({ criteria: [] }), false);
  assert.equal(rules.gatePassed({ criteria: [{ id: 'a', passed: true }, { id: 'b', passed: false }] }), false);
  assert.equal(rules.gatePassed({ criteria: [{ id: 'a', passed: true }, { id: 'b', passed: true }] }), true);
});

// ---- plateau, red, rollback ----------------------------------------------------------

test('isPlateau: three iterations with no score gain and no card closed', () => {
  assert.equal(rules.isPlateau([rec(1, 40), rec(2, 40), rec(3, 40)]), false, 'needs an earlier best to compare with');
  assert.equal(rules.isPlateau([rec(1, 40), rec(2, 40), rec(3, 38), rec(4, 40)]), true);
  assert.equal(rules.isPlateau([rec(1, 40), rec(2, 41), rec(3, 40), rec(4, 40)]), false, 'a gain inside the window');
  assert.equal(
    rules.isPlateau([rec(1, 40), rec(2, 40), rec(3, 40, { cardsClosed: 1 }), rec(4, 40)]),
    false,
    'a closed card is progress',
  );
});

test('isRedStreak: self-check red two iterations in a row', () => {
  assert.equal(rules.isRedStreak([rec(1, 50, { selfCheck: 'red' })]), false);
  assert.equal(rules.isRedStreak([rec(1, 50, { selfCheck: 'red' }), rec(2, 50, { selfCheck: 'red' })]), true);
  assert.equal(
    rules.isRedStreak([rec(1, 50, { selfCheck: 'red' }), rec(2, 50), rec(3, 50, { selfCheck: 'red' })]),
    false,
  );
});

test('rollbackDecision: a broken core journey rolls back to the last good iteration', () => {
  const d = rules.rollbackDecision([rec(1, 50), rec(2, 60), rec(3, 62, { coreJourneysOk: false })]);
  assert.equal(d.rollback, true);
  assert.equal(d.toIteration, 2);
  assert.equal(d.reason, 'coreJourneyBroken');
});

test('rollbackDecision: a score drop beyond the margin rolls back, a small dip does not', () => {
  const big = rules.rollbackDecision([rec(1, 60), rec(2, 60 - rules.ROLLBACK_MARGIN - 1)]);
  assert.deepEqual(big, { rollback: true, toIteration: 1, reason: 'scoreDrop' });
  const small = rules.rollbackDecision([rec(1, 60), rec(2, 60 - rules.ROLLBACK_MARGIN)]);
  assert.equal(small.rollback, false);
});

test('rollbackDecision skips rolled-back and red iterations when finding the last good one', () => {
  const d = rules.rollbackDecision([
    rec(1, 50),
    rec(2, 70, { rolledBack: true }),
    rec(3, 70, { selfCheck: 'red' }),
    rec(4, 20),
  ]);
  assert.deepEqual(d, { rollback: true, toIteration: 1, reason: 'scoreDrop' });
});

test('rollbackDecision never rolls back an iteration that is already rolled back', () => {
  assert.equal(rules.rollbackDecision([rec(1, 80), rec(2, 40, { rolledBack: true })]).rollback, false);
});

test('a new, harder milestone starting lower is not a score drop or a plateau', () => {
  const advance = [rec(4, 90, { milestone: 'skeleton' }), rec(5, 60, { milestone: 'core flows' })];
  assert.equal(rules.rollbackDecision(advance).rollback, false);
  const drop = [...advance, rec(6, 45, { milestone: 'core flows' })];
  assert.deepEqual(rules.rollbackDecision(drop), { rollback: true, toIteration: 5, reason: 'scoreDrop' });
  const crossing = [
    rec(1, 90, { milestone: 'skeleton' }),
    rec(2, 50, { milestone: 'core flows' }),
    rec(3, 50, { milestone: 'core flows' }),
    rec(4, 50, { milestone: 'core flows' }),
  ];
  assert.equal(rules.isPlateau(crossing), false, 'the earlier milestone is not the baseline');
});

test('history rules skip malformed entries instead of throwing', () => {
  const bad = [null, 7, { score: 'x' }, rec(1, 50, { selfCheck: 'red' }), undefined, rec(2, 50, { selfCheck: 'red' })];
  assert.equal(rules.isRedStreak(bad), true);
  assert.doesNotThrow(() => rules.isPlateau(bad));
  assert.doesNotThrow(() => rules.rollbackDecision([null]));
  assert.equal(rules.rollbackDecision([null]).rollback, false);
  assert.equal(rules.isPlateau([rec(1, 40), { n: 2, score: undefined }, rec(3, 40), rec(4, 40), rec(5, 40)]), true);
});

test('isPlateau needs exactly one record before the window; a closed card or rollback inside does not hide it', () => {
  assert.equal(rules.isPlateau([rec(1, 40), rec(2, 40), rec(3, 40), rec(4, 40)]), true);
  assert.equal(rules.isPlateau([rec(1, 40), rec(2, 40, { rolledBack: true }), rec(3, 40), rec(4, 40)]), true);
});

test('rollbackDecision: nothing to do for a red latest iteration or with no good one', () => {
  assert.equal(rules.rollbackDecision([rec(1, 60), rec(2, 10, { selfCheck: 'red' })]).rollback, false, 'red never reached main');
  assert.equal(rules.rollbackDecision([rec(1, 10, { coreJourneysOk: false })]).rollback, false);
  assert.equal(rules.rollbackDecision([]).rollback, false);
});

// ---- stop verdict ------------------------------------------------------------------------

test('stopVerdict: SHIP needs the critic AND the second playtester', () => {
  const history = [rec(1, 90)];
  assert.equal(rules.stopVerdict({ history, critic: { verdict: 'ship' }, shipConfirmed: false }).type, 'continue');
  assert.equal(rules.stopVerdict({ history, critic: { verdict: 'ship' }, shipConfirmed: true }).type, 'ship');
});

test('stopVerdict precedence: stop, then ship, then red, then plateau', () => {
  const plateau = [rec(1, 40), rec(2, 40), rec(3, 40), rec(4, 40)];
  const red = [rec(1, 40, { selfCheck: 'red' }), rec(2, 40, { selfCheck: 'red' })];
  assert.equal(rules.stopVerdict({ history: red, stopRequested: true }).type, 'stop');
  assert.equal(rules.stopVerdict({ history: red, critic: { verdict: 'ship' }, shipConfirmed: true }).type, 'ship');
  assert.equal(rules.stopVerdict({ history: [...plateau, ...red] }).type, 'red');
  assert.equal(rules.stopVerdict({ history: plateau }).type, 'plateau');
  assert.equal(rules.stopVerdict({ history: [] }).type, 'continue');
});

// ---- stored run ----------------------------------------------------------------------------

test('normalizeStoredRun rejects garbage and relative repo paths', () => {
  assert.equal(rules.normalizeStoredRun(null), null);
  assert.equal(rules.normalizeStoredRun({ id: 'r1', repoPath: 'relative/path' }), null);
  assert.equal(rules.normalizeStoredRun({ repoPath: process.cwd() }), null);
});

test('normalizeStoredRun keeps a valid run and cleans its fields', () => {
  const run = rules.normalizeStoredRun({
    id: 'r1',
    repoPath: process.cwd(),
    phase: 'playtesting',
    iteration: 3,
    milestone: 'core flows',
    models: { builder: 'sonnet', playtester: 'nope' },
    history: [rec(1, 150), { n: 'x' }, rec(2, -5, { selfCheck: 'red' })],
    startedAt: 1792666734152,
    handover: true,
  });
  assert.equal(run.id, 'r1');
  assert.equal(run.phase, 'playtesting');
  assert.equal(run.iteration, 3);
  assert.equal(run.models.builder, 'sonnet');
  assert.equal(run.models.playtester, rules.DEFAULT_MODELS.playtester);
  assert.equal(run.history.length, 2, 'records without a number are dropped');
  assert.equal(run.history[0].score, 100, 'scores are clamped to 0-100');
  assert.equal(run.history[1].score, 0);
  assert.equal(run.handover, true);
});

test('normalizeStoredRun drops corrupt records instead of inventing a red streak', () => {
  const run = rules.normalizeStoredRun({
    id: 'r1',
    repoPath: process.cwd(),
    history: [{ n: 1 }, { n: 2 }, rec(3, 50, { selfCheck: 'purple' }), rec(4, '80'), null, 7],
  });
  assert.deepEqual(run.history, []);
  assert.equal(rules.stopVerdict({ history: run.history }).type, 'continue');
});

test('normalizeStoredRun sorts history, keeps the last duplicate, and never lets iteration lag', () => {
  const run = rules.normalizeStoredRun({
    id: 'r1',
    repoPath: process.cwd(),
    iteration: 1,
    history: [rec(3, 30), rec(1, 10), rec(3, 33)],
  });
  assert.deepEqual(run.history.map((r) => [r.n, r.score]), [[1, 10], [3, 33]]);
  assert.equal(run.iteration, 3, 'iteration tags must not collide with history');
});

test('normalizeStoredRun rejects ids that are unsafe in git tag names', () => {
  for (const id of ['a b', '../x', 'a..b', 'x:y', 'x^1', '~x', '.x','x'.repeat(65), '']) {
    assert.equal(rules.normalizeStoredRun({ id, repoPath: process.cwd() }), null, id);
  }
  assert.ok(rules.normalizeStoredRun({ id: 'amsteel-2026.10_22', repoPath: process.cwd() }));
});

test('normalizeStoredRun: an unknown phase restarts the iteration at directing', () => {
  const run = rules.normalizeStoredRun({ id: 'r1', repoPath: process.cwd(), phase: 'dancing' });
  assert.equal(run.phase, 'directing');
  assert.equal(run.iteration, 0);
  assert.deepEqual(run.history, []);
});

// ---- card rules (LW 1.8: B1, #3, B4, B5, B9) --------------------------------------

test('appChecks keeps the checks the app can show, not the code-only ones', () => {
  const card = { acceptance: ['The quote shows the total', 'A test reproduces the bug', '', 'A regression test covers it', 'Saving keeps the date'] };
  assert.deepEqual(rules.appChecks(card), ['The quote shows the total', 'Saving keeps the date']);
  assert.deepEqual(rules.appChecks(null), []);
});

test('builtVerdict: every app check confirmed closes a built card (B1)', () => {
  const card = { acceptance: ['Total shows', 'Date saves'] };
  const v = rules.builtVerdict(card, [{ check: 0, passed: true }, { check: 1, passed: true }]);
  assert.equal(v.outcome, 'done');
  assert.deepEqual(v.missing, []);
});

test('builtVerdict: a failed check reopens the card with its text (B1)', () => {
  const card = { acceptance: ['Total shows', 'Date saves'] };
  const v = rules.builtVerdict(card, [{ check: 0, passed: true }, { check: 1, passed: false, evidence: { shot: 'a.png' } }]);
  assert.equal(v.outcome, 'reopen');
  assert.equal(v.failed.length, 1);
  assert.equal(v.failed[0].text, 'Date saves');
  assert.deepEqual(v.failed[0].evidence, { shot: 'a.png' });
});

test('builtVerdict: an unchecked check leaves the card built; bad results are ignored', () => {
  const card = { acceptance: ['Total shows', 'Date saves'] };
  const v = rules.builtVerdict(card, [{ check: 0, passed: true }, { check: 7, passed: false }, null, { check: 'x' }]);
  assert.equal(v.outcome, 'built');
  assert.deepEqual(v.missing, [1]);
  assert.equal(rules.builtVerdict({ acceptance: ['A test reproduces the bug'] }, []).outcome, 'done');
});

test('isTestFile recognises the common test paths', () => {
  for (const f of ['test/a.test.js', 'src/__tests__/x.js', 'app/foo.spec.ts', 'tests/test_api.py', 'pkg/x_test.go', 'e2e\\checkout.js']) {
    assert.equal(rules.isTestFile(f), true, f);
  }
  for (const f of ['src/main.js', 'docs/testing.md', 'src/contest.js', null]) {
    assert.equal(rules.isTestFile(f), false, String(f));
  }
});

test('bugTestVerdict: a bug card needs a changed test file (#3)', () => {
  const bug = { tags: ['kind:bug'] };
  assert.deepEqual(rules.bugTestVerdict(bug, ['src/a.js', 'test/a.test.js']), { ok: true });
  const missing = rules.bugTestVerdict(bug, ['src/a.js']);
  assert.equal(missing.ok, false);
  assert.match(missing.note, /test file/);
  const unknown = rules.bugTestVerdict({ kind: 'bug' }, null);
  assert.equal(unknown.ok, false);
  assert.match(unknown.note, /not known/);
});

test('bugTestVerdict: other kinds never need a test', () => {
  assert.deepEqual(rules.bugTestVerdict({ kind: 'missing' }, []), { ok: true });
  assert.deepEqual(rules.bugTestVerdict({ tags: ['kind:feel'] }, null), { ok: true });
  assert.deepEqual(rules.bugTestVerdict(null, null), { ok: true });
});

test('nextFailCounts counts failures and forgets closed cards, without mutating (B4)', () => {
  const counts = Object.freeze({ 1: 1, 2: 1, 3: 0, 4: 'x' });
  const next = rules.nextFailCounts(counts, { failed: [1, 1, 5], closed: [2] });
  assert.deepEqual(next, { 1: 2, 5: 1 });
  assert.deepEqual(rules.nextFailCounts(null), {});
});

test('stuckOf and stuckOutcome: two failures make a card stuck; split or ask (B4)', () => {
  const counts = rules.nextFailCounts(rules.nextFailCounts({}, { failed: [10, 20] }), { failed: [10] });
  assert.equal(rules.STUCK_AFTER, 2);
  assert.deepEqual(rules.stuckOf([10, 20, 30], counts), [10]);
  assert.deepEqual(rules.stuckOutcome([10, 11], [11, 99]), { split: [11], ask: [10] });
  assert.deepEqual(rules.stuckOutcome([10], null), { split: [], ask: [10] });
});

test('scopeCheck: a card inside DESIGN.md / ROADMAP.md is in scope (B5)', () => {
  const pack = '# Design\nA quote calculator: the user enters materials and labour, the quote shows a total and a PDF export.';
  assert.equal(rules.scopeCheck({ text: 'Quote total rounds labour', kind: 'missing' }, pack).inScope, true);
  const out = rules.scopeCheck({ text: 'Multiplayer leaderboard with chat', kind: 'idea' }, pack);
  assert.equal(out.inScope, false);
  assert.equal(out.reason, 'outsidePack');
  assert.ok(out.missing.includes('leaderboard'));
});

test('scopeCheck: steer and bug cards, an empty pack and a term-less title are never out of scope', () => {
  const pack = 'A quote calculator.';
  assert.equal(rules.scopeCheck({ text: 'Multiplayer leaderboard', steer: true }, pack).reason, 'steer');
  assert.equal(rules.scopeCheck({ text: 'Multiplayer leaderboard', tags: ['steer'] }, pack).reason, 'steer');
  assert.equal(rules.scopeCheck({ text: 'Multiplayer leaderboard', tags: ['kind:bug'] }, pack).reason, 'bug');
  assert.equal(rules.scopeCheck({ text: 'Multiplayer leaderboard' }, '').reason, 'noPack');
  assert.equal(rules.scopeCheck({ text: 'Fix the page' }, pack).reason, 'noTerms');
  assert.equal(rules.scopeCheck(null, pack).inScope, false);
});

test('flakyTests: failed then passed on the same rev is flaky; across revs it is not (B9)', () => {
  const obs = [
    { name: 'checkout', passed: false, rev: 'iter-3' },
    { name: 'checkout', passed: true, rev: 'iter-3' },
    { name: 'login', passed: false, rev: 'iter-2' },
    { name: 'login', passed: true, rev: 'iter-3' },
    { name: 'search', passed: false, rev: 'iter-3' },
    { name: 'search', passed: false, rev: 'iter-3' },
    { name: '', passed: true, rev: 'iter-3' },
    null,
  ];
  assert.deepEqual(rules.flakyTests(obs), ['checkout']);
  assert.deepEqual(rules.flakyTests(null), []);
});

test('withoutQuarantined drops quarantined journeys, so they cannot trigger a rollback (B9)', () => {
  const journeys = [{ name: 'checkout', passed: false }, { name: 'login', passed: true }];
  const kept = rules.withoutQuarantined(journeys, [{ name: 'checkout', n: 3 }]);
  assert.deepEqual(kept, [{ name: 'login', passed: true }]);
  assert.deepEqual(rules.withoutQuarantined(journeys, ['login']).map((j) => j.name), ['checkout']);
  // With the flaky journey left out the record is good again: no rollback.
  const history = [rec(1, 70), rec(2, 72, { coreJourneysOk: kept.every((j) => j.passed) })];
  assert.equal(rules.rollbackDecision(history).rollback, false);
});

// ---- playtest personas (LW 2.14) and browser/device matrix (LW 2.24) -----------------

test('personasFor: core journeys every iteration plus one persona, round-robin', () => {
  const ids = (n) => rules.personasFor(n, false).map((p) => p.id);
  const count = rules.PERSONAS.length;
  assert.equal(count, 5);
  for (let n = 0; n < count * 2; n += 1) {
    const list = ids(n);
    assert.equal(list.length, 2);
    assert.equal(list[0], 'core');
    assert.equal(list[1], rules.PERSONAS[n % count].id);
  }
  // One full lap visits every persona exactly once.
  const lap = new Set(Array.from({ length: count }, (_, n) => ids(n)[1]));
  assert.equal(lap.size, count);
  for (const p of rules.PERSONAS) assert.ok(p.prompt.length > 20, p.id);
});

test('personasFor: a milestone gate runs every persona; bad iterations count as 0', () => {
  assert.deepEqual(
    rules.personasFor(7, true).map((p) => p.id),
    ['core', 'firstTime', 'power', 'phone', 'a11y', 'breakIt'],
  );
  assert.deepEqual(rules.personasFor(-3, false), rules.personasFor(0, false));
  assert.deepEqual(rules.personasFor('x', 'yes'), rules.personasFor(0, false));
});

test('matrixFor: chromium desktop baseline always, plus one rotated combo', () => {
  const key = (c) => `${c.engine}@${c.width}`;
  const seen = new Set();
  for (let n = 0; n < 16; n += 1) {
    const list = rules.matrixFor(n, false);
    assert.equal(list.length, 2);
    assert.deepEqual(list[0], rules.BASELINE_COMBO);
    assert.equal(key(list[0]), 'chromium@1440');
    assert.notEqual(key(list[1]), 'chromium@1440');
    seen.add(key(list[1]));
  }
  // Eight laps cover every non-baseline combo.
  assert.equal(seen.size, 8);
  assert.notDeepEqual(rules.matrixFor(1, false)[1], rules.matrixFor(2, false)[1]);
});

test('matrixFor: a milestone gate runs every engine x width, baseline first', () => {
  const list = rules.matrixFor(3, true);
  assert.equal(list.length, 9);
  assert.deepEqual(list[0], rules.BASELINE_COMBO);
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    for (const width of [390, 820, 1440]) {
      assert.ok(list.some((c) => c.engine === engine && c.width === width), `${engine} ${width}`);
    }
  }
  assert.ok(list.every((c) => Number.isInteger(c.height) && c.height > 0));
});
