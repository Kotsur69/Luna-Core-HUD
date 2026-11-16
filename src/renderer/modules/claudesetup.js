// ============================================================================
// LunaCore - Claude setup switcher widget (`setup`)
// ----------------------------------------------------------------------------
// Machine-wide Claude Code setup profiles (claude-code-setup, `luna-setup use`,
// main side in src/claudesetup.js). Unlike the profile/project twins in
// switchers.js this does NOT restart anything: it rewrites ~/.claude, and
// every running claude keeps its old setup until the user restarts that tab.
//
// Picking another profile is three steps, never one:
//   1. preview  - `use <name> --dry-run`: the change list is shown inline;
//   2. confirm  - the same panel says how many claude sessions are running
//                 (counted in main) and that they keep the old setup;
//   3. apply    - only on Confirm. Cancel (or Escape) changes nothing and puts
//                 the select back on the active profile.
// Sessions are never killed or restarted from here, and there is no restore
// button (that stays a deliberate `luna-setup restore` in a terminal).
//
// Below that: "Also apply to Antigravity (agy)" (main mirrors the switched
// setup into ~/.gemini/config, src/agysetupmirror.js) and "Sync to agy now".
// The mirror's outcome has its own status line - a failed mirror never turns
// a good switch into an error.
//
// All DOM text goes through textContent. State lives at module level so a
// remount repaints without asking main again. Nothing loads until both
// initClaudeSetup() (renderer.js) has run and the widget is on screen.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, emitSetupSwitched } from './bus.js';
import { defineWidget } from './registry.js';

const NOTE_MS = 10000;

/** Main's error codes -> i18n keys. Anything unknown reads as a plain failure. */
const ERROR_KEYS = Object.freeze({
  'switcher-too-old': 'claudesetup.err.tooOld',
  'no-switcher': 'claudesetup.err.noSwitcher',
  'clone-failed': 'claudesetup.err.clone',
  'repo-broken': 'claudesetup.err.repoBroken',
  timeout: 'claudesetup.err.timeout',
  busy: 'claudesetup.err.busy',
  'bad-name': 'claudesetup.err.unknown',
  'unknown-profile': 'claudesetup.err.unknown',
  failed: 'claudesetup.err.failed',
});

/** Antigravity mirror error codes -> i18n keys. */
const AGY_ERROR_KEYS = Object.freeze({
  'agy-not-found': 'claudesetup.agy.err.notFound',
  'broken-json': 'claudesetup.agy.err.brokenJson',
  'block-damaged': 'claudesetup.agy.err.damaged',
  'source-unreadable': 'claudesetup.agy.err.source',
  unreadable: 'claudesetup.agy.err.unreadable',
  'linked-folder': 'claudesetup.agy.err.linked',
  busy: 'claudesetup.err.busy',
  failed: 'claudesetup.agy.err.failed',
});

// ---- module state (survives a remount) -----------------------------------------
let initialized = false;
let loaded = false;
let loading = false;
let loadSeq = 0;
let profiles = null; // [{name, description, active}] | null before a good load
let active = null; // the applied profile's name | null (unmanaged)
let tokens = null; // approx. always-on context of the live setup | null
let stale = false; // main could not fetch and listed the downloaded clone
let pending = null; // {name, steps, warnings, running} while the confirm is open
let working = false; // a preview or an apply is in flight
let note = null; // {kind:'info'|'ok'|'error', key, params, detail}
let noteTimer = null;
let refocus = false; // put focus back on the select after the next reload
let agy = null; // {available, enabled, profile, mirroredAt, lastError} | null before a good load
let agyBusy = false; // a toggle save or a manual sync is in flight
let agyNote = null; // {kind, key, params, detail} from the last sync this session
let agySeq = 0; // a status answer older than the last toggle is dropped

let els = null; // elements of the current mount, or null when off screen

// ---- helpers -------------------------------------------------------------------

const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s) : []);
const count = (n) => (Number.isInteger(n) && n >= 0 ? n : null);

/** 18234 -> "18k", 640 -> "640". */
export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

/** An {ok:false, error} answer -> a note. */
function errorNote(res) {
  const code = res && typeof res.error === 'string' ? res.error : 'failed';
  const detail = code === 'failed' && res && typeof res.detail === 'string' ? res.detail : '';
  return { kind: 'error', key: ERROR_KEYS[code] || ERROR_KEYS.failed, params: {}, detail };
}

/** An agy mirror answer (after a switch or a manual sync) -> the agy status line. */
function agyResultNote(res) {
  if (res && res.ok) {
    const params = {
      name: typeof res.profile === 'string' && res.profile ? res.profile : '-',
      servers: count(res.servers) || 0,
      skills: count(res.skills) || 0,
      skipped: count(res.skipped) || 0,
    };
    return { kind: 'ok', key: 'claudesetup.agy.synced', params, detail: '' };
  }
  const code = res && typeof res.error === 'string' ? res.error : 'failed';
  const detail = res && typeof res.detail === 'string' ? res.detail : '';
  return { kind: 'error', key: AGY_ERROR_KEYS[code] || AGY_ERROR_KEYS.failed, params: {}, detail };
}

/** An ISO time -> the local date and time, or '' when it does not parse. */
function whenText(iso) {
  const d = typeof iso === 'string' ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
}

function setNote(next, { autoHide = false } = {}) {
  clearTimeout(noteTimer);
  note = next;
  if (autoHide) {
    noteTimer = setTimeout(() => {
      note = null;
      renderNote();
    }, NOTE_MS);
  }
}

/** The applied profile, if the list knows it (status first, then the list's flag). */
function activeName() {
  if (!profiles) return null;
  if (active && profiles.some((p) => p.name === active)) return active;
  const flagged = profiles.find((p) => p.active);
  return flagged ? flagged.name : null;
}

function option(value, text) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  return opt;
}

function listItem(text, cls) {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.textContent = text;
  return li;
}

// ---- render --------------------------------------------------------------------

function renderSelect() {
  const { select, refresh } = els;
  const current = activeName();
  select.replaceChildren();
  if (!profiles || !profiles.length) {
    const key = loading ? 'claudesetup.loading' : profiles ? 'claudesetup.none' : 'claudesetup.unavailable';
    select.append(option('', t(key)));
  } else {
    if (!current) select.append(option('', t('claudesetup.unmanaged')));
    for (const p of profiles) select.append(option(p.name, p.name));
  }
  select.value = pending ? pending.name : current || '';
  const blocked = loading || working || !!pending;
  select.disabled = blocked || !profiles || !profiles.length;
  refresh.disabled = blocked;
}

function renderInfo() {
  const { desc, cost, staleLine } = els;
  const current = activeName();
  const profile = current && profiles ? profiles.find((p) => p.name === current) : null;
  let text = '';
  if (profile) text = profile.description;
  else if (profiles && profiles.length) text = t('claudesetup.unmanaged.hint');
  desc.textContent = text;
  desc.hidden = !text;
  const n = formatTokens(tokens);
  cost.textContent = n ? t('claudesetup.cost', { n }) : '';
  cost.hidden = !n;
  staleLine.hidden = !(stale && profiles);
}

function runningText(n) {
  if (n === null) return t('claudesetup.running.unknown');
  if (n === 0) return t('claudesetup.running.none');
  if (n === 1) return t('claudesetup.running.one');
  return t('claudesetup.running', { n });
}

function renderConfirm() {
  const { confirm, confirmTitle, steps, running, apply, cancel } = els;
  if (!pending) {
    confirm.hidden = true;
    return;
  }
  confirm.hidden = false;
  confirmTitle.textContent = t('claudesetup.preview.title', { name: pending.name });
  const items = [
    ...pending.steps.map((s) => listItem(s)),
    ...pending.warnings.map((w) => listItem(w, 'is-warning')),
  ];
  steps.replaceChildren(...(items.length ? items : [listItem(t('claudesetup.preview.empty'))]));
  running.textContent = runningText(pending.running);
  apply.textContent = t(working ? 'claudesetup.applying' : 'claudesetup.apply');
  apply.disabled = working;
  cancel.disabled = working;
}

function renderNote() {
  if (!els) return;
  const { noteLine } = els;
  if (!note) {
    noteLine.hidden = true;
    noteLine.textContent = '';
    return;
  }
  const text = t(note.key, note.params);
  noteLine.textContent = note.detail ? `${text} (${note.detail})` : text;
  noteLine.classList.toggle('is-error', note.kind === 'error');
  noteLine.classList.toggle('is-ok', note.kind === 'ok');
  noteLine.hidden = false;
}

/** The note the agy line shows: this session's last sync first, then the saved state. */
function agyLine() {
  if (agyNote) return agyNote;
  if (!agy) return null;
  if (!agy.available) return { kind: 'info', key: 'claudesetup.agy.missing', params: {}, detail: '' };
  if (agy.lastError) return agyResultNote({ ok: false, ...agy.lastError });
  if (agy.profile) return { kind: 'info', key: 'claudesetup.agy.last', params: { name: agy.profile, when: whenText(agy.mirroredAt) }, detail: '' };
  return { kind: 'info', key: 'claudesetup.agy.never', params: {}, detail: '' };
}

function renderAgy() {
  const { agyToggle, agySync, agyStatus } = els;
  const blocked = !agy || !agy.available || agyBusy || working || !!pending;
  agyToggle.checked = !!(agy && agy.enabled);
  agyToggle.disabled = blocked;
  agySync.disabled = blocked;
  agySync.textContent = t(agyBusy ? 'claudesetup.agy.syncing' : 'claudesetup.agy.sync');
  const line = agyBusy ? { kind: 'info', key: 'claudesetup.agy.syncing', params: {}, detail: '' } : agyLine();
  if (!line) {
    agyStatus.hidden = true;
    agyStatus.textContent = '';
    return;
  }
  const text = t(line.key, line.params);
  agyStatus.textContent = line.detail ? `${text} (${line.detail})` : text;
  agyStatus.classList.toggle('is-error', line.kind === 'error');
  agyStatus.classList.toggle('is-ok', line.kind === 'ok');
  agyStatus.hidden = false;
}

function render() {
  if (!els) return;
  renderSelect();
  renderInfo();
  renderConfirm();
  renderNote();
  renderAgy();
}

// ---- actions -------------------------------------------------------------------

/** Profiles + the applied one. Main fetches first; offline it lists the clone. */
async function load() {
  if (!window.lunacore || loading) return;
  const seq = ++loadSeq;
  loading = true;
  render();
  loadAgy();
  try {
    const list = await window.lunacore.claudeSetupList();
    if (seq !== loadSeq) return;
    if (!list || !list.ok || !Array.isArray(list.profiles)) {
      profiles = null;
      setNote(errorNote(list));
      return;
    }
    profiles = list.profiles.filter((p) => p && typeof p.name === 'string' && p.name);
    stale = list.stale === true;
    const status = await window.lunacore.claudeSetupStatus();
    if (seq !== loadSeq) return;
    if (status && status.ok) {
      active = typeof status.profile === 'string' ? status.profile : null;
      tokens = typeof status.tokens === 'number' ? status.tokens : null;
    } else if (!note || note.kind !== 'ok') {
      // Keep what we knew (e.g. what an apply just reported) rather than
      // blanking it; never bury a fresh "switched" confirmation under this.
      setNote(errorNote(status));
    }
  } catch {
    if (seq === loadSeq) {
      profiles = null;
      setNote(errorNote(null));
    }
  } finally {
    if (seq === loadSeq) {
      loading = false;
      loaded = true;
      render();
      restoreFocus();
    }
  }
}

/** The agy mirror's state (installed, toggle, last sync). Independent of the profile list. */
async function loadAgy() {
  if (!window.lunacore || typeof window.lunacore.claudeSetupAgyStatus !== 'function') return;
  const seq = ++agySeq;
  let res = null;
  try {
    res = await window.lunacore.claudeSetupAgyStatus();
  } catch {
    res = null;
  }
  if (seq !== agySeq) return;
  if (res && res.ok) {
    agy = res;
  } else {
    // Keep what was loaded before; say that this read failed.
    agyNote = agyResultNote(res);
  }
  render();
}

/** "Also apply to Antigravity": saved in main, which answers the new status. */
async function onAgyToggle() {
  if (!els || !agy || agyBusy) return;
  const wanted = els.agyToggle.checked === true;
  agyBusy = true;
  // A status read already in flight predates this toggle: drop its answer.
  agySeq += 1;
  render();
  let res = null;
  try {
    res = await window.lunacore.claudeSetupAgySetEnabled(wanted);
  } catch {
    res = null;
  }
  agyBusy = false;
  if (res && res.ok) {
    agy = res;
    if (agyNote && agyNote.kind === 'error') agyNote = null;
  } else {
    agyNote = agyResultNote(res);
  }
  render();
}

/** "Sync to agy now": mirrors the setup ~/.claude holds right now. */
async function onAgySync() {
  if (!els || !agy || agyBusy || working || pending) return;
  agyBusy = true;
  agyNote = null;
  render();
  let res = null;
  try {
    res = await window.lunacore.claudeSetupAgySync();
  } catch {
    res = null;
  }
  agyBusy = false;
  agyNote = agyResultNote(res);
  render();
  loadAgy();
}

/** Puts focus back on the select once a reload has re-enabled it. */
function restoreFocus() {
  if (!refocus || !els || els.select.disabled) return;
  refocus = false;
  els.select.focus();
}

/** Step 1: the dry run for the picked profile, then the inline confirm. */
async function onPick() {
  if (!els || working || pending || loading) return;
  const name = els.select.value;
  if (!name || name === activeName()) {
    render();
    return;
  }
  working = true;
  setNote({ kind: 'info', key: 'claudesetup.previewing', params: { name } });
  render();
  let res = null;
  try {
    res = await window.lunacore.claudeSetupPreview(name);
  } catch {
    res = null;
  }
  working = false;
  if (!res || !res.ok) {
    setNote(errorNote(res));
    render();
    return;
  }
  pending = { name, steps: strings(res.steps), warnings: strings(res.warnings), running: count(res.running) };
  setNote(null);
  render();
  if (els) els.cancel.focus();
}

/** Cancel: nothing was written; the select goes back to the applied profile. */
function onCancel() {
  if (!pending || working) return;
  pending = null;
  setNote(null);
  render();
  if (els) els.select.focus();
}

/** Step 3: the real switch. Running sessions are left alone. */
async function onApply() {
  if (!pending || working) return;
  const { name } = pending;
  working = true;
  setNote({ kind: 'info', key: 'claudesetup.applying.note', params: {} });
  render();
  let res = null;
  try {
    res = await window.lunacore.claudeSetupApply(name);
  } catch {
    res = null;
  }
  working = false;
  pending = null;
  refocus = true;
  if (!res || !res.ok) {
    setNote(errorNote(res));
    render();
    // A timed-out or failed `use` may have written part of ~/.claude: re-read
    // what is really applied. 'busy' means another switch owns that.
    if (!res || res.error !== 'busy') {
      load();
      emitSetupSwitched();
    } else restoreFocus();
    return;
  }
  emitSetupSwitched();
  active = name;
  if (typeof res.tokens === 'number') tokens = res.tokens;
  // The agy mirror reports separately: its failure never turns the switch into one.
  if (res.agy) agyNote = agyResultNote(res.agy);
  const n = count(res.running);
  const key = n ? 'claudesetup.applied.running' : 'claudesetup.applied';
  setNote({ kind: 'ok', key, params: { name, n: n || 0 } }, { autoHide: true });
  render();
  load();
}

function onRefresh() {
  if (working || pending) return;
  setNote(null);
  // A refresh shows the saved agy state again instead of this session's last sync.
  agyNote = null;
  load();
}

/** Called once from renderer.js after the layout is up. */
export function initClaudeSetup() {
  initialized = true;
  if (els && !loaded) load();
}

defineWidget({
  id: 'setup',
  titleKey: 'claudesetup.title',
  template: 'w-setup',
  mount(root) {
    els = {
      select: root.querySelector('#claude-setup-select'),
      refresh: root.querySelector('#claude-setup-refresh'),
      desc: root.querySelector('#claude-setup-desc'),
      cost: root.querySelector('#claude-setup-cost'),
      staleLine: root.querySelector('#claude-setup-stale'),
      noteLine: root.querySelector('#claude-setup-note'),
      confirm: root.querySelector('#claude-setup-confirm'),
      confirmTitle: root.querySelector('#claude-setup-confirm-title'),
      steps: root.querySelector('#claude-setup-steps'),
      running: root.querySelector('#claude-setup-running'),
      apply: root.querySelector('#claude-setup-apply'),
      cancel: root.querySelector('#claude-setup-cancel'),
      agyToggle: root.querySelector('#claude-setup-agy-toggle'),
      agySync: root.querySelector('#claude-setup-agy-sync'),
      agyStatus: root.querySelector('#claude-setup-agy-status'),
    };
    els.select.addEventListener('change', onPick);
    els.agyToggle.addEventListener('change', onAgyToggle);
    els.agySync.addEventListener('click', onAgySync);
    els.refresh.addEventListener('click', onRefresh);
    els.apply.addEventListener('click', onApply);
    els.cancel.addEventListener('click', onCancel);
    els.confirm.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') onCancel();
    });
    render();
    if (initialized && !loaded) load();

    const offLang = onLangChange(render);
    return () => {
      offLang();
      els = null;
    };
  },
});
