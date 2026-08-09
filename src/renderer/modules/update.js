// ============================================================================
// LunaCore - D5: the update notice
// ----------------------------------------------------------------------------
// Lives inside the `appearance` widget's root rather than being a widget of its
// own, and that is a correctness choice, not laziness. Since C1, widget
// placement is DATA (config/layouts.json) and a preset is free to leave a widget
// out - so an update notice as its own widget would be invisible to anyone on a
// preset that dropped it, which is the one message that must never be droppable.
// `appearance` is in src/layouts.js REQUIRED_WIDGETS, so every valid preset has
// it by construction. Same one-root-two-owners shape as mountBoot() (§A2).
//
// NOTHING here downloads or installs. The buttons ask main to; main is where the
// consent lives (see src/update.js for why notify-only).
// ============================================================================

'use strict';

import { onUpdateState, onLangChange } from './bus.js';

const t = (key, params) => window.i18n.t(key, params);

// Elements of the current mount, or null when not on screen.
let els = null;

// Last state from the bus. Module scope, so a remount repaints from truth
// instead of from the template's authored markup (the §A2c rule).
let last = { state: 'idle', info: null, percent: 0, error: null, reason: null, version: '' };

/**
 * What the row says, and which buttons it offers, for one state.
 *
 * Returned as data rather than written straight to the DOM so the whole state
 * machine is readable in one screen - and so `render()` stays a function that
 * only WRITES to the DOM and never reads from it (§A2d).
 */
function describe(s) {
  const version = s.info && s.info.version;

  switch (s.state) {
    case 'checking':
      return { text: t('update.checking'), busy: true };

    case 'available':
      return {
        text: t('update.available', { v: version || '?' }),
        highlight: true,
        primary: { label: t('update.download'), action: 'download' },
        notes: true,
      };

    case 'downloading':
      return { text: t('update.downloading', { p: s.percent }), busy: true, percent: s.percent };

    case 'ready':
      return {
        text: t('update.ready', { v: version || '?' }),
        highlight: true,
        primary: { label: t('update.install'), action: 'install' },
        notes: true,
      };

    case 'error':
      // The message from electron-updater is deliberately NOT shown in the row:
      // it is an English stack-ish string no translation covers, and "ENOTFOUND
      // api.github.com" tells a user nothing they can act on. It stays in the
      // title attribute for whoever is actually debugging.
      return {
        text: t('update.error'),
        detail: s.error || '',
        primary: { label: t('update.retry'), action: 'check' },
      };

    case 'none':
      return {
        text: t('update.current', { v: s.version || '' }),
        primary: { label: t('update.check'), action: 'check' },
      };

    case 'unsupported':
      // A dev clone says nothing at all - `git pull` is the update path and a
      // notice would be noise. A portable build MUST speak up: it cannot update
      // itself (see src/update.js), so silence would read as "you are current".
      if (s.reason === 'portable') {
        return { text: t('update.portable', { v: s.version || '' }), notes: true };
      }
      return null;

    default:
      return null;
  }
}

function render() {
  if (!els) return;

  const view = describe(last);

  // Hidden entirely rather than emptied: an empty row still costs a flex gap,
  // and a dev clone should look exactly as it did before D5 existed.
  els.root.hidden = !view;
  if (!view) return;

  els.text.textContent = view.text;
  els.text.title = view.detail || '';
  els.root.classList.toggle('is-available', Boolean(view.highlight));
  els.root.classList.toggle('is-busy', Boolean(view.busy));

  // Progress bar: scaleX like the usage bars, so there is no layout thrash.
  const pct = typeof view.percent === 'number' ? view.percent : 0;
  els.bar.hidden = typeof view.percent !== 'number';
  els.bar.style.setProperty('--update-progress', String(pct / 100));

  if (view.primary) {
    els.action.hidden = false;
    els.action.textContent = view.primary.label;
    els.action.dataset.action = view.primary.action;
  } else {
    els.action.hidden = true;
    delete els.action.dataset.action;
  }

  els.notes.hidden = !view.notes;
  els.notes.textContent = t('update.notes');
}

function onAction() {
  const action = els && els.action.dataset.action;
  if (action === 'download') window.lunacore.downloadUpdate();
  else if (action === 'install') window.lunacore.installUpdate();
  else if (action === 'check') window.lunacore.checkUpdate();
}

function onNotes() {
  // No argument: main owns the address, so the renderer cannot aim
  // shell.openExternal anywhere it likes.
  window.lunacore.openReleases();
}

/**
 * Mounts the notice into the appearance widget's root.
 *
 * @param {HTMLElement} root the appearance widget root
 * @returns {() => void} disposer
 */
export function mountUpdate(root) {
  const container = root.querySelector('#update-notice');
  if (!container) return () => {};

  els = {
    root: container,
    text: container.querySelector('#update-text'),
    bar: container.querySelector('#update-bar'),
    action: container.querySelector('#update-action'),
    notes: container.querySelector('#update-notes'),
  };

  els.action.addEventListener('click', onAction);
  els.notes.addEventListener('click', onNotes);

  // Replayed channel, so a state that arrived before this mount still lands.
  const offState = onUpdateState((state) => {
    last = state && typeof state === 'object' ? state : last;
    render();
  });
  const offLang = onLangChange(render);

  render();

  // Pure display: the timers and requests all live in main, so this disposer
  // genuinely only cancels - there is no pending user intent to flush (§A2b).
  return () => {
    offState();
    offLang();
    els = null;
  };
}
