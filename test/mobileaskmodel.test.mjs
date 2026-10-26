// Phone "Ask Luna" model (mobile/src/askmodel.js, LW 2.27): the unit the
// phone writes is the one the PC's reader accepts; what the phone shows is
// the PC's answers plus its own questions not picked up yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { askUnit, asksToShow, askStatusKey, askStatusTone, sourceLabels, MAX_QUESTION } from '../mobile/src/askmodel.js';

const require = createRequire(import.meta.url);
const rows = require('../src/cloudrows');
const { asksFromTodoPeers } = require('../src/lunasworkAskModel');

const NOW = 1_760_000_000_000;

const mirrorOf = (units) =>
  rows.applyRows({ cursor: 0, mirror: {}, pushed: {} }, units.map((x, i) => ({ key: x.k, value: x.v, u: x.u, deleted_at: x.d, rev: i + 1 })), NOW).mirror;

test('the phone unit survives the PC reader unchanged; over 500 chars is refused', () => {
  const unit = askUnit('  why did you roll back iteration 14?  ', NOW);
  assert.deepEqual(asksFromTodoPeers([rows.todoPeer(mirrorOf([unit]))]), [{ id: NOW, text: 'why did you roll back iteration 14?' }]);
  assert.equal(MAX_QUESTION, 500);
  assert.equal(askUnit('x'.repeat(501), NOW), null);
  assert.equal(askUnit('   ', NOW), null);
});

test('asksToShow: the PC answers plus this phone\'s questions not picked up yet, newest first', () => {
  const picked = askUnit('picked up', NOW - 10);
  const waiting = askUnit('on its way', NOW - 5);
  const old = askUnit('two days ago', NOW - 2 * 24 * 3600 * 1000);
  const answered = { id: NOW - 10, question: 'picked up', status: 'answered', answer: 'because', sources: [{ file: 'DECISIONS.md', iteration: 3 }], from: 'phone', at: NOW - 10 };
  const godmode = [{ machine: 'pc-1', data: { asks: { v: 1, items: [answered] } } }];
  const shown = asksToShow(godmode, mirrorOf([picked, waiting, old]), NOW);
  assert.equal(shown.machine, 'pc-1');
  assert.deepEqual(shown.items.map((i) => [i.question, i.status]), [['on its way', 'sent'], ['picked up', 'answered']]);
  assert.deepEqual(asksToShow([], {}, NOW), { machine: null, items: [] });
});

test('status labels, tones and source labels', () => {
  assert.equal(askStatusKey('answered'), 'askStatusAnswered');
  assert.equal(askStatusKey('evil'), 'askStatusSent');
  assert.equal(askStatusTone('limited'), 'tag is-warn');
  assert.equal(askStatusTone('failed'), 'tag is-bad');
  assert.deepEqual(sourceLabels([{ file: 'rollbacks', iteration: 14 }, { file: '/etc/passwd' }, { file: 'run-report' }]), [
    { key: 'askSrcRollbacks', iteration: 14 },
    { key: 'askSrcReport', iteration: null },
  ]);
});
