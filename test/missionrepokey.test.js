// ============================================================================
// LunaCore - Mission Control project key tests (src/missionrepokey.js)
// ----------------------------------------------------------------------------
// Real temp directories: a repo with a remote, one without, a God Mode style
// worktree (`.git` file -> .../.git/worktrees/<name>) and a plain folder.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeRemote, originUrl, createRepoKeys } = require('../src/missionrepokey.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-repokey-'));
}

function makeRepo(root, name, remote) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const cfg = remote ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*\n` : '[core]\n';
  fs.writeFileSync(path.join(dir, '.git', 'config'), cfg);
  return dir;
}

test('normalizeRemote folds https, scp-style and ssh:// forms into host/owner/repo', () => {
  assert.equal(normalizeRemote('https://github.com/Kotsur69/Luna-Core-HUD.git'), 'github.com/kotsur69/luna-core-hud');
  assert.equal(normalizeRemote('git@github.com:Kotsur69/Luna-Core-HUD.git'), 'github.com/kotsur69/luna-core-hud');
  assert.equal(normalizeRemote('ssh://git@github.com/Kotsur69/Luna-Core-HUD'), 'github.com/kotsur69/luna-core-hud');
  assert.equal(normalizeRemote('https://user:secret@github.com/a/b/'), 'github.com/a/b');
});

test('normalizeRemote rejects local paths and junk', () => {
  assert.equal(normalizeRemote('C:/repos/thing'), null);
  assert.equal(normalizeRemote('../other'), null);
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote(undefined), null);
});

test('originUrl reads the origin url, not another remote', () => {
  const cfg = '[remote "fork"]\n\turl = https://github.com/x/fork\n[remote "origin"]\n\turl = https://github.com/x/main\n';
  assert.equal(originUrl(cfg), 'https://github.com/x/main');
  assert.equal(originUrl('[core]\n'), null);
});

test('a cwd inside a repo with a remote keys by the remote', () => {
  const root = tmp();
  const repo = makeRepo(root, 'Luna-Core-HUD', 'https://github.com/Kotsur69/Luna-Core-HUD.git');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  const keys = createRepoKeys();
  assert.deepEqual(keys.resolve(path.join(repo, 'src', 'deep')), {
    key: 'git:github.com/kotsur69/luna-core-hud',
    name: 'Luna-Core-HUD',
  });
});

test('a repo without a remote keys by its folder name', () => {
  const root = tmp();
  const repo = makeRepo(root, 'Scratch-Tool', null);
  assert.deepEqual(createRepoKeys().resolve(repo), { key: 'local:scratch-tool', name: 'Scratch-Tool' });
});

test('a worktree folds into its parent repo', () => {
  const root = tmp();
  const repo = makeRepo(root, 'Main-Repo', 'git@github.com:me/Main-Repo.git');
  const wtGit = path.join(repo, '.git', 'worktrees', 'feat-x');
  fs.mkdirSync(wtGit, { recursive: true });
  const wt = path.join(root, 'wt', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.deepEqual(createRepoKeys().resolve(wt), { key: 'git:github.com/me/main-repo', name: 'Main-Repo' });
});

test('a folder outside any repo, or a missing one, is "other"', () => {
  const root = tmp();
  const keys = createRepoKeys();
  assert.deepEqual(keys.resolve(root), { key: 'other', name: 'other' });
  assert.deepEqual(keys.resolve(path.join(root, 'gone', 'away')), { key: 'other', name: 'other' });
  assert.deepEqual(keys.resolve(42), { key: 'other', name: 'other' });
});

test('resolve caches per cwd', () => {
  const root = tmp();
  const repo = makeRepo(root, 'Cached', null);
  const keys = createRepoKeys();
  assert.equal(keys.resolve(repo).key, 'local:cached');
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(keys.resolve(repo).key, 'local:cached');
});

test('UNC and relative cwds are "other" without touching the network', () => {
  const keys = createRepoKeys();
  assert.deepEqual(keys.resolve(String.raw`\\evil-host\share\repo`), { key: 'other', name: 'other' });
  assert.deepEqual(keys.resolve('//evil-host/share/repo'), { key: 'other', name: 'other' });
  assert.deepEqual(keys.resolve('relative/dir'), { key: 'other', name: 'other' });
});

test('a Git Bash style cwd (/c/Users/...) resolves like the Windows path', { skip: process.platform !== 'win32' }, () => {
  const root = tmp();
  const repo = makeRepo(root, 'Bash-Repo', 'https://github.com/me/bash-repo');
  const drive = repo[0].toLowerCase();
  const bashPath = `/${drive}${repo.slice(2).split(path.sep).join('/')}`;
  assert.equal(createRepoKeys().resolve(bashPath).key, 'git:github.com/me/bash-repo');
});

test('a missing folder matching a pinned alias counts for that project', () => {
  const root = tmp();
  const aliases = () => new Map([['synthara', { key: 'git:github.com/kotsur69/synthara', name: 'synthara' }]]);
  const keys = createRepoKeys({ aliases });
  assert.deepEqual(keys.resolve(path.join(root, 'gone', 'Synthara')), { key: 'git:github.com/kotsur69/synthara', name: 'synthara' });
  assert.deepEqual(keys.resolve(path.join(root, 'gone', 'Synthara', 'src')), { key: 'git:github.com/kotsur69/synthara', name: 'synthara' });
  assert.deepEqual(keys.resolve(path.join(root, 'unrelated')), { key: 'other', name: 'other' });
});
