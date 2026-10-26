// ============================================================================
// Luna's Work project skills (LW 2.16): the hard path guard (absolute paths,
// `..`, ~/.claude, symlink / junction escapes), valid frontmatter, the
// Critic's accept / reject / edit gate before any write, the pass running
// only at a passed gate, the local commit, and the builder brief naming the
// skills. `claude` is a fake runner; repos are temp folders.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const S = require('../src/lunasworkSkills.js');
const C = require('../src/lunasworkCritic.js');
const Pack = require('../src/lunasworkPack.js');
const { createLoopHooks } = require('../src/lunasworkLoopHooks.js');
const { withBuilderBrief } = require('../src/lunasworkDirector.js');
const { createCommitter } = require('../src/lunasworkCommit.js');

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A temp project with a design pack (lunasworkPack's checkCwd needs a real folder). */
function fakeRepo() {
  const dir = tmp('lw-skills-');
  assert.equal(Pack.scaffoldPack(dir).ok, true);
  fs.writeFileSync(path.join(dir, 'design', 'DECISIONS.md'), '# Decisions\n\n- Chose vitest because the repo already runs it\n');
  return dir;
}

const envelope = (raw) => JSON.stringify({ is_error: false, structured_output: raw, total_cost_usd: 0.1 });

const proposal = (over = {}) => ({
  slug: 'run-tests',
  description: 'Use when running or adding tests: vitest with the repo config',
  body: '# Run tests\n\nRun `npm test`. New tests go next to the module as `*.test.ts`.',
  evidence: 'DECISIONS.md: chose vitest',
  ...over,
});

/** Fake proposer: answers every call with the given proposals. */
function proposer(skills) {
  const calls = [];
  return { calls, run: async (call) => { calls.push(call); return { stdout: envelope({ skills }) }; } };
}

const skillFile = (repo, slug) => path.join(repo, '.claude', 'skills', slug, 'SKILL.md');
const noCommit = async () => ({ ok: true, committed: false });

// ---- the hard guard ------------------------------------------------------------------

test('resolveSkillFile accepts a SKILL.md under <repo>/.claude/skills', () => {
  const repo = fakeRepo();
  const res = S.resolveSkillFile(repo, '.claude/skills/run-tests/SKILL.md', { home: tmp('lw-home-') });
  assert.equal(res.ok, true);
  assert.equal(res.path, path.join(fs.realpathSync(repo), '.claude', 'skills', 'run-tests', 'SKILL.md'));
});

test('resolveSkillFile refuses absolute paths, ~, .. and anything outside .claude/skills', () => {
  const repo = fakeRepo();
  const home = tmp('lw-home-');
  const refused = {
    '/etc/passwd': 'absolute',
    'C:\\Windows\\x.md': 'absolute',
    'C:x.md': 'absolute',
    '\\\\server\\share\\SKILL.md': 'absolute',
    '~/.claude/skills/x/SKILL.md': 'home',
    '.claude/skills/../settings.json': 'dotSegment',
    '.claude/skills/x/../../../../outside.md': 'dotSegment',
    '.claude/skills/./x/SKILL.md': 'dotSegment',
    '.claude/settings.json': 'outsideSkills',
    '.claude/skills': 'outsideSkills',
    'src/index.js': 'outsideSkills',
    '': 'badPath',
  };
  for (const [rel, error] of Object.entries(refused)) {
    const res = S.resolveSkillFile(repo, rel, { home });
    assert.equal(res.ok, false, rel);
    assert.equal(res.error, error, rel);
  }
  assert.equal(S.resolveSkillFile(repo, 42).ok, false);
  assert.equal(S.resolveSkillFile('relative/repo', '.claude/skills/x/SKILL.md').error, 'noRepo');
});

test('resolveSkillFile refuses the global ~/.claude even when the repo IS the home folder', () => {
  const home = fakeRepo();
  const res = S.resolveSkillFile(home, '.claude/skills/run-tests/SKILL.md', { home });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'globalClaude');
  assert.equal(S.writeSkill(home, proposal(), { home }).ok, false);
  assert.equal(fs.existsSync(skillFile(home, 'run-tests')), false);
});

test('resolveSkillFile refuses a symlinked or junctioned .claude/skills that escapes the repo', () => {
  const repo = fakeRepo();
  const outside = tmp('lw-outside-');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  // A junction needs no admin rights on Windows; elsewhere it is a dir symlink.
  fs.symlinkSync(outside, path.join(repo, '.claude', 'skills'), 'junction');
  const res = S.resolveSkillFile(repo, '.claude/skills/run-tests/SKILL.md', { home: tmp('lw-home-') });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'symlink');
  assert.equal(S.writeSkill(repo, proposal(), { home: tmp('lw-home-') }).ok, false);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through the link');
});

test('resolveSkillFile refuses a symlinked skill folder inside the skills dir', () => {
  const repo = fakeRepo();
  const outside = tmp('lw-outside-');
  fs.mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, '.claude', 'skills', 'run-tests'), 'junction');
  assert.equal(S.resolveSkillFile(repo, '.claude/skills/run-tests/SKILL.md', { home: tmp('lw-home-') }).error, 'symlink');
});

test('writeSkill never overwrites a skill a human wrote', () => {
  const repo = fakeRepo();
  const file = skillFile(repo, 'run-tests');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: run-tests\ndescription: mine\n---\n\nhand written\n');
  const res = S.writeSkill(repo, proposal(), { home: tmp('lw-home-') });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'humanSkill');
  assert.match(fs.readFileSync(file, 'utf8'), /hand written/);
});

test('writeSkill replaces a skill this loop wrote before', () => {
  const repo = fakeRepo();
  const home = tmp('lw-home-');
  assert.equal(S.writeSkill(repo, proposal(), { home }).ok, true);
  assert.equal(S.writeSkill(repo, proposal({ body: 'Second version.' }), { home }).ok, true);
  assert.match(fs.readFileSync(skillFile(repo, 'run-tests'), 'utf8'), /Second version\./);
});

// ---- frontmatter -----------------------------------------------------------------------

test('buildSkillFile writes valid frontmatter: name = slug, a quoted one-line description', () => {
  const text = S.buildSkillFile(proposal({ description: 'Use when: tests "fail" # sometimes' }));
  assert.ok(text.startsWith('---\nname: run-tests\ndescription: "Use when: tests \\"fail\\" # sometimes"\n---\n'));
  assert.equal(S.validSkillFile(text), true);
  const parsed = S.parseSkillFile(text);
  assert.equal(parsed.name, 'run-tests');
  assert.equal(parsed.description, 'Use when: tests "fail" # sometimes');
  assert.match(parsed.body, /Run `npm test`/);
  assert.ok(text.includes(S.SKILL_MARKER));
});

test('validSkillFile rejects files without frontmatter, a bad name or no description', () => {
  assert.equal(S.validSkillFile('# no frontmatter'), false);
  assert.equal(S.validSkillFile('---\nname: Bad Name\ndescription: x\n---\n'), false);
  assert.equal(S.validSkillFile('---\nname: ok-name\n---\nbody'), false);
  assert.equal(S.validSkillFile('---\nname: ok-name\ndescription: ""\n---\n'), false);
  assert.equal(S.validSkillFile('---\nname: ok-name\ndescription: plain text works\n---\n'), true);
});

test('validateProposals keeps valid, unique slugs and never a human skill', () => {
  const out = S.validateProposals({
    skills: [
      proposal(),
      proposal({ slug: 'run-tests', description: 'duplicate' }),
      proposal({ slug: '../evil' }),
      proposal({ slug: 'Upper' }),
      proposal({ slug: 'mine', description: 'x' }),
      proposal({ slug: 'empty-body', body: '   ' }),
      proposal({ slug: 'frontmatter', body: '---\nname: other\ndescription: y\n---\nReal body' }),
    ],
  }, { existing: [{ slug: 'mine', ours: false }] });
  assert.deepEqual(out.proposals.map((p) => p.slug), ['run-tests', 'frontmatter']);
  assert.equal(out.proposals[1].body, 'Real body');
  assert.deepEqual(out.warnings.map((w) => w.code).sort(), ['badProposal', 'badProposal', 'badProposal', 'duplicateSlug', 'humanSkill'].sort());
  assert.deepEqual(S.validateProposals('nope').proposals, []);
});

// ---- the Critic's gate -------------------------------------------------------------------

test('validateSkillReview: known slugs only, first verdict wins, an empty edit is dropped', () => {
  const proposals = [proposal(), proposal({ slug: 'deploy-steps' })];
  const out = C.validateSkillReview({
    reviews: [
      { slug: 'run-tests', verdict: 'accept', reason: 'true and specific' },
      { slug: 'run-tests', verdict: 'reject', reason: 'second answer' },
      { slug: 'deploy-steps', verdict: 'edit', reason: 'vague' },
      { slug: 'unknown', verdict: 'accept', reason: 'x' },
      { slug: 'deploy-steps', verdict: 'maybe', reason: 'x' },
    ],
  }, proposals);
  assert.deepEqual(out.reviews, [{ slug: 'run-tests', verdict: 'accept', reason: 'true and specific' }]);
  assert.ok(out.warnings.some((w) => w.code === 'emptySkillEdit'));
});

test('applyReview: accept keeps, edit replaces, reject and no review drop', () => {
  const proposals = [proposal(), proposal({ slug: 'deploy-steps' }), proposal({ slug: 'lint-rules' }), proposal({ slug: 'unreviewed' })];
  const { accepted, rejected } = S.applyReview(proposals, [
    { slug: 'run-tests', verdict: 'accept', reason: 'ok' },
    { slug: 'deploy-steps', verdict: 'edit', reason: 'sharper', body: 'Deploy with `npm run deploy`.' },
    { slug: 'lint-rules', verdict: 'reject', reason: 'generic advice' },
  ]);
  assert.deepEqual(accepted.map((a) => [a.slug, a.edited]), [['run-tests', false], ['deploy-steps', true]]);
  assert.equal(accepted[1].body, 'Deploy with `npm run deploy`.');
  assert.deepEqual(rejected, [{ slug: 'lint-rules', reason: 'generic advice' }, { slug: 'unreviewed', reason: 'not reviewed' }]);
});

test('runGateSkills: a rejection prevents the write, an accept writes, an edit writes the edit', async () => {
  const repo = fakeRepo();
  const fake = proposer([proposal(), proposal({ slug: 'deploy-steps' }), proposal({ slug: 'lint-rules' })]);
  const seen = [];
  const res = await S.runGateSkills({
    isGate: true, repoDir: repo, milestone: 'Skeleton', home: tmp('lw-home-'), runClaude: fake.run, commit: noCommit,
    review: async (o) => {
      seen.push(o.proposals.map((p) => p.slug));
      // Nothing is on disk while the Critic reviews.
      assert.equal(fs.existsSync(path.join(repo, '.claude', 'skills')), false);
      return { ok: true, reviews: [
        { slug: 'run-tests', verdict: 'accept', reason: 'ok' },
        { slug: 'deploy-steps', verdict: 'edit', reason: 'fix', description: 'Use when deploying the app', body: 'Edited body.' },
        { slug: 'lint-rules', verdict: 'reject', reason: 'generic' },
      ] };
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [['run-tests', 'deploy-steps', 'lint-rules']]);
  assert.deepEqual(res.written, ['.claude/skills/run-tests/SKILL.md', '.claude/skills/deploy-steps/SKILL.md']);
  assert.equal(fs.existsSync(skillFile(repo, 'lint-rules')), false);
  const edited = fs.readFileSync(skillFile(repo, 'deploy-steps'), 'utf8');
  assert.match(edited, /description: "Use when deploying the app"/);
  assert.match(edited, /Edited body\./);
  assert.equal(S.validSkillFile(edited), true);
  assert.deepEqual(res.rejected, [{ slug: 'lint-rules', reason: 'generic' }]);
});

test('runGateSkills writes nothing when the Critic review fails', async () => {
  const repo = fakeRepo();
  const res = await S.runGateSkills({
    isGate: true, repoDir: repo, home: tmp('lw-home-'), runClaude: proposer([proposal()]).run, commit: noCommit,
    review: async () => ({ ok: false, reviews: [], error: 'timeout' }),
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.written, []);
  assert.match(res.notes[0], /review failed \(timeout\) - nothing written/);
  assert.equal(fs.existsSync(skillFile(repo, 'run-tests')), false);
});

test('runGateSkills through the real Critic review: one read-only call with the review schema', async () => {
  const repo = fakeRepo();
  const calls = [];
  const runClaude = async (call) => {
    calls.push(call);
    if (calls.length === 1) return { stdout: envelope({ skills: [proposal(), proposal({ slug: 'deploy-steps' })] }) };
    return { stdout: envelope({ reviews: [{ slug: 'run-tests', verdict: 'reject', reason: 'contradicts DECISIONS.md' }, { slug: 'deploy-steps', verdict: 'accept', reason: 'ok' }] }) };
  };
  const res = await S.runGateSkills({ isGate: true, repoDir: repo, milestone: 'Core flows', home: tmp('lw-home-'), runClaude, commit: noCommit });
  assert.equal(calls.length, 2);
  const reviewArgs = calls[1].args;
  assert.equal(reviewArgs[reviewArgs.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.match(reviewArgs[reviewArgs.indexOf('--json-schema') + 1], /"reviews"/);
  assert.match(calls[1].prompt, /"Core flows" milestone gate/);
  assert.match(calls[1].prompt, /Chose vitest/);
  assert.deepEqual(res.written, ['.claude/skills/deploy-steps/SKILL.md']);
  assert.equal(fs.existsSync(skillFile(repo, 'run-tests')), false);
});

// ---- only at gates ------------------------------------------------------------------------

test('runGateSkills does nothing when it is not a gate', async () => {
  const fake = proposer([proposal()]);
  const res = await S.runGateSkills({ isGate: false, repoDir: fakeRepo(), runClaude: fake.run });
  assert.equal(res.skipped, 'notGate');
  assert.equal(fake.calls.length, 0);
});

function hooksFor(runState, skills) {
  let run = runState;
  const events = [];
  const hooks = createLoopHooks({
    deps: { skills, todoStore: () => ({ read: () => [] }) },
    run: () => run,
    update: (fields) => { run = { ...run, ...fields }; },
    logEvent: (text) => events.push(text),
    cardBook: { fileCards: () => [] },
    ask: () => ({ ok: false }),
  });
  return { hooks, events, run: () => run };
}

test('the loop hook runs the skills pass only at a passed gate that stayed on main, once per iteration', async () => {
  const calls = [];
  const skills = async (o) => { calls.push(o); return { ok: true, notes: ['project skills: 1 proposed, 1 written, 0 rejected by the Critic'], committed: true }; };
  const base = { id: 'lwtest1', repoPath: 'C:/repo', iteration: 4, milestone: 'Core flows', models: {}, laps: [{ n: 2, gate: true }, { n: 3 }], current: { hooks: null, hookNotes: [] } };
  const passed = { verdict: 'continue', milestone: { name: 'Core flows', passed: true } };
  const notPassed = { verdict: 'continue', milestone: { name: 'Core flows', passed: false } };

  const a = hooksFor(base, skills);
  await a.hooks.atGate(notPassed, {});
  assert.equal(calls.length, 0, 'no gate, no pass');
  await a.hooks.atGate(passed, { rolledBack: true });
  assert.equal(calls.length, 0, 'a rolled-back gate is not a gate');
  await a.hooks.atGate(passed, { milestone: 'Core flows' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].isGate, true);
  assert.equal(calls[0].sinceIteration, 2, 'the git log starts at the previous gate');
  assert.equal(calls[0].milestone, 'Core flows');
  assert.ok(a.run().current.hookNotes.some((n) => /1 written/.test(n)));
  await a.hooks.atGate(passed, {});
  assert.equal(calls.length, 1, 'once per iteration (a restart never repeats it)');
});

// ---- the commit -----------------------------------------------------------------------------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

function gitRepo() {
  const dir = fakeRepo();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'luna@example.com');
  git(dir, 'config', 'user.name', 'Luna');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'app.js'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('the written skills are one local commit on the checkout; other changes stay uncommitted', async () => {
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, 'app.js'), 'work in progress\n');
  const before = git(repo, 'rev-parse', 'HEAD');
  const res = await S.runGateSkills({
    isGate: true, repoDir: repo, milestone: 'Skeleton', home: tmp('lw-home-'), runClaude: proposer([proposal()]).run,
    review: async () => ({ ok: true, reviews: [{ slug: 'run-tests', verdict: 'accept', reason: 'ok' }] }),
    commit: (o) => createCommitter().commitPaths(o),
  });
  assert.equal(res.committed, true);
  assert.equal(git(repo, 'rev-parse', 'HEAD~1'), before);
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'chore(skills): project skills from the Skeleton gate');
  assert.equal(git(repo, 'show', '--name-only', '--format=', 'HEAD'), '.claude/skills/run-tests/SKILL.md');
  assert.equal(git(repo, 'diff', '--name-only'), 'app.js', 'the work in progress is left alone');
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), '', 'and nothing else is staged');
});

test('commitPaths refuses unsafe paths and commits nothing new twice', async () => {
  const repo = gitRepo();
  const committer = createCommitter();
  assert.equal((await committer.commitPaths({ repoPath: repo, paths: ['../x'], message: 'm' })).error, 'badPaths');
  assert.equal((await committer.commitPaths({ repoPath: repo, paths: ['/etc/x'], message: 'm' })).error, 'badPaths');
  assert.equal((await committer.commitPaths({ repoPath: repo, paths: ['app.js'], message: '' })).error, 'noMessage');
  const same = await committer.commitPaths({ repoPath: repo, paths: ['app.js'], message: 'nothing changed' });
  assert.deepEqual(same, { ok: true, committed: false });
});

// ---- the builder brief ------------------------------------------------------------------------

test('builder briefs name the project skills when the repo has them', () => {
  const repo = fakeRepo();
  assert.equal(S.writeSkill(repo, proposal(), { home: tmp('lw-home-') }).ok, true);
  const skills = S.listSkills(repo);
  assert.deepEqual(skills.map((s) => [s.slug, s.ours]), [['run-tests', true]]);
  const briefed = withBuilderBrief({ at: 1, text: 'Card', details: 'Do it.' }, [], skills);
  assert.match(briefed.details, /Project skills in \.claude\/skills\/ record what worked in this project - use them: run-tests/);
  const plain = withBuilderBrief({ at: 2, text: 'Card', details: 'Do it.' }, []);
  assert.doesNotMatch(plain.details, /Project skills/);
});
