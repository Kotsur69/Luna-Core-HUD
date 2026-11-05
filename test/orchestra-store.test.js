// ============================================================================
// God Mode v2 per-project run storage (docs/MULTI_GODMODE_PLAN.md A1):
// config/orchestra/<sha1(projectId)[0..16]>.local.json, plus the one-time
// migration of the single-run config/orchestra.local.json older builds wrote.
// Every test runs against its own temp config root.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOrchestraStore, storeFileName, STORE_DIR, LEGACY_FILE } = require('../src/orchestraStore.js');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-orch-store-'));
  const logs = [];
  const store = createOrchestraStore({ userDir: () => dir, log: (line) => logs.push(line) });
  return { dir, store, logs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const run = (id, extra = {}) => ({ id, projectId: 'alpha', repoPath: '/repo/alpha', packages: [], ...extra });

test('a run round-trips through its project file', (t) => {
  const { dir, store, cleanup } = tempStore();
  t.after(cleanup);
  const data = run('p1', { packages: [{ id: 'a', state: 'pending' }] });
  assert.equal(store.saveRun('alpha', data), true);
  assert.deepEqual(store.loadRun('alpha'), data);
  const file = path.join(dir, STORE_DIR, storeFileName('alpha'));
  assert.ok(fs.existsSync(file), 'written under the hashed name');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'the tmp file is renamed away');
  assert.deepEqual(store.listStored(), ['alpha']);
  // null deletes the project's file.
  assert.equal(store.saveRun('alpha', null), true);
  assert.equal(store.loadRun('alpha'), null);
  assert.deepEqual(store.listStored(), []);
});

test('two projects do not clobber each other', (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  assert.equal(store.saveRun('alpha', run('pa')), true);
  assert.equal(store.saveRun('beta', run('pb', { projectId: 'beta' })), true);
  assert.equal(store.loadRun('alpha').id, 'pa');
  assert.equal(store.loadRun('beta').id, 'pb');
  assert.equal(store.saveRun('alpha', null), true);
  assert.equal(store.loadRun('alpha'), null);
  assert.equal(store.loadRun('beta').id, 'pb', 'deleting one project leaves the other');
  assert.deepEqual(store.listStored(), ['beta']);
});

test('evil project ids map to hashed file names inside the store folder', (t) => {
  const { dir, store, cleanup } = tempStore();
  t.after(cleanup);
  const evil = ['..\\x', '../x', 'CON', 'nul', 'a/b', 'C:\\Windows', '', 'x'.repeat(500)];
  for (const id of evil) {
    const name = storeFileName(id);
    assert.match(name, /^[0-9a-f]{16}\.local\.json$/, JSON.stringify(id));
    assert.equal(store.saveRun(id, run(`p-${evil.indexOf(id)}`)), true, JSON.stringify(id));
  }
  const files = fs.readdirSync(path.join(dir, STORE_DIR)).sort();
  assert.equal(files.length, evil.length, 'one file each, nothing outside the folder');
  assert.ok(files.every((f) => /^[0-9a-f]{16}\.local\.json$/.test(f)));
  assert.deepEqual(fs.readdirSync(dir).sort(), [STORE_DIR], 'nothing escaped into the config root');
  for (const id of evil) assert.equal(store.loadRun(id).id, `p-${evil.indexOf(id)}`, JSON.stringify(id));
  assert.deepEqual(store.listStored().sort(), [...evil].sort());
});

test('a tab with no project stores under null; a non-string id is refused', (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  assert.equal(store.saveRun(null, run('p0', { projectId: null })), true);
  assert.equal(store.loadRun(null).id, 'p0');
  assert.deepEqual(store.listStored(), [null]);
  assert.equal(store.saveRun(42, run('p1')), false);
  assert.equal(store.saveRun({ id: 'x' }, run('p1')), false);
  assert.equal(store.loadRun(42), null);
});

test('a corrupt or foreign file reads as null', (t) => {
  const { dir, store, cleanup } = tempStore();
  t.after(cleanup);
  fs.mkdirSync(path.join(dir, STORE_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, STORE_DIR, storeFileName('alpha')), '{ not json', 'utf8');
  assert.equal(store.loadRun('alpha'), null);
  // A file whose envelope names another project (copied under this name).
  assert.equal(store.saveRun('beta', run('pb')), true);
  fs.copyFileSync(path.join(dir, STORE_DIR, storeFileName('beta')), path.join(dir, STORE_DIR, storeFileName('gamma')));
  assert.equal(store.loadRun('gamma'), null);
  assert.deepEqual(store.listStored(), ['beta'], 'the broken and the copied file are not listed');
});

test('a failed write returns false and never throws', (t) => {
  const { dir, store, cleanup } = tempStore();
  t.after(cleanup);
  // The store folder's name is taken by a plain file: mkdir fails.
  fs.writeFileSync(path.join(dir, STORE_DIR), 'in the way', 'utf8');
  assert.equal(store.saveRun('alpha', run('p1')), false);
  assert.equal(store.loadRun('alpha'), null);
  assert.deepEqual(store.listStored(), []);
});

test('migration with the id the legacy file carries', (t) => {
  const { dir, store, cleanup } = tempStore();
  t.after(cleanup);
  const legacy = run('plegacy', { projectId: 'alpha' });
  fs.writeFileSync(path.join(dir, LEGACY_FILE), JSON.stringify(legacy), 'utf8');
  let asked = 0;
  const res = store.migrateLegacy(() => {
    asked += 1;
    return 'other';
  });
  assert.equal(res.migrated, true);
  assert.equal(res.projectId, 'alpha');
  assert.equal(asked, 0, 'the repo match is only a fallback');
  assert.deepEqual(store.loadRun('alpha'), legacy);
  assert.ok(!fs.existsSync(path.join(dir, LEGACY_FILE)), 'legacy renamed');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${LEGACY_FILE}.migrated`), 'utf8')), legacy, 'never deleted');
  // Once only: a second start finds nothing to migrate.
  assert.equal(store.migrateLegacy(() => 'alpha').reason, 'none');
});

test('migration via repoPath when the legacy run has no project id', (t) => {
  const { dir, store, cleanup } = tempStore();
  t.after(cleanup);
  const legacy = run('plegacy', { projectId: null, repoPath: '/repo/beta' });
  fs.writeFileSync(path.join(dir, LEGACY_FILE), JSON.stringify(legacy), 'utf8');
  const seen = [];
  const res = store.migrateLegacy((raw) => {
    seen.push(raw.repoPath);
    return raw.repoPath === '/repo/beta' ? 'beta' : null;
  });
  assert.deepEqual(seen, ['/repo/beta']);
  assert.equal(res.migrated, true);
  assert.equal(res.projectId, 'beta');
  // The run itself is kept exactly as it was saved.
  assert.deepEqual(store.loadRun('beta'), legacy);
  assert.ok(fs.existsSync(path.join(dir, `${LEGACY_FILE}.migrated`)));
});

test('an unmatched legacy file is left untouched and logged', (t) => {
  const { dir, store, logs, cleanup } = tempStore();
  t.after(cleanup);
  const text = JSON.stringify(run('plegacy', { projectId: null, repoPath: '/gone' }));
  fs.writeFileSync(path.join(dir, LEGACY_FILE), text, 'utf8');
  const res = store.migrateLegacy(() => null);
  assert.deepEqual(res, { migrated: false, reason: 'unmatched' });
  assert.equal(fs.readFileSync(path.join(dir, LEGACY_FILE), 'utf8'), text);
  assert.ok(!fs.existsSync(path.join(dir, `${LEGACY_FILE}.migrated`)));
  assert.deepEqual(store.listStored(), []);
  assert.ok(logs.some((l) => /matches no registered project/.test(l)));
});

test('a broken legacy file is left untouched and logged', (t) => {
  const { dir, store, logs, cleanup } = tempStore();
  t.after(cleanup);
  fs.writeFileSync(path.join(dir, LEGACY_FILE), '{ broken', 'utf8');
  assert.deepEqual(store.migrateLegacy(() => 'alpha'), { migrated: false, reason: 'broken' });
  assert.equal(fs.readFileSync(path.join(dir, LEGACY_FILE), 'utf8'), '{ broken');
  assert.ok(logs.some((l) => /broken/.test(l)));
});

test('migration never overwrites a newer stored run or an earlier .migrated file', (t) => {
  const { dir, store, cleanup } = tempStore();
  t.after(cleanup);
  // The project already has a run in the new layout: legacy stays put.
  assert.equal(store.saveRun('alpha', run('pnew')), true);
  fs.writeFileSync(path.join(dir, LEGACY_FILE), JSON.stringify(run('pold')), 'utf8');
  assert.equal(store.migrateLegacy(() => null).reason, 'exists');
  assert.equal(store.loadRun('alpha').id, 'pnew');
  assert.ok(fs.existsSync(path.join(dir, LEGACY_FILE)));
  // A legacy file for a fresh project while an older .migrated exists.
  assert.equal(store.saveRun('alpha', null), true);
  fs.writeFileSync(path.join(dir, `${LEGACY_FILE}.migrated`), 'first', 'utf8');
  const res = store.migrateLegacy(() => null);
  assert.equal(res.migrated, true);
  assert.equal(fs.readFileSync(path.join(dir, `${LEGACY_FILE}.migrated`), 'utf8'), 'first');
  assert.equal(res.renamedTo, path.join(dir, `${LEGACY_FILE}.migrated.2`));
  assert.equal(JSON.parse(fs.readFileSync(res.renamedTo, 'utf8')).id, 'pold');
});

test('an older stored run without a stall history still loads (empty history)', (t) => {
  const sup = require('../src/orchestraSupervisor.js');
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const legacy = run('p1', { packages: [{ id: 'a', state: 'stalled', error: 'noMarker', detail: 'last only', stalls: 3 }] });
  assert.equal(store.saveRun('alpha', legacy), true);
  const plan = sup.normalizeStoredPlan(store.loadRun('alpha'));
  assert.ok(plan, 'loads');
  assert.deepEqual(plan.packages[0].stallHistory, []);
  assert.equal(plan.packages[0].error, 'noMarker');
  // A newer run keeps its history through the store.
  const entry = { at: 5, kind: 'stall', reason: 'timeout', detail: null };
  store.saveRun('alpha', run('p2', { packages: [{ id: 'a', state: 'stalled', stallHistory: [entry] }] }));
  assert.deepEqual(sup.normalizeStoredPlan(store.loadRun('alpha')).packages[0].stallHistory, [entry]);
});
