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
import { onLangChange, registerSessionView } from './bus.js';

const LED_IDLE_MS = 800;

const led = document.getElementById('led');
const ledLabel = document.getElementById('led-label');

let ledTimer = null;
let ledDead = false;
let ledState = 'waiting'; // 'working' | 'waiting' | 'dead' - the label comes from i18n

/** Paints the LED from its state (text via i18n, so a language switch refreshes it). */
export function renderLed() {
  led.className = `led led--${ledState}`;
  ledLabel.textContent = t(`led.${ledState}`);
}

/** Called on every chunk of stdout; the idle timer slides forward. */
export function markWorking() {
  if (ledDead) return;
  ledState = 'working';
  renderLed();
  clearTimeout(ledTimer);
  ledTimer = setTimeout(() => {
    ledState = 'waiting';
    renderLed();
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
export function markBucketWorking(bucket) {
  bucket.ledState = 'working';
}

export function markBucketDead(bucket) {
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
