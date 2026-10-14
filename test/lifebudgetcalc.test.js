// ============================================================================
// LunaCore - Life dashboard budget math (src/lifebudgetcalc.js)
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
    income: { amount: 8000, payday: 10 },
    categories: [
      { id: 'food', name: 'Food', limit: 1500 },
      { id: 'fuel', name: 'Fuel', limit: 0 },
    ],
    expenses: [],
    bills: [],
    payments: {},
    goals: [],
    ...over,
  };
}

const bill = (id, expected, dueDay, over = {}) => ({ id, name: id, expected, dueDay, kind: 'bill', every: 'month', month: 0, category: '', ...over });

test('monthKey and dueDateIn clamp the due day to the month length', () => {
  assert.equal(monthKey(NOW), '2026-10');
  assert.equal(dueDateIn('2026-02', 31), '2026-02-28');
  assert.equal(dueDateIn('2026-10', 5), '2026-10-05');
});

test('the budget month runs payday to payday', () => {
  const s = budgetSummary(store(), NOW);
  assert.equal(s.period.start, '2026-10-10');
  assert.equal(s.period.end, '2026-11-09');
  assert.equal(s.period.daysLeft, 27); // 14 Oct .. 9 Nov inclusive
});

test('before payday the period is the previous payday to this one', () => {
  const s = budgetSummary(store(), new Date(2026, 9, 3, 12).getTime());
  assert.equal(s.period.start, '2026-09-10');
  assert.equal(s.period.end, '2026-10-09');
});

test('left = income - bills (actual once paid, expected while due) - spent', () => {
  const s = budgetSummary(
    store({
      bills: [bill('gas', 400, 20), bill('net', 60, 12)],
      payments: { '2026-10': { gas: { amount: 200, paidOn: '2026-10-13' } } },
      expenses: [
        { id: 'e1', date: '2026-10-11', amount: 100, category: 'food', note: '' },
        { id: 'e2', date: '2026-10-09', amount: 999, category: 'food', note: 'last period' },
      ],
    }),
    NOW
  );
  assert.equal(s.billsTotal, 260); // gas paid 200 + internet still due 60
  assert.equal(s.spent, 100);
  assert.equal(s.left, 7640);
  assert.equal(s.perDay, 282.96); // 7640 / 27, floored to grosze
});

test('bill rows carry status and the difference against the expected amount', () => {
  const s = budgetSummary(
    store({
      bills: [bill('gas', 400, 20), bill('net', 60, 12), bill('tv', 50, 16)],
      payments: { '2026-10': { gas: { amount: 200, paidOn: '2026-10-13' } } },
    }),
    NOW
  );
  const byId = Object.fromEntries(s.bills.map((b) => [b.id, b]));
  assert.equal(byId.gas.status, 'paid');
  assert.equal(byId.gas.paid, 200);
  assert.equal(byId.gas.diff, -200);
  assert.equal(byId.net.status, 'overdue');
  assert.equal(byId.tv.status, 'soon'); // due in 2 days
  assert.equal(byId.tv.dueDate, '2026-10-16');
  assert.equal(byId.tv.month, '2026-10');
});

test('a due day before payday falls in the next calendar month of the period', () => {
  const s = budgetSummary(store({ bills: [bill('rent', 2000, 5)] }), NOW);
  assert.equal(s.bills[0].dueDate, '2026-11-05');
  assert.equal(s.bills[0].month, '2026-11');
  assert.equal(s.bills[0].status, 'due');
});

test('yearly subscriptions count only in their month; the list shows monthly and yearly cost', () => {
  const s = budgetSummary(
    store({
      bills: [
        bill('sp', 24, 15, { kind: 'subscription' }),
        bill('dom', 120, 1, { kind: 'subscription', every: 'year', month: 3 }),
      ],
    }),
    NOW
  );
  assert.equal(s.billsTotal, 24);
  assert.deepEqual(
    s.subscriptions.map((x) => [x.id, x.monthly, x.yearly]),
    [
      ['sp', 24, 288],
      ['dom', 10, 120],
    ]
  );
  assert.equal(s.subscriptionsMonthly, 34);
  assert.deepEqual(s.bills.map((b) => b.id), ['sp']);
});

test('category bars: spent, limit and remaining; no limit means no remaining', () => {
  const s = budgetSummary(
    store({
      expenses: [
        { id: 'e1', date: '2026-10-11', amount: 1200, category: 'food', note: '' },
        { id: 'e2', date: '2026-10-12', amount: 400, category: 'food', note: '' },
        { id: 'e3', date: '2026-10-12', amount: 80, category: 'fuel', note: '' },
      ],
    }),
    NOW
  );
  const food = s.categories.find((c) => c.id === 'food');
  assert.deepEqual([food.spent, food.limit, food.remaining, food.over], [1600, 1500, -100, true]);
  const fuel = s.categories.find((c) => c.id === 'fuel');
  assert.equal(fuel.remaining, null);
  assert.equal(fuel.over, false);
});

test('savings goals: per-month amount to reach the target by its month', () => {
  const s = budgetSummary(store({ goals: [{ id: 'g', name: 'Tires', target: 2000, saved: 500, by: '2027-04' }] }), NOW);
  // Oct 2026 .. Apr 2027 = 7 months including this one.
  assert.equal(s.goals[0].perMonth, 214.29);
  assert.equal(s.goals[0].pct, 25);
  assert.equal(s.goals[0].monthsLeft, 7);
});

test('a goal already reached or past its month asks for nothing per month', () => {
  const s = budgetSummary(
    store({
      goals: [
        { id: 'a', name: 'Done', target: 100, saved: 150, by: '2027-01' },
        { id: 'b', name: 'Late', target: 100, saved: 0, by: '2026-01' },
      ],
    }),
    NOW
  );
  assert.equal(s.goals[0].perMonth, 0);
  assert.equal(s.goals[0].pct, 100);
  assert.equal(s.goals[1].perMonth, 100); // the whole rest, now
});

test('week vs last week per category (Mon-Sun weeks)', () => {
  const s = budgetSummary(
    store({
      expenses: [
        { id: 'a', date: '2026-10-12', amount: 100, category: 'food', note: '' }, // Mon this week
        { id: 'b', date: '2026-10-14', amount: 50, category: 'fuel', note: '' },
        { id: 'c', date: '2026-10-06', amount: 80, category: 'food', note: '' }, // last week
      ],
    }),
    NOW
  );
  const food = s.week.find((w) => w.id === 'food');
  assert.deepEqual([food.thisWeek, food.lastWeek], [100, 80]);
  assert.deepEqual(s.weekTotal, { thisWeek: 150, lastWeek: 80 });
});

test('money is rounded to grosze, never float noise', () => {
  const s = budgetSummary(
    store({
      expenses: [
        { id: 'a', date: '2026-10-11', amount: 0.1, category: 'food', note: '' },
        { id: 'b', date: '2026-10-11', amount: 0.2, category: 'food', note: '' },
      ],
    }),
    NOW
  );
  assert.equal(s.spent, 0.3);
});

test('recent expenses: this period, newest first, capped', () => {
  const expenses = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, date: '2026-10-12', amount: 1, category: 'food', note: '' }));
  expenses.push({ id: 'new', date: '2026-10-14', amount: 5, category: 'fuel', note: '' });
  const s = budgetSummary(store({ expenses }), NOW);
  assert.equal(s.recent.length, 30);
  assert.equal(s.recent[0].id, 'new');
});
