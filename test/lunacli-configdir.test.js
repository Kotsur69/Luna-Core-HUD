// ============================================================================
// LunaCore - which config folder `node scripts/luna.js` works on
// (scripts/luna.js resolveConfigDir)
// ----------------------------------------------------------------------------
// --dir, then LUNA_CONFIG_DIR, then the clone's config/ when the script runs
// from a git clone whose mirror holds memories, else the installed folder.
// Every path is a temp folder: the real %APPDATA% is never looked at.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveConfigDir, installedConfigDir } = require('../scripts/luna.js');
const { writeRecord } = require('../src/memorystore.js');
const { memoryPaths } = require('../src/memorysync.js');

const PROJECT = 'github.com/acme/hud';

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-cfgdir-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const clone = path.join(base, 'clone', 'config');
  const installed = path.join(base, 'AppData', 'LunaCore', 'config');
  fs.mkdirSync(clone, { recursive: true });
  const warnings = [];
  /** resolveConfigDir with everything injected; `over` replaces a part. */
  const resolve = (flag, over = {}) => resolveConfigDir(flag, { env: {}, installed, clone, isClone: true, warn: (line) => warnings.push(line), ...over });
  return { base, clone, installed, warnings, resolve };
}

/** Writes one valid memory into a config folder's mirror. */
function addMemory(configDir, id = 'retry-busy') {
  writeRecord(memoryPaths(configDir).dir, {
    id,
    type: 'gotcha',
    project: PROJECT,
    title: `Title of ${id}`,
    created: '2026-11-12',
    confidence: 'confirmed',
    supersedes: [],
    links: [],
    body: `Body of ${id}.`,
  });
}

test('--dir wins over the env var and over folders that hold memories, without a warning', (t) => {
  const s = setup(t);
  addMemory(s.clone);
  addMemory(s.installed);
  const picked = path.join(s.base, 'picked');

  assert.equal(s.resolve(picked, { env: { LUNA_CONFIG_DIR: path.join(s.base, 'env') } }), path.resolve(picked));
  assert.deepEqual(s.warnings, []);
});

test('LUNA_CONFIG_DIR wins when there is no --dir', (t) => {
  const s = setup(t);
  addMemory(s.clone);
  addMemory(s.installed);
  const fromEnv = path.join(s.base, 'env');

  assert.equal(s.resolve(undefined, { env: { LUNA_CONFIG_DIR: fromEnv } }), path.resolve(fromEnv));
  assert.deepEqual(s.warnings, []);
});

test('a clone with memories is used over an installed folder that exists but is empty', (t) => {
  const s = setup(t);
  addMemory(s.clone);
  fs.mkdirSync(s.installed, { recursive: true });

  assert.equal(s.resolve(undefined), path.resolve(s.clone));
  assert.deepEqual(s.warnings, []);
});

test('an empty clone falls back to the installed folder with memories', (t) => {
  const s = setup(t);
  addMemory(s.installed);

  assert.equal(s.resolve(undefined), path.resolve(s.installed));
  assert.deepEqual(s.warnings, []);
});

test('when both folders hold memories the clone is used and one line names both', (t) => {
  const s = setup(t);
  addMemory(s.clone);
  addMemory(s.installed);

  assert.equal(s.resolve(undefined), path.resolve(s.clone));
  assert.equal(s.warnings.length, 1);
  assert.ok(s.warnings[0].includes(`${path.resolve(s.clone)} (used)`), s.warnings[0]);
  assert.ok(s.warnings[0].includes(`${path.resolve(s.installed)} (not used)`), s.warnings[0]);
});

test('outside a git clone the installed folder is used, and memories in both are still reported', (t) => {
  const s = setup(t);
  addMemory(s.clone);
  addMemory(s.installed);

  assert.equal(s.resolve(undefined, { isClone: false }), path.resolve(s.installed));
  assert.equal(s.warnings.length, 1);
  assert.ok(s.warnings[0].includes(`${path.resolve(s.installed)} (used)`), s.warnings[0]);
});

test('with no memories anywhere and no installed LunaCore the clone config/ is used', (t) => {
  const s = setup(t);

  assert.equal(s.resolve(undefined), path.resolve(s.clone));
  assert.deepEqual(s.warnings, []);
});

test('a clone mirror holding only broken files does not count as memories', (t) => {
  const s = setup(t);
  const dir = path.join(memoryPaths(s.clone).dir, 'global');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.md'), 'no frontmatter here\n');
  addMemory(s.installed);

  assert.equal(s.resolve(undefined), path.resolve(s.installed));
});

test('the installed folder follows the platform convention', () => {
  const home = path.join(path.sep, 'home', 'mati');

  assert.equal(installedConfigDir({ env: { APPDATA: path.join('C:', 'Roaming') }, home, platform: 'win32' }), path.join('C:', 'Roaming', 'LunaCore', 'config'));
  assert.equal(installedConfigDir({ env: {}, home, platform: 'win32' }), path.join(home, 'AppData', 'Roaming', 'LunaCore', 'config'));
  assert.equal(installedConfigDir({ env: {}, home, platform: 'darwin' }), path.join(home, 'Library', 'Application Support', 'LunaCore', 'config'));
  assert.equal(installedConfigDir({ env: { XDG_CONFIG_HOME: path.join(home, 'xdg') }, home, platform: 'linux' }), path.join(home, 'xdg', 'LunaCore', 'config'));
  assert.equal(installedConfigDir({ env: {}, home, platform: 'linux' }), path.join(home, '.config', 'LunaCore', 'config'));
});
