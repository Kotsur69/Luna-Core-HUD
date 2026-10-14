// ============================================================================
// LunaCore - Life dashboard: quick add bar (renderer)
// ----------------------------------------------------------------------------
// Always visible above the tabs: amount (takes arithmetic, "45+120,5") ->
// one click on a category chip -> Enter. Planned envelopes (food, fuel) and
// free categories (snacks, fun) sit in two labelled chip groups, so a Red
// Bull lands in free money and a tank of fuel in its envelope. Every add
// answers with an Undo toast.
// ============================================================================

'use strict';

import { t } from './util.js';
import {
  el, field, input, amountField, money, catName, catColor, today, getState, onState, act, setStatus, toast,
} from './lifeui.js';

let els = null;
let picked = null; // the selected category id, kept across re-renders

function chip(c) {
  const b = el('button', 'life-chip-btn');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.dataset.id = c.id;
  const dot = el('span', 'life-dot');
  dot.style.background = catColor(c.id);
  b.append(dot, document.createTextNode(catName(c)));
  b.addEventListener('click', () => {
    picked = c.id;
    paint();
    els.amount.input.focus();
  });
  return b;
}

function paint() {
  for (const b of els.chips.querySelectorAll('.life-chip-btn')) {
    const on = b.dataset.id === picked;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function group(labelKey, cats) {
  const wrap = el('div', 'life-quick__group');
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', t(labelKey));
  wrap.append(el('span', 'life-quick__group-label', t(labelKey)));
  for (const c of cats) wrap.append(chip(c));
  return wrap;
}

function renderChips(budget) {
  const cats = [...budget.categories];
  if (!cats.some((c) => c.id === 'other')) cats.push({ id: 'other', name: '', kind: 'free', plan: 0 });
  const planned = cats.filter((c) => c.kind === 'planned');
  const free = cats.filter((c) => c.kind !== 'planned');
  if (!cats.some((c) => c.id === picked)) picked = (free[0] || cats[0]).id;
  els.chips.replaceChildren();
  if (planned.length) els.chips.append(group('life.quick.planned', planned));
  els.chips.append(group('life.quick.free', free));
  paint();
}

async function save() {
  const value = els.amount.value();
  if (value === null || value <= 0) {
    setStatus(t('life.err.bad-amount'), true);
    els.amount.input.focus();
    return;
  }
  const data = { date: els.date.value || today(), amount: value, category: picked, note: els.note.value };
  els.go.disabled = true;
  const res = await act('addExpense', data);
  els.go.disabled = false;
  if (!res.ok) return;
  const label = data.note.trim() || catName(getState().budget.categories.find((c) => c.id === picked) || { id: picked });
  setStatus('');
  toast(t('life.quick.added', { amount: money(value), what: label }), res.created ? () => act('deleteExpense', { id: res.created }) : null);
  els.amount.set('');
  els.note.value = '';
  els.date.value = today();
  els.amount.input.focus();
}

function build(root) {
  const form = el('form', 'life-quick');
  const amount = amountField('life.f.amount');
  const note = input({ maxlength: '200', placeholder: t('life.quick.notePh') });
  const date = input({ type: 'date' });
  date.value = today();
  const chips = el('div', 'life-quick__chips');
  const go = el('button', 'pad-send life-quick__go', t('life.quick.add'));
  go.type = 'submit';
  const row = el('div', 'life-quick__row');
  row.append(amount.wrap, field('life.f.note', note, 'life-field--grow'), field('life.f.date', date), go);
  form.append(row, chips);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  // Arrow keys move between chips, like a native radio group.
  chips.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const all = [...chips.querySelectorAll('.life-chip-btn')];
    const i = all.findIndex((b) => b.dataset.id === picked);
    const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    picked = next.dataset.id;
    paint();
    next.focus();
    e.preventDefault();
  });
  root.replaceChildren(form);
  els = { root, amount, note, date, chips, go };
}

export function mountQuick(root) {
  build(root);
  onState((s) => renderChips(s.budget));
  if (getState()) renderChips(getState().budget);
}

/** Language switch: rebuilt, keeping what was typed. */
export function relabelQuick() {
  if (!els) return;
  const kept = { amount: els.amount.input.value, note: els.note.value, date: els.date.value };
  build(els.root);
  els.amount.set(kept.amount);
  els.note.value = kept.note;
  els.date.value = kept.date;
  if (getState()) renderChips(getState().budget);
}

export function focusQuick() {
  if (els) els.amount.input.focus();
}
