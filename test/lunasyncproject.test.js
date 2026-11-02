// ============================================================================
// LunaCore - Luna sync project layer (src/lunasyncproject.js)
// ----------------------------------------------------------------------------
// A project's .mcp.json servers reach only the tab started in that project:
// which servers count (Claude's approval, nearer .mcp.json wins, local scope),
// and the per-project Codex profile / Gemini defaults layer they are written
// to. Fixtures live in temp dirs - never the real ~/.claude.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readProjectServers, projectLayerFor, projectLayerName } = require('../src/lunasyncproject');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
}

/**
 * <root>/repos/.mcp.json (parent) + <root>/repos/app/.mcp.json (project), the
 * project's approval in .claude/settings.local.json, a fake Claude home.
 */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunaproj-'));
  const claudeHome = path.join(root, 'home', '.claude');
  const claudeJson = path.join(root, 'home', '.claude.json');
  const parent = path.join(root, 'repos');
  const projectDir = path.join(parent, 'app');
  write(path.join(parent, '.mcp.json'), {
    mcpServers: {
      shared: { command: 'parent-cmd', args: [] },
      fromParent: { command: 'p', args: ['x'] },
    },
  });
  write(path.join(projectDir, '.mcp.json'), {
    mcpServers: {
      shared: { command: 'child-cmd', args: [] },
      gh: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GH_TOKEN}' } },
      tool: { command: 'npx', args: ['tool-mcp'], env: { TOOL_KEY: '${TOOL_KEY}' } },
      stranger: { command: 'evil.exe', args: [] },
    },
  });
  write(path.join(projectDir, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['shared', 'fromParent', 'gh', 'tool'] });
  write(claudeJson, trustedJson(projectDir));
  const overlayRoot = path.join(root, 'overlay');
  fs.mkdirSync(overlayRoot, { recursive: true });
  return { root, claudeHome, claudeJson, parent, projectDir, overlayRoot };
}

/** ~/.claude.json with Claude's trust dialog accepted for `dir`, plus `extra` in its entry. */
function trustedJson(dir, extra = {}) {
  return { projects: { [dir.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, ...extra } } };
}

const only = (skipped, names) => skipped.filter((s) => names.includes(s.name)).map((s) => `${s.name}:${s.reason}`).sort();

// ---- which servers -------------------------------------------------------------

test('readProjectServers walks up from the project, the nearer .mcp.json winning', () => {
  const fx = makeProject();
  const { servers } = readProjectServers(fx);
  assert.equal(servers.shared.command, 'child-cmd');
  assert.equal(servers.fromParent.command, 'p', 'a parent folder\'s .mcp.json counts too, as in Claude');
  assert.deepEqual(['fromParent', 'gh', 'shared', 'tool'].filter((n) => servers[n]), ['fromParent', 'gh', 'shared', 'tool']);
});

test('readProjectServers carries only servers Claude approved for the folder', () => {
  const fx = makeProject();
  write(fx.claudeJson, trustedJson(fx.projectDir, { disabledMcpjsonServers: ['tool'] }));
  const { servers, skipped } = readProjectServers(fx);
  assert.equal(servers.stranger, undefined, 'never approved in Claude - not started in another CLI either');
  assert.equal(servers.tool, undefined, 'disabled in ~/.claude.json wins over enabled');
  assert.deepEqual(only(skipped, ['stranger', 'tool']), ['stranger:not-approved', 'tool:disabled-in-claude']);
});

test('enableAllProjectMcpServers approves every .mcp.json server of the folder', () => {
  const fx = makeProject();
  fs.rmSync(path.join(fx.projectDir, '.claude', 'settings.local.json'));
  write(path.join(fx.projectDir, '.claude', 'settings.json'), { enableAllProjectMcpServers: true });
  const { servers, skipped } = readProjectServers(fx);
  assert.ok(servers.stranger && servers.gh && servers.fromParent);
  assert.deepEqual(only(skipped, ['stranger', 'gh', 'fromParent', 'shared', 'tool']), []);
});

test('Claude local-scope servers of the folder are carried and win a name clash', () => {
  const fx = makeProject();
  write(fx.claudeJson, {
    projects: {
      // Windows keys in ~/.claude.json use forward slashes; case differs here on purpose.
      [fx.projectDir.split(path.sep).join('/').toUpperCase()]: { hasTrustDialogAccepted: true, mcpServers: { stranger: { command: 'mine.exe', args: [] }, own: { command: 'own', args: [] } } },
      '/somewhere/else': { mcpServers: { foreign: { command: 'no', args: [] } } },
    },
  });
  const { servers, skipped } = readProjectServers(fx);
  if (process.platform === 'win32') {
    assert.equal(servers.own.command, 'own');
    assert.equal(servers.stranger.command, 'mine.exe', 'the user added it for this folder - no approval step');
    assert.deepEqual(only(skipped, ['stranger']), [], 'not also reported as unapproved');
  }
  assert.equal(servers.foreign, undefined, 'another folder\'s local servers stay there');
});

test('readProjectServers never throws on broken files', () => {
  const fx = makeProject();
  write(path.join(fx.projectDir, '.mcp.json'), '{ broken');
  const { servers } = readProjectServers(fx);
  assert.equal(servers.shared.command, 'parent-cmd', 'the parent file still counts');
  write(fx.claudeJson, 'nope');
  assert.deepEqual(readProjectServers(fx).servers, {}, 'unreadable ~/.claude.json = no trust = nothing carried');
});

// ---- Codex: a per-project profile ---------------------------------------------------

test('projectLayerFor (codex) writes a profile file and launches with --profile, secrets left in the env', () => {
  const fx = makeProject();
  const layer = projectLayerFor({ cli: 'codex', ...fx });
  const name = projectLayerName(fx.projectDir);
  assert.deepEqual(layer.args, ['--profile', name]);
  assert.deepEqual(layer.servers.sort(), ['fromParent', 'gh', 'shared', 'tool']);
  const text = fs.readFileSync(path.join(fx.overlayRoot, `${name}.config.toml`), 'utf8');
  assert.match(text, /mcp_servers\.gh = \{ url = "https:\/\/api\.githubcopilot\.com\/mcp\/", bearer_token_env_var = "GH_TOKEN" \}/);
  assert.match(text, /mcp_servers\.tool = \{ command = "npx", args = \["tool-mcp"\], env_vars = \["TOOL_KEY"\] \}/);
  assert.ok(!text.includes('${'), 'no placeholder - and so no secret - in the file');
  assert.equal(fs.existsSync(path.join(fx.overlayRoot, 'config.toml')), false, 'the shared config.toml is not touched');
});

test('projectLayerFor (codex) leaves an unchanged profile file alone', () => {
  const fx = makeProject();
  projectLayerFor({ cli: 'codex', ...fx });
  const file = path.join(fx.overlayRoot, `${projectLayerName(fx.projectDir)}.config.toml`);
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file, past, past);
  projectLayerFor({ cli: 'codex', ...fx });
  assert.equal(Math.floor(fs.statSync(file).mtimeMs / 1000), Math.floor(past.getTime() / 1000));
});

test('projectLayerFor (codex) skips with a reason when --profile cannot be used', () => {
  const fx = makeProject();
  const own = projectLayerFor({ cli: 'codex', ...fx, profileArgs: ['-c', 'x=1', '--profile', 'work'] });
  assert.equal(own.args, undefined);
  assert.ok(own.skipped.some((s) => s.name === 'gh' && s.reason === 'profile-in-use'));

  write(path.join(fx.overlayRoot, 'config.toml'), 'model = "a"\n[profiles.old]\nmodel = "b"\n');
  const legacy = projectLayerFor({ cli: 'codex', ...fx });
  assert.equal(legacy.args, undefined, 'Codex refuses --profile next to a legacy [profiles.x] table');
  assert.ok(legacy.skipped.some((s) => s.name === 'gh' && s.reason === 'codex-legacy-profile'));
});

test('projectLayerFor (codex) with nothing Codex can run adds no --profile and removes a stale file', () => {
  const fx = makeProject();
  projectLayerFor({ cli: 'codex', ...fx });
  const file = path.join(fx.overlayRoot, `${projectLayerName(fx.projectDir)}.config.toml`);
  assert.ok(fs.existsSync(file));
  fs.rmSync(path.join(fx.parent, '.mcp.json'));
  write(path.join(fx.projectDir, '.mcp.json'), { mcpServers: { shared: { type: 'sse', url: 'https://e/sse' } } });
  const layer = projectLayerFor({ cli: 'codex', ...fx });
  assert.equal(layer.args, undefined);
  assert.deepEqual(only(layer.skipped, ['shared']), ['shared:sse-unsupported']);
  assert.equal(fs.existsSync(file), false);
});

// ---- Gemini: a per-project extension, enabled for that folder only ------------------

const geminiPaths = (fx) => {
  const name = projectLayerName(fx.projectDir);
  const extensions = path.join(fx.overlayRoot, '.gemini', 'extensions');
  return { name, manifest: path.join(extensions, name, 'gemini-extension.json'), enablement: path.join(extensions, 'extension-enablement.json') };
};

test('projectLayerFor (gemini) writes a folder-scoped extension, placeholders kept for Gemini', () => {
  const fx = makeProject();
  const layer = projectLayerFor({ cli: 'gemini', ...fx, baseServers: ['shared'] });
  const p = geminiPaths(fx);
  assert.deepEqual(layer.servers.sort(), ['fromParent', 'gh', 'tool']);
  assert.deepEqual(only(layer.skipped, ['shared']), ['shared:name-taken'], 'Gemini\'s settings.json server would win the clash anyway');
  assert.equal(layer.args, undefined, 'Gemini needs no extra args - it picks the extension by folder');
  assert.equal(layer.env, undefined);
  const manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.equal(manifest.name, p.name);
  assert.deepEqual(manifest.mcpServers.gh, { httpUrl: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GH_TOKEN}' } });
  assert.deepEqual(manifest.mcpServers.tool.env, { TOOL_KEY: '${TOOL_KEY}' });
  const rules = JSON.parse(fs.readFileSync(p.enablement, 'utf8'))[p.name].overrides;
  assert.equal(rules[0], '!/*', 'off everywhere else');
  assert.ok(rules.slice(1).every((r) => r.endsWith('/app/')), 'on for the project folder only');
});

test('projectLayerFor (gemini) keeps Gemini\'s own enablement entries and refuses a file it cannot parse', () => {
  const fx = makeProject();
  const p = geminiPaths(fx);
  write(p.enablement, { theirs: { overrides: ['/D:/w/*'] } });
  projectLayerFor({ cli: 'gemini', ...fx });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.enablement, 'utf8')).theirs, { overrides: ['/D:/w/*'] });

  write(p.enablement, '{ not json');
  fs.rmSync(path.dirname(p.manifest), { recursive: true });
  const refused = projectLayerFor({ cli: 'gemini', ...fx });
  assert.deepEqual(refused.servers, []);
  assert.ok(refused.skipped.some((s) => s.name === 'gh' && s.reason === 'overlay-unreadable'));
  assert.equal(fs.existsSync(p.manifest), false, 'no extension without its folder rule');
  assert.equal(fs.readFileSync(p.enablement, 'utf8'), '{ not json', 'Gemini\'s file left as it was');
});

test('projectLayerFor (gemini) removes the extension and its rule once the project has nothing to carry', () => {
  const fx = makeProject();
  const p = geminiPaths(fx);
  projectLayerFor({ cli: 'gemini', ...fx });
  assert.ok(fs.existsSync(p.manifest));
  const layer = projectLayerFor({ cli: 'gemini', ...fx, baseServers: ['shared', 'fromParent', 'gh', 'tool'] });
  assert.deepEqual(layer.servers, []);
  assert.equal(fs.existsSync(path.dirname(p.manifest)), false);
  assert.equal(JSON.parse(fs.readFileSync(p.enablement, 'utf8'))[p.name], undefined);
});

// ---- edges -------------------------------------------------------------------------

test('projectLayerFor is null without an absolute project folder, and empty for a folder without servers', () => {
  const fx = makeProject();
  assert.equal(projectLayerFor({ cli: 'codex', ...fx, projectDir: 'relative/dir' }), null);
  assert.equal(projectLayerFor({ cli: 'codex', ...fx, projectDir: null }), null);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'lunaproj-bare-'));
  const layer = projectLayerFor({ cli: 'codex', ...fx, projectDir: bare });
  assert.equal(layer.args, undefined);
  assert.equal(layer.env, undefined);
});

test('projectLayerName is a plain, stable name per folder', () => {
  const name = projectLayerName('C:\\Users\\x\\repo');
  assert.match(name, /^luna[0-9a-f]{12}$/);
  assert.equal(projectLayerName('C:\\Users\\x\\repo'), name);
  assert.notEqual(projectLayerName('C:\\Users\\x\\other'), name);
  if (process.platform === 'win32') assert.equal(projectLayerName('c:\\users\\X\\REPO'), name);
});

// ---- review follow-ups: trust gate, revocation, profile detection ----------------

test('a folder Claude never trusted gets no .mcp.json servers, even if the repo approves itself', () => {
  const fx = makeProject();
  // A hostile repo can ship its own approval - Claude ignores it until the trust dialog is accepted.
  write(path.join(fx.projectDir, '.claude', 'settings.json'), { enableAllProjectMcpServers: true });
  write(fx.claudeJson, { projects: { [fx.projectDir.split(path.sep).join('/')]: { hasTrustDialogAccepted: false, mcpServers: { mine: { command: 'm', args: [] } } } } });
  const { servers, skipped } = readProjectServers(fx);
  assert.deepEqual(Object.keys(servers), ['mine'], 'local-scope servers are the user\'s own - still carried');
  assert.deepEqual(only(skipped, ['stranger', 'gh']), ['gh:folder-not-trusted', 'stranger:folder-not-trusted']);
});

test('trust accepted on a parent folder covers the project, as in Claude', () => {
  const fx = makeProject();
  write(fx.claudeJson, trustedJson(fx.parent));
  assert.ok(readProjectServers(fx).servers.gh);
});

test('a server revoked in Claude stops loading in Gemini: the extension and its rule are removed', () => {
  const fx = makeProject();
  const p = geminiPaths(fx);
  projectLayerFor({ cli: 'gemini', ...fx });
  assert.ok(fs.existsSync(p.manifest));
  write(fx.claudeJson, trustedJson(fx.projectDir, { disabledMcpjsonServers: ['shared', 'fromParent', 'gh', 'tool'] }));
  const layer = projectLayerFor({ cli: 'gemini', ...fx });
  assert.deepEqual(layer.servers, []);
  assert.equal(fs.existsSync(path.dirname(p.manifest)), false);
  assert.equal(JSON.parse(fs.readFileSync(p.enablement, 'utf8'))[p.name], undefined);
});

test('projectLayerFor clear removes the folder layer for both CLIs and reads nothing', () => {
  const fx = makeProject();
  const p = geminiPaths(fx);
  projectLayerFor({ cli: 'gemini', ...fx });
  projectLayerFor({ cli: 'codex', ...fx });
  const codexFile = path.join(fx.overlayRoot, `${p.name}.config.toml`);
  assert.ok(fs.existsSync(codexFile) && fs.existsSync(p.manifest));
  assert.equal(projectLayerFor({ cli: 'gemini', overlayRoot: fx.overlayRoot, projectDir: fx.projectDir, clear: true }), null);
  assert.equal(projectLayerFor({ cli: 'codex', overlayRoot: fx.overlayRoot, projectDir: fx.projectDir, clear: true }), null);
  assert.equal(fs.existsSync(codexFile), false);
  assert.equal(fs.existsSync(path.dirname(p.manifest)), false);
});

test('a profile chosen any way in the tab args blocks the Codex layer', () => {
  const fx = makeProject();
  for (const args of [['-pwork'], ['-p', 'work'], ['--profile=work'], ['-c', 'profile=work']]) {
    const layer = projectLayerFor({ cli: 'codex', ...fx, profileArgs: args });
    assert.equal(layer.args, undefined, args.join(' '));
  }
  assert.deepEqual(projectLayerFor({ cli: 'codex', ...fx, profileArgs: ['-c', 'model="x"'] }).args.slice(0, 1), ['--profile']);
});
