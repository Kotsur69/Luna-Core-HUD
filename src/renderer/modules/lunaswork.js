// ============================================================================
// LunaCore - Luna's Work entry point (docs/LUNAS_WORK_PLAN.md slice 1.2c)
// ----------------------------------------------------------------------------
// Its own button (next to God Mode in the to-do widget) and its own Settings
// pane: models per role, the free-providers fallback, the project profile and
// pre-production (scaffold design/ + the interview tab, and the per-project
// LW 2.25 toggles: design variants, clickable mockup first). God Mode's
// controls are not touched.
//
// Everything goes through the narrow lunaswork:* IPC (src/lunasworkipc.js):
// the renderer names a known project by id and sends plain values; main
// validates them and answers with the stored state, which is what gets
// painted - never the value the user typed. Same static-overlay mount shape
// as orchestrasettings.js.
//
// The run panel's Dashboard button opens the live run dashboard (LW 2.17a,
// modules/lunasworkDashboard.js) in its own overlay over Settings, and the
// "Ask Luna" box (LW 2.27, modules/lunasworkAsk.js) sits under the steer form.
// ============================================================================

'use strict';

import { sfx } from './sound.js';
import { t } from './util.js';
import { onLangChange } from './bus.js';
import { mountLunasWorkPanel } from './lunasworkPanel.js';
import { mountLunasWorkDashboard } from './lunasworkDashboard.js';
import { mountLunasWorkAsk } from './lunasworkAsk.js';

const MODEL_LABELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const SAVED_FLASH_MS = 2000;

let refreshPane = null;

/** Opens Settings on the Luna's Work pane with fresh state. */
async function openLunasWork() {
  sfx.modeToggle();
  // Imported on click: termcustom.js touches the DOM at load, and todo.js
  // (which mounts this button) is imported by node tests without one.
  const { openSettingsAt } = await import('./termcustom.js');
  await openSettingsAt('lunaswork-section');
  if (refreshPane) refreshPane();
}

/**
 * Wires the to-do widget's "Luna's Work" button. Returns the cleanup for its unmount.
 * @param {HTMLElement} root
 * @returns {() => void}
 */
export function mountLunasWorkButton(root) {
  const btn = root.querySelector('#lunaswork-open');
  if (!btn) return () => {};
  btn.addEventListener('click', openLunasWork);
  return () => btn.removeEventListener('click', openLunasWork);
}

/** Localized text for a failed IPC answer. */
function errorText(res) {
  if (res && res.reason === 'bad-profile') return t(`lw.err.field.${res.field || 'profile'}`);
  const reason = res && typeof res.reason === 'string' ? res.reason : 'failed';
  const text = t(`lw.err.${reason}`);
  return text === `lw.err.${reason}` ? t('lw.err.failed') : text;
}

function show(el, text) {
  el.textContent = text || '';
  el.hidden = !text;
}

/**
 * @param {HTMLElement} root the Settings overlay
 */
export function mountLunasWorkSettings(root) {
  const el = {
    project: root.querySelector('#lw-project'),
    error: root.querySelector('#lw-error'),
    selects: Array.from(root.querySelectorAll('[data-lw-role]')),
    free: root.querySelector('#lw-free-toggle'),
    freeStatus: root.querySelector('#lw-free-status'),
    form: root.querySelector('#lw-profile-form'),
    adapter: root.querySelector('#lw-adapter'),
    start: root.querySelector('#lw-start'),
    url: root.querySelector('#lw-url'),
    timeout: root.querySelector('#lw-timeout'),
    check: root.querySelector('#lw-check'),
    profileError: root.querySelector('#lw-profile-error'),
    saved: root.querySelector('#lw-profile-saved'),
    packStatus: root.querySelector('#lw-pack-status'),
    packList: root.querySelector('#lw-pack-missing'),
    preprod: root.querySelector('#lw-preprod-start'),
  };
  // LW 2.25a / 2.25b: per-project toggles; the setting key -> its switch and status.
  const toggles = [
    ['designVariants', root.querySelector('#lw-variants-toggle'), root.querySelector('#lw-variants-status')],
    ['mockupFirst', root.querySelector('#lw-mockup-toggle'), root.querySelector('#lw-mockup-status')],
  ].filter(([, input, status]) => input && status);
  if (Object.values(el).some((v) => !v)) return;

  let state = null;
  let pack = null;
  let savedTimer = null;
  const projectId = () => el.project.value || null;

  function fillModelOptions(choices) {
    for (const select of el.selects) {
      if (select.options.length === choices.length) continue;
      select.replaceChildren(...choices.map((c) => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c === 'auto' ? t('lw.model.auto') : MODEL_LABELS[c] || c;
        return opt;
      }));
    }
  }

  function paintModels() {
    if (!state) return;
    fillModelOptions(state.choices);
    for (const select of el.selects) select.value = state.models[select.dataset.lwRole];
    el.free.checked = state.freeFallback === true;
    el.freeStatus.textContent = t(state.freeFallback ? 'lw.free.on' : 'lw.free.off');
    for (const [key, input, status] of toggles) {
      input.checked = state[key] === true;
      status.textContent = t(state[key] === true ? 'lw.toggle.on' : 'lw.toggle.off');
    }
  }

  function paintProfile() {
    if (!state) return;
    const p = state.profile;
    el.adapter.value = p ? p.adapter : 'web';
    el.start.value = p ? p.startCommand : '';
    el.url.value = p ? p.url : '';
    el.timeout.value = p ? String(p.readyTimeoutSec) : '';
    el.check.value = p ? p.checkCommand : '';
  }

  function paintPack() {
    el.packList.replaceChildren();
    if (!pack) return show(el.packStatus, '');
    if (!pack.ok) return show(el.packStatus, errorText(pack));
    const { complete, missing, empty } = pack.pack;
    show(el.packStatus, t(complete ? 'lw.pack.complete' : 'lw.pack.incomplete'));
    const rows = [...missing.map((f) => [f, 'lw.pack.missing']), ...empty.map((f) => [f, 'lw.pack.empty'])];
    el.packList.replaceChildren(...rows.map(([file, key]) => {
      const li = document.createElement('li');
      li.textContent = `${file} - ${t(key)}`;
      return li;
    }));
  }

  async function loadProjects() {
    const res = await window.lunacore.getProjects();
    const list = res && Array.isArray(res.projects) ? res.projects : [];
    const keep = projectId() || (res && res.activeProject);
    el.project.replaceChildren(...list.map((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label || p.id;
      return opt;
    }));
    if (list.some((p) => p.id === keep)) el.project.value = keep;
  }

  async function refresh() {
    show(el.error, '');
    show(el.profileError, '');
    if (!projectId()) await loadProjects();
    const id = projectId();
    if (!id) return show(el.error, t('lw.err.bad-project'));
    const [settings, status] = await Promise.all([
      window.lunacore.lunasworkGetSettings(id),
      window.lunacore.lunasworkPackStatus(id),
    ]);
    if (settings && settings.ok) state = settings;
    else show(el.error, errorText(settings));
    pack = status;
    paintModels();
    paintProfile();
    paintPack();
  }
  refreshPane = refresh;

  /**
   * Saves one patch and paints main's answer. On a refusal the selects and the
   * toggle go back to the stored values, but the profile form keeps what was
   * typed so it can be corrected.
   */
  async function save(patch, errorEl = el.error) {
    const id = projectId();
    if (!id) return false;
    const res = await window.lunacore.lunasworkSaveSettings(id, patch);
    if (!res || !res.ok) {
      show(errorEl, errorText(res));
      paintModels();
      return false;
    }
    show(errorEl, '');
    state = res;
    paintModels();
    if (patch.profile !== undefined) paintProfile();
    return true;
  }

  for (const select of el.selects) {
    select.addEventListener('change', () => {
      sfx.modeToggle();
      save({ models: { [select.dataset.lwRole]: select.value } });
    });
  }

  el.free.addEventListener('change', () => {
    sfx.modeToggle();
    save({ freeFallback: el.free.checked });
  });

  for (const [key, input] of toggles) {
    input.addEventListener('change', () => {
      sfx.modeToggle();
      save({ [key]: input.checked });
    });
  }

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.saved.hidden = true;
    const timeout = el.timeout.value.trim();
    const profile = {
      adapter: el.adapter.value,
      startCommand: el.start.value,
      // Empty URL / timeout -> main's defaults (localhost, 60 s).
      ...(el.url.value.trim() ? { url: el.url.value.trim() } : {}),
      ...(timeout ? { readyTimeoutSec: Number(timeout) } : {}),
      checkCommand: el.check.value,
    };
    if (await save({ profile }, el.profileError)) {
      sfx.modeToggle();
      el.saved.hidden = false;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => { el.saved.hidden = true; }, SAVED_FLASH_MS);
    }
  });

  // The run panel (start / stop / steer, live status) lives in the same pane.
  const runPanel = mountLunasWorkPanel(root, {
    projectId,
    projectLabel: (id) => {
      const opt = Array.from(el.project.options).find((o) => o.value === id);
      return opt ? opt.textContent : id;
    },
  });

  // LW 2.27: "Ask Luna about the run", answered read-only by main.
  mountLunasWorkAsk(root);

  // LW 2.17a: the live dashboard, an overlay of its own (#lw-dash) over Settings.
  const dashboard = mountLunasWorkDashboard(document.getElementById('lw-dash'));
  const dashButton = root.querySelector('#lw-run-dashboard');
  if (dashButton) {
    dashButton.addEventListener('click', () => {
      sfx.navClick();
      dashboard.open();
    });
  }

  el.project.addEventListener('change', () => {
    sfx.navClick();
    runPanel.projectChanged();
    refresh();
  });

  el.preprod.addEventListener('click', async () => {
    const id = projectId();
    if (!id) return;
    el.preprod.disabled = true;
    try {
      sfx.terminalNew();
      const res = await window.lunacore.lunasworkStartInterview(id);
      pack = res && res.ok ? { ok: true, pack: res.pack } : res;
      paintPack();
      if (res && res.ok) show(el.packStatus, `${el.packStatus.textContent} ${t('lw.preprod.opened')}`);
    } finally {
      el.preprod.disabled = false;
    }
  });

  window.lunacore.onProjectsChanged(() => loadProjects().then(refresh));
  onLangChange(() => {
    // Option labels and status texts are built here, not by data-i18n.
    for (const select of el.selects) select.replaceChildren();
    paintModels();
    paintPack();
  });

  loadProjects().then(refresh);
}
