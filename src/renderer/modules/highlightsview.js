// ============================================================================
// LunaCore - the nodes the highlight extractor panel is built from
// ----------------------------------------------------------------------------
// Everything in here answers "what does it look like". Everything in
// modules/highlights.js answers "what does it do" - when the overlay opens,
// when the pickHighlightsFolder()/runHighlightBatch() bridges get called,
// which per-file status is currently on screen. Same split modules/ask.js and
// modules/askview.js already established (and libraries.js/librariesview.js
// before that): pure builders with no state and no window.lunacore calls of
// their own.
//
// The panel's header (title, close button) and footer live in static markup
// in index.html's #highlights block, same as #ask/#libraries - only the body
// (which of "ffmpeg missing" / the form / live per-file progress is on
// screen) is built here, because that depends on runtime state a static
// skeleton cannot express.
// ============================================================================

'use strict';

import { t } from './util.js';

// ---- The panel shell ---------------------------------------------------------

/**
 * The body's static shell: a slot for the ffmpeg-missing banner (or a run
 * error), a form host the caller fills with folderPickerRow()/secondsField(),
 * the always-visible keyframe caveat, the Run/Cancel buttons, and the live
 * per-file status list.
 *
 * The keyframe caveat is a LOCKED-IN requirement (see the plan's "Design
 * decisions locked in" section): stream-copy trimming seeks to the nearest
 * keyframe, not an exact frame, so the trimmed clip's first fraction of a
 * second can be broken. It stays on screen unconditionally - not just on
 * error, not dismissible - so it is never read as a promise of frame-accurate
 * output.
 *
 * @returns {{
 *   el: HTMLElement,
 *   bannerHost: HTMLElement,
 *   form: HTMLElement,
 *   runBtn: HTMLButtonElement,
 *   cancelBtn: HTMLButtonElement,
 *   filesEl: HTMLUListElement,
 * }}
 */
export function panelSkeleton() {
  const el = document.createElement('div');
  el.className = 'highlights__panel';

  // Holds either ffmpegMissingBanner() or a run-error row - the two never
  // coincide in practice (the Run button stays disabled while ffmpeg is
  // missing, so a run error can only happen once ffmpeg is already present).
  const bannerHost = document.createElement('div');
  bannerHost.className = 'highlights__banner-host';
  el.appendChild(bannerHost);

  // The caller appends folderPickerRow('source', ...), folderPickerRow('output', ...)
  // and secondsField() into this host, in that order.
  const form = document.createElement('div');
  form.className = 'highlights__form';
  el.appendChild(form);

  const caveat = document.createElement('p');
  caveat.className = 'highlights__caveat';
  caveat.textContent = t('highlights.keyframeWarning');
  el.appendChild(caveat);

  const actions = document.createElement('div');
  actions.className = 'highlights__actions';

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'highlights__run';
  runBtn.textContent = t('highlights.run');
  actions.appendChild(runBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'highlights__cancel';
  cancelBtn.textContent = t('highlights.cancel');
  // Disabled until a batch is actually running - see this file's header on
  // modules/highlights.js owning that toggle.
  cancelBtn.disabled = true;
  actions.appendChild(cancelBtn);

  el.appendChild(actions);

  const filesEl = document.createElement('ul');
  filesEl.className = 'highlights__files';
  el.appendChild(filesEl);

  return { el, bannerHost, form, runBtn, cancelBtn, filesEl };
}

// ---- Folder pickers -----------------------------------------------------------

/**
 * One labeled row: the folder currently picked (or a neutral placeholder),
 * and a "Choose..." button that hands off to a native folder-picker dialog.
 *
 * @param {'source'|'output'} role only picks which i18n key labels the button
 * @param {{label:string, path:?string, onPick:() => void}} opts `label`
 *   already resolved via t() by the caller - same convention rowButton()
 *   takes a resolved title in librariesview.js.
 * @returns {HTMLElement}
 */
export function folderPickerRow(role, { label, path, onPick }) {
  const row = document.createElement('div');
  row.className = 'highlights__row highlights__row--folder';

  const labelEl = document.createElement('span');
  labelEl.className = 'highlights__label';
  labelEl.textContent = label;

  const pathEl = document.createElement('span');
  pathEl.className = 'highlights__path';
  // An em dash rather than a translated placeholder: "no folder chosen yet"
  // is conveyed by the dash's neutrality in either language, so it needs no
  // i18n key of its own.
  pathEl.textContent = path || '—';
  pathEl.title = path || '';

  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'highlights__pick';
  pickBtn.textContent = t(role === 'output' ? 'highlights.output.pick' : 'highlights.source.pick');
  pickBtn.addEventListener('click', () => onPick());

  row.append(labelEl, pathEl, pickBtn);
  return row;
}

// ---- Seconds field --------------------------------------------------------------

/**
 * The "keep the last N seconds" numeric field.
 * @param {{value:number, onChange:(raw:string) => void}} opts `onChange`
 *   receives the raw input string; parsing/validating it is
 *   modules/highlightscommand.js's job (parseSecondsInput/isValidSeconds),
 *   not this builder's.
 * @returns {HTMLElement}
 */
export function secondsField({ value, onChange }) {
  const row = document.createElement('div');
  row.className = 'highlights__row highlights__row--seconds';

  const labelEl = document.createElement('label');
  labelEl.className = 'highlights__label';
  labelEl.textContent = t('highlights.seconds.label');
  labelEl.setAttribute('for', 'highlights-seconds-input');

  const input = document.createElement('input');
  input.type = 'number';
  input.id = 'highlights-seconds-input';
  input.className = 'highlights__seconds-input';
  input.min = '1';
  input.step = '1';
  input.value = String(value);
  input.addEventListener('input', () => onChange(input.value));

  row.append(labelEl, input);
  return row;
}

// ---- Per-file status row -------------------------------------------------------

/** Every status fileStatusRow() can be handed, mapped to its i18n key. */
const STATUS_KEYS = {
  queued: 'highlights.status.queued',
  running: 'highlights.status.running',
  done: 'highlights.status.done',
  error: 'highlights.status.error',
  cancelled: 'highlights.status.cancelled',
};

/**
 * One row in the live per-file progress list: the file name and a status
 * badge. `is-<status>` on both the row and the badge is the same
 * class-per-state convention `.git-badge--behind/ahead/dirty/conflict` and
 * `.mcpcall-item__badge.is-ok/.is-bad` already use elsewhere in this app -
 * reused here rather than inventing a new one, per this feature's own
 * instructions.
 * @param {{name:string, status:'queued'|'running'|'done'|'error'|'cancelled'}} opts
 * @returns {HTMLElement}
 */
export function fileStatusRow({ name, status }) {
  const li = document.createElement('li');
  li.className = `highlights-file is-${status}`;

  const nameEl = document.createElement('span');
  nameEl.className = 'highlights-file__name';
  nameEl.textContent = name;

  const badge = document.createElement('span');
  badge.className = `highlights-file__badge is-${status}`;
  badge.textContent = t(STATUS_KEYS[status] || STATUS_KEYS.queued);

  li.append(nameEl, badge);
  return li;
}

// ---- ffmpeg-missing banner ------------------------------------------------------

/**
 * Shown in place of (or above) the form when getFfmpegStatus() reports
 * ok:false. `onOpenCatalog` deep-links to the FFmpeg entry Phase 3 added to
 * config/libraries.json.
 * @param {{onOpenCatalog:() => void}} opts
 * @returns {HTMLElement}
 */
export function ffmpegMissingBanner({ onOpenCatalog }) {
  const el = document.createElement('div');
  el.className = 'highlights__banner highlights__banner--missing';

  const msg = document.createElement('p');
  msg.className = 'highlights__banner-text';
  msg.textContent = t('highlights.ffmpeg.missing');
  el.appendChild(msg);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'highlights__banner-action';
  btn.textContent = t('highlights.ffmpeg.openCatalog');
  btn.addEventListener('click', () => onOpenCatalog());
  el.appendChild(btn);

  return el;
}
