// ============================================================================
// LunaCore - Luna sync launch glue (src/lunasynclaunch.js)
// ----------------------------------------------------------------------------
// Which tabs get an overlay (only a native Codex/Gemini profile with the switch
// on), and the picked-plugin-skills list the renderer may write - validated
// here because it arrives over IPC.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizePickedSkills,
  loadLunaSyncPrefs,
  saveLunaSyncPrefs,
  lunaLaunchFor,
} = require('../src/lunasynclaunch');

const NATIVE_GEMINI = { id: 'gemini-cli', wireVia: 'native', command: 'gemini' };
const DIRECT_GLM = { id: 'glm', wireVia: 'direct', command: '' };

// An empty Claude setup, so the overlay fingerprint never walks the real ~/.claude.
const NO_CLAUDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lunasynclaunch-home-'));
const NO_CLAUDE = { claudeHome: path.join(NO_CLAUDE_DIR, '.claude'), claudeJson: path.join(NO_CLAUDE_DIR, '.claude.json') };

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lunasynclaunch-')), 'lunasync.local.json');
}

test('normalizePickedSkills keeps unique plugin:skill ids and drops junk', () => {
  assert.deepEqual(
    normalizePickedSkills(['ecc:tdd-workflow', 'ecc:tdd-workflow', 'bad', '../x:y', 'a:b/c', 42, null, 'ui-ux-pro-max:design']),
    ['ecc:tdd-workflow', 'ui-ux-pro-max:design'],
  );
  assert.deepEqual(normalizePickedSkills('nope'), []);
  assert.equal(normalizePickedSkills(Array.from({ length: 900 }, (_, i) => `p:s${i}`)).length, 500);
});

test('loadLunaSyncPrefs falls back to an empty list for a missing or broken file', () => {
  const file = tmpFile();
  assert.deepEqual(loadLunaSyncPrefs(file), { pickedSkills: [] });
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(loadLunaSyncPrefs(file), { pickedSkills: [] });
});

test('saveLunaSyncPrefs validates before writing and round-trips', () => {
  const file = tmpFile();
  const saved = saveLunaSyncPrefs({ pickedSkills: ['ecc:tdd-workflow', '../evil:x'] }, file);
  assert.deepEqual(saved, { ok: true, prefs: { pickedSkills: ['ecc:tdd-workflow'] } });
  assert.deepEqual(loadLunaSyncPrefs(file), { pickedSkills: ['ecc:tdd-workflow'] });
});

test('lunaLaunchFor is null unless a native profile has the switch on', () => {
  const calls = [];
  const deps = { readSetup: () => ({}), sync: (args) => (calls.push(args), { ok: true, env: {} }) };
  const base = path.join(os.tmpdir(), 'luna-overlay');
  assert.equal(lunaLaunchFor({ ...NO_CLAUDE, profile: { lunaSync: false }, template: NATIVE_GEMINI, overlayBase: base, ...deps }), null);
  assert.equal(lunaLaunchFor({ ...NO_CLAUDE, profile: { lunaSync: true }, template: DIRECT_GLM, overlayBase: base, ...deps }), null);
  assert.equal(lunaLaunchFor({ ...NO_CLAUDE, profile: { lunaSync: true }, template: null, overlayBase: base, ...deps }), null);
  assert.equal(lunaLaunchFor({ ...NO_CLAUDE, profile: { lunaSync: true }, template: { ...NATIVE_GEMINI, command: 'aider' }, overlayBase: base, ...deps }), null);
  assert.equal(calls.length, 0, 'no sync ran');
});

test('lunaLaunchFor syncs the CLI overlay under the base dir with the picked skills', () => {
  const calls = [];
  const setup = { marker: 1 };
  const base = path.join(os.tmpdir(), 'luna-overlay');
  const result = lunaLaunchFor({ ...NO_CLAUDE,
    profile: { lunaSync: true },
    template: NATIVE_GEMINI,
    overlayBase: base,
    pickedSkillIds: ['ecc:tdd-workflow'],
    readSetup: () => setup,
    sync: (args) => (calls.push(args), { ok: true, env: { GEMINI_CLI_HOME: args.overlayRoot } }),
  });
  assert.deepEqual(result, { ok: true, env: { GEMINI_CLI_HOME: path.join(base, 'gemini') } });
  assert.deepEqual(calls, [{ cli: 'gemini', overlayRoot: path.join(base, 'gemini'), setup, pickedSkillIds: ['ecc:tdd-workflow'] }]);
});

test('lunaSyncNotice says what loaded, or why nothing did, in the UI language', () => {
  const { lunaSyncNotice } = require('../src/lunasynclaunch');
  const ok = { ok: true, skills: ['a', 'b'], servers: ['m'], skipped: [{ kind: 'mcp', name: 'x', reason: 'sse-unsupported' }] };
  const en = lunaSyncNotice(ok, 'en');
  assert.match(en, /Luna setup/);
  assert.match(en, /2 skills/);
  assert.match(en, /1 MCP/);
  assert.match(en, /1 skipped/);
  assert.match(lunaSyncNotice(ok, 'pl'), /2 skill/);
  const fail = lunaSyncNotice({ ok: false, reason: 'overlay-damaged' }, 'en');
  assert.match(fail, /not loaded/i);
  assert.match(fail, /overlay-damaged/);
  assert.ok(en.endsWith('\r\n'), 'a whole terminal line');
});

test('lunaSyncNotice names the MCP servers that may run in the tab', () => {
  const { lunaSyncNotice } = require('../src/lunasynclaunch');
  const line = lunaSyncNotice({ ok: true, skills: [], servers: ['shadcn', 'evil\x1b[31m'], skipped: [] }, 'en');
  assert.match(line, /\(shadcn\)/);
  assert.doesNotMatch(line, /\x1b\[31m/, 'no escape sequence from a server name');
});

test('a gateway-home template always gets its own home, with the Luna setup only when switched on', () => {
  const calls = [];
  const sync = (args) => (calls.push(args), { ok: true, env: { GEMINI_CLI_HOME: args.overlayRoot } });
  const base = path.join(os.tmpdir(), 'luna-overlay');
  const template = { id: 'freellm-gemini', wireVia: 'native', command: 'gemini', gatewayHome: true };
  const off = lunaLaunchFor({ ...NO_CLAUDE, profile: { lunaSync: false }, template, overlayBase: base, readSetup: () => ({ full: 1 }), sync });
  assert.deepEqual(off.env, { GEMINI_CLI_HOME: path.join(base, 'gemini-freellm-gemini') });
  assert.deepEqual(calls[0].setup, { globalMd: '', rules: [], personalSkills: [], plugins: [], mcpServers: {} });
  assert.equal(calls[0].geminiAuthType, 'gemini-api-key');
  lunaLaunchFor({ ...NO_CLAUDE, profile: { lunaSync: true }, template, overlayBase: base, readSetup: () => ({ full: 1 }), sync });
  assert.deepEqual(calls[1].setup, { full: 1 });
  assert.equal(calls[1].overlayRoot, path.join(base, 'gemini-freellm-gemini'));
});

// ---- project MCP servers (src/lunasyncproject.js) ---------------------------------

test('lunaLaunchFor layers the project servers on top of the shared overlay result', () => {
  const calls = [];
  const base = path.join(os.tmpdir(), 'luna-overlay');
  const projectDir = path.join(os.tmpdir(), 'some-project');
  const result = lunaLaunchFor({ ...NO_CLAUDE,
    profile: { lunaSync: true, args: ['-c', 'x=1'] },
    template: { id: 'codex-cli', wireVia: 'native', command: 'codex' },
    overlayBase: base,
    projectDir,
    readSetup: () => ({}),
    sync: (args) => ({ ok: true, env: { CODEX_HOME: args.overlayRoot }, skills: [], servers: ['user1'], skipped: [{ kind: 'connector', name: 'claude.ai Gmail', reason: 'connector-auth' }] }),
    projectLayer: (args) => (calls.push(args), { args: ['--profile', 'luna0123456789ab'], servers: ['proj1'], skipped: [{ kind: 'mcp', name: 'p2', reason: 'not-approved' }] }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectDir, projectDir);
  assert.equal(calls[0].overlayRoot, path.join(base, 'codex'));
  assert.deepEqual(calls[0].baseServers, ['user1']);
  assert.deepEqual(calls[0].profileArgs, ['-c', 'x=1']);
  assert.deepEqual(result.args, ['--profile', 'luna0123456789ab']);
  assert.deepEqual(result.projectServers, ['proj1']);
  assert.deepEqual(result.env, { CODEX_HOME: path.join(base, 'codex') });
  assert.deepEqual(result.skipped.map((s) => s.reason), ['connector-auth', 'not-approved']);
});

test('lunaLaunchFor only clears the project layer with the switch off, and skips it without a folder or after a failed sync', () => {
  const calls = [];
  const base = path.join(os.tmpdir(), 'luna-overlay');
  const projectLayer = (args) => (calls.push(args), { servers: ['x'], skipped: [] });
  const gateway = { id: 'freellm-gemini', wireVia: 'native', command: 'gemini', gatewayHome: true };
  const ok = (args) => ({ ok: true, env: { GEMINI_CLI_HOME: args.overlayRoot }, skills: [], servers: [], skipped: [] });
  lunaLaunchFor({ ...NO_CLAUDE, profile: { lunaSync: false }, template: gateway, overlayBase: base, projectDir: os.tmpdir(), readSetup: () => ({}), sync: ok, projectLayer });
  lunaLaunchFor({ ...NO_CLAUDE, profile: { lunaSync: true }, template: NATIVE_GEMINI, overlayBase: base, projectDir: null, readSetup: () => ({}), sync: ok, projectLayer });
  const failed = lunaLaunchFor({ ...NO_CLAUDE, profile: { lunaSync: true }, template: NATIVE_GEMINI, overlayBase: path.join(base, 'f'), projectDir: os.tmpdir(), readSetup: () => ({}), sync: () => ({ ok: false, reason: 'write-failed' }), projectLayer });
  // Switch off: only a clear of this folder's layer (a gateway home keeps running on the overlay).
  assert.equal(calls.length, 1);
  assert.equal(calls[0].clear, true);
  assert.equal(calls[0].projectDir, os.tmpdir());
  assert.equal(failed.ok, false);
});

test('lunaSyncNotice lists project servers and names every skip with its reason', () => {
  const { lunaSyncNotice } = require('../src/lunasynclaunch');
  const result = {
    ok: true,
    skills: [],
    servers: ['shadcn'],
    projectServers: ['github', 'context7'],
    skipped: [
      { kind: 'connector', name: 'claude.ai Gmail', reason: 'connector-auth' },
      { kind: 'connector', name: 'claude.ai Drive\x1b[31m', reason: 'connector-auth' },
      { kind: 'mcp', name: 'supabase', reason: 'env-placeholder' },
      { kind: 'mcp', name: 'odd', reason: 'project-write-failed:EPERM' },
    ],
  };
  const en = lunaSyncNotice(result, 'en');
  const lines = en.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /1 MCP servers \(shadcn\), project: 2 \(github, context7\), 4 skipped/);
  assert.match(lines[1], /Skipped: claude\.ai Gmail, claude\.ai Drive31m \(claude\.ai connector - its login stays with Claude\); supabase \(\$\{VAR\} this CLI cannot fill\); odd \(could not write the project layer\)/);
  assert.doesNotMatch(en, /\x1b\[31m/);
  const pl = lunaSyncNotice(result, 'pl');
  assert.match(pl, /projekt: 2/);
  assert.match(pl, /Pominieto: .*logowanie zostaje w Claude/);
  assert.equal(lunaSyncNotice({ ok: true, skills: [], servers: [], skipped: [] }, 'en').split('\r\n').filter(Boolean).length, 1, 'no skip line when nothing was skipped');
});
