// ============================================================================
// LunaCore - shared motion primitive tests (v0.10 phase 3)
// ----------------------------------------------------------------------------
// motion.js is deliberately dumb about the DOM - every impure entry point takes
// its host or its duration as a parameter - so the whole file is reachable from
// node --test with two object literals and no jsdom.
//
// The two tests that actually earn their keep are at the bottom: the exit
// duration and the list of overlays that animate are each written down TWICE,
// once in JS and once in CSS, and neither copy can fail loudly on its own. So
// they fail here instead.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  parseDuration,
  crossfade,
  closeWithExit,
  cancelExit,
  EXIT_RATIO,
  LEAVING_CLASS,
} = require('../src/renderer/modules/motion.js');

const STYLES = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const css = () => fs.readFileSync(STYLES, 'utf8');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal stand-in for an overlay root - this is why the helpers take one. */
function fakeOverlay() {
  const classes = new Set();
  return {
    hidden: false,
    classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

// ---- parseDuration ---------------------------------------------------------

test('parseDuration reads both CSS time units', () => {
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('0.25s'), 250);
  assert.equal(parseDuration(' 180ms '), 180);
  assert.equal(parseDuration('0ms'), 0);
});

test('parseDuration treats anything it cannot read as instant', () => {
  // The failure mode that matters: a junk token must degrade to "do not
  // animate", never to a number large enough to hang a UI on.
  for (const bad of ['', null, undefined, 'auto', 'NaNms', '-5s', {}]) {
    assert.equal(parseDuration(bad), 0, `${String(bad)} should read as 0`);
  }
});

// ---- crossfade -------------------------------------------------------------

test('crossfade applies the change even with no View Transitions support', () => {
  let calls = 0;
  const animated = crossfade(() => (calls += 1), { doc: {}, durationMs: 350 });
  assert.equal(animated, false);
  assert.equal(calls, 1, 'the mutation must land exactly once on the fallback path');
});

test('crossfade skips the transition entirely when the duration is zero', () => {
  // Motion off. Capturing two snapshots of the viewport to then show one of
  // them instantly is pure cost, and "off" has to mean off.
  let calls = 0;
  let started = 0;
  const doc = {
    startViewTransition: (fn) => {
      started += 1;
      fn();
      return { finished: Promise.resolve() };
    },
  };
  const animated = crossfade(() => (calls += 1), { doc, durationMs: 0 });
  assert.equal(animated, false);
  assert.equal(started, 0, 'no transition may be started at 0ms');
  assert.equal(calls, 1);
});

test('crossfade hands the mutation to startViewTransition when it can', () => {
  let calls = 0;
  let received = null;
  const doc = {
    startViewTransition: (fn) => {
      received = fn;
      fn();
      return { finished: Promise.resolve() };
    },
  };
  const animated = crossfade(() => (calls += 1), { doc, durationMs: 350 });
  assert.equal(animated, true);
  assert.equal(typeof received, 'function');
  assert.equal(calls, 1, 'still exactly once - never twice, never zero');
});

test('crossfade skips a transition still in flight rather than stacking', () => {
  let skipped = 0;
  const make = () => ({ skipTransition: () => (skipped += 1), finished: new Promise(() => {}) });
  const doc = {
    startViewTransition: (fn) => {
      fn();
      return make();
    },
  };
  crossfade(() => {}, { doc, durationMs: 350 });
  crossfade(() => {}, { doc, durationMs: 350 });
  assert.equal(skipped, 1, 'the first must be landed before the second starts');
});

// ---- closeWithExit / cancelExit --------------------------------------------

test('closeWithExit hides immediately when there is no time to animate', () => {
  const el = fakeOverlay();
  let done = 0;
  const animated = closeWithExit(el, { durationMs: 0, done: () => (done += 1) });
  assert.equal(animated, false);
  assert.equal(el.hidden, true);
  assert.equal(done, 1);
  assert.ok(!el.classList.contains(LEAVING_CLASS));
});

test('closeWithExit leaves the element visible until the exit has played', async () => {
  const el = fakeOverlay();
  let done = 0;
  const animated = closeWithExit(el, { durationMs: 20, done: () => (done += 1) });
  assert.equal(animated, true);
  assert.equal(el.hidden, false, 'hiding it up front is exactly the bug this fixes');
  assert.ok(el.classList.contains(LEAVING_CLASS));
  await wait(120);
  assert.equal(el.hidden, true);
  assert.equal(done, 1);
  assert.ok(!el.classList.contains(LEAVING_CLASS), 'the class must not be left behind');
});

test('closeWithExit ignores an element that is already hidden', () => {
  const el = fakeOverlay();
  el.hidden = true;
  assert.equal(closeWithExit(el, { durationMs: 20 }), false);
  assert.ok(!el.classList.contains(LEAVING_CLASS));
});

test('cancelExit rescues an overlay reopened inside its own exit window', async () => {
  // Esc then Ctrl+L, faster than the animation. Without cancelExit the pending
  // timer hides an overlay the user has just deliberately reopened.
  const el = fakeOverlay();
  let done = 0;
  closeWithExit(el, { durationMs: 20, done: () => (done += 1) });
  cancelExit(el);
  el.hidden = false;
  await wait(120);
  assert.equal(el.hidden, false, 'the stale timer must not fire');
  assert.equal(done, 0);
  assert.ok(!el.classList.contains(LEAVING_CLASS));
});

test('a second close on the same element lands the first instead of stacking', async () => {
  const el = fakeOverlay();
  let done = 0;
  closeWithExit(el, { durationMs: 20, done: () => (done += 1) });
  closeWithExit(el, { durationMs: 20, done: () => (done += 1) });
  await wait(120);
  assert.equal(el.hidden, true);
  assert.equal(done, 1, 'one close, one completion - not two timers racing');
});

// ---- drift guards ----------------------------------------------------------

test('EXIT_RATIO matches the ratio styles.css animates at', () => {
  // JS decides WHEN to set `hidden`; CSS decides how long the animation runs.
  // If those two numbers drift, the overlay is either cut off mid-fade or sits
  // there invisible-but-present for the difference.
  const rules = css().match(/calc\(var\(--dur-fast\) \* [0-9.]+\)/g) || [];
  assert.ok(rules.length >= 2, 'the exit rules must be expressed against --dur-fast');
  for (const rule of rules) {
    const ratio = parseFloat(rule.slice(rule.lastIndexOf('*') + 1));
    assert.equal(ratio, EXIT_RATIO, `${rule} disagrees with EXIT_RATIO in motion.js`);
  }
});

test('every overlay that animates in also has an exit rule', () => {
  // The real risk is a SEVENTH overlay being added later, copying the shipped
  // `animation: palette-in` line, and silently never getting an exit - which
  // looks like nothing is wrong until you dismiss it.
  const text = css();
  const entering = [
    ...text.matchAll(/([.#][\w-]+)\s*\{[^{}]*animation:\s*palette-in[^{}]*\}/g),
  ].map((m) => m[1]);

  assert.ok(entering.length >= 3, 'expected the palette, settings and modal shells');
  for (const selector of entering) {
    assert.ok(
      text.includes(`.${LEAVING_CLASS} ${selector}`),
      `${selector} animates in but nothing matches .${LEAVING_CLASS} ${selector}`
    );
  }
});
