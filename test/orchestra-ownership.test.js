// ============================================================================
// LW 2.12: the file ownership map fed to God Mode's live overlap guard. With
// makePlan's optional ctx.ownership, a worker that edits a file another
// package owns is told to revert it on its FIRST touch - before the owner's
// worker clashes with it. Pure rules first (src/ownership.js and the
// supervisor), then the controller with tabs, git and disk faked. The
// default path without a map is pinned in orchestra-hooks-default.test.js.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const own = require('../src/ownership.js');
const sup = require('../src/orchestraSupervisor.js');
const { createOrchestra } = require('../src/orchestra.js');

// ---- pure: paths and globs ---------------------------------------------------

test('normalizeOwnedPath keeps repo-relative paths and refuses anything outside the repo', () => {
  assert.equal(own.normalizeOwnedPath('src/quote.js'), 'src/quote.js');
  assert.equal(own.normalizeOwnedPath('./src//quote.js'), 'src/quote.js');
  assert.equal(own.normalizeOwnedPath('src\\quote\\total.js'), 'src/quote/total.js');
  assert.equal(own.normalizeOwnedPath('src/quote/'), 'src/quote/**', 'a folder owns everything under it');
  assert.equal(own.normalizeOwnedPath('src/**/*.test.js'), 'src/**/*.test.js');
  for (const bad of ['/etc/passwd', 'C:\\Windows\\x', 'c:/x', '\\\\server\\share\\x', '~/x', '../outside.js',
    'src/../../x', '', '   ', '.', 'a\nb', 42, null, 'x'.repeat(own.MAX_OWNED_PATH_CHARS + 1)]) {
    assert.equal(own.normalizeOwnedPath(bad), null, JSON.stringify(bad));
  }
});

test('ownerOf: exact path beats a glob, the longer glob beats the shorter one', () => {
  const map = own.compileOwnership({ 'src/**': 'a', 'src/quote/**': 'b', 'src/quote/total.js': 'c', '*.md': 'd' });
  assert.equal(own.ownerOf('src/app.js', map), 'a');
  assert.equal(own.ownerOf('src/quote/tax.js', map), 'b');
  assert.equal(own.ownerOf('src/quote/total.js', map), 'c');
  assert.equal(own.ownerOf('README.md', map), 'd');
  assert.equal(own.ownerOf('docs/README.md', map), null, '* never crosses a folder');
  assert.equal(own.ownerOf('package.json', map), null, 'unowned');
  assert.equal(own.ownerOf('src/app.js', null), null);
});

test('normalizeOwnedPath refuses whole-repo globs and markdown-breaking characters; collapses **', () => {
  for (const bad of ['**', '*', '**/*', './**/', '?', 'src/`x`.js', 'src/a|b.js', 'src/<x>.js']) {
    assert.equal(own.normalizeOwnedPath(bad), null, bad);
  }
  assert.equal(own.normalizeOwnedPath('src/**/**/x.js'), 'src/**/x.js');
  assert.equal(own.normalizeOwnedPath('**/*.test.js'), '**/*.test.js');
});

test('a plain folder path owns everything under it; matching ignores letter case', () => {
  const map = own.compileOwnership({ 'src/quote': 'a', 'Src/PDF.js': 'b' });
  assert.equal(own.ownerOf('src/quote/total.js', map), 'a');
  assert.equal(own.ownerOf('src/quote', map), 'a');
  assert.equal(own.ownerOf('src/quoter.js', map), null, 'a prefix is not a folder');
  assert.equal(own.ownerOf('src/pdf.js', map), 'b');
  assert.equal(own.ownerOf('SRC/Quote/x.js', map), 'a');
  assert.equal(own.compileOwnership({ 'src/a.js': 'a', 'SRC/A.js': 'b' }).length, 1, 'same file twice');
});

test('** spans folders, * and ? stay inside one segment', () => {
  const map = own.compileOwnership({ 'src/**/test/*.js': 'a', 'docs/?.md': 'b', '**/*.css': 'c' });
  assert.equal(own.ownerOf('src/test/x.js', map), 'a');
  assert.equal(own.ownerOf('src/a/b/test/x.js', map), 'a');
  assert.equal(own.ownerOf('src/test/sub/x.js', map), null);
  assert.equal(own.ownerOf('docs/a.md', map), 'b');
  assert.equal(own.ownerOf('docs/ab.md', map), null);
  assert.equal(own.ownerOf('app.css', map), 'c');
  assert.equal(own.ownerOf('ui/deep/app.css', map), 'c');
});

test('hostile globs match in linear-ish time (no regex backtracking)', () => {
  const evil = `${'*a'.repeat(40)}*b`;
  const deep = `${'**/'.repeat(40)}x`;
  const map = own.compileOwnership({ [evil]: 'a', [deep]: 'b' });
  assert.ok(map, 'still valid paths');
  const started = Date.now();
  for (let i = 0; i < 50; i += 1) {
    assert.equal(own.ownerOf('a'.repeat(250), map), null);
    assert.equal(own.ownerOf(`${'d/'.repeat(120)}y`, map), null);
  }
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('compileOwnership is lenient: bad entries dropped, card ids become text, first owner wins', () => {
  const map = own.compileOwnership([
    { path: 'src/a.js', owner: 12 },
    { path: '../x.js', owner: 'a' },
    { path: 'src/b.js', owner: '' },
    { path: 'src/a.js', owner: 13 },
    'junk',
  ]);
  assert.deepEqual(map.map((e) => [e.path, e.owner]), [['src/a.js', '12']]);
  assert.equal(own.compileOwnership({}), null);
  assert.equal(own.compileOwnership('nope'), null);
});

// ---- pure: supervisor ----------------------------------------------------------

const P = (id, todoAts) => ({ id, todoAts, state: 'launched', dependsOn: [], touched: [] });

test('normalizeOwnership: plain JSON-safe entries, null when unset', () => {
  assert.equal(sup.normalizeOwnership(undefined), null);
  assert.equal(sup.normalizeOwnership(null), null);
  assert.equal(sup.normalizeOwnership({ '/abs': 'a' }), null);
  assert.deepEqual(sup.normalizeOwnership({ 'src/a/': 1 }), [{ path: 'src/a/**', owner: '1' }]);
});

test('ownershipViolations: only files another package of the run owns', () => {
  const packages = [P('a', [1]), P('b', [2, 3])];
  // Owners by package id and by card `at` (Luna's Work maps cards, the planner makes packages).
  const map = sup.normalizeOwnership({ 'src/a/**': 'a', 'src/b/**': 2, 'src/c.js': 3, 'src/z.js': 99 });
  assert.deepEqual(sup.ownershipViolations(packages[0], ['src/a/x.js', 'src/b/y.js', 'src/c.js', 'src/z.js', 'free.js'], map, packages), [
    { file: 'src/b/y.js', owner: 'b' },
    { file: 'src/c.js', owner: 'b' },
  ]);
  assert.deepEqual(sup.ownershipViolations(packages[1], ['src/b/y.js', 'src/c.js'], map, packages), [], 'own files');
  assert.deepEqual(sup.ownershipViolations(packages[0], ['src/b/y.js'], null, packages), [], 'no map, no guard');
});

test('ownershipText names the files, their owner and this package\'s marker', () => {
  const text = sup.ownershipText('a', [{ file: 'src/b/y.js', owner: 'b' }]);
  assert.match(text, /src\/b\/y\.js \(owned by package b\)/);
  assert.match(text, /Revert/);
  assert.match(text, /LUNA_DONE a/);
});

test('a stored plan keeps its ownership map; a plan without one gets no key', () => {
  const stored = {
    id: 'p1',
    repoPath: path.resolve('/repo'),
    packages: [{ id: 'a', title: 'A', todoAts: [1], prompt: 'x', files: [], dependsOn: [], verify: 'npm test', model: 'sonnet', state: 'pending' }],
  };
  assert.equal('ownership' in sup.normalizeStoredPlan(stored), false);
  const withMap = sup.normalizeStoredPlan({ ...stored, ownership: [{ path: 'src/**', owner: 'a' }, { path: '/x', owner: 'a' }] });
  assert.deepEqual(withMap.ownership, [{ path: 'src/**', owner: 'a' }]);
});

// ---- controller ----------------------------------------------------------------

const pkg = (id, todoAts) => ({ id, title: `T ${id}`, todoAts, prompt: `do ${id}`, files: [], dependsOn: [], verify: 'npm test', model: 'sonnet' });
const TODOS = [
  { at: 1, text: 'quote screen', done: false },
  { at: 2, text: 'pdf export', done: false },
];

async function started(planCtx = {}) {
  let seq = 0;
  const log = { events: [], pty: [], saved: null, roots: [] };
  const alive = new Set();
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => TODOS,
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => ({ ok: true, raw: { packages: [pkg('a', [1]), pkg('b', [2])], notes: '' }, costUsd: 0 }),
    addWorktree: async (_repo, name) => {
      const root = path.join(path.resolve('/wt'), name);
      log.roots.push(root);
      return { ok: true, root, cwd: root, branch: `luna/${name}` };
    },
    headSha: async () => 'base0000',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: () => {
      seq += 1;
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    sessionAlive: (id) => alive.has(id),
    writePty: (id, text) => {
      log.pty.push([id, text]);
      return alive.has(id);
    },
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}5678aaa`, files: [] }),
    createPr: async () => ({ ok: true, url: 'https://github.com/o/r/pull/1' }),
    removeWorktree: async () => ({ ok: true }),
    sleep: async () => {},
    saveState: (state) => {
      log.saved = state;
    },
    onRunEvent: (kind, payload) => log.events.push([kind, payload]),
  });
  const res = await orch.makePlan({ projectId: 'p1', repoPath: '/repo', profileId: 'cloud', env: {}, ...planCtx });
  assert.equal(res.ok, true);
  await orch.launch({ planId: res.plan.id });
  assert.equal(log.roots.length, 2, 'both workers launched');
  return { orch, log };
}

const stops = (log) => log.pty.filter(([, text]) => /^STOP:/.test(text));

test('with a map, a worker touching a file another package owns is stopped on its first touch', async () => {
  // Owners are card ids, as runDirector returns them.
  const s = await started({ ownership: { 'src/quote/**': 1, 'src/export/**': 2 } });
  const [ra] = s.log.roots;
  s.orch.onFiles('s1', [path.join(ra, 'src', 'quote', 'screen.js')]);
  assert.equal(stops(s.log).length, 0, 'own file: no stop');

  // a edits b's file before b has touched it: no overlap yet, but a stop already.
  s.orch.onFiles('s1', [path.join(ra, 'src', 'quote', 'screen.js'), path.join(ra, 'src', 'export', 'pdf.js')]);
  assert.equal(s.orch.view().overlaps.length, 0);
  const sent = stops(s.log);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 's1');
  assert.match(sent[0][1], /src\/export\/pdf\.js \(owned by package b\)/);
  const events = s.log.events.filter(([k]) => k === 'ownership');
  assert.deepEqual(events.map(([, p]) => p), [{ id: 'a', files: [{ file: 'src/export/pdf.js', owner: 'b' }], nudged: true }]);

  // The same file again is not repeated; a new foreign file is.
  s.orch.onFiles('s1', [path.join(ra, 'src', 'export', 'pdf.js'), path.join(ra, 'src', 'quote', 'more.js')]);
  assert.equal(stops(s.log).length, 1);
  s.orch.onFiles('s1', [path.join(ra, 'src', 'export', 'csv.js')]);
  assert.equal(stops(s.log).length, 2);
  assert.match(stops(s.log)[1][1], /csv\.js/);
  assert.doesNotMatch(stops(s.log)[1][1], /pdf\.js/);
});

test('the map is saved with the plan and package ids work as owners too', async () => {
  const s = await started({ ownership: [{ path: 'docs/', owner: 'b' }] });
  assert.deepEqual(s.log.saved.ownership, [{ path: 'docs/**', owner: 'b' }]);
  s.orch.onFiles('s1', [path.join(s.log.roots[0], 'docs', 'x.md')]);
  assert.equal(stops(s.log).length, 1);
});

test('an unusable map is no map: no stop, no ownership key', async () => {
  const s = await started({ ownership: { '../escape.js': 'b', '/abs/x.js': 'b' } });
  assert.equal('ownership' in s.log.saved, false);
  s.orch.onFiles('s1', [path.join(s.log.roots[0], 'src', 'export', 'pdf.js')]);
  assert.equal(stops(s.log).length, 0);
  assert.equal(s.log.events.filter(([k]) => k === 'ownership').length, 0);
});
