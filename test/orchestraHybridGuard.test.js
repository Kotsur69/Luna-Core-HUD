// ============================================================================
// Free God Mode v2 Slice F6b: the hybrid guard (src/orchestraHybridGuard.js).
// A package the planner marked "free" is moved to Sonnet, with reasons for
// the board, when it lists 0 or >2 files, touches a protected path, or has no
// acceptance test / verify. The protected list loads like cheatsheets /
// prompts / layouts / themes: broken file -> built-in defaults, never a crash.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('../src/orchestraHybridGuard.js');

const free = (files, extra = {}) => ({ id: 'p', title: 'P', prompt: 'do it', files, verify: 'npm test', model: 'free', ...extra });
const codes = (pkg, rules) => guard.guardReasons(pkg, rules).map((r) => r.code);

// ---- file count --------------------------------------------------------------

test('file count: 0 files -> noFiles; 1 and 2 stay free; 3 -> tooManyFiles', () => {
  assert.deepEqual(codes(free([])), ['noFiles']);
  assert.deepEqual(codes(free(undefined)), ['noFiles']);
  assert.deepEqual(codes(free(['src/renderer/styles.css'])), []);
  assert.deepEqual(codes(free(['src/renderer/styles.css', 'src/renderer/i18n.js'])), []);
  const three = guard.guardReasons(free(['a.css', 'b.css', 'c.css']));
  assert.deepEqual(three, [{ code: 'tooManyFiles', n: 3 }]);
});

test('blank file entries do not count', () => {
  assert.deepEqual(codes(free(['', '   '])), ['noFiles']);
});

// ---- protected paths -----------------------------------------------------------

const PROTECTED_CASES = [
  ['entry', 'src/main.js'],
  ['preload', 'src/preload.js'],
  ['ipc', 'src/orchestraIpc.js'],
  ['ipc', 'src/ipc/handlers.js'],
  ['secrets', 'src/auth/session.js'],
  ['secrets', 'config/.env.local'],
  ['secrets', 'src/claudeSecrets.js'],
  ['secrets', 'keys/deploy.pem'],
  ['migrations', 'supabase/migrations/001_init.sql'],
  ['dependencies', 'package.json'],
  ['dependencies', 'package-lock.json'],
  ['dependencies', 'web/yarn.lock'],
  ['build', 'electron-builder.yml'],
  ['build', 'vite.config.ts'],
  ['build', 'scripts/release.js'],
  ['ci', '.github/workflows/test.yml'],
  ['tests', 'test/helpers/fakeGit.js'],
  ['tests', 'jest.config.js'],
];

for (const [kind, file] of PROTECTED_CASES) {
  test(`protected ${kind}: ${file} moves the package to Sonnet`, () => {
    const reasons = guard.guardReasons(free([file]));
    assert.deepEqual(reasons, [{ code: 'protected', kind, file }]);
  });
}

test('protected match ignores case, backslashes, ./ and planner annotations', () => {
  assert.equal(guard.protectedKindOf('SRC\\Main.js', guard.compileRules()), 'entry');
  assert.equal(guard.protectedKindOf('./src/preload.js:120', guard.compileRules()), 'preload');
  assert.equal(guard.protectedKindOf('package.json - bump version', guard.compileRules()), 'dependencies');
});

test('a path outside the repo is never a small local change', () => {
  assert.equal(guard.protectedKindOf('../other/app.css', guard.compileRules()), 'outside');
  assert.equal(guard.protectedKindOf('C:/Windows/x.css', guard.compileRules()), 'outside');
});

test('ordinary UI files are not protected', () => {
  for (const f of ['src/renderer/styles.css', 'src/renderer/i18n.js', 'config/themes/dark.json', 'README.md']) {
    assert.equal(guard.protectedKindOf(f, guard.compileRules()), null, f);
  }
});

// ---- verify ---------------------------------------------------------------------

test('missing verify -> noVerify; a plan acceptance test counts as verify', () => {
  assert.deepEqual(codes(free(['a.css'], { verify: '' })), ['noVerify']);
  assert.deepEqual(codes(free(['a.css'], { verify: '   ' })), ['noVerify']);
  assert.deepEqual(codes(free(['a.css'], { verify: '', prompt: 'Do x.\nAcceptance test: the header is red.' })), []);
});

test('every reason is listed at once', () => {
  const reasons = guard.guardReasons(free(['src/main.js', 'a.css', 'b.css'], { verify: '' }));
  assert.deepEqual(reasons.map((r) => r.code), ['tooManyFiles', 'protected', 'noVerify']);
});

// ---- applyHybridGuard -------------------------------------------------------------

test('applyHybridGuard: upgrades only offending free packages, others untouched', () => {
  const ok = free(['src/renderer/styles.css']);
  const bad = free(['src/preload.js'], { id: 'bad' });
  const sonnet = { ...free(['a.js', 'b.js', 'c.js']), id: 's', model: 'sonnet' };
  const out = guard.applyHybridGuard([ok, bad, sonnet]);
  assert.equal(out[0], ok, 'a clean free package is returned as it was');
  assert.equal(out[2], sonnet, 'a Claude package is never touched');
  assert.equal(out[1].model, 'sonnet');
  assert.deepEqual(out[1].hybridGuard, { from: 'free', reasons: [{ code: 'protected', kind: 'preload', file: 'src/preload.js' }] });
  assert.equal(bad.model, 'free', 'the input is not mutated');
});

// ---- config file + repo extension ---------------------------------------------------

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hybrid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

test('shipped config/hybrid-protected.json matches the built-in defaults', () => {
  const shipped = guard.normalizeProtected(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'hybrid-protected.json'), 'utf8')));
  assert.deepEqual(shipped, guard.DEFAULT_PROTECTED.map((e) => ({ kind: e.kind, patterns: [...e.patterns] })));
  assert.deepEqual(guard.loadProtected(), shipped);
});

test('repo extension: .lunacore/hybrid-protected.json adds paths and kinds, never removes', (t) => {
  const repo = tmpDir(t);
  fs.mkdirSync(path.join(repo, '.lunacore'));
  fs.writeFileSync(path.join(repo, guard.REPO_FILE), JSON.stringify({
    protected: [
      { kind: 'payments', patterns: ['src/billing/**'] },
      { kind: 'entry', patterns: ['src/server.js'] },
    ],
  }));
  const rules = guard.loadProtected({ repoPath: repo });
  assert.deepEqual(codes(free(['src/billing/stripe.js']), rules), ['protected']);
  assert.equal(guard.guardReasons(free(['src/billing/stripe.js']), rules)[0].kind, 'payments');
  assert.equal(guard.guardReasons(free(['src/server.js']), rules)[0].kind, 'entry');
  assert.equal(guard.guardReasons(free(['src/main.js']), rules)[0].kind, 'entry', 'the default stays');
  // Another repo without the file gets the shipped list only.
  assert.deepEqual(codes(free(['src/billing/stripe.js']), guard.loadProtected({ repoPath: tmpDir(t) })), []);
});

test('broken shipped config -> built-in defaults, never a crash', (t) => {
  const dir = tmpDir(t);
  const bad = path.join(dir, 'hybrid-protected.json');
  const defaults = guard.DEFAULT_PROTECTED.map((e) => ({ kind: e.kind, patterns: [...e.patterns] }));
  for (const text of ['{ not json', '[]', '{"protected": "nope"}', '{"protected": [{"kind": "BAD KIND", "patterns": ["x"]}]}', '']) {
    fs.writeFileSync(bad, text);
    assert.deepEqual(guard.loadProtected({ baseFile: bad }), defaults, JSON.stringify(text));
  }
  assert.deepEqual(guard.loadProtected({ baseFile: path.join(dir, 'missing.json') }), defaults);
  assert.deepEqual(guard.loadProtected({ baseFile: dir }), defaults, 'a folder is not a config file');
  const throwing = () => { throw new Error('EACCES'); };
  assert.deepEqual(guard.loadProtected({ readImpl: throwing, repoPath: dir }), defaults);
});

test('broken repo file is ignored; the shipped list still applies', (t) => {
  const repo = tmpDir(t);
  fs.mkdirSync(path.join(repo, '.lunacore'));
  fs.writeFileSync(path.join(repo, guard.REPO_FILE), '{ "protected": [ broken');
  const rules = guard.loadProtected({ repoPath: repo });
  assert.equal(guard.guardReasons(free(['package.json']), rules)[0].kind, 'dependencies');
});

test('off-shape entries and patterns are dropped at the boundary', () => {
  const out = guard.normalizeProtected({
    protected: [
      { kind: 'ok', patterns: ['a/**', 7, '', 'x'.repeat(500), 'b\0c'] },
      { kind: 'empty', patterns: [] },
      null,
      'str',
    ],
  });
  assert.deepEqual(out, [{ kind: 'ok', patterns: ['a/**'] }]);
});

test('an unusable rule list falls back to the defaults', () => {
  assert.deepEqual(codes(free(['src/main.js']), []), ['protected']);
  assert.deepEqual(codes(free(['src/main.js']), null), ['protected']);
});
