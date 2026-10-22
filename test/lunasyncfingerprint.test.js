'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { lunaLaunchFor } = require('../src/lunasynclaunch');
const { overlayFingerprint } = require('../src/lunasyncfingerprint');

const NATIVE_CODEX = { id: 'codex-cli', wireVia: 'native', command: 'codex' };

/** A fake ~/.claude + ~/.claude.json and an overlay base, all under one temp dir. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunafp-'));
  const claudeHome = path.join(dir, '.claude');
  fs.mkdirSync(path.join(claudeHome, 'skills', 'mine'), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, 'rules', 'common'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'CLAUDE.md'), '# me');
  fs.writeFileSync(path.join(claudeHome, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
  fs.writeFileSync(path.join(claudeHome, 'rules', 'common', 'a.md'), 'rule');
  const claudeJson = path.join(dir, '.claude.json');
  fs.writeFileSync(claudeJson, '{}');
  return { dir, claudeHome, claudeJson, overlayBase: path.join(dir, 'luna-overlay') };
}

/** A sync stub that creates the overlay folder like the real one and counts calls. */
function countingSync() {
  const calls = [];
  const sync = (args) => {
    calls.push(args);
    fs.mkdirSync(args.overlayRoot, { recursive: true });
    return { ok: true, env: { CODEX_HOME: args.overlayRoot }, skills: ['mine'], servers: [], skipped: [] };
  };
  return { calls, sync };
}

function launch(fx, sync, extra = {}) {
  return lunaLaunchFor({
    profile: { lunaSync: true },
    template: NATIVE_CODEX,
    overlayBase: fx.overlayBase,
    claudeHome: fx.claudeHome,
    claudeJson: fx.claudeJson,
    readSetup: () => ({ marker: 1 }),
    sync,
    ...extra,
  });
}

/** Moves a file's mtime forward so the change is visible even on coarse-mtime filesystems. */
function touch(file, text) {
  fs.writeFileSync(file, text);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
}

test('second spawn with nothing changed does no copy and reuses the last result', () => {
  const fx = fixture();
  const { calls, sync } = countingSync();
  const first = launch(fx, sync);
  const second = launch(fx, sync);
  assert.equal(calls.length, 1, 'built once');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.deepEqual(second.env, first.env);
  assert.deepEqual(second.skills, ['mine']);
});

test('a changed source file triggers a rebuild', () => {
  const fx = fixture();
  const { calls, sync } = countingSync();
  launch(fx, sync);
  touch(path.join(fx.claudeHome, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\nchanged\n');
  launch(fx, sync);
  assert.equal(calls.length, 2);
  touch(path.join(fx.claudeHome, 'rules', 'common', 'b.md'), 'new rule');
  launch(fx, sync);
  assert.equal(calls.length, 3, 'a new rule file counts');
  touch(fx.claudeJson, '{"mcpServers":{}}');
  launch(fx, sync);
  assert.equal(calls.length, 4, '~/.claude.json counts');
  launch(fx, sync);
  assert.equal(calls.length, 4, 'and settles again');
});

test('picked skills, gateway port and a deleted overlay each force a rebuild', () => {
  const fx = fixture();
  const { calls, sync } = countingSync();
  launch(fx, sync);
  launch(fx, sync, { pickedSkillIds: ['ecc:tdd-workflow'] });
  assert.equal(calls.length, 2);
  launch(fx, sync, { pickedSkillIds: ['ecc:tdd-workflow'], gatewayPort: 3001 });
  assert.equal(calls.length, 3);
  fs.rmSync(path.join(fx.overlayBase, 'codex'), { recursive: true, force: true });
  launch(fx, sync, { pickedSkillIds: ['ecc:tdd-workflow'], gatewayPort: 3001 });
  assert.equal(calls.length, 4);
});

test('a changed plugin .mcp.json or picked plugin skill triggers a rebuild', () => {
  const fx = fixture();
  const installPath = path.join(fx.dir, 'plugins', 'ecc', '1.0.0');
  fs.mkdirSync(path.join(installPath, 'skills', 'tdd-workflow'), { recursive: true });
  fs.writeFileSync(path.join(installPath, 'skills', 'tdd-workflow', 'SKILL.md'), 'v1');
  fs.writeFileSync(path.join(installPath, '.mcp.json'), '{}');
  fs.mkdirSync(path.join(fx.claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(fx.claudeHome, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'ecc@ecc': [{ installPath }] } }),
  );
  const { calls, sync } = countingSync();
  const picked = { pickedSkillIds: ['ecc:tdd-workflow'] };
  launch(fx, sync, picked);
  launch(fx, sync, picked);
  assert.equal(calls.length, 1);
  touch(path.join(installPath, 'skills', 'tdd-workflow', 'SKILL.md'), 'v2 longer');
  launch(fx, sync, picked);
  assert.equal(calls.length, 2, 'picked plugin skill edited in place');
  touch(path.join(installPath, '.mcp.json'), '{"mcpServers":{}}');
  launch(fx, sync, picked);
  assert.equal(calls.length, 3, 'plugin MCP servers changed');
});

test('a deleted or edited overlay file forces a rebuild', () => {
  const fx = fixture();
  const calls = [];
  const sync = (args) => {
    calls.push(args);
    fs.mkdirSync(args.overlayRoot, { recursive: true });
    fs.writeFileSync(path.join(args.overlayRoot, 'config.toml'), 'model = "x"\n');
    return { ok: true, env: { CODEX_HOME: args.overlayRoot }, skills: [], servers: [], skipped: [] };
  };
  launch(fx, sync);
  launch(fx, sync);
  assert.equal(calls.length, 1);
  fs.rmSync(path.join(fx.overlayBase, 'codex', 'config.toml'));
  launch(fx, sync);
  assert.equal(calls.length, 2);
});

test('a cache hit never takes its env from the stored file', () => {
  const fx = fixture();
  const { sync } = countingSync();
  launch(fx, sync);
  const file = `${path.join(fx.overlayBase, 'codex')}.fingerprint.json`;
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.result.env, undefined, 'env is not stored');
  stored.result.env = { NODE_OPTIONS: '--require evil' };
  fs.writeFileSync(file, JSON.stringify(stored));
  const hit = launch(fx, sync);
  assert.equal(hit.cached, true);
  assert.deepEqual(hit.env, { CODEX_HOME: path.join(fx.overlayBase, 'codex') });
});

test('a failed sync is never cached: the next spawn tries again and still reports why', () => {
  const fx = fixture();
  let n = 0;
  const sync = (args) => {
    n += 1;
    fs.mkdirSync(args.overlayRoot, { recursive: true });
    return { ok: false, reason: 'overlay-damaged' };
  };
  assert.deepEqual(launch(fx, sync), { ok: false, reason: 'overlay-damaged' });
  assert.deepEqual(launch(fx, sync), { ok: false, reason: 'overlay-damaged' });
  assert.equal(n, 2);
});

test('the fingerprint ignores ~/.claude when the overlay reads nothing from it', () => {
  const fx = fixture();
  const base = { options: { cli: 'gemini' }, claudeHome: fx.claudeHome, claudeJson: fx.claudeJson };
  const before = overlayFingerprint({ ...base, withSources: false });
  const withBefore = overlayFingerprint({ ...base, withSources: true });
  touch(path.join(fx.claudeHome, 'CLAUDE.md'), '# changed');
  assert.equal(overlayFingerprint({ ...base, withSources: false }), before);
  assert.notEqual(overlayFingerprint({ ...base, withSources: true }), withBefore);
});
