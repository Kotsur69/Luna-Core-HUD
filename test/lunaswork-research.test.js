// ============================================================================
// Luna's Work research step (src/lunasworkResearch.js, idea #14). Covers the
// pure reference detector, the write confinement to design/references/, the
// append-only DESIGN.md summary, one researcher pass with a fake `claude`
// (screenshots copied from the staging dir only), the controller seam, and
// the controller running the step before the first Director and again when
// DESIGN.md gains a reference - with a fake researcher.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../src/lunasworkResearch');
const pack = require('../src/lunasworkPack');
const { createLunasWork } = require('../src/lunaswork');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const START = 1_700_000_000_000;

function tempRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-research-repo-'));
  fs.mkdirSync(path.join(dir, 'design', 'references'), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'design', name), text);
  return dir;
}

const readDesign = (repo) => fs.readFileSync(path.join(repo, 'design', 'DESIGN.md'), 'utf8');
const notesPath = (repo, slug) => path.join(repo, 'design', 'references', slug, 'NOTES.md');

// ---- detection ---------------------------------------------------------------------

test('detectReferences: "like X", "similar to X", quoted names and URLs, in text order, unique slugs', () => {
  const md = [
    '# Design',
    'A task board like Linear, with a sidebar similar to "Notion Calendar".',
    'Checkout inspired by Stripe\'s checkout; see https://www.figma.com/community/file/123.',
    'Again like Linear.',
  ].join('\n');
  const refs = R.detectReferences(md, 'DESIGN.md');
  assert.deepEqual(refs.map((r) => r.slug), ['linear', 'notion-calendar', 'stripe', 'figma-com']);
  assert.deepEqual(refs.map((r) => r.name), ['Linear', 'Notion Calendar', 'Stripe', 'figma.com']);
  assert.equal(refs[3].url, 'https://www.figma.com/community/file/123');
  assert.equal(refs[0].file, 'DESIGN.md');
  assert.match(refs[0].phrase, /like Linear/);
});

test('detectReferences: wishes, pronouns, lowercase words, comments, code, local URLs and its own sections are not references', () => {
  const md = [
    'It should feel like this, or like a game, with layouts like 2 columns.',
    'We would like Jan to approve the colors.',
    '<!-- like Dribbble, a template comment -->',
    '```',
    'like Hidden in code',
    '```',
    'Runs on http://localhost:3000/ and http://127.0.0.1:8080.',
    '## References (research, 2026-10-27)',
    '- **Linear** - task board (sources: https://linear.app/features)',
    '## Look and feel',
    'Colors in the style of Things 3.',
  ].join('\n');
  assert.deepEqual(R.detectReferences(md).map((r) => r.slug), ['things-3']);
  assert.deepEqual(R.detectReferences(''), []);
  assert.deepEqual(R.detectReferences(null), []);
});

test('detectReferences: a huge token without spaces (a pasted blob) is scanned in linear time', () => {
  const started = Date.now();
  const refs = R.detectReferences(`${'A'.repeat(200000)} like Linear`);
  assert.deepEqual(refs.map((r) => r.slug), ['linear']);
  assert.ok(Date.now() - started < 1000, 'no quadratic backtracking');
});

test('slugify: folder-safe, diacritics folded, empty -> null', () => {
  assert.equal(R.slugify('Notion Calendar'), 'notion-calendar');
  assert.equal(R.slugify('Café Zażó'), 'cafe-zazo');
  assert.equal(R.slugify('../..'), null);
  assert.equal(R.slugify(''), null);
});

test('pendingReferences: BRIEF.md + DESIGN.md merged, a reference with NOTES.md is done, skip set honoured', () => {
  const repo = tempRepo({ 'BRIEF.md': 'A planner like Linear.', 'DESIGN.md': 'Board like Linear, calendar like Cron.' });
  assert.deepEqual(R.pendingReferences(repo).map((r) => [r.slug, r.file]), [['linear', 'BRIEF.md'], ['cron', 'DESIGN.md']]);
  assert.equal(R.writeReferenceFile(repo, 'linear/NOTES.md', '# notes').ok, true);
  assert.deepEqual(R.pendingReferences(repo).map((r) => r.slug), ['cron']);
  assert.deepEqual(R.pendingReferences(repo, new Set(['cron'])), []);
});

// ---- write confinement ---------------------------------------------------------------

test('write confinement: only design/references/<slug>/<file> is writable', () => {
  const repo = tempRepo();
  const refused = [
    '../DESIGN.md',
    'linear/../../DESIGN.md',
    'linear\\..\\..\\BRIEF.md',
    path.join(repo, 'evil.txt'),
    'C:/evil.txt',
    'NOTES.md',
    'linear/deeper/NOTES.md',
    'Linear/NOTES.md',
    'linear/..',
    'linear/.hidden',
    'linear/CON.png',
    'nul/NOTES.md',
    'linear/com1',
    '',
  ];
  for (const rel of refused) {
    assert.equal(R.referencePath(repo, rel), null, rel);
    assert.equal(R.writeReferenceFile(repo, rel, 'x').ok, false, rel);
  }
  assert.equal(R.referencePath('relative/repo', 'linear/NOTES.md'), null);
  assert.equal(R.writeReferenceFile(repo, 'linear/home.png', PNG).ok, true);
  assert.equal(R.referencePath(repo, 'linear/home.png'), path.join(repo, 'design', 'references', 'linear', 'home.png'));
  assert.ok(fs.existsSync(path.join(repo, 'design', 'references', 'linear', 'home.png')));
  assert.ok(!fs.existsSync(path.join(repo, 'evil.txt')));
});

test('write confinement: a references folder that is a link (junction) is refused', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-research-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-research-outside-'));
  fs.mkdirSync(path.join(repo, 'design'));
  fs.symlinkSync(outside, path.join(repo, 'design', 'references'), 'junction');
  const res = R.writeReferenceFile(repo, 'linear/NOTES.md', 'x');
  assert.equal(res.ok, false);
  assert.match(res.error, /link/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

// ---- DESIGN.md: append-only ---------------------------------------------------------------

test('appendReferences: a dated section at the end of DESIGN.md, existing text kept byte for byte', () => {
  const repo = tempRepo({ 'DESIGN.md': '# Design\n\n## Features\n\n- board like Linear\n' });
  const before = readDesign(repo);
  const op = pack.appendReferences(['**Linear** - fast board', '  '], '2026-10-27');
  assert.equal(op.file, 'DESIGN.md');
  assert.equal(pack.applyWrite(repo, op).ok, true);
  const after = readDesign(repo);
  assert.ok(after.startsWith(before.trimEnd()), 'the old text is a prefix');
  assert.match(after, /## References \(research, 2026-10-27\)\n\n- \*\*Linear\*\* - fast board\n$/);
  assert.equal(pack.appendReferences([], '2026-10-27'), null);
  assert.equal(pack.appendReferences(['x'.repeat(pack.MAX_APPEND_CHARS + 1)]), null);
  assert.match(pack.appendReferences(['a'], 'not a date').update(''), /^## References \(research\)\n/);
});

// ---- one researcher pass ------------------------------------------------------------------

/** A fake `claude -p`: drops screenshots into the staging dir (its cwd) and answers `reply`. */
function fakeClaude(reply, calls = []) {
  return async (o) => {
    calls.push(o);
    fs.writeFileSync(path.join(o.cwd, 'linear-home.png'), PNG);
    fs.writeFileSync(path.join(o.cwd, 'fake.png'), 'not an image');
    return { stdout: JSON.stringify({ structured_output: reply, total_cost_usd: 0.4 }) };
  };
}

const linearEntry = (extra = {}) => ({
  slug: 'linear',
  summary: 'An issue tracker known for speed and keyboard flow.',
  strengths: ['Keyboard shortcuts everywhere', 'Instant search'],
  screens: [{ name: 'Board', description: 'Columns per state, drag to move' }],
  notes: 'Dense layout.\nMuted colors. <!-- injected -->',
  sources: ['https://linear.app/features', 'javascript:alert(1)'],
  screenshots: [
    { file: 'linear-home.png', caption: 'Home', source: 'https://linear.app' },
    { file: 'fake.png', caption: 'not an image', source: 'https://linear.app' },
    { file: '../outside.png', caption: 'escape', source: 'https://linear.app' },
  ],
  ...extra,
});

test('runResearch: NOTES.md with sources and screenshots, DESIGN.md summary appended, staging removed', async () => {
  const repo = tempRepo({ 'BRIEF.md': '# Brief\n\nA tracker.', 'DESIGN.md': '# Design\n\nBoard like Linear, with dates like Cron.\n' });
  // A real image right outside the staging dir: "../outside.png" must not reach the repo.
  fs.writeFileSync(path.join(os.tmpdir(), 'outside.png'), PNG);
  const before = readDesign(repo);
  const calls = [];
  const res = await R.runResearch({
    repoDir: repo,
    references: R.pendingReferences(repo),
    model: 'sonnet',
    now: () => START,
    runClaude: fakeClaude({
      references: [
        linearEntry(),
        // No source: dropped (cite sources or nothing).
        { slug: 'cron', summary: 's', strengths: [], screens: [], notes: '', sources: [], screenshots: [] },
        // Never asked for: dropped.
        { ...linearEntry(), slug: 'evil' },
      ],
    }, calls),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.written, ['linear']);
  assert.deepEqual(res.warnings.map((w) => [w.code, w.slug]), [['noSources', 'cron'], ['unknownSlug', 'evil']]);
  assert.equal(res.costUsd, 0.4);

  const notes = fs.readFileSync(notesPath(repo, 'linear'), 'utf8');
  assert.match(notes, /^# Linear - reference notes/);
  assert.match(notes, /Internal reference only/);
  assert.match(notes, /## Sources\n\n- https:\/\/linear\.app\/features\n/);
  assert.doesNotMatch(notes, /javascript:/);
  assert.doesNotMatch(notes, /injected -->/);
  assert.match(notes, /!\[Home\]\(linear-home\.png\) - source: https:\/\/linear\.app/);
  assert.deepEqual(fs.readdirSync(path.join(repo, 'design', 'references', 'linear')).sort(), ['NOTES.md', 'linear-home.png']);
  assert.ok(!fs.existsSync(path.join(repo, 'design', 'references', 'evil')));
  // Not identified with a source: a stub, so a restart does not pay for it again.
  assert.deepEqual(res.unidentified, ['cron']);
  assert.match(fs.readFileSync(notesPath(repo, 'cron'), 'utf8'), /could not identify/);

  const design = readDesign(repo);
  assert.ok(design.startsWith(before.trimEnd()), 'DESIGN.md was appended to, not rewritten');
  assert.match(design, /## References \(research, 2023-11-14\)\n\n- \*\*Linear\*\* - An issue tracker/);
  assert.doesNotMatch(design.slice(before.length), /Cron/, 'a stub is not summarised');
  // The summary's sources are not new references, and both slugs have notes now.
  assert.deepEqual(R.pendingReferences(repo), []);

  // The researcher ran outside the repo, in a staging dir that is gone now.
  assert.notEqual(calls[0].cwd, repo);
  assert.ok(!fs.existsSync(calls[0].cwd));
});

test('runResearch argv: web tools + browser screenshot only, no file or shell tools, no user MCP servers', () => {
  const args = R.buildResearchArgs({ model: 'sonnet', stagingDir: '/tmp/stage' });
  const val = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(val('--tools'), 'WebSearch,WebFetch');
  assert.deepEqual(val('--allowedTools').split(','), [...R.WEB_TOOLS, ...R.BROWSER_TOOLS]);
  for (const tool of ['Write', 'Edit', 'Bash', 'PowerShell', 'Read']) assert.ok(val('--disallowedTools').split(',').includes(tool), tool);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(val('--setting-sources'), '');
  const mcp = JSON.parse(val('--mcp-config'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['playwright']);
  assert.ok(mcp.mcpServers.playwright.args.includes('/tmp/stage'));
});

test('runResearch failure: a timeout or a bad reply writes nothing and resolves ok:false', async () => {
  const repo = tempRepo({ 'DESIGN.md': '# Design\n\nlike Linear\n' });
  const before = readDesign(repo);
  const refs = R.pendingReferences(repo);
  const timeout = await R.runResearch({ repoDir: repo, references: refs, runClaude: async () => ({ error: 'timeout' }) });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error, 'timeout');
  const bad = await R.runResearch({ repoDir: repo, references: refs, runClaude: async () => ({ stdout: 'not json' }) });
  assert.equal(bad.error, 'badJson');
  const thrown = await R.runResearch({
    repoDir: repo,
    references: refs,
    runClaude: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(thrown.error, 'failed');
  assert.equal((await R.runResearch({ repoDir: repo, references: [] })).error, 'noReferences');
  assert.equal((await R.runResearch({ repoDir: path.join(repo, 'missing'), references: refs })).error, 'noRepo');
  assert.equal(readDesign(repo), before);
  assert.ok(!fs.existsSync(notesPath(repo, 'linear')));
});

// ---- the controller seam --------------------------------------------------------------------

function fakeResearcher(calls, opts = {}) {
  return async (o) => {
    calls.push(o.references.map((r) => r.slug));
    if (opts.fail) return { ok: false, error: 'timeout' };
    for (const r of o.references) R.writeReferenceFile(o.repoDir, `${r.slug}/NOTES.md`, `# ${r.name}`);
    return { ok: true, written: o.references.map((r) => r.slug) };
  };
}

test('createResearchStep: runs on new references only, tries a failed one once, never throws', async () => {
  const repo = tempRepo({ 'DESIGN.md': '# Design\n\nlike Linear\n' });
  const calls = [];
  const log = { events: [], models: [] };
  const step = R.createResearchStep({
    research: fakeResearcher(calls),
    logEvent: (t) => log.events.push(t),
    logModel: (role, model, reason) => log.models.push({ role, model, reason }),
  });
  const run = { id: 'lw1', repoPath: repo, iteration: 1, models: {} };
  assert.equal((await step.beforeDirecting(run)).ok, true);
  assert.equal(await step.beforeDirecting(run), null, 'nothing new: no call');
  fs.appendFileSync(path.join(repo, 'design', 'DESIGN.md'), '\nCalendar like Cron.\n');
  await step.beforeDirecting(run);
  assert.deepEqual(calls, [['linear'], ['cron']]);
  assert.deepEqual(log.models.map((m) => [m.role, m.model]), [['researcher', 'sonnet'], ['researcher', 'sonnet']]);

  const failing = R.createResearchStep({
    research: async () => {
      throw new Error('down');
    },
    logEvent: (t) => log.events.push(t),
    logModel: () => {},
  });
  fs.appendFileSync(path.join(repo, 'design', 'DESIGN.md'), '\nNotes like Bear.\n');
  const res = await failing.beforeDirecting(run);
  assert.equal(res.ok, false);
  assert.match(log.events.at(-1), /research of Bear failed \(failed\) - the run went on without it: down/);
  assert.equal(await failing.beforeDirecting(run), null, 'a failed reference is not retried every lap');
  assert.equal(await R.createResearchStep({ logEvent() {}, logModel() {} }).beforeDirecting(run), null, 'no researcher dep');
});

// ---- the controller --------------------------------------------------------------------

function controller(repo, research) {
  const order = [];
  let todos = [];
  const ctl = createLunasWork({
    store: { load: () => null, save: () => true },
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => ({ id, repoPath: repo }),
    profileFor: () => ({ adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: 'npm test' }),
    packStatus: () => ({ complete: true, missing: [] }),
    godModeActive: () => false,
    godModeCheckCommand: () => 'npm test',
    todoStore: () => ({
      read: () => todos,
      write: (list) => {
        todos = list;
        return true;
      },
    }),
    research: async (o) => {
      order.push(`research ${o.iteration}`);
      return research(o);
    },
    director: async (o) => {
      order.push(`director ${o.iteration}`);
      // Iteration 1's Director (or Mati) adds a reference to DESIGN.md.
      if (o.iteration === 1) fs.appendFileSync(path.join(repo, 'design', 'DESIGN.md'), '\nDates like Cron.\n');
      return { ok: true, stop: o.iteration >= 2, cards: [], model: 'opus', modelReason: 'setting' };
    },
    build: async () => ({ ok: true, integration: { state: 'done', skipped: [] }, plan: { packages: [] } }),
    createAdapter: (name) => ({
      name,
      evidenceDir: path.join(repo, 'evidence'),
      start: async () => ({ url: 'http://localhost:3000' }),
      stop: async () => true,
      tools: () => ({}),
    }),
    playtest: async (o) => ({
      ok: true,
      mode: o.mode,
      model: 'sonnet',
      modelReason: 'exploratory pass',
      report: { findings: [], scores: [], journeys: [], screens: [] },
    }),
    shipGate: () => ({ allPassed: false }),
    critic: async () => ({
      ok: true,
      verdict: 'continue',
      model: 'sonnet',
      modelReason: 'regular iteration',
      milestone: { name: 'skeleton', passed: false, score: 50 },
      next: 'skeleton',
      allPassed: false,
    }),
    newRunId: () => 'lwres1',
    now: () => START,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  return { ctl, order };
}

async function settle(ctl) {
  for (let i = 0; i < 5; i += 1) await ctl.idle();
}

test('controller: research runs before the first Director, and again once DESIGN.md gains a reference', async () => {
  const repo = tempRepo({ 'BRIEF.md': '# Brief\n\nA tracker.\n', 'DESIGN.md': '# Design\n\nBoard like Linear.\n' });
  const calls = [];
  const { ctl, order } = controller(repo, fakeResearcher(calls));
  assert.equal((await ctl.start({ projectId: 'game' })).ok, true);
  await settle(ctl);
  assert.deepEqual(order, ['research 1', 'director 1', 'research 2', 'director 2']);
  assert.deepEqual(calls, [['linear'], ['cron']]);
  const researcher = ctl.runLog().filter((e) => e.kind === 'model' && e.role === 'researcher');
  assert.equal(researcher.length, 2);
  assert.match(researcher[0].reason, /researched Linear: 1 into design\/references\//);
});

test('controller: a failed research never blocks the run - the Director goes on, the report notes it', async () => {
  const repo = tempRepo({ 'DESIGN.md': '# Design\n\nBoard like Linear.\n' });
  const calls = [];
  const { ctl, order } = controller(repo, fakeResearcher(calls, { fail: true }));
  await ctl.start({ projectId: 'game' });
  await settle(ctl);
  assert.deepEqual(order.slice(0, 2), ['research 1', 'director 1']);
  // Iteration 2 only researches the new reference: the failed one is not retried.
  assert.deepEqual(calls, [['linear'], ['cron']]);
  const researcher = ctl.runLog().filter((e) => e.kind === 'model' && e.role === 'researcher');
  assert.match(researcher[0].reason, /research of Linear failed \(timeout\) - the run went on without it/);
});
