// ============================================================================
// LunaCore - boot sequence
// ----------------------------------------------------------------------------
// Pure decoration over a ready UI: a "subsystem" log, a scanning sweep and a
// progress rule. No IPC and no tokens - CSS does all the movement, JS only
// inserts the (translated) lines, sets the delay cascade and cleans up.
//
// Overriding rule: it NEVER blocks. The pty starts and pours stdout underneath,
// and a click or any key removes the overlay immediately. Deliberately without
// preventDefault - the key should still reach the terminal, so "skipping" does
// not swallow the first character you type.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { term } from './terminals.js';

const BOOT_LINE_KEYS = [
  'boot.line.pty',
  'boot.line.observer',
  'boot.line.injector',
  'boot.line.theme',
  'boot.line.skills',
];
const BOOT_FIRST_LINE_MS = 340; // cascade start (after the wordmark is revealed)
const BOOT_LINE_STEP_MS = 120; // gap between lines
const BOOT_HOLD_MS = 1150; // when the overlay leaves on its own
const BOOT_FADE_MS = 240; // MUST match .boot.is-out in styles.css

const bootEl = document.getElementById('boot');
const bootLogEl = document.getElementById('boot-log');
const bootToggle = document.getElementById('boot-toggle');
const bootStatus = document.getElementById('boot-status');

let bootTimers = [];
let bootDone = false;

/** Removes the overlay. Idempotent - a click and the timer may both land here. */
function endBoot(instant = false) {
  if (bootDone) return;
  bootDone = true;
  bootTimers.forEach(clearTimeout);
  bootTimers = [];
  document.removeEventListener('keydown', skipBoot, true);
  bootEl.removeEventListener('click', skipBoot);

  if (instant) {
    bootEl.hidden = true;
  } else {
    bootEl.classList.add('is-out');
    bootTimers.push(setTimeout(() => { bootEl.hidden = true; }, BOOT_FADE_MS));
  }
  term.focus();
}

function skipBoot() {
  endBoot();
}

/** Builds one log line. The "ready" line has no OK marker - it is the summary. */
function bootLine(key, isReady) {
  const li = document.createElement('li');
  li.className = isReady ? 'boot__line boot__line--ready' : 'boot__line';
  const name = document.createElement('span');
  name.textContent = t(key);
  li.appendChild(name);
  if (!isReady) {
    const ok = document.createElement('span');
    ok.className = 'boot__line-ok';
    ok.textContent = t('boot.line.ok');
    li.appendChild(ok);
  }
  return li;
}

function runBootSequence() {
  bootLogEl.replaceChildren();
  // One DOM write; the cascade is animation-delay, not a setTimeout chain.
  BOOT_LINE_KEYS.forEach((key, i) => {
    const li = bootLine(key, false);
    li.style.animationDelay = `${BOOT_FIRST_LINE_MS + i * BOOT_LINE_STEP_MS}ms`;
    bootLogEl.appendChild(li);
  });
  const ready = bootLine('boot.line.ready', true);
  ready.style.animationDelay =
    `${BOOT_FIRST_LINE_MS + BOOT_LINE_KEYS.length * BOOT_LINE_STEP_MS}ms`;
  bootLogEl.appendChild(ready);

  document.addEventListener('keydown', skipBoot, true);
  bootEl.addEventListener('click', skipBoot);
  bootTimers.push(setTimeout(endBoot, BOOT_HOLD_MS));
}

/** The toggle label (separate, because it has to survive a language switch). */
function renderBootPref(enabled) {
  bootToggle.checked = enabled;
  bootStatus.textContent = t(enabled ? 'boot.on' : 'boot.off');
}

/**
 * Called once from initAppearance(), AFTER the language and theme are set: the
 * log is then in the right language and the colours come from the chosen theme
 * straight away, so nothing jumps mid-animation. The system "reduce motion"
 * setting skips it entirely.
 */
export function startBoot(enabled) {
  renderBootPref(enabled);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!enabled || reducedMotion) {
    endBoot(true);
    return;
  }
  runBootSequence();
}

bootToggle.addEventListener('change', () => {
  renderBootPref(bootToggle.checked);
  // Takes effect from the next launch - we do not rewind the current animation.
  window.lunacore.setUiPrefs({ boot: bootToggle.checked });
});

onLangChange(() => renderBootPref(bootToggle.checked));
