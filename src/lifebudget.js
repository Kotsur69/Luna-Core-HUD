// ============================================================================
// LunaCore - Life dashboard: budget store (main process)
// ----------------------------------------------------------------------------
// config/life-budget.local.json (gitignored by the *.local.json rule):
//   currency:   'PLN'
//   income:     {amount, payday 1-31}
//   categories: [{id, name, kind 'planned'|'free', plan}]  name '' = a
//               built-in one, localized by id in the renderer. 'planned' =
//               a monthly envelope (food, fuel): its plan is set aside from
//               free money up front. 'free' = quick spending (snacks, fun)
//               that comes straight out of free money. Older files with
//               {limit} migrate: limit > 0 -> planned with plan = limit.
//   expenses:   [{id, date 'YYYY-MM-DD', amount, category, note}]
//   bills:      [{id, name, expected, dueDay 1-31,
//                 kind 'bill'|'subscription'|'saving', every 'month'|'year',
//                 month 1-12 (yearly only, else 0), category, goal}]
//               'saving' = a planned monthly transfer (Revolut Investing):
//               counted out of free money like a bill, but as saved, not
//               spent; `goal` optionally names the pot it grows.
//   payments:   {'YYYY-MM': {billId: {amount, paidOn 'YYYY-MM-DD'}}}  the
//               actual amount paid, editable after the fact (expected 400,
//               paid 200)
//   goals:      [{id, name, target (0 = open-ended pot), saved (starting
//                balance), by 'YYYY-MM' | ''}]
//   deposits:   [{id, date, goal, amount, note}]  one-off "+ Save" entries,
//               kept as rows so a mistaken deposit can be deleted
//
// Same contract as the other config loaders: safe read, validate at the
// boundary, a broken file yields the default store rather than a crash; a
// hand-edited file keeps only its valid rows. Every write goes through
// apply(op, data): a fixed op table, each op validates its whole payload and
// throws on bad input. Row ids are minted here, never taken from the renderer
// on create.
// ============================================================================

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const paths = require('./paths');

const FILE_NAME = 'life-budget.local.json';
const MAX_AMOUNT = 10_000_000;
const MAX_EXPENSES = 5000;
const MAX_BILLS = 100;
const MAX_CATEGORIES = 30;
const MAX_GOALS = 20;
const MAX_PAYMENT_MONTHS = 24;
const MAX_DEPOSITS = 2000;
const MAX_NOTE = 200;
const MAX_NAME = 60;

const ID_RE = /^[a-z0-9-]{1,40}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
// Printable text only: no C0/C1 control characters, no zero-width or bidi
// override characters (they could make a name display as something else).
const TEXT_RE = /^[^\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]*$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
// A payment can be recorded for at most this many months before/after now.
const PAYMENT_WINDOW_MONTHS = 12;
const KINDS = ['bill', 'subscription', 'saving'];
const CAT_KINDS = ['planned', 'free'];
const EVERY = ['month', 'year'];

const DEFAULT_CATEGORIES = [
  ['food', 'planned'],
  ['fuel', 'planned'],
  ['home', 'planned'],
  ['car', 'free'],
  ['trackday', 'free'],
  ['eatout', 'free'],
  ['snacks', 'free'],
  ['fun', 'free'],
  ['health', 'free'],
  ['other', 'free'],
];

const defaultFile = () => paths.local(FILE_NAME);
const round2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const newId = () => crypto.randomBytes(6).toString('hex');

function defaults() {
  return {
    currency: 'PLN',
    income: { amount: 0, payday: 1 },
    categories: DEFAULT_CATEGORIES.map(([id, kind]) => ({ id, name: '', kind, plan: 0 })),
    expenses: [],
    bills: [],
    payments: {},
    goals: [],
    deposits: [],
  };
}

// --- field validators: return the clean value or throw --------------------

function amount(v, { allowZero = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v > MAX_AMOUNT) throw new Error('bad amount');
  // Checked after rounding: 0.004 would otherwise pass "> 0" and store 0.
  const r = round2(v);
  if (allowZero ? r < 0 : r <= 0) throw new Error('bad amount');
  return r;
}

function day(v) {
  if (!Number.isInteger(v) || v < 1 || v > 31) throw new Error('bad day');
  return v;
}

function date(v) {
  const m = typeof v === 'string' && DATE_RE.exec(v);
  if (!m) throw new Error('bad date');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < MIN_YEAR || y > MAX_YEAR) throw new Error('bad date');
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error('bad date');
  return v;
}

function month(v) {
  const m = typeof v === 'string' && MONTH_RE.exec(v);
  if (!m || Number(m[1]) < MIN_YEAR || Number(m[1]) > MAX_YEAR) throw new Error('bad month');
  return v;
}

/** A payment month near now: a renderer cannot evict history with '9999-12'. */
function paymentMonth(v, nowMs) {
  const m = month(v);
  const now = new Date(nowMs);
  const [y, mo] = m.split('-').map(Number);
  const offset = (y - now.getFullYear()) * 12 + (mo - 1 - now.getMonth());
  if (Math.abs(offset) > PAYMENT_WINDOW_MONTHS) throw new Error('bad month');
  return m;
}

function text(v, max, { required = false } = {}) {
  if (typeof v !== 'string' || v.length > max || !TEXT_RE.test(v)) throw new Error('bad text');
  const s = v.trim();
  if (required && !s) throw new Error('bad text');
  return s;
}

function id(v) {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new Error('bad id');
  return v;
}

const oneOf = (v, list) => {
  if (!list.includes(v)) throw new Error('bad value');
  return v;
};

// --- row shapes (shared by load-time normalization and ops) ---------------

function expenseRow(e, rowId) {
  return { id: rowId, date: date(e.date), amount: amount(e.amount), category: id(e.category), note: text(e.note ?? '', MAX_NOTE) };
}

function billRow(b, rowId) {
  const every = oneOf(b.every, EVERY);
  const m = every === 'year' ? b.month : 0;
  if (every === 'year' && !(Number.isInteger(m) && m >= 1 && m <= 12)) throw new Error('bad month');
  return {
    id: rowId,
    name: text(b.name, MAX_NAME, { required: true }),
    expected: amount(b.expected),
    dueDay: day(b.dueDay),
    kind: oneOf(b.kind, KINDS),
    every,
    month: m,
    category: b.category ? id(b.category) : '',
    goal: b.goal ? id(b.goal) : '',
  };
}

function categoryRow(c, rowId) {
  // Migration from the {limit} shape: a limit was a plan in all but name.
  const legacyLimit = c.kind === undefined && c.plan === undefined ? c.limit ?? 0 : null;
  const plan = amount(legacyLimit ?? c.plan ?? 0, { allowZero: true });
  const kind = legacyLimit !== null ? (plan > 0 ? 'planned' : 'free') : oneOf(c.kind, CAT_KINDS);
  return { id: rowId, name: text(c.name ?? '', MAX_NAME), kind, plan };
}

function goalRow(g, rowId) {
  return {
    id: rowId,
    name: text(g.name, MAX_NAME, { required: true }),
    target: amount(g.target ?? 0, { allowZero: true }),
    saved: amount(g.saved ?? 0, { allowZero: true }),
    by: g.by ? month(g.by) : '',
  };
}

function depositRow(d, rowId) {
  return { id: rowId, date: date(d.date), goal: id(d.goal), amount: amount(d.amount), note: text(d.note ?? '', MAX_NOTE) };
}

/** Keeps the rows `shape` accepts; a bad row is dropped, not fatal. */
function cleanRows(list, shape, max) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    try {
      if (!raw || seen.has(raw.id)) continue;
      out.push(shape(raw, id(raw.id)));
      seen.add(raw.id);
    } catch {
      // Invalid row in a hand-edited file: skip it, keep the rest.
    }
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Goals with the amounts of `dropped` payments ({month: {billId: {amount}}})
 * added to their starting `saved`, for payments of saving bills linked to a
 * goal - so a pot's total never shrinks when payment history goes away.
 */
function foldIntoGoals(b, dropped) {
  const goalOf = new Map(b.bills.filter((x) => x.goal).map((x) => [x.id, x.goal]));
  const add = {};
  for (const row of Object.values(dropped)) {
    for (const [billId, p] of Object.entries(row || {})) {
      const g = goalOf.get(billId);
      if (g && p && Number.isFinite(p.amount)) add[g] = (add[g] || 0) + p.amount;
    }
  }
  return b.goals.map((g) => (add[g.id] ? { ...g, saved: round2(g.saved + add[g.id]) } : g));
}

function cleanPayments(raw, billIds) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const months = Object.keys(raw).filter((k) => MONTH_RE.test(k)).sort().slice(-MAX_PAYMENT_MONTHS);
  for (const m of months) {
    const row = {};
    for (const [billId, p] of Object.entries(raw[m] || {})) {
      try {
        if (billIds.has(billId)) row[billId] = { amount: amount(p.amount, { allowZero: true }), paidOn: date(p.paidOn) };
      } catch {
        // Invalid payment: drop it.
      }
    }
    if (Object.keys(row).length) out[m] = row;
  }
  return out;
}

function normalize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
  let income = base.income;
  try {
    income = { amount: amount(raw.income.amount, { allowZero: true }), payday: day(raw.income.payday) };
  } catch {
    // Missing or invalid income: keep the default.
  }
  const categories = Array.isArray(raw.categories) ? cleanRows(raw.categories, categoryRow, MAX_CATEGORIES) : base.categories;
  const bills = cleanRows(raw.bills, billRow, MAX_BILLS);
  const goals = cleanRows(raw.goals, goalRow, MAX_GOALS);
  const goalIds = new Set(goals.map((g) => g.id));
  return {
    currency: 'PLN',
    income,
    categories,
    expenses: cleanRows(raw.expenses, expenseRow, MAX_EXPENSES),
    bills,
    payments: cleanPayments(raw.payments, new Set(bills.map((b) => b.id))),
    goals,
    deposits: cleanRows(raw.deposits, depositRow, MAX_DEPOSITS).filter((d) => goalIds.has(d.goal)),
  };
}

/** For display: never throws, a missing or broken file shows the defaults. */
function loadBudget(file = defaultFile()) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return defaults();
  }
}

const rowCount = (b) => ['categories', 'expenses', 'bills', 'goals', 'deposits'].reduce((n, k) => n + (Array.isArray(b && b[k]) ? b[k].length : 0), 0);

/**
 * For writes: only a MISSING file means "start from the defaults". Any other
 * read or parse failure (antivirus / sync lock, a half-written file) throws,
 * so the write that follows can never replace real data with an empty store.
 * `lossy` = normalizing dropped rows a hand edit broke (the caller backs up).
 */
function loadForWrite(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { budget: defaults(), text: null, lossy: false };
    throw new Error('unreadable');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('unreadable');
  }
  const budget = normalize(raw);
  const lossy = Array.isArray(raw && raw.categories) ? rowCount(raw) !== rowCount(budget) : rowCount(raw) !== rowCount(budget) - budget.categories.length;
  return { budget, text, lossy };
}

/**
 * A file next to the budget, still named *.local.json so the config/ gitignore
 * rule covers it: life-budget.local.json -> life-budget.<tag>.local.json.
 */
function sibling(file, tag) {
  return file.endsWith('.local.json') ? `${file.slice(0, -'.local.json'.length)}.${tag}.local.json` : `${file}.${tag}`;
}

/** Temp file + rename: a crash mid-write never leaves a truncated budget. */
function save(next, file) {
  if (file === defaultFile()) paths.ensureUserDir();
  const tmp = sibling(file, `${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return next;
}

// --- ops --------------------------------------------------------------------

function mustFind(list, rowId) {
  if (!list.some((x) => x.id === rowId)) throw new Error('not found');
}

/** Replaces the row with the same id, or appends a new one under `max`. */
function upsert(list, row, max) {
  if (list.some((x) => x.id === row.id)) return list.map((x) => (x.id === row.id ? row : x));
  if (list.length >= max) throw new Error('too many');
  return [...list, row];
}

/** An existing row's id (must exist) or a freshly minted one. */
function targetId(list, data) {
  if (data.id === undefined) return newId();
  const rowId = id(data.id);
  mustFind(list, rowId);
  return rowId;
}

function knownCategory(b, catId) {
  if (catId !== 'other' && !b.categories.some((c) => c.id === catId)) throw new Error('bad category');
}

function knownGoal(b, goalId) {
  if (goalId && !b.goals.some((g) => g.id === goalId)) throw new Error('not found');
}

const OPS = {
  setIncome: (b, d) => ({ ...b, income: { amount: amount(d.amount, { allowZero: true }), payday: day(d.payday) } }),

  addExpense: (b, d) => {
    const row = expenseRow(d, newId());
    knownCategory(b, row.category);
    // Refuse at the cap rather than silently evicting the oldest history.
    if (b.expenses.length >= MAX_EXPENSES) throw new Error('too many');
    return { ...b, expenses: [...b.expenses, row] };
  },
  updateExpense: (b, d) => {
    mustFind(b.expenses, id(d.id));
    const row = expenseRow(d, d.id);
    knownCategory(b, row.category);
    return { ...b, expenses: b.expenses.map((e) => (e.id === row.id ? row : e)) };
  },
  deleteExpense: (b, d) => {
    mustFind(b.expenses, id(d.id));
    return { ...b, expenses: b.expenses.filter((e) => e.id !== d.id) };
  },

  saveBill: (b, d) => {
    const row = billRow(d, targetId(b.bills, d));
    // Only a saving grows a pot; a bill never carries a stale goal link.
    const clean = row.kind === 'saving' ? row : { ...row, goal: '' };
    knownGoal(b, clean.goal);
    return { ...b, bills: upsert(b.bills, clean, MAX_BILLS) };
  },
  deleteBill: (b, d) => {
    mustFind(b.bills, id(d.id));
    const payments = {};
    const dropped = {};
    for (const [m, row] of Object.entries(b.payments)) {
      const rest = Object.fromEntries(Object.entries(row).filter(([k]) => k !== d.id));
      if (row[d.id]) dropped[m] = { [d.id]: row[d.id] };
      if (Object.keys(rest).length) payments[m] = rest;
    }
    // A deleted saving bill's past payments stay in its pot.
    return { ...b, goals: foldIntoGoals(b, dropped), bills: b.bills.filter((x) => x.id !== d.id), payments };
  },
  payBill: (b, d, nowMs) => {
    mustFind(b.bills, id(d.id));
    const m = paymentMonth(d.month, nowMs);
    const now = new Date(nowMs);
    const paidOn = d.paidOn ? date(d.paidOn) : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const payments = { ...b.payments, [m]: { ...(b.payments[m] || {}), [d.id]: { amount: amount(d.amount, { allowZero: true }), paidOn } } };
    // Months past the history cap are pruned; what they paid into a pot is kept as its starting amount.
    const old = Object.keys(payments).sort().slice(0, -MAX_PAYMENT_MONTHS);
    const dropped = Object.fromEntries(old.map((k) => [k, payments[k]]));
    return { ...b, goals: foldIntoGoals(b, dropped), payments: cleanPayments(payments, new Set(b.bills.map((x) => x.id))) };
  },
  unpayBill: (b, d) => {
    const m = month(d.month);
    const row = Object.fromEntries(Object.entries(b.payments[m] || {}).filter(([k]) => k !== id(d.id)));
    const payments = Object.fromEntries(Object.entries(b.payments).filter(([k]) => k !== m));
    if (Object.keys(row).length) payments[m] = row;
    return { ...b, payments };
  },

  saveCategory: (b, d) => ({ ...b, categories: upsert(b.categories, categoryRow(d, targetId(b.categories, d)), MAX_CATEGORIES) }),
  // Expenses keep the deleted id; the summary counts them under "other".
  deleteCategory: (b, d) => {
    mustFind(b.categories, id(d.id));
    return { ...b, categories: b.categories.filter((c) => c.id !== d.id) };
  },

  saveGoal: (b, d) => ({ ...b, goals: upsert(b.goals, goalRow(d, targetId(b.goals, d)), MAX_GOALS) }),
  // The pot's deposits go with it; savings bills that fed it stay, unlinked.
  deleteGoal: (b, d) => {
    mustFind(b.goals, id(d.id));
    return {
      ...b,
      goals: b.goals.filter((g) => g.id !== d.id),
      deposits: b.deposits.filter((x) => x.goal !== d.id),
      bills: b.bills.map((x) => (x.goal === d.id ? { ...x, goal: '' } : x)),
    };
  },

  addDeposit: (b, d) => {
    const row = depositRow(d, newId());
    mustFind(b.goals, row.goal);
    if (b.deposits.length >= MAX_DEPOSITS) throw new Error('too many');
    return { ...b, deposits: [...b.deposits, row] };
  },
  deleteDeposit: (b, d) => {
    mustFind(b.deposits, id(d.id));
    return { ...b, deposits: b.deposits.filter((x) => x.id !== d.id) };
  },
};

/**
 * Applies one validated change and saves. Throws on a bad op or payload.
 * @returns {object} the new store
 */
function apply(op, data, file = defaultFile(), nowMs = Date.now()) {
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(OPS, op)) throw new Error('bad op');
  if (!data || typeof data !== 'object') throw new Error('bad payload');
  const { budget, text, lossy } = loadForWrite(file);
  const next = OPS[op](budget, data, nowMs);
  // This write would persist rows a hand edit broke: keep the original first.
  if (lossy && text !== null) fs.writeFileSync(sibling(file, 'bak'), text, 'utf8');
  return save(next, file);
}

/**
 * For the sync with other PCs (src/lifesync.js): the whole store as it is on
 * disk. Same rule as apply(): only a missing file counts as empty
 * (`exists: false`); an unreadable one throws, so a sync can never mistake a
 * locked file for "everything was deleted". `suspect` = the file parses but
 * is not what save() writes (a hand edit dropped rows, or `{}`): a sync must
 * not publish that as deletions.
 * @returns {{budget: object, exists: boolean, suspect: boolean, mtimeMs: number}}
 */
function readForSync(file = defaultFile()) {
  const { budget, text, lossy } = loadForWrite(file);
  if (text === null) return { budget, exists: false, suspect: false, mtimeMs: 0 };
  const raw = JSON.parse(text);
  const shaped = Boolean(raw) && typeof raw === 'object' && ['categories', 'expenses', 'bills', 'goals', 'deposits'].every((k) => Array.isArray(raw[k]));
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // Gone between the read and the stat: the read is what counts.
  }
  return { budget, exists: true, suspect: lossy || !shaped, mtimeMs };
}

/** Replaces the whole store (a sync merge), validated like a loaded file. */
function replaceBudget(raw, file = defaultFile()) {
  const { text, lossy } = loadForWrite(file);
  if (lossy && text !== null) fs.writeFileSync(sibling(file, 'bak'), text, 'utf8');
  return save(normalize(raw), file);
}

module.exports = { loadBudget, apply, normalize, readForSync, replaceBudget, OP_NAMES: Object.keys(OPS) };
