// ============================================================================
// LunaCore - the memory log (src/memorylog.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLog, readLog, logPath, cleanEvent, captureStats, usage, rejectedTitles, openDisputes, acceptedMissing, decisionEvent, memoryNotes, LOG_FILE, MAX_LOG_BYTES, DAY_MS, USEFULNESS_BANDS } = require('../src/memorylog.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/quote';
const NOW = Date.parse('2026-11-11T12:00:00Z');
const key = (id, project = PROJECT) => `${project}/${id}`;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memlog-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const clock = { at: NOW };
  const file = logPath(dir);
  return { file, clock, log: createLog(file, { now: () => clock.at }) };
}

test('an event is stamped, written as one line and read back', (t) => {
  const { file, log } = setup(t);

  assert.equal(log.add({ ev: 'proposed', key: key('busy'), type: 'gotcha' }), true);
  assert.equal(log.add({ ev: 'get', key: key('busy') }), true);

  assert.equal(path.basename(file), LOG_FILE);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.deepEqual(log.read(), [
    { at: NOW, ev: 'proposed', key: key('busy'), type: 'gotcha' },
    { at: NOW, ev: 'get', key: key('busy') },
  ]);
});

test('what is not a known event is refused and never written', (t) => {
  const { file, log } = setup(t);

  for (const bad of [null, {}, { ev: 'nonsense' }, { ev: 'proposed', key: '../../x', type: 'gotcha' }, { ev: 'proposed', key: key('a'), type: 'spell' }, { ev: 'verified', key: key('a'), by: 'nobody' }, { ev: 'capture', project: 'not a project' }]) {
    assert.equal(log.add(bad), false);
  }

  assert.equal(fs.existsSync(file), false);
});

test('free text in an event is cut to one clean line', () => {
  const event = cleanEvent({ at: NOW, ev: 'disputed', key: key('a'), by: 'tool', note: `line one\nline two​ ${'x'.repeat(500)}`, extra: 'dropped' });

  assert.equal(event.note.includes('\n'), false);
  assert.equal(event.note.includes('​'), false);
  assert.equal(event.note.length, 300);
  assert.equal('extra' in event, false);
});

test('a missing log is empty and a broken line does not lose the others', (t) => {
  const { file, log } = setup(t);

  assert.deepEqual(readLog(file), []);

  log.add({ ev: 'get', key: key('a') });
  fs.appendFileSync(file, '{"at": 5, "ev": "get", "key": \n');
  fs.appendFileSync(file, 'not json at all\n');
  log.add({ ev: 'get', key: key('b') });

  assert.deepEqual(
    log.read().map((e) => e.key),
    [key('a'), key('b')],
  );
});

test('a log past its limit keeps its newer half', (t) => {
  const { file, log } = setup(t);
  const row = `${JSON.stringify({ at: 1, ev: 'get', key: key('old') })}\n`;
  fs.writeFileSync(file, row.repeat(Math.ceil(MAX_LOG_BYTES / row.length) + 10));

  log.add({ ev: 'get', key: key('newest') });

  const events = readLog(file);
  assert.ok(fs.statSync(file).size < MAX_LOG_BYTES);
  assert.equal(events.at(-1).key, key('newest'));
  assert.ok(events.length > 100);
});

test('reads are trimmed before reports and decisions: a search loop cannot push a report out', (t) => {
  const { file, log } = setup(t);
  const report = JSON.stringify({ at: 1, ev: 'disputed', key: key('wrong'), by: 'tool', note: 'the flag is gone' });
  const search = JSON.stringify({ at: 2, ev: 'search', project: PROJECT, hits: Array.from({ length: 20 }, (_, i) => key(`hit-${i}`)) });
  fs.writeFileSync(file, [report, ...Array.from({ length: Math.ceil(MAX_LOG_BYTES / search.length) + 10 }, () => search), ''].join('\n'));

  log.add({ ev: 'get', key: key('newest') });

  const events = readLog(file);
  assert.ok(fs.statSync(file).size < MAX_LOG_BYTES);
  assert.deepEqual(openDisputes(events).get(key('wrong')), { at: 1, note: 'the flag is gone' });
  assert.equal(events.at(-1).key, key('newest'));
});

test('a log of decisions alone still shrinks, oldest first', (t) => {
  const { file, log } = setup(t);
  const row = JSON.stringify({ at: 1, ev: 'proposed', key: key('old'), type: 'gotcha' });
  fs.writeFileSync(file, [...Array.from({ length: Math.ceil(MAX_LOG_BYTES / row.length) + 10 }, () => row), ''].join('\n'));

  log.add({ ev: 'approved', key: key('newest'), type: 'gotcha' });

  assert.ok(fs.statSync(file).size < MAX_LOG_BYTES);
  assert.equal(readLog(file).at(-1).key, key('newest'));
});

test('add never throws when the log cannot be written', (t) => {
  const { file } = setup(t);
  fs.mkdirSync(file); // a folder where the file should be
  const quiet = t.mock.method(console, 'error', () => {});

  assert.equal(createLog(file).add({ ev: 'get', key: key('a') }), false);
  assert.equal(quiet.mock.callCount(), 1);
});

test('the approval rate is approved over decided, per type and in the window', () => {
  const week = NOW - 7 * DAY_MS;
  const events = [
    { at: week - 5, ev: 'proposed', key: key('old'), type: 'gotcha' },
    { at: week - 4, ev: 'edited', key: key('fixed'), type: 'how-to' },
    { at: week + 1, ev: 'capture', project: PROJECT, reason: 'saved', kept: 2, dropped: { duplicate: 2 } },
    { at: week + 2, ev: 'proposed', key: key('a'), type: 'gotcha' },
    { at: week + 2, ev: 'proposed', key: key('b'), type: 'gotcha' },
    { at: week + 3, ev: 'capture', project: OTHER, reason: 'nothing', kept: 0, dropped: { secret: 1 } },
    { at: week + 4, ev: 'approved', key: key('a'), type: 'gotcha' },
    { at: week + 5, ev: 'rejected', key: key('b'), type: 'gotcha', title: 'B' },
    { at: week + 6, ev: 'rejected', key: key('c'), type: 'gotcha', title: 'C' },
    { at: week + 7, ev: 'approved', key: key('fixed'), type: 'how-to' },
    { at: week + 8, ev: 'approved', key: key('z', OTHER), type: 'decision' },
  ];

  const all = captureStats(events, { since: week });
  const mine = captureStats(events, { since: week, project: PROJECT });

  assert.equal(all.captures, 2);
  assert.equal(all.proposed, 2);
  assert.equal(all.approved, 3);
  assert.equal(all.rejected, 2);
  assert.equal(all.edited, 1);
  assert.equal(all.rate, 3 / 5);
  assert.deepEqual(all.dropped, { duplicate: 2, secret: 1 });
  assert.equal(all.byType.gotcha.rate, 1 / 3);
  assert.equal(all.byType['how-to'].edited, 1);
  assert.equal(mine.captures, 1);
  assert.equal(mine.approved, 2);
  assert.equal(mine.byType.decision, undefined);
});

test('the rate of nothing decided is null, not zero', () => {
  assert.equal(captureStats([{ at: NOW, ev: 'proposed', key: key('a'), type: 'gotcha' }]).rate, null);
  assert.equal(captureStats([]).rate, null);
});

test('usage counts how often a memory was found and opened', () => {
  const events = [
    { at: 10, ev: 'search', project: PROJECT, hits: [key('a'), key('b')] },
    { at: 20, ev: 'search', project: null, hits: [key('a')] },
    { at: 30, ev: 'get', key: key('a') },
  ];

  const counts = usage(events);

  assert.deepEqual(counts.get(key('a')), { found: 2, opened: 1, last: 30 });
  assert.deepEqual(counts.get(key('b')), { found: 1, opened: 0, last: 10 });
  assert.equal(usage(events, { since: 25 }).has(key('b')), false);
});

test('rejected titles come back newest first, for the project and global only, without repeats', () => {
  const events = [
    { at: 1, ev: 'rejected', key: key('a'), type: 'gotcha', title: 'Oldest' },
    { at: 2, ev: 'rejected', key: key('x', OTHER), type: 'gotcha', title: 'Other project' },
    { at: 3, ev: 'rejected', key: 'global/g', type: 'preference', title: 'A global one' },
    { at: 4, ev: 'approved', key: key('b'), type: 'gotcha' },
    { at: 5, ev: 'rejected', key: key('c'), type: 'gotcha', title: 'Oldest' },
    { at: 6, ev: 'rejected', key: key('d'), type: 'gotcha' },
  ];

  assert.deepEqual(rejectedTitles(events, PROJECT), ['Oldest', 'A global one']);
  assert.deepEqual(rejectedTitles(events, PROJECT, 1), ['Oldest']);
});

test("a report stays open until the user settles it; a session's own 'it held' does not close it", () => {
  const events = [
    { at: 1, ev: 'disputed', key: key('a'), by: 'tool', note: 'flag renamed' },
    { at: 2, ev: 'verified', key: key('a'), by: 'tool' },
    { at: 3, ev: 'disputed', key: key('b'), by: 'tool' },
    { at: 4, ev: 'verified', key: key('b'), by: 'user' },
    { at: 5, ev: 'disputed', key: key('c'), by: 'tool', note: 'gone' },
    { at: 6, ev: 'retired', key: key('c'), type: 'gotcha' },
    { at: 7, ev: 'disputed', key: key('d'), by: 'tool', note: 'never approved' },
    { at: 8, ev: 'rejected', key: key('d'), type: 'gotcha', title: 'D' },
  ];

  const open = openDisputes(events);

  assert.deepEqual([...open.keys()], [key('a')]);
  assert.deepEqual(open.get(key('a')), { at: 1, note: 'flag renamed' });
});

test('the missing files the user accepted are remembered per memory, latest verification wins', () => {
  const events = [
    { at: 1, ev: 'verified', key: key('a'), by: 'user', missing: ['src/old.js'] },
    { at: 2, ev: 'verified', key: key('a'), by: 'tool' },
    { at: 3, ev: 'verified', key: key('a'), by: 'user', missing: ['src/older.js'] },
  ];

  assert.deepEqual([...acceptedMissing(events).get(key('a'))], ['src/older.js']);
});

test('a dropped candidate is logged with its reason and score; the score of any event must be 0-100', (t) => {
  const { log } = setup(t);

  assert.equal(log.add({ ev: 'dropped', project: PROJECT, reason: 'low usefulness', type: 'gotcha', title: 'Weak\nthing', usefulness: 12 }), true);
  assert.equal(log.add({ ev: 'dropped', project: 'not a project', reason: 'low usefulness' }), false);
  assert.equal(log.add({ ev: 'dropped', project: PROJECT, reason: '' }), false);
  log.add({ ev: 'proposed', key: key('a'), type: 'gotcha', usefulness: 140 });
  log.add({ ev: 'approved', key: key('a'), type: 'gotcha', usefulness: 77 });
  log.add({ ev: 'rejected', key: key('b'), type: 'gotcha', title: 'B', usefulness: '50' });

  assert.deepEqual(
    log.read().map(({ at, ...event }) => event),
    [
      { ev: 'dropped', project: PROJECT, reason: 'low usefulness', type: 'gotcha', title: 'Weak thing', usefulness: 12 },
      { ev: 'proposed', key: key('a'), type: 'gotcha' },
      { ev: 'approved', key: key('a'), type: 'gotcha', usefulness: 77 },
      { ev: 'rejected', key: key('b'), type: 'gotcha', title: 'B' },
    ],
  );
});

test('a dropped title is never offered back to the extractor as not wanted', () => {
  const events = [{ at: NOW, ev: 'dropped', project: PROJECT, reason: 'low usefulness', title: 'Weak thing', usefulness: 10 }];

  assert.deepEqual(rejectedTitles(events, PROJECT), []);
});

test('decisionEvent builds the same line for the app and the CLI', () => {
  const record = { project: PROJECT, id: 'a', type: 'how-to', title: 'A title', usefulness: 61 };

  assert.deepEqual(decisionEvent('approved', record), { ev: 'approved', key: key('a'), type: 'how-to', usefulness: 61 });
  assert.deepEqual(decisionEvent('rejected', record), { ev: 'rejected', key: key('a'), type: 'how-to', title: 'A title', usefulness: 61 });
  assert.deepEqual(decisionEvent('edited', { ...record, usefulness: undefined }), { ev: 'edited', key: key('a'), type: 'how-to' });
});

test('decisions are counted per usefulness band; a score under the bands is under, none is unscored', () => {
  const decision = (ev, id, usefulness) => ({ at: NOW, ev, key: key(id), type: 'gotcha', ...(usefulness === undefined ? {} : { usefulness }) });
  const events = [
    decision('approved', 'a', 30),
    decision('rejected', 'b', 49),
    decision('rejected', 'c', 50),
    decision('approved', 'd', 69),
    decision('approved', 'e', 70),
    decision('approved', 'f', 84),
    decision('approved', 'g', 85),
    decision('rejected', 'h', 100),
    decision('approved', 'i'),
    decision('rejected', 'j', 10),
    decision('approved', 'l', 0),
    { at: NOW, ev: 'proposed', key: key('k'), type: 'gotcha', usefulness: 90 },
  ];

  const stats = captureStats(events);

  assert.deepEqual(stats.bands, [
    { label: '30-49', approved: 1, rejected: 1 },
    { label: '50-69', approved: 1, rejected: 1 },
    { label: '70-84', approved: 2, rejected: 0 },
    { label: '85-100', approved: 1, rejected: 1 },
  ]);
  assert.deepEqual(stats.under, { approved: 1, rejected: 1 });
  assert.deepEqual(stats.unscored, { approved: 1, rejected: 0 });
  assert.deepEqual(
    USEFULNESS_BANDS.map((b) => b.label),
    ['30-49', '50-69', '70-84', '85-100'],
  );
  assert.deepEqual(
    captureStats([]).bands.map((b) => b.approved + b.rejected),
    [0, 0, 0, 0],
  );
});

// ---- memory notes (luna memory notes) ----------------------------------------------------

const memo = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: '2026-10-01',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `SECRET BODY of ${id} that must never be printed`,
  ...over,
});

test('memory notes list what was confirmed, superseded, archived and retired since a date, by type, titles only', () => {
  const since = Date.parse('2026-11-01T00:00:00Z');
  const records = [
    memo('new-gotcha'),
    memo('new-decision', { type: 'decision', title: 'Use one ledger per PC', supersedes: ['old-decision'] }),
    memo('old-decision', { type: 'decision', title: 'Use one ledger for both PCs' }),
    memo('auto-howto', { type: 'how-to', title: 'Run tests through PowerShell' }),
    memo('before-tag', { title: 'Approved before the tag' }),
    memo('dusty', { type: 'project-fact', title: 'An unused fact', archived: '2026-11-05' }),
    memo('dusty-old', { type: 'project-fact', title: 'Archived long ago', archived: '2026-09-01' }),
    memo('lost-pair', { title: 'Lost a conflict' }),
    memo('elsewhere', { project: OTHER, title: 'Another project memory' }),
  ];
  const at = (day) => Date.parse(`2026-11-${day}T10:00:00Z`);
  const events = [
    { at: Date.parse('2026-10-20T10:00:00Z'), ev: 'approved', key: key('before-tag'), type: 'gotcha' },
    { at: at('02'), ev: 'approved', key: key('new-gotcha'), type: 'gotcha' },
    { at: at('03'), ev: 'approved', key: key('new-decision'), type: 'decision' },
    { at: at('04'), ev: 'auto-accepted', key: key('auto-howto'), type: 'how-to' },
    { at: at('05'), ev: 'superseded', key: key('lost-pair'), type: 'gotcha', title: 'Lost a conflict' },
    // A retired memory is gone from the mirror: the title comes from the log.
    { at: at('06'), ev: 'retired', key: key('gone'), type: 'reference', title: 'A link that died' },
    { at: at('07'), ev: 'approved', key: key('elsewhere', OTHER), type: 'gotcha' },
    { at: at('08'), ev: 'rejected', key: key('nope'), type: 'gotcha', title: 'Rejected, never in notes' },
    { at: at('08'), ev: 'get', key: key('new-gotcha') },
  ];

  const text = memoryNotes({ records, events, since, project: PROJECT, label: 'v0.28.0' });

  assert.equal(
    text,
    [
      '# Memory notes since v0.28.0 (2026-11-01), github.com/acme/hud',
      '',
      '## Confirmed (3)',
      '',
      '### decision',
      '- Use one ledger per PC',
      '',
      '### gotcha',
      '- Title of new-gotcha',
      '',
      '### how-to',
      '- Run tests through PowerShell',
      '',
      '## Superseded (2)',
      '',
      '### decision',
      '- Use one ledger for both PCs',
      '',
      '### gotcha',
      '- Lost a conflict',
      '',
      '## Archived (1)',
      '',
      '### project-fact',
      '- An unused fact',
      '',
      '## Retired (1)',
      '',
      '### reference',
      '- A link that died',
      '',
    ].join('\n'),
  );
  assert.doesNotMatch(text, /SECRET BODY/);
});

test('memory notes without a project cover every project; an empty window says none', () => {
  const since = Date.parse('2026-11-01T00:00:00Z');
  const events = [{ at: since + DAY_MS, ev: 'approved', key: key('elsewhere', OTHER), type: 'gotcha' }];
  const all = memoryNotes({ records: [memo('elsewhere', { project: OTHER, title: 'Another project memory' })], events, since });
  assert.match(all, /^# Memory notes since 2026-11-01\n/);
  assert.match(all, /## Confirmed \(1\)\n\n### gotcha\n- Another project memory/);

  const none = memoryNotes({ records: [], events: [], since, project: PROJECT });
  for (const heading of ['Confirmed', 'Superseded', 'Archived', 'Retired']) assert.ok(none.includes(`## ${heading} (0)\n\n_None._`));
});

test('memory notes escape markdown in titles, so a title cannot become a link or HTML', () => {
  const since = Date.parse('2026-11-01T00:00:00Z');
  const records = [memo('linky', { title: 'Click [here](http://evil.example) <img src=x> *now*' })];
  const events = [{ at: since + DAY_MS, ev: 'approved', key: key('linky'), type: 'gotcha' }];
  const text = memoryNotes({ records, events, since, project: PROJECT });
  assert.ok(text.includes('- Click \\[here\\](http:\\/\\/evil.example) \\<img src=x\\> \\*now\\*'), text);
  const bare = memoryNotes({ records: [memo('bare', { title: 'See https://evil.example and www.evil.example' })], events: [{ at: since + DAY_MS, ev: 'approved', key: key('bare'), type: 'gotcha' }], since });
  assert.ok(bare.includes('- See https:\\/\\/evil.example and www\\.evil.example'), bare);
});

// ---- the graveyard restore and the weekly digest ---------------------------------

const { isoWeek, weeklyCounts } = require('../src/memorylog.js');

test('`restored` is a logged event with its key, type, title and score', (t) => {
  const { log } = setup(t);
  assert.equal(log.add({ ev: 'restored', key: key('back'), type: 'gotcha', title: 'Came back', usefulness: 12, junk: 'x' }), true);
  assert.equal(log.add({ ev: 'restored', key: '../x', type: 'gotcha' }), false, 'a bad key is not logged');
  assert.deepEqual(log.read(), [{ at: NOW, ev: 'restored', key: key('back'), type: 'gotcha', title: 'Came back', usefulness: 12 }]);
});

test('isoWeek names the ISO week and its Monday, across year ends', () => {
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
  assert.deepEqual(isoWeek(at(2026, 11, 14)), { key: '2026-46', start: at(2026, 11, 9, 0) });
  assert.equal(isoWeek(at(2026, 11, 9, 0)).key, '2026-46', 'Monday midnight starts the week');
  assert.equal(isoWeek(at(2026, 11, 8, 23)).key, '2026-45', 'Sunday ends the week before');
  assert.equal(isoWeek(at(2025, 12, 29)).key, '2026-01', 'a late December day can be week 1 of the next year');
  assert.equal(isoWeek(at(2027, 1, 3)).key, '2026-53', 'an early January day can be the last week of the year before');
  assert.equal(isoWeek(at(2021, 1, 3)).key, '2020-53');
});

test('weeklyCounts counts this week only: proposed, approved, rejected, auto-accepted, graveyard, archived', () => {
  const now = new Date(2026, 10, 14, 12).getTime(); // Saturday of week 2026-46
  const monday = new Date(2026, 10, 9, 0).getTime();
  const ev = (at, e, over = {}) => ({ at, ev: e, key: key('m'), type: 'gotcha', ...over });
  const events = [
    ev(monday - 1, 'proposed'), // last week
    ev(monday, 'proposed'),
    ev(monday + 1, 'proposed'),
    ev(now - 5, 'approved'),
    ev(now - 4, 'rejected', { title: 'No' }),
    ev(now - 3, 'auto-accepted'),
    { at: now - 2, ev: 'dropped', project: PROJECT, reason: 'low usefulness', title: 'Weak', usefulness: 3 },
    ev(now - 1, 'restored'),
    { at: now - 1, ev: 'search', project: PROJECT, hits: [] },
    ev(now + 1000, 'approved'), // after now: not counted
    null,
    { at: 'x', ev: 'proposed' },
  ];
  const records = [
    { archived: '2026-11-10' },
    { archived: '2026-11-08' }, // last week
    { archived: null },
    {},
    null,
  ];

  assert.deepEqual(weeklyCounts(events, { now, records }), {
    week: '2026-46',
    start: monday,
    proposed: 2,
    approved: 1,
    rejected: 1,
    autoAccepted: 1,
    graveyard: 1,
    archived: 1,
  });
  assert.deepEqual(weeklyCounts([], { now }), { week: '2026-46', start: monday, proposed: 0, approved: 0, rejected: 0, autoAccepted: 0, graveyard: 0, archived: 0 });
  assert.deepEqual(weeklyCounts(null, { now, records: 'x' }).proposed, 0, 'broken input counts nothing');
});

test('`merged` is a logged event with the new key, its type, title and the keys it was made from', (t) => {
  const { log } = setup(t);
  assert.equal(log.add({ ev: 'merged', key: key('both'), type: 'gotcha', title: 'One of two', from: [key('a'), '../x', key('b'), key('a'), key('both')] }), true);
  assert.equal(log.add({ ev: 'merged', key: key('none'), type: 'gotcha', from: ['../x'] }), false, 'a merge from nothing valid is not logged');
  assert.equal(log.add({ ev: 'merged', key: key('none'), type: 'gotcha' }), false);
  assert.equal(log.add({ ev: 'merged', key: '../x', type: 'gotcha', from: [key('a')] }), false, 'a bad key is not logged');
  assert.deepEqual(log.read(), [{ at: NOW, ev: 'merged', key: key('both'), type: 'gotcha', title: 'One of two', from: [key('a'), key('b')] }]);
  assert.equal(cleanEvent({ at: 1, ev: 'merged', key: key('m'), type: 'nope', from: [key('a')] }), null, 'an unknown type is refused');
});

test('memoryNotes lists a merged memory as confirmed', () => {
  const since = NOW - DAY_MS;
  const records = [{ id: 'both', type: 'gotcha', project: PROJECT, title: 'One of two', supersedes: ['a', 'b'] }];
  const text = memoryNotes({ records, events: [{ at: NOW, ev: 'merged', key: key('both'), type: 'gotcha', from: [key('a'), key('b')] }], since, project: PROJECT });
  assert.match(text, /## Confirmed \(1\)[\s\S]*- One of two/);
  assert.match(text, /## Superseded \(2\)/);
});
