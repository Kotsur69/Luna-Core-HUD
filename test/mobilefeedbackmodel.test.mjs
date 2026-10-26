// Phone feedback model (mobile/src/feedbackmodel.js, B17): per-item status on
// the phone, what the phone sent before the PC picked it up, and the unit the
// form writes - which the PC's own reader must accept unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { feedbackUnit, itemsToShow, statusKey, statusTone } from '../mobile/src/feedbackmodel.js';

const require = createRequire(import.meta.url);
const rows = require('../src/cloudrows');
const { feedbackFromTodoPeers } = require('../src/lunasworkFeedback');

const NOW = 1_760_000_000_000;
const RUN = 'lwfb1';

const mirrorOf = (units) =>
  rows.applyRows({ cursor: 0, mirror: {}, pushed: {} }, units.map((x, i) => ({ key: x.k, value: x.v, u: x.u, deleted_at: x.d, rev: i + 1 })), NOW).mirror;

test('the form unit survives the PC reader unchanged', () => {
  const unit = feedbackUnit(RUN, '  the header is too big  ', NOW);
  assert.deepEqual(unit.v, { runId: RUN, text: 'the header is too big' });
  assert.deepEqual(feedbackFromTodoPeers([rows.todoPeer(mirrorOf([unit]))]), [{ id: NOW, runId: RUN, text: 'the header is too big' }]);
  assert.equal(feedbackUnit(RUN, '', NOW), null);
});

test('itemsToShow: the PC items with their status, plus what this phone sent that the PC has not picked up yet', () => {
  const picked = feedbackUnit(RUN, 'picked up', NOW);
  const waiting = feedbackUnit(RUN, 'still on its way', NOW + 1);
  const otherRun = feedbackUnit('lwold', 'old run', NOW + 2);
  const mirror = mirrorOf([picked, waiting, otherRun]);
  const section = { runId: RUN, items: [{ id: NOW, author: 'mati', text: 'picked up', status: 'built', cards: 1 }] };
  assert.deepEqual(itemsToShow(section, mirror).map((i) => [i.text, i.status]), [['picked up', 'built'], ['still on its way', 'sent']]);
  assert.deepEqual(itemsToShow(null, mirror), []);
});

test('every status has a label key and a tone', () => {
  for (const s of ['sent', 'new', 'waiting', 'planned', 'built', 'verified', 'declined', 'noted']) {
    assert.match(statusKey(s), /^feedbackStatus[A-Z]/);
  }
  assert.equal(statusKey('weird'), 'feedbackStatusNew');
  assert.equal(statusTone('verified'), 'tag is-good');
  assert.equal(statusTone('declined'), 'tag is-bad');
  assert.equal(statusTone('waiting'), 'tag is-warn');
});
