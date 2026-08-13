// ============================================================================
// LunaCore - D5: the update chip
// ----------------------------------------------------------------------------
// Lives in the `terminal` widget's bar, next to the Ctrl+K / Ctrl+L chips,
// rather than being a widget of its own or a permanent block in the left
// panel (its original home through 2026-08-13). That move was a deliberate
// declutter, not a relocation for its own sake: `terminal` - like `appearance`
// - is in src/layouts.js REQUIRED_WIDGETS, so every valid layout preset still
// carries it by construction, and it is now HIDDEN unless there is something
// to actually do (`available` / `downloading` / `ready`). `checking`,
// `current` and - on request - `error` are no longer rendered at all: a
// permanently-visible "could not check for updates" was worse than useful
// noise, since a build checks on every launch and normally has nothing to
// report. The state machine still runs in full (see src/update.js); only what
// this module chooses to SHOW changed.
//
// NOTHING here downloads or installs. The chip asks main to; main is where the
// consent lives (see src/update.js for why notify-only).
// ============================================================================

'use strict';

import { onUpdateState, onLangChange } from './bus.js';

const t = (key, params) => window.i18n.t(key, params);

// Elements of the current mount, or null when not on screen.
let els = null;

// Last state from the bus. Module scope, so a remount repaints from truth
// instead of from the template's authored markup (the §A2c rule). `terminal`
// never actually remounts (§A2f), but the state still has to survive a
// language switch, which re-runs render() the same way.
let last = { state: 'idle', info: null, percent: 0, error: null, reason: null, version: '' };

/**
 * What the chip says, and what clicking it does, for one state. Returns null
 * for every state that has nothing actionable to show - the chip stays
 * hidden, which is the whole point of moving this out of the left panel.
 *
 * Returned as data rather than written straight to the DOM so `render()`
 * stays a function that only WRITES to the DOM and never reads from it (§A2d).
 */
function describe(s) {
  const version = (s.info && s.info.version) || '?';

  switch (s.state) {
    case 'available':
      return {
        text: t('update.chip.available', { v: version }),
        title: t('update.available', { v: version }),
        action: 'download',
      };

    case 'downloading':
      return {
        text: t('update.chip.downloading', { p: s.percent }),
        title: t('update.downloading', { p: s.percent }),
        busy: true,
      };

    case 'ready':
      return {
        text: t('update.chip.ready', { v: version }),
        title: t('update.ready', { v: version }),
        action: 'install',
      };

    // 'checking', 'current'/'none', 'error' and 'unsupported' (dev clone or
    // portable build) all resolve to "nothing to show here" on purpose - see
    // the header comment. The real error still reaches main's console for
    // whoever is actually debugging a failed check.
    default:
      return null;
  }
}

function render() {
  if (!els) return;

  const view = describe(last);

  els.root.hidden = !view;
  if (!view) return;

  els.root.textContent = view.text;
  els.root.title = view.title;
  els.root.disabled = Boolean(view.busy);
  els.root.classList.toggle('is-busy', Boolean(view.busy));
  els.root.dataset.action = view.action || '';
}

function onClick() {
  const action = els && els.root.dataset.action;
  if (action === 'download') window.lunacore.downloadUpdate();
  else if (action === 'install') window.lunacore.installUpdate();
}

/**
 * Mounts the chip into the terminal widget's bar.
 *
 * @param {HTMLElement} root the terminal widget root
 */
export function mountUpdateChip(root) {
  const btn = root.querySelector('#update-chip');
  if (!btn) return;

  els = { root: btn };

  btn.addEventListener('click', onClick);

  // Replayed channel, so a state that arrived before this mount still lands.
  onUpdateState((state) => {
    last = state && typeof state === 'object' ? state : last;
    render();
  });
  onLangChange(render);

  render();

  // No returned disposer: `terminal` never unmounts (§A2f), same as this
  // bar's other two chips (mountPaletteChip / mountTermcustomChip).
}
