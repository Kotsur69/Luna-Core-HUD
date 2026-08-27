// resolveInRoot() and buildEditorInvocation() - the two pure helpers in
// src/editor.js (loadEditorConfig() reads real config files and is covered by
// the manual checklist, same convention as gpu.js / cheatsheets.js).
//
// These pin the §D4a compensating control: main NEVER trusts the renderer's
// `file` string. resolveInRoot() must reject every way out of the session cwd,
// and buildEditorInvocation() must only ever substitute the three placeholders.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveInRoot, buildEditorInvocation } = require('../src/editor');

const REPO_ROOT = path.join(__dirname, '..');

// ---- resolveInRoot -------------------------------------------------------------

test('resolveInRoot resolves a relative path inside the root to an absolute path', () => {
  const abs = resolveInRoot(REPO_ROOT, 'src/editor.js');
  assert.equal(abs, path.join(REPO_ROOT, 'src', 'editor.js'));
});

test('resolveInRoot resolves a path through a nested directory', () => {
  const abs = resolveInRoot(REPO_ROOT, 'src/renderer/modules/termlinks.js');
  assert.equal(abs, path.join(REPO_ROOT, 'src', 'renderer', 'modules', 'termlinks.js'));
});

test('resolveInRoot rejects a ".." traversal that climbs out of the root', () => {
  assert.equal(resolveInRoot(path.join(REPO_ROOT, 'src'), '../package.json'), null);
  assert.equal(resolveInRoot(REPO_ROOT, '../../etc/passwd'), null);
});

test('resolveInRoot rejects an absolute path outside the root', () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
  assert.equal(resolveInRoot(path.join(REPO_ROOT, 'src'), outside), null);
});

test('resolveInRoot rejects a NUL byte in the candidate', () => {
  assert.equal(resolveInRoot(REPO_ROOT, 'src/editor.js\0.txt'), null);
});

test('resolveInRoot rejects an existing directory (not a file)', () => {
  assert.equal(resolveInRoot(REPO_ROOT, 'src'), null);
});

test('resolveInRoot rejects the root itself', () => {
  assert.equal(resolveInRoot(REPO_ROOT, '.'), null);
});

test('resolveInRoot rejects a file that does not exist', () => {
  assert.equal(resolveInRoot(REPO_ROOT, 'src/does-not-exist-xyz.js'), null);
});

test('resolveInRoot rejects junk input', () => {
  assert.equal(resolveInRoot('', 'src/editor.js'), null);
  assert.equal(resolveInRoot(REPO_ROOT, ''), null);
  assert.equal(resolveInRoot(REPO_ROOT, null), null);
  assert.equal(resolveInRoot(null, null), null);
});

// ---- buildEditorInvocation ---------------------------------------------------

const DEFAULT_CFG = { command: 'code', args: ['-g', '{file}:{line}:{col}'] };
const FILE = path.join(REPO_ROOT, 'src', 'editor.js');

test('buildEditorInvocation: default config with a column -> code -g file:line:col', () => {
  const inv = buildEditorInvocation(DEFAULT_CFG, { file: FILE, line: 42, col: 7 });
  assert.deepEqual(inv, { cmd: 'code', args: ['-g', `${FILE}:42:7`] });
});

test('buildEditorInvocation: default config, col null -> the ":{col}" is dropped', () => {
  const inv = buildEditorInvocation(DEFAULT_CFG, { file: FILE, line: 42, col: null });
  assert.deepEqual(inv, { cmd: 'code', args: ['-g', `${FILE}:42`] });
});

test('buildEditorInvocation: a custom template is substituted verbatim', () => {
  const cfg = { command: 'subl', args: ['--wait', '{file}:{line}'] };
  const inv = buildEditorInvocation(cfg, { file: FILE, line: 9, col: 3 });
  assert.deepEqual(inv, { cmd: 'subl', args: ['--wait', `${FILE}:9`] });
});

test('buildEditorInvocation: command "" falls back to $EDITOR with "+line file"', () => {
  const saved = { v: process.env.VISUAL, e: process.env.EDITOR };
  delete process.env.VISUAL;
  process.env.EDITOR = 'vim';
  try {
    const inv = buildEditorInvocation({ command: '', args: [] }, { file: FILE, line: 15, col: null });
    assert.deepEqual(inv, { cmd: 'vim', args: ['+15', FILE] });
  } finally {
    if (saved.v === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = saved.v;
    if (saved.e === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = saved.e;
  }
});

test('buildEditorInvocation: $VISUAL wins over $EDITOR', () => {
  const saved = { v: process.env.VISUAL, e: process.env.EDITOR };
  process.env.VISUAL = 'nano';
  process.env.EDITOR = 'vim';
  try {
    const inv = buildEditorInvocation({ command: '' }, { file: FILE, line: 3, col: 1 });
    assert.deepEqual(inv, { cmd: 'nano', args: ['+3', FILE] });
  } finally {
    if (saved.v === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = saved.v;
    if (saved.e === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = saved.e;
  }
});

test('buildEditorInvocation: command "" and no editor env -> null', () => {
  const saved = { v: process.env.VISUAL, e: process.env.EDITOR };
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  try {
    assert.equal(buildEditorInvocation({ command: '' }, { file: FILE, line: 1, col: null }), null);
  } finally {
    if (saved.v !== undefined) process.env.VISUAL = saved.v;
    if (saved.e !== undefined) process.env.EDITOR = saved.e;
  }
});
