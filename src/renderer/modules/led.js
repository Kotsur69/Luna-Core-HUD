// ============================================================================
// LunaCore - LED: working vs waiting for you
// ----------------------------------------------------------------------------
// PASSIVE OBSERVER at its purest - no new channel, no tokens. The signal is
// already in the stream: the Claude Code TUI pours stdout while it is thinking
// (spinner, tokens, tool output) and goes quiet when it wants input. So: data =
// working, silence longer than the threshold = your turn.
//
// The threshold is deliberately longer than a spinner frame, so the LED does
// not flicker between states.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, registerSessionView, emitBusyIdle } from './bus.js';

const LED_IDLE_MS = 800;

// A2f: set once by mountLed() - see modules/terminal.js.
let els = null;

let ledTimer = null;
let ledDead = false;
let ledState = 'waiting'; // 'working' | 'waiting' | 'dead' - the label comes from i18n

// How long each session has been pouring output without an idle gap:
// sessionId -> { since, last } (ms). Lives outside the buckets so a tab switch
// mid-burst (active timer <-> bucket timer) does not reset the span. The
// busy -> idle edge carries it, so a listener can tell real work from a tab
// that merely redraws one line a second (a CLI retry countdown, a clock).
const busySpans = new Map();

/**
 * Next span for a session that just printed a chunk. Pure.
 * @param {{since: number, last: number}|undefined} span
 * @param {number} now
 * @returns {{since: number, last: number}}
 */
export function nextBusySpan(span, now) {
  return span ? { since: span.since, last: now } : { since: now, last: now };
}

/** Length of a finished busy span in ms (0 for an unknown one). Pure. */
export function busySpanMs(span) {
  return span ? Math.max(0, span.last - span.since) : 0;
}

function noteOutput(sessionId) {
  if (sessionId) busySpans.set(sessionId, nextBusySpan(busySpans.get(sessionId), Date.now()));
}

/** Ends the session's busy span and announces the busy -> idle edge with its length. */
function announceIdle(sessionId) {
  const busyMs = busySpanMs(busySpans.get(sessionId));
  busySpans.delete(sessionId);
  emitBusyIdle(sessionId, busyMs);
}

/** Paints the LED from its state (text via i18n, so a language switch refreshes it). */
export function renderLed() {
  if (!els) return;
  els.led.className = `led led--${ledState}`;
  els.ledLabel.textContent = t(`led.${ledState}`);
}

/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountLed(root) {
  els = {
    led: root.querySelector('#led'),
    ledLabel: root.querySelector('#led-label'),
  };
  renderLed();
}

/**
 * Called on every chunk of stdout; the idle timer slides forward.
 * `sessionId` names whose data this is, purely so the busy->idle edge fired
 * below can say which session went quiet - it plays no part in the LED itself.
 */
export function markWorking(sessionId) {
  if (ledDead) return;
  noteOutput(sessionId);
  ledState = 'working';
  renderLed();
  clearTimeout(ledTimer);
  ledTimer = setTimeout(() => {
    ledState = 'waiting';
    renderLed();
    announceIdle(sessionId);
  }, LED_IDLE_MS);
}

export function setLedDead() {
  ledDead = true;
  clearTimeout(ledTimer);
  ledState = 'dead';
  renderLed();
}

/** Session restarted in place: it is alive again and waiting for you. */
export function resetLed() {
  ledDead = false;
  ledState = 'waiting';
  renderLed();
}

export function isLedDead() {
  return ledDead;
}

// A background tab blinks on its own bucket - nothing is on screen to repaint.
// Its idle timer is a per-bucket mirror of ledTimer above: markWorking() only
// ever fires for the ACTIVE tab, so a background session never got an idle
// transition at all until this - it just sat "working" forever once any data
// had arrived, and notify.js has nothing to listen for without one.
export function markBucketWorking(bucket) {
  if (bucket.ledDead) return;
  noteOutput(bucket.id);
  bucket.ledState = 'working';
  clearTimeout(bucket.ledIdleTimer);
  bucket.ledIdleTimer = setTimeout(() => {
    bucket.ledState = 'waiting';
    announceIdle(bucket.id);
  }, LED_IDLE_MS);
}

export function markBucketDead(bucket) {
  clearTimeout(bucket.ledIdleTimer);
  busySpans.delete(bucket.id);
  bucket.ledDead = true;
  bucket.ledState = 'dead';
}

onLangChange(renderLed);

registerSessionView({
  save(bucket) {
    bucket.ledState = ledState;
    bucket.ledDead = ledDead;
  },
  load(bucket) {
    ledState = bucket.ledState || 'waiting';
    ledDead = !!bucket.ledDead;
    renderLed();
  },
  clear(bucket) {
    bucket.ledState = 'waiting';
    bucket.ledDead = false;
  },
});
