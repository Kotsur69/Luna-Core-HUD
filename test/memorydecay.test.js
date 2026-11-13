// ============================================================================
// LunaCore - usefulness decay, the archive and references (src/memorydecay.js)
// All time is injected: no test waits for a day to pass.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  decayRecord,
  decayAll,
  restore,
  noteReferences,
  createReferenceRecorder,
  createDecayTimer,
  DECAY_AFTER_DAYS,
  DECAY_STEP_DAYS,
  DECAY_PER_STEP,
  RESTORED_USEFULNESS,
} = require('../src/memorydecay.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { createIndex } = require('../src/memoryindex.js');
const { buildCard } = require('../src/memorycard.js');
const { reviewList } = require('../src/memoryreview.js');
const { selectMemories } = require('../src/memoryinject.js');

const PROJECT = 'github.com/acme/hud';
const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY_MS).toISOString().slice(0, 10);

const rec = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Worktree junction gotcha ${id}`,
  created: '2026-01-01',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `Do not junction node_modules into a worktree (${id}).`,
  usefulness: 60,
  usefulness_at: '2026-01-01',
  ...over,
});

function mirror(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-decay-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  for (const r of records) writeRecord(dir, r);
  return dir;
}
const stored = (dir) => Object.fromEntries(scan(dir).records);

test('the named constants say 30 days of grace, then 10 points a week', () => {
  assert.equal(DECAY_AFTER_DAYS, 30);
  assert.equal(DECAY_STEP_DAYS, 7);
  assert.equal(DECAY_PER_STEP, 10);
});

test('nothing decays within the grace period or before a full step after it', () => {
  const r = rec('a');
  const graceEnds = addDays(r.created, DECAY_AFTER_DAYS);
  assert.equal(decayRecord(r, graceEnds), r);
  assert.equal(decayRecord(r, addDays(graceEnds, DECAY_STEP_DAYS - 1)), r);
  const next = decayRecord(r, addDays(graceEnds, DECAY_STEP_DAYS));
  assert.equal(next.usefulness, 50);
  assert.equal(next.usefulness_at, addDays(graceEnds, DECAY_STEP_DAYS));
  assert.equal(next.archived, undefined);
  // Pure: the input is untouched, and a second run the same day changes nothing.
  assert.equal(r.usefulness, 60);
  assert.equal(decayRecord(next, addDays(graceEnds, DECAY_STEP_DAYS)), next);
});

test('decay is the same whether the timer runs daily or once after a month off', () => {
  const start = rec('a');
  // Part way down, and well past zero (archive date included).
  for (const end of ['2026-03-10', '2026-06-15']) {
    let daily = start;
    for (let day = start.created; day <= end; day = addDays(day, 1)) daily = decayRecord(daily, day);
    assert.deepEqual(decayRecord(start, end), daily, end);
  }
});

test('at zero a memory moves to the archive, dated the day it reached zero', () => {
  const next = decayRecord(rec('a', { usefulness: 20 }), '2026-06-01');
  // Grace ends 2026-01-31; two weekly steps take 20 points to zero on 2026-02-14.
  assert.equal(next.usefulness, 0);
  assert.equal(next.archived, '2026-02-14');
  assert.equal(decayRecord(next, '2026-09-01'), next, 'an archived memory decays no further');
});

test('a scan score of zero archives an unused memory, but not a recently used one', () => {
  const unused = decayRecord(rec('a', { usefulness: 0, usefulness_at: '2026-05-01' }), '2026-05-01');
  assert.equal(unused.archived, '2026-05-01');
  const used = rec('b', { usefulness: 0, usefulness_at: '2026-05-01', last_used: '2026-04-25' });
  assert.equal(decayRecord(used, '2026-05-01'), used);
});

test('a recent reference, verification or scan holds decay off', () => {
  const today = '2026-03-01';
  assert.equal(decayRecord(rec('a', { last_used: '2026-02-20' }), today).usefulness, 60);
  assert.equal(decayRecord(rec('a', { last_verified: '2026-02-20' }), today).usefulness, 60);
  // Scanned long after the last reference: the charge starts from the scan.
  const scanned = rec('a', { usefulness_at: '2026-02-25' });
  assert.equal(decayRecord(scanned, today), scanned);
  assert.equal(decayRecord(scanned, '2026-03-04').usefulness, 50);
});

test('only a confirmed, scored memory decays', () => {
  const today = '2026-12-01';
  const waiting = rec('a', { confidence: 'observed' });
  const unscored = rec('b', { usefulness: undefined, usefulness_at: undefined });
  assert.equal(decayRecord(waiting, today), waiting);
  assert.equal(decayRecord(unscored, today), unscored);
});

test('decayAll writes the lowered memories and names the archived ones', (t) => {
  const dir = mirror(t, [rec('old', { usefulness: 10 }), rec('used', { last_used: '2026-03-10' }), rec('fresh', { created: '2026-03-01' })]);
  const res = decayAll(dir, '2026-03-15');
  assert.deepEqual(res.archived, [`${PROJECT}/old`]);
  assert.deepEqual(res.lowered.sort(), [`${PROJECT}/old`]);
  const after = stored(dir);
  // 10 points, one weekly step after the grace period ended on 2026-01-31.
  assert.equal(after[`${PROJECT}/old`].archived, '2026-02-07');
  assert.equal(after[`${PROJECT}/used`].usefulness, 60);
  // A second run the same day writes nothing.
  assert.deepEqual(decayAll(dir, '2026-03-15').lowered, []);
});

test('an archived memory is off the card, out of default search, off the review list and out of briefs', (t) => {
  const today = '2026-12-01';
  const dir = mirror(t, [
    rec('gone', { archived: '2026-11-01', usefulness: 0, type: 'how-to', created: '2026-01-01' }),
    rec('kept', { title: 'Worktree junction gotcha kept' }),
  ]);
  const { records } = scan(dir);
  const card = buildCard(records, { project: PROJECT, now: Date.parse(today) });
  assert.match(card.text, /\[kept\]/);
  assert.doesNotMatch(card.text, /\[gone\]/);

  const index = createIndex(records);
  t.after(() => index.close());
  assert.deepEqual(index.search('worktree junction', { project: PROJECT }).map((h) => h.id), ['kept']);
  assert.ok(index.search('worktree junction', { project: PROJECT, archived: true }).some((h) => h.id === 'gone'), 'still findable on request');

  // A stale how-to would be flagged; archived, it is out of the way.
  assert.equal(reviewList({ records, today }).items.some((i) => i.id === 'gone'), false);
  const pkg = { title: 'Worktree junction fix', prompt: 'worktree junction node_modules', files: [] };
  assert.deepEqual(selectMemories(records, { project: PROJECT, pkg, today }).map((m) => m.record.id), ['kept']);
});

test('restore brings a memory back and the next tick does not archive it again', (t) => {
  const dir = mirror(t, [rec('gone', { archived: '2026-11-01', usefulness: 0 }), rec('live', { last_used: '2026-11-30' })]);
  const key = `${PROJECT}/gone`;
  const today = '2026-12-01';
  assert.deepEqual(restore(dir, key, today), { ok: true, key });
  const back = stored(dir)[key];
  assert.equal(back.archived, undefined);
  assert.equal(back.usefulness, RESTORED_USEFULNESS);
  assert.equal(back.last_used, today);
  assert.equal(decayAll(dir, today).archived.includes(key), false);

  assert.deepEqual(restore(dir, `${PROJECT}/live`, today), { ok: false, reason: 'not-archived' });
  assert.deepEqual(restore(dir, '../../etc', today), { ok: false, reason: 'bad-key' });
  assert.deepEqual(restore(dir, `${PROJECT}/nope`, today), { ok: false, reason: 'not-found' });
});

test('a reference moves last_used to today, once a day, never on an archived memory', (t) => {
  const dir = mirror(t, [rec('a'), rec('b', { last_used: '2026-05-01' }), rec('z', { archived: '2026-04-01', usefulness: 0 })]);
  const keys = ['a', 'b', 'z'].map((id) => `${PROJECT}/${id}`);
  assert.deepEqual(noteReferences(dir, [...keys, 'not a key'], '2026-05-01').sort(), [`${PROJECT}/a`]);
  assert.deepEqual(noteReferences(dir, keys, '2026-05-01'), []);
  assert.equal(stored(dir)[`${PROJECT}/a`].last_used, '2026-05-01');
  assert.equal(stored(dir)[`${PROJECT}/z`].last_used, undefined);
});

test('the recorder reads search hits, reads and verifications, and skips keys it noted today', (t) => {
  const dir = mirror(t, [rec('a'), rec('b')]);
  let now = Date.parse('2026-05-01T10:00:00Z');
  const written = [];
  const refs = createReferenceRecorder({ dir: () => dir, now: () => now, onWritten: (keys) => written.push(...keys) });

  assert.equal(refs.fromEvent({ ev: 'search', hits: [`${PROJECT}/a`] }), 1);
  assert.equal(refs.fromEvent({ ev: 'get', key: `${PROJECT}/a` }), 0);
  assert.equal(refs.fromEvent({ ev: 'verified', key: `${PROJECT}/b` }), 1);
  assert.equal(refs.fromEvent({ ev: 'capture', project: PROJECT }), 0);
  assert.deepEqual(written, [`${PROJECT}/a`, `${PROJECT}/b`]);

  now += 1 * DAY_MS;
  assert.equal(refs.note([`${PROJECT}/a`]), 1);
  assert.equal(stored(dir)[`${PROJECT}/a`].last_used, '2026-05-02');
});

test('the recorder never throws: a broken folder is a logged zero', (t) => {
  const quiet = t.mock.method(console, 'error', () => {});
  const refs = createReferenceRecorder({ dir: () => { throw new Error('no folder'); } });
  assert.equal(refs.note([`${PROJECT}/a`]), 0);
  assert.equal(quiet.mock.callCount(), 1);
});

test('the timer tick decays with the injected clock and reports what changed', (t) => {
  const dir = mirror(t, [rec('old', { usefulness: 10 })]);
  const seen = [];
  const timer = createDecayTimer({ dir: () => dir, now: () => Date.parse('2026-06-01T08:00:00Z'), onChanged: (res) => seen.push(res) });
  const res = timer.tick();
  assert.deepEqual(res.archived, [`${PROJECT}/old`]);
  assert.equal(seen.length, 1);
  assert.equal(timer.tick().lowered.length, 0);
  assert.equal(seen.length, 1, 'no change, no repaint');
});
