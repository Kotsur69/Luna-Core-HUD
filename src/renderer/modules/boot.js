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

// The overlay itself: always in the static DOM, never part of a widget.
const bootEl = document.getElementById('boot');
const bootLogEl = document.getElementById('boot-log');

// A2/2026-08-13: boot-toggle / boot-status live inside the #termcustom
// Settings overlay's static markup (the "Sekwencja startowa" switch-field,
// moved there from the `appearance` widget - see TERMINAL_CUSTOMIZER_PLAN.md),
// so they don't exist at import time - looked up in mountBoot() instead.
// Elements of the current mount, or null before that ever runs.
let bootEls = null;

// Mirrors config/ui.local.json's `boot`. Kept at module scope, like
// autocompact's armed flag, so a remount of `appearance` repaints the toggle
// from truth instead of the template's authored default (A2c).
let bootEnabled = true;

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
function renderBootPref() {
  if (!bootEls) return;
  bootEls.toggle.checked = bootEnabled;
  bootEls.status.textContent = t(bootEnabled ? 'boot.on' : 'boot.off');
}

/**
 * Called once from initAppearance(), AFTER the language and theme are set: the
 * log is then in the right language and the colours come from the chosen theme
 * straight away, so nothing jumps mid-animation. The system "reduce motion"
 * setting skips it entirely.
 */
export function startBoot(enabled) {
  bootEnabled = enabled;
  renderBootPref();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!enabled || reducedMotion) {
    endBoot(true);
    return;
  }
  runBootSequence();
}

/**
 * Mounts the boot-sequence toggle inside whatever root it's given - called
 * once from termcustom.js with the #termcustom overlay as root (it is static
 * markup, not a widget, so there's no remount to guard against here the way
 * context.js's mountSpark() one-root-two-owners shape had to).
 */
export function mountBoot(root) {
  bootEls = {
    toggle: root.querySelector('#boot-toggle'),
    status: root.querySelector('#boot-status'),
  };

  // Repaint from module state - startBoot() only runs once at app launch, a
  // remount must not fall back to the template's authored default (A2c).
  renderBootPref();

  // Bound inside root, so the host removes it with the subtree.
  bootEls.toggle.addEventListener('change', () => {
    bootEnabled = bootEls.toggle.checked;
    renderBootPref();
    // Takes effect from the next launch - we do not rewind the current animation.
    window.lunacore.setUiPrefs({ boot: bootEnabled });
  });

  const offLang = onLangChange(renderBootPref);

  return () => {
    offLang();
    bootEls = null;
  };
}
