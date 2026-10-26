// ============================================================================
// Luna's Work card rules in the run (LW 1.8): the Playtester's acceptance
// checks (lunasworkChecks.js), the card book (lunasworkCards.js) and the
// controller's card flow (lunasworkCardFlow.js) - B1 built -> done, #3 bug
// cards need a test, B4 stuck cards, B5 out-of-scope questions, B9 flaky tests.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Checks = require('../src/lunasworkChecks.js');
const { createCardBook } = require('../src/lunasworkCards.js');
const { createCardFlow, flakyCard } = require('../src/lunasworkCardFlow.js');
const { emptyCurrent } = require('../src/lunasworkRun.js');

const RUN_ID = 'amsteel-1';
const RUN_TAG = 'run:amsteel-1';
const PROJECT = 'proj';
const NOW = Date.UTC(2026, 9, 26);

const evidence = { screenshot: 'shot.png', steps: ['open', 'press save'] };
const cleanEvidence = (raw) => ({
  screenshot: raw && typeof raw.screenshot === 'string' ? raw.screenshot : null,
  steps: raw && Array.isArray(raw.steps) ? raw.steps : [],
});

/** An in-memory to-do store; `list` is replaced on every write. */
function memStore(initial = []) {
  const store = { list: initial };
  store.read = () => store.list;
  store.write = (next) => {
    store.list = next;
    return true;
  };
  return store;
}

const builtCard = (at, over = {}) => ({
  text: `Card ${at}`,
  done: false,
  state: 'built',
  at,
  tags: [RUN_TAG, 'kind:feel', 'sev:medium'],
  acceptance: ['Totals show', 'A test reproduces the bug'],
  ...over,
});

/** A card flow over a memory store and a run record the test can read back. */
function harness({ cards = [], run: over = {}, replay = { ok: true, journeys: [] } } = {}) {
  const store = memStore(cards);
  const logs = [];
  const asked = [];
  let replays = 0;
  let run = {
    id: RUN_ID,
    projectId: PROJECT,
    iteration: 3,
    current: emptyCurrent(),
    decisions: [],
    failCounts: {},
    quarantine: [],
    laps: [],
    ...over,
  };
  const cardBook = createCardBook({ store: () => store, now: () => NOW, log: (l) => logs.push(l) });
  const flow = createCardFlow({
    run: () => run,
    update: (fields) => {
      run = { ...run, ...fields };
    },
    logEvent: (t) => logs.push(t),
    cardBook,
    ask: (spec) => asked.push(spec),
    replayPass: async () => {
      replays += 1;
      return replay;
    },
  });
  return { store, flow, cardBook, logs, asked, run: () => run, replays: () => replays };
}

// ---- checks: the Playtester's trust boundary (B1) -----------------------------------

test('checkList gives the Playtester only the app checks of built cards', () => {
  const list = Checks.checkList([builtCard(1), builtCard(2, { acceptance: ['A test reproduces the bug'] }), null]);
  assert.deepEqual(list, [{ card: 1, text: 'Card 1', checks: ['Totals show'] }]);
  assert.match(Checks.checksPrompt(list).join('\n'), /card 1: Card 1/);
  assert.deepEqual(Checks.checksPrompt([]), []);
});

test('cleanChecks drops unknown cards, bad indexes and passes without evidence', () => {
  const list = [{ card: 1, text: 'Card 1', checks: ['Totals show', 'Date saves'] }];
  const warnings = [];
  const out = Checks.cleanChecks([
    { card: 1, check: 0, passed: true, evidence },
    { card: 1, check: 0, passed: false, evidence },
    { card: 1, check: 1, passed: true, evidence: { screenshot: null, steps: [] } },
    { card: 9, check: 0, passed: true, evidence },
    { card: 1, check: 5, passed: false, evidence },
  ], list, cleanEvidence, warnings);
  assert.deepEqual(out.map((r) => `${r.card}:${r.check}:${r.passed}`), ['1:0:true']);
  assert.equal(warnings.filter((w) => w.code === 'noEvidence').length, 1);
  assert.equal(warnings.filter((w) => w.code === 'badCheck').length, 2);
  assert.deepEqual(Checks.cleanChecks('nope', list, cleanEvidence, []), []);
});

test('cardVerdicts closes, reopens with the evidence, or keeps a card built', () => {
  const cards = [builtCard(1), builtCard(2), builtCard(3)];
  const results = [
    { card: 1, check: 0, passed: true, evidence },
    { card: 2, check: 0, passed: false, evidence },
  ];
  const verdicts = Checks.cardVerdicts(cards, results, 4);
  assert.deepEqual(verdicts.map((v) => v.outcome), ['done', 'reopen', 'built']);
  assert.match(verdicts[1].note, /iteration 4/);
  assert.match(verdicts[1].note, /"Totals show" failed/);
  assert.match(verdicts[1].note, /shot\.png/);
});

// ---- card book ------------------------------------------------------------------------

test('markBuilt, settle and reopen move cards through built (B1)', () => {
  const store = memStore([
    { text: 'a', done: true, doneAt: 1, at: 1, tags: [RUN_TAG] },
    { text: 'b', done: true, doneAt: 1, at: 2, tags: [RUN_TAG] },
    { text: 'c', done: false, at: 3, tags: [RUN_TAG] },
  ]);
  const book = createCardBook({ store: () => store, now: () => NOW, log: () => {} });
  book.markBuilt(PROJECT, [1, 2, 3]);
  assert.deepEqual(store.list.map((c) => c.state || null), ['built', 'built', null]);
  assert.ok(store.list.every((c) => c.done === false && c.doneAt === undefined));
  assert.deepEqual(book.builtCards(PROJECT).map((c) => c.at), [1, 2]);
  book.settle(PROJECT, [{ at: 1, outcome: 'done' }, { at: 2, outcome: 'reopen', note: 'Reopened: x' }]);
  const [one, two] = store.list;
  assert.equal(one.done, true);
  assert.equal(one.doneAt, NOW);
  assert.equal(one.state, undefined);
  assert.equal(two.done, false);
  assert.equal(two.state, undefined);
  assert.match(two.details, /Reopened: x/);
});

test('a card book over a throwing store logs and changes nothing', () => {
  const logs = [];
  const book = createCardBook({ store: () => { throw new Error('disk gone'); }, now: () => NOW, log: (l) => logs.push(l) });
  book.markBuilt(PROJECT, [1]);
  assert.deepEqual(book.builtCards(PROJECT), []);
  assert.deepEqual(book.lookup(PROJECT, [1]), []);
  assert.deepEqual(book.fileCards(PROJECT, RUN_ID, [flakyCard('Save', 2)]), []);
  assert.ok(logs.length >= 3);
  assert.ok(logs.every((l) => /disk gone/.test(l)));
});

// ---- card flow: landed work (B1, #3) ------------------------------------------------

test('landed cards become built; a bug card without a test file stays open with a note', () => {
  const cards = [
    { text: 'Fix the total', done: true, at: 1, tags: [RUN_TAG, 'kind:bug', 'sev:high'] },
    { text: 'Fix the date', done: true, at: 2, tags: [RUN_TAG, 'kind:bug', 'sev:high'] },
    { text: 'Nicer header', done: true, at: 3, tags: [RUN_TAG, 'kind:feel', 'sev:low'] },
  ];
  const h = harness({ cards });
  const settled = {
    plan: {
      packages: [
        { merged: true, todos: ['Fix the total'], touched: ['src/total.js', 'test/total.test.js'] },
        { merged: true, todos: ['Fix the date'], touched: ['src/date.js'] },
        { merged: true, todos: ['Nicer header'], touched: ['src/header.css'] },
      ],
    },
  };
  const res = h.flow.landedToBuilt(settled, cards, [1, 2, 3]);
  assert.deepEqual(res, { built: [1, 3], noTest: [2] });
  const byAt = new Map(h.store.list.map((c) => [c.at, c]));
  assert.equal(byAt.get(1).state, 'built');
  assert.equal(byAt.get(3).state, 'built');
  assert.equal(byAt.get(2).done, false);
  assert.equal(byAt.get(2).state, undefined);
  assert.match(byAt.get(2).details, /did not add or change a test file/);
});

test('iteration 0 scaffold cards stay done: there is no app to check yet', () => {
  const cards = [{ text: 'Scaffold', done: true, at: 1, tags: [RUN_TAG, 'kind:missing'] }];
  const h = harness({ cards, run: { iteration: 0 } });
  assert.deepEqual(h.flow.landedToBuilt({}, cards, [1]), { built: [], noTest: [] });
  assert.equal(h.store.list[0].done, true);
});

// ---- card flow: the Playtester's pass (B1, B4) ----------------------------------------

test('settleBuilt closes confirmed cards and reports which ones failed the iteration', () => {
  const built = [builtCard(1), builtCard(2), builtCard(3)];
  const open = { text: 'Card 4', done: false, at: 4, tags: [RUN_TAG] };
  const h = harness({ cards: [...built, open], run: { current: { ...emptyCurrent(), cards: [{ at: 4 }] } } });
  const report = {
    checks: [
      { card: 1, check: 0, passed: true, evidence },
      { card: 2, check: 0, passed: false, evidence },
    ],
  };
  const verify = h.flow.settleBuilt(built, report);
  assert.deepEqual(verify.closed, [1]);
  assert.deepEqual(verify.reopened, [2]);
  assert.deepEqual(verify.waiting, [3]);
  assert.deepEqual([...verify.failed].sort(), [2, 4]);
  assert.ok(h.logs.some((l) => /1 confirmed in the app, 1 reopened, 1 still built/.test(l)));
});

// ---- card flow: stuck and out-of-scope questions (B4, B5) ----------------------------

test('stuck cards are offered to the Critic and asked about once a decision holds none', () => {
  const cards = [{ text: 'PDF export', done: false, at: 7, tags: [RUN_TAG] }, { text: 'Other', done: false, at: 8, tags: [RUN_TAG] }];
  const h = harness({ cards, run: { failCounts: { 7: 2, 8: 1 } } });
  assert.deepEqual(h.flow.stuckNow(), [7]);
  h.flow.askAboutStuck([7]);
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].kind, 'stuckCard');
  assert.deepEqual(h.asked[0].cardIds, [7]);
  assert.match(h.asked[0].question, /Failed twice: PDF export/);
  assert.ok(h.asked[0].options.includes(h.asked[0].defaultAnswer));
});

test('out-of-scope cards go to the decision queue with what the design lacks', () => {
  const h = harness();
  h.flow.askAboutScope([{ at: 5, text: 'Multiplayer leaderboard', missing: ['multiplayer', 'leaderboard'] }, null, 'x']);
  h.flow.askAboutScope(undefined);
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].kind, 'outOfScope');
  assert.deepEqual(h.asked[0].cardIds, [5]);
  assert.match(h.asked[0].detail, /not in the design: multiplayer, leaderboard/);
});

// ---- card flow: flaky tests (B9) ------------------------------------------------------

test('a journey that fails then passes on replay is quarantined, gets a card and stops counting', async () => {
  const h = harness({
    run: { laps: [{ selfCheck: 'green', journeysPassed: ['Save a quote', 'Open the app'] }] },
    replay: { ok: true, journeys: [{ name: 'Save a quote', passed: true }, { name: 'Open the app', passed: true }] },
  });
  const journeys = [{ name: 'Save a quote', passed: false }, { name: 'Open the app', passed: true }];
  const before = h.flow.coreJourneys(journeys, 1);
  assert.deepEqual(before, { regressed: ['Save a quote'], ok: false, failing: ['Save a quote'] });

  await h.flow.quarantineFlaky(journeys, before.failing);
  const run = h.run();
  assert.equal(run.quarantine.length, 1);
  assert.equal(run.quarantine[0].name, 'Save a quote');
  assert.equal(run.quarantine[0].n, 3);
  assert.ok(Number.isFinite(run.quarantine[0].card));
  const card = h.store.list.find((c) => c.at === run.quarantine[0].card);
  assert.match(card.text, /Flaky test: "Save a quote"/);
  assert.ok(card.tags.includes(RUN_TAG) && card.tags.includes('kind:bug'));

  // The quarantined journey no longer breaks the core journeys: no rollback.
  assert.equal(h.flow.coreJourneys(journeys, 1).ok, true);

  // The replay is kept in the run: a second look does not replay or re-file.
  await h.flow.quarantineFlaky(journeys, before.failing);
  assert.equal(h.replays(), 1);
  assert.equal(h.run().quarantine.length, 1);
});

test('a journey that fails again on replay is a real break: nothing is quarantined', async () => {
  const h = harness({
    run: { laps: [{ selfCheck: 'green', journeysPassed: ['Save a quote'] }] },
    replay: { ok: false, journeys: [{ name: 'Save a quote', passed: false }] },
  });
  const journeys = [{ name: 'Save a quote', passed: false }];
  await h.flow.quarantineFlaky(journeys, ['Save a quote']);
  assert.deepEqual(h.run().quarantine, []);
  assert.equal(h.flow.coreJourneys(journeys, 1).ok, false);
});

test('a broken replay counts as no replay, never as a pass', async () => {
  const h = harness({ replay: null });
  await h.flow.quarantineFlaky([{ name: 'Save a quote', passed: false }], ['Save a quote']);
  assert.deepEqual(h.run().quarantine, []);
  assert.deepEqual(h.run().current.replay, { ok: false, journeys: [] });
});
