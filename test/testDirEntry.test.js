// test/index.js makes `node --test test/` (a directory argument, which Node 21+
// runs as one module) run the real suite. Each case builds a throwaway project
// with a copy of that entry and a few test files, then runs node on it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENTRY = path.join(__dirname, 'index.js');

/** A temp project: test/index.js (the real entry) plus the given test files. */
function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-testdir-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  fs.mkdirSync(path.join(root, 'test'));
  fs.copyFileSync(ENTRY, path.join(root, 'test', 'index.js'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, 'test', name), body);
  return root;
}

/** Runs node in `cwd` outside this file's own test-runner context. */
function node(cwd, args) {
  const { NODE_TEST_CONTEXT, LUNACORE_TEST_DIR_ENTRY, ...env } = process.env;
  const res = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true });
  return { status: res.status, output: `${res.stdout}\n${res.stderr}` };
}

const PASSING = "require('node:test')('inner passing test', () => {});\n";
const ESM_PASSING = "import test from 'node:test';\ntest('inner esm test', () => {});\n";
const FAILING = "require('node:test')('inner failing test', () => { throw new Error('inner boom'); });\n";

test('node --test test/ runs every test file in the folder and passes when they pass', (t) => {
  const root = project(t, { 'ok.test.js': PASSING, 'esm.test.mjs': ESM_PASSING });
  const res = node(root, ['--test', 'test/']);
  assert.equal(res.status, 0, res.output);
  assert.match(res.output, /inner passing test/);
  assert.match(res.output, /inner esm test/);
  assert.doesNotMatch(res.output, /Cannot find module/);
});

test('node --test test/ fails, with the real error in the output, when a test in the folder fails', (t) => {
  const root = project(t, { 'ok.test.js': PASSING, 'bad.test.js': FAILING });
  const res = node(root, ['--test', 'test/']);
  assert.notEqual(res.status, 0, res.output);
  assert.match(res.output, /inner failing test/);
  assert.match(res.output, /inner boom/);
});

test('node --test passes a name pattern on to the inner run', (t) => {
  const root = project(t, { 'ok.test.js': PASSING, 'bad.test.js': FAILING });
  const res = node(root, ['--test', '--test-name-pattern=inner passing', 'test/']);
  assert.equal(res.status, 0, res.output);
  assert.doesNotMatch(res.output, /inner boom/);
});

test('test/index.js run as a plain file (how npm test meets it) does nothing', (t) => {
  const root = project(t, { 'bad.test.js': FAILING });
  const res = node(root, [path.join('test', 'index.js')]);
  assert.equal(res.status, 0, res.output);
  assert.doesNotMatch(res.output, /inner/);
});
