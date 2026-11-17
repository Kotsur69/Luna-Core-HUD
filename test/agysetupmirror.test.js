// ============================================================================
// LunaCore - Claude setup -> Antigravity (agy) mirror (src/agysetupmirror.js)
// ----------------------------------------------------------------------------
// Runs against a throwaway home dir: a fake ~/.claude (CLAUDE.md, rules,
// skills, ~/.claude.json) and a fake ~/.gemini/config. Pinned: the managed
// block in AGENTS.md is inserted, replaced and never touches user text; MCP
// servers LunaCore owns are merged, replaced and removed while the user's stay;
// a broken JSON file is refused untouched; the first write makes a backup; a
// second run changes nothing; skills of the previous profile are removed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAgyMirror, mergeMcpConfig, isPathScoped } = require('../src/agysetupmirror');

const START = '<!-- lunacore:start';
const END = '<!-- lunacore:end -->';

const homes = [];
test.after(async () => {
  await Promise.all(homes.map((h) => fs.promises.rm(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

/** A fresh temp home with agy installed (an empty ~/.gemini/config) unless told otherwise. */
function makeHome({ agy = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agymirror-'));
  homes.push(home);
  if (agy) fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  return home;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const read = (file) => fs.readFileSync(file, 'utf8');
const readJson = (file) => JSON.parse(read(file));

/** A Claude setup: global instructions, one always-on and one path-scoped rule, skills, servers. */
function claudeSetup(home, { md = '# Global\nCall me Mati.\n', servers, skills = ['alpha', 'beta'], profile = 'coding' } = {}) {
  const claude = path.join(home, '.claude');
  write(path.join(claude, 'CLAUDE.md'), md);
  write(path.join(claude, 'rules', 'luna', 'engineering.md'), '# Engineering rules\nSmall diffs.\n');
  write(path.join(claude, 'rules', 'ecc', 'ts.md'), '---\npaths:\n  - "**/*.ts"\n---\n# TS style\n');
  fs.rmSync(path.join(claude, 'skills'), { recursive: true, force: true });
  for (const name of skills) write(path.join(claude, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`);
  const mcpServers = servers || {
    supabase: { type: 'http', url: 'https://mcp.example.test/mcp' },
    files: { type: 'stdio', command: 'npx', args: ['-y', 'files-mcp'], env: { MODE: 'ro' } },
  };
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers, otherKey: 1 }));
  write(path.join(claude, 'luna-setup', 'state.json'), JSON.stringify({ profile }));
}

function mirrorFor(home, extra = {}) {
  const logs = [];
  const mirror = createAgyMirror({
    home,
    settingsFile: path.join(home, 'lunacore-config', 'agy-mirror.local.json'),
    now: () => new Date('2026-11-16T12:00:00Z'),
    log: (line) => logs.push(line),
    ...extra,
  });
  return { mirror, logs, p: mirror.paths };
}

// ---- pure helpers ----------------------------------------------------------------

test('isPathScoped: only frontmatter with a paths key', () => {
  assert.equal(isPathScoped('---\npaths:\n  - "**/*.ts"\n---\n# x'), true);
  assert.equal(isPathScoped('---\r\nname: a\r\npaths: ["x"]\r\n---\r\nbody'), true);
  assert.equal(isPathScoped('# Rules\npaths: not frontmatter'), false);
  assert.equal(isPathScoped('---\nname: a\n---\npaths: in body'), false);
});

test('mergeMcpConfig: replaces owned, keeps user entries, refuses taken names', () => {
  const existing = {
    mcpServers: { mine: { command: 'user-cmd' }, old: { command: 'gone' }, kept: { url: 'https://x.test/mcp', disabled: true } },
    otherKey: true,
  };
  const servers = {
    kept: { kind: 'http', url: 'https://new.test/mcp', headers: {} },
    mine: { kind: 'stdio', command: 'luna', args: [], env: {} },
    legacy: { kind: 'sse', url: 'https://sse.test/sse', headers: {} },
  };
  const res = mergeMcpConfig(existing, servers, ['old', 'kept']);
  assert.deepEqual(res.config.mcpServers, {
    mine: { command: 'user-cmd' },
    kept: { url: 'https://new.test/mcp', disabled: true },
  });
  assert.equal(res.config.otherKey, true);
  assert.deepEqual(res.written, ['kept']);
  assert.deepEqual(res.skipped, [
    { kind: 'mcp', name: 'mine', reason: 'name-taken' },
    { kind: 'mcp', name: 'legacy', reason: 'sse-unsupported' },
  ]);
});

test('mergeMcpConfig: a "__proto__" server name stays a plain key', () => {
  const existing = JSON.parse('{"mcpServers":{"__proto__":{"command":"x"}}}');
  const res = mergeMcpConfig(existing, {}, []);
  assert.ok(Object.prototype.hasOwnProperty.call(res.config.mcpServers, '__proto__'));
  assert.equal(Object.getPrototypeOf(res.config.mcpServers), Object.prototype);
});

// ---- the sync against a temp home --------------------------------------------------

test('first sync: managed block, MCP servers, skills and the manifest', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror, p } = mirrorFor(home);

  const res = mirror.sync('coding');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.profile, 'coding');
  assert.deepEqual(res.servers.sort(), ['files', 'supabase']);
  assert.deepEqual(res.skills.sort(), ['alpha', 'beta']);

  const rules = read(p.rules);
  assert.ok(rules.startsWith(START));
  assert.match(rules, /Call me Mati\./);
  assert.match(rules, /Small diffs\./, 'an always-on rule is inline');
  assert.doesNotMatch(rules, /# TS style/, 'a path-scoped rule is not inline');
  assert.match(rules, /ecc\/ts\.md: .*\.claude\/rules\/ecc\/ts\.md/, 'a path-scoped rule is referenced');

  const mcp = readJson(p.mcp);
  assert.deepEqual(mcp.mcpServers.supabase, { url: 'https://mcp.example.test/mcp' });
  assert.deepEqual(mcp.mcpServers.files, { command: 'npx', args: ['-y', 'files-mcp'], env: { MODE: 'ro' } });

  assert.ok(fs.existsSync(path.join(p.skills, 'alpha', 'SKILL.md')));
  const manifest = readJson(p.manifest);
  assert.equal(manifest.profile, 'coding');
  assert.equal(manifest.mirroredAt, '2026-11-16T12:00:00.000Z');
  assert.deepEqual(manifest.servers.sort(), ['files', 'supabase']);
});

test('user text around the block survives, and a re-sync replaces only the block', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror, p } = mirrorFor(home);
  write(p.rules, '# My own agy rules\nAlways answer in haiku.\n');

  assert.equal(mirror.sync('coding').ok, true);
  let text = read(p.rules);
  assert.ok(text.startsWith(START), 'the block goes on top');
  assert.match(text, /Always answer in haiku\./);

  claudeSetup(home, { md: '# Global\nMinimal profile now.\n', profile: 'minimal' });
  write(p.rules, `${read(p.rules)}\nA line the user added later.\n`);
  assert.equal(mirror.sync('minimal').ok, true);
  text = read(p.rules);
  assert.match(text, /Minimal profile now\./);
  assert.doesNotMatch(text, /Call me Mati/);
  assert.match(text, /Always answer in haiku\./);
  assert.match(text, /A line the user added later\./);
  assert.equal(text.split(START).length, 2, 'exactly one managed block');
  assert.equal(text.split(END).length, 2);
});

test('a block whose end marker was deleted is refused and the file is left alone', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror, p } = mirrorFor(home);
  const damaged = `${START} (managed) -->\nhalf a block\nuser text\n`;
  write(p.rules, damaged);
  write(p.mcp, '{"mcpServers":{}}');

  const res = mirror.sync('coding');
  assert.deepEqual(res, { ok: false, error: 'block-damaged', detail: 'AGENTS.md' });
  assert.equal(read(p.rules), damaged);
  assert.equal(read(p.mcp), '{"mcpServers":{}}', 'nothing is written when any part is refused');
  assert.equal(fs.existsSync(p.manifest), false);
});

test('MCP: user servers stay, managed ones are replaced and removed with the profile', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror, p } = mirrorFor(home);
  write(p.mcp, JSON.stringify({ mcpServers: { userOwn: { command: 'mine' }, supabase: { url: 'https://user.test/mcp' } } }));

  let res = mirror.sync('coding');
  assert.equal(res.ok, true);
  assert.deepEqual(res.servers, ['files']);
  assert.deepEqual(res.skipped.filter((s) => s.kind === 'mcp'), [{ kind: 'mcp', name: 'supabase', reason: 'name-taken' }]);
  let servers = readJson(p.mcp).mcpServers;
  assert.deepEqual(servers.supabase, { url: 'https://user.test/mcp' }, 'a server the user already had is not overwritten');
  assert.deepEqual(servers.userOwn, { command: 'mine' });

  // agy's own `mcp disable` on a managed server survives a re-sync.
  write(p.mcp, JSON.stringify({ mcpServers: { ...servers, files: { ...servers.files, disabled: true } } }));
  claudeSetup(home, {
    servers: { files: { command: 'npx', args: ['files-mcp@2'] }, fresh: { type: 'http', url: 'https://fresh.test/mcp' } },
    profile: 'gamedev',
  });
  res = mirror.sync('gamedev');
  assert.equal(res.ok, true);
  servers = readJson(p.mcp).mcpServers;
  assert.deepEqual(servers.files, { command: 'npx', args: ['files-mcp@2'], disabled: true });
  assert.deepEqual(servers.fresh, { url: 'https://fresh.test/mcp' });

  claudeSetup(home, { servers: {}, profile: 'minimal' });
  res = mirror.sync('minimal');
  assert.equal(res.ok, true);
  servers = readJson(p.mcp).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['supabase', 'userOwn'], 'managed servers go, user servers stay');
  assert.deepEqual(readJson(p.manifest).servers, []);
});

test('a broken mcp_config.json is refused, not overwritten', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror, p, logs } = mirrorFor(home);
  write(p.mcp, '{ "mcpServers": { "a": { "command": "x" }, }');

  const res = mirror.sync('coding');
  assert.deepEqual(res, { ok: false, error: 'broken-json', detail: 'mcp_config.json' });
  assert.equal(read(p.mcp), '{ "mcpServers": { "a": { "command": "x" }, }');
  assert.equal(fs.existsSync(p.rules), false, 'no file is written when one target is refused');
  assert.ok(logs.some((l) => /broken-json/.test(l)));
  assert.deepEqual(mirror.status().lastError, { error: 'broken-json', detail: 'mcp_config.json' });
});

test('mcpServers that is not an object, and a broken manifest, are refused too', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror, p } = mirrorFor(home);
  write(p.mcp, '{"mcpServers":[]}');
  assert.deepEqual(mirror.sync('coding'), { ok: false, error: 'broken-json', detail: 'mcp_config.json' });
  write(p.mcp, '{}');
  write(p.manifest, 'not json');
  assert.deepEqual(mirror.sync('coding'), { ok: false, error: 'broken-json', detail: '.lunacore-mirror.json' });
  assert.equal(read(p.mcp), '{}');
});

test('a broken ~/.claude.json is refused, so managed servers are not dropped by mistake', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror, p } = mirrorFor(home);
  assert.equal(mirror.sync('coding').ok, true);
  const before = read(p.mcp);
  write(path.join(home, '.claude.json'), '{"mcpServers": {');
  assert.deepEqual(mirror.sync('coding'), { ok: false, error: 'source-unreadable', detail: '.claude.json' });
  assert.equal(read(p.mcp), before);
});

test('the first write of an existing file makes a backup, once', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror, p } = mirrorFor(home);
  write(p.rules, 'original rules\n');
  write(p.mcp, '');

  const res = mirror.sync('coding');
  assert.equal(res.ok, true);
  const rulesBak = path.join(home, '.gemini', 'lunacore-backup', 'config__AGENTS.md.bak');
  const mcpBak = path.join(home, '.gemini', 'lunacore-backup', 'config__mcp_config.json.bak');
  assert.deepEqual(res.backups.sort(), [rulesBak, mcpBak].sort());
  assert.equal(read(rulesBak), 'original rules\n');
  assert.equal(read(mcpBak), '');

  claudeSetup(home, { md: 'changed\n', profile: 'minimal' });
  const again = mirror.sync('minimal');
  assert.equal(again.ok, true);
  assert.deepEqual(again.backups, [], 'the original backup is kept, not replaced');
  assert.equal(read(rulesBak), 'original rules\n');
});

test('a new file gets no backup (there is nothing to restore)', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror } = mirrorFor(home);
  assert.deepEqual(mirror.sync('coding').backups, []);
  assert.equal(fs.existsSync(path.join(home, '.gemini', 'lunacore-backup')), false);
});

test('a re-run with the same setup changes nothing', () => {
  const home = makeHome();
  claudeSetup(home);
  write(path.join(home, '.gemini', 'config', 'AGENTS.md'), 'user text\n');
  const { mirror, p } = mirrorFor(home);
  assert.equal(mirror.sync('coding').ok, true);
  const snapshot = { rules: read(p.rules), mcp: read(p.mcp), skill: read(path.join(p.skills, 'beta', 'SKILL.md')) };
  const rulesMtime = fs.statSync(p.rules).mtimeMs;

  const again = mirror.sync('coding');
  assert.equal(again.ok, true);
  assert.deepEqual(again.skipped, []);
  assert.deepEqual({ rules: read(p.rules), mcp: read(p.mcp), skill: read(path.join(p.skills, 'beta', 'SKILL.md')) }, snapshot);
  assert.equal(fs.statSync(p.rules).mtimeMs, rulesMtime, 'an unchanged file is not rewritten');
  assert.deepEqual(fs.readdirSync(p.config).filter((n) => n.includes('lunacore-tmp')), [], 'no temp files left');
});

test('skills: the previous profile\'s are removed, the user\'s own are never touched', () => {
  const home = makeHome();
  claudeSetup(home, { skills: ['alpha', 'beta'] });
  const { mirror, p } = mirrorFor(home);
  write(path.join(p.skills, 'mine', 'SKILL.md'), 'user skill');
  write(path.join(p.skills, 'beta', 'SKILL.md'), 'user beta');

  let res = mirror.sync('coding');
  assert.deepEqual(res.skills, ['alpha']);
  assert.deepEqual(res.skipped, [{ kind: 'skill', name: 'beta', reason: 'name-taken' }]);
  assert.equal(read(path.join(p.skills, 'beta', 'SKILL.md')), 'user beta');

  claudeSetup(home, { skills: ['gamma'], profile: 'gamedev' });
  res = mirror.sync('gamedev');
  assert.deepEqual(res.skills, ['gamma']);
  assert.equal(fs.existsSync(path.join(p.skills, 'alpha')), false, 'a stale managed skill is removed');
  assert.ok(fs.existsSync(path.join(p.skills, 'gamma', 'SKILL.md')));
  assert.equal(read(path.join(p.skills, 'mine', 'SKILL.md')), 'user skill');
  assert.equal(read(path.join(p.skills, 'beta', 'SKILL.md')), 'user beta');
});

test('no agy on this machine: nothing is created', () => {
  const home = makeHome({ agy: false });
  claudeSetup(home);
  const { mirror } = mirrorFor(home);
  assert.deepEqual(mirror.sync('coding'), { ok: false, error: 'agy-not-found' });
  assert.equal(fs.existsSync(path.join(home, '.gemini')), false);
  assert.equal(mirror.isEnabled(), false, 'the default is off without agy');
});

test('agy found by its CLI data folder alone counts as installed', () => {
  const home = makeHome({ agy: false });
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  claudeSetup(home);
  const { mirror, p } = mirrorFor(home);
  assert.equal(mirror.available(), true);
  assert.equal(mirror.sync('coding').ok, true);
  assert.ok(fs.existsSync(p.mcp));
});

test('enabled: defaults to on with agy, then follows the saved setting', () => {
  const home = makeHome();
  const { mirror, logs } = mirrorFor(home);
  assert.equal(mirror.isEnabled(), true);
  mirror.setEnabled(false);
  assert.equal(mirror.isEnabled(), false);
  mirror.setEnabled(true);
  assert.equal(mirror.isEnabled(), true);
  assert.throws(() => mirror.setEnabled('yes'), TypeError);
  write(path.join(home, 'lunacore-config', 'agy-mirror.local.json'), '{broken');
  assert.equal(mirror.isEnabled(), false, 'a broken setting reads as off');
  assert.ok(logs.some((l) => /not valid/.test(l)));
});

test('manual sync reads the applied profile from luna-setup state; status reports it', () => {
  const home = makeHome();
  claudeSetup(home, { profile: 'lunawork' });
  const { mirror } = mirrorFor(home);
  assert.equal(mirror.sync().profile, 'lunawork');
  assert.deepEqual(mirror.status(), {
    ok: true,
    available: true,
    enabled: true,
    profile: 'lunawork',
    mirroredAt: '2026-11-16T12:00:00.000Z',
    lastError: null,
  });
});

test('a failed write is write-failed, leaves no temp file, and never throws', () => {
  const home = makeHome();
  claudeSetup(home);
  const failing = {
    ...fs,
    renameSync: (from, to) => {
      if (String(to).endsWith('mcp_config.json')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.renameSync(from, to);
    },
  };
  const { mirror, p } = mirrorFor(home, { fs: failing });
  const res = mirror.sync('coding');
  assert.deepEqual(res, { ok: false, error: 'write-failed', detail: 'EBUSY' });
  assert.deepEqual(fs.readdirSync(p.config).filter((n) => n.includes('lunacore-tmp')), []);
  // Ownership was recorded before the write, so the next good run cleans up.
  assert.deepEqual(readJson(p.manifest).servers.sort(), ['files', 'supabase']);
});

test('a linked skills folder or config file is refused: no deletion lands in a link target', () => {
  const home = makeHome();
  claudeSetup(home);
  const { mirror, p } = mirrorFor(home);
  const elsewhere = path.join(home, 'elsewhere-skills');
  write(path.join(elsewhere, 'alpha', 'SKILL.md'), 'not LunaCore\'s');
  // A junction needs no admin rights on Windows; elsewhere it is a dir symlink.
  fs.symlinkSync(elsewhere, p.skills, process.platform === 'win32' ? 'junction' : 'dir');
  write(p.manifest, JSON.stringify({ v: 1, servers: [], skills: ['alpha'] }));

  assert.deepEqual(mirror.sync('coding'), { ok: false, error: 'linked-folder', detail: 'config/skills' });
  assert.equal(read(path.join(elsewhere, 'alpha', 'SKILL.md')), 'not LunaCore\'s');
  assert.equal(fs.existsSync(p.mcp), false);
});

test('a skill that fails to copy is skipped and its cause is logged, not dropped', () => {
  const home = makeHome();
  claudeSetup(home, { skills: ['alpha'] });
  const { mirror, logs } = mirrorFor(home, {
    copySkills: (dir, previous, skills, opts) => {
      opts.onCopyError('alpha', Object.assign(new Error('denied'), { code: 'EACCES' }));
      return { copied: [], skipped: [{ kind: 'skill', name: 'alpha', reason: 'copy-failed' }] };
    },
  });
  const res = mirror.sync('coding');
  assert.equal(res.ok, true);
  assert.deepEqual(res.skipped, [{ kind: 'skill', name: 'alpha', reason: 'copy-failed' }]);
  assert.ok(logs.some((l) => /could not copy skill alpha: EACCES/.test(l)));
});
