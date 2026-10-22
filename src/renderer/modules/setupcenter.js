// ============================================================================
// LunaCore - Setup Center (Settings overlay, Ctrl+L, top section)
// ----------------------------------------------------------------------------
// One collapsible row per integration: a status dot, the state, and - for
// anything not ok - short steps plus Connect/Fix buttons. Main decides every
// state (src/setupcenter.js + src/setupipc.js) and owns every URL; this module
// only gets {id, state, note} rows and builds DOM with textContent.
//
// Two rows carry a form: the cloud one (the user's OWN Supabase project URL +
// publishable key -> config/cloud.local.json, validated in main) and the
// phone one (their own PWA deploy URL -> a QR code main encodes).
// Also here: the optional-module switches (hide Life / Mission Control /
// God Mode), applied as data-hide-* attributes on <html>.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

const DOT = { ok: 'diag-item__dot--ok', warning: 'diag-item__dot--warn', missing: 'diag-item__dot--fail' };

/**
 * Per integration: how many guide steps it has (setup.<id>.step1..N) and its
 * buttons. `link` opens a whitelisted page by id (main builds the URL); `run`
 * names an action in RUNS below.
 */
const ROWS = {
  claude: { steps: 3, actions: [{ link: 'claude-install', label: 'setup.action.install' }] },
  gh: { steps: 2, actions: [{ link: 'gh-install', label: 'setup.action.install' }] },
  cloud: {
    steps: 3,
    form: 'cloud',
    actions: [
      { link: 'supabase-new', label: 'setup.action.newProject' },
      { run: 'cloudLogin', label: 'setup.action.login' },
      { run: 'relaunch', label: 'setup.action.restart' },
    ],
  },
  cloudTables: {
    steps: 2,
    actions: [
      { run: 'checkTables', label: 'setup.action.check' },
      { link: 'migrations', label: 'setup.action.migrations' },
      { link: 'supabase-sql', label: 'setup.action.sqlEditor' },
    ],
  },
  cloudAuth: {
    steps: 4,
    actions: [
      { link: 'supabase-auth-providers', label: 'setup.action.providers' },
      { link: 'supabase-url-config', label: 'setup.action.redirects' },
    ],
  },
  google: {
    steps: 4,
    actions: [
      { link: 'google-console', label: 'setup.action.googleConsole' },
      { link: 'google-consent', label: 'setup.action.consent' },
      { run: 'gcalImport', label: 'setup.action.importClient' },
      { run: 'gcalConnect', label: 'setup.action.connect' },
    ],
  },
  functions: {
    steps: 4,
    ownerId: true,
    actions: [
      { link: 'functions', label: 'setup.action.functionsSource' },
      { link: 'supabase-functions', label: 'setup.action.functions' },
      { link: 'supabase-secrets', label: 'setup.action.secrets' },
    ],
  },
  pwa: {
    steps: 4,
    form: 'pwa',
    actions: [
      { link: 'vercel-new', label: 'setup.action.vercel' },
      { link: 'mobile', label: 'setup.action.mobileSource' },
    ],
  },
  host: { steps: 3, actions: [] },
  yazio: { steps: 2, actions: [] },
  agentReach: { steps: 3, actions: [{ run: 'newsSetup', label: 'setup.action.newsSetup' }] },
  lmstudio: { steps: 2, actions: [{ link: 'lmstudio', label: 'setup.action.download' }] },
  freellm: { steps: 2, actions: [{ link: 'freellm', label: 'setup.action.download' }] },
};

/** Reason ids from main -> i18n keys under setup.msg. */
const MESSAGES = new Set([
  'bad-url',
  'bad-key',
  'secret-key',
  'exists',
  'save-failed',
  'not-configured',
  'rate-limited',
  'timeout',
  'failed',
  'cancelled',
  'busy',
]);
const msgKey = (reason) => `setup.msg.${MESSAGES.has(reason) ? reason : 'failed'}`;

/** ui pref -> dataset key on <html> (data-hide-life / -mission / -godmode). */
const HIDE_ATTRS = { hideLife: 'hideLife', hideMission: 'hideMission', hideGodMode: 'hideGodmode' };
const HIDE_INPUTS = { hideLife: '#setup-hide-life', hideMission: '#setup-hide-mission', hideGodMode: '#setup-hide-godmode' };

let els = null;
let status = null; // last setup:status answer, null while checking
let seq = 0; // drops a stale answer that lands after a newer refresh started
let notes = {}; // id -> {key, params, fail}: one line under a row after an action
const openRows = new Set();

const api = () => window.lunacore;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, onClick) {
  const b = el('button', 'termcustom__reset', t(label));
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function setNote(id, key, params = {}, fail = false) {
  notes = { ...notes, [id]: { key, params, fail } };
  render();
}

/** Shows an action's outcome under its row, then re-probes. */
function report(id, r, okKey) {
  const ok = Boolean(r && r.ok);
  setNote(id, ok ? okKey : msgKey(r && r.reason), {}, !ok);
  refresh();
}

// ---- actions ---------------------------------------------------------------

const RUNS = {
  async cloudLogin(id) {
    report(id, await api().cloudLogin().catch(() => null), 'setup.msg.loggedIn');
  },
  relaunch() {
    api().relaunchApp();
  },
  async checkTables(id) {
    const r = await api().checkSetupTables().catch(() => null);
    if (!r || !r.ok) return report(id, r, '');
    const missing = Array.isArray(r.missing) ? r.missing.join(', ') : '';
    setNote(id, missing ? 'setup.msg.tablesMissing' : 'setup.msg.tablesOk', { present: r.present, total: r.total, missing }, Boolean(missing));
    refresh();
  },
  async gcalImport(id) {
    report(id, await api().missionGcalImportClient().catch(() => null), 'setup.msg.clientSaved');
  },
  async gcalConnect(id) {
    report(id, await api().missionGcalConnect().catch(() => null), 'setup.msg.connected');
  },
  async newsSetup(id) {
    setNote(id, 'setup.msg.working');
    report(id, await api().missionNewsSetup().catch(() => null), 'setup.msg.done');
  },
};

// Replacing an already-configured project is confirmed by main's own dialog.
async function saveCloud(id, urlInput, keyInput) {
  const r = await api().saveSetupCloud({ url: urlInput.value, key: keyInput.value }).catch(() => null);
  if (r && r.ok) keyInput.value = '';
  report(id, r, 'setup.msg.cloudSaved');
}

async function savePwa(id, input) {
  report(id, await api().setSetupPwaUrl(input.value.trim() || null).catch(() => null), 'setup.msg.pwaSaved');
}

// ---- forms -----------------------------------------------------------------

function field(labelKey, input) {
  const label = el('label', 'ui-field');
  input.setAttribute('aria-label', t(labelKey));
  input.spellcheck = false;
  label.append(el('span', 'ui-field__label', t(labelKey)), input);
  return label;
}

function cloudForm(id) {
  const wrap = el('div', 'setup-form');
  const url = el('input', 'profile-select');
  url.type = 'url';
  url.placeholder = 'https://<project-ref>.supabase.co';
  const key = el('input', 'profile-select');
  key.type = 'password';
  key.placeholder = 'sb_publishable_...';
  key.autocomplete = 'off';
  wrap.append(
    field('setup.cloud.url', url),
    field('setup.cloud.key', key),
    el('p', 'hint', t('setup.cloud.keyHint')),
    button('setup.action.save', () => saveCloud(id, url, key))
  );
  return wrap;
}

function drawQr(canvas, qr) {
  const quiet = 4;
  const scale = 4;
  const n = qr.size + quiet * 2;
  canvas.width = n * scale;
  canvas.height = n * scale;
  const css = getComputedStyle(document.documentElement);
  const ctx = canvas.getContext('2d');
  // Dark modules on a light ground scan best: the theme's text colour is its
  // light one, its background the dark one.
  ctx.fillStyle = css.getPropertyValue('--text').trim();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = css.getPropertyValue('--bg').trim();
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.bits[y * qr.size + x] === '1') ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
}

function pwaForm(id) {
  const wrap = el('div', 'setup-form');
  const input = el('input', 'profile-select');
  input.type = 'url';
  input.placeholder = 'https://your-luna.vercel.app';
  input.value = (status && status.pwaUrl) || '';
  wrap.append(field('setup.pwa.url', input), button('setup.action.save', () => savePwa(id, input)));
  if (status && status.pwaUrl) {
    const canvas = el('canvas', 'setup-qr');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', t('setup.pwa.qr'));
    wrap.append(canvas, button('setup.action.openPwa', () => api().openSetupLink('pwa')));
    api()
      .getSetupPwaQr()
      .then((qr) => {
        if (qr && qr.ok && typeof qr.bits === 'string' && qr.bits.length === qr.size * qr.size) drawQr(canvas, qr);
      })
      .catch(() => {});
  }
  return wrap;
}

// ---- rows ------------------------------------------------------------------

function rowBody(r, spec) {
  const body = el('div', 'setup-row__body');
  const steps = el('ol', 'setup-row__steps');
  for (let i = 1; i <= spec.steps; i++) steps.append(el('li', null, t(`setup.${r.id}.step${i}`)));
  body.append(steps);
  if (spec.ownerId && status.ownerUserId) {
    const owner = el('p', 'hint setup-row__owner', `${t('setup.functions.ownerId')} `);
    owner.append(el('code', null, status.ownerUserId));
    body.append(owner);
  }
  if (spec.form === 'cloud') body.append(cloudForm(r.id));
  if (spec.form === 'pwa') body.append(pwaForm(r.id));
  if (spec.actions.length) {
    const bar = el('div', 'setup-row__actions');
    for (const a of spec.actions) bar.append(button(a.label, () => (a.link ? api().openSetupLink(a.link) : RUNS[a.run](r.id))));
    body.append(bar);
  }
  const note = notes[r.id];
  if (note) {
    const p = el('p', `hint${note.fail ? ' is-fail' : ''}`, t(note.key, note.params));
    p.setAttribute('role', 'status');
    body.append(p);
  }
  return body;
}

function renderRow(r) {
  const spec = ROWS[r.id];
  if (!spec) return null;
  const details = el('details', `setup-row setup-row--${r.state}`);
  details.open = openRows.has(r.id);
  details.addEventListener('toggle', () => (details.open ? openRows.add(r.id) : openRows.delete(r.id)));
  const summary = el('summary', 'setup-row__head');
  summary.append(
    el('span', `diag-item__dot ${DOT[r.state] || 'diag-item__dot--unknown'}`),
    el('span', 'setup-row__title', t(`setup.${r.id}.title`)),
    el('span', 'setup-row__state', t(r.note ? `setup.note.${r.note}` : `setup.state.${r.state}`))
  );
  details.append(summary, rowBody(r, spec));
  return details;
}

function render() {
  if (!els) return;
  if (!status) {
    els.rows.replaceChildren(el('p', 'hint', t('setup.checking')));
    return;
  }
  if (!status.ok) {
    els.rows.replaceChildren(el('p', 'hint is-fail', t('setup.msg.failed')));
    return;
  }
  els.rows.replaceChildren(...status.rows.map(renderRow).filter(Boolean));
}

/** Re-probes everything (main caches answers for a few seconds). */
export async function refresh() {
  if (!els) return;
  const mine = ++seq;
  let next;
  try {
    next = await api().getSetupStatus();
  } catch {
    next = null;
  }
  if (mine !== seq || !els) return;
  status = next && next.ok && Array.isArray(next.rows) ? next : { ok: false };
  render();
}

// ---- optional modules ------------------------------------------------------

/** Puts the hide switches on <html>; styles.css and the panel shortcuts read them. */
export function applyModuleVisibility(prefs) {
  const root = document.documentElement;
  for (const [key, attr] of Object.entries(HIDE_ATTRS)) {
    if (prefs && prefs[key] === true) root.dataset[attr] = '1';
    else delete root.dataset[attr];
  }
}

function mountModuleSwitches(root, prefs) {
  let current = { ...prefs };
  for (const [key, sel] of Object.entries(HIDE_INPUTS)) {
    const input = root.querySelector(sel);
    if (!input) continue;
    input.checked = prefs[key] === true;
    input.addEventListener('change', async () => {
      const next = await api().setUiPrefs({ [key]: input.checked }).catch(() => null);
      current = next || { ...current, [key]: input.checked };
      applyModuleVisibility(current);
    });
  }
}

/**
 * Called once from initTermcustomSettings() - the section is static markup.
 * @param {ParentNode} root
 * @param {object} prefs ui prefs read at startup
 */
export function mountSetupCenter(root, prefs = {}) {
  applyModuleVisibility(prefs);
  mountModuleSwitches(root, prefs);
  const rows = root.querySelector('#setup-rows');
  if (!rows || typeof api().getSetupStatus !== 'function') return;
  els = { rows };
  const again = root.querySelector('#setup-refresh');
  if (again) again.addEventListener('click', refresh);
  onLangChange(render);
  render();
}
