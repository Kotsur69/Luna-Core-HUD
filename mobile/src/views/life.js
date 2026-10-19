// ============================================================================
// LunaCore phone - Life: budget of the current period (plan phase 4b)
// ----------------------------------------------------------------------------
// Free money first, then the main action (add an expense), then envelopes,
// bills, savings and the latest expenses. Numbers come from the desktop's own
// maths (src/lifebudgetcalc.js) over the budget lifemodel.js rebuilds from
// the cloud mirror. Every action is one budget op -> the units it changed;
// the screen re-renders from the mirror the write's pull returns (with the
// phone's queued writes laid over it, phase 4d).
// ============================================================================

import { h, icon, ICONS } from '../dom.js';
import { t, tf, lang } from '../i18n.js';
import { budgetOf, opUnits } from '../lifemodel.js';
import calc from '../../../src/lifebudgetcalc.js';

const { budgetSummary } = calc;
const SCOPE = 'life';
const RECENT = 10;
const BUCKETS = [
  ['fixed', 'bucketFixed'],
  ['savings', 'bucketSavings'],
  ['planned', 'bucketPlanned'],
  ['free', 'bucketFree'],
  ['left', 'bucketLeft'],
];
const BILL_STATUS = { paid: 'billPaid', overdue: 'billOverdue', soon: 'billSoon', due: 'billDue' };
const locale = lang === 'pl' ? 'pl-PL' : 'en-GB';
const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'PLN' });
const fmt = (n) => money.format(n);
const shortDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
const pad = (n) => String(n).padStart(2, '0');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** '1 200,50' -> 1200.5; NaN when it is not a number. */
function parseAmount(raw) {
  const s = String(raw).trim().replace(/ /g, '').replace(',', '.');
  return s ? Number(s) : NaN;
}

/** A category's label: its own name, else the built-in one for its id. */
function catName(categories, catId) {
  const c = categories.find((x) => x.id === catId);
  if (c && c.name) return c.name;
  const key = `cat_${c ? c.id : 'other'}`;
  return t(key) === key ? catId : t(key);
}

// Sizes go through the CSSOM: the CSP (style-src 'self') blocks style attributes.
function sized(el, prop, value) {
  el.style[prop] = value;
  return el;
}

const meter = (pct, bad = false) =>
  h('div', { class: `meter${bad ? ' is-bad' : ''}`, 'aria-hidden': 'true' }, sized(h('span'), 'transform', `scaleX(${Math.max(0, Math.min(100, pct)) / 100})`));

/** An input whose value lives in `get` / `set`, so a re-render never loses what was typed. */
function boundInput(attrs, get, set) {
  const el = h('input', attrs);
  el.value = get();
  el.addEventListener('input', () => set(el.value));
  return el;
}

function hero(s) {
  const parts = BUCKETS.map(([key, label]) => ({ key, label, amount: (s.donut.find((d) => d.key === key) || {}).amount || 0 }));
  const total = parts.reduce((n, p) => n + p.amount, 0);
  let sub = t('lifePerDayPast');
  if (s.left < 0) sub = t('lifeOver');
  else if (s.period.isCurrent) sub = tf('lifePerDay', { amount: fmt(s.free.perDay), days: s.period.daysLeft });
  return h(
    'section',
    { class: 'card hero', 'aria-labelledby': 'life-left' },
    h('h2', { class: 'label', id: 'life-left' }, `${t('lifeLeft')} · ${shortDate(s.period.start)} – ${shortDate(s.period.end)}`),
    h('div', { class: `big num${s.left < 0 ? ' is-bad' : ''}` }, fmt(s.left)),
    h('div', { class: 'sub' }, sub),
    total > 0
      ? h('div', { class: 'bucket-bar', 'aria-hidden': 'true' }, parts.filter((p) => p.amount > 0).map((p) => sized(h('span', { class: `seg seg-${p.key}` }), 'flexGrow', String(p.amount))))
      : null,
    h(
      'ul',
      { class: 'legend' },
      parts.map((p) => h('li', {}, h('span', { class: `dot seg-${p.key}`, 'aria-hidden': 'true' }), h('span', { class: 'grow' }, t(p.label)), h('span', { class: 'num' }, fmt(p.amount)))),
    ),
  );
}

function envelopes(s) {
  if (!s.envelopes.length) return null;
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'life-env' },
    h('h2', { class: 'section-title', id: 'life-env' }, t('envelopes')),
    h(
      'ul',
      { class: 'rows' },
      s.envelopes.map((e) => {
        const flag = { over: t('statusOver'), pace: t('statusPace') }[e.status] || '';
        return h(
          'li',
          { class: 'row-col' },
          h('div', { class: 'row' }, h('span', { class: 'grow' }, catName([e], e.id)), h('span', { class: `num${flag ? ' is-bad' : ''}` }, tf('envelopeOf', { spent: fmt(e.spent), plan: fmt(e.plan) }))),
          meter(e.plan > 0 ? (e.spent / e.plan) * 100 : 0, Boolean(flag)),
          flag ? h('span', { class: 'hint is-bad' }, flag) : null,
        );
      }),
    ),
  );
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: ReturnType<import('../cloud.js').createCloud>, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountLife(main, { cloud, toast }) {
  let mirror = {};
  let busy = false;
  // Kept outside the DOM: a refresh re-renders the screen while Mati types.
  const draft = { amount: '', category: '', note: '', deposit: '' };
  let savingInto = null;
  // Bumped by every pull and write: a result older than the newest request is
  // dropped, so a slow pull never repaints over a write (or feeds it old stamps).
  let seq = 0;

  /** Runs one op; refused input and a failed save are told apart. Offline, the op is queued. */
  async function act(op, data, ok) {
    if (busy) return false;
    let units;
    try {
      units = opUnits(mirror, op, data);
    } catch (err) {
      const msg = { 'not-ready': 'lifeEmpty', 'bad amount': 'badAmount' }[err.message] || 'badInput';
      toast(t(msg), true);
      return false;
    }
    if (!units.length) return true;
    busy = true;
    const mine = ++seq;
    try {
      const s = await cloud.write(SCOPE, units);
      busy = false;
      if (mine === seq) render(s.mirror);
      if (s.queued) toast(t('savedOffline'));
      else if (ok) toast(ok);
      return true;
    } catch {
      toast(t('saveFailed'), true);
      return false;
    } finally {
      busy = false;
    }
  }

  function addForm(budget) {
    const ids = budget.categories.map((c) => c.id);
    const cats = ids.includes('other') ? ids : [...ids, 'other'];
    if (!cats.includes(draft.category)) draft.category = cats[0];
    const amount = boundInput(
      { class: 'field num', id: 'life-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', placeholder: '0,00' },
      () => draft.amount,
      (v) => (draft.amount = v),
    );
    const note = boundInput({ class: 'field', id: 'life-note', type: 'text', maxlength: 200, autocomplete: 'off', enterkeyhint: 'done' }, () => draft.note, (v) => (draft.note = v));
    const category = h('select', { class: 'field', id: 'life-cat' }, cats.map((id) => h('option', { value: id, selected: id === draft.category }, catName(budget.categories, id))));
    category.addEventListener('change', () => (draft.category = category.value));
    const form = h(
      'form',
      { class: 'card stack-sm', 'aria-labelledby': 'life-add' },
      h('h2', { class: 'section-title', id: 'life-add' }, t('lifeAddTitle')),
      h(
        'div',
        { class: 'grid-2' },
        h('div', {}, h('label', { class: 'label', for: 'life-amount' }, t('amount')), amount),
        h('div', {}, h('label', { class: 'label', for: 'life-cat' }, t('category')), category),
      ),
      h('div', {}, h('label', { class: 'label', for: 'life-note' }, t('note')), note),
      h('button', { class: 'btn btn-primary', type: 'submit' }, icon(ICONS.plus), t('addExpense')),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = parseAmount(draft.amount);
      if (!(value > 0)) {
        toast(t('badAmount'), true);
        document.getElementById('life-amount')?.focus();
        return;
      }
      const sent = { ...draft };
      const data = { date: today(), amount: value, category: draft.category, note: draft.note };
      if (!(await act('addExpense', data, tf('expenseAdded', { amount: fmt(value) })))) return;
      // Typed something new while it saved: keep that instead.
      if (draft.amount === sent.amount && draft.note === sent.note) {
        draft.amount = '';
        draft.note = '';
        render(mirror);
      }
    });
    return form;
  }

  function billLine(b) {
    const paid = b.status === 'paid';
    const date = shortDate(paid ? b.paidOn : b.dueDate);
    const button = paid
      ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => act('unpayBill', { id: b.id, month: b.month }) }, t('unpay'))
      : h(
          'button',
          { class: 'btn btn-sm', onclick: () => act('payBill', { id: b.id, month: b.month, amount: b.expected }, tf('paidMsg', { name: b.name, amount: fmt(b.expected) })) },
          icon(ICONS.check),
          t('pay'),
        );
    return h(
      'li',
      { class: `row bill is-${b.status}` },
      h('div', { class: 'grow' }, h('div', {}, b.name), h('div', { class: 'hint status' }, tf(BILL_STATUS[b.status], { date }))),
      h('span', { class: 'num' }, fmt(paid ? b.paid : b.expected)),
      button,
    );
  }

  function bills(s) {
    return h(
      'section',
      { class: 'card', 'aria-labelledby': 'life-bills' },
      h('h2', { class: 'section-title', id: 'life-bills' }, t('bills')),
      s.bills.length ? h('ul', { class: 'rows' }, s.bills.map(billLine)) : h('p', { class: 'hint' }, t('noBills')),
    );
  }

  function depositForm(g) {
    const input = boundInput(
      { class: 'field num', id: 'life-deposit', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': tf('depositAmount', { name: g.name }) },
      () => draft.deposit,
      (v) => (draft.deposit = v),
    );
    const cancel = () => {
      savingInto = null;
      render(mirror);
    };
    const form = h('form', { class: 'add-row' }, input, h('button', { class: 'btn', type: 'submit' }, t('deposit')), h('button', { class: 'btn btn-ghost', type: 'button', onclick: cancel }, t('cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = parseAmount(draft.deposit);
      if (!(value > 0)) {
        toast(t('badAmount'), true);
        return;
      }
      const data = { date: today(), goal: g.id, amount: value, note: '' };
      if (await act('addDeposit', data, tf('depositMsg', { amount: fmt(value), name: g.name }))) {
        savingInto = null;
        draft.deposit = '';
        render(mirror);
      }
    });
    return form;
  }

  function goalLine(g) {
    const open = () => {
      savingInto = g.id;
      draft.deposit = '';
      render(mirror);
      document.getElementById('life-deposit')?.focus();
    };
    const amount = g.target > 0 ? tf('goalOf', { total: fmt(g.total), target: fmt(g.target) }) : fmt(g.total);
    return h(
      'li',
      { class: 'row-col' },
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }, h('div', {}, g.name), h('div', { class: 'hint num' }, amount)),
        g.pct === 100 ? h('span', { class: 'hint is-good' }, t('goalDone')) : null,
        savingInto === g.id ? null : h('button', { class: 'btn btn-sm', onclick: open }, icon(ICONS.plus), t('deposit')),
      ),
      g.target > 0 ? meter(g.pct) : null,
      savingInto === g.id ? depositForm(g) : null,
    );
  }

  function goals(s) {
    return h(
      'section',
      { class: 'card', 'aria-labelledby': 'life-goals' },
      h('h2', { class: 'section-title', id: 'life-goals' }, `${t('goals')} · ${fmt(s.totalSaved)}`),
      s.goals.length ? h('ul', { class: 'rows' }, s.goals.map(goalLine)) : h('p', { class: 'hint' }, t('noGoals')),
    );
  }

  function recent(s, budget) {
    const list = s.transactions.filter((x) => x.type === 'expense').slice(0, RECENT);
    const line = (x) => {
      const cat = catName(budget.categories, x.category);
      const label = x.note || cat;
      const del = () => {
        if (confirm(t('confirmDeleteExpense'))) act('deleteExpense', { id: x.id });
      };
      return h(
        'li',
        { class: 'row' },
        h('div', { class: 'grow' }, h('div', {}, label), h('div', { class: 'hint' }, `${shortDate(x.date)} · ${cat}`)),
        h('span', { class: 'num' }, fmt(x.amount)),
        h('button', { class: 'icon-btn', 'aria-label': `${t('delete')}: ${label}`, onclick: del }, icon(ICONS.trash)),
      );
    };
    return h(
      'section',
      { class: 'card', 'aria-labelledby': 'life-recent' },
      h('h2', { class: 'section-title', id: 'life-recent' }, t('recent')),
      list.length ? h('ul', { class: 'rows' }, list.map(line)) : h('p', { class: 'hint' }, t('noExpenses')),
    );
  }

  function render(next) {
    mirror = next;
    const { budget, ready } = budgetOf(mirror);
    if (!ready) {
      main.replaceChildren(h('p', { class: 'empty' }, t('lifeEmpty')));
      return;
    }
    const s = budgetSummary(budget, Date.now());
    const focused = document.activeElement?.id || '';
    main.replaceChildren(h('div', { class: 'stack' }, hero(s), addForm(budget), envelopes(s), bills(s), goals(s), recent(s, budget)));
    if (focused.startsWith('life-')) document.getElementById(focused)?.focus();
  }

  async function refresh() {
    const mine = ++seq;
    try {
      const s = await cloud.pull(SCOPE);
      if (mine === seq) render(s.mirror);
    } catch {
      toast(t('pullFailed'), true);
    }
  }

  // Cached mirror first (instant, works offline), then the network.
  const first = seq;
  cloud.state(SCOPE).then((s) => seq === first && render(s.mirror), () => {});
  return { refresh };
}
