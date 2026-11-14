// ============================================================================
// LunaCore - notification hub collectors (src/hubcollect.js)
// ----------------------------------------------------------------------------
// Every collector with empty, broken and normal input. A broken source must
// give [] and never throw (runCollector catches a throw too).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../src/hubcollect.js');
const { ID_RE } = require('../src/hub.js');

const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime();
const BROKEN = [undefined, null, 42, 'x', [], { now: 'soon' }];

const REPORT = [
  '# God Mode run p1abc',
  '',
  '- Repo: `C:\\repos\\Luna-Core-HUD` (base `main`)',
  '- Workers: sonnet, plan',
  '- Result: 5 of 6 packages pushed',
  '- Integration: merge - done',
  '',
  '## Needs you',
  '',
  '- hub-core stalled: merge by hand, then Retry',
  '- 2 manual actions to apply live - see Manual actions.',
  '    npm test failed at line 3',
  '',
  '## Manual actions',
  '',
  '### Migrations',
  '',
  '- `supabase/migrations/001.sql` (from abc1234)',
  '- restart the host',
  '',
  '## Merged / pushed',
  '',
  '- something',
].join('\n');

const CLEAN_REPORT = REPORT.replace(/## Needs you[\s\S]*## Merged/, '## Needs you\n\nNothing - all done\n\n## Manual actions\n\nNone.\n\n## Merged');

function assertIds(items) {
  for (const i of items) assert.match(i.id, ID_RE, `bad id ${i.id}`);
}

test('every collector gives [] for broken input and never throws', () => {
  for (const [name, fn] of Object.entries(c.COLLECTORS)) {
    for (const bad of BROKEN) {
      assert.deepEqual(c.runCollector(fn, bad), [], `${name} with ${JSON.stringify(bad)}`);
    }
  }
});

test('runCollector turns a throw or a non-array into []', () => {
  assert.deepEqual(c.runCollector(() => { throw new Error('boom'); }, {}), []);
  assert.deepEqual(c.runCollector(() => 'nope', {}), []);
});

test('godmode: empty input gives nothing', () => {
  assert.deepEqual(c.collectGodmode({ runs: [], now: NOW }), []);
  assert.deepEqual(c.collectGodmode({ now: NOW }), []);
});

test('godmode: a run gives an info summary plus one needs item per line', () => {
  const items = c.collectGodmode({ runs: [{ id: 'p1abc', mtime: NOW - 1000, text: REPORT }], now: NOW });
  assertIds(items);
  const summary = items.find((i) => i.id === 'godmode:p1abc');
  assert.equal(summary.kind, 'info');
  assert.equal(summary.title, 'God Mode: Luna-Core-HUD - 5 of 6 packages pushed');
  assert.deepEqual(summary.primary, { action: 'openReport', arg: 'p1abc' });
  const needs = items.filter((i) => i.kind === 'needs');
  // The pointer line and the indented tail are not items of their own.
  assert.deepEqual(needs.map((i) => i.title), [
    '- hub-core stalled: merge by hand, then Retry'.slice(2),
    'supabase/migrations/001.sql (from abc1234)',
    'restart the host',
  ]);
  assert.deepEqual(needs.map((i) => i.id), [
    `godmode:p1abc:needs:${c.lineKey(needs[0].title)}`,
    `godmode:p1abc:manual:${c.lineKey(needs[1].title)}`,
    `godmode:p1abc:manual:${c.lineKey(needs[2].title)}`,
  ]);
});

test('godmode: a clean run is info only', () => {
  const items = c.collectGodmode({ runs: [{ id: 'p2', mtime: NOW, text: CLEAN_REPORT }], now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'info');
});

test('godmode: old, malformed and excess runs are left out', () => {
  const runs = [
    { id: 'old', mtime: NOW - c.GODMODE_WINDOW_MS - 1, text: REPORT },
    { id: 'BAD ID', mtime: NOW, text: REPORT },
    { id: 'notext', mtime: NOW },
    ...Array.from({ length: c.MAX_RUNS + 3 }, (_, i) => ({ id: `r${i}`, mtime: NOW - i, text: CLEAN_REPORT })),
  ];
  const items = c.collectGodmode({ runs, now: NOW });
  assert.equal(items.length, c.MAX_RUNS);
  assert.ok(!items.some((i) => i.id.includes('old')));
});

test('godmode: lines per run are capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => `- thing ${i}`).join('\n');
  const text = `# God Mode run p3\n\n## Needs you\n\n${many}\n\n## Manual actions\n\n${many}\n`;
  const items = c.collectGodmode({ runs: [{ id: 'p3', mtime: NOW, text }], now: NOW });
  assert.equal(items.filter((i) => i.id.includes(':needs:')).length, c.MAX_LINES_PER_RUN);
  assert.equal(items.filter((i) => i.id.includes(':manual:')).length, c.MAX_LINES_PER_RUN);
});

test('manualFromReport: none, missing and normal', () => {
  assert.deepEqual(c.manualFromReport(''), []);
  assert.deepEqual(c.manualFromReport(CLEAN_REPORT), []);
  assert.deepEqual(c.manualFromReport(REPORT), ['supabase/migrations/001.sql (from abc1234)', 'restart the host']);
});

test('power: nothing without a countdown', () => {
  assert.deepEqual(c.collectPower({ power: null, now: NOW }), []);
  assert.deepEqual(c.collectPower({ power: { sleep: null, shutdown: null }, now: NOW }), []);
  assert.deepEqual(c.collectPower({ power: { sleep: { phase: 'scheduling', at: null } }, now: NOW }), []);
  assert.deepEqual(c.collectPower({ power: { sleep: { phase: 'countdown', at: NOW - 1 } }, now: NOW }), []);
});

test('power: running countdowns are local needs items with Cancel', () => {
  const items = c.collectPower({
    power: { sleep: { phase: 'countdown', at: NOW + 45000, wakeAt: NOW + 3600000 }, shutdown: { phase: 'countdown', at: NOW + 90000 } },
    now: NOW,
  });
  assertIds(items);
  assert.deepEqual(items.map((i) => [i.kind, i.local, i.primary.arg, i.expiresAt]), [
    ['needs', true, 'sleep', NOW + 45000],
    ['needs', true, 'shutdown', NOW + 90000],
  ]);
});

test('planwait: only a waiting plan gives an item', () => {
  assert.deepEqual(c.collectPlanWait({ wait: null, now: NOW }), []);
  assert.deepEqual(c.collectPlanWait({ wait: { state: 'planning', resumeAt: NOW }, now: NOW }), []);
  assert.deepEqual(c.collectPlanWait({ wait: { state: 'waiting', resumeAt: 'later' }, now: NOW }), []);
  const [item] = c.collectPlanWait({ wait: { state: 'waiting', resumeAt: new Date(2026, 10, 2, 14, 5).getTime() }, now: NOW });
  assert.equal(item.kind, 'info');
  assert.equal(item.local, true);
  assert.equal(item.vars.time, '14:05');
  assert.deepEqual(item.primary, { action: 'cancelPlanWait' });
  assertIds([item]);
});

test('checkin: only an unanswered today is an item', () => {
  assert.deepEqual(c.collectCheckin({ checkin: null }), []);
  assert.deepEqual(c.collectCheckin({ checkin: { today: '2026-11-02', entry: { sleep: null, energy: null } } }), []);
  assert.deepEqual(c.collectCheckin({ checkin: { today: 'today', entry: null } }), []);
  const [item] = c.collectCheckin({ checkin: { today: '2026-11-02', entry: null } });
  assert.equal(item.id, 'life:checkin:2026-11-02');
  assert.equal(item.kind, 'needs');
  assert.equal(item.at, new Date(2026, 10, 2).getTime());
});

test('goals: only a week not asked yet is an item', () => {
  assert.deepEqual(c.collectGoals({ goals: null }), []);
  assert.deepEqual(c.collectGoals({ goals: { week: '2026-W45', goals: [] } }), []);
  assert.deepEqual(c.collectGoals({ goals: { week: '2026-45', goals: null } }), []);
  const [item] = c.collectGoals({ goals: { week: '2026-W45', goals: null } });
  assert.equal(item.id, 'life:goals:2026-W45');
  assert.equal(item.at, new Date(2026, 10, 2).getTime(), 'ISO week 45 of 2026 starts Monday 2 Nov');
  assertIds([item]);
});

test('weekStart handles week 1 across a year boundary', () => {
  // ISO 2026-W01 starts Monday 29 Dec 2025.
  assert.equal(c.weekStart('2026-W01'), new Date(2025, 11, 29).getTime());
  assert.equal(c.weekStart('nope'), 0);
});

test('bills: due soon and overdue bills only, no savings, no paid', () => {
  assert.deepEqual(c.collectBills({ summary: null }), []);
  assert.deepEqual(c.collectBills({ summary: { currency: 'PLN', bills: [] } }), []);
  const bills = [
    { id: 'gas', name: 'Gas', kind: 'bill', expected: 400, month: '2026-11', dueDate: '2026-11-04', status: 'soon' },
    { id: 'tv', name: 'TV', kind: 'subscription', expected: 50, month: '2026-11', dueDate: '2026-10-30', status: 'overdue' },
    { id: 'rent', name: 'Rent', kind: 'bill', expected: 2000, month: '2026-11', dueDate: '2026-11-20', status: 'due' },
    { id: 'paid', name: 'Paid', kind: 'bill', expected: 10, month: '2026-11', dueDate: '2026-11-03', status: 'paid' },
    { id: 'inv', name: 'Invest', kind: 'saving', expected: 500, month: '2026-11', dueDate: '2026-11-03', status: 'soon' },
    { id: 'x', name: '', kind: 'bill', dueDate: '2026-11-03', status: 'soon' },
    null,
  ];
  const items = c.collectBills({ summary: { currency: 'PLN', bills } });
  assertIds(items);
  assert.deepEqual(items.map((i) => [i.id, i.key]), [
    ['bills:gas:2026-11', 'hub.item.billDue'],
    ['bills:tv:2026-11', 'hub.item.billOverdue'],
  ]);
  assert.equal(items[0].title, 'Gas 400 PLN due 2026-11-04');
  assert.deepEqual(items[0].primary, { action: 'openLife', arg: 'bills' });
});

test('update: only an available / downloaded version is an item', () => {
  assert.deepEqual(c.collectUpdate({ update: { state: 'idle', info: null }, now: NOW }), []);
  assert.deepEqual(c.collectUpdate({ update: { state: 'available', info: { version: 42 } }, now: NOW }), []);
  const [item] = c.collectUpdate({ update: { state: 'available', info: { version: '0.21.0', releaseDate: '2026-11-01T10:00:00Z' } }, now: NOW });
  assert.equal(item.id, 'update:0.21.0');
  assert.equal(item.kind, 'info');
  assert.equal(item.at, Date.parse('2026-11-01T10:00:00Z'));
  assert.deepEqual(item.primary, { action: 'installUpdate' });
  const [noDate] = c.collectUpdate({ update: { state: 'downloaded', info: { version: '0.21.0' } }, now: NOW });
  assert.equal(noDate.at, new Date(2026, 10, 2).getTime());
});

// ---- the weekly memory digest ----------------------------------------------------

test('the weekly memory digest is one brief per ISO week, every count in words', () => {
  const start = new Date(2026, 10, 9, 0).getTime();
  const digest = { week: '2026-46', start, proposed: 5, approved: 3, rejected: 1, autoAccepted: 2, graveyard: 4, archived: 1, conflicts: 2 };
  const items = c.COLLECTORS.memory({ count: 0, now: NOW, digest });

  assert.equal(items.length, 1);
  const [item] = items;
  assertIds(items);
  assert.equal(item.id, 'memory:digest:2026-46');
  assert.equal(item.kind, 'brief');
  assert.equal(item.source, 'memory');
  assert.equal(item.at, start);
  assert.equal(item.title, 'Memory this week: 5 proposed, 3 approved, 1 rejected, 2 auto-accepted');
  assert.equal(item.detail, '4 to the graveyard, 1 archived by decay, 2 conflicts open');
  assert.equal(item.key, 'hub.item.memoryDigest');
  assert.equal(item.detailKey, 'hub.item.memoryDigestDetail');
  assert.deepEqual(item.vars, { proposed: 5, approved: 3, rejected: 1, autoAccepted: 2, graveyard: 4, archived: 1, conflicts: 2 });
  assert.deepEqual(item.primary, { action: 'openMemoryInbox' });

  // The hub keeps every count (MAX_VARS).
  const { cleanItem } = require('../src/hub.js');
  assert.deepEqual(cleanItem(item).vars, item.vars);
});

test('the digest comes with the inbox count and stays alone when nothing waits', () => {
  const start = new Date(2026, 10, 9, 0).getTime();
  const digest = { week: '2026-46', start, proposed: 1 };
  const ids = c.COLLECTORS.memory({ count: 3, now: NOW, digest }).map((i) => i.id);
  assert.deepEqual(ids, ['memory:inbox:3', 'memory:digest:2026-46']);
  const [only] = c.COLLECTORS.memory({ count: 0, now: NOW, digest });
  assert.deepEqual(only.vars, { proposed: 1, approved: 0, rejected: 0, autoAccepted: 0, graveyard: 0, archived: 0, conflicts: 0 });
});

test('no digest for an empty week, and a broken digest yields [] without a throw', () => {
  const start = new Date(2026, 10, 9, 0).getTime();
  const empty = { week: '2026-46', start, proposed: 0, approved: 0, rejected: 0, autoAccepted: 0, graveyard: 0, archived: 0, conflicts: 0 };
  assert.deepEqual(c.COLLECTORS.memory({ count: 0, now: NOW, digest: empty }), []);
  for (const digest of [null, undefined, 42, 'x', [], {}, { week: '2026-W46', start, proposed: 3 }, { week: '2026-46', start: 0, proposed: 3 }, { week: '2026-46', start, proposed: -3, approved: '2', rejected: NaN }]) {
    assert.deepEqual(c.runCollector(c.COLLECTORS.memory, { count: 0, now: NOW, digest }), [], JSON.stringify(digest));
  }
  assert.deepEqual(c.digestItems({ week: '2026-46', start, proposed: 1e12 })[0].vars.proposed, 9999, 'a huge count is capped');
});
