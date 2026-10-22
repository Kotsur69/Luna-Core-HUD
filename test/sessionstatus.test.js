// sessionstatus.js - the per-tab status light. A light that lies (stuck on
// "working", flickering on every redraw, an approval that never clears) is
// worse than no light, so the priority order and the debounce are pinned here
// with an injected clock.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVITY_MS,
  DEBOUNCE_MS,
  ECHO_MS,
  TURN_STALE_MS,
  createSessionStatus,
  createStatusBoard,
} = require('../src/sessionstatus.js');

function clock(start = 1000000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** Ticks until the debounce has lapsed and returns the committed state. */
function settle(m, c) {
  m.tick();
  c.advance(DEBOUNCE_MS);
  m.tick();
  return m.current().state;
}

test('starts idle', () => {
  const m = createSessionStatus({ now: clock().now });
  assert.equal(m.current().state, 'idle');
});

test('output makes it working, silence brings it back to idle', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.activity();
  assert.equal(settle(m, c), 'working');
  c.advance(ACTIVITY_MS);
  assert.equal(settle(m, c), 'idle');
});

test('debounce: a blip shorter than the window never reaches the light', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.activity();
  assert.equal(m.tick(), null);
  c.advance(DEBOUNCE_MS - 1);
  assert.equal(m.tick(), null);
  assert.equal(m.current().state, 'idle');
  c.advance(1);
  const changed = m.tick();
  assert.equal(changed.state, 'working');
  assert.equal(changed.since, c.now());
});

test('debounce: flapping between states restarts the window', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.approval();
  m.tick();
  c.advance(DEBOUNCE_MS / 2);
  m.input(); // answered before the light even moved
  m.tick();
  c.advance(DEBOUNCE_MS);
  m.tick();
  assert.equal(m.current().state, 'idle');
});

test('tick reports a change once, then null while nothing moves', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.approval();
  m.tick();
  c.advance(DEBOUNCE_MS);
  assert.equal(m.tick().state, 'approval');
  assert.equal(m.tick(), null);
});

test('priority: approval > limit > working > done > idle', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.turnStart();
  m.turnEnd(false);
  assert.equal(settle(m, c), 'done');
  m.activity();
  assert.equal(settle(m, c), 'working');
  m.limit(c.now() + 60 * 60 * 1000);
  assert.equal(settle(m, c), 'limit');
  m.approval();
  assert.equal(settle(m, c), 'approval');
});

test('dead overrides everything and commits without the debounce', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.approval();
  m.limit(null);
  m.activity();
  m.exited();
  assert.equal(m.tick().state, 'dead');
});

test('revive after a restart clears the old process facts', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.approval();
  m.exited();
  m.tick();
  m.revive();
  assert.equal(settle(m, c), 'idle');
});

test('done -> idle once the tab is viewed', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.turnStart();
  m.turnEnd(false);
  assert.equal(settle(m, c), 'done');
  m.viewed();
  assert.equal(settle(m, c), 'idle');
});

test('a turn ending on the tab being watched goes straight to idle', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.turnStart();
  m.turnEnd(true);
  assert.equal(settle(m, c), 'idle');
});

test('a running turn stays working through quiet stretches, but not forever', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.turnStart();
  c.advance(ACTIVITY_MS * 4);
  assert.equal(settle(m, c), 'working');
  c.advance(TURN_STALE_MS);
  assert.equal(settle(m, c), 'idle');
});

test('approval clears on the next input', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.approval();
  assert.equal(settle(m, c), 'approval');
  m.input();
  assert.equal(settle(m, c), 'idle');
});

test('keystroke echo right after input is not work', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  m.input();
  c.advance(ECHO_MS - 1);
  m.activity();
  assert.equal(settle(m, c), 'idle');
});

test('limit carries resetsAt, lapses at the reset time and on a new turn', () => {
  const c = clock();
  const m = createSessionStatus({ now: c.now });
  const resetsAt = c.now() + 10 * DEBOUNCE_MS;
  m.limit(resetsAt);
  settle(m, c);
  assert.deepEqual({ state: m.current().state, resetsAt: m.current().resetsAt }, { state: 'limit', resetsAt });
  c.advance(10 * DEBOUNCE_MS);
  assert.equal(settle(m, c), 'idle');
  assert.equal(m.current().resetsAt, null);

  m.limit(null);
  assert.equal(settle(m, c), 'limit');
  m.turnStart();
  assert.equal(settle(m, c), 'working');
});

test('board: pushes changes only, per session, and counts states', () => {
  const c = clock();
  const pushes = [];
  const board = createStatusBoard({ now: c.now, onChange: (id, s) => pushes.push([id, s.state]) });
  board.approval('a');
  board.activity('b');
  board.tick();
  assert.deepEqual(pushes, []);
  c.advance(DEBOUNCE_MS);
  board.tick();
  board.tick();
  assert.deepEqual(pushes, [['a', 'approval'], ['b', 'working']]);
  assert.equal(board.count('approval'), 1);
  board.input('a');
  c.advance(DEBOUNCE_MS);
  board.tick();
  assert.equal(board.current('a').state, 'idle');
  board.exited('b');
  assert.deepEqual(pushes.at(-1), ['b', 'dead']);
  board.remove('b');
  assert.equal(board.current('b'), null);
});

test('board: activation marks done -> idle', () => {
  const c = clock();
  const board = createStatusBoard({ now: c.now });
  board.turnStart('a');
  board.turnEnd('a', false);
  c.advance(DEBOUNCE_MS);
  board.tick();
  assert.equal(board.current('a').state, 'done');
  board.viewed('a');
  c.advance(DEBOUNCE_MS);
  board.tick();
  assert.equal(board.current('a').state, 'idle');
});
