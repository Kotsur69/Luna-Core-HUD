// ============================================================================
// LunaCore - entry point for `node --test test/`
// ----------------------------------------------------------------------------
// Since Node 21 the arguments of `node --test` are glob patterns, and a pattern
// that names a directory (`test/`) is run as ONE module: node resolves the
// directory like require() does - package.json "main", then index.js - and
// without either fails with "Cannot find module '.../test'". God Mode verify
// commands are written by the planner and often say `node --test test/`, so
// this file gives the directory an entry that runs the real suite: a fresh
// `node --test` over every test file in test/, the same files `npm test` runs.
//
// `npm test` (`node --test`, default patterns) also runs this file, as a plain
// test file. Then argv[1] is this file, not the directory, and it does nothing.
// The env guard stops the nested run from ever starting another one.
// ============================================================================

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NESTED_GUARD = 'LUNACORE_TEST_DIR_ENTRY';
const TEST_FILES = 'test/**/*.test.{js,mjs,cjs}';
// Only the flags that pick WHICH tests run are passed on. The child's execArgv
// also holds node's expanded defaults (e.g. --test-timeout=0, --inspect-port),
// which must not reach the nested runner.
const SELECTION_FLAG_RE = /^--test-(?:name-pattern|skip-pattern|only)(?:=|$)/;

const ranAsDirectory = path.resolve(process.argv[1] || '') === __dirname;

if (ranAsDirectory && !process.env[NESTED_GUARD]) {
  // NODE_TEST_CONTEXT marks this process as a test-runner child; a nested
  // `node --test` that inherits it skips every file, so it is dropped.
  const { NODE_TEST_CONTEXT, ...inherited } = process.env;
  const flags = process.execArgv.filter((arg) => SELECTION_FLAG_RE.test(arg));
  const res = spawnSync(process.execPath, ['--test', ...flags, TEST_FILES], {
    cwd: path.dirname(__dirname),
    env: { ...inherited, [NESTED_GUARD]: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (res.error) process.stderr.write(`node --test test/: could not start the suite: ${res.error.message}\n`);
  process.exitCode = typeof res.status === 'number' ? res.status : 1;
}
