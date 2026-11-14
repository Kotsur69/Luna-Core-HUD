// Tests for armGestureEnd() - the one idempotent end every HUD drag gesture
// (splitter, widget arrange, hub drawer resize) now goes through. The bug it
// defends: a drag whose pointerup never arrived (alt-tab, a native dialog, a
// rebuilt handle, a pen) left body.is-resizing / a lifted pointer-events:none
// tile behind, and the bars under it stayed unclickable until a restart.
//
// Driven with Node's own EventTarget, so no DOM shim is needed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { armGestureEnd } = require('../src/renderer/modules/gestureend.js');

/** An Event carrying the extra fields the handlers read. */
function ev(type, extra = {}) {
  return Object.assign(new Event(type, { cancelable: true }), extra);
}

function setup(pointerId = 7) {
  const win = new EventTarget();
  const target = new EventTarget();
  const reasons = [];
  const end = armGestureEnd({ win, target, pointerId, onEnd: (r) => reasons.push(r) });
  return { win, target, reasons, end };
}

test('pointerup for the same pointer ends the gesture as a drop', () => {
  const { win, reasons } = setup();
  win.dispatchEvent(ev('pointerup', { pointerId: 7 }));
  assert.deepEqual(reasons, ['up']);
});

test('pointerup / cancel / lost capture for ANOTHER pointer are ignored', () => {
  const { win, target, reasons } = setup();
  win.dispatchEvent(ev('pointerup', { pointerId: 8 }));
  win.dispatchEvent(ev('pointercancel', { pointerId: 8 }));
  target.dispatchEvent(ev('lostpointercapture', { pointerId: 8 }));
  assert.deepEqual(reasons, []);
});

for (const [name, fire, reason] of [
  ['pointercancel', (s) => s.win.dispatchEvent(ev('pointercancel', { pointerId: 7 })), 'cancel'],
  ['lostpointercapture', (s) => s.target.dispatchEvent(ev('lostpointercapture', { pointerId: 7 })), 'lost'],
  ['window blur (alt-tab mid-drag)', (s) => s.win.dispatchEvent(ev('blur')), 'blur'],
  ['a new pointerdown (old release lost)', (s) => s.win.dispatchEvent(ev('pointerdown', { pointerId: 9 })), 'stale'],
]) {
  test(`${name} ends the gesture as an interruption`, () => {
    const s = setup();
    fire(s);
    assert.deepEqual(s.reasons, [reason]);
  });
}

test('Escape ends the gesture and is swallowed; other keys are not', () => {
  const { win, reasons } = setup();
  const other = ev('keydown', { key: 'a' });
  win.dispatchEvent(other);
  assert.equal(other.defaultPrevented, false);
  assert.deepEqual(reasons, []);

  const esc = ev('keydown', { key: 'Escape' });
  win.dispatchEvent(esc);
  assert.equal(esc.defaultPrevented, true);
  assert.deepEqual(reasons, ['escape']);
});

test('the end runs exactly once, whatever fires afterwards', () => {
  const { win, target, reasons, end } = setup();
  win.dispatchEvent(ev('pointerup', { pointerId: 7 }));
  // Chromium follows a pointerup with lostpointercapture on the captured element.
  target.dispatchEvent(ev('lostpointercapture', { pointerId: 7 }));
  win.dispatchEvent(ev('blur'));
  win.dispatchEvent(ev('pointerdown', { pointerId: 7 }));
  assert.equal(end('removed'), false);
  assert.deepEqual(reasons, ['up']);
});

test('ending by hand passes the caller reason and reports whether it ended', () => {
  const { reasons, end } = setup();
  assert.equal(end('removed'), true);
  assert.equal(end('removed'), false);
  assert.deepEqual(reasons, ['removed']);
});

test('ending by hand defaults to "manual"', () => {
  const { reasons, end } = setup();
  end();
  assert.deepEqual(reasons, ['manual']);
});

/** An EventTarget that counts live listeners, to prove the end unhooks them all. */
function countingTarget() {
  const t = new EventTarget();
  t.live = 0;
  const add = t.addEventListener.bind(t);
  const remove = t.removeEventListener.bind(t);
  t.addEventListener = (...a) => {
    t.live += 1;
    add(...a);
  };
  t.removeEventListener = (...a) => {
    t.live -= 1;
    remove(...a);
  };
  return t;
}

test('every listener armed on window and target is removed by the end', () => {
  const win = countingTarget();
  const target = countingTarget();
  const end = armGestureEnd({ win, target, pointerId: 1, onEnd: () => {} });
  assert.ok(win.live > 0);
  assert.equal(target.live, 1);
  end();
  assert.equal(win.live, 0);
  assert.equal(target.live, 0);
});

test('a throwing onEnd still leaves no listener behind', () => {
  const win = countingTarget();
  let calls = 0;
  const end = armGestureEnd({
    win,
    pointerId: 1,
    onEnd: () => {
      calls += 1;
      throw new Error('cleanup blew up');
    },
  });
  // Ended by hand so the throw reaches this caller synchronously (an EventTarget
  // would report a listener's throw out of band instead).
  assert.throws(() => end('removed'), /cleanup blew up/);
  assert.equal(win.live, 0);
  win.dispatchEvent(ev('blur'));
  win.dispatchEvent(ev('pointerup', { pointerId: 1 }));
  win.dispatchEvent(ev('pointerdown', { pointerId: 2 }));
  assert.equal(end('removed'), false);
  assert.equal(calls, 1);
});

test('arming inside the starting pointerdown does not end on that same press', () => {
  // The gesture is armed from a target-phase pointerdown listener; the window's
  // capture phase for that event has already run, so only a LATER press is stale.
  const win = new EventTarget();
  const reasons = [];
  win.addEventListener('pointerdown', () => {
    if (reasons.started) return;
    reasons.started = true;
    armGestureEnd({ win, pointerId: 3, onEnd: (r) => reasons.push(r) });
  });
  win.dispatchEvent(ev('pointerdown', { pointerId: 3 }));
  assert.deepEqual([...reasons], []);
  win.dispatchEvent(ev('pointerdown', { pointerId: 3 }));
  assert.deepEqual([...reasons], ['stale']);
});

test('works without a capture target (widget arrange holds no capture)', () => {
  const win = new EventTarget();
  const reasons = [];
  armGestureEnd({ win, pointerId: 2, onEnd: (r) => reasons.push(r) });
  win.dispatchEvent(ev('pointercancel', { pointerId: 2 }));
  assert.deepEqual(reasons, ['cancel']);
});

test('rejects a missing window or callback', () => {
  assert.throws(() => armGestureEnd({ pointerId: 1, onEnd: () => {} }), TypeError);
  assert.throws(() => armGestureEnd({ win: new EventTarget(), pointerId: 1 }), TypeError);
});
