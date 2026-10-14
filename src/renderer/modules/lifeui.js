// ============================================================================
// LunaCore - Life dashboard: shared DOM helpers + state (renderer)
// ----------------------------------------------------------------------------
// One budget state for the three Money columns (lifemoney / lifebills /
// lifeplan): load() and act() go through the life:* IPC (src/lifeipc.js) and
// every column re-renders from the same answer, so a paid bill moves "left"
// in the Money column at once. Everything here builds DOM with textContent -
// budget names and notes are user text and never go through innerHTML.
// ============================================================================

'use strict';

import { t } from './util.js';
import { evalAmount } from './lifecalc.js';

const ARM_MS = 3000;

// --- state --------------------------------------------------------------------

let state = null;
const listeners = new Set();
let statusEl = null;

export const getState = () => state;

/** Subscribes to every new budget answer; returns the unsubscribe. */
export function onState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function accept(res) {
  if (!res || !res.ok) return;
  state = { summary: res.summary, budget: res.budget };
  for (const fn of listeners) fn(state);
}

const ipcFailed = () => ({ ok: false, reason: 'ipc' });

export async function loadBudget() {
  const res = await window.lunacore.lifeBudget().catch(ipcFailed);
  accept(res);
  if (!res.ok) setStatus(errText(res.reason), true);
  return res;
}

/** One change through main; a failure lands in the status line. */
export async function act(op, data) {
  const res = await window.lunacore.lifeBudgetDo(op, data).catch(ipcFailed);
  accept(res);
  if (!res.ok) setStatus(errText(res.reason), true);
  return res;
}

export function bindStatus(node) {
  statusEl = node;
}

export function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', isError);
}

export function errText(reason) {
  const key = `life.err.${reason}`;
  const text = t(key);
  return text === key ? t('life.err.failed') : text;
}

// --- formatting -------------------------------------------------------------

export const lang = () => (window.i18n && window.i18n.lang) || 'pl';

export function money(n, currency = 'PLN') {
  return new Intl.NumberFormat(lang(), { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
}

/** Signed difference, e.g. "-200,00 zl" / "+15,30 zl". */
export function signedMoney(n, currency = 'PLN') {
  return (n > 0 ? '+' : '') + money(n, currency);
}

/** '2026-10-14' -> "14 paz" in the UI language. */
export function shortDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d));
}

/** 'YYYY-MM' -> "kwi 2027". */
export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat(lang(), { month: 'short', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A category's display name: its own, or the built-in one by id. */
export function catName(cat) {
  if (cat && cat.name) return cat.name;
  return t(`life.cat.${cat ? cat.id : 'other'}`);
}

export function catById(id) {
  const cats = state ? state.budget.categories : [];
  return cats.find((c) => c.id === id) || { id, name: '' };
}

// --- DOM ----------------------------------------------------------------------

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A titled section like the Mission Control buckets: {sec, body}. */
export function bucket(titleKey) {
  const sec = el('section', 'mc-bucket life-bucket');
  const body = el('div', 'life-bucket__body');
  sec.append(el('h3', 'mc-bucket__title', t(titleKey)), body);
  sec.dataset.titleKey = titleKey;
  return { sec, body };
}

/** Re-applies section titles after a language switch. */
export function relabel(root) {
  for (const sec of root.querySelectorAll('[data-title-key]')) {
    sec.querySelector('.mc-bucket__title').textContent = t(sec.dataset.titleKey);
  }
}

export function button(labelKey, onClick, cls = 'life-btn') {
  const b = el('button', cls, t(labelKey));
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * A destructive button that needs two clicks: the first arms it (filled,
 * "Sure?"), a second within 3 s runs `onConfirm`, otherwise it disarms.
 */
export function armedButton(labelKey, onConfirm) {
  let timer = null;
  const b = button(
    labelKey,
    () => {
      if (!b.classList.contains('is-armed')) {
        b.classList.add('is-armed');
        b.textContent = t('life.confirm');
        timer = setTimeout(reset, ARM_MS);
        return;
      }
      reset();
      onConfirm();
    },
    'life-btn mc-danger'
  );
  function reset() {
    clearTimeout(timer);
    b.classList.remove('is-armed');
    b.textContent = t(labelKey);
  }
  return b;
}

/** A visibly labelled control: <label><span>Label</span>control</label>. */
export function field(labelKey, control, cls = '') {
  const wrap = el('label', `life-field ${cls}`.trim());
  wrap.append(el('span', 'life-field__label', t(labelKey)), control);
  return wrap;
}

export function input(attrs = {}) {
  const node = el('input', 'mc-input');
  node.autocomplete = 'off';
  node.spellcheck = false;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function select(options, value) {
  const node = el('select', 'mc-input');
  for (const [v, label] of options) {
    const o = el('option', '', label);
    o.value = v;
    node.append(o);
  }
  if (value !== undefined) node.value = value;
  return node;
}

/**
 * Amount input that takes arithmetic ("45+120,5"). The live preview under it
 * shows the result, or that the text is not a sum. value() -> number | null.
 */
export function amountField(labelKey, initial) {
  const inp = input({ inputmode: 'decimal', maxlength: '80' });
  const preview = el('span', 'life-field__preview');
  preview.setAttribute('aria-live', 'polite');
  const wrap = field(labelKey, inp, 'life-field--amount');
  wrap.append(preview);
  const update = () => {
    const raw = inp.value.trim();
    const v = evalAmount(raw);
    preview.classList.toggle('is-bad', raw !== '' && v === null);
    if (raw === '') preview.textContent = '';
    else if (v === null) preview.textContent = t('life.calc.bad');
    else preview.textContent = /[+*/()]|\d-/.test(raw) ? `= ${money(v)}` : '';
  };
  const set = (v) => {
    inp.value = v === null || v === undefined ? '' : String(v);
    update();
  };
  inp.addEventListener('input', update);
  set(initial);
  return { wrap, input: inp, value: () => evalAmount(inp.value), set };
}

/** A 0..1 progress bar (transform-only, no layout writes). */
export function bar(fraction, stateCls = '') {
  const track = el('div', `life-bar ${stateCls}`.trim());
  const fill = el('div', 'life-bar__fill');
  fill.style.setProperty('--p', String(Math.max(0, Math.min(1, fraction))));
  track.append(fill);
  track.setAttribute('aria-hidden', 'true');
  return track;
}
