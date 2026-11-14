// ============================================================================
// LunaCore - the memory inbox (src/memoryinbox.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listInbox, pendingCount, approve, reject, update, makeGlobal } = require('../src/memoryinbox.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { createIndex } = require('../src/memoryindex.js');
const { buildCard } = require('../src/memorycard.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/quote';

const rec = (id, title, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title,
  created: '2026-11-10',
  confidence: 'observed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});

function mirror(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-inbox-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  for (const r of records) writeRecord(dir, r);
  return dir;
}

const stored = (dir) => Object.fromEntries(scan(dir).records);

test('each decision is reported once it is on disk, and a refused one is not', (t) => {
  const dir = mirror(t, [rec('keep', 'Retry says busy after sleep'), rec('drop', 'Packaging times out on battery'), rec('done', 'Name the installer with dashes', { confidence: 'confirmed' })]);
  const seen = [];
  const decided = (event, record) => seen.push([event, record.id, record.title]);

  update(dir, `${PROJECT}/keep`, { title: 'Retry says busy after a sleep' }, decided);
  approve(dir, `${PROJECT}/keep`, '2026-11-11', decided);
  reject(dir, `${PROJECT}/drop`, decided);
  approve(dir, `${PROJECT}/done`, '2026-11-11', decided);
  reject(dir, `${PROJECT}/nope`, decided);

  assert.deepEqual(seen, [
    ['edited', 'keep', 'Retry says busy after a sleep'],
    ['approved', 'keep', 'Retry says busy after a sleep'],
    ['rejected', 'drop', 'Packaging times out on battery'],
  ]);
});

test('lists what is not confirmed, newest first, and leaves confirmed memories out', (t) => {
  const dir = mirror(t, [
    rec('old-one', 'Packaging times out on battery', { created: '2026-11-01' }),
    rec('new-one', 'Retry says busy after sleep', { created: '2026-11-11', source: 'captured from session abc on PC1' }),
    rec('done', 'Name the installer with dashes', { confidence: 'confirmed' }),
  ]);

  const { items, total } = listInbox(dir);

  assert.equal(total, 2);
  assert.deepEqual(
    items.map((i) => i.key),
    [`${PROJECT}/new-one`, `${PROJECT}/old-one`],
  );
  assert.equal(items[0].source, 'captured from session abc on PC1');
  assert.equal(items[0].body, 'Body of new-one.');
});

test('folds near-duplicates into the oldest and counts them', (t) => {
  const dir = mirror(t, [
    rec('junction-a', 'Do not junction node_modules into a worktree', { created: '2026-11-09' }),
    rec('junction-b', 'Never junction node_modules into a worktree', { created: '2026-11-10' }),
    rec('junction-c', 'Do not junction node_modules into a worktree', { project: OTHER }),
  ]);

  const { items, total } = listInbox(dir);

  assert.equal(total, 2);
  const mine = items.find((i) => i.project === PROJECT);
  assert.equal(mine.key, `${PROJECT}/junction-a`);
  assert.equal(mine.duplicates, 1);
  assert.equal(pendingCount(dir, PROJECT), 1);
});

test('shows what an entry would replace and a confirmed memory it resembles', (t) => {
  const dir = mirror(t, [
    rec('rule', 'God Mode cards need a separate run', { confidence: 'confirmed' }),
    rec('rule-new', 'God Mode cards may build God Mode cards', { supersedes: ['rule', 'gone'] }),
    rec('names', 'Name the installer asset with dashes', { confidence: 'confirmed' }),
    rec('names-again', 'Name the installer asset with dashes always'),
  ]);

  const byId = Object.fromEntries(listInbox(dir).items.map((i) => [i.id, i]));

  assert.deepEqual(byId['rule-new'].supersedes, [{ id: 'rule', title: 'God Mode cards need a separate run' }]);
  assert.equal(byId['rule-new'].similar, null);
  assert.deepEqual(byId['names-again'].similar, { key: `${PROJECT}/names`, title: 'Name the installer asset with dashes' });
});

test('approve confirms the entry, dates it and removes its duplicates', (t) => {
  const dir = mirror(t, [
    rec('junction-a', 'Do not junction node_modules into a worktree', { created: '2026-11-09' }),
    rec('junction-b', 'Never junction node_modules into a worktree'),
  ]);

  const res = approve(dir, `${PROJECT}/junction-a`, '2026-11-11');

  assert.deepEqual(res, { ok: true, key: `${PROJECT}/junction-a`, removed: [`${PROJECT}/junction-b`] });
  const after = stored(dir);
  assert.deepEqual(Object.keys(after), [`${PROJECT}/junction-a`]);
  assert.equal(after[`${PROJECT}/junction-a`].confidence, 'confirmed');
  assert.equal(after[`${PROJECT}/junction-a`].last_verified, '2026-11-11');
  assert.equal(listInbox(dir).total, 0);
});

test('approving a folded duplicate keeps that one and removes the rest of its group', (t) => {
  const dir = mirror(t, [
    rec('junction-a', 'Do not junction node_modules into a worktree', { created: '2026-11-09' }),
    rec('junction-b', 'Never junction node_modules into a worktree'),
  ]);

  const res = approve(dir, `${PROJECT}/junction-b`, '2026-11-11');

  assert.deepEqual(res.removed, [`${PROJECT}/junction-a`]);
  assert.deepEqual(Object.keys(stored(dir)), [`${PROJECT}/junction-b`]);
});

test('reject deletes the entry and its duplicates', (t) => {
  const dir = mirror(t, [rec('weak', 'Something not worth keeping'), rec('keep', 'Retry says busy after sleep')]);

  assert.deepEqual(reject(dir, `${PROJECT}/weak`), { ok: true, key: `${PROJECT}/weak`, removed: [] });
  assert.deepEqual(Object.keys(stored(dir)), [`${PROJECT}/keep`]);
});

test('a confirmed memory, a missing one and a bad key are refused', (t) => {
  const dir = mirror(t, [rec('done', 'Name the installer with dashes', { confidence: 'confirmed' })]);

  for (const act of [(k) => approve(dir, k, '2026-11-11'), (k) => reject(dir, k), (k) => update(dir, k, { title: 'x' })]) {
    assert.deepEqual(act(`${PROJECT}/done`), { ok: false, reason: 'not-pending' });
    assert.deepEqual(act(`${PROJECT}/missing`), { ok: false, reason: 'not-found' });
    assert.deepEqual(act('../../etc/passwd'), { ok: false, reason: 'bad-key' });
    assert.deepEqual(act(undefined), { ok: false, reason: 'bad-key' });
  }
  assert.equal(stored(dir)[`${PROJECT}/done`].confidence, 'confirmed');
});

test('update corrects the text, keeps the entry waiting and cannot change who it is', (t) => {
  const dir = mirror(t, [rec('busy', 'Retry says busy', { area: 'godmode' })]);
  const key = `${PROJECT}/busy`;

  assert.deepEqual(update(dir, key, { title: 'Retry says busy after sleep', body: 'New body.', type: 'how-to', area: '', id: 'x', project: OTHER, confidence: 'confirmed' }), {
    ok: true,
    key,
  });

  const r = stored(dir)[key];
  assert.equal(r.title, 'Retry says busy after sleep');
  assert.equal(r.body, 'New body.');
  assert.equal(r.type, 'how-to');
  assert.equal('area' in r, false);
  assert.equal(r.confidence, 'observed');
});

test('update refuses a field that is not valid and leaves the file as it was', (t) => {
  const dir = mirror(t, [rec('busy', 'Retry says busy')]);
  const key = `${PROJECT}/busy`;

  assert.deepEqual(update(dir, key, { body: '   ' }), { ok: false, reason: 'empty-body' });
  assert.deepEqual(update(dir, key, { type: 'rule' }), { ok: false, reason: 'bad-type' });
  assert.deepEqual(update(dir, key, { title: 5 }), { ok: false, reason: 'bad-title' });
  assert.equal(stored(dir)[key].title, 'Retry says busy');
});

test('an unconfirmed memory replaces nothing in search or on the card until it is approved', (t) => {
  const dir = mirror(t, [
    rec('rule', 'God Mode cards need a separate run', { confidence: 'confirmed' }),
    rec('rule-new', 'God Mode cards may build God Mode cards', { supersedes: ['rule'] }),
  ]);
  const found = () => {
    const index = createIndex(scan(dir).records);
    t.after(() => index.close());
    return index.search('God Mode cards', { project: PROJECT }).map((h) => h.id);
  };

  assert.deepEqual(found().sort(), ['rule', 'rule-new']);
  assert.match(buildCard(scan(dir).records, { project: PROJECT }).text, /\[rule\]/);

  approve(dir, `${PROJECT}/rule-new`, '2026-11-11');

  assert.deepEqual(found(), ['rule-new']);
  const card = buildCard(scan(dir).records, { project: PROJECT }).text;
  assert.match(card, /\[rule-new\]/);
  assert.doesNotMatch(card, /\[rule\]/);
});

test('an empty or missing mirror is an empty inbox', (t) => {
  const dir = mirror(t, []);

  assert.deepEqual(listInbox(dir), { items: [], total: 0 });
  assert.deepEqual(listInbox(path.join(dir, 'nowhere')), { items: [], total: 0 });
  assert.equal(pendingCount(dir, PROJECT), 0);
});

// ---- Make global, and the capture notes (security review of 2026-11-11) --------

const SESSION = 'captured from session abc on PC1';

test('listInbox exposes the suggested-global mark and the outside-source count from the source', (t) => {
  const dir = mirror(t, [
    rec('suggested', 'Comments are written in English', { source: `${SESSION}, read 2 outside source(s), suggested global`, created: '2026-11-03' }),
    rec('outside', 'Retry says busy after sleep', { source: `${SESSION}, read 4 outside source(s)`, created: '2026-11-02' }),
    rec('local', 'Packaging times out on battery', { source: SESSION, created: '2026-11-01' }),
  ]);

  const byId = Object.fromEntries(listInbox(dir).items.map((i) => [i.id, i]));

  assert.deepEqual([byId.suggested.suggestedGlobal, byId.suggested.outside], [true, 2]);
  assert.deepEqual([byId.outside.suggestedGlobal, byId.outside.outside], [false, 4]);
  assert.deepEqual([byId.local.suggestedGlobal, byId.local.outside], [false, 0]);
});

test('makeGlobal moves a waiting project entry to global, still waiting, without supersedes or the suggestion note', (t) => {
  const dir = mirror(t, [
    rec('old-rule', 'Comments may be in Polish', { confidence: 'confirmed' }),
    rec('english', 'Comments are written in English', { source: `${SESSION}, read 1 outside source(s), suggested global`, supersedes: ['old-rule'], area: 'style' }),
  ]);

  const res = makeGlobal(dir, `${PROJECT}/english`);

  assert.deepEqual(res, { ok: true, key: 'global/english' });
  const all = stored(dir);
  assert.equal(all[`${PROJECT}/english`], undefined);
  assert.deepEqual(all['global/english'], {
    ...rec('english', 'Comments are written in English', { area: 'style' }),
    project: 'global',
    source: `${SESSION}, read 1 outside source(s)`,
  });
  assert.equal(all[`${PROJECT}/old-rule`].confidence, 'confirmed');
  assert.deepEqual(listInbox(dir).items.map((i) => [i.key, i.suggestedGlobal]), [['global/english', false]]);
});

test('makeGlobal takes the next free id when the id is taken in global, and gives up after -9', (t) => {
  const taken = ['english', ...Array.from({ length: 8 }, (_, i) => `english-${i + 2}`)];
  const dir = mirror(t, [
    rec('english', 'Comments are written in English'),
    ...taken.slice(0, 2).map((id) => rec(id, `Unrelated global memory ${id}`, { project: 'global', confidence: 'confirmed', body: `Other text ${id}.` })),
  ]);

  assert.deepEqual(makeGlobal(dir, `${PROJECT}/english`), { ok: true, key: 'global/english-3' });

  for (const id of taken.slice(2)) writeRecord(dir, rec(id, `Unrelated global memory ${id}`, { project: 'global', confidence: 'confirmed', body: `Other text ${id}.` }));
  // A second project entry with the same id, now that every candidate id is taken in global.
  writeRecord(dir, rec('english', 'Write the commit messages in English'));
  const before = stored(dir);

  assert.deepEqual(makeGlobal(dir, `${PROJECT}/english`), { ok: false, reason: 'id-taken' });
  assert.deepEqual(stored(dir), before);
});

test('makeGlobal refuses a confirmed entry, a bad key, a missing one and one that is already global', (t) => {
  const dir = mirror(t, [
    rec('done', 'Name the installer with dashes', { confidence: 'confirmed' }),
    rec('everywhere', 'Comments are written in English', { project: 'global' }),
  ]);
  const before = stored(dir);

  assert.deepEqual(makeGlobal(dir, `${PROJECT}/done`), { ok: false, reason: 'not-pending' });
  assert.deepEqual(makeGlobal(dir, 'global/everywhere'), { ok: false, reason: 'already-global' });
  assert.deepEqual(makeGlobal(dir, `${PROJECT}/nope`), { ok: false, reason: 'not-found' });
  for (const key of ['', '../../x', 'C:\Windows\win.ini', undefined]) assert.deepEqual(makeGlobal(dir, key), { ok: false, reason: 'bad-key' });
  assert.deepEqual(stored(dir), before);
});

test('makeGlobal leaves the duplicates folded into the entry where they are', (t) => {
  const dir = mirror(t, [
    rec('busy-a', 'Retry says busy after a sleep', { created: '2026-11-01' }),
    rec('busy-b', 'Retry says busy after the sleep', { created: '2026-11-02' }),
  ]);

  assert.equal(makeGlobal(dir, `${PROJECT}/busy-a`).ok, true);

  assert.deepEqual(Object.keys(stored(dir)).sort(), [`${PROJECT}/busy-b`, 'global/busy-a']);
});

test('the inbox lists the most useful entry first, newest first within a score, and unknown scores last', (t) => {
  const dir = mirror(t, [
    rec('unknown-new', 'Retry says busy after sleep', { created: '2026-11-12' }),
    rec('mid-old', 'Packaging times out on battery', { created: '2026-11-01', usefulness: 60 }),
    rec('mid-new', 'Name the installer with dashes', { created: '2026-11-09', usefulness: 60 }),
    rec('top', 'Junction targets get emptied', { created: '2026-11-02', usefulness: 91 }),
    rec('low', 'Release notes need a date', { created: '2026-11-11', usefulness: 31 }),
  ]);

  const { items } = listInbox(dir);

  assert.deepEqual(
    items.map((i) => [i.id, i.usefulness]),
    [
      ['top', 91],
      ['mid-new', 60],
      ['mid-old', 60],
      ['low', 31],
      ['unknown-new', null],
    ],
  );
});

test('approving keeps the score on the confirmed memory and hands it to the decision log', (t) => {
  const dir = mirror(t, [rec('keep', 'Retry says busy after sleep', { usefulness: 77 })]);
  const seen = [];

  approve(dir, `${PROJECT}/keep`, '2026-11-12', (ev, record) => seen.push([ev, record.usefulness]));

  assert.equal(stored(dir)[`${PROJECT}/keep`].usefulness, 77);
  assert.deepEqual(seen, [['approved', 77]]);
});

// Bug: "usefulness disappeared when I have memories to review". Near-duplicates
// fold into the OLDEST entry, and only that entry's own score was shown. The
// oldest is often the one without a score (captured by a PC on a release older
// than the field, or proposed by a session, which never carries one), so the
// group showed "?" and sorted last although a folded twin had a score, and
// approving it confirmed the memory without one.
test('a folded group shows the score of a scored twin when its oldest entry has none', (t) => {
  const dir = mirror(t, [
    rec('junction-a', 'Do not junction node_modules into a worktree', { created: '2026-11-09' }),
    rec('junction-b', 'Never junction node_modules into a worktree', { created: '2026-11-10', usefulness: 80, usefulness_note: 'Saves a broken install.' }),
    rec('battery', 'Packaging times out on battery', { created: '2026-11-11', usefulness: 60 }),
  ]);

  const { items } = listInbox(dir);

  assert.deepEqual(
    items.map((i) => [i.id, i.usefulness, i.usefulness_note, i.duplicates]),
    [
      ['junction-a', 80, 'Saves a broken install.', 1],
      ['battery', 60, null, 0],
    ],
  );
});

test("a folded group's own score wins over its twins'", (t) => {
  const dir = mirror(t, [
    rec('junction-a', 'Do not junction node_modules into a worktree', { created: '2026-11-09', usefulness: 50 }),
    rec('junction-b', 'Never junction node_modules into a worktree', { created: '2026-11-10', usefulness: 80 }),
  ]);

  assert.equal(listInbox(dir).items[0].usefulness, 50);
});

test('approving a folded group keeps the score the inbox showed for it', (t) => {
  const dir = mirror(t, [
    rec('junction-a', 'Do not junction node_modules into a worktree', { created: '2026-11-09' }),
    rec('junction-b', 'Never junction node_modules into a worktree', { created: '2026-11-10', usefulness: 80, usefulness_note: 'Saves a broken install.' }),
  ]);
  const seen = [];

  const res = approve(dir, `${PROJECT}/junction-a`, '2026-11-12', (ev, record) => seen.push([ev, record.usefulness]));

  assert.deepEqual(res.removed, [`${PROJECT}/junction-b`]);
  const kept = stored(dir)[`${PROJECT}/junction-a`];
  assert.equal(kept.confidence, 'confirmed');
  assert.equal(kept.usefulness, 80);
  assert.equal(kept.usefulness_note, 'Saves a broken install.');
  assert.deepEqual(seen, [['approved', 80]]);
});

test('the inbox sorts by final score: reads on this PC lift an entry, a tie falls to usefulness then newest', (t) => {
  const dir = mirror(t, [
    rec('read-often', 'Retry says busy after sleep', { created: '2026-11-01', usefulness: 60 }),
    rec('more-useful', 'Packaging times out on battery', { created: '2026-11-02', usefulness: 64 }),
    rec('same-old', 'Name the installer with dashes', { created: '2026-11-03', usefulness: 50 }),
    rec('same-new', 'Release notes need a date', { created: '2026-11-04', usefulness: 50 }),
    rec('unrated', 'Junction targets get emptied', { created: '2026-11-05' }),
  ]);
  const reads = new Map([[`${PROJECT}/read-often`, 5]]);

  const { items } = listInbox(dir, { reads, today: '2026-11-14' });

  // read-often: 0.7 * 60 + 7.5 + 15 = 64.5 -> 65; more-useful: 0.7 * 64 + 7.5 = 52.3 -> 52.
  assert.deepEqual(
    items.map((i) => [i.id, i.final.score]),
    [
      ['read-often', 65],
      ['more-useful', 52],
      ['same-new', 43],
      ['same-old', 43],
      ['unrated', null],
    ],
  );
  assert.deepEqual(items[0].final.parts, { usefulness: 60, confidence: 'observed', usage: 5 });
  // Without usage (the CLI, the phone) the order is the usefulness order.
  assert.deepEqual(
    listInbox(dir).items.map((i) => i.id),
    ['more-useful', 'read-often', 'same-new', 'same-old', 'unrated'],
  );
});
