// ============================================================================
// LunaCore - memories that contradict each other (src/memoryconflict.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findConflicts, findDuplicates, listConflicts, resolveConflict, mergePair, conflictCount, markConflicts, topicOf, opposing } = require('../src/memoryconflict.js');
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

// ---- merge suggestions and merging ---------------------------------------------------

const TWIN_A = rec('ci-first', 'Run npm ci in package worktrees before the tests', { usefulness: 60, links: ['dashes'] });
const TWIN_B = rec('ci-before', 'Run npm ci in package worktrees before tests', { usefulness: 80, usefulness_note: 'Saves a red run.', links: ['ci-first'] });

test('near-duplicate confirmed memories of one project are merge suggestions next to conflicts', (t) => {
  const { dir } = mirror(t, [
    JUNCTION_NO,
    JUNCTION_YES,
    TWIN_A,
    TWIN_B,
    // Waiting, in another project, archived, or marked compatible: no suggestion.
    rec('ci-waiting', 'Run npm ci in package worktrees before the tests run', { confidence: 'observed' }),
    rec('ci-elsewhere', 'Run npm ci in package worktrees before the tests', { project: OTHER }),
    rec('ci-cold', 'Run npm ci in package worktrees before all tests', { archived: '2026-10-01', usefulness: 0 }),
    rec('ok-one', 'Name the installer with dashes', { compatible: ['ok-two'] }),
    rec('ok-two', 'Name the installer with dashes always'),
  ]);
  const records = scan(dir).records;
  // The junction pair looks alike too, but it is listed once, as the conflict it is.
  assert.deepEqual(
    findDuplicates(records).map((p) => [p.a, p.b, p.source]),
    [
      [key('ci-before'), key('ci-first'), 'duplicate'],
      [key('junction'), key('no-junction'), 'duplicate'],
    ],
  );
  const { items, total } = listConflicts(records);
  assert.equal(total, 2);
  assert.deepEqual(items.map((i) => [i.a.id, i.source]), [['junction', 'check'], ['ci-before', 'duplicate']], 'conflicts first, then suggestions');
  assert.equal(items[1].a.body, TWIN_B.body, 'the whole body travels, for the merge draft');
  assert.equal(conflictCount(dir), 1, 'the hub counts conflicts only');
});

test('a pair that is a conflict is listed once, as the conflict', (t) => {
  const { dir } = mirror(t, [rec('x', 'Use npm ci in package worktrees always'), rec('y', 'Never use npm ci in package worktrees')]);
  const { items } = listConflicts(scan(dir).records);
  assert.deepEqual(items.map((i) => i.source), ['check']);
});

test('merge writes one confirmed memory superseding both; the originals stay on disk and leave the lists', (t) => {
  const { base, dir } = mirror(t, [TWIN_A, TWIN_B]);
  const log = createLog(logPath(base));
  const res = mergePair(dir, { a: key('ci-before'), b: key('ci-first'), title: 'Run npm ci in each package worktree first', body: 'One.\n\nTwo.' }, TODAY, { log });
  const merged = key('run-npm-ci-in-each-package-worktree-first');
  assert.deepEqual(res, { ok: true, key: merged, superseded: [key('ci-before'), key('ci-first')] });

  const after = stored(dir);
  assert.equal(Object.keys(after).length, 3, 'one new record, nothing deleted');
  assert.ok(after[key('ci-first')] && after[key('ci-before')], 'both originals stay as history');
  const m = after[merged];
  assert.equal(m.confidence, 'confirmed');
  assert.equal(m.created, TODAY);
  assert.equal(m.last_verified, TODAY);
  assert.deepEqual(m.supersedes, ['ci-before', 'ci-first']);
  assert.deepEqual(m.links, ['dashes'], 'links carried, the merged pair itself left out');
  assert.equal(m.usefulness, 80, 'the better score of the two is kept');
  assert.equal(m.usefulness_note, 'Saves a red run.');
  assert.equal(m.source, 'merged by hand from ci-before and ci-first');
  assert.equal(m.body, 'One.\n\nTwo.');

  assert.deepEqual(listConflicts(scan(dir).records).items, [], 'the suggestion is gone');
  assert.deepEqual(
    log.read().map((e) => [e.ev, e.key, e.from]),
    [
      ['merged', merged, [key('ci-before'), key('ci-first')]],
      ['superseded', key('ci-before'), undefined],
      ['superseded', key('ci-first'), undefined],
    ],
  );
});

test('a merge title whose id is taken gets a free one; a merge can settle a conflict too', (t) => {
  const { dir } = mirror(t, [JUNCTION_NO, JUNCTION_YES]);
  const res = mergePair(dir, { a: key('junction'), b: key('no-junction'), title: 'Junction', body: 'Never junction node_modules.' }, TODAY);
  assert.deepEqual(res, { ok: true, key: key('junction-2'), superseded: [key('junction'), key('no-junction')] });
  assert.deepEqual(findConflicts(scan(dir).records), []);
});

test('merge refuses an unlisted pair, bad keys and bad text, and writes nothing', (t) => {
  const { dir } = mirror(t, [TWIN_A, TWIN_B, rec('dashes', 'Name the installer with dashes')]);
  const before = stored(dir);
  const pair = { a: key('ci-before'), b: key('ci-first') };
  assert.deepEqual(mergePair(dir, { a: key('ci-first'), b: key('dashes'), title: 'X', body: 'Y' }, TODAY), { ok: false, reason: 'not-conflict' });
  assert.deepEqual(mergePair(dir, { a: '../x', b: key('dashes'), title: 'X', body: 'Y' }, TODAY), { ok: false, reason: 'bad-key' });
  assert.deepEqual(mergePair(dir, { a: pair.a, b: pair.a, title: 'X', body: 'Y' }, TODAY), { ok: false, reason: 'bad-key' });
  assert.deepEqual(mergePair(dir, { ...pair, title: 'X', body: '   ' }, TODAY), { ok: false, reason: 'empty-body' });
  assert.deepEqual(mergePair(dir, { ...pair, title: '', body: 'Y' }, TODAY), { ok: false, reason: 'bad-title' });
  assert.deepEqual(mergePair(dir, { ...pair, title: 7, body: 'Y' }, TODAY), { ok: false, reason: 'bad-title' });
  assert.deepEqual(stored(dir), before);
});

test('keep both on a merge suggestion hides the pair for good', (t) => {
  const { dir } = mirror(t, [TWIN_A, TWIN_B]);
  assert.equal(resolveConflict(dir, { a: key('ci-before'), b: key('ci-first'), keep: 'both' }, TODAY).ok, true);
  assert.deepEqual(stored(dir)[key('ci-before')].compatible, ['ci-first']);
  assert.deepEqual(findDuplicates(scan(dir).records), []);
  assert.deepEqual(listConflicts(scan(dir).records).items, []);
  // Settled for good: neither another keep nor a merge reaches it any more.
  assert.deepEqual(mergePair(dir, { a: key('ci-before'), b: key('ci-first'), title: 'X', body: 'Y' }, TODAY), { ok: false, reason: 'not-conflict' });
});

test('keep A on a merge suggestion supersedes B like a conflict', (t) => {
  const { dir } = mirror(t, [TWIN_A, TWIN_B]);
  assert.deepEqual(resolveConflict(dir, { a: key('ci-before'), b: key('ci-first'), keep: 'a' }, TODAY), { ok: true, kept: [key('ci-before')], superseded: key('ci-first') });
  assert.deepEqual(stored(dir)[key('ci-before')].supersedes, ['ci-first']);
});
