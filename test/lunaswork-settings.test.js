// ============================================================================
// Luna's Work settings: global models per role, per-project overrides, the
// strict project profile, freeFallback, and the safe read / write contract.
// Disk tests use a temp file, never the real config/ directory.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../src/lunasworkSettings.js');
const { DEFAULT_MODELS } = require('../src/lunasworkRules.js');
const { DEFAULT_BUDGETS } = require('../src/lunasworkLighthouse.js');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-settings-')), 'settings.json');
const goodProfile = { adapter: 'web', startCommand: 'npm run dev', url: 'http://localhost:5173' };

// ---- defaults ---------------------------------------------------------------------

test('defaults equal lunasworkRules.DEFAULT_MODELS', () => {
  assert.deepEqual(S.defaultSettings().models, DEFAULT_MODELS);
  assert.deepEqual(S.modelsFor({}, 'any-project'), DEFAULT_MODELS);
});

test('freeFallback defaults to false and only exactly true turns it on', () => {
  assert.equal(S.defaultSettings().freeFallback, false);
  for (const junk of ['true', 1, null, {}]) {
    assert.equal(S.normalizeSettings({ freeFallback: junk }).freeFallback, false);
  }
  assert.equal(S.normalizeSettings({ freeFallback: true }).freeFallback, true);
});

// ---- models -----------------------------------------------------------------------

test('a per-project override merges over the global models', () => {
  const settings = {
    models: { playtester: 'haiku' },
    projects: { 'proj-a': { models: { builder: 'sonnet', critic: 'auto' } } },
  };
  assert.deepEqual(S.modelsFor(settings, 'proj-a'), {
    ...DEFAULT_MODELS,
    playtester: 'haiku',
    builder: 'sonnet',
    critic: 'auto',
  });
  // Another project only sees the global models.
  assert.deepEqual(S.modelsFor(settings, 'proj-b'), { ...DEFAULT_MODELS, playtester: 'haiku' });
});

test('invalid model choices and unknown roles in an override are dropped', () => {
  assert.deepEqual(S.normalizeModelOverride({ builder: 'gpt-5', wizard: 'opus', critic: 'sonnet' }), { critic: 'sonnet' });
  assert.deepEqual(S.normalizeModelOverride(null), {});
});

test('the project key matches the to-do key (missing id -> _default bucket)', () => {
  const { settings } = S.withProject({}, null, { models: { director: 'haiku' } });
  assert.ok(settings.projects._default);
  assert.equal(S.modelsFor(settings, undefined).director, 'haiku');
});

// ---- profile ----------------------------------------------------------------------

test('a valid profile is normalized with defaults filled in', () => {
  const { profile, reason } = S.validateProfile({ startCommand: '  npm start  ' });
  assert.equal(reason, null);
  assert.deepEqual(profile, {
    adapter: 'web',
    startCommand: 'npm start',
    url: S.DEFAULT_URL,
    readyTimeoutSec: S.DEFAULT_READY_TIMEOUT_SEC,
    checkCommand: '',
  });
  assert.equal(new URL(S.DEFAULT_URL).hostname, 'localhost');
});

test('profile validation rejects a bad url', () => {
  for (const url of ['not a url', 'ftp://localhost/x', 'file:///C:/x', 'javascript:alert(1)', '', 42]) {
    const r = S.validateProfile({ ...goodProfile, url });
    assert.equal(r.profile, null, `url=${String(url)}`);
    assert.match(r.reason, /url/);
  }
  assert.ok(S.validateProfile({ ...goodProfile, url: 'https://127.0.0.1:8443/app' }).profile);
});

test('profile validation rejects a timeout out of range', () => {
  for (const t of [0, -1, 601, 1.5, '60', NaN, null]) {
    const r = S.validateProfile({ ...goodProfile, readyTimeoutSec: t });
    assert.equal(r.profile, null, `timeout=${String(t)}`);
    assert.match(r.reason, /readyTimeoutSec/);
  }
  assert.equal(S.validateProfile({ ...goodProfile, readyTimeoutSec: 1 }).profile.readyTimeoutSec, 1);
  assert.equal(S.validateProfile({ ...goodProfile, readyTimeoutSec: 600 }).profile.readyTimeoutSec, 600);
});

test('profile validation rejects unknown and reserved adapters', () => {
  assert.match(S.validateProfile({ ...goodProfile, adapter: 'android' }).reason, /unknown adapter/);
  for (const adapter of S.RESERVED_ADAPTERS) {
    const r = S.validateProfile({ ...goodProfile, adapter });
    assert.equal(r.profile, null);
    assert.match(r.reason, /not supported yet/);
  }
});

test('profile validation rejects an empty or malformed startCommand', () => {
  for (const startCommand of ['', '   ', undefined, 7, 'npm run dev\nrm -rf /', 'x'.repeat(S.MAX_COMMAND_CHARS + 1)]) {
    const r = S.validateProfile({ ...goodProfile, startCommand });
    assert.equal(r.profile, null, `startCommand=${JSON.stringify(startCommand)}`);
    assert.match(r.reason, /startCommand/);
  }
});

test('profile validation rejects a malformed checkCommand and non-objects', () => {
  assert.match(S.validateProfile({ ...goodProfile, checkCommand: 'a\r\nb' }).reason, /checkCommand/);
  assert.match(S.validateProfile({ ...goodProfile, checkCommand: 5 }).reason, /checkCommand/);
  for (const junk of [null, 'npm start', [], 3]) assert.equal(S.validateProfile(junk).profile, null);
});

test('withProject sets, rejects, and removes a profile without mutating its input', () => {
  const base = S.defaultSettings();
  const frozen = JSON.stringify(base);

  const set = S.withProject(base, 'p', { profile: goodProfile });
  assert.equal(set.reason, null);
  assert.equal(S.profileFor(set.settings, 'p').startCommand, 'npm run dev');
  assert.equal(JSON.stringify(base), frozen);

  const bad = S.withProject(set.settings, 'p', { profile: { ...goodProfile, url: 'ftp://x' } });
  assert.match(bad.reason, /url/);
  assert.equal(S.profileFor(bad.settings, 'p').url, 'http://localhost:5173', 'old profile kept');

  const removed = S.withProject(set.settings, 'p', { profile: null });
  assert.equal(S.profileFor(removed.settings, 'p'), null);
});

test('an invalid stored profile is dropped on read', () => {
  const s = S.normalizeSettings({ projects: { p: { profile: { startCommand: '' }, models: { builder: 'haiku' } } } });
  assert.equal(S.profileFor(s, 'p'), null);
  assert.equal(S.modelsFor(s, 'p').builder, 'haiku');
});

test('a __proto__ project key in the file is dropped, not turned into a prototype', () => {
  const s = S.normalizeSettings(JSON.parse('{"projects":{"__proto__":{"models":{"builder":"haiku"}}}}'));
  assert.equal(Object.getPrototypeOf(s.projects), Object.prototype);
  assert.deepEqual(Object.keys(s.projects), []);
});

// ---- Lighthouse budgets + second opinion ---------------------------------------------

test('lighthouse budgets default to DEFAULT_BUDGETS; a project override merges over them', () => {
  assert.deepEqual(S.lighthouseBudgetsFor({}, 'p'), { ...DEFAULT_BUDGETS });
  const s = { projects: { p: { lighthouseBudgets: { performance: 60, seo: 70 } } } };
  assert.deepEqual(S.lighthouseBudgetsFor(s, 'p'), { ...DEFAULT_BUDGETS, performance: 60, seo: 70 });
  assert.deepEqual(S.lighthouseBudgetsFor(s, 'other'), { ...DEFAULT_BUDGETS });
});

test('lighthouse budget validation rejects unknown categories and scores out of range', () => {
  assert.deepEqual(S.validateBudgets({ accessibility: 95 }), { budgets: { accessibility: 95 }, reason: null });
  assert.match(S.validateBudgets({ speed: 50 }).reason, /unknown Lighthouse category/);
  for (const bad of [-1, 101, '90', NaN, null]) {
    assert.match(S.validateBudgets({ seo: bad }).reason, /0 to 100/);
  }
  for (const junk of [null, [], 'x', 3]) assert.equal(S.validateBudgets(junk).budgets, null);
});

test('bad stored budgets are dropped on read, the good ones kept', () => {
  const s = S.normalizeSettings({ projects: { p: { lighthouseBudgets: { seo: 50, performance: 200, bogus: 1 } } } });
  assert.deepEqual(s.projects.p.lighthouseBudgets, { seo: 50 });
  const none = S.normalizeSettings({ projects: { p: { lighthouseBudgets: { performance: 'fast' } } } });
  assert.equal(none.projects.p, undefined, 'an entry with nothing valid is dropped');
});

test('withProject sets, rejects, and removes lighthouse budgets without mutating its input', () => {
  const base = S.defaultSettings();
  const frozen = JSON.stringify(base);
  const set = S.withProject(base, 'p', { lighthouseBudgets: { performance: 70 } });
  assert.equal(set.reason, null);
  assert.equal(S.lighthouseBudgetsFor(set.settings, 'p').performance, 70);
  assert.equal(JSON.stringify(base), frozen);

  const bad = S.withProject(set.settings, 'p', { lighthouseBudgets: { performance: 170 } });
  assert.match(bad.reason, /performance/);
  assert.equal(S.lighthouseBudgetsFor(bad.settings, 'p').performance, 70, 'old budgets kept');

  const removed = S.withProject(set.settings, 'p', { lighthouseBudgets: null });
  assert.equal(S.lighthouseBudgetsFor(removed.settings, 'p').performance, DEFAULT_BUDGETS.performance);
});

test('the second-opinion CLI order is off by default and keeps known CLIs once, in order', () => {
  assert.deepEqual(S.defaultSettings().secondOpinionOrder, []);
  assert.deepEqual(S.normalizeSettings({ secondOpinionOrder: ['gemini', 'rm -rf', 'gemini', 'codex'] }).secondOpinionOrder, ['gemini', 'codex']);
  for (const junk of ['codex', null, {}, [1, 2]]) assert.deepEqual(S.normalizeSettings({ secondOpinionOrder: junk }).secondOpinionOrder, []);
  // Prototype names are no CLI.
  assert.deepEqual(S.normalizeCliOrder(['constructor', '__proto__', 'toString']), []);
});

// ---- disk -------------------------------------------------------------------------

test('a missing file reads as defaults', () => {
  assert.deepEqual(S.readSettings(tmpFile()), S.defaultSettings());
});

test('a broken JSON file reads as defaults', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ "models": { "director": ', 'utf8');
  assert.deepEqual(S.readSettings(file), S.defaultSettings());
  fs.writeFileSync(file, '[1,2,3]', 'utf8');
  assert.deepEqual(S.readSettings(file), S.defaultSettings());
});

test('write then read round-trips the normalized settings', () => {
  const file = tmpFile();
  const { settings } = S.withProject({ freeFallback: true }, 'p', { profile: goodProfile, models: { builder: 'auto' } });
  assert.equal(S.writeSettings(settings, file), true);
  const back = S.readSettings(file);
  assert.deepEqual(back, settings);
  assert.equal(back.freeFallback, true);
});

test('a failed write returns false instead of throwing', () => {
  const dir = path.dirname(tmpFile());
  // Writing to a directory path fails on every platform.
  assert.equal(S.writeSettings(S.defaultSettings(), dir), false);
});
