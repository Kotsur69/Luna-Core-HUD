// ============================================================================
// LunaCore - the memory graveyard (src/memorygraveyard.js)
// ----------------------------------------------------------------------------
// Candidates dropped under the usefulness floor: kept locally, capped, pruned,
// restorable to the inbox, deletable. A broken file is an empty graveyard.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const g = require('../src/memorygraveyard.js');
const { listInbox } = require('../src/memoryinbox.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { createLog, logPath } = require('../src/memorylog.js');
const { LOW_USEFULNESS } = require('../src/memoryextract.js');

const PROJECT = 'github.com/acme/hud';
const NOW = Date.parse('2026-11-11T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
// Assembled at runtime: no secret-shaped literal in the source.
const FAKE_SECRET_LINE = `${['DEPLOY', 'TOKEN'].join('_')}=${'q'.repeat(24)}`;

const record = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: '2026-11-10',
  source: 'captured from session abc on PC1',
  confidence: 'observed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  usefulness: 12,
  ...over,
});
const low = (id, over) => ({ title: `Title of ${id}`, reason: LOW_USEFULNESS, type: 'gotcha', usefulness: 12, record: record(id, over) });

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-grave-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const file = g.graveyardPath(base);
  const dir = path.join(base, 'memory');
  const log = createLog(logPath(base), { now: () => NOW });
  return { base, file, dir, log, logged: () => log.read().map(({ at, ...e }) => e) };
}

test('bury keeps only low-usefulness drops that carry their record, newest first', (t) => {
  const s = setup(t);
  assert.equal(g.bury(s.file, [low('first')], NOW - 1000), 1);
  assert.equal(
    g.bury(s.file, [low('second'), { title: 'Dup', reason: 'duplicate' }, { title: 'No record', reason: LOW_USEFULNESS }], NOW),
    1,
  );

  const entries = g.readGraveyard(s.file, NOW);
  assert.deepEqual(entries.map((e) => e.record.id), ['second', 'first']);
  assert.equal(entries[0].reason, LOW_USEFULNESS);
  assert.equal(entries[0].score, 12);
  assert.match(entries[0].id, /^[a-z0-9]{1,12}-[0-9a-f]{8}$/);
  assert.equal(g.bury(s.file, [], NOW), 0);
  assert.equal(g.bury(s.file, null, NOW), 0);
});

test('the body is scrubbed before it is written', (t) => {
  const s = setup(t);
  g.bury(s.file, [low('leaky', { body: `Run the deploy with ${FAKE_SECRET_LINE} set.` })], NOW);

  const text = fs.readFileSync(s.file, 'utf8');
  assert.ok(!text.includes('q'.repeat(24)), 'the secret value never reaches the file');
  assert.match(g.readGraveyard(s.file, NOW)[0].record.body, /\[redacted\]/);
});

test('the graveyard is capped and entries older than the keep window are pruned', (t) => {
  const s = setup(t);
  const many = Array.from({ length: g.MAX_GRAVEYARD_ENTRIES + 15 }, (_, i) => low(`entry-${i}`));
  g.bury(s.file, many, NOW);
  assert.equal(g.readGraveyard(s.file, NOW).length, g.MAX_GRAVEYARD_ENTRIES);

  const later = NOW + (g.GRAVEYARD_KEEP_DAYS + 1) * DAY;
  assert.deepEqual(g.readGraveyard(s.file, later), [], 'older than the keep window: pruned on read');
  g.bury(s.file, [low('fresh')], later);
  assert.deepEqual(g.readGraveyard(s.file, later).map((e) => e.record.id), ['fresh'], 'and dropped from the file on the next write');
});

test('a missing, broken or hostile file is an empty graveyard, never a crash', (t) => {
  const s = setup(t);
  assert.deepEqual(g.readGraveyard(s.file, NOW), []);
  fs.writeFileSync(s.file, '{not json');
  assert.deepEqual(g.readGraveyard(s.file, NOW), []);
  assert.deepEqual(g.listGraveyard(s.file, NOW), { items: [], total: 0 });
  fs.writeFileSync(s.file, JSON.stringify({ entries: [null, 42, { id: '../x', at: NOW, reason: 'r', record: record('a') }, { id: 'abc-0000aaaa', at: NOW, reason: 'r', record: { id: 'NOT VALID' } }] }));
  assert.deepEqual(g.readGraveyard(s.file, NOW), []);
  // A broken file is replaced by the next bury, not a reason to fail capture.
  assert.equal(g.bury(s.file, [low('after')], NOW), 1);
});

test('listGraveyard gives the window type, title, score, reason, date and body under the entry id', (t) => {
  const s = setup(t);
  g.bury(s.file, [low('shown')], NOW);
  const { items, total } = g.listGraveyard(s.file, NOW);
  assert.equal(total, 1);
  const [item] = items;
  assert.equal(g.isEntryId(item.key), true);
  assert.deepEqual(
    { ...item, key: undefined },
    { key: undefined, at: NOW, reason: LOW_USEFULNESS, usefulness: 12, project: PROJECT, type: 'gotcha', title: 'Title of shown', body: 'Body of shown.', created: '2026-11-10' },
  );
});

test('restore puts the record in the inbox as observed, logs `restored` and takes it out of the graveyard', (t) => {
  const s = setup(t);
  g.bury(s.file, [low('comeback')], NOW);
  const [entry] = g.readGraveyard(s.file, NOW);

  const res = g.restoreEntry({ file: s.file, dir: s.dir, id: entry.id, now: NOW, log: s.log });

  assert.deepEqual(res, { ok: true, key: `${PROJECT}/comeback` });
  const [[key, restored]] = scan(s.dir).records;
  assert.equal(key, `${PROJECT}/comeback`);
  assert.equal(restored.confidence, 'observed');
  assert.equal(restored.body, 'Body of comeback.');
  assert.deepEqual(listInbox(s.dir).items.map((i) => i.key), [`${PROJECT}/comeback`]);
  assert.deepEqual(g.readGraveyard(s.file, NOW), []);
  assert.deepEqual(s.logged(), [{ ev: 'restored', key: `${PROJECT}/comeback`, type: 'gotcha', title: 'Title of comeback', usefulness: 12 }]);
});

test('restore never overwrites a memory: a taken id gets the next free one', (t) => {
  const s = setup(t);
  writeRecord(s.dir, record('taken', { confidence: 'confirmed', title: 'Title of taken', body: 'A confirmed memory.' }));
  g.bury(s.file, [low('taken')], NOW);
  const [entry] = g.readGraveyard(s.file, NOW);

  const res = g.restoreEntry({ file: s.file, dir: s.dir, id: entry.id, now: NOW, log: s.log });

  assert.equal(res.ok, true);
  assert.notEqual(res.key, `${PROJECT}/taken`);
  const byKey = new Map(scan(s.dir).records);
  assert.equal(byKey.get(`${PROJECT}/taken`).confidence, 'confirmed', 'the confirmed memory is untouched');
  assert.equal(byKey.get(res.key).confidence, 'observed');
});

test('a graveyard that cannot be saved undoes the restore: no copy is left in the inbox', (t) => {
  const s = setup(t);
  g.bury(s.file, [low('stuck')], NOW);
  const [entry] = g.readGraveyard(s.file, NOW);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to) === g.GRAVEYARD_FILE) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return rename(from, to);
  });

  assert.throws(() => g.restoreEntry({ file: s.file, dir: s.dir, id: entry.id, now: NOW, log: s.log }), /locked/);

  assert.deepEqual(scan(s.dir).records, [], 'the record written to the mirror is taken back');
  assert.equal(g.readGraveyard(s.file, NOW).length, 1, 'the entry is still in the graveyard');
  assert.deepEqual(s.logged(), []);
});

test('restore keeps only `supersedes` ids that still exist and drops conflict marks', (t) => {
  const s = setup(t);
  writeRecord(s.dir, record('older', { confidence: 'confirmed', title: 'An older memory', body: 'Something else entirely.' }));
  g.bury(s.file, [low('newer', { supersedes: ['older', 'gone'], conflicts: ['older'] })], NOW);
  const [entry] = g.readGraveyard(s.file, NOW);

  const res = g.restoreEntry({ file: s.file, dir: s.dir, id: entry.id, now: NOW, log: s.log });

  assert.equal(res.ok, true);
  const restored = new Map(scan(s.dir).records).get(res.key);
  assert.deepEqual(restored.supersedes, ['older']);
  assert.deepEqual(restored.conflicts || [], []);
});

test('an entry dated in the future (clock set back) is kept as now, not pruned', (t) => {
  const s = setup(t);
  const id = 'abc123-0000cafe';
  fs.writeFileSync(s.file, JSON.stringify({ entries: [{ id, at: NOW + DAY, reason: LOW_USEFULNESS, score: 12, record: record('ahead') }] }));
  const [entry] = g.readGraveyard(s.file, NOW);
  assert.equal(entry.id, id);
  assert.equal(entry.at, NOW);
});

test('carried unknown fields of a hand-edited entry are dropped on read', (t) => {
  const s = setup(t);
  const id = 'abc123-0000f00d';
  const carried = record('carried', { extra: [['custom_field', 'some value']] });
  fs.writeFileSync(s.file, JSON.stringify({ entries: [{ id, at: NOW, reason: LOW_USEFULNESS, score: 12, record: carried }] }));
  const [entry] = g.readGraveyard(s.file, NOW);
  assert.equal(entry.record.extra, undefined);
});

test('a hand-edited entry holding a secret is masked on read, so restore never writes the secret', (t) => {
  const s = setup(t);
  const id = 'abc123-0000beef';
  const leaky = record('leaky', { body: `Use ${FAKE_SECRET_LINE} here.` });
  // Written by hand, past bury's scrub; the read scrubs it, so the restore writes the masked text.
  fs.writeFileSync(s.file, JSON.stringify({ entries: [{ id, at: NOW, reason: LOW_USEFULNESS, score: 12, record: leaky }] }));
  const res = g.restoreEntry({ file: s.file, dir: s.dir, id, now: NOW, log: s.log });
  assert.equal(res.ok, true);
  const [[, restored]] = scan(s.dir).records;
  assert.ok(!restored.body.includes('q'.repeat(24)), 'the secret value never reaches the synced mirror');
});

test('delete removes one entry; a bad or unknown key is refused and changes nothing', (t) => {
  const s = setup(t);
  g.bury(s.file, [low('one'), low('two')], NOW);
  const [a, b] = g.readGraveyard(s.file, NOW);

  for (const bad of ['', '../memory-log.local.jsonl', 'ABC-0000beef', null, 42, `${PROJECT}/one`]) {
    assert.deepEqual(g.removeEntry(s.file, bad, NOW), { ok: false, reason: 'bad-key' });
    assert.deepEqual(g.restoreEntry({ file: s.file, dir: s.dir, id: bad, now: NOW }), { ok: false, reason: 'bad-key' });
  }
  assert.deepEqual(g.removeEntry(s.file, 'zzz-00000000', NOW), { ok: false, reason: 'not-found' });
  assert.equal(g.readGraveyard(s.file, NOW).length, 2);

  assert.deepEqual(g.removeEntry(s.file, a.id, NOW), { ok: true, key: a.id });
  assert.deepEqual(g.readGraveyard(s.file, NOW).map((e) => e.id), [b.id]);
  assert.deepEqual(scan(s.dir).records, [], 'delete never touches the mirror');
});

test('the graveyard is local: its file name is per PC and nothing syncs it', () => {
  assert.match(g.GRAVEYARD_FILE, /\.local\.json$/);
  const sources = ['memorysync.js', 'memorycard.js', 'memoryindex.js', 'memoryinject.js', 'memorytools.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'));
  for (const text of sources) assert.ok(!/memorygraveyard|memory-graveyard/.test(text));
});
