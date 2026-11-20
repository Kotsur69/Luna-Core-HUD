// Packaging guard: per-PC files (*.local.json, *.local.md) and God Mode run
// data (config/runs/) must never ship in the public installer. An earlier
// build.files rule excluded only config/*.local.json at the top level, so
// config/orchestra/*.local.json was packed. These tests read package.json
// build.files and evaluate it against sample paths, so narrowing a glob again
// fails here instead of leaking into a release.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PACKAGE_JSON = path.join(__dirname, '..', 'package.json');

const REQUIRED_EXCLUSIONS = [
  '!config/**/*.local.json',
  '!config/**/*.local.md',
  '!config/runs/**',
];

function readBuildFiles() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const files = pkg && pkg.build && pkg.build.files;
  assert.ok(Array.isArray(files), 'package.json build.files must be an array');
  return files;
}

// electron-builder evaluates file patterns in order and the last pattern that
// matches a path decides: a plain pattern includes it, a "!" pattern excludes it.
function isPacked(relPath, patterns) {
  let packed = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    if (path.posix.matchesGlob(relPath, glob)) packed = !negated;
  }
  return packed;
}

test('build.files keeps the recursive exclusions for local files and run data', () => {
  const files = readBuildFiles();
  for (const exclusion of REQUIRED_EXCLUSIONS) {
    assert.ok(files.includes(exclusion), `build.files is missing ${exclusion}`);
  }
});

test('nested and top-level *.local.json / *.local.md files are not packed', () => {
  const files = readBuildFiles();
  const leaked = [
    'config/claude-accounts.local.json',
    'config/orchestra/foo.local.json',
    'config/orchestra/deep/nested/bar.local.json',
    'config/notes.local.md',
    'config/orchestra/handoff.local.md',
    'config/runs/2026-11-20/state.json',
    'config/runs/run-1/log.md',
  ].filter((p) => isPacked(p, files));
  assert.deepEqual(leaked, [], `these private paths would be packed: ${leaked.join(', ')}`);
});

test('shared config files are still packed', () => {
  const files = readBuildFiles();
  for (const p of ['config/prompts.json', 'config/orchestra/workers.json']) {
    assert.equal(isPacked(p, files), true, `${p} should be packed`);
  }
});

test('the evaluator catches the old top-level-only glob', () => {
  const narrowed = ['config/**/*.json', '!config/*.local.json'];
  assert.equal(isPacked('config/claude-accounts.local.json', narrowed), false);
  assert.equal(isPacked('config/orchestra/foo.local.json', narrowed), true);
});
