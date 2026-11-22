// ============================================================================
// Work map effects (src/renderer/modules/workmapFx.js): burst planning, the
// capped packet pool, lanes, and the afterglow's heat and glow. The pool is
// exercised on a minimal fake DOM (createElementNS + animate) so the cap is
// checked on the real code path, not on a copy of it.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// --- a minimal DOM: enough for svgNode(), animate() and the motion tokens ------------

const animations = [];
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = new Map();
    this.children = [];
    this.style = {};
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  animate(keyframes, opts) {
    const anim = { node: this, keyframes, opts, cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(anim);
    return anim;
  }
}
let durMs = '350ms';
globalThis.document = { createElementNS: (_ns, tag) => new FakeNode(tag), documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => (name.startsWith('--dur') ? durMs : '') });

const FX = require('../src/renderer/modules/workmapFx.js');

// --- burstPlan ---------------------------------------------------------------------------

test('concurrent calls on one station plan one packet each, out on start and back on end', () => {
  const plan = FX.burstPlan({ started: 3, ended: 2, failed: 1 });
  assert.equal(plan.out, 3);
  assert.equal(plan.back, 2);
  assert.equal(plan.failedBack, 1);
  assert.equal(plan.failedRipple, true);
});

test('a burst is capped per station and direction', () => {
  const plan = FX.burstPlan({ started: 100, ended: 100, failed: 0 });
  assert.equal(plan.out, FX.MAX_BURST_PER_STATION);
  assert.equal(plan.back, FX.MAX_BURST_PER_STATION);
});

test('a call that starts and ends inside one tick still ripples, and its return waits for the outbound packet', () => {
  const plan = FX.burstPlan({ started: 1, ended: 1, failed: 0 });
  assert.equal(plan.ripple, true);
  assert.equal(plan.backDelayed, true);
  assert.equal(plan.out, 1);
  assert.equal(plan.back, 1);
});

test('a quiet frame plans nothing; junk deltas read as quiet', () => {
  for (const d of [{ started: 0, ended: 0, failed: 0 }, null, undefined, { started: -2, ended: NaN, failed: 'x' }]) {
    const plan = FX.burstPlan(d);
    assert.equal(plan.ripple, false);
    assert.equal(plan.out + plan.back, 0);
  }
});

test('failed returns never exceed the returns', () => {
  assert.equal(FX.burstPlan({ started: 0, ended: 1, failed: 5 }).failedBack, 1);
});

// --- the pool ------------------------------------------------------------------------------

test('pickSlot takes a free slot first, else drops the oldest packet', () => {
  const slots = [
    { busyUntil: 100, startedAt: 5 },
    { busyUntil: 10, startedAt: 1 },
    { busyUntil: 100, startedAt: 3 },
  ];
  assert.equal(FX.pickSlot(slots, 50), 1);
  slots[1].busyUntil = 100;
  assert.equal(FX.pickSlot(slots, 50), 1, 'all busy: the one started first');
  slots[1].startedAt = 9;
  assert.equal(FX.pickSlot(slots, 50), 2);
  assert.equal(FX.pickSlot([], 0), -1);
  assert.equal(FX.pickSlot(null, 0), -1);
});

test('the packet pool never builds more than MAX_PACKETS dots and recycles the oldest beyond it', () => {
  animations.length = 0;
  const layer = new FakeNode('g');
  const pool = FX.createPacketPool(layer);
  assert.equal(pool.size, FX.MAX_PACKETS);
  assert.equal(layer.children.length, FX.MAX_PACKETS);
  const seg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const extra = 12;
  for (let i = 0; i < FX.MAX_PACKETS + extra; i += 1) pool.send(seg, { outward: true, failed: false, station: 'files', lane: i });
  assert.equal(layer.children.length, FX.MAX_PACKETS, 'no dot is ever added');
  assert.equal(animations.length, FX.MAX_PACKETS + extra);
  assert.equal(animations.filter((a) => a.cancelled).length, extra, 'one oldest packet dropped per packet past the cap');
  assert.equal(animations[0].cancelled, true);
  assert.equal(animations[animations.length - 1].cancelled, false);
  pool.cancelAll();
  assert.ok(animations.every((a) => a.cancelled));
});

test('with motion tokens at 0 (reduced motion) the pool sends nothing', () => {
  animations.length = 0;
  durMs = '0ms';
  try {
    const pool = FX.createPacketPool(new FakeNode('g'));
    pool.send({ x1: 0, y1: 0, x2: 10, y2: 0 }, { outward: true, failed: false, station: 'shell' });
    FX.playBurst(pool, { seg: { x1: 0, y1: 0, x2: 10, y2: 0 }, ripple: new FakeNode('circle'), rippleAnim: null }, 'shell', { started: 2, ended: 1, failed: 0 });
    assert.equal(animations.length, 0);
  } finally {
    durMs = '350ms';
  }
});

test('playBurst sends a packet per call (capped), staggered on lanes, and one ripple', () => {
  animations.length = 0;
  const pool = FX.createPacketPool(new FakeNode('g'));
  const ripple = new FakeNode('circle');
  const item = { seg: { x1: 0, y1: 0, x2: 100, y2: 0 }, ripple, rippleAnim: null };
  FX.playBurst(pool, item, 'files', { started: 3, ended: 1, failed: 1 });
  const packets = animations.filter((a) => a.node !== ripple);
  assert.equal(packets.length, 4);
  assert.deepEqual(packets.slice(0, 3).map((a) => a.opts.delay), [0, FX.PACKET_STAGGER_MS, 2 * FX.PACKET_STAGGER_MS]);
  assert.ok(packets[3].opts.delay > 0, 'the return waits for this frame\'s outbound packets');
  assert.match(packets[3].node.getAttribute('class'), /is-failed/);
  assert.equal(animations.filter((a) => a.node === ripple).length, 1);
});

// --- lanes ----------------------------------------------------------------------------------

test('laneOffset alternates around the spoke', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(FX.laneOffset), [0, FX.LANE_SPACING, -FX.LANE_SPACING, 2 * FX.LANE_SPACING, -2 * FX.LANE_SPACING, 0]);
  assert.equal(FX.laneOffset(-1), 0);
});

test('laneSegment moves a spoke sideways, keeping its length', () => {
  const s = FX.laneSegment({ x1: 0, y1: 0, x2: 100, y2: 0 }, 5);
  assert.deepEqual(s, { x1: 0, y1: 5, x2: 100, y2: 5 });
  assert.deepEqual(FX.laneSegment({ x1: 1, y1: 1, x2: 1, y2: 1 }, 5), { x1: 1, y1: 1, x2: 1, y2: 1 });
});

// --- afterglow ---------------------------------------------------------------------------------

test('heat halves every half-life and grows by one per call', () => {
  assert.equal(FX.stepHeat(0, 0, 1), 1);
  assert.equal(FX.stepHeat(8, FX.GLOW_HALF_LIFE_MS, 0), 4);
  assert.equal(FX.stepHeat(8, 2 * FX.GLOW_HALF_LIFE_MS, 2), 4);
});

test('heat goes cold (exactly 0) instead of decaying for ever', () => {
  let h = 1;
  for (let i = 0; i < 40; i += 1) h = FX.stepHeat(h, FX.GLOW_HALF_LIFE_MS, 0);
  assert.equal(h, 0);
  assert.equal(FX.glowLevel(h), 0);
});

test('stepHeat reads junk as nothing', () => {
  assert.equal(FX.stepHeat(NaN, -5, 'x'), 0);
  assert.equal(FX.stepHeat(2, NaN, 0), 2);
});

test('glow rises with the recent call rate and stays below 1', () => {
  const levels = [0.5, 1, 4, 10, 100].map(FX.glowLevel);
  for (let i = 1; i < levels.length; i += 1) assert.ok(levels[i] > levels[i - 1], `glow(${i})`);
  assert.ok(levels[levels.length - 1] <= 1);
  assert.equal(FX.glowLevel(-1), 0);
  assert.equal(FX.glowLevel(undefined), 0);
});

test('a steady stream keeps a station warmer than a single call', () => {
  let busy = 0;
  let quiet = FX.stepHeat(0, 0, 1);
  for (let i = 0; i < 10; i += 1) {
    busy = FX.stepHeat(busy, 1000, 1);
    quiet = FX.stepHeat(quiet, 1000, 0);
  }
  assert.ok(FX.glowLevel(busy) > FX.glowLevel(quiet) + 0.3);
});
