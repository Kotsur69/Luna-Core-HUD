// ============================================================================
// LunaCore - Settings (Ctrl+L) -> Notification hub (renderer, N6)
// ----------------------------------------------------------------------------
// docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N6. Static markup in index.html
// (#hub-section ...), wired once from termcustom.js like notify.js:
//   - auto-open at launch: always / only when needed (default) / never
//     (hubAutoOpen, read by hubicon.js at launch);
//   - toasts on / off (hubToasts, applied live to hubtoast.js);
//   - per-source on / off (hubSources = {group: false}; main's hub drops the
//     collectors of a switched-off group, src/hubsources.js);
//   - drawer width reset (hubWidth back to the default, applied live).
// Every value is validated again in main (src/uiprefs.js).
//
// N7: auto-open, toasts, sources and the system notification switch sync
// across PCs (src/hubprefsync.js) while the cloud is logged in; the line under
// the heading says which ("Synced across your PCs" / "This PC only", checked
// on every Settings open). A choice made on another PC repaints the switches
// live (hubstate.js onHubPrefs). The drawer width stays per PC.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { sfx } from './sound.js';
import { AUTO_OPEN_MODES, normalizeAutoOpen } from './hubrules.js';
import { setHubToastsEnabled } from './hubtoast.js';
import { resetHubWidth } from './hubpanel.js';
import { refreshHub, onHubPrefs } from './hubstate.js';

/**
 * The source groups, in display order - the same names as src/hubsources.js
 * GROUP_NAMES (CommonJS, main side); test/hubsettings.test.js pins the two.
 */
export const HUB_SOURCE_GROUPS = Object.freeze(['godmode', 'power', 'life', 'mail', 'accounts', 'todo', 'update']);

const save = (partial) => Promise.resolve().then(() => window.lunacore.setUiPrefs(partial)).catch(() => {});

let els = null;
let state = { autoOpen: 'needed', toasts: true, sources: {} };
/** null until the cloud status answered; then whether the switches sync. */
let synced = null;

/** The stored prefs -> this module's state (unknown groups dropped). */
function stateOf(prefs) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const sources = p.hubSources && typeof p.hubSources === 'object' ? p.hubSources : {};
  return {
    autoOpen: normalizeAutoOpen(p.hubAutoOpen),
    toasts: p.hubToasts !== false,
    sources: Object.fromEntries(HUB_SOURCE_GROUPS.filter((g) => sources[g] === false).map((g) => [g, false])),
  };
}

function paintSync() {
  if (!els || !els.sync) return;
  els.sync.textContent = t(synced ? 'hubset.sync.synced' : 'hubset.sync.local');
  els.sync.classList.toggle('is-synced', synced === true);
}

/** Re-checks whether the hub Settings sync (cloud configured + logged in). Never throws. */
export async function refreshHubSyncLine() {
  let status = null;
  try {
    status = await window.lunacore.cloudStatus();
  } catch {
    status = null;
  }
  synced = Boolean(status && status.ok !== false && status.configured !== false && status.loggedIn === true);
  paintSync();
}

function switchRow(group) {
  const label = document.createElement('label');
  label.className = 'switch-field';
  const text = document.createElement('span');
  text.className = 'switch-field__text';
  const name = document.createElement('span');
  name.className = 'switch-field__label';
  name.dataset.hubGroup = group;
  text.append(name);
  const sw = document.createElement('span');
  sw.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'switch__input';
  input.id = `hubset-src-${group}`;
  const track = document.createElement('span');
  track.className = 'switch__track';
  const thumb = document.createElement('span');
  thumb.className = 'switch__thumb';
  track.append(thumb);
  sw.append(input, track);
  label.append(text, sw);
  input.addEventListener('change', () => {
    sfx.modeToggle();
    const next = { ...state.sources };
    if (input.checked) delete next[group];
    else next[group] = false;
    state = { ...state, sources: next };
    // Sent whole: uiprefs replaces hubSources, so turning a group back on works.
    save({ hubSources: next }).then(() => refreshHub());
  });
  return { label, input, name };
}

function paint() {
  if (!els) return;
  els.select.replaceChildren(...AUTO_OPEN_MODES.map((mode) => {
    const opt = document.createElement('option');
    opt.value = mode;
    opt.textContent = t(`hubset.autoOpen.${mode}`);
    return opt;
  }));
  els.select.value = state.autoOpen;
  els.toggle.checked = state.toasts;
  els.toastsStatus.textContent = t(state.toasts ? 'hubset.on' : 'hubset.off');
  els.toastsField.classList.toggle('is-armed', state.toasts);
  for (const [group, row] of els.rows) {
    row.name.textContent = t(`hubset.src.${group}`);
    row.input.checked = state.sources[group] !== false;
  }
  paintSync();
}

/** Called once from termcustom.js initTermcustomSettings() with #termcustom as root. */
export function mountHubSettings(root, prefs) {
  const select = root.querySelector('#hubset-autoopen');
  const toggle = root.querySelector('#hubset-toasts');
  const sourcesBox = root.querySelector('#hubset-sources');
  const reset = root.querySelector('#hubset-width-reset');
  if (!select || !toggle || !sourcesBox || !reset) return () => {};
  const rows = new Map(HUB_SOURCE_GROUPS.map((g) => [g, switchRow(g)]));
  sourcesBox.replaceChildren(...[...rows.values()].map((r) => r.label));
  els = {
    select,
    toggle,
    rows,
    toastsField: root.querySelector('#hubset-toasts-field'),
    toastsStatus: root.querySelector('#hubset-toasts-status'),
    sync: root.querySelector('#hubset-sync'),
  };
  state = stateOf(prefs);
  paint();
  refreshHubSyncLine();

  select.addEventListener('change', () => {
    sfx.modeToggle();
    state = { ...state, autoOpen: normalizeAutoOpen(select.value) };
    save({ hubAutoOpen: state.autoOpen });
  });
  toggle.addEventListener('change', () => {
    sfx.modeToggle();
    state = { ...state, toasts: toggle.checked };
    setHubToastsEnabled(state.toasts);
    paint();
    save({ hubToasts: state.toasts });
  });
  reset.addEventListener('click', () => {
    sfx.modeToggle();
    resetHubWidth();
  });
  // Static overlay, never unmounted (same as notify.js): permanent for the app's life.
  const offLang = onLangChange(paint);
  // N7: another PC's choice re-reads getUiPrefs() and repaints the switches live.
  const offPrefs = onHubPrefs((next) => {
    state = stateOf(next);
    paint();
  });
  return () => {
    offLang();
    offPrefs();
    els = null;
  };
}
