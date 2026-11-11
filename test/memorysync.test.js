// ============================================================================
// LunaCore - memory sync wiring: the secret gate, status, the run loop
// (src/memorysync.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startMemory, guardPublish, hasSecret, localStatus, memoryPaths } = require('../src/memorysync.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { setEnabled } = require('../src/memoryprojects.js');

const PROJECT = 'github.com/acme/demo';
const record = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: '2026-10-21',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});
// Built at run time so no secret-shaped literal sits in the repository.
const FAKE_KEY = ['sk', 'a'.repeat(24)].join('-');

function configDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memsync-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test('spots a secret in the title, the body or the source', () => {
  assert.equal(hasSecret(record('clean')), false);
  assert.equal(hasSecret(record('in-body', { body: `Use ${FAKE_KEY} for the API.` })), true);
  assert.equal(hasSecret(record('in-title', { title: `Key is ${FAKE_KEY}` })), true);
  assert.equal(hasSecret(record('env-line', { body: 'Set DB_PASSWORD=hunter2 in the env file.' })), true);
});

test('a memory holding a secret is not handed to the cloud', () => {
  const sent = [];
  const blocked = [];
  const publish = guardPublish(
    (doc) => sent.push(doc),
    (keys) => blocked.push(keys),
  );
  const leak = record('leak', { body: `Token ${FAKE_KEY}` });

  publish({
    units: [
      { k: `${PROJECT}/ok`, v: record('ok'), u: 5 },
      { k: `${PROJECT}/leak`, v: leak, u: 6 },
      { k: '_health/pc-a', v: { at: 1, count: 2 }, u: 7 },
    ],
    gone: { [`${PROJECT}/old`]: 3 },
  });

  assert.deepEqual(blocked, [[`${PROJECT}/leak`]]);
  assert.deepEqual(
    sent[0].units.map((x) => x.k),
    [`${PROJECT}/ok`, '_health/pc-a'],
  );
  assert.deepEqual(sent[0].gone, { [`${PROJECT}/old`]: 3 });
});

test('status from the files alone: counts, broken files, held-back memories, switches', (t) => {
  const dir = configDir(t);
  const p = memoryPaths(dir);
  writeRecord(p.dir, record('ok'));
  writeRecord(p.dir, record('leak', { body: `Token ${FAKE_KEY}` }));
  fs.writeFileSync(path.join(p.dir, 'projects', 'github.com', 'acme', 'demo', 'broken.md'), 'no frontmatter');
  setEnabled(p.projects, PROJECT, true);

  const status = localStatus(dir, 'pc-a', 1000);

  assert.equal(status.count, 2);
  assert.deepEqual(status.blocked, [`${PROJECT}/leak`]);
  assert.deepEqual(
    status.invalid.map((x) => x.error),
    ['no-frontmatter'],
  );
  assert.deepEqual(status.enabled, [PROJECT]);
  assert.deepEqual(status.machines, []);
});

/** A stand-in for startCloud(): one remote peer body, and what was published. */
function fakeCloud(peer) {
  const state = { published: [], pulled: [], lastSync: null };
  return {
    state,
    hooks: (scope) => ({
      extraPeers: () => (scope === 'memory' ? [peer] : null),
      onPublish: (doc) => state.published.push(doc),
    }),
    onPulled: (cb) => state.pulled.push(cb),
    memoryStatus: () => ({ ready: true, lastSync: state.lastSync, pending: 0, error: null }),
  };
}

test('the run loop pulls a remote memory into the mirror and publishes a heartbeat', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const dir = configDir(t);
  const remote = record('from-other-pc');
  const cloud = fakeCloud({ units: [{ k: `${PROJECT}/from-other-pc`, v: remote, u: 500 }], gone: {} });
  cloud.state.lastSync = Date.now();
  let changed = 0;

  const memory = startMemory({ cloud, machine: 'pc-a', configDir: dir, onChanged: () => changed++ });
  t.after(() => memory.stop());
  t.mock.timers.tick(10_000);

  assert.equal(changed, 1);
  assert.deepEqual(
    scan(memoryPaths(dir).dir).records.map(([k]) => k),
    [`${PROJECT}/from-other-pc`],
  );
  // The heartbeat is written after a sync that worked and travels with the next one.
  t.mock.timers.tick(60_000);
  const last = cloud.state.published.at(-1);
  assert.deepEqual(last.units.map((x) => x.k).sort(), ['_health/pc-a', `${PROJECT}/from-other-pc`].sort());
  assert.deepEqual(last.units.find((x) => x.k === '_health/pc-a').v, { at: cloud.state.lastSync, count: 1 });
  assert.equal(memory.status().count, 1);
  assert.equal(memory.status().transport.ready, true);
});

test('a PC whose memory sync is paused or failing sends no heartbeat', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const beats = (cloud) => cloud.state.published.flatMap((doc) => doc.units).filter((x) => x.k.startsWith('_health/'));

  const brokenDir = configDir(t);
  writeRecord(memoryPaths(brokenDir).dir, record('ok'));
  fs.writeFileSync(path.join(memoryPaths(brokenDir).dir, 'projects', 'github.com', 'acme', 'demo', 'broken.md'), 'no frontmatter');
  const paused = fakeCloud({ units: [], gone: {} });
  paused.state.lastSync = Date.now();
  const a = startMemory({ cloud: paused, machine: 'pc-a', configDir: brokenDir });
  t.after(() => a.stop());

  const failing = fakeCloud({ units: [], gone: {} });
  failing.state.lastSync = Date.now();
  failing.memoryStatus = () => ({ ready: true, lastSync: failing.state.lastSync, pending: 1, error: 'push-failed' });
  const b = startMemory({ cloud: failing, machine: 'pc-b', configDir: configDir(t) });
  t.after(() => b.stop());

  t.mock.timers.tick(10_000);
  t.mock.timers.tick(60_000);

  assert.deepEqual(beats(paused), []);
  assert.deepEqual(beats(failing), []);
});

test('a pull of the memory scope schedules a sync, other scopes do not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const dir = configDir(t);
  const cloud = fakeCloud({ units: [], gone: {} });
  const memory = startMemory({ cloud, machine: 'pc-a', configDir: dir });
  t.after(() => memory.stop());
  t.mock.timers.tick(10_000);
  const before = cloud.state.published.length;

  cloud.state.pulled.forEach((cb) => cb('todos'));
  t.mock.timers.tick(5000);
  assert.equal(cloud.state.published.length, before);

  cloud.state.pulled.forEach((cb) => cb('memory'));
  t.mock.timers.tick(5000);
  assert.equal(cloud.state.published.length, before + 1);
});
