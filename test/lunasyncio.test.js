// ============================================================================
// LunaCore - Luna sync file I/O (src/lunasyncio.js)
// ----------------------------------------------------------------------------
// Runs against a fake ~/.claude in a temp dir - never the real one. Pins the
// promises the sync makes: the source setup is only read, the overlay keeps
// files the other CLI wrote (login, trust, memories, its own skills), and a
// skill dropped from the selection is removed from the overlay again.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readClaudeSetup, listPluginSkills, syncOverlay, overlayEnv } = require('../src/lunasyncio');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function skillMd(name) {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}.\n`;
}

/** A fake Claude home: global CLAUDE.md, rules, personal + learned skills, one enabled and one disabled plugin. */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunasync-'));
  const claudeHome = path.join(root, '.claude');
  write(path.join(claudeHome, 'CLAUDE.md'), 'User = Mati, assistant = Luna.');
  write(path.join(claudeHome, 'rules', 'ecc', 'common', 'testing.md'), 'Write tests first.');
  write(path.join(claudeHome, 'rules', 'ecc', 'python', 'style.md'), 'Use type hints.');
  write(path.join(claudeHome, 'skills', 'my-skill', 'SKILL.md'), skillMd('my-skill'));
  write(path.join(claudeHome, 'skills', 'my-skill', 'ref.md'), 'extra file');
  write(path.join(claudeHome, 'skills', 'learned', 'tip-one.md'), skillMd('tip-one'));
  write(path.join(claudeHome, 'skills', 'synced', 'abc', 'browser', 'SKILL.md'), skillMd('browser'));

  const goodRoot = path.join(claudeHome, 'plugins', 'cache', 'mk', 'good', '1.0.0');
  write(path.join(goodRoot, 'skills', 'tdd', 'SKILL.md'), skillMd('tdd'));
  write(path.join(goodRoot, 'skills', 'ui', 'SKILL.md'), skillMd('ui'));
  write(path.join(goodRoot, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/s.js'] } } }));
  const offRoot = path.join(claudeHome, 'plugins', 'cache', 'mk', 'off', '1.0.0');
  write(path.join(offRoot, 'skills', 'hidden', 'SKILL.md'), skillMd('hidden'));

  write(path.join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'good@mk': true, 'off@mk': false } }));
  write(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'good@mk': [
        { installPath: path.join(claudeHome, 'plugins', 'cache', 'mk', 'good', '0.9.0'), lastUpdated: '2026-01-01T00:00:00Z' },
        { installPath: goodRoot, lastUpdated: '2026-10-01T00:00:00Z' },
      ],
      'off@mk': [{ installPath: offRoot, lastUpdated: '2026-10-01T00:00:00Z' }],
    },
  }));
  const claudeJson = path.join(root, '.claude.json');
  write(claudeJson, JSON.stringify({ mcpServers: { memory: { command: 'mem.exe', args: [] } } }));
  return { root, claudeHome, claudeJson, goodRoot };
}

/** Every file under `dir` with its content, for a before/after comparison. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('readClaudeSetup collects instructions, rules, personal skills, enabled plugins and MCP servers', () => {
  const fx = makeFixture();
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  assert.match(setup.globalMd, /assistant = Luna/);
  assert.deepEqual(setup.rules.map((r) => r.rel), ['ecc/common/testing.md', 'ecc/python/style.md']);
  assert.deepEqual(setup.personalSkills.map((s) => s.name).sort(), ['my-skill', 'tip-one']);
  assert.deepEqual(setup.plugins.map((p) => p.id), ['good@mk']);
  assert.equal(setup.plugins[0].installPath, fx.goodRoot, 'latest install wins');
  assert.deepEqual(Object.keys(setup.mcpServers).sort(), ['docs', 'memory']);
  // Forward slashes on every OS: the path lands in TOML/JSON read by other CLIs.
  assert.deepEqual(setup.mcpServers.docs.args, [`${fx.goodRoot.split(path.sep).join('/')}/s.js`]);
});

test('readClaudeSetup on a machine without Claude Code returns an empty setup, never throws', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lunasync-empty-'));
  const setup = readClaudeSetup({ claudeHome: path.join(empty, '.claude'), claudeJson: path.join(empty, '.claude.json') });
  assert.equal(setup.globalMd, '');
  assert.deepEqual(setup.rules, []);
  assert.deepEqual(setup.personalSkills, []);
  assert.deepEqual(setup.plugins, []);
  assert.deepEqual(setup.mcpServers, {});
});

test('listPluginSkills lists only enabled plugins, as plugin:skill ids', () => {
  const fx = makeFixture();
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  assert.deepEqual(listPluginSkills(setup).map((s) => s.id), ['good:tdd', 'good:ui']);
});

test('syncOverlay (gemini) writes the overlay home and never touches the Claude setup', () => {
  const fx = makeFixture();
  const before = snapshot(fx.claudeHome);
  const overlayRoot = path.join(fx.root, 'overlay-gemini');
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });

  const result = syncOverlay({ cli: 'gemini', overlayRoot, setup, pickedSkillIds: ['good:tdd'] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.env, { GEMINI_CLI_HOME: overlayRoot });
  const geminiDir = path.join(overlayRoot, '.gemini');
  const md = fs.readFileSync(path.join(geminiDir, 'GEMINI.md'), 'utf8');
  assert.match(md, /assistant = Luna/);
  assert.match(md, /Write tests first\./, 'common rules inline');
  assert.doesNotMatch(md, /Use type hints\./, 'language rules referenced, not inline');
  assert.ok(fs.existsSync(path.join(overlayRoot, 'luna-rules', 'ecc', 'python', 'style.md')));
  for (const name of ['my-skill', 'tip-one', 'tdd']) {
    assert.ok(fs.existsSync(path.join(geminiDir, 'skills', name, 'SKILL.md')), name);
  }
  assert.ok(fs.existsSync(path.join(geminiDir, 'skills', 'my-skill', 'ref.md')), 'whole skill folder copied');
  assert.ok(!fs.existsSync(path.join(geminiDir, 'skills', 'ui')), 'unpicked plugin skill not copied');
  assert.ok(!fs.existsSync(path.join(geminiDir, 'skills', 'browser')), 'claude.ai synced skills skipped');
  const settings = JSON.parse(fs.readFileSync(path.join(geminiDir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(settings.mcpServers).sort(), ['docs', 'memory']);
  assert.deepEqual(snapshot(fx.claudeHome), before, '~/.claude unchanged');
});

test('syncOverlay keeps what the other CLI wrote and drops a skill that is no longer picked', () => {
  const fx = makeFixture();
  const overlayRoot = path.join(fx.root, 'overlay-gemini');
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  syncOverlay({ cli: 'gemini', overlayRoot, setup, pickedSkillIds: ['good:tdd'] });

  // What Gemini itself writes into its home between runs.
  const geminiDir = path.join(overlayRoot, '.gemini');
  write(path.join(geminiDir, 'oauth_creds.json'), '{"token":"x"}');
  write(path.join(geminiDir, 'skills', 'own-skill', 'SKILL.md'), skillMd('own-skill'));
  const settingsFile = path.join(geminiDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, security: { auth: { selectedType: 'oauth-personal' } } }));
  fs.appendFileSync(path.join(geminiDir, 'GEMINI.md'), '\n## Gemini Added Memories\n- likes tea\n');

  syncOverlay({ cli: 'gemini', overlayRoot, setup, pickedSkillIds: [] });

  assert.ok(fs.existsSync(path.join(geminiDir, 'oauth_creds.json')));
  assert.ok(fs.existsSync(path.join(geminiDir, 'skills', 'own-skill', 'SKILL.md')), 'unmanaged skill kept');
  assert.ok(!fs.existsSync(path.join(geminiDir, 'skills', 'tdd')), 'unpicked managed skill removed');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).security.auth.selectedType, 'oauth-personal');
  const md = fs.readFileSync(path.join(geminiDir, 'GEMINI.md'), 'utf8');
  assert.match(md, /- likes tea/);
  assert.equal(md.match(/lunacore:start/g).length, 1);
});

test('syncOverlay (codex) writes AGENTS.md, skills and a config.toml block that keeps Codex entries', () => {
  const fx = makeFixture();
  const overlayRoot = path.join(fx.root, 'overlay-codex');
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  write(path.join(overlayRoot, 'config.toml'), '[projects."C:\\\\work"]\ntrust_level = "trusted"\n');

  const result = syncOverlay({ cli: 'codex', overlayRoot, setup, pickedSkillIds: [] });

  assert.deepEqual(result.env, { CODEX_HOME: overlayRoot });
  assert.match(fs.readFileSync(path.join(overlayRoot, 'AGENTS.md'), 'utf8'), /assistant = Luna/);
  assert.ok(fs.existsSync(path.join(overlayRoot, 'skills', 'my-skill', 'SKILL.md')));
  const toml = fs.readFileSync(path.join(overlayRoot, 'config.toml'), 'utf8');
  assert.match(toml, /^mcp_servers\.memory = /m);
  assert.match(toml, /trust_level = "trusted"/);
  assert.ok(toml.indexOf('mcp_servers.memory') < toml.indexOf('[projects'), 'LunaCore lines stay above Codex tables');
  assert.deepEqual(result.servers.sort(), ['docs', 'memory']);
  assert.deepEqual(result.skipped, []);
});

// ---- review fixes (S2 review, 2026-10-20) -------------------------------------

test('syncOverlay refuses a root that is, contains or sits inside a real CLI home', () => {
  const setup = { globalMd: '', rules: [], personalSkills: [], plugins: [], mcpServers: {} };
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunasync-home-'));
  for (const root of [homeDir, path.join(homeDir, '.codex'), path.join(homeDir, '.gemini', 'x'), path.join(homeDir, '.claude'), path.dirname(homeDir)]) {
    assert.equal(syncOverlay({ cli: 'codex', overlayRoot: root, setup, homeDir }).reason, 'forbidden-root', root);
  }
  const fine = path.join(homeDir, 'AppData', 'LunaCore', 'luna-overlay', 'codex');
  assert.equal(syncOverlay({ cli: 'codex', overlayRoot: fine, setup, homeDir }).ok, true);
});

test('syncOverlay refuses to overwrite an overlay file it cannot parse', () => {
  const fx = makeFixture();
  const overlayRoot = path.join(fx.root, 'overlay-gemini');
  const settingsFile = path.join(overlayRoot, '.gemini', 'settings.json');
  const jsonc = '{\n  // Gemini allows comments\n  "security": { "auth": { "selectedType": "oauth-personal" } }\n}\n';
  write(settingsFile, jsonc);
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  const result = syncOverlay({ cli: 'gemini', overlayRoot, setup });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'overlay-unreadable');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), jsonc, 'left untouched');
});

test('syncOverlay refuses a damaged instructions block instead of rewriting it', () => {
  const fx = makeFixture();
  const overlayRoot = path.join(fx.root, 'overlay-codex');
  const agents = path.join(overlayRoot, 'AGENTS.md');
  write(agents, '<!-- lunacore:start (managed) -->\nhalf a block, user removed the end marker\n');
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  const result = syncOverlay({ cli: 'codex', overlayRoot, setup });
  assert.equal(result.reason, 'overlay-damaged');
  assert.match(fs.readFileSync(agents, 'utf8'), /half a block/);
});

test('syncOverlay never replaces a skill folder it did not create, and dedupes names case-insensitively', () => {
  const fx = makeFixture();
  write(path.join(fx.claudeHome, 'skills', 'learned', 'My-Skill.md'), skillMd('My-Skill'));
  const overlayRoot = path.join(fx.root, 'overlay-codex');
  write(path.join(overlayRoot, 'skills', 'tip-one', 'SKILL.md'), 'codex-made skill');
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  const result = syncOverlay({ cli: 'codex', overlayRoot, setup });
  assert.equal(fs.readFileSync(path.join(overlayRoot, 'skills', 'tip-one', 'SKILL.md'), 'utf8'), 'codex-made skill');
  assert.deepEqual(result.skipped.filter((s) => s.kind === 'skill'), [{ kind: 'skill', name: 'tip-one', reason: 'name-taken' }]);
  assert.deepEqual(result.skills, ['my-skill'], 'My-Skill collapses onto my-skill');
});

test('syncOverlay copies a skill without its .git and node_modules folders', () => {
  const fx = makeFixture();
  write(path.join(fx.claudeHome, 'skills', 'my-skill', '.git', 'HEAD'), 'ref');
  write(path.join(fx.claudeHome, 'skills', 'my-skill', 'node_modules', 'x', 'index.js'), '0');
  const overlayRoot = path.join(fx.root, 'overlay-codex');
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  syncOverlay({ cli: 'codex', overlayRoot, setup });
  const dest = path.join(overlayRoot, 'skills', 'my-skill');
  assert.ok(fs.existsSync(path.join(dest, 'ref.md')));
  assert.ok(!fs.existsSync(path.join(dest, '.git')));
  assert.ok(!fs.existsSync(path.join(dest, 'node_modules')));
});

test('syncOverlay reports MCP servers Codex cannot take instead of claiming them', () => {
  const fx = makeFixture();
  write(fx.claudeJson, JSON.stringify({ mcpServers: { memory: { command: 'mem.exe' }, stream: { type: 'sse', url: 'https://e/sse' }, keyed: { command: 'x', env: { T: '${TOKEN}' } } } }));
  const overlayRoot = path.join(fx.root, 'overlay-codex');
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  const result = syncOverlay({ cli: 'codex', overlayRoot, setup });
  assert.deepEqual(result.servers.sort(), ['docs', 'memory']);
  assert.deepEqual(
    result.skipped.filter((s) => s.kind === 'mcp').map((s) => `${s.name}:${s.reason}`).sort(),
    ['keyed:env-placeholder', 'stream:sse-unsupported'],
  );
});

test('a loose .md in a skill group folder is a skill only when it has skill frontmatter', () => {
  const fx = makeFixture();
  write(path.join(fx.claudeHome, 'skills', 'learned', 'README.md'), '# notes, not a skill');
  const setup = readClaudeSetup({ claudeHome: fx.claudeHome, claudeJson: fx.claudeJson });
  assert.ok(!setup.personalSkills.some((s) => s.name === 'README'));
});

test('syncOverlay rejects an unknown cli and a relative overlay root', () => {
  const setup = { globalMd: '', rules: [], personalSkills: [], plugins: [], mcpServers: {} };
  assert.equal(syncOverlay({ cli: 'vim', overlayRoot: os.tmpdir(), setup }).reason, 'unknown-cli');
  assert.equal(syncOverlay({ cli: 'codex', overlayRoot: 'relative/dir', setup }).reason, 'invalid-root');
});

test('overlayEnv maps each cli to its home variable', () => {
  assert.deepEqual(overlayEnv('gemini', '/o'), { GEMINI_CLI_HOME: '/o' });
  assert.deepEqual(overlayEnv('codex', '/o'), { CODEX_HOME: '/o' });
  assert.equal(overlayEnv('claude', '/o'), null);
});
