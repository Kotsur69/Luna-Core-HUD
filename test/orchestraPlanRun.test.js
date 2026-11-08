// ============================================================================
// Free God Mode v2 plan runs: topics, package graph, briefs
// (orchestraPlanRun.js), PLAN.md tasks and sizing (planTasks.js), and the
// plan-run finish guard (planRunFinishCheck + orchestraFinish.js wiring).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pr = require('../src/orchestraPlanRun.js');
const pt = require('../src/planTasks.js');
const { finishPackage } = require('../src/orchestraFinish.js');

const SLUG = 'hud-v3';
const topicsOf = (n) => Array.from({ length: n }, (_, i) => ({ slug: `topic-${i + 1}`, question: `Question ${i + 1}?` }));

// ---------------------------------------------------------------------------
// Topics and run slug
// ---------------------------------------------------------------------------

test('validateTopics: 2-6 topics pass, normalized', () => {
  const res = pr.validateTopics({ topics: [{ slug: 'UI Ideas!', question: '  What\n  UI?  ' }, { slug: 'data', question: 'Which store?' }] });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.topics, [
    { slug: 'ui-ideas', question: 'What UI?' },
    { slug: 'data', question: 'Which store?' },
  ]);
  assert.equal(pr.validateTopics(topicsOf(6)).topics.length, 6);
});

test('validateTopics: fewer than 2 is an error, more than 6 is capped', () => {
  assert.deepEqual(pr.validateTopics({ topics: topicsOf(1) }).errors, [{ code: 'tooFew', count: 1, min: 2 }]);
  assert.equal(pr.validateTopics(null).errors[0].code, 'tooFew');
  const many = pr.validateTopics(topicsOf(8));
  assert.equal(many.topics.length, 6);
  assert.equal(many.warnings.filter((w) => w.code === 'tooMany').length, 2);
  assert.deepEqual(many.errors, []);
});

test('validateTopics: bad slugs, duplicates, reserved names and empty questions are dropped', () => {
  const res = pr.validateTopics([
    { slug: '!!!', question: 'q' },
    { slug: 'a', question: 'q1' },
    { slug: 'A', question: 'q2' },
    { slug: 'Plan', question: 'q3' },
    { slug: 'critique', question: 'q4' },
    { slug: 'nul', question: 'q5' },
    { slug: 'b', question: '   ' },
    'nope',
    { slug: 'c', question: 'q6' },
  ]);
  assert.deepEqual(res.topics.map((t) => t.slug), ['a', 'c']);
  assert.deepEqual(res.warnings.map((w) => w.code).sort(), [
    'badSlug', 'badTopic', 'dupSlug', 'emptyQuestion', 'reservedSlug', 'reservedSlug', 'reservedSlug',
  ]);
});

test('validateTopics: slug and question caps', () => {
  const res = pr.validateTopics([
    { slug: 'x'.repeat(60), question: 'q'.repeat(900) },
    { slug: 'long-name-' + 'y'.repeat(40), question: 'ok' },
  ]);
  assert.equal(res.topics[0].slug.length, pr.MAX_TOPIC_SLUG_CHARS);
  assert.equal(res.topics[0].question.length, pr.MAX_QUESTION_CHARS);
  assert.ok(res.topics.every((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.slug)));
});

test('validateRunSlug: safe for a branch and a folder', () => {
  assert.deepEqual(pr.validateRunSlug(' hud-v3 '), { ok: true, slug: 'hud-v3' });
  assert.equal(pr.validateRunSlug('').error, 'empty');
  assert.equal(pr.validateRunSlug(42).error, 'empty');
  assert.equal(pr.validateRunSlug('a'.repeat(pr.MAX_RUN_SLUG_CHARS + 1)).error, 'tooLong');
  for (const bad of ['Hud', 'a..b', 'a/b', '../x', 'a--b', '-a', 'a-', 'a.lock', 'a b', 'a\\b']) {
    assert.equal(pr.validateRunSlug(bad).error, 'notKebab', bad);
  }
  assert.equal(pr.validateRunSlug('con').error, 'reserved');
});

// ---------------------------------------------------------------------------
// Package graph and briefs
// ---------------------------------------------------------------------------

test('buildPlanRunPackages: topics in parallel -> critique -> synthesis', () => {
  const pkgs = pr.buildPlanRunPackages(SLUG, topicsOf(3), { goal: 'Make the HUD better' });
  assert.deepEqual(pkgs.map((p) => [p.id, p.dependsOn]), [
    ['topic-1', []],
    ['topic-2', []],
    ['topic-3', []],
    ['critique', ['topic-1', 'topic-2', 'topic-3']],
    ['synthesis', ['critique']],
  ]);
  assert.deepEqual(pkgs.map((p) => p.files[0]), [
    'docs/plans/hud-v3/topic-1.md',
    'docs/plans/hud-v3/topic-2.md',
    'docs/plans/hud-v3/topic-3.md',
    'docs/plans/hud-v3/CRITIQUE.md',
    'docs/plans/hud-v3/PLAN.md',
  ]);
  assert.deepEqual(pkgs[0].planRun, { runSlug: SLUG, role: 'topic', topic: 'topic-1', outputPath: 'docs/plans/hud-v3/topic-1.md' });
  assert.equal(pkgs[3].planRun.role, 'critique');
  assert.equal(pkgs[4].planRun.role, 'synthesis');
  assert.ok(pkgs.every((p) => pr.isPlanRunPackage(p)));
  // The critic prefers a different easy model than the topic writers.
  assert.deepEqual(pkgs[3].modelHint, { pool: 'auto:easy', avoidModelsOf: ['topic-1', 'topic-2', 'topic-3'] });
  assert.equal(pkgs[0].modelHint.pool, 'auto:easy');
});

test('buildPlanRunPackages: refuses a bad run slug or topic count', () => {
  assert.throws(() => pr.buildPlanRunPackages('../x', topicsOf(2)), TypeError);
  assert.throws(() => pr.buildPlanRunPackages(SLUG, topicsOf(1)), TypeError);
  assert.throws(() => pr.buildPlanRunPackages(SLUG, topicsOf(7)), TypeError);
});

test('briefs: path, outline, no-code, English, whole repo, research tools', () => {
  const [topic, , critique, synthesis] = pr.buildPlanRunPackages(SLUG, topicsOf(2), { goal: 'Zrob lepszy HUD' });
  for (const p of [topic, critique, synthesis]) {
    assert.match(p.prompt, /English only, whatever language the request is in/);
    assert.match(p.prompt, /Read the whole repo first - code, assets, configs and docs/);
    assert.match(p.prompt, /No code\. Do not edit, create or delete anything outside `docs\/plans\/hud-v3\/`/);
    assert.match(p.prompt, /Zrob lepszy HUD/);
    assert.ok(p.prompt.includes(`\`${p.files[0]}\` (exactly this path)`), p.id);
  }
  for (const p of [topic, critique]) {
    assert.match(p.prompt, /WebSearch/);
    assert.match(p.prompt, /WebFetch/);
    assert.match(p.prompt, /Playwright MCP, read-only: navigate, snapshot and evaluate/);
    assert.match(p.prompt, /r\.jina\.ai\/<url>/);
  }
  assert.match(topic.prompt, /MUST end with a `## Sources` section listing every source as a full URL/);
  for (const s of pr.TOPIC_OUTLINE) assert.ok(topic.prompt.includes(`## ${s}`), s);
  for (const s of pr.CRITIQUE_OUTLINE) assert.ok(critique.prompt.includes(`## ${s}`), s);
  assert.match(critique.prompt, /Do NOT propose the plan/);
  assert.match(critique.prompt, /docs\/plans\/hud-v3\/topic-1\.md/);
});

test('synthesis brief: PLAN.md outline in order, critique answered, task format', () => {
  const synthesis = pr.buildPlanRunPackages(SLUG, topicsOf(2)).pop();
  const outline = ['Summary', 'Decisions', 'Critique answered', 'Milestones', 'Tasks', 'Risks', 'Open questions'];
  assert.deepEqual(pr.PLAN_OUTLINE, outline);
  const block = synthesis.prompt.slice(synthesis.prompt.indexOf('```markdown'));
  const positions = outline.map((s) => block.indexOf(`## ${s}`));
  assert.ok(positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1])), 'outline in order');
  assert.match(synthesis.prompt, /fixed \(say how the plan changed\) or accepted with a reason/);
  assert.match(synthesis.prompt, /checkbox list/);
  assert.match(synthesis.prompt, /- Files: /);
  assert.match(synthesis.prompt, /- Acceptance: /);
  assert.match(synthesis.prompt, /docs\/plans\/hud-v3\/CRITIQUE\.md/);
});

// ---------------------------------------------------------------------------
// PLAN.md task parser
// ---------------------------------------------------------------------------

const PLAN_MD = [
  '# Plan',
  '## Summary',
  '- [ ] not a task, wrong section',
  '## Tasks',
  '',
  '- [ ] Add the plan-run store',
  '  - Files: `src/planStore.js` (new), src/orchestraStore.js',
  '  - Acceptance: `npm test -- test/planStore.test.js`',
  '- [x] Show topics on the board',
  '    - files:',
  '        - src/renderer/board.js',
  '        - src/renderer/board.css',
  '    - Acceptance test: open the board and it shows 3 topic cards',
  '    - [ ] sub step one',
  '    - [x] sub step two',
  '    - a free note',
  '* [X] Inline task - Files: src/a.js, src/b.js; Acceptance: npm run lint',
  '1. [ ] Numbered task',
  '   - Acceptance: works',
  '- Plain bullet without a checkbox',
  '```',
  '- [ ] fenced, ignored',
  '```',
  '## Risks',
  '- [ ] not a task either',
].join('\n');

test('parsePlanTasks: checkboxes, nested files, acceptance, subtasks', () => {
  const tasks = pt.parsePlanTasks(PLAN_MD);
  assert.deepEqual(tasks.map((t) => t.text), [
    'Add the plan-run store',
    'Show topics on the board',
    'Inline task',
    'Numbered task',
    'Plain bullet without a checkbox',
  ]);
  assert.deepEqual(tasks.map((t) => t.checked), [false, true, true, false, false]);
  assert.deepEqual(tasks.map((t) => t.hasCheckbox), [true, true, true, true, false]);
  assert.deepEqual(tasks[0].files, [
    { path: 'src/planStore.js', isNew: true },
    { path: 'src/orchestraStore.js', isNew: false },
  ]);
  assert.equal(tasks[0].acceptance, '`npm test -- test/planStore.test.js`');
  assert.deepEqual(tasks[1].files.map((f) => f.path), ['src/renderer/board.js', 'src/renderer/board.css']);
  assert.equal(tasks[1].acceptance, 'open the board and it shows 3 topic cards');
  assert.deepEqual(tasks[1].subtasks, [
    { text: 'sub step one', checked: false },
    { text: 'sub step two', checked: true },
  ]);
  assert.deepEqual(tasks[1].notes, ['a free note']);
  assert.deepEqual(tasks[2].files.map((f) => f.path), ['src/a.js', 'src/b.js']);
  assert.equal(tasks[2].acceptance, 'npm run lint');
  assert.equal(tasks[3].acceptance, 'works');
});

test('parsePlanTasks: missing section or bad input -> empty', () => {
  assert.deepEqual(pt.parsePlanTasks('# Plan\n## Summary\n- [ ] x\n'), []);
  assert.deepEqual(pt.parsePlanTasks(''), []);
  assert.deepEqual(pt.parsePlanTasks(null), []);
});

test('parsePlanTasks: format drift - CRLF, ### heading, bold keys, tabs, new: prefix', () => {
  const md = '### Tasks (2)\r\n- [ ] One\r\n\t- **Files:** new: src/x.js, ./src/y.js\r\n\t- **Acceptance:** node --test\r\n';
  const [t] = pt.parsePlanTasks(md);
  assert.equal(t.text, 'One');
  assert.deepEqual(t.files, [
    { path: 'src/x.js', isNew: true },
    { path: 'src/y.js', isNew: false },
  ]);
  assert.equal(t.acceptance, 'node --test');
});

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/** Fake fs: rel path -> line count; anything else does not exist. */
function fakeFs(files) {
  return {
    repoRoot: '/repo',
    fileExists: (_abs, rel) => Object.prototype.hasOwnProperty.call(files, rel),
    lineCount: (_abs, rel) => files[rel] || 0,
  };
}

const task = (over = {}) => ({
  index: 0,
  text: 'Do a thing',
  checked: false,
  hasCheckbox: true,
  files: [{ path: 'src/a.js', isNew: false }],
  acceptance: '`npm test`',
  subtasks: [],
  notes: [],
  ...over,
});

const codes = (res) => res.tasks[0].failures.map((f) => f.code);

test('limits are named constants (Q7)', () => {
  assert.equal(pt.MAX_TASK_FILES, 5);
  assert.equal(pt.MAX_TASK_AREAS, 1);
  assert.equal(pt.MAX_TOUCHED_LINES, 400);
  assert.ok(pt.MAX_TASK_TEXT_CHARS > 0);
});

test('light sizing: format and acceptance only', () => {
  assert.equal(pt.checkTaskSizing([task()]).ok, true);
  // No file checks in light mode, even with ten unknown files.
  const files = Array.from({ length: 10 }, (_, i) => ({ path: `x${i}/f.js`, isNew: false }));
  assert.equal(pt.checkTaskSizing([task({ files, acceptance: 'works' })]).ok, true);
  assert.deepEqual(codes(pt.checkTaskSizing([task({ acceptance: null })])), ['noAcceptance']);
  assert.deepEqual(codes(pt.checkTaskSizing([task({ hasCheckbox: false, text: '' })])), ['noCheckbox', 'emptyText']);
});

test('strict sizing: a small task passes', () => {
  const fs = fakeFs({ 'src/a.js': 120, 'src/b.js': 200 });
  const res = pt.checkTaskSizing(
    [task({ files: [{ path: 'src/a.js', isNew: false }, { path: 'src/b.js', isNew: false }, { path: 'src/c.js', isNew: true }] })],
    { strict: true, ...fs },
  );
  assert.equal(res.ok, true, JSON.stringify(res.failing));
});

test('strict sizing: missing file vs new-file marker', () => {
  const fs = fakeFs({});
  assert.deepEqual(codes(pt.checkTaskSizing([task()], { strict: true, ...fs })), ['missingFile']);
  assert.equal(pt.checkTaskSizing([task({ files: [{ path: 'src/a.js', isNew: true }] })], { strict: true, ...fs }).ok, true);
});

test('strict sizing: file count, areas, touched lines', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.js`, isNew: true }));
  const fs = fakeFs({ 'src/main.js': 3383, 'test/a.test.js': 10, 'package.json': 5 });
  assert.deepEqual(codes(pt.checkTaskSizing([task({ files: six })], { strict: true, ...fs })), ['tooManyFiles']);
  const twoAreas = [{ path: 'src/main.js', isNew: false }, { path: 'test/a.test.js', isNew: false }];
  const res = pt.checkTaskSizing([task({ files: twoAreas })], { strict: true, ...fs });
  assert.deepEqual(codes(res), ['tooManyAreas', 'tooManyLines']);
  assert.match(res.tasks[0].failures[0].reason, /src, test/);
  assert.match(res.tasks[0].failures[1].reason, /3393/);
  // A root file is its own area.
  const rootAndSrc = [{ path: 'package.json', isNew: false }, { path: 'src/x.js', isNew: true }];
  assert.deepEqual(codes(pt.checkTaskSizing([task({ files: rootAndSrc })], { strict: true, ...fs })), ['tooManyAreas']);
  // New files do not count as touched existing lines.
  assert.equal(pt.checkTaskSizing([task({ files: [{ path: 'src/main.js', isNew: true }] })], { strict: true, ...fs }).ok, true);
});

test('strict sizing: no files, bad paths, long text', () => {
  const fs = fakeFs({});
  assert.deepEqual(codes(pt.checkTaskSizing([task({ files: [] })], { strict: true, ...fs })), ['noFiles']);
  const bad = [{ path: '../etc/x', isNew: true }, { path: '/abs/x.js', isNew: true }, { path: 'C:/x.js', isNew: true }];
  assert.deepEqual(codes(pt.checkTaskSizing([task({ files: bad })], { strict: true, ...fs })).filter((c) => c === 'badPath').length, 3);
  const long = task({ text: 'x'.repeat(pt.MAX_TASK_TEXT_CHARS + 1), files: [{ path: 'src/n.js', isNew: true }] });
  assert.deepEqual(codes(pt.checkTaskSizing([long], { strict: true, ...fs })), ['textTooLong']);
});

test('acceptance kinds: command, concrete check, vague', () => {
  assert.equal(pt.acceptanceKind('`npm test`'), 'command');
  assert.equal(pt.acceptanceKind('npm test -- test/x.test.js'), 'command');
  assert.equal(pt.acceptanceKind('Run node --test test/a.test.js'), 'command');
  assert.equal(pt.acceptanceKind('open the board and it shows 3 topic cards'), 'check');
  assert.equal(pt.acceptanceKind('the Plans tab lists every topic of the run'), 'check');
  assert.equal(pt.acceptanceKind('works'), 'vague');
  assert.equal(pt.acceptanceKind('tests pass'), 'vague');
  assert.equal(pt.acceptanceKind('manual check'), 'vague');
  assert.equal(pt.acceptanceKind('it should be nice and good'), 'vague');
  assert.equal(pt.acceptanceKind(''), 'missing');
  assert.equal(pt.acceptanceKind(null), 'missing');
  const fs = fakeFs({ 'src/a.js': 1 });
  assert.deepEqual(codes(pt.checkTaskSizing([task({ acceptance: 'works' })], { strict: true, ...fs })), ['vagueAcceptance']);
});

test('strict sizing needs the injected fs helpers', () => {
  assert.throws(() => pt.checkTaskSizing([task()], { strict: true }), TypeError);
});

test('sizing works end to end on a parsed PLAN.md', () => {
  const tasks = pt.parsePlanTasks(PLAN_MD);
  const fs = fakeFs({ 'src/orchestraStore.js': 150, 'src/renderer/board.js': 100, 'src/renderer/board.css': 50, 'src/a.js': 1, 'src/b.js': 1 });
  const res = pt.checkTaskSizing(tasks, { strict: true, ...fs });
  assert.deepEqual(res.failing.map((t) => t.index), [3, 4]);
});

// ---------------------------------------------------------------------------
// Split flow
// ---------------------------------------------------------------------------

test('first strict failure -> one split brief to the synthesis writer', () => {
  const fs = fakeFs({ 'src/main.js': 3383 });
  const sizing = pt.checkTaskSizing([task({ text: 'Rewrite main', files: [{ path: 'src/main.js', isNew: false }] })], { strict: true, ...fs });
  const step = pt.nextSizingStep(sizing, { splitsSent: 0, planPath: pr.planPath(SLUG) });
  assert.equal(step.action, 'split');
  assert.match(step.brief, /docs\/plans\/hud-v3\/PLAN\.md/);
  assert.match(step.brief, /Split these tasks/);
  assert.match(step.brief, /Task 1: Rewrite main/);
  assert.match(step.brief, /touches ~3383 lines/);
  assert.match(step.brief, /at most 5 files/);
  assert.match(step.brief, /Edit only the `## Tasks` section/);
});

test('second failure -> tasks flagged for the board, not blocked', () => {
  const fs = fakeFs({ 'src/main.js': 3383 });
  const sizing = pt.checkTaskSizing([task({ text: 'Rewrite main', files: [{ path: 'src/main.js', isNew: false }] })], { strict: true, ...fs });
  const step = pt.nextSizingStep(sizing, { splitsSent: 1, planPath: pr.planPath(SLUG) });
  assert.equal(step.action, 'flag');
  assert.deepEqual(step.flagged, [{ index: 0, text: 'Rewrite main', reasons: ['touches ~3383 lines of existing code (max ~400)'] }]);
});

test('passing sizing is accepted; light failures are flagged, never split', () => {
  assert.deepEqual(pt.nextSizingStep(pt.checkTaskSizing([task()]), { planPath: 'p' }), { action: 'accept' });
  const light = pt.checkTaskSizing([task({ acceptance: null })]);
  assert.equal(pt.nextSizingStep(light, { splitsSent: 0, planPath: 'p' }).action, 'flag');
});

// ---------------------------------------------------------------------------
// Finish guard (pure)
// ---------------------------------------------------------------------------

const z = (...recs) => recs.join('\0') + '\0';
const SOURCES_DOC = '# Topic\n## Findings\nx\n## Sources\n- https://example.com/a\n';
const topicRun = { runSlug: SLUG, role: 'topic', topic: 'topic-1' };

test('guard: changes inside the plan folder pass', () => {
  const status = z('?? docs/plans/hud-v3/topic-1.md', ' M docs/plans/hud-v3/notes.md');
  assert.deepEqual(pr.planRunFinishCheck({ planRun: topicRun, status, topicDoc: SOURCES_DOC }), { ok: true });
});

test('guard: changes outside only -> reverted + outsidePlanFolder', () => {
  const status = z(' M src/main.js', '?? scratch.txt', 'A  src/new.js', ' D README.md');
  const res = pr.planRunFinishCheck({ planRun: topicRun, status, topicDoc: SOURCES_DOC });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'outsidePlanFolder');
  assert.deepEqual(res.revert, [
    { path: 'src/main.js', action: 'checkout' },
    { path: 'scratch.txt', action: 'remove' },
    { path: 'src/new.js', action: 'rmIndexed' },
    { path: 'README.md', action: 'checkout' },
  ]);
  assert.match(res.detail, /src\/main\.js/);
});

test('guard: mixed inside and outside -> only the outside is reverted', () => {
  const status = z('?? docs/plans/hud-v3/topic-1.md', ' M package.json', 'R  docs/plans/hud-v3/x.md', 'src/old.js');
  const res = pr.planRunFinishCheck({ planRun: topicRun, status, topicDoc: SOURCES_DOC });
  assert.equal(res.reason, 'outsidePlanFolder');
  assert.deepEqual(res.revert, [
    { path: 'package.json', action: 'checkout' },
    { path: 'src/old.js', action: 'checkout' },
  ]);
});

test('guard: path tricks count as outside', () => {
  for (const p of [
    'docs/plans/hud-v3/../../../src/main.js',
    'docs/plans/hud-v3/./x.md',
    '/docs/plans/hud-v3/x.md',
    'C:/docs/plans/hud-v3/x.md',
    'docs\\plans\\hud-v3\\x.md',
    'docs/plans/other-run/x.md',
    'docs/plans/hud-v3-2/x.md',
    'docs/plans/hud-v3',
    'docs/plans/hud-v3/',
    'docs/plans//hud-v3/x.md',
  ]) {
    assert.equal(pr.isInsidePlanFolder(p, SLUG), false, p);
    const res = pr.planRunFinishCheck({ planRun: topicRun, status: [{ x: '?', y: '?', path: p }], topicDoc: SOURCES_DOC });
    assert.equal(res.reason, 'outsidePlanFolder', p);
  }
  assert.equal(pr.isInsidePlanFolder('docs/plans/hud-v3/sub/x.md', SLUG), true);
});

test('guard: a topic doc without sources stalls; critique and synthesis are exempt', () => {
  const status = z('?? docs/plans/hud-v3/topic-1.md');
  for (const doc of ['# Topic\n## Findings\nhttps://example.com\n', '# T\n## Sources\n- none yet\n', '# T\n## Sources\n## Extra\nhttps://example.com/x\n']) {
    const res = pr.planRunFinishCheck({ planRun: topicRun, status, topicDoc: doc });
    assert.equal(res.reason, 'noSources', doc);
  }
  const missing = pr.planRunFinishCheck({ planRun: topicRun, status: '', topicDoc: null });
  assert.equal(missing.reason, 'noSources');
  assert.match(missing.detail, /missing/);
  for (const role of ['critique', 'synthesis']) {
    assert.deepEqual(pr.planRunFinishCheck({ planRun: { runSlug: SLUG, role }, status: z('?? docs/plans/hud-v3/PLAN.md'), topicDoc: null }), { ok: true });
  }
});

test('hasSourcesSection: accepts drift in heading and link style', () => {
  assert.equal(pr.hasSourcesSection('## sources:\n1. [Doc](https://docs.example.org/page)\n'), true);
  assert.equal(pr.hasSourcesSection('##   Sources  \n<http://example.com/x>\n'), true);
  assert.equal(pr.hasSourcesSection('### Sources\nhttps://example.com\n'), false);
});

test('parseStatusZ: renames carry the original path', () => {
  assert.deepEqual(pr.parseStatusZ(z('R  new.md', 'old.md', ' M a b.js')), [
    { x: 'R', y: ' ', path: 'new.md', origPath: 'old.md' },
    { x: ' ', y: 'M', path: 'a b.js' },
  ]);
});

test('isPlanRunPackage: only an explicit planRun flag', () => {
  assert.equal(pr.isPlanRunPackage({ id: 'a' }), false);
  assert.equal(pr.isPlanRunPackage({ planRun: true }), false);
  assert.equal(pr.isPlanRunPackage({ planRun: { runSlug: '../x', role: 'topic', topic: 'a' } }), false);
  assert.equal(pr.isPlanRunPackage({ planRun: { runSlug: SLUG, role: 'build' } }), false);
  assert.equal(pr.isPlanRunPackage({ planRun: { runSlug: SLUG, role: 'topic' } }), false);
  assert.equal(pr.isPlanRunPackage({ planRun: topicRun }), true);
});

// ---------------------------------------------------------------------------
// Finish guard wired into finishPackage
// ---------------------------------------------------------------------------

/** Fake execFile for `git -C <root> ...`; `status -z` gets its own answer. */
function fakeGit({ statusZ = '', committedZ = '', revertFails = [] } = {}) {
  const calls = [];
  const execImpl = (_bin, args, _opts, cb) => {
    const sub = args.slice(2);
    calls.push(sub.join(' '));
    let a = { ok: true, stdout: '' };
    if (sub[0] === 'status' && sub.includes('-z')) a = { ok: true, stdout: statusZ };
    else if (sub[0] === 'diff' && sub.includes('--name-status')) a = { ok: true, stdout: committedZ };
    else if (sub[0] === 'rev-list') a = { ok: true, stdout: '1\n' };
    else if (sub[0] === 'rev-parse') a = { ok: true, stdout: 'abc\n' };
    else if (sub[0] === '--literal-pathspecs' && revertFails.includes(sub[sub.length - 1])) a = { ok: false, stderr: 'fatal: nope' };
    setImmediate(() => cb(a.ok ? null : new Error('x'), a.stdout || '', a.stderr || ''));
  };
  return { execImpl, calls };
}

const basePkg = { id: 'topic-1', root: '/wt/t', cwd: '/wt/t', branch: 'luna/topic-1', baseSha: 'base', verify: '' };
const deps = (git, doc = SOURCES_DOC) => ({
  isDirImpl: () => true,
  execImpl: git.execImpl,
  verifyImpl: async () => ({ ok: true, output: '' }),
  readFileImpl: async () => doc,
});

test('finishPackage: plan run inside its folder finishes normally', async () => {
  const git = fakeGit({ statusZ: z('?? docs/plans/hud-v3/topic-1.md') });
  const res = await finishPackage({ ...basePkg, planRun: topicRun }, deps(git));
  assert.equal(res.ok, true);
  assert.ok(!git.calls.some((c) => c.startsWith('--literal-pathspecs')));
});

test('finishPackage: outside changes are reverted and the package stalls', async () => {
  const git = fakeGit({ statusZ: z(' M src/main.js', '?? tmp.txt', 'A  src/n.js', '?? docs/plans/hud-v3/topic-1.md'), revertFails: ['src/n.js'] });
  const res = await finishPackage({ ...basePkg, planRun: topicRun }, deps(git));
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'planGuard');
  assert.equal(res.reason, 'outsidePlanFolder');
  assert.deepEqual(res.reverted, ['src/main.js', 'tmp.txt']);
  assert.deepEqual(res.revertFailed, ['src/n.js']);
  assert.match(res.detail, /reverted outside docs\/plans\/hud-v3\/: src\/main\.js, tmp\.txt; could not revert: src\/n\.js/);
  assert.ok(git.calls.includes('--literal-pathspecs checkout HEAD -- src/main.js'));
  assert.ok(git.calls.includes('--literal-pathspecs clean -f -q -- tmp.txt'));
  assert.ok(git.calls.includes('--literal-pathspecs rm -f -q -- src/n.js'));
  assert.ok(!git.calls.some((c) => c.startsWith('commit') || c.startsWith('push')), 'no commit, no push');
});

test('finishPackage: topic doc without sources stalls noSources', async () => {
  const git = fakeGit({ statusZ: '' });
  const res = await finishPackage({ ...basePkg, planRun: topicRun }, deps(git, '# T\n## Findings\n'));
  assert.deepEqual([res.stage, res.reason], ['planGuard', 'noSources']);
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
});

test('finishPackage: synthesis needs no sources', async () => {
  const git = fakeGit({ statusZ: '' });
  const res = await finishPackage({ ...basePkg, planRun: { runSlug: SLUG, role: 'synthesis' } }, deps(git, null));
  assert.equal(res.ok, true);
});

test('finishPackage: build runs are untouched by the guard', async () => {
  const git = fakeGit({ statusZ: z(' M src/main.js') });
  const res = await finishPackage({ ...basePkg, verify: 'npm test' }, deps(git, null));
  assert.equal(res.ok, true);
  assert.ok(!git.calls.some((c) => c.includes('-z') || c.startsWith('--literal-pathspecs')));
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

test('guard: committed changes outside the folder are reverted to the base and committed', async () => {
  const committedZ = z('A', 'src/new.js', 'M', 'src/main.js', 'A', 'docs/plans/hud-v3/topic-1.md');
  const git = fakeGit({ statusZ: '', committedZ });
  const res = await finishPackage({ ...basePkg, planRun: topicRun }, deps(git));
  assert.deepEqual([res.stage, res.reason], ['planGuard', 'outsidePlanFolder']);
  assert.deepEqual(res.reverted, ['src/new.js', 'src/main.js']);
  assert.ok(git.calls.includes('--literal-pathspecs rm -f -q -- src/new.js'));
  assert.ok(git.calls.includes('--literal-pathspecs checkout base -- src/main.js'));
  assert.ok(git.calls.includes('--literal-pathspecs commit -q -m chore: luna revert changes outside docs/plans/hud-v3/ -- src/new.js src/main.js'));
  assert.ok(!git.calls.some((c) => c.startsWith('push')));
});

test('guard (pure): committed entries inside the folder pass', () => {
  const res = pr.planRunFinishCheck({ planRun: topicRun, status: '', committed: z('A', 'docs/plans/hud-v3/topic-1.md'), topicDoc: SOURCES_DOC });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(pr.parseNameStatusZ(z('M', 'a b.js', 'D', 'c.js')), [
    { status: 'M', path: 'a b.js' },
    { status: 'D', path: 'c.js' },
  ]);
});

test('finishPackage: an unreadable planRun flag fails closed', async () => {
  const git = fakeGit({ statusZ: '' });
  const res = await finishPackage({ ...basePkg, planRun: { role: 'topc', runSlug: SLUG } }, deps(git));
  assert.deepEqual([res.ok, res.stage, res.reason], [false, 'planGuard', 'badPlanRun']);
  assert.ok(!git.calls.some((c) => c.startsWith('commit') || c.startsWith('push')));
});

test('guard: intent-to-add and worktree renames', () => {
  assert.deepEqual(pr.parseStatusZ(z(' R new.js', 'old.js', ' M x.js')), [
    { x: ' ', y: 'R', path: 'new.js', origPath: 'old.js' },
    { x: ' ', y: 'M', path: 'x.js' },
  ]);
  const res = pr.planRunFinishCheck({ planRun: topicRun, status: z(' A src/x.js', ' R src/n.js', 'src/o.js'), topicDoc: SOURCES_DOC });
  assert.deepEqual(res.revert, [
    { path: 'src/x.js', action: 'rmIndexed' },
    { path: 'src/n.js', action: 'rmIndexed' },
    { path: 'src/o.js', action: 'checkout' },
  ]);
});

test('guard: an untracked nested repo inside the folder is inside', () => {
  assert.equal(pr.isInsidePlanFolder('docs/plans/hud-v3/sub/', SLUG), true);
  assert.equal(pr.isInsidePlanFolder('docs/plans/hud-v3//', SLUG), false);
});

test('hasSourcesSection: headings inside code fences do not count', () => {
  assert.equal(pr.hasSourcesSection('```markdown\n## Sources\nhttps://example.com/x\n```\n'), false);
  assert.equal(pr.hasSourcesSection('## Sources\n```\n# comment\n```\n- https://example.com/x\n'), true);
});

test('parsePlanTasks: the exact ## Tasks wins over ### Tasks under Milestones', () => {
  const md = '## Milestones\n### Tasks\n- [ ] milestone item\n## Tasks\n- [ ] real task\n  - Acceptance: npm test\n## Risks\n';
  assert.deepEqual(pt.parsePlanTasks(md).map((t) => t.text), ['real task']);
});

test('parseFileList: commas in parentheses and prose words', () => {
  assert.deepEqual(pt.parseFileList('src/a.js (add foo, bar), src/b.js').map((f) => f.path), ['src/a.js', 'src/b.js']);
  assert.deepEqual(pt.parseFileList('src/a.js and the tests').map((f) => f.path), ['src/a.js']);
  assert.deepEqual(pt.parseFileList('Makefile, package.json').map((f) => f.path), ['Makefile', 'package.json']);
});

test('parsePlanTasks: a "files:" inside task prose stays text', () => {
  const [t] = pt.parsePlanTasks('## Tasks\n- [ ] Handle zero-byte files: skip them\n');
  assert.equal(t.text, 'Handle zero-byte files: skip them');
  assert.deepEqual(t.files, []);
});

test('acceptanceKind: English sentences are not commands', () => {
  assert.equal(pt.acceptanceKind('Make sure it looks good'), 'vague');
  assert.equal(pt.acceptanceKind('Go to settings and check'), 'vague');
  assert.equal(pt.acceptanceKind('`make test`'), 'command');
});
