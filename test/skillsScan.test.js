// Tests for the skill disk scan (scanSkills). It must list what a Claude Code
// session really loads: ~/.claude/skills/<name>/SKILL.md plus the skill paths of
// ENABLED plugins - not every SKILL.md that happens to sit in the plugin cache.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanSkills } = require('../src/skills');

/** Writes a file, creating its parent folders. */
function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const skillMd = (name, description = 'does things') => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;

/** Names in a scan result, sorted. */
function names(scan) {
  return scan.categories.flatMap((c) => c.skills.map((s) => s.name)).sort();
}

/**
 * A fake ~/.claude with:
 *  - user skill `mine`, plus nested synced/learned skills that Claude Code does not load
 *  - `alpha@mkt` enabled, default ./skills layout, and an OLD cached version beside it
 *  - `beta@mkt` installed but disabled
 *  - `gamma@mkt` enabled, plugin.json pointing at a custom skills folder
 *  - `docs@anth` enabled, no plugin.json, marketplace entry (strict:false) picking 2 of 3 skills
 *  - `evil@mkt` enabled, plugin.json path escaping its install folder
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-skills-'));
  const cache = path.join(dir, 'plugins', 'cache');
  const alpha = path.join(cache, 'mkt', 'alpha', '2.0.0');
  const alphaOld = path.join(cache, 'mkt', 'alpha', '1.0.0');
  const beta = path.join(cache, 'mkt', 'beta', '1.0.0');
  const gamma = path.join(cache, 'mkt', 'gamma', '1.0.0');
  const docs = path.join(cache, 'anth', 'docs', 'abc');
  const evil = path.join(cache, 'mkt', 'evil', '1.0.0');

  put(path.join(dir, 'skills', 'mine', 'SKILL.md'), skillMd('mine'));
  put(path.join(dir, 'skills', 'synced', 'uuid', 'xlsx', 'SKILL.md'), skillMd('xlsx'));
  put(path.join(dir, 'skills', 'learned', 'deep', 'SKILL.md'), skillMd('deep'));

  put(path.join(alpha, 'skills', 'one', 'SKILL.md'), skillMd('one'));
  put(path.join(alpha, 'skills', 'two', 'SKILL.md'), skillMd('two'));
  put(path.join(alpha, '.codex', 'skills', 'one', 'SKILL.md'), skillMd('one-codex-copy'));
  put(path.join(alphaOld, 'skills', 'stale', 'SKILL.md'), skillMd('stale'));
  put(path.join(beta, 'skills', 'off', 'SKILL.md'), skillMd('off'));
  put(path.join(gamma, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'gamma', skills: './.claude/skills/' }));
  put(path.join(gamma, '.claude', 'skills', 'g1', 'SKILL.md'), skillMd('g1'));
  put(path.join(gamma, 'skills', 'ignored', 'SKILL.md'), skillMd('ignored'));
  put(
    path.join(docs, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      plugins: [
        { name: 'docs', strict: false, skills: ['./skills/pdf', './skills/xlsx'] },
        { name: 'examples', strict: false, skills: ['./skills/art'] },
      ],
    }),
  );
  for (const s of ['pdf', 'xlsx', 'art']) put(path.join(docs, 'skills', s, 'SKILL.md'), skillMd(s));
  put(path.join(evil, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'evil', skills: ['../../../../../skills/'] }));

  const entry = (installPath) => [{ scope: 'user', installPath, version: 'x' }];
  put(
    path.join(dir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'alpha@mkt': entry(alpha),
        'beta@mkt': entry(beta),
        'gamma@mkt': entry(gamma),
        'docs@anth': entry(docs),
        'evil@mkt': entry(evil),
      },
    }),
  );
  put(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      enabledPlugins: { 'alpha@mkt': true, 'beta@mkt': false, 'gamma@mkt': true, 'docs@anth': true, 'evil@mkt': true },
    }),
  );
  return dir;
}

test('scanSkills lists only skills a session really loads', async () => {
  const dir = fixture();
  try {
    const scan = await scanSkills({ claudeDir: dir });
    assert.deepEqual(names(scan), ['alpha:one', 'alpha:two', 'docs:pdf', 'docs:xlsx', 'gamma:g1', 'mine']);
    assert.equal(scan.total, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings.local.json can enable or disable a plugin on top of settings.json', async () => {
  const dir = fixture();
  try {
    put(path.join(dir, 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'alpha@mkt': false, 'beta@mkt': true } }));
    const got = names(await scanSkills({ claudeDir: dir }));
    assert.ok(got.includes('beta:off'));
    assert.ok(!got.includes('alpha:one'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken settings.json still lists the user skills', async () => {
  const dir = fixture();
  try {
    put(path.join(dir, 'settings.json'), '{ not json');
    const scan = await scanSkills({ claudeDir: dir, log: () => {} });
    assert.deepEqual(names(scan), ['mine']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a linked user skill folder (junction/symlink) is listed', async () => {
  const dir = fixture();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-skill-target-'));
  try {
    put(path.join(target, 'SKILL.md'), skillMd('linked'));
    // A junction needs no admin rights on Windows; elsewhere the type is ignored.
    fs.symlinkSync(target, path.join(dir, 'skills', 'linked'), 'junction');
    assert.ok(names(await scanSkills({ claudeDir: dir })).includes('linked'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('a plugin key whose marketplace name climbs out is not followed', async () => {
  const dir = fixture();
  try {
    const sneaky = path.join(dir, 'plugins', 'cache', 'x', 'sneaky', '1');
    put(path.join(sneaky, 'skills', 'ok', 'SKILL.md'), skillMd('ok'));
    put(path.join(dir, 'outside', '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'sneaky', skills: ['../../../../outside'] }] }));
    const registry = JSON.parse(fs.readFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'utf8'));
    registry.plugins['sneaky@../../outside'] = [{ scope: 'user', installPath: sneaky }];
    put(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify(registry));
    put(path.join(dir, 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'sneaky@../../outside': true } }));
    const got = names(await scanSkills({ claudeDir: dir }));
    // The hostile catalog is never read, so the plugin falls back to ./skills.
    assert.ok(got.includes('sneaky:ok'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing config folder yields an empty list, not a crash', async () => {
  const scan = await scanSkills({ claudeDir: path.join(os.tmpdir(), 'luna-skills-does-not-exist') });
  assert.deepEqual(scan, { categories: [], total: 0 });
});
