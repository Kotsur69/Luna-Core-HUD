// ============================================================================
// God Mode A/B parallel builds, pure part (src/orchestraVariants.js): the
// planner's variants at the boundary, the plan schema and prompt, expanding a
// package into its group and variants, stored shapes, the group decision,
// the critic's answer and prompt - plus the supervisor rules that know A/B.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ab = require('../src/orchestraVariants.js');
const plan = require('../src/orchestraPlan.js');
const sup = require('../src/orchestraSupervisor.js');

const TWO = [
  { label: ' use  library X ', prompt: ' Parse with X. ' },
  { label: 'use library Y', prompt: 'Parse with Y.' },
];

// ---- validateVariants ---------------------------------------------------------

test('validateVariants: none is fine, exactly two usable ones are kept, anything else is dropped', () => {
  for (const none of [undefined, null, []]) assert.deepEqual(ab.validateVariants(none), { variants: null, dropped: false });
  assert.deepEqual(ab.validateVariants(TWO), {
    variants: [
      { key: 'a', label: 'use library X', prompt: 'Parse with X.' },
      { key: 'b', label: 'use library Y', prompt: 'Parse with Y.' },
    ],
    dropped: false,
  });
  const bad = [
    'two',
    [TWO[0]],
    [...TWO, { label: 'Z', prompt: 'z' }],
    [TWO[0], { label: 'USE LIBRARY X', prompt: 'other' }],
    [TWO[0], { label: 'other', prompt: ' Parse with X.' }],
    [TWO[0], { label: '', prompt: 'p' }],
    [TWO[0], { label: 'l', prompt: 42 }],
    [TWO[0], null],
  ];
  for (const raw of bad) assert.deepEqual(ab.validateVariants(raw), { variants: null, dropped: true }, JSON.stringify(raw));
});

test('validateVariants caps the label and the prompt', () => {
  const out = ab.validateVariants([
    { label: 'x'.repeat(100), prompt: 'p'.repeat(5000) },
    { label: 'y', prompt: 'q' },
  ]);
  assert.equal(out.variants[0].label.length, 60);
  assert.equal(out.variants[0].prompt.length, ab.MAX_VARIANT_PROMPT_CHARS);
});

// ---- schema, prompt, validatePlan -------------------------------------------------

test('planSchemaFor adds a required `variants` only for an A/B plan; the base schema is untouched', () => {
  assert.equal(plan.planSchemaFor(false), plan.PLAN_SCHEMA);
  const withAb = plan.planSchemaFor(false, true);
  const items = withAb.properties.packages.items;
  assert.ok(items.required.includes('variants'));
  assert.equal(items.properties.variants, ab.VARIANTS_SCHEMA);
  assert.equal(plan.PLAN_SCHEMA.properties.packages.items.required.includes('variants'), false);
  assert.equal('variants' in plan.PLAN_SCHEMA.properties.packages.items.properties, false);
  const hybridAb = plan.planSchemaFor(true, true).properties.packages.items;
  assert.ok(hybridAb.required.includes('variants'));
  assert.deepEqual(hybridAb.properties.model, plan.HYBRID_PLAN_SCHEMA.properties.packages.items.properties.model);
});

test('buildPlannerArgs / buildPlannerPrompt ask for variants only when A/B is on, never on the free planner', () => {
  const schemaOf = (args) => args[args.indexOf('--json-schema') + 1];
  assert.match(schemaOf(plan.buildPlannerArgs({ abBuild: true })), /"variants"/);
  assert.doesNotMatch(schemaOf(plan.buildPlannerArgs({})), /"variants"/);
  assert.doesNotMatch(schemaOf(plan.buildPlannerArgs({ planner: 'free', abBuild: true })), /"variants"/);
  const todos = [{ at: 1, text: 'parse the feed' }];
  assert.ok(plan.buildPlannerPrompt(todos, { abBuild: true }).includes(ab.AB_PLANNER_RULES[0]));
  assert.equal(plan.buildPlannerPrompt(todos, {}).includes(ab.AB_PLANNER_RULES[0]), false);
});

test('validatePlan keeps usable variants of an A/B plan, warns about dropped ones, and ignores them otherwise', () => {
  const todos = [{ at: 1, text: 'one' }, { at: 2, text: 'two' }];
  const raw = {
    notes: '',
    packages: [
      { id: 'a', title: 'A', todoAts: [1], prompt: 'do a', variants: TWO },
      { id: 'b', title: 'B', todoAts: [2], prompt: 'do b', variants: [TWO[0]] },
    ],
  };
  const checked = plan.validatePlan(raw, todos, { abBuild: true });
  assert.equal(checked.packages[0].variants.length, 2);
  assert.equal('variants' in checked.packages[1], false);
  assert.deepEqual(checked.warnings.filter((w) => w.code === 'abDropped'), [{ code: 'abDropped', id: 'b' }]);
  const plain = plan.validatePlan(raw, todos);
  assert.equal(plain.packages.some((p) => 'variants' in p), false, 'a plan made without the option never has them');
  assert.equal(plain.warnings.some((w) => w.code === 'abDropped'), false);
});

// ---- expandVariants -----------------------------------------------------------------

const planned = (id, extra = {}) => ({ id, title: id.toUpperCase(), todoAts: [1], prompt: `do ${id}`, files: [], dependsOn: [], verify: 'npm test', model: null, ...extra });

test('expandVariants: a package with variants becomes its group plus one package per variant', () => {
  const variants = ab.validateVariants(TWO).variants;
  const input = [planned('a', { variants, dependsOn: ['z'] }), planned('b')];
  const before = JSON.stringify(input);
  const { packages, warnings } = ab.expandVariants(input);
  assert.equal(JSON.stringify(input), before, 'the input is not changed');
  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.id), ['a', 'a-a', 'a-b', 'b']);
  const [group, va, vb, b] = packages;
  assert.deepEqual(group.ab, { variants: [{ key: 'a', label: 'use library X' }, { key: 'b', label: 'use library Y' }], winner: null });
  assert.equal('variants' in group, false);
  assert.deepEqual(group.todoAts, [1], 'the group ticks the to-dos');
  assert.equal(va.title, 'A [A: use library X]');
  assert.deepEqual([va.abOf, va.abKey, va.abLabel, va.todoAts, va.dependsOn], ['a', 'a', 'use library X', [], ['z']]);
  assert.ok(va.prompt.startsWith('do a\n'));
  assert.match(va.prompt, /## Variant A: use library X\n/);
  assert.match(va.prompt, /Parse with X\.$/);
  assert.match(vb.prompt, /## Variant B: use library Y\n[\s\S]*Parse with Y\.$/);
  assert.deepEqual(b, input[1], 'a package without variants passes through');
  assert.equal(ab.hasGroups(packages), true);
  assert.equal(ab.hasGroups([planned('x')]), false);
});

test('expandVariants keeps a package whole when a variant id is already taken', () => {
  const variants = ab.validateVariants(TWO).variants;
  const { packages, warnings } = ab.expandVariants([planned('a', { variants }), planned('a-b')]);
  assert.deepEqual(packages.map((p) => p.id), ['a', 'a-b']);
  assert.equal('ab' in packages[0], false);
  assert.deepEqual(warnings, [{ code: 'abDropped', id: 'a' }]);
});

// ---- stored shapes ----------------------------------------------------------------------

test('normalizeStoredAb: a variant role, its parked build and a group record, shape-checked', () => {
  assert.deepEqual(ab.normalizeStoredAb({}), {});
  assert.deepEqual(ab.normalizeStoredAb({ abOf: 'a', abKey: 'b', abLabel: '  lib   Y ', abBuilt: { headSha: 'abc1234', at: 5 } }), {
    abOf: 'a',
    abKey: 'b',
    abLabel: 'lib Y',
    abBuilt: { headSha: 'abc1234', at: 5 },
  });
  assert.deepEqual(ab.normalizeStoredAb({ abOf: 'a', abKey: 'a', abBuilt: { headSha: 'not a sha', at: 'x' } }).abBuilt, { headSha: null, at: null });
  assert.deepEqual(ab.normalizeStoredAb({ abOf: 'a', abKey: 'a', abBuilt: null }), { abOf: 'a', abKey: 'a', abLabel: '' });
  assert.deepEqual(ab.normalizeStoredAb({ abOf: '../x', abKey: 'a' }), {});
  assert.deepEqual(ab.normalizeStoredAb({ abOf: 'a', abKey: 'c' }), {});

  assert.deepEqual(ab.normalizeStoredAb({ ab: { variants: [{ label: 'X' }, { label: 'Y' }], winner: 'z' } }), {
    ab: { variants: [{ key: 'a', label: 'X' }, { key: 'b', label: 'Y' }], winner: null },
  });
  assert.deepEqual(ab.normalizeStoredAb({ ab: { variants: [{ label: 'X' }], winner: null } }), {});
  const decided = ab.normalizeStoredAb({
    ab: {
      variants: [{ label: 'X' }, { label: 'Y' }],
      winner: 'b',
      by: 'magic',
      decidedAt: 7,
      reasons: ['  smaller  ', '', 'tests kept'],
      losers: [
        { key: 'a', label: 'X', branch: 'luna/a-a-1', headSha: 'abc1234', outcome: 'lost', removed: true },
        { key: 'b', label: 'Y' },
      ],
    },
  }).ab;
  assert.deepEqual(decided, {
    variants: [{ key: 'a', label: 'X' }, { key: 'b', label: 'Y' }],
    winner: 'b',
    by: 'critic',
    decidedAt: 7,
    reasons: ['smaller', 'tests kept'],
    losers: [{ key: 'a', label: 'X', branch: 'luna/a-a-1', headSha: 'abc1234', outcome: 'lost', removed: true }],
  });
  const odd = ab.normalizeStoredAb({ ab: { variants: [{}, {}], winner: 'a', losers: [{ key: 'b', branch: 'main', outcome: '' }] } }).ab;
  assert.deepEqual(odd.losers, [{ key: 'b', label: '', branch: null, headSha: null, outcome: 'lost', removed: false }]);
});

// ---- decisions ---------------------------------------------------------------------------

const group = (extra = {}) => ({ id: 'a', state: 'pending', ab: { variants: [{ key: 'a', label: 'X' }, { key: 'b', label: 'Y' }], winner: null }, ...extra });
const variant = (key, extra = {}) => ({ id: `a-${key}`, abOf: 'a', abKey: key, abLabel: key.toUpperCase(), state: 'launched', terminal: false, ...extra });
const built = (key, extra = {}) => variant(key, { state: 'finishing', abBuilt: { headSha: `${key}${key}${key}1111`, at: 1 }, ...extra });

test('isParked / isUndecidedGroup / variantDone', () => {
  assert.equal(ab.isParked(built('a')), true);
  assert.equal(ab.isParked(built('a', { state: 'killed' })), false);
  assert.equal(ab.isParked(variant('a', { state: 'finishing' })), false, 'verifying, not parked');
  assert.equal(ab.isUndecidedGroup(group()), true);
  assert.equal(ab.isUndecidedGroup(group({ ab: { variants: [], winner: 'a' } })), false);
  assert.equal(ab.isUndecidedGroup({ id: 'x' }), false);
  const done = (extra) => ab.variantDone(variant('a', extra));
  assert.equal(ab.variantDone(built('a')), true);
  assert.equal(ab.variantDone(built('a', { state: 'killed' })), true, 'a kill keeps the verified build');
  assert.equal(done({ state: 'killed' }), false, 'a kill is a pause, not a verdict');
  assert.equal(done({ state: 'closed' }), true);
  assert.equal(done({ state: 'stalled', terminal: true }), true);
  assert.equal(done({ state: 'failed', terminal: true }), true);
  assert.equal(done({ state: 'stalled', terminal: false }), false, 'its automatic resume may still come');
  assert.equal(done({ state: 'launched' }), false);
  assert.equal(done({ state: 'pending' }), false);
});

test('groupDecision: wait, critic, the only built one, or neither', () => {
  assert.deepEqual(ab.groupDecision(group(), [group(), variant('a'), built('b')]), { kind: 'wait' });
  const both = [group(), built('a'), built('b')];
  assert.deepEqual(ab.groupDecision(group(), both), { kind: 'critic', built: [both[1], both[2]] });
  const one = [group(), variant('a', { state: 'stalled', terminal: true, error: 'blocked' }), built('b')];
  assert.deepEqual(ab.groupDecision(group(), one), { kind: 'only', winner: one[2], loser: one[1] });
  const none = [group(), variant('a', { state: 'closed' }), variant('b', { state: 'failed', terminal: true })];
  assert.deepEqual(ab.groupDecision(group(), none), { kind: 'none', variants: [none[1], none[2]] });
  const paused = [group(), variant('a', { state: 'killed' }), variant('b', { state: 'failed', terminal: true })];
  assert.deepEqual(ab.groupDecision(group(), paused), { kind: 'wait' }, 'a killed variant is waited for: its Retry may still build it');
  const kept = [group(), built('a', { state: 'killed' }), built('b')];
  assert.deepEqual(ab.groupDecision(group(), kept), { kind: 'critic', built: [kept[1], kept[2]] }, 'a build kept through a kill counts');
  assert.equal(ab.groupDecision(group({ state: 'stalled' }), none), null, 'already stalled for it');
  assert.deepEqual(ab.groupDecision(group({ state: 'stalled' }), both).kind, 'critic', 'a retried variant decides a stalled group again');
  assert.equal(ab.groupDecision(group({ state: 'launched' }), both), null);
  assert.equal(ab.groupDecision(group({ ab: { variants: [], winner: 'a' } }), both), null);
  assert.equal(ab.groupDecision(group(), [group(), built('a')]), null, 'a variant missing');
  assert.equal(ab.groupDecision({ id: 'x', state: 'pending' }, both), null);
});

test('retryAction: a group is refused; a built variant parks again, or waits for its stopped twin', () => {
  assert.deepEqual(ab.retryAction(group(), []), { refuse: 'abGroup' });
  assert.equal(ab.retryAction(group({ ab: { variants: [], winner: 'a' } }), []), null, 'a decided group retries like any package');
  assert.equal(ab.retryAction({ id: 'x', state: 'stalled' }, []), null);
  assert.equal(ab.retryAction(null, []), null);
  const unbuilt = variant('a', { state: 'killed' });
  assert.equal(ab.retryAction(unbuilt, [group(), unbuilt, variant('b')]), null, 'an unbuilt variant gets the ordinary Retry');
  const kept = built('a', { state: 'killed' });
  for (const state of ['stalled', 'killed', 'failed']) {
    assert.deepEqual(ab.retryAction(kept, [group(), kept, variant('b', { state })]), { refuse: 'abBuilt' }, `twin ${state}: its own Retry first`);
  }
  const moving = [variant('b'), variant('b', { state: 'pending' }), built('b'), variant('b', { state: 'stalled', terminal: true }), variant('b', { state: 'closed' })];
  for (const twin of moving) {
    assert.deepEqual(ab.retryAction(kept, [group(), kept, twin]), { keep: true }, `twin ${twin.state}`);
  }
  assert.deepEqual(ab.retryAction(kept, [kept]), { keep: true }, 'no twin to wait for');
});

test('adoptedFields: the group takes the winner worktree, branch, tab and verified head', () => {
  const winner = built('b', {
    prompt: 'do a, B',
    branch: 'luna/a-b-1',
    root: '/wt/a-b-1',
    cwd: '/wt/a-b-1',
    baseSha: 'base111',
    sessionId: 's2',
    headSha: 'old0000',
    touched: ['src/x.js'],
    startedAt: 10,
    escalated: true,
  });
  const fields = ab.adoptedFields(winner);
  assert.deepEqual(
    [fields.branch, fields.root, fields.cwd, fields.baseSha, fields.sessionId, fields.headSha, fields.verifiedSha, fields.touched, fields.escalated],
    ['luna/a-b-1', '/wt/a-b-1', '/wt/a-b-1', 'base111', 's2', 'bbb1111', 'bbb1111', ['src/x.js'], true],
  );
  assert.deepEqual([fields.pausedMs, fields.nudges, fields.modelOverride, fields.lastWords], [0, 0, null, null]);
});

// ---- the critic ------------------------------------------------------------------------

test('validateChoice: a or b with short reasons, or null', () => {
  for (const bad of [null, 'a', {}, { choice: 'c' }, { choice: 'A' }]) assert.equal(ab.validateChoice(bad), null, JSON.stringify(bad));
  assert.deepEqual(ab.validateChoice({ choice: 'b', reasons: ['  smaller\n diff ', '', 'keeps tests'] }), { choice: 'b', reasons: ['smaller diff', 'keeps tests'] });
  assert.deepEqual(ab.validateChoice({ choice: 'a', reasons: 'x' }), { choice: 'a', reasons: [] });
  assert.deepEqual(ab.CRITIC_SCHEMA.properties.choice.enum, ['a', 'b']);
});

test('buildCriticPrompt: the task and both variants as fenced data; a fence inside cannot close its block', () => {
  const prompt = ab.buildCriticPrompt({
    id: 'a',
    title: 'Parse the feed',
    prompt: 'do a',
    verify: 'npm test',
    variants: [
      { key: 'a', label: 'X', approach: 'Parse with X.', verify: 'passed', stat: ' 1 file changed', diff: '+const x = """;\n' },
      { key: 'b', label: 'Y', approach: 'Parse with Y.', verify: 'passed', stat: '', diff: '' },
    ],
  });
  assert.match(prompt, /Package `a`: Parse the feed/);
  assert.match(prompt, /Verify command: `npm test`/);
  assert.match(prompt, /### Variant A - X \(verify: passed\)/);
  assert.match(prompt, /### Variant B - Y \(verify: passed\)/);
  assert.match(prompt, /\(no diff available\)/);
  assert.match(prompt, /"choice" \("a" or "b"\)/);
  const fences = prompt.split('\n').filter((l) => l === '"""').length;
  assert.equal(fences, 2 * (1 + 3 * 2), 'task + approach/stat/diff per variant, each opened and closed once');
  assert.equal(prompt.includes('= """;'), false, 'the fence inside the diff is defused');
});

test('buildCriticPrompt says when a long diff was cut', () => {
  const diff = 'x'.repeat(50_000);
  const prompt = ab.buildCriticPrompt({
    id: 'a',
    title: 'T',
    prompt: 'p',
    variants: [
      { key: 'a', label: 'X', approach: '', verify: 'passed', stat: '', diff },
      { key: 'b', label: 'Y', approach: '', verify: 'passed', stat: '', diff: 'small' },
    ],
  });
  assert.match(prompt, /\(The diff is 50000 characters; only the first 40000 are shown\.\)/);
  assert.equal(prompt.includes('x'.repeat(40_001)), false);
});

// ---- supervisor rules ------------------------------------------------------------------

test('normalizeOptions keeps the three opt-in switches only when they are exactly true', () => {
  assert.deepEqual(sup.normalizeOptions({ abBuild: true, selfHeal: 'yes', contextGuard: true }), {
    unattendedApprovalMin: 30,
    sleepOnLimit: false,
    shutdownWhenDone: false,
    abBuild: true,
    contextGuard: true,
  });
  assert.equal('selfHeal' in sup.normalizeOptions({ selfHeal: 1 }), false);
});

test('readyToLaunch: an undecided group never launches; a parked variant holds no slot', () => {
  const pending = (id, extra = {}) => ({ id, state: 'pending', dependsOn: [], ...extra });
  const ready = sup.readyToLaunch([group(), variant('a', { state: 'pending', dependsOn: [] }), variant('b', { state: 'pending', dependsOn: [] }), pending('c')], 3);
  assert.deepEqual(ready.map((p) => p.id), ['a-a', 'a-b', 'c']);
  const parked = [group(), built('a', { dependsOn: [] }), variant('b', { dependsOn: [] }), pending('c'), pending('d')];
  assert.deepEqual(sup.readyToLaunch(parked, 2).map((p) => p.id), ['c'], 'only the running twin counts');
  const decided = group({ ab: { variants: [], winner: 'a' }, dependsOn: [] });
  assert.deepEqual(sup.readyToLaunch([decided], 1).map((p) => p.id), ['a']);
});

test('liveOverlaps: A/B twins touching the same files are no clash', () => {
  const twins = [variant('a', { dependsOn: [], touched: ['src/x.js'] }), variant('b', { dependsOn: [], touched: ['src/x.js'] })];
  assert.deepEqual(sup.liveOverlaps(twins), []);
  const other = { id: 'c', state: 'launched', dependsOn: [], touched: ['src/x.js'] };
  assert.deepEqual(sup.liveOverlaps([twins[0], other]), [{ a: 'a-a', b: 'c', files: ['src/x.js'] }]);
});

test('stored A/B, heal and context fields survive a restart shape-checked; a legacy package gets none', () => {
  const stored = sup.normalizeStoredPlan({
    id: 'p',
    repoPath: path.resolve('/r'),
    options: { abBuild: true, selfHeal: true },
    packages: [
      { id: 'a', state: 'pending', ab: { variants: [{ label: 'X' }, { label: 'Y' }], winner: null } },
      { id: 'a-a', state: 'stalled', abOf: 'a', abKey: 'a', abLabel: 'X', abBuilt: { headSha: 'abc1234', at: 5 }, heals: ['lock', 'nope'] },
      { id: 'b', state: 'stalled', contextResume: { at: 9, percent: 81, etaMs: 120000 }, heals: 'deps' },
      { id: 'c', state: 'pending' },
    ],
  });
  assert.deepEqual(stored.options, { unattendedApprovalMin: 30, sleepOnLimit: false, shutdownWhenDone: false, abBuild: true, selfHeal: true });
  const [g, va, b, c] = stored.packages;
  assert.deepEqual(g.ab, { variants: [{ key: 'a', label: 'X' }, { key: 'b', label: 'Y' }], winner: null });
  assert.deepEqual([va.abOf, va.abKey, va.abBuilt, va.heals], ['a', 'a', { headSha: 'abc1234', at: 5 }, ['lock']]);
  assert.deepEqual(b.contextResume, { at: 9, percent: 81, etaMs: 120000 });
  assert.equal('heals' in b, false);
  for (const key of ['ab', 'abOf', 'abKey', 'abLabel', 'abBuilt', 'heals', 'contextResume']) assert.equal(key in c, false, key);
});
