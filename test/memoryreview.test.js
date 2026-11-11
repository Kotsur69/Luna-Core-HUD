// ============================================================================
// LunaCore - staleness, anchors and the review list (src/memoryreview.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isStale, isDecayed, anchorsOf, missingAnchors, reviewList, verify, retire, toolVerdict, STALE_DAYS, DIGEST_DAYS } = require('../src/memoryreview.js');
const { createLog, logPath } = require('../src/memorylog.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { createIndex } = require('../src/memoryindex.js');

const PROJECT = 'github.com/acme/hud';
const TODAY = '2026-11-11';
const NOW = Date.parse(`${TODAY}T12:00:00Z`);
const key = (id) => `${PROJECT}/${id}`;

const rec = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: '2026-11-01',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});

function setup(t, records = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-review-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(base, 'memory');
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'here.js'), '');
  for (const r of records) writeRecord(dir, r);
  const log = createLog(logPath(base), { now: () => NOW });
  const list = (over = {}) => reviewList({ records: scan(dir).records, today: TODAY, events: log.read(), roots: { [PROJECT]: root }, ...over });
  return { dir, root, log, list, stored: () => Object.fromEntries(scan(dir).records) };
}

// ---- staleness and decay --------------------------------------------------------

test('a confirmed gotcha or how-to is stale once nobody verified it for the limit', () => {
  const old = '2026-05-01'; // 194 days before TODAY

  assert.ok(STALE_DAYS < 194);
  assert.equal(isStale(rec('a', { created: old }), TODAY), true);
  assert.equal(isStale(rec('a', { created: old, type: 'how-to' }), TODAY), true);
  assert.equal(isStale(rec('a', { created: old, last_verified: '2026-10-01' }), TODAY), false);
  assert.equal(isStale(rec('a', { created: old, type: 'decision' }), TODAY), false);
  assert.equal(isStale(rec('a', { created: old, confidence: 'observed' }), TODAY), false);
  assert.equal(isStale(rec('a', { created: '2026-11-01' }), TODAY), false);
});

test('the limits are exclusive: day 180 is not stale, day 181 is; a digest decays on day 61', () => {
  assert.equal(STALE_DAYS, 180);
  assert.equal(DIGEST_DAYS, 60);
  assert.equal(isStale(rec('a', { created: '2026-05-15' }), TODAY), false); // 180 days
  assert.equal(isStale(rec('a', { created: '2026-05-14' }), TODAY), true); // 181 days
  assert.equal(isDecayed(rec('d', { type: 'digest', created: '2026-09-12' }), TODAY), false); // 60 days
  assert.equal(isDecayed(rec('d', { type: 'digest', created: '2026-09-11' }), TODAY), true); // 61 days
});

test('only an old digest decays', () => {
  assert.ok(DIGEST_DAYS < 71);
  assert.equal(isDecayed(rec('d', { type: 'digest', created: '2026-09-01' }), TODAY), true);
  assert.equal(isDecayed(rec('d', { type: 'digest', created: '2026-11-01' }), TODAY), false);
  assert.equal(isDecayed(rec('d', { created: '2020-01-01' }), TODAY), false);
});

test('search leaves an old digest out and ranks a stale memory lower, only when given today', (t) => {
  const records = [
    rec('fresh', { title: 'Packaging hangs on battery', body: 'packaging hangs', created: '2026-11-01' }),
    rec('stale', { title: 'Packaging hangs on battery', body: 'packaging hangs', created: '2026-01-01' }),
    rec('digest', { type: 'digest', title: 'Packaging work of the day', body: 'packaging hangs', created: '2026-01-01' }),
  ].map((r) => [key(r.id), r]);
  const index = createIndex(records);
  t.after(() => index.close());

  const aged = index.search('packaging hangs', { today: TODAY });
  const ageless = index.search('packaging hangs');

  assert.deepEqual(
    aged.map((h) => [h.id, h.stale]),
    [
      ['fresh', false],
      ['stale', true],
    ],
  );
  assert.equal(ageless.length, 3);
  assert.equal(ageless.some((h) => h.stale), false);
});

// ---- anchors --------------------------------------------------------------------

test('anchors are the repository paths a memory names in backticks', () => {
  const body = [
    'Capture lives in `src/memorycapture.js` and `./src/renderer/modules/memoryinbox.js:42`.',
    'Not anchors: `main.js`, `config/*.json`, `~/.claude/projects/x.jsonl`, `config/accounts.local.json`,',
    '`node_modules/electron/dist/x.asar`, `github.com/acme/hud.git`, `../outside/file.js`, `npm run build`,',
    'src/unquoted.js, `C:\\Users\\x\\file.js`, `<config>/memory/global/x.md`.',
  ].join('\n');

  assert.deepEqual(anchorsOf(body), ['src/memorycapture.js', 'src/renderer/modules/memoryinbox.js']);
  assert.deepEqual(anchorsOf(''), []);
});

test('a named file that is gone is missing; without a repository nothing is checked', (t) => {
  const { root } = setup(t);
  // `tools/` and `electron/` are not folders of this repository: those paths name something else.
  const record = rec('a', { body: 'See `src/here.js` and `src/gone.js`. Elsewhere: `tools/setup.mjs`, `electron/dist/app.asar`.' });

  assert.deepEqual(missingAnchors(record, root), ['src/gone.js']);
  assert.deepEqual(missingAnchors(record, null), []);
});

// ---- the review list ------------------------------------------------------------

test('a deliberately broken memory is flagged: its file is gone', (t) => {
  const s = setup(t, [rec('broken', { body: 'The poller is in `src/removed-poller.js`.' }), rec('fine', { body: 'See `src/here.js`.' })]);

  const { items, total } = s.list();

  assert.equal(total, 1);
  assert.equal(items[0].key, key('broken'));
  assert.deepEqual(items[0].flags, [{ kind: 'anchor', missing: ['src/removed-poller.js'] }]);
});

test('the list holds disputed, anchor and stale memories, worst first, and only confirmed ones', (t) => {
  const s = setup(t, [
    rec('a-stale', { created: '2026-01-01' }),
    rec('b-anchor', { body: 'In `src/gone.js`.' }),
    rec('c-disputed'),
    rec('d-waiting', { confidence: 'observed', created: '2026-01-01', body: 'In `src/gone.js`.' }),
    rec('e-replaced', { created: '2026-01-01' }),
    rec('f-newer', { supersedes: ['e-replaced'] }),
  ]);
  s.log.add({ ev: 'disputed', key: key('c-disputed'), by: 'tool', note: 'the flag is --force now' });

  const { items } = s.list();

  assert.deepEqual(
    items.map((i) => [i.id, i.flags.map((f) => f.kind)]),
    [
      ['c-disputed', ['disputed']],
      ['b-anchor', ['anchor']],
      ['a-stale', ['stale']],
    ],
  );
  assert.equal(items[0].flags[0].note, 'the flag is --force now');
  assert.equal(items[2].flags[0].since, '2026-01-01');
});

test('"still true" moves the date, clears the flags and remembers the missing file', (t) => {
  const s = setup(t, [rec('old', { created: '2026-01-01', body: 'It was in `src/gone.js`.' })]);
  s.log.add({ ev: 'disputed', key: key('old'), by: 'tool', note: 'x' });
  assert.equal(s.list().items[0].flags.length, 3);

  const res = verify(s.dir, key('old'), TODAY, { log: s.log, roots: { [PROJECT]: s.root } });

  assert.deepEqual(res, { ok: true, key: key('old') });
  assert.equal(s.stored()[key('old')].last_verified, TODAY);
  assert.equal(s.list().total, 0);
});

test('a file that goes missing after "still true" is flagged again', (t) => {
  const s = setup(t, [rec('two', { body: 'In `src/gone.js` and `src/here.js`.' })]);
  verify(s.dir, key('two'), TODAY, { log: s.log, roots: { [PROJECT]: s.root } });
  assert.equal(s.list().total, 0);

  fs.rmSync(path.join(s.root, 'src', 'here.js'));

  assert.deepEqual(s.list().items[0].flags, [{ kind: 'anchor', missing: ['src/here.js'] }]);
});

test('retire deletes a confirmed memory and logs it', (t) => {
  const s = setup(t, [rec('gone-soon')]);

  assert.deepEqual(retire(s.dir, key('gone-soon'), { log: s.log }), { ok: true, key: key('gone-soon') });

  assert.deepEqual(s.stored(), {});
  assert.deepEqual(
    s.log.read().map((e) => [e.ev, e.key, e.type]),
    [['retired', key('gone-soon'), 'gotcha']],
  );
});

test('verify and retire refuse a bad key, a missing memory and one that is not confirmed', (t) => {
  const s = setup(t, [rec('waiting', { confidence: 'observed' })]);

  for (const act of [(k) => verify(s.dir, k, TODAY), (k) => retire(s.dir, k)]) {
    assert.deepEqual(act('../../x'), { ok: false, reason: 'bad-key' });
    assert.deepEqual(act(key('nope')), { ok: false, reason: 'not-found' });
    assert.deepEqual(act(key('waiting')), { ok: false, reason: 'not-confirmed' });
  }
  assert.equal(s.stored()[key('waiting')].confidence, 'observed');
});

// ---- what a session may report --------------------------------------------------

test('a session that reports "wrong" flags the memory and changes nothing in it', (t) => {
  const s = setup(t, [rec('a')]);
  const before = s.stored()[key('a')];

  const res = toolVerdict(s.dir, { key: key('a'), outcome: 'wrong', note: 'the command is gone', today: TODAY, log: s.log });

  assert.deepEqual(res, { ok: true, key: key('a'), status: 'flagged', changed: false });
  assert.deepEqual(s.stored()[key('a')], before);
  assert.deepEqual(s.list().items[0].flags, [{ kind: 'disputed', at: NOW, note: 'the command is gone' }]);
});

test('a second report on the same memory adds nothing; a report that cannot be kept is refused', (t) => {
  const s = setup(t, [rec('a')]);
  const report = (log) => toolVerdict(s.dir, { key: key('a'), outcome: 'wrong', note: 'again', today: TODAY, log });

  assert.equal(report(s.log).status, 'flagged');
  assert.equal(report(s.log).status, 'flagged');

  assert.equal(s.log.read().filter((e) => e.ev === 'disputed').length, 1);
  assert.deepEqual(report(null), { ok: false, reason: 'log' });
  assert.deepEqual(report({ read: () => [], add: () => false }), { ok: false, reason: 'log' });
});

test('a session that reports "holds" refreshes an old date, at most once a week', (t) => {
  const s = setup(t, [rec('old', { last_verified: '2026-10-01' }), rec('recent', { last_verified: '2026-11-08' }), rec('never')]);
  const report = (id) => toolVerdict(s.dir, { key: key(id), outcome: 'holds', today: TODAY, log: s.log });

  assert.deepEqual(report('old'), { ok: true, key: key('old'), status: 'verified', changed: true });
  assert.deepEqual(report('recent'), { ok: true, key: key('recent'), status: 'fresh', changed: false });
  assert.equal(report('never').status, 'verified');

  assert.equal(s.stored()[key('old')].last_verified, TODAY);
  assert.equal(s.stored()[key('recent')].last_verified, '2026-11-08');
});

test('a session can never confirm a memory, and its "holds" does not settle a report', (t) => {
  const s = setup(t, [rec('waiting', { confidence: 'observed' }), rec('reported', { last_verified: '2026-10-01' })]);
  s.log.add({ ev: 'disputed', key: key('reported'), by: 'tool', note: 'x' });

  const waiting = toolVerdict(s.dir, { key: key('waiting'), outcome: 'holds', today: TODAY, log: s.log });
  toolVerdict(s.dir, { key: key('reported'), outcome: 'holds', today: TODAY, log: s.log });

  assert.equal(waiting.status, 'waiting');
  assert.equal(s.stored()[key('waiting')].confidence, 'observed');
  assert.equal(s.stored()[key('waiting')].last_verified, undefined);
  assert.equal(s.list().items[0].id, 'reported');
});

test('a report with a bad key, an unknown memory or an unknown outcome is refused', (t) => {
  const s = setup(t, [rec('a')]);

  assert.deepEqual(toolVerdict(s.dir, { key: 'C:\\x', outcome: 'holds', today: TODAY }), { ok: false, reason: 'bad-key' });
  assert.deepEqual(toolVerdict(s.dir, { key: key('nope'), outcome: 'holds', today: TODAY }), { ok: false, reason: 'not-found' });
  assert.deepEqual(toolVerdict(s.dir, { key: key('a'), outcome: 'delete', today: TODAY }), { ok: false, reason: 'bad-outcome' });
});
