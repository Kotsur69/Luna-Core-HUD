// ============================================================================
// LunaCore - weekly + daily brief (src/missionbrief.js) and its IPC in
// src/missioncontrolipc.js
// ----------------------------------------------------------------------------
// Fake sources, fake runner, temp history file. Pins: one call per brief with
// only Gmail's read-only tools, validation against the inputs, the weekly
// schedule (once per ISO week, any day from Monday), the daily brief never
// scheduled, Regenerate only on confirm, the weekend window starting after
// the Sunday review.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBrief, createBriefStore, validateBrief, weekendStart, gatherInputs, MAX_DAILY } = require('../src/missionbrief.js');
const { registerMissionIpc } = require('../src/missioncontrolipc.js');

const MON = new Date(2026, 9, 26, 9).getTime(); // Monday, ISO 2026-W44

const INPUTS = {
  events: [{ key: 'e1', title: 'Trackday', start: '2026-10-28T09:00:00+01:00', weather: null }],
  todos: { totalOpen: 1, projects: [{ project: 'LunaCore', open: 1, items: ['Ship brief'] }] },
};

test('validateBrief keeps only sent events / to-dos and well-formed mail rows', () => {
  const b = validateBrief(
    {
      headline: 'Big week.',
      priorities: ['a', 'b', 'c', 'd', 'e', 'f'],
      events: [{ key: 'e1', note: 'rain 60%' }, { key: 'e9', note: 'invented' }, { key: 'e1', note: 'dup' }],
      todos: [{ project: 'LunaCore', text: 'Ship brief' }, { project: 'LunaCore', text: 'Made up' }],
      mail: [{ threadId: 'abc_1', from: 'Bank', subject: 'Sign', why: 'needs a signature' }, { threadId: '../x', from: 'x' }],
      news: ['n1'],
    },
    INPUTS
  );
  assert.equal(b.priorities.length, 5);
  assert.deepEqual(b.events, [{ key: 'e1', note: 'rain 60%' }]);
  assert.deepEqual(b.todos, [{ project: 'LunaCore', text: 'Ship brief' }]);
  assert.deepEqual(b.mail.map((m) => m.threadId), ['abc_1']);
  assert.equal(validateBrief({ priorities: [] }, INPUTS), null);
});

test('weekendStart is the Friday 18:00 before the week', () => {
  assert.equal(weekendStart('2026-10-26'), new Date(2026, 9, 23, 18).getTime());
  assert.equal(weekendStart('2026-10-29'), new Date(2026, 9, 23, 18).getTime());
});

function sources(over = {}) {
  const calls = { range: [], commits: [], calendar: [] };
  return {
    calls,
    src: {
      range: async (req) => {
        calls.range.push(req);
        return { ok: true, totalUsd: 2, projects: [{ name: 'LunaCore', usd: 2, cls: 'fun' }], hours: [{ name: 'LunaCore', ms: 3 * 3600000, cls: 'fun' }] };
      },
      commits: async (s, u) => {
        calls.commits.push([s, u]);
        return [{ repo: 'luna', commits: 4, feat: [], fix: 0, added: 1, removed: 0 }];
      },
      calendar: async (from, to) => {
        calls.calendar.push([from, to]);
        return { events: [{ id: 'g1', title: 'Trackday', start: '2026-10-28T09:00:00+01:00', end: '2026-10-28T17:00:00+01:00', location: 'Tor Poznan' }], weather: { g1: { tMin: 8, tMax: 14, rain: 60, wind: 20, place: 'Poznan' } } };
      },
      todos: async () => INPUTS.todos,
      goals: async () => [],
      review: async () => null,
      ...over,
    },
  };
}

test('weekly inputs: weekend since Fri 18:00, events with weather, no path or id leaks', async () => {
  const { src, calls } = sources();
  const inputs = await gatherInputs('weekly', src, MON, { at: 1, briefing: ['news 1'] });
  assert.equal(calls.range[0].sinceMs, new Date(2026, 9, 23, 18).getTime());
  assert.equal(calls.range[0].untilMs, MON);
  assert.equal(inputs.weekend.claude.hours.fun, 3);
  assert.equal(inputs.weekend.claude.funPct, 100);
  assert.equal(inputs.events[0].key, 'e1');
  assert.equal(inputs.events[0].weather.rain, 60);
  assert.equal(JSON.stringify(inputs).includes('g1'), false);
  assert.deepEqual(inputs.goals, { week: '2026-W44', goals: [] });
  assert.deepEqual(inputs.news.briefing, ['news 1']);
});

test('weekly inputs start after the Sunday review when it is later than Fri 18:00', async () => {
  const reviewAt = new Date(2026, 9, 25, 20, 5).getTime();
  const { src, calls } = sources({ review: async () => ({ week: '2026-W43', at: reviewAt, review: { headline: 'H' } }) });
  const inputs = await gatherInputs('weekly', src, MON, null);
  assert.equal(calls.range[0].sinceMs, reviewAt);
  assert.deepEqual(inputs.review, { week: '2026-W43', at: reviewAt, headline: 'H' });
});

test('a failing source is {error}, the brief still gets the rest', async () => {
  const { src } = sources({ calendar: async () => { throw Object.assign(new Error('x'), { reason: 'gcal-not-connected' }); } });
  const inputs = await gatherInputs('daily', src, MON, null);
  assert.deepEqual(inputs.events, []);
  assert.equal(inputs.calendarError, 'gcal-not-connected');
  assert.equal(inputs.yesterday[0].repo, 'luna');
});

function setup({ answer = { headline: 'Hi', events: [{ key: 'e1', note: 'n' }] }, clock = MON } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-brief-')), 'mission-brief.local.json');
  const store = createBriefStore({ file });
  const runs = [];
  let at = clock;
  const brief = createBrief({
    store,
    run: async (job) => {
      runs.push(job);
      return { ok: true, answer, costUsd: 0.03 };
    },
    getEnv: () => ({}),
    sources: sources().src,
    now: () => at,
  });
  return { store, runs, brief, setNow: (v) => (at = v) };
}

test('one call per brief, Gmail read-only tools only, not lean', async () => {
  const h = setup();
  const res = await h.brief.generate('daily');
  assert.equal(res.ok, true);
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.runs[0].allowed, ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread']);
  assert.equal(h.runs[0].lean, undefined);
  assert.match(h.runs[0].prompt, /READ-ONLY/);
  assert.equal(res.entry.costUsd, 0.03);
  assert.equal(res.entry.brief.headline, 'Hi');
});

test('the weekly brief: once per ISO week from Monday on; the daily one is never scheduled', async () => {
  const h = setup();
  assert.equal(h.brief.weeklyDue(), true);
  const res = await h.brief.tick();
  assert.equal(res.entry.kind, 'weekly');
  assert.equal(res.entry.key, '2026-W44');
  h.setNow(new Date(2026, 9, 29, 9).getTime()); // Thursday, same week
  assert.equal(await h.brief.tick(), null);
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.store.load().daily, {});
  h.setNow(new Date(2026, 10, 4, 9).getTime()); // Wednesday next week: first launch then
  assert.equal((await h.brief.tick()).entry.key, '2026-W45');
});

test('Regenerate needs an explicit overwrite', async () => {
  const h = setup();
  await h.brief.generate('daily');
  assert.deepEqual(await h.brief.generate('daily'), { ok: false, reason: 'exists' });
  assert.equal((await h.brief.generate('daily', { overwrite: true })).ok, true);
  assert.equal(h.runs.length, 2);
  assert.deepEqual(await h.brief.generate('hourly'), { ok: false, reason: 'bad-input' });
});

test('unusable output keeps the inputs; history caps at 14 daily', async () => {
  const h = setup({ answer: { nope: true } });
  const res = await h.brief.generate('daily');
  assert.equal(res.entry.brief, null);
  assert.equal(res.entry.failure, 'bad-json');
  assert.equal(res.entry.inputs.events[0].title, 'Trackday');
  for (let d = 1; d <= MAX_DAILY + 3; d++) h.store.put({ kind: 'daily', key: `2026-09-${String(d).padStart(2, '0')}`, at: d, model: 'haiku', costUsd: null, brief: null, failure: 'x', inputs: {} });
  assert.equal(Object.keys(h.store.load().daily).length, MAX_DAILY);
});

test('rememberNews keeps the last briefing for the next brief', () => {
  const h = setup();
  h.brief.rememberNews(['one', 'two']);
  h.brief.rememberNews([]);
  assert.deepEqual(h.store.load().lastNews.briefing, ['one', 'two']);
});

test('mission:brief* IPC: kinds and models from fixed lists, exists until confirmed', async () => {
  const handlers = new Map();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-brief-ipc-')), 'mission-brief.local.json');
  registerMissionIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
    getModel: () => 'haiku',
    getEnv: () => ({}),
    run: async () => ({ ok: true, answer: { headline: 'Hi' }, costUsd: 0.01 }),
    gcal: { status: () => ({}) },
    github: { fetch: async () => ({}), urlFor: () => null },
    briefStore: createBriefStore({ file }),
    briefSources: sources().src,
  });
  const call = (ch, arg) => handlers.get(ch)({}, arg);
  assert.deepEqual(await call('mission:brief-run', { kind: 'evil' }), { ok: false, reason: 'bad-input' });
  const res = await call('mission:brief-run', { kind: 'daily' });
  assert.equal(res.ok, true);
  assert.equal(res.daily.entry.brief.headline, 'Hi');
  assert.equal((await call('mission:brief-run', { kind: 'daily' })).reason, 'exists');
  assert.equal((await call('mission:brief-run', { kind: 'daily', overwrite: true })).ok, true);
  assert.deepEqual(await call('mission:brief-model', { model: 'gpt-5' }), { ok: false, reason: 'bad-input' });
  assert.equal((await call('mission:brief-model', { model: 'opus' })).model, 'opus');
  assert.equal((await call('mission:brief', { daily: 'not-a-key' })).daily.keys.length, 1);
});
