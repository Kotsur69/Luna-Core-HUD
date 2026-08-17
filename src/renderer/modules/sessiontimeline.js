// ============================================================================
// LunaCore - Session Timeline & Snapshot Scrubber (LUNA_HUD_SPECIFICATION.md §6.1)
// ----------------------------------------------------------------------------
// PASSIVE OBSERVER: rides TranscriptWatcher.onTurnEnd() (observer.js), the same
// { startedAt, endedAt, text } fragment ttsExtract.js already reads for the
// "read aloud" feature - no new IPC round trip, no new transcript/file read.
// The preview modal only ever displays that captured text; nothing in this
// module writes to the PTY (no pastePrompt/write/runCommand calls anywhere
// here) - clicking a marker cannot replay anything into the live session.
//
// Structural template is activefiles.js: module-scope state that survives
// remount (§A2c), defineWidget() from registry.js, per-tab isolation via
// registerSessionView() from bus.js, honest truncation, DOM built with
// createElement (never innerHTML with transcript text).
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, onSessionRestarted, registerSessionView } from './bus.js';
import { defineWidget } from './registry.js';

/** Oldest turns are dropped past this - a session can run for hours, and
 *  nothing needs infinite history in memory or DOM. */
const MAX_TURNS = 100;

/** Honest truncation (activefiles.js's MAX_ROWS rule, applied to text instead
 *  of row count): a turn's captured fragment can be huge (a long tool dump
 *  echoed back); storing all of it would bloat memory and the modal for no
 *  reader benefit. `truncated: true` lets the modal say so instead of quietly
 *  cutting text off with no indication anything is missing. */
const MAX_TEXT_CHARS = 4000;

/** { startedAt, endedAt, text, truncated }[], oldest first. App state, not
 *  view state - survives unmount/remount and tab backgrounding, same as
 *  activefiles.js's `files` map. */
let turns = [];

/** Elements of the current mount, or null while this widget is off screen. */
let els = null;

/** Modal elements - these live at the top of index.html (not inside the
 *  widget's own template), same as the palette/termcustom overlays, so the
 *  preview can escape a narrow rail's clipping. Looked up once on first mount
 *  since the modal markup is static and never unmounts with the widget. */
let modal = null;
let modalOpen = false;

/**
 * Caps text at maxChars, flagging whether anything was cut.
 * Pure and exported so truncation is unit-testable without a DOM.
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateText(text, maxChars) {
  const str = typeof text === 'string' ? text : '';
  if (str.length <= maxChars) return { text: str, truncated: false };
  return { text: str.slice(0, maxChars), truncated: true };
}

/**
 * Drops the oldest entries past `max`, mutating in place.
 * @param {Array} list
 * @param {number} max
 * @returns {Array} the same list, for chaining
 */
export function capTurns(list, max) {
  if (list.length > max) list.splice(0, list.length - max);
  return list;
}

/**
 * Folds one onTurnEnd payload into a turns list. Pure and exported for the
 * same reason activefiles.js's applyFileEvent is - unit-testable without
 * mocking window.lunacore or the DOM.
 * @param {Array} list mutated in place
 * @param {{startedAt:number, endedAt:number, text:string}} turn
 * @param {number} [maxChars] defaults to MAX_TEXT_CHARS - overridable for tests
 * @param {number} [max] defaults to MAX_TURNS - overridable for tests
 * @returns {Array} the same list, for chaining
 */
export function applyTurnEvent(list, turn, maxChars = MAX_TEXT_CHARS, max = MAX_TURNS) {
  if (!turn) return list;
  const { text, truncated } = truncateText(turn.text, maxChars);
  list.push({
    startedAt: turn.startedAt || 0,
    endedAt: turn.endedAt || 0,
    text,
    truncated,
  });
  capTurns(list, max);
  return list;
}

function formatTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return '';
  }
}

/** One marker button per turn - a small dot in a horizontally-scrollable
 *  strip. Narrow right-rail/dock slots (~260-380px) cannot fit a wide visual
 *  timeline, so v1 is a compact scrollable row of markers rather than a
 *  full-width chart (plan §7 layout note). */
function buildMarker(turn, idx) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'stimeline__marker';
  if (turn.truncated) btn.classList.add('is-truncated');
  btn.title = formatTime(turn.endedAt);
  btn.setAttribute('aria-label', formatTime(turn.endedAt) || t('sessiontimeline.title'));
  btn.addEventListener('click', () => openModal(idx));
  return btn;
}

/** Repaints from `turns`. Called on every event AND on mount/lang change, same
 *  as activefiles.js's render(). */
function render() {
  if (!els) return;

  els.track.innerHTML = '';

  if (!turns.length) {
    els.empty.textContent = t('sessiontimeline.empty');
    els.empty.style.display = '';
    return;
  }

  els.empty.style.display = 'none';
  turns.forEach((turn, idx) => els.track.appendChild(buildMarker(turn, idx)));
  // Newest turn scrolled into view - the reader is watching the session live,
  // not digging through history by default.
  els.track.scrollLeft = els.track.scrollWidth;
}

function openModal(idx) {
  const turn = turns[idx];
  if (!turn || !modal) return;
  modal.time.textContent = formatTime(turn.endedAt);
  modal.text.textContent = turn.text;
  modal.truncated.hidden = !turn.truncated;
  modal.el.hidden = false;
  modalOpen = true;
}

function closeModal() {
  if (!modalOpen || !modal) return;
  modalOpen = false;
  modal.el.hidden = true;
}

/** Looked up once - the modal markup is static top-level HTML, not part of
 *  this widget's own template, so it does not come and go with mount/unmount. */
function ensureModal() {
  if (modal) return;
  const el = document.getElementById('stimeline-modal');
  if (!el) return;
  modal = {
    el,
    time: document.getElementById('stimeline-modal-time'),
    text: document.getElementById('stimeline-modal-text'),
    truncated: document.getElementById('stimeline-modal-truncated'),
  };
  el.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-stimeline-close')) closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOpen) closeModal();
  });
}

/** Apply a completed turn to the tab you are looking at. */
export function applyTurnEnd(turn) {
  applyTurnEvent(turns, turn);
  render();
}

/** The same fold for a tab running in the background - keeps its history
 *  accurate so switching to it shows what happened THERE. Mirrors
 *  activefiles.js's trackBucketFiles(). */
export function trackBucketTurn(bucket, turn) {
  if (!bucket.sessionTimeline) bucket.sessionTimeline = [];
  applyTurnEvent(bucket.sessionTimeline, turn);
}

defineWidget({
  id: 'sessiontimeline',
  titleKey: 'sessiontimeline.title',
  template: 'w-sessiontimeline',
  mount(root) {
    els = {
      track: root.querySelector('#stimeline-track'),
      empty: root.querySelector('#stimeline-empty'),
    };
    ensureModal();

    const offLang = onLangChange(render);
    render();

    return () => {
      offLang();
      closeModal();
      els = null;
    };
  },
});

registerSessionView({
  save(bucket) {
    bucket.sessionTimeline = [...turns];
  },
  load(bucket) {
    turns = bucket.sessionTimeline || [];
    render();
  },
  clear(bucket) {
    bucket.sessionTimeline = [];
  },
});

// Restart = a new process: whatever was tracked belonged to the one that died.
onSessionRestarted(() => {
  turns = [];
  closeModal();
  render();
});
