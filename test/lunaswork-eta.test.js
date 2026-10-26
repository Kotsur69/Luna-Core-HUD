// ============================================================================
// Luna's Work time-to-SHIP inputs (LW 2.22b, src/lunasworkEta.js): open
// cards, epics left in ROADMAP.md, per-iteration inputs and the email line.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const eta = require('../src/lunasworkEta.js');

const ROADMAP = '# Roadmap\n\n## Milestone A\n\n- [x] epic:a1 - One\n- [ ] epic:a2 - Two\n\n## Milestone B\n- [ ] epic:b1 - Three\n';

test('openCardCount: open cards of this run plus open steer cards', () => {
  const cards = [
    { text: 'a', done: false, tags: ['run:lw1'] },
    { text: 'b', done: false, tags: ['run:lw1'], state: 'built' },
    { text: 'c', done: true, tags: ['run:lw1'] },
    { text: 'd', done: false, tags: ['steer'] },
    { text: 'e', done: false, tags: ['run:lw2'] },
    { text: 'f', done: false },
    null,
  ];
  assert.equal(eta.openCardCount(cards, 'lw1'), 3);
  assert.equal(eta.openCardCount(null, 'lw1'), 0);
});

test('roadmapLeft: epics not ticked over every milestone', () => {
  assert.equal(eta.roadmapLeft(ROADMAP), 2);
  assert.equal(eta.roadmapLeft(''), 0);
  assert.equal(eta.roadmapLeft(null), 0);
});

test('shipInputs: closed cards and minutes per lap from the usage ledger', () => {
  const run = {
    laps: [{ n: 1, cardsClosed: ['a', 'b'] }, { n: 2, cardsClosed: [] }, { n: 'x' }],
    usage: { iterations: [{ n: 1, phases: { building: 1_800_000, playtesting: 600_000 } }] },
  };
  assert.deepEqual(eta.shipInputs(run), { closedPerIteration: [2, 0], iterationMinutes: [40, 0] });
});

test('shipEstimate + etaLine: from a run, its cards and its roadmap', () => {
  const run = {
    id: 'lw1',
    laps: [{ n: 1, cardsClosed: ['a', 'b'] }, { n: 2, cardsClosed: ['c', 'd'] }],
    usage: { iterations: [{ n: 1, phases: { building: 3_600_000 } }, { n: 2, phases: { building: 3_600_000 } }] },
  };
  const cards = [{ text: 'x', done: false, tags: ['run:lw1'] }, { text: 'y', done: false, tags: ['run:lw1'] }];
  const est = eta.shipEstimate(run, { cards, roadmapMd: ROADMAP });
  // 2 cards + 2 epics left at 2 per iteration -> 2 iterations of an hour.
  assert.deepEqual(est, { iterations: 2, hours: 2, low: 2, high: 2 });
  assert.equal(eta.etaLine(est), 'about 2 h (2-2 h), ~2 iterations');
  assert.equal(eta.shipEstimate({ id: 'lw1', laps: [] }), null);
  assert.equal(eta.shipEstimate(null), null);
});

test('etaLine: iterations only, open high end, nothing', () => {
  assert.equal(eta.etaLine({ iterations: 1, hours: null, low: null, high: null }), '~1 iteration');
  assert.equal(eta.etaLine({ iterations: 4, hours: 3, low: 2, high: null }), 'about 3 h (2-? h), ~4 iterations');
  assert.equal(eta.etaLine(null), '');
});
