// ============================================================================
// LunaCore - God Mode "Workers" pool picker (plan screen + Approve)
// ----------------------------------------------------------------------------
// A checkbox dropdown: Opus, Sonnet, Opus / Argon / Hydrogen on agy (one entry
// per family, its live variants in the tooltip) and Mati's free profiles,
// listed live by main (window.lunacore.orchestraPoolOptions, src/orchestraPool.js).
// An agy family the live `agy models` list lacks, and an easy-tasks free
// profile (never writes code), are disabled with a hint. Ticking a second
// free profile replaces the first (one per run).
//
// The pool on screen is the ui pref orchestraModelPool, shared by both
// screens; a change saves it right away (main validates it again). Nothing
// ticked = the single Settings worker model, exactly as before the pool.
// Rules live in src/workerPool.js; text goes in via textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { POOL_MODEL_LIST, poolFromPrefs, togglePoolModel, cleanPoolOptions, poolLabel, freeProfileIdOf } from '../../workerPool.js';

/** The pool on screen (= the saved pref), or null before it was read. */
let pool = null;
/** Main's live menu, or null before the first read. */
let options = null;
/** The read in flight, shared by every caller. */
let reading = null;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Reads the saved pool; an unreadable pref keeps the pool already on screen. */
export async function loadPool() {
  refreshPoolOptions();
  const before = pool;
  try {
    const prefs = await window.lunacore.getUiPrefs();
    // A tick made while the read was in flight wins (it is saved already).
    if (pool === before) pool = poolFromPrefs(prefs);
  } catch (err) {
    console.warn('[orchestraPool] reading the Workers pool pref failed:', err);
  }
}

/** A copy of the pool on screen (Opus before the pref was read). */
export const chosenPool = () => (pool || poolFromPrefs(null)).map((e) => ({ ...e }));

/**
 * Asks main for the live menu again (one read at a time). A failed read
 * keeps the last menu; agy rows wait for the first one.
 * @returns {Promise<object|null>}
 */
export function refreshPoolOptions() {
  if (reading) return reading;
  reading = (async () => {
    try {
      options = cleanPoolOptions(await window.lunacore.orchestraPoolOptions());
    } catch (err) {
      console.warn('[orchestraPool] reading the Workers pool menu failed:', err);
    } finally {
      reading = null;
    }
    return options;
  })();
  return reading;
}

/** A free entry's profile name from the live menu, else null. */
function freeName(model) {
  const hit = options && options.free.find((f) => f.model === model);
  return hit ? hit.name : null;
}

/** The pool's text: 'Opus + Argon (agy) + Free: FreeLLMAPI - coding'. */
export function poolText(list) {
  return poolLabel(list, (model) => (freeProfileIdOf(model) ? t('orch.pool.free', { name: freeName(model) || freeProfileIdOf(model) }) : null));
}

/**
 * The agy families of the live menu: [{model, available}] in menu order
 * ('agy-opus' / 'agy-argon' / 'agy-hydrogen'); [] before the first read.
 */
export function agyFamilyOptions() {
  return options ? options.models.filter((m) => m.model.startsWith('agy-')).map((m) => ({ model: m.model, available: m.available })) : [];
}

/** The 'agy:<id>' a one-model agy pool runs on (main's pick), else null. */
export function agyDefaultVariant(model) {
  const hit = options && options.models.find((m) => m.model === model);
  return hit ? hit.defaultVariant : null;
}

/** The row specs of the menu, in menu order. */
function menuRows(current) {
  const ticked = (model) => current.some((e) => e.model === model);
  const rows = POOL_MODEL_LIST.map((m) => {
    if (m.runsOn !== 'agy') return { model: m.id, name: m.name, checked: ticked(m.id), disabled: false, hint: null, title: '' };
    const opt = options ? options.models.find((o) => o.model === m.id) : null;
    const available = !!(opt && opt.available);
    const hint = !options ? t('orch.pool.agyReading') : available ? null : t('orch.pool.agyMissing');
    const title = opt && opt.variants.length ? t('orch.pool.variants', { list: opt.variants.map((v) => v.name).join(', ') }) : '';
    // A ticked family that left the list stays untickable, so it can be removed.
    return { model: m.id, name: m.name, checked: ticked(m.id), disabled: !available && !ticked(m.id), hint, title };
  });
  const listed = options ? options.free : [];
  for (const f of listed) {
    rows.push({
      model: f.model,
      name: t('orch.pool.free', { name: f.name }),
      checked: ticked(f.model),
      disabled: !f.coding && !ticked(f.model),
      hint: f.coding ? null : t('orch.pool.freeEasy'),
      title: t('orch.pool.freeOne'),
    });
  }
  // A ticked free profile the menu no longer lists (removed in Settings).
  for (const e of current) {
    if (!freeProfileIdOf(e.model) || listed.some((f) => f.model === e.model)) continue;
    rows.push({ model: e.model, name: t('orch.pool.free', { name: freeProfileIdOf(e.model) }), checked: true, disabled: false, hint: t('orch.pool.freeMissing'), title: '' });
  }
  return rows;
}

function rowEl(spec, onToggle) {
  const label = el('label', `orchestra__pool-row${spec.disabled ? ' is-off' : ''}`);
  const box = el('input');
  box.type = 'checkbox';
  box.checked = spec.checked;
  box.disabled = spec.disabled;
  box.dataset.model = spec.model;
  box.addEventListener('change', () => onToggle(spec.model, box.checked));
  label.append(box, el('span', '', spec.name));
  if (spec.hint) label.append(el('span', 'orchestra__pool-hint', spec.hint));
  if (spec.title) label.title = spec.title;
  return label;
}

/** Saves the pool (fire-and-forget: a failed write keeps the choice on screen). */
function savePool(next) {
  try {
    Promise.resolve(window.lunacore.setUiPrefs({ orchestraModelPool: next.length ? next : null })).catch((err) => {
      console.warn('[orchestraPool] saving the Workers pool failed:', err);
    });
  } catch (err) {
    console.warn('[orchestraPool] saving the Workers pool failed:', err);
  }
}

/** Closes an open pool dropdown on a click outside it (registered once). */
let outsideBound = false;
function bindOutsideClose() {
  if (outsideBound) return;
  outsideBound = true;
  document.addEventListener('click', (ev) => {
    for (const d of document.querySelectorAll('details.orchestra__pool[open]')) {
      if (!d.contains(ev.target)) d.open = false;
    }
  });
}

/**
 * The dropdown.
 * @param {{disabled?:boolean, locked?:boolean, fallbackLabel?:string, onChange?:() => void}} opts
 *   locked: the Workers mode picks its own workers (Free only, Antigravity);
 *   fallbackLabel: the Settings model's name, shown when nothing is ticked
 * @returns {HTMLElement}
 */
export function poolPickerView({ disabled = false, locked = false, fallbackLabel = '', onChange = () => {} } = {}) {
  bindOutsideClose();
  const off = disabled || locked;
  const box = el('details', 'orchestra__pool');
  box.title = t(locked ? 'orch.pool.locked' : 'orch.pool.hint');
  if (off) box.setAttribute('aria-disabled', 'true');
  const current = () => chosenPool();
  const summaryText = () => (current().length ? poolText(current()) : t('orch.pool.settings', { model: fallbackLabel }));
  const summary = el('summary', 'profile-select orchestra__pool-summary', summaryText());
  const list = el('div', 'orchestra__pool-list');
  box.append(summary, list);
  // The board (badges, run line) follows once the menu closes: repainting it
  // on every tick would rebuild - and so close - this dropdown.
  let changed = false;
  const toggle = (model, on) => {
    pool = togglePoolModel(current(), model, on);
    savePool(pool);
    summary.textContent = summaryText();
    paint();
    // Keyboard focus stays on the row just toggled.
    const again = [...list.querySelectorAll('input[type="checkbox"]')].find((b) => b.dataset.model === model);
    if (again) again.focus();
    changed = true;
  };
  const paint = () => list.replaceChildren(...menuRows(current()).map((spec) => rowEl(spec, toggle)));
  summary.addEventListener('click', (ev) => {
    if (off) ev.preventDefault();
  });
  box.addEventListener('toggle', () => {
    if (!box.open) {
      if (changed) {
        changed = false;
        onChange();
      }
      return;
    }
    paint();
    // The menu opens: main reads `agy models` and the profiles again.
    refreshPoolOptions().then(() => {
      if (box.isConnected && box.open) {
        summary.textContent = summaryText();
        paint();
      }
    });
  });
  return box;
}
