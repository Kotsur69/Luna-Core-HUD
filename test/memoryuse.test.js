// ============================================================================
// LunaCore - memory usage from the log (src/memoryuse.js), the `card` tab-start
// event and session tags of src/memorylog.js, and `luna memory stats`
// printing the with/without-card numbers.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLog, readLog, logPath, cleanEvent, forSession, MAX_LOG_BYTES } = require('../src/memorylog.js');
const { readCounts, lastOpened, oldestRead, cardSessions, cardSessionLines, callOf } = require('../src/memoryuse.js');
const { main } = require('../scripts/luna.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/quote';
const NOW = Date.parse('2026-11-11T12:00:00Z');
const key = (id, project = PROJECT) => `${project}/${id}`;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memuse-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = logPath(dir);
  return { dir, file, log: createLog(file, { now: () => NOW }) };
}

// ---- the `card` event and session tags -------------------------------------------

test('a tab start is logged as a card event, with or without the card', (t) => {
  const { log } = setup(t);

  assert.equal(log.add({ ev: 'card', session: 's3', loaded: true, project: PROJECT }), true);
  assert.equal(log.add({ ev: 'card', session: 's4', loaded: false, project: null }), true);

  assert.deepEqual(log.read(), [
    { at: NOW, ev: 'card', session: 's3', loaded: true, project: PROJECT },
    { at: NOW, ev: 'card', session: 's4', loaded: false },
  ]);
});

test('a card event needs a clean tab id and a boolean flag', () => {
  for (const bad of [
    { ev: 'card', loaded: true },
    { ev: 'card', session: 's1' },
    { ev: 'card', session: 's1', loaded: 'yes' },
    { ev: 'card', session: '../s1', loaded: true },
    { ev: 'card', session: 'x'.repeat(65), loaded: true },
  ]) {
    assert.equal(cleanEvent({ at: NOW, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal('project' in cleanEvent({ at: NOW, ev: 'card', session: 's1', loaded: true, project: 'not a project' }), false);
});

test('forSession tags what a tab logs; a bad tag is dropped, the event kept', (t) => {
  const { log } = setup(t);
  const tab = forSession(log, 's7');

  tab.add({ ev: 'search', project: PROJECT, hits: [key('a')] });
  tab.add({ ev: 'get', key: key('a') });
  tab.add({ ev: 'verified', key: key('a'), by: 'tool' });
  tab.add({ ev: 'proposed', key: key('b'), type: 'gotcha', by: 'session' });
  forSession(log, 'bad id!').add({ ev: 'get', key: key('a') });

  const events = tab.read();
  assert.deepEqual(events.slice(0, 4).map((e) => e.session), ['s7', 's7', 's7', 's7']);
  assert.equal('session' in events[4], false);
  assert.equal(events[4].ev, 'get');
});

test('card lines are trimmed with the reads, before decisions', (t) => {
  const { file, log } = setup(t);
  const decision = JSON.stringify({ at: 1, ev: 'approved', key: key('keep'), type: 'gotcha' });
  const card = JSON.stringify({ at: 2, ev: 'card', session: 's1', loaded: true, project: PROJECT });
  const rows = Array.from({ length: Math.ceil(MAX_LOG_BYTES / card.length) + 10 }, () => card);
  fs.writeFileSync(file, [decision, ...rows, ''].join('\n'));

  log.add({ ev: 'get', key: key('newest') });

  const events = readLog(file);
  assert.ok(fs.statSync(file).size < MAX_LOG_BYTES);
  assert.equal(events[0].ev, 'approved');
  assert.ok(events.filter((e) => e.ev === 'card').length < rows.length);
  assert.equal(events.at(-1).key, key('newest'));
});

// ---- per-memory counts ----------------------------------------------------------

test('readCounts adds searches that returned a memory and gets that opened it, in the window', () => {
  const events = [
    { at: 10, ev: 'search', project: PROJECT, hits: [key('a'), key('b')] },
    { at: 20, ev: 'get', key: key('a') },
    { at: 30, ev: 'search', project: null, hits: [key('a')] },
    { at: 40, ev: 'approved', key: key('c'), type: 'gotcha' },
  ];

  const all = readCounts(events);
  assert.equal(all.get(key('a')), 3);
  assert.equal(all.get(key('b')), 1);
  assert.equal(all.has(key('c')), false);
  assert.equal(readCounts(events, { since: 15 }).get(key('a')), 2);
  assert.equal(readCounts(events, { since: 15 }).has(key('b')), false);
});

test('lastOpened keeps the newest get per memory; oldestRead is the first search or get', () => {
  const events = [
    { at: 5, ev: 'approved', key: key('a'), type: 'gotcha' },
    { at: 10, ev: 'search', project: PROJECT, hits: [key('a')] },
    { at: 30, ev: 'get', key: key('a') },
    { at: 20, ev: 'get', key: key('a') },
  ];

  assert.equal(lastOpened(events).get(key('a')), 30);
  assert.equal(oldestRead(events), 10);
  assert.equal(oldestRead([{ at: 5, ev: 'approved', key: key('a'), type: 'gotcha' }]), null);
});

// ---- sessions with and without the card -----------------------------------------

test('callOf counts only what a session called: user verdicts and capture proposals are not calls', () => {
  assert.equal(callOf({ ev: 'search' }), 'search');
  assert.equal(callOf({ ev: 'get' }), 'get');
  assert.equal(callOf({ ev: 'verified', by: 'tool' }), 'verify');
  assert.equal(callOf({ ev: 'disputed', by: 'tool' }), 'verify');
  assert.equal(callOf({ ev: 'verified', by: 'user' }), null);
  assert.equal(callOf({ ev: 'proposed', by: 'session' }), 'propose');
  assert.equal(callOf({ ev: 'proposed' }), null);
});

test('cardSessions splits tab starts by the card and counts each start\'s tool calls', () => {
  const events = [
    { at: 1, ev: 'search', project: PROJECT, hits: [], session: 's1' }, // before any start: nobody's
    { at: 2, ev: 'card', session: 's1', loaded: true, project: PROJECT },
    { at: 3, ev: 'card', session: 's2', loaded: false, project: PROJECT },
    { at: 4, ev: 'search', project: PROJECT, hits: [key('a')], session: 's1' },
    { at: 5, ev: 'get', key: key('a'), session: 's1' },
    { at: 6, ev: 'disputed', key: key('a'), by: 'tool', session: 's1' },
    { at: 7, ev: 'get', key: key('a') }, // untagged: nobody's
    { at: 8, ev: 'search', project: PROJECT, hits: [], session: 's2' },
    { at: 9, ev: 'card', session: 's1', loaded: true, project: OTHER }, // tab s1 restarted
    { at: 10, ev: 'proposed', key: key('b'), type: 'gotcha', by: 'session', session: 's1' },
  ];

  const all = cardSessions(events);
  assert.deepEqual(all.withCard, { sessions: 2, calls: 4, search: 1, get: 1, verify: 1, propose: 1, perSession: 2 });
  assert.deepEqual(all.withoutCard, { sessions: 1, calls: 1, search: 1, get: 0, verify: 0, propose: 0, perSession: 1 });

  const mine = cardSessions(events, { project: PROJECT });
  assert.equal(mine.withCard.sessions, 1);
  assert.equal(mine.withCard.calls, 3);

  const late = cardSessions(events, { since: 9 });
  assert.equal(late.withCard.sessions, 1);
  assert.equal(late.withCard.propose, 1);
  assert.equal(late.withoutCard.sessions, 0);
  assert.equal(late.withoutCard.perSession, null);
});

test('cardSessionLines prints both sides, n/a for no session', () => {
  const lines = cardSessionLines(cardSessions([
    { at: 1, ev: 'card', session: 's1', loaded: true },
    { at: 2, ev: 'get', key: key('a'), session: 's1' },
    { at: 3, ev: 'card', session: 's2', loaded: true },
  ]));

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^with the card: 2 session\(s\), 1 memory tool call\(s\), 0\.5 per session \(search 0, get 1, verify 0, propose 0\)$/);
  assert.match(lines[1], /^without the card: 0 session\(s\), 0 memory tool call\(s\), n\/a per session/);
});

// ---- `luna memory stats` ---------------------------------------------------------

test('luna memory stats prints the with/without-card numbers next to the usefulness bands', (t) => {
  const { dir } = setup(t);
  const log = createLog(logPath(dir));
  log.add({ ev: 'card', session: 's1', loaded: true, project: PROJECT });
  forSession(log, 's1').add({ ev: 'search', project: PROJECT, hits: [key('a')] });
  forSession(log, 's1').add({ ev: 'get', key: key('a') });
  log.add({ ev: 'card', session: 's2', loaded: false, project: PROJECT });
  const printed = [];
  t.mock.method(process.stdout, 'write', (text) => {
    printed.push(String(text));
    return true;
  });

  const code = main(['memory', 'stats', '--dir', dir, '--all']);

  t.mock.restoreAll();
  const text = printed.join('');
  assert.equal(code, 0);
  assert.match(text, /by usefulness score/);
  assert.match(text, /with the card: 1 session\(s\), 2 memory tool call\(s\), 2\.0 per session \(search 1, get 1/);
  assert.match(text, /without the card: 1 session\(s\), 0 memory tool call\(s\), 0\.0 per session/);
});

test('a tab start without the memory tools is logged with tools:false and left out of both sides', (t) => {
  const { log } = setup(t);
  log.add({ ev: 'card', session: 's1', loaded: true, tools: false, project: PROJECT });
  log.add({ ev: 'card', session: 's2', loaded: false, tools: false, project: PROJECT });
  log.add({ ev: 'card', session: 's3', loaded: true, tools: true, project: PROJECT });
  log.add({ ev: 'card', session: 's4', loaded: false, tools: 'yes', project: PROJECT });

  const events = log.read();
  assert.equal(events[0].tools, false);
  assert.equal('tools' in events[3], false, 'a non-boolean is dropped, the start kept');

  const stats = cardSessions(events);
  assert.equal(stats.withCard.sessions, 1);
  assert.equal(stats.withoutCard.sessions, 1, 'a start logged before the flag existed still counts');
});

test('recentUsage counts the reads of the last RECENT_READ_DAYS and names today', () => {
  const { recentUsage, RECENT_READ_DAYS } = require('../src/memoryuse.js');
  const DAY = 24 * 60 * 60 * 1000;
  const key = 'github.com/acme/hud/busy-after-sleep';
  const events = [
    { at: NOW - (RECENT_READ_DAYS + 1) * DAY, ev: 'get', key },
    { at: NOW - 2 * DAY, ev: 'get', key },
    { at: NOW - DAY, ev: 'search', hits: [key, 'global/other'] },
    { at: NOW, ev: 'approved', key },
  ];
  const usage = recentUsage(events, NOW);
  assert.equal(usage.today, '2026-11-11');
  assert.equal(usage.reads.get(key), 2);
  assert.equal(usage.reads.get('global/other'), 1);
  assert.deepEqual(recentUsage([], NOW).reads, new Map());
});
