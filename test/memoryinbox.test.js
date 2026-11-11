// ============================================================================
// LunaCore - the memory inbox (src/memoryinbox.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listInbox, pendingCount, approve, reject, update } = require('../src/memoryinbox.js');
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
