// ============================================================================
// Machine-specific paths (docs/done_docs/DONE_PATH_AUDIT.md): two PCs, two user names
// (Kotsur69 / mmazur), cloud-synced config. Every check runs on injected
// exists/isDir fns, so nothing depends on this machine's disk.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const { resolveStoredPath, checkCwd, toPortablePath } = require('../src/projects');
const { localPaths, portableRepoList, readRepoStatus } = require('../src/gitstation');
const { rehomePlanPaths } = require('../src/orchestraSupervisor');
const { runPlanner } = require('../src/orchestraPlan');
const { finishPackage } = require('../src/orchestraFinish');
const integ = require('../src/orchestraIntegrate');
const { resolveScript } = require('../src/keepawake');

const HOME = 'C:\\Users\\Kotsur69';
const OTHER = 'C:\\Users\\mmazur\\source\\repos\\synthara';
const HERE = path.normalize('C:\\Users\\Kotsur69\\source\\repos\\synthara');
const onlyHere = (p) => path.normalize(p).toLowerCase() === HERE.toLowerCase();
const nowhere = () => false;

// --- re-home on read ---------------------------------------------------------------

test('resolveStoredPath keeps an existing path, re-homes another user, expands ~', { skip: process.platform !== 'win32' }, () => {
  assert.equal(resolveStoredPath(HERE, onlyHere, HOME), HERE);
  assert.equal(resolveStoredPath(OTHER, onlyHere, HOME), HERE);
  assert.equal(resolveStoredPath('~\\source\\repos\\synthara', onlyHere, HOME), HERE);
  // Neither exists: the expanded original comes back, for an honest "missing".
  assert.equal(resolveStoredPath(OTHER, nowhere, HOME), path.normalize(OTHER));
  assert.equal(resolveStoredPath('', onlyHere, HOME), null);
  assert.equal(resolveStoredPath(null, onlyHere, HOME), null);
});

test('git station: stored repos re-home on load and are written home-relative', { skip: process.platform !== 'win32' }, () => {
  assert.deepEqual(localPaths([OTHER, HERE, 7, ''], onlyHere, HOME), [HERE]);
  const body = portableRepoList([HERE, HERE], [path.join(HOME, 'source', 'repos')], HOME);
  assert.deepEqual(body.repos, ['~\\source\\repos\\synthara']);
  assert.deepEqual(body.roots, ['~\\source\\repos']);
  assert.equal(toPortablePath('D:\\work\\x', HOME), 'D:\\work\\x', 'outside the home stays absolute');
});

test('a restored God Mode run has its repo, worktrees and briefs re-homed', { skip: process.platform !== 'win32' }, () => {
  const plan = {
    repoPath: OTHER,
    packages: [{ id: 'a', root: `${OTHER}-wt`, cwd: `${OTHER}-wt`, briefPath: 'C:\\Users\\mmazur\\AppData\\b.md' }, { id: 'b', root: null, cwd: null, briefPath: null }],
  };
  const exists = (p) => onlyHere(p) || path.normalize(p).toLowerCase() === `${HERE}-wt`.toLowerCase();
  const resolve = (p) => resolveStoredPath(p, exists, HOME);
  const out = rehomePlanPaths(plan, resolve, (p) => resolveStoredPath(p, () => true, HOME));
  assert.equal(out.repoPath, HERE);
  assert.equal(out.packages[0].root, `${HERE}-wt`);
  assert.equal(out.packages[0].briefPath, path.normalize('C:\\Users\\mmazur\\AppData\\b.md'));
  assert.equal(out.packages[1].root, null);
  assert.equal(plan.repoPath, OTHER, 'input untouched');
});

test('keep-awake script: ~ and another user home both resolve, junk stays refused', { skip: process.platform !== 'win32' }, () => {
  const bat = path.normalize('C:\\Users\\Kotsur69\\Tools\\Keep Awake.bat');
  const exists = (p) => path.normalize(p).toLowerCase() === bat.toLowerCase();
  assert.deepEqual(resolveScript({ script: 'C:\\Users\\mmazur\\Tools\\Keep Awake.bat' }, exists, HOME), { ok: true, script: bat });
  assert.deepEqual(resolveScript({ script: '~\\Tools\\Keep Awake.bat' }, exists, HOME), { ok: true, script: bat });
  assert.equal(resolveScript({ script: 'C:\\Users\\mmazur\\x.bat' }, exists, HOME).reason, 'missing');
  assert.equal(resolveScript({ script: 'C:\\a&b.bat' }, exists, HOME).reason, 'invalid-path');
});

// --- cwd checked before a spawn ------------------------------------------------------

test('checkCwd reports a missing folder as missingCwd', () => {
  assert.deepEqual(checkCwd('C:\\x', () => true), { ok: true });
  assert.deepEqual(checkCwd('C:\\x', () => false), { ok: false, error: 'missingCwd', detail: 'C:\\x' });
  assert.equal(checkCwd(undefined, () => true).ok, false);
});

test('runPlanner: a missing repo folder is noRepo, never "claude not found"', async () => {
  let spawned = false;
  const execImpl = () => { spawned = true; };
  const res = await runPlanner({ cwd: 'C:\\gone', env: {}, openTodos: [], execImpl, isDirImpl: () => false });
  assert.equal(res.error, 'noRepo');
  assert.equal(spawned, false);
});

test('createPr / resolver / finishPackage refuse a missing folder before spawning', async () => {
  let spawned = 0;
  const execImpl = (...args) => { spawned += 1; args[args.length - 1](null, '', ''); };
  const pr = await integ.createPr({ repoPath: 'C:\\gone', base: 'main', branch: 'luna/a', title: 't', body: '', isDirImpl: () => false }, execImpl);
  assert.equal(pr.error, 'missingCwd');
  const fin = await finishPackage({ id: 'a', root: 'C:\\gone', branch: 'luna/a', verify: 'npm test' }, { execImpl, isDirImpl: () => false });
  assert.equal(fin.ok, false);
  assert.match(fin.detail, /worktree folder missing/);
  assert.equal(spawned, 0);
});

test('git station row for a folder that is not on this PC says missingDir', async () => {
  const row = await readRepoStatus(path.join(__dirname, 'no-such-repo-folder-xyz'));
  assert.equal(row.error, 'missingDir');
});

// --- the audit itself: no literal user home in shipped code or config -----------------

const HOME_RE = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`]+|\/Users\/[^/\s'"`]+|\/home\/[^/\s'"`]+|Kotsur69|mmazur/;
const ALLOWED = [/REPO_OWNER = 'Kotsur69'/]; // the GitHub owner the updater reads releases from
const AUDITED_DIRS = ['src', 'config', 'scripts'];
const AUDITED_EXT = /\.(js|mjs|cjs|json|ps1|sh|bat)$/;

/** True for a file the audit judges: shipped code or config, never a *.local.json. */
function isAudited(rel) {
  const posix = rel.replace(/\\/g, '/');
  return AUDITED_DIRS.some((d) => posix.startsWith(`${d}/`)) && AUDITED_EXT.test(posix) && !/\.local\.json$/.test(posix);
}

/** `file:line` for every code line of `text` that names a user home. */
function homePathHits(rel, text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    if (HOME_RE.test(code) && !ALLOWED.some((re) => re.test(code))) hits.push(`${rel}:${i + 1}`);
  });
  return hits;
}

/**
 * The files git tracks under the audited dirs. Runtime output (config/runs/
 * Luna's Work artifacts, logs, caches) is gitignored, never shipped, and may
 * hold absolute paths of this PC - the audit must not judge it.
 * Returns null when git is not usable here (e.g. a source tarball).
 */
function trackedFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...AUDITED_DIRS], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const files = out.split('\0').filter(Boolean);
    return files.length ? files : null;
  } catch {
    return null;
  }
}

/** Fallback without git: walk the audited dirs, skipping known runtime output. */
function walkedFiles(root) {
  const RUNTIME_DIRS = new Set(['config/runs', 'node_modules']);
  const files = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(root, rel))) {
      const child = `${rel}/${name}`;
      if (fs.statSync(path.join(root, child)).isDirectory()) {
        if (!RUNTIME_DIRS.has(child) && name !== 'node_modules') walk(child);
      } else {
        files.push(child);
      }
    }
  };
  for (const d of AUDITED_DIRS) if (fs.existsSync(path.join(root, d))) walk(d);
  return files;
}

test('no literal user-home path in tracked src/ (outside comments), config/ or scripts/', () => {
  const root = path.join(__dirname, '..');
  const files = (trackedFiles(root) || walkedFiles(root)).filter(isAudited);
  assert.ok(files.length > 50, 'the audit found its files');
  const hits = [];
  for (const rel of files) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue; // tracked but deleted in the working tree
    hits.push(...homePathHits(rel, fs.readFileSync(full, 'utf8')));
  }
  assert.deepEqual(hits, []);
});

test('the audit skips runtime output and still catches a home path in tracked code or config', () => {
  // Luna's Work run artifacts are gitignored, so git never lists them.
  const tracked = trackedFiles(path.join(__dirname, '..'));
  if (tracked) assert.deepEqual(tracked.filter((f) => f.startsWith('config/runs/')), []);
  assert.equal(isAudited('src/main.js'), true);
  assert.equal(isAudited('config\\themes.json'), true);
  assert.equal(isAudited('config/lunaswork.local.json'), false);
  assert.equal(isAudited('docs/notes.json'), false);
  assert.equal(isAudited('src/readme.md'), false);

  assert.deepEqual(homePathHits('src/x.js', "const a = 1;\nconst p = 'C:\\\\Users\\\\someone\\\\repo';"), ['src/x.js:2']);
  assert.deepEqual(homePathHits('config/x.json', '{\n  "shot": "/home/someone/shot.png"\n}'), ['config/x.json:2']);
  assert.deepEqual(homePathHits('src/x.js', "// lives in C:\\Users\\someone\nconst REPO_OWNER = 'Kotsur69';"), []);
});
