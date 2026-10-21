// ============================================================================
// LunaCore - Life dashboard: shared DOM helpers + state (renderer)
// ----------------------------------------------------------------------------
// One budget state for every Life tab: load() and act() go through the
// life:* IPC (src/lifeipc.js) for the viewed month, and every tab re-renders
// from the same answer, so a paid bill moves "free money" on the Overview at
// once. Everything here builds DOM with textContent - budget names and notes
// are user text and never go through innerHTML.
// ============================================================================

'use strict';

import { t } from './util.js';
import { evalAmount } from './lifecalc.js';

const ARM_MS = 3000;
const TOAST_MS = 6000;
const CAT_COLORS = 10;

// --- state --------------------------------------------------------------------

let state = null;
let viewMonth = null; // null = the current period
const listeners = new Set();
let statusEl = null;
let toastEl = null;
let toastTimer = null;

export const getState = () => state;
export const getMonth = () => viewMonth;

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
  const res = await window.lunacore.lifeBudget(viewMonth || undefined).catch(ipcFailed);
  accept(res);
  if (!res.ok) setStatus(errText(res.reason), true);
  return res;
}

/**
 * The current period's budget without touching the shared state - for the
 * background reminder, so it never redraws (and wipes) a form being typed in.
 */
export async function peekBudget() {
  return window.lunacore.lifeBudget(undefined).catch(ipcFailed);
}

/** Views another budget period ('YYYY-MM'); null = back to the current one. */
export function setMonth(month) {
  viewMonth = month && state && month === state.summary.currentMonth ? null : month;
  return loadBudget();
}

/** One change through main; a failure lands in the status line. */
export async function act(op, data) {
  const res = await window.lunacore.lifeBudgetDo(op, data, viewMonth || undefined).catch(ipcFailed);
  accept(res);
  if (!res.ok) setStatus(errText(res.reason), true);
  return res;
}

/** "Add to calendar" for a bill: main creates the recurring event and links it. */
export async function addBillToCalendar(billId, calendarKey) {
  const res = await window.lunacore.lifeBillCalAdd(billId, calendarKey, viewMonth || undefined).catch(ipcFailed);
  accept(res);
  if (!res.ok) setStatus(errText(res.reason), true);
  return res;
}

export function bindStatus(node, toastNode) {
  statusEl = node;
  toastEl = toastNode;
}

export function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', isError);
}

/**
 * A short "Deleted X · Undo" toast. `undo` runs at most once; the toast never
 * takes focus (aria-live on the node), and hides itself after a few seconds.
 */
export function toast(text, undo) {
  if (!toastEl) return;
  clearTimeout(toastTimer);
  const msg = el('span', 'life-toast__text', text);
  toastEl.replaceChildren(msg);
  if (undo) {
    let done = false;
    toastEl.append(
      button(
        'life.undo',
        async () => {
          if (done) return;
          done = true;
          hideToast();
          await undo();
        },
        'life-btn life-toast__undo'
      )
    );
  }
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

export function hideToast() {
  clearTimeout(toastTimer);
  if (toastEl) toastEl.hidden = true;
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

/** Whole zloty for charts and KPI cards: "4 430 zl". */
export function money0(n, currency = 'PLN') {
  return new Intl.NumberFormat(lang(), { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

/** Signed difference, e.g. "-200,00 zl" / "+15,30 zl". */
export function signedMoney(n, currency = 'PLN') {
  return (n > 0 ? '+' : '') + money(n, currency);
}

export const pct = (n) => `${new Intl.NumberFormat(lang(), { maximumFractionDigits: 1 }).format(n)}%`;

/** '2026-10-14' -> "14 paz" in the UI language. */
export function shortDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d));
}

/** 'YYYY-MM' -> "kwi 2027" (or "kwiecien 2027" with style 'long'). */
export function monthLabel(ym, style = 'short') {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat(lang(), { month: style, year: 'numeric' }).format(new Date(y, m - 1, 1));
}

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Change against a previous amount as text + class: "▲ 28%" (warn) /
 * "▼ 12%" (good) / "new". Arrow and words, never colour alone.
 */
export function trend(now, before) {
  if (now === before) return { cls: '', text: t('life.trend.same') };
  if (!before) return { cls: 'is-warn', text: t('life.trend.new') };
  const p = Math.round(((now - before) / before) * 100);
  return now > before ? { cls: 'is-warn', text: `▲ ${p}%` } : { cls: 'is-good', text: `▼ ${-p}%` };
}

// --- categories ---------------------------------------------------------------

/** A category's display name: its own, the built-in one by id, or a bucket. */
export function catName(cat) {
  if (cat && cat.name) return cat.name;
  if (cat && typeof cat.id === 'string' && cat.id.startsWith('_')) return t(`life.bucket.${cat.id.slice(1)}`);
  return t(`life.cat.${cat ? cat.id : 'other'}`);
}

export function catById(id) {
  const cats = state ? state.budget.categories : [];
  return cats.find((c) => c.id === id) || { id, name: '', kind: 'free', plan: 0 };
}

/** Stable colour per category (its place in the list); buckets have their own. */
export function catColor(id) {
  if (id === '_fixed') return 'var(--life-fixed)';
  if (id === '_savings') return 'var(--life-savings)';
  const cats = state ? state.budget.categories : [];
  const i = cats.findIndex((c) => c.id === id);
  return `var(--life-c${(i < 0 ? cats.length : i) % CAT_COLORS})`;
}

/** [id, label] options for an expense category select, 'other' always present. */
export function categoryOptions(budget) {
  const opts = budget.categories.map((c) => [c.id, catName(c)]);
  if (!budget.categories.some((c) => c.id === 'other')) opts.push(['other', t('life.cat.other')]);
  return opts;
}

// --- DOM ----------------------------------------------------------------------

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A titled card: {sec, body}. */
export function bucket(titleKey, cls = '') {
  const sec = el('section', `mc-bucket life-bucket ${cls}`.trim());
  const body = el('div', 'life-bucket__body');
  sec.append(el('h3', 'mc-bucket__title', t(titleKey)), body);
  return { sec, body };
}

export function button(labelKey, onClick, cls = 'life-btn') {
  const b = el('button', cls, t(labelKey));
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** An icon-only button: the label is the tooltip and the accessible name. */
export function iconButton(glyph, labelKey, onClick, cls = '') {
  const b = el('button', `life-icon-btn ${cls}`.trim(), glyph);
  b.type = 'button';
  b.title = t(labelKey);
  b.setAttribute('aria-label', t(labelKey));
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Two clicks for what an undo toast cannot bring back (a category, a bill
 * with its payment history): the first arms it, a second within 3 s runs it.
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
export function bar(fraction, stateCls = '', color = '') {
  const track = el('div', `life-bar ${stateCls}`.trim());
  const fill = el('div', 'life-bar__fill');
  fill.style.setProperty('--p', String(Math.max(0, Math.min(1, fraction))));
  if (color) fill.style.background = color;
  track.append(fill);
  track.setAttribute('aria-hidden', 'true');
  return track;
}
