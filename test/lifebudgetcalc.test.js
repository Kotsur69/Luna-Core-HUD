// ============================================================================
// LunaCore - Life dashboard budget math (src/lifebudgetcalc.js +
// lifebudgettrend.js + lifebudgetdates.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { budgetSummary, monthKey, dueDateIn } = require('../src/lifebudgetcalc.js');

// Wednesday 2026-10-14, noon local time.
const NOW = new Date(2026, 9, 14, 12).getTime();

function store(over = {}) {
  return {
    currency: 'PLN',
    income: { amount: 9000, payday: 10 },
    categories: [
      { id: 'food', name: 'Food', kind: 'planned', plan: 1500 },
      { id: 'fuel', name: 'Fuel', kind: 'planned', plan: 1500 },
      { id: 'snacks', name: '', kind: 'free', plan: 0 },
      { id: 'fun', name: '', kind: 'free', plan: 0 },
    ],
    expenses: [],
    bills: [],
    payments: {},
    goals: [],
    deposits: [],
    ...over,
  };
}

const bill = (id, expected, dueDay, over = {}) => ({ id, name: id, expected, dueDay, kind: 'bill', every: 'month', month: 0, category: '', goal: '', ...over });
const exp = (id, date, amount, category, note = '') => ({ id, date, amount, category, note });

test('monthKey and dueDateIn clamp the due day to the month length', () => {
  assert.equal(monthKey(NOW), '2026-10');
  assert.equal(dueDateIn('2026-02', 31), '2026-02-28');
  assert.equal(dueDateIn('2026-10', 5), '2026-10-05');
});

test('the budget period runs payday to payday and counts days', () => {
  const s = budgetSummary(store(), NOW);
  assert.equal(s.month, '2026-10');
  assert.equal(s.period.start, '2026-10-10');
  assert.equal(s.period.end, '2026-11-09');
  assert.equal(s.period.daysLeft, 27); // 14 Oct .. 9 Nov inclusive
  assert.equal(s.period.daysElapsed, 5);
  assert.equal(s.period.isCurrent, true);
});

test('before payday the period is the previous payday to this one', () => {
  const s = budgetSummary(store(), new Date(2026, 9, 3, 12).getTime());
  assert.equal(s.period.start, '2026-09-10');
  assert.equal(s.period.end, '2026-10-09');
});

test('another month can be viewed: past periods are closed', () => {
  const s = budgetSummary(store(), NOW, '2026-08');
  assert.equal(s.period.start, '2026-08-10');
  assert.equal(s.period.isPast, true);
  assert.equal(s.period.daysLeft, 0);
  assert.equal(s.currentMonth, '2026-10');
});

test('planned envelopes are set aside up front: free left counts the unspent plan', () => {
  // Mati's case: 1500 food + 1500 fuel planned, 500 fuel spent. The other
  // 2500 is already gone from free money even though it is not spent yet.
  const s = budgetSummary(
    store({
      bills: [bill('rent', 500, 12), bill('gas', 300, 20)],
      expenses: [exp('e1', '2026-10-11', 500, 'fuel'), exp('e2', '2026-10-12', 15, 'snacks', 'Red Bull')],
    }),
    NOW
  );
  assert.equal(s.fixed.committed, 800);
  assert.equal(s.planned.plan, 3000);
  assert.equal(s.planned.reserved, 3000);
  assert.equal(s.free.spent, 15);
  assert.equal(s.free.plan, 9000 - 800 - 3000);
  assert.equal(s.left, 9000 - 800 - 3000 - 15);
  assert.equal(s.free.perDay, Math.floor(((9000 - 3815) / 27) * 100) / 100);
});

test('an envelope over its plan reserves what was spent and is flagged', () => {
  const s = budgetSummary(store({ expenses: [exp('e1', '2026-10-11', 1800, 'food')] }), NOW);
  const food = s.envelopes.find((e) => e.id === 'food');
  assert.equal(food.status, 'over');
  assert.equal(food.reserved, 1800);
  assert.equal(food.left, -300);
  assert.equal(s.left, 9000 - 1800 - 1500);
});

test('the pace flag waits a week, then projects the period', () => {
  const early = budgetSummary(store({ expenses: [exp('e1', '2026-10-11', 1000, 'food')] }), NOW);
  assert.equal(early.envelopes.find((e) => e.id === 'food').projected, null);
  const later = new Date(2026, 9, 20, 12).getTime(); // day 11 of 31
  const s = budgetSummary(store({ expenses: [exp('e1', '2026-10-11', 1000, 'food')] }), later);
  const food = s.envelopes.find((e) => e.id === 'food');
  assert.equal(food.status, 'pace');
  assert.equal(food.projected, Math.round((1000 / 11) * 31 * 100) / 100);
});

test('usual spend averages the last 3 periods that had any expenses', () => {
  const s = budgetSummary(
    store({
      expenses: [
        exp('a', '2026-09-15', 1200, 'fuel'),
        exp('b', '2026-08-15', 1800, 'fuel'),
        // the 2026-07 period has nothing: not counted
        exp('c', '2026-10-11', 900, 'fuel'),
      ],
    }),
    NOW
  );
  const fuel = s.envelopes.find((e) => e.id === 'fuel');
  assert.equal(fuel.usual, 1500);
  assert.equal(fuel.vsUsual, -40);
});

test('a saving bill leaves free money but counts as saved and grows its pot', () => {
  const s = budgetSummary(
    store({
      goals: [{ id: 'inv', name: 'Investments', target: 0, saved: 2000, by: '' }],
      bills: [bill('rev', 3000, 10, { kind: 'saving', goal: 'inv' })],
      payments: { '2026-09': { rev: { amount: 3000, paidOn: '2026-09-10' } }, '2026-10': { rev: { amount: 3000, paidOn: '2026-10-10' } } },
    }),
    NOW
  );
  assert.equal(s.fixed.committed, 0);
  assert.equal(s.savings.committed, 3000);
  assert.equal(s.left, 9000 - 3000 - 3000);
  const inv = s.goals[0];
  assert.equal(inv.total, 8000); // 2000 start + two paid months
  assert.equal(inv.monthly, 3000);
  assert.equal(inv.pct, null); // open-ended pot
  assert.equal(s.totalSaved, 8000);
});

test('deposits count as saved in their period and toward the goal', () => {
  const s = budgetSummary(
    store({
      goals: [{ id: 'z', name: 'Zanzibar', target: 15000, saved: 10000, by: '2026-12' }],
      deposits: [{ id: 'd1', date: '2026-10-12', goal: 'z', amount: 1000, note: '' }],
    }),
    NOW
  );
  assert.equal(s.savings.deposited, 1000);
  assert.equal(s.left, 9000 - 3000 - 1000);
  const z = s.goals[0];
  assert.equal(z.total, 11000);
  assert.equal(z.monthsLeft, 3);
  assert.equal(z.perMonth, 1333.33);
  assert.equal(z.pct, 73);
});

test('bill rows: status, the actual amount once paid, due day before payday in the next month', () => {
  const s = budgetSummary(
    store({
      bills: [bill('gas', 400, 20), bill('net', 60, 12), bill('phone', 50, 5)],
      payments: { '2026-10': { gas: { amount: 200, paidOn: '2026-10-13' } } },
    }),
    NOW
  );
  const by = Object.fromEntries(s.bills.map((b) => [b.id, b]));
  assert.equal(by.gas.status, 'paid');
  assert.equal(by.gas.diff, -200);
  assert.equal(by.net.status, 'overdue');
  assert.equal(by.phone.dueDate, '2026-11-05');
  assert.equal(s.fixed.committed, 200 + 60 + 50);
  assert.equal(s.fixed.plan, 510);
});

test('yearly subscriptions count only in their month; the list shows monthly and yearly cost', () => {
  const s = budgetSummary(store({ bills: [bill('domain', 120, 15, { kind: 'subscription', every: 'year', month: 3 })] }), NOW);
  assert.equal(s.bills.length, 0);
  assert.deepEqual(s.subscriptions.map((x) => [x.monthly, x.yearly]), [[10, 120]]);
});

test('transactions list expenses, deposits and paid bills, newest first', () => {
  const s = budgetSummary(
    store({
      goals: [{ id: 'z', name: 'Zanzibar', target: 1, saved: 0, by: '' }],
      deposits: [{ id: 'd1', date: '2026-10-13', goal: 'z', amount: 100, note: '' }],
      bills: [bill('gas', 400, 20)],
      payments: { '2026-10': { gas: { amount: 380, paidOn: '2026-10-14' } } },
      expenses: [exp('e1', '2026-10-11', 20, 'snacks'), exp('old', '2026-10-01', 5, 'snacks')],
    }),
    NOW
  );
  assert.deepEqual(
    s.transactions.map((x) => [x.type, x.date, x.amount, x.note]),
    [
      ['bill', '2026-10-14', 380, 'gas'],
      ['deposit', '2026-10-13', 100, 'Zanzibar'],
      ['expense', '2026-10-11', 20, ''],
    ]
  );
});

test('breakdown: % per category for the month (bills and savings included) and the week', () => {
  const s = budgetSummary(
    store({
      bills: [bill('rent', 600, 12)],
      expenses: [exp('a', '2026-10-12', 300, 'fuel'), exp('b', '2026-10-13', 100, 'snacks'), exp('c', '2026-10-06', 50, 'snacks')],
    }),
    NOW
  );
  const m = s.breakdown.month;
  assert.equal(m.total, 1000);
  assert.deepEqual(m.rows.map((r) => [r.id, r.pct]), [['_fixed', 60], ['fuel', 30], ['snacks', 10]]);
  const w = s.breakdown.week;
  assert.equal(w.start, '2026-10-12');
  assert.equal(w.total, 400);
  assert.equal(w.rows.find((r) => r.id === 'snacks').prev, 50);
});

test('trend: one row per period, leading empty periods dropped', () => {
  const s = budgetSummary(
    store({ expenses: [exp('a', '2026-09-12', 300, 'fuel'), exp('b', '2026-10-12', 40, 'fun')], bills: [bill('rent', 600, 12)] }),
    NOW
  );
  assert.deepEqual(s.trend, [
    { month: '2026-09', fixed: 0, savings: 0, planned: 300, free: 0 },
    { month: '2026-10', fixed: 600, savings: 0, planned: 0, free: 40 },
  ]);
});

test('money is rounded to grosze, never float noise', () => {
  const s = budgetSummary(store({ expenses: [exp('a', '2026-10-11', 0.1, 'fun'), exp('b', '2026-10-11', 0.2, 'fun')] }), NOW);
  assert.equal(s.free.spent, 0.3);
});

test("'other' made a planned envelope is counted once, deleted categories included", () => {
  const categories = [...store().categories, { id: 'other', name: '', kind: 'planned', plan: 200 }];
  const s = budgetSummary(store({ categories, expenses: [exp('a', '2026-10-11', 50, 'other'), exp('b', '2026-10-11', 30, 'gone')] }), NOW);
  assert.equal(s.envelopes.find((e) => e.id === 'other').spent, 80);
  assert.equal(s.free.spent, 0);
  assert.ok(!s.free.rows.some((r) => r.id === 'other'));
});

test('payday 31 in a 30-day month: a bill due on the 30th falls inside the period', () => {
  // 2027-04-30 noon: the period started Apr 30 (payday 31, clamped).
  const now = new Date(2027, 3, 30, 12).getTime();
  const s = budgetSummary(store({ income: { amount: 9000, payday: 31 }, bills: [bill('rent', 500, 30), bill('gas', 100, 15)] }), now);
  assert.equal(s.period.start, '2027-04-30');
  const due = Object.fromEntries(s.bills.map((b) => [b.id, b.dueDate]));
  assert.equal(due.rent, '2027-04-30');
  assert.equal(due.gas, '2027-05-15');
});

test('per day never floors a grosz away, and a zero balance is never -0', () => {
  const { floor2, round2 } = require('../src/lifebudgetdates.js');
  assert.equal(floor2(0.29), 0.29);
  assert.ok(Object.is(round2(-0.001), 0));
});
