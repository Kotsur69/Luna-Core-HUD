// ============================================================================
// Luna's Work built cards confirmed in the app (B1), one check per card: the
// Playtester is given every built card with its acceptance and answers pass /
// fail / notRun per card (src/lunasworkChecks.js); settleBuilt
// (src/lunasworkCardFlow.js) closes, reopens with the evidence, or keeps the
// card built with the reason in the run log. A built card whose acceptance
// names a journey that passed is confirmed from that journey - replayed here
// from a stored report fixture whose `checks` is empty, as the live reports
// were. The older per-check answer shape keeps working
// (test/lunaswork-cardflow.test.js).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Checks = require('../src/lunasworkChecks.js');
const { createCardBook } = require('../src/lunasworkCards.js');
const { createCardFlow, flakyCard } = require('../src/lunasworkCardFlow.js');
const { emptyCurrent, cleanReport } = require('../src/lunasworkRun.js');

const RUN_TAG = 'run:amsteel-1';
const PROJECT = 'proj';
const NOW = Date.UTC(2026, 10, 28);
const FIXTURE = path.join(__dirname, 'fixtures', 'playtest-report-journey-pass.json');

const evidence = { screenshot: 'shot.png', steps: ['open', 'press save'] };
const noEvidence = { screenshot: null, steps: [] };
const cleanEvidence = (raw) => ({
  screenshot: raw && typeof raw.screenshot === 'string' && raw.screenshot ? raw.screenshot : null,
  steps: raw && Array.isArray(raw.steps) ? raw.steps : [],
});

function memStore(initial = []) {
  const store = { list: initial };
  store.read = () => store.list;
  store.write = (next) => {
    store.list = next;
    return true;
  };
  return store;
}

const builtCard = (at, acceptance, over = {}) => ({
  text: `Card ${at}`,
  done: false,
  state: 'built',
  at,
  tags: [RUN_TAG, 'kind:feel', 'sev:medium'],
  acceptance,
  ...over,
});

/** The controller's card flow over a memory store. */
function harness(cards) {
  const store = memStore(cards);
  const logs = [];
  const run = { id: 'amsteel-1', projectId: PROJECT, iteration: 4, current: emptyCurrent(), decisions: [], failCounts: {}, quarantine: [], laps: [] };
  const cardBook = createCardBook({ store: () => store, now: () => NOW, log: (l) => logs.push(l) });
  const flow = createCardFlow({
    run: () => run,
    update: () => {},
    logEvent: (t) => logs.push(t),
    cardBook,
    ask: () => {},
    replayPass: async () => ({ ok: true, journeys: [] }),
  });
  const card = (at) => store.list.find((c) => c.at === at);
  return { flow, logs, card };
}

// ---- prompt and schema ------------------------------------------------------------------

test('every built card is listed with its app acceptance, and one check is asked of each', () => {
  const cards = Array.from({ length: 24 }, (_, i) => builtCard(1000 + i, [`Line A of ${i}`, `Line B of ${i}`, 'A test reproduces the bug']));
  const list = Checks.checkList(cards);
  assert.equal(list.length, 24, 'more than the old 20-card cap');
  const prompt = Checks.checksPrompt(list).join('\n');
  assert.match(prompt, /exactly ONE entry per card below, 24 in all/);
  for (const c of cards) {
    assert.ok(prompt.includes(`card ${c.at}: Card ${c.at}\n  - ${c.acceptance[0]}\n  - ${c.acceptance[1]}`), `card ${c.at} with its acceptance`);
  }
  assert.ok(!prompt.includes('A test reproduces the bug'));
  assert.match(prompt, /result "pass"/);
  assert.match(prompt, /"notRun" = you could not check it \(reason = why\)/);
  const schema = Checks.checksSchema({ type: 'object' });
  assert.deepEqual(schema.items.required, ['card', 'result', 'reason', 'evidence']);
  assert.ok(schema.maxItems >= list.length);
});

// ---- the trust boundary -----------------------------------------------------------------

test('cleanChecks keeps one answer per listed card; a pass without evidence is not run', () => {
  const list = Checks.checkList([builtCard(1, ['a']), builtCard(2, ['b']), builtCard(3, ['c']), builtCard(4, ['d'])]);
  const warnings = [];
  const out = Checks.cleanChecks([
    { card: 1, result: 'pass', reason: '', evidence },
    { card: 1, result: 'fail', reason: 'second answer', evidence },
    { card: '2', result: 'pass', reason: 'trust me', evidence: noEvidence },
    { card: 3, result: 'fail', reason: '', evidence: noEvidence },
    { card: 4, result: 'maybe', reason: 'x', evidence },
    { card: 99, result: 'pass', reason: '', evidence },
    'junk',
  ], list, cleanEvidence, warnings);
  assert.deepEqual(out.map((r) => [r.card, r.result]), [[1, 'pass'], [2, 'notRun'], [3, 'notRun']]);
  assert.match(out[1].reason, /without a screenshot and steps/);
  assert.match(out[2].reason, /without a reason or evidence/);
  assert.equal(warnings.filter((w) => w.code === 'noEvidence').length, 2);
  assert.equal(warnings.filter((w) => w.code === 'badCheck').length, 3);
});

// ---- verdicts ----------------------------------------------------------------------------

test('pass closes, fail reopens with the evidence, notRun keeps the card built with the reason', () => {
  const cards = [builtCard(1, ['Totals show']), builtCard(2, ['Date saves']), builtCard(3, ['Logo shows']), builtCard(4, ['Undo works'])];
  const results = [
    { card: 1, result: 'pass', reason: '', evidence },
    { card: 2, result: 'fail', reason: 'the date reset to today after Save', evidence },
    { card: 3, result: 'notRun', reason: 'the editor crashed first', evidence: noEvidence },
  ];
  const verdicts = Checks.cardVerdicts(cards, results, 4);
  assert.deepEqual(verdicts.map((v) => v.outcome), ['done', 'reopen', 'built', 'built']);
  assert.match(verdicts[1].note, /iteration 4/);
  assert.match(verdicts[1].note, /Failed: the date reset to today after Save\./);
  assert.match(verdicts[1].note, /Screenshot: shot\.png/);
  assert.match(verdicts[1].note, /Steps: open > press save/);
  assert.equal(verdicts[2].reason, 'not run: the editor crashed first');
  assert.equal(verdicts[3].reason, 'the Playtester returned no check for it');
});

test('settleBuilt applies the verdicts to the store and logs why cards stay built', () => {
  const h = harness([builtCard(1, ['Totals show']), builtCard(2, ['Date saves']), builtCard(3, ['Logo shows'])]);
  const report = cleanReport({
    checks: [
      { card: 1, result: 'pass', reason: '', evidence },
      { card: 2, result: 'fail', reason: 'date lost', evidence },
      { card: 3, result: 'notRun', reason: 'no time left', evidence: noEvidence },
    ],
  });
  const verify = h.flow.settleBuilt([1, 2, 3].map(h.card), report);
  assert.deepEqual([verify.closed, verify.reopened, verify.waiting], [[1], [2], [3]]);
  assert.equal(h.card(1).done, true);
  assert.equal(h.card(1).state, undefined);
  assert.equal(h.card(2).done, false);
  assert.match(h.card(2).details, /Failed: date lost/);
  assert.equal(h.card(3).state, 'built');
  assert.ok(h.logs.some((l) => /1 confirmed in the app, 1 reopened, 1 still built/.test(l)));
  assert.ok(h.logs.some((l) => /still built: card 3 \(not run: no time left\)/.test(l)));
});

// ---- confirmed from a journey -----------------------------------------------------------

test('fixture replay: a built card whose acceptance names a passing journey closes from it', () => {
  // As stored on disk and replayed through the run's own report cleaner.
  const report = cleanReport(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
  assert.deepEqual(report.checks, [], 'the Playtester answered no card checks');
  const cards = [
    builtCard(11, ['The "Move through the sandbox" journey completes end to end', 'A test reproduces the bug']),
    // The B9 flaky-test card's own acceptance shape.
    builtCard(12, flakyCard('Slow motion through the button step', 4).acceptance),
    builtCard(13, ['The Wall jump off the shaft wall journey passes']),
    builtCard(14, ['The "Move through the sandbox" journey passes', 'The dash leaves an afterimage']),
    builtCard(15, ['The player moves through the sandbox']),
  ];
  const h = harness(cards);
  const verify = h.flow.settleBuilt(cards.map((c) => h.card(c.at)), report);
  assert.deepEqual(verify.closed.sort(), [11, 12]);
  assert.deepEqual(verify.reopened, [], 'a failed journey never reopens a card on its own');
  assert.deepEqual(verify.waiting.sort(), [13, 14, 15]);
  assert.equal(h.card(11).done, true);
  assert.equal(h.card(12).done, true);
  assert.ok(h.logs.some((l) => /confirmed by a passing journey: card 11 \("Move through the sandbox"\); card 12/.test(l)));
});

test('a journey confirms what the Playtester left unchecked, never over its own fail', () => {
  const journeys = [{ name: 'Make a quote', passed: true, evidence }];
  const card = builtCard(21, ['Totals show', 'The "Make a quote" journey passes']);
  // Legacy per-check answers: check 0 passed, check 1 left out - the journey fills it.
  const legacy = Checks.cardVerdicts([card], [{ card: 21, check: 0, passed: true, evidence }], 5, journeys);
  assert.deepEqual([legacy[0].outcome, legacy[0].via, legacy[0].journeys], ['done', 'journey', ['Make a quote']]);
  // notRun, but every app check names the passing journey: confirmed by it.
  const both = builtCard(22, ['The "Make a quote" journey completes']);
  const fromJourney = Checks.cardVerdicts([both], [{ card: 22, result: 'notRun', reason: 'skipped', evidence: noEvidence }], 5, journeys);
  assert.equal(fromJourney[0].outcome, 'done');
  // An explicit fail wins over a passing journey.
  const failed = Checks.cardVerdicts([both], [{ card: 22, result: 'fail', reason: 'total wrong', evidence }], 5, journeys);
  assert.equal(failed[0].outcome, 'reopen');
  // A journey claimed passed in a report that is not passed (no evidence upstream) confirms nothing.
  const none = Checks.cardVerdicts([both], [], 5, [{ name: 'Make a quote', passed: false }]);
  assert.equal(none[0].outcome, 'built');
});

test('a journey never confirms a line that asks more than its pass, names two journeys or negates it', () => {
  const journeys = [
    { name: 'Login', passed: true, evidence },
    { name: 'Checkout', passed: false, evidence },
    { name: 'Combat round', passed: true, evidence },
  ];
  const verdict = (line) => Checks.cardVerdicts([builtCard(41, [line])], [], 7, journeys)[0];
  for (const line of [
    'The "Login" journey and the "Checkout" journey both pass',
    'The "Combat round" journey must still fail when the player has no weapon',
    'Hit flash shows during the Combat round journey at both widths',
    'The "Combat round" journey does not pass',
    'The "Checkout" journey passes',
    'The "Login" journey passes and the cart keeps its items',
  ]) {
    assert.equal(verdict(line).outcome, 'built', line);
  }
  for (const line of [
    'The "Login" journey passes',
    'The Combat round journey completes end to end at both widths with no console errors',
  ]) {
    assert.equal(verdict(line).outcome, 'done', line);
  }
  // Two entries of one journey, one failed: not a pass.
  const twice = Checks.cardVerdicts([builtCard(42, ['The "Login" journey passes'])], [], 7, [...journeys, { name: 'login', passed: false }]);
  assert.equal(twice[0].outcome, 'built');
});

test('mixed answer shapes for one card: the first shape counts, and any failure wins', () => {
  const list = Checks.checkList([builtCard(51, ['Totals show', 'Date saves'])]);
  const out = Checks.cleanChecks([
    { card: 51, check: 1, passed: false, evidence },
    { card: 51, result: 'pass', reason: '', evidence },
  ], list, cleanEvidence, []);
  assert.deepEqual(out.map((r) => r.check), [1], 'the later per-card pass is dropped');
  // Both shapes in a stored report: the per-check failure still reopens the card.
  const mixed = Checks.cardVerdicts([builtCard(51, ['Totals show', 'Date saves'])], [
    { card: 51, result: 'pass', reason: '', evidence },
    { card: 51, check: 1, passed: false, evidence },
  ], 7);
  assert.equal(mixed[0].outcome, 'reopen');
  assert.match(mixed[0].note, /"Date saves" failed/);
});

test('a card with only code checks still closes; the older per-check answers still settle', () => {
  const verdicts = Checks.cardVerdicts(
    [builtCard(31, ['A test reproduces the bug']), builtCard(32, ['Totals show', 'Date saves'])],
    [{ card: 32, check: 0, passed: true, evidence }, { card: 32, check: 1, passed: false, evidence }],
    6,
  );
  assert.deepEqual(verdicts.map((v) => v.outcome), ['done', 'reopen']);
  assert.match(verdicts[1].note, /"Date saves" failed/);
});
