// ============================================================================
// LunaCore - list FLIP tests (v0.10 phase 3.3)
// ----------------------------------------------------------------------------
// planList() is pure and takes plain rect objects, so most of the interesting
// behaviour is testable with two Maps. The rest needs a DOM, but only the four
// bits of one flip.js actually touches - getBoundingClientRect, dataset,
// classList and animate() - which is little enough to stub honestly here rather
// than pull in jsdom for.
//
// The stub records every animate() call instead of running it, which is what
// makes the important assertion possible at all: that an UNCHANGED list
// animates NOTHING. That is the case this whole module exists for - these
// lists re-render every few seconds and used to blink each time - and it is
// invisible in a browser precisely when it is working.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planList,
  beginListUpdate,
  endListUpdate,
  FLIP_ANIMATE_CAP,
  GHOST_CLASS,
  LIST_CLASS,
} = require('../src/renderer/modules/flip.js');

const rectsOf = (entries) => new Map(entries.map(([k, top, left]) => [k, { top, left }]));

// ---- planList (pure) -------------------------------------------------------

test('planList: a list that did not change plans nothing', () => {
  const same = () =>
    rectsOf([
      ['a', 0, 0],
      ['b', 20, 0],
      ['c', 40, 0],
    ]);
  const plan = planList(same(), same());
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.enters, []);
  assert.deepEqual(plan.exits, []);
});

test('planList: a moved row is inverted, not described forwards', () => {
  // FLIP animates FROM where the row was TO where it is, so the delta has to
  // point backwards. Getting this sign wrong is the classic way to end up with
  // rows that fly off in the wrong direction.
  const prev = rectsOf([['a', 60, 0]]);
  const next = rectsOf([['a', 20, 0]]);
  assert.deepEqual(planList(prev, next).moves, [{ key: 'a', dx: 0, dy: 40 }]);
});

test('planList: horizontal movement is reported too', () => {
  const plan = planList(rectsOf([['a', 0, 90]]), rectsOf([['a', 0, 30]]));
  assert.deepEqual(plan.moves, [{ key: 'a', dx: 60, dy: 0 }]);
});

test('planList: an unknown key is an enter, a vanished key is an exit', () => {
  const prev = rectsOf([
    ['a', 0, 0],
    ['gone', 20, 0],
  ]);
  const next = rectsOf([
    ['a', 0, 0],
    ['new', 20, 0],
  ]);
  const plan = planList(prev, next);
  assert.deepEqual(plan.exits, ['gone']);
  assert.equal(plan.enters.length, 1);
  assert.equal(plan.enters[0].key, 'new');
  assert.equal(plan.enters[0].animate, true);
  assert.deepEqual(plan.moves, [], 'a row that stayed put must not animate');
});

test('planList: entrances past the cap are reported but not animated', () => {
  // A 40-row list staggering all 40 is most of a second of nonsense. Every row
  // is still REPORTED - the cap is on the reveal, not on the render.
  const next = rectsOf([...Array(40)].map((_, i) => [`k${i}`, i * 10, 0]));
  const plan = planList(new Map(), next);
  assert.equal(plan.enters.length, 40);
  const animated = plan.enters.filter((e) => e.animate);
  assert.equal(animated.length, FLIP_ANIMATE_CAP);
  assert.equal(plan.enters[FLIP_ANIMATE_CAP].animate, false);
  // The index keeps counting so the stagger stays evenly spaced.
  assert.equal(plan.enters[5].index, 5);
});

test('planList: a custom cap is honoured', () => {
  const next = rectsOf([
    ['a', 0, 0],
    ['b', 10, 0],
    ['c', 20, 0],
  ]);
  const plan = planList(new Map(), next, 2);
  assert.deepEqual(
    plan.enters.map((e) => e.animate),
    [true, true, false]
  );
});

test('planList: anything that is not a Map is treated as empty', () => {
  const next = rectsOf([['a', 0, 0]]);
  assert.equal(planList(null, next).enters.length, 1);
  assert.deepEqual(planList(next, undefined).exits, ['a']);
});

// ---- the DOM half ----------------------------------------------------------

function fakeNode(key, rect) {
  const classes = new Set();
  const node = {
    dataset: key === undefined ? {} : { flipKey: key },
    style: {},
    parent: null,
    removed: false,
    animations: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    getBoundingClientRect: () => ({ ...rect }),
    animate(frames, opts) {
      node.animations.push({ frames, opts });
      return { finished: Promise.resolve() };
    },
    remove() {
      node.removed = true;
      if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
    },
  };
  return node;
}

function fakeList(children, opts = {}) {
  const classes = new Set();
  const rect = opts.rect || { top: 0, left: 0, width: 300, height: 200 };
  const list = {
    isConnected: opts.isConnected !== false,
    scrollTop: opts.scrollTop || 0,
    scrollLeft: opts.scrollLeft || 0,
    children,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    getBoundingClientRect: () => ({ ...rect }),
    appendChild(node) {
      list.children.push(node);
      node.parent = list;
    },
  };
  for (const child of children) child.parent = list;
  return list;
}

const row = (key, top) => fakeNode(key, { top, left: 0, width: 300, height: 20 });

test('beginListUpdate refuses a list that is not on screen', () => {
  assert.equal(beginListUpdate(null).ok, false);
  assert.equal(beginListUpdate(fakeList([], { isConnected: false })).ok, false);
});

test('beginListUpdate refuses a list with no box at all', () => {
  // A folded panel measures every row at 0x0. Animating from that would fling
  // the whole list in from the top-left corner the moment it is unfolded.
  const list = fakeList([row('a', 0)], { rect: { top: 0, left: 0, width: 0, height: 0 } });
  assert.equal(beginListUpdate(list).ok, false);
});

test('beginListUpdate marks the list and keeps the nodes, not just the rects', () => {
  const a = row('a', 10);
  const list = fakeList([a]);
  const snap = beginListUpdate(list);
  assert.equal(snap.ok, true);
  assert.ok(list.classList.contains(LIST_CLASS), 'the positioning context is applied here');
  assert.equal(snap.nodes.get('a'), a, 'the node is what makes an exit animation possible');
  assert.deepEqual(snap.rects.get('a'), { top: 10, left: 0, width: 300, height: 20 });
});

test('beginListUpdate ignores rows with no key', () => {
  const plain = fakeNode(undefined, { top: 0, left: 0, width: 10, height: 10 });
  const snap = beginListUpdate(fakeList([plain, row('a', 20)]));
  assert.deepEqual([...snap.rects.keys()], ['a']);
});

test('endListUpdate does nothing at all when the duration is zero', () => {
  const list = fakeList([row('a', 0)]);
  const snap = beginListUpdate(list);
  const after = row('b', 0);
  list.children = [after];
  endListUpdate(list, snap, { durationMs: 0 });
  assert.equal(after.animations.length, 0, 'motion off has to mean off');
});

test('endListUpdate animates nothing when the list is unchanged', () => {
  // The case the whole module exists for: ports rescans every few seconds and
  // returns the same ports, and nothing may move.
  const list = fakeList([row('a', 0), row('b', 20)]);
  const snap = beginListUpdate(list);
  const rebuilt = [row('a', 0), row('b', 20)];
  list.children = rebuilt;
  endListUpdate(list, snap, { durationMs: 180 });
  for (const node of rebuilt) assert.equal(node.animations.length, 0);
});

test('endListUpdate gives a new row an entrance and a moved row a FLIP', () => {
  const list = fakeList([row('a', 0)]);
  const snap = beginListUpdate(list);
  const fresh = row('new', 0);
  const moved = row('a', 20);
  list.children = [fresh, moved];
  endListUpdate(list, snap, { durationMs: 180 });

  assert.equal(moved.animations.length, 1);
  assert.equal(moved.animations[0].frames[0].transform, 'translate(0px, -20px)');

  assert.equal(fresh.animations.length, 1);
  const enter = fresh.animations[0];
  assert.equal(enter.frames[0].opacity, 0);
  assert.ok(enter.frames[0].transform.startsWith('translateY('));
  assert.equal(enter.opts.fill, 'backwards', 'a delayed row must start invisible');
});

test('endListUpdate sends a new row in sideways on a horizontal list', () => {
  const list = fakeList([]);
  const snap = beginListUpdate(list);
  const fresh = row('t1', 0);
  list.children = [fresh];
  endListUpdate(list, snap, { durationMs: 180, axis: 'x' });
  assert.ok(fresh.animations[0].frames[0].transform.startsWith('translateX('));
});

test('endListUpdate can be told not to animate entrances', () => {
  const list = fakeList([]);
  const snap = beginListUpdate(list);
  const fresh = row('t1', 0);
  list.children = [fresh];
  endListUpdate(list, snap, { durationMs: 180, enter: false });
  assert.equal(fresh.animations.length, 0);
});

test('endListUpdate ghosts a removed row, then drops it', async () => {
  const doomed = row('gone', 20);
  const list = fakeList([row('a', 0), doomed]);
  const snap = beginListUpdate(list);
  list.children = [row('a', 0)];
  endListUpdate(list, snap, { durationMs: 180 });

  assert.ok(doomed.classList.contains(GHOST_CLASS));
  assert.equal(doomed.style.top, '20px', 'parked exactly where it last was');
  assert.equal(doomed.style.height, '20px', 'and at its own size, out of flow');
  assert.equal(doomed.animations.length, 1);
  assert.equal(doomed.animations[0].frames[1].opacity, 0);
  assert.ok(list.children.includes(doomed), 'it has to be back in the DOM to fade');

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(doomed.removed, true, 'and gone once it has');
});

test('scrolling a list is not movement', () => {
  // The session-timeline case. render() auto-scrolls to the newest turn, so in
  // viewport coordinates every marker appears to have slid left - and FLIP
  // would faithfully animate a slide that never happened. flip.js measures
  // against the track's own content box, so this must come out empty.
  const list = fakeList([fakeNode('t1', { top: 0, left: 10, width: 8, height: 20 })]);
  const snap = beginListUpdate(list);

  list.scrollLeft = 50;
  const same = fakeNode('t1', { top: 0, left: -40, width: 8, height: 20 });
  list.children = [same];
  endListUpdate(list, snap, { durationMs: 180 });

  assert.equal(same.animations.length, 0, 'a scroll must not read as a reorder');
});
