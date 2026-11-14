// ============================================================================
// LunaCore - memories that contradict each other (src/memoryconflict.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findConflicts, listConflicts, resolveConflict, conflictCount, markConflicts, topicOf, opposing } = require('../src/memoryconflict.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { listInbox } = require('../src/memoryinbox.js');
const { buildCard } = require('../src/memorycard.js');
const { createIndex } = require('../src/memoryindex.js');
const { createLog, logPath } = require('../src/memorylog.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/quote';
const TODAY = '2026-11-13';
const key = (id, project = PROJECT) => `${project}/${id}`;

const rec = (id, title, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title,
  created: '2026-11-01',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});

const JUNCTION_NO = rec('no-junction', 'Do not create node_modules junctions for package worktrees');
const JUNCTION_YES = rec('junction', 'Create node_modules junctions for package worktrees to save time');

function mirror(t, records) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-conflict-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(base, 'memory');
  for (const r of records) writeRecord(dir, r);
  return { base, dir };
}
const stored = (dir) => Object.fromEntries(scan(dir).records);

test('the cheap check: same topic words, and only one of the two says "not"', () => {
  assert.equal(opposing(topicOf(JUNCTION_NO.title), topicOf(JUNCTION_YES.title)), true);
  assert.equal(opposing(topicOf("Don't use npm ci in worktrees"), topicOf('Use npm ci in worktrees')), true);
  // Both negative, or different topics: no conflict.
  assert.equal(opposing(topicOf('Never push to main'), topicOf('Do not push to main without a review')), false);
  assert.equal(opposing(topicOf('Do not sleep the laptop on battery'), topicOf('Name the installer with dashes')), false);
});

test('a conflict is found by the cheap check or by the scan, within one project only', (t) => {
  const { dir } = mirror(t, [
    JUNCTION_NO,
    JUNCTION_YES,
    rec('ci', 'Install with npm ci', { conflicts: ['plain'] }),
    rec('plain', 'Install with plain npm install'),
    rec('elsewhere', 'Create node_modules junctions for package worktrees', { project: OTHER }),
  ]);
  const pairs = findConflicts(scan(dir).records);
  assert.deepEqual(
    pairs.map((p) => [p.a, p.b, p.source]),
    [
      [key('ci'), key('plain'), 'scan'],
      [key('junction'), key('no-junction'), 'check'],
    ],
  );
  assert.equal(conflictCount(dir), 2);
});

test('the inbox entry carries both sides with their usefulness', (t) => {
  const { dir } = mirror(t, [JUNCTION_NO, { ...JUNCTION_YES, usefulness: 20, usefulness_note: 'Risky.' }]);
  const { items, total } = listConflicts(scan(dir).records);
  assert.equal(total, 1);
  assert.equal(items[0].a.key, key('junction'));
  assert.equal(items[0].a.usefulness, 20);
  assert.equal(items[0].b.usefulness, null);
  assert.equal(items[0].b.title, JUNCTION_NO.title);
});

test('keep A supersedes B: B stays on disk as history, off the card, out of search and out of the inbox', (t) => {
  const { base, dir } = mirror(t, [JUNCTION_NO, { ...JUNCTION_YES, confidence: 'observed' }]);
  const log = createLog(logPath(base));
  const res = resolveConflict(dir, { a: key('no-junction'), b: key('junction'), keep: 'a' }, TODAY, { log });
  assert.deepEqual(res, { ok: true, kept: [key('no-junction')], superseded: key('junction') });

  const after = stored(dir);
  assert.deepEqual(after[key('no-junction')].supersedes, ['junction']);
  assert.ok(after[key('junction')], 'the loser is never deleted');
  assert.deepEqual(findConflicts(scan(dir).records), []);
  assert.equal(listInbox(dir).items.some((i) => i.id === 'junction'), false, 'a superseded waiting entry leaves the inbox');
  const card = buildCard(scan(dir).records, { project: PROJECT, now: Date.parse(TODAY) });
  assert.doesNotMatch(card.text, /\[junction\]/);
  const index = createIndex(scan(dir).records);
  t.after(() => index.close());
  assert.equal(index.search('junctions worktrees', { project: PROJECT }).some((h) => h.id === 'junction'), false);
  assert.deepEqual(
    log.read().map(({ ev, key: k }) => [ev, k]),
    [['superseded', key('junction')]],
  );
});

test('keep B confirms a winner that was still waiting', (t) => {
  const { dir } = mirror(t, [JUNCTION_NO, { ...JUNCTION_YES, confidence: 'observed' }]);
  const res = resolveConflict(dir, { a: key('no-junction'), b: key('junction'), keep: 'b' }, TODAY);
  assert.equal(res.ok, true);
  const winner = stored(dir)[key('junction')];
  assert.equal(winner.confidence, 'confirmed');
  assert.equal(winner.last_verified, TODAY);
  assert.deepEqual(winner.supersedes, ['no-junction']);
});

test('keep both: the pair is never shown again, by either way of finding it', (t) => {
  const { dir } = mirror(t, [{ ...JUNCTION_NO, conflicts: ['junction'] }, JUNCTION_YES]);
  assert.equal(resolveConflict(dir, { a: key('junction'), b: key('no-junction'), keep: 'both' }, TODAY).ok, true);
  const after = stored(dir);
  assert.deepEqual(after[key('junction')].compatible, ['no-junction']);
  assert.equal(after[key('no-junction')].conflicts, undefined);
  assert.equal(after[key('no-junction')].confidence, 'confirmed');
  assert.deepEqual(findConflicts(scan(dir).records), []);
  // A later scan naming the same pair does not bring it back.
  assert.equal(markConflicts(dir, PROJECT, [{ a: 'no-junction', b: 'junction', reason: 'again' }]), 0);
});

test('only a listed pair can be settled, so this is no way to supersede any memory', (t) => {
  const { dir } = mirror(t, [JUNCTION_NO, rec('dashes', 'Name the installer with dashes')]);
  const before = stored(dir);
  assert.deepEqual(resolveConflict(dir, { a: key('no-junction'), b: key('dashes'), keep: 'a' }, TODAY), { ok: false, reason: 'not-conflict' });
  assert.deepEqual(resolveConflict(dir, { a: '../x', b: key('dashes'), keep: 'a' }, TODAY), { ok: false, reason: 'bad-key' });
  assert.deepEqual(resolveConflict(dir, { a: key('dashes'), b: key('dashes'), keep: 'a' }, TODAY), { ok: false, reason: 'bad-key' });
  assert.deepEqual(resolveConflict(dir, { a: key('no-junction'), b: key('dashes'), keep: 'neither' }, TODAY), { ok: false, reason: 'bad-keep' });
  assert.deepEqual(stored(dir), before);
});

test('an archived memory is in no conflict', (t) => {
  const { dir } = mirror(t, [JUNCTION_NO, { ...JUNCTION_YES, archived: '2026-10-01', usefulness: 0 }]);
  assert.deepEqual(findConflicts(scan(dir).records), []);
});
