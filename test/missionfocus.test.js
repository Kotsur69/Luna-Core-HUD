// ============================================================================
// LunaCore - Mission Control focus math tests (src/missionfocus.js)
// ----------------------------------------------------------------------------
// Pure functions: events -> blocks, union across PCs, the Mon-Sun week split.
// Times are built in LOCAL time (new Date(y, m, d, h, min)), like the module.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { eventsToBlocks, mergeBlocks, focusWeek, mondayStart, GAP_MS, TAIL_MS } = require('../src/missionfocus.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Monday 2026-10-12 00:00 local.
const MON = new Date(2026, 9, 12).getTime();
const at = (day, h, m = 0) => new Date(2026, 9, 12 + day, h, m).getTime();
const ev = (ms, key = 'git:a', name = 'a') => ({ ms, key, name });

test('events less than 10 min apart join one block; the block gets a 5 min tail', () => {
  const blocks = eventsToBlocks([ev(at(0, 14, 0)), ev(at(0, 14, 6)), ev(at(0, 14, 12))]);
  assert.deepEqual(blocks, [[at(0, 14, 0), at(0, 14, 17), 'git:a', 'a']]);
});

test('a gap of 10 min or more starts a new block; a lone event counts 5 min', () => {
  const blocks = eventsToBlocks([ev(at(0, 9, 0)), ev(at(0, 9, 10)), ev(at(0, 11, 0))]);
  assert.deepEqual(blocks, [
    [at(0, 9, 0), at(0, 9, 5), 'git:a', 'a'],
    [at(0, 9, 10), at(0, 9, 15), 'git:a', 'a'],
    [at(0, 11, 0), at(0, 11, 5), 'git:a', 'a'],
  ]);
  assert.equal(GAP_MS, 10 * MIN);
  assert.equal(TAIL_MS, 5 * MIN);
});

test('blocks are per project, and unsorted input is fine', () => {
  const blocks = eventsToBlocks([ev(at(0, 10, 5), 'git:b', 'b'), ev(at(0, 10, 0)), ev(at(0, 10, 3), 'git:b', 'b')]);
  assert.deepEqual(blocks, [
    [at(0, 10, 0), at(0, 10, 5), 'git:a', 'a'],
    [at(0, 10, 3), at(0, 10, 10), 'git:b', 'b'],
  ]);
});

test('events with a bad time are ignored', () => {
  assert.deepEqual(eventsToBlocks([ev(NaN), ev(undefined), { ms: 5 }]), []);
});

test('mergeBlocks unions overlapping blocks of one project (the same work seen by two PCs)', () => {
  const merged = mergeBlocks([
    [at(0, 10), at(0, 11), 'git:a', 'a'],
    [at(0, 10, 30), at(0, 12), 'git:a', 'a'],
    [at(0, 12), at(0, 12, 30), 'git:a', 'a'],
    [at(0, 10), at(0, 11), 'git:b', 'b'],
  ]);
  assert.deepEqual(merged, [
    [at(0, 10), at(0, 12, 30), 'git:a', 'a'],
    [at(0, 10), at(0, 11), 'git:b', 'b'],
  ]);
});

test('mondayStart is local Monday 00:00 for every day of the week', () => {
  for (let d = 0; d < 7; d++) assert.equal(mondayStart(at(d, 15)), MON);
});

test('focusWeek: hours per project and per day, sorted by time', () => {
  const f = focusWeek(
    [
      [at(0, 9), at(0, 11), 'git:a', 'a'],
      [at(1, 9), at(1, 10), 'git:a', 'a'],
      [at(0, 13), at(0, 13, 30), 'git:b', 'b'],
    ],
    { now: at(2, 12) }
  );
  assert.equal(f.weekStart, MON);
  assert.equal(f.days.length, 7);
  assert.deepEqual(f.projects.map((p) => [p.key, p.totalMs]), [['git:a', 3 * HOUR], ['git:b', 30 * MIN]]);
  assert.deepEqual(f.projects[0].days.slice(0, 3), [2 * HOUR, HOUR, 0]);
  assert.equal(f.days[0].totalMs, 2.5 * HOUR);
  assert.equal(f.totalMs, 3.5 * HOUR);
});

test('focusWeek: the day total is wall-clock time, so parallel projects are not double-counted', () => {
  const f = focusWeek(
    [
      [at(0, 9), at(0, 11), 'git:a', 'a'],
      [at(0, 10), at(0, 12), 'git:b', 'b'],
    ],
    { now: at(1, 0) }
  );
  assert.equal(f.days[0].totalMs, 3 * HOUR);
  assert.equal(f.projects.reduce((s, p) => s + p.totalMs, 0), 4 * HOUR);
});

test('focusWeek: a block across midnight is split between the two days', () => {
  const f = focusWeek([[at(0, 23), at(1, 1), 'git:a', 'a']], { now: at(3, 0) });
  assert.deepEqual(f.projects[0].days.slice(0, 2), [HOUR, HOUR]);
});

test('focusWeek: last week and the future are cut off', () => {
  const f = focusWeek(
    [
      [at(-1, 22), at(0, 1), 'git:a', 'a'],
      [at(2, 11), at(2, 13), 'git:a', 'a'],
    ],
    { now: at(2, 12) }
  );
  assert.deepEqual(f.projects[0].days.slice(0, 3), [HOUR, 0, HOUR]);
});

test('focusWeek: a project change within 30 min counts as a context switch', () => {
  const f = focusWeek(
    [
      [at(0, 9), at(0, 10), 'git:a', 'a'],
      [at(0, 10, 20), at(0, 11), 'git:b', 'b'], // 20 min after a -> switch
      [at(0, 11, 10), at(0, 11, 30), 'git:a', 'a'], // 10 min after b -> switch
      [at(0, 14), at(0, 15), 'git:b', 'b'], // 2.5 h later -> a fresh start, not a switch
      [at(1, 9), at(1, 10), 'git:a', 'a'],
    ],
    { now: at(2, 0) }
  );
  assert.deepEqual(f.days.map((d) => d.switches).slice(0, 2), [2, 0]);
});

test('focusWeek of nothing is an empty week with no NaN', () => {
  const f = focusWeek([], { now: at(0, 8) });
  assert.equal(f.totalMs, 0);
  assert.deepEqual(f.projects, []);
  assert.ok(f.days.every((d) => d.totalMs === 0 && d.switches === 0));
});

test('a side trip inside a long block is judged against the long block, not the side trip', () => {
  const f = focusWeek(
    [
      [at(0, 9), at(0, 12), 'git:a', 'a'],
      [at(0, 9, 30), at(0, 9, 40), 'git:b', 'b'], // b starts while a runs -> switch
      [at(0, 11), at(0, 11, 10), 'git:c', 'c'], // 80 min after b ended, but a still runs -> switch
    ],
    { now: at(1, 0) }
  );
  assert.equal(f.days[0].switches, 2);
});

test('a block longer than a day is shared as day-sized pieces that add up to the same time', () => {
  const events = [];
  for (let t = at(0, 0); t <= at(2, 12); t += 5 * MIN) events.push(ev(t));
  const blocks = eventsToBlocks(events);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.every(([s, e]) => e - s <= 24 * HOUR));
  assert.equal(mergeBlocks(blocks).length, 1);
  assert.equal(focusWeek(blocks, { now: at(3, 0) }).projects[0].totalMs, at(2, 12) + TAIL_MS - at(0, 0));
});
