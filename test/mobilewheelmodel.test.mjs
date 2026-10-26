// Phone wheel model (mobile/src/wheelmodel.js, C11): the button for each
// published state, what this phone sent that the PC has not shown yet, and
// the unit a tap writes - which the PC's own reader must accept unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { wheelUnit, wheelView, pendingAction } from '../mobile/src/wheelmodel.js';

const require = createRequire(import.meta.url);
const rows = require('../src/cloudrows');
const { wheelFromTodoPeers } = require('../src/lunasworkWheel');

const NOW = 1_760_000_000_000;
const RUN = 'lwwheel1';

const mirrorOf = (units) =>
  rows.applyRows({ cursor: 0, mirror: {}, pushed: {} }, units.map((x, i) => ({ key: x.k, value: x.v, u: x.u, deleted_at: x.d, rev: i + 1 })), NOW).mirror;

test('the tap unit survives the PC reader unchanged', () => {
  const unit = wheelUnit(RUN, 'hand', NOW);
  assert.deepEqual(wheelFromTodoPeers([rows.todoPeer(mirrorOf([unit]))]), [{ id: NOW, runId: RUN, action: 'hand' }]);
});

test('wheelView: hand while Luna drives, cancel while the pause waits, hand back while handed', () => {
  assert.deepEqual(wheelView('running'), { state: 'wheelRunning', action: 'hand', button: 'wheelHand', hint: 'wheelHandHint' });
  assert.equal(wheelView('requested').action, 'back');
  assert.equal(wheelView('requested').button, 'wheelCancel');
  assert.equal(wheelView('handed').button, 'wheelBack');
  assert.equal(wheelView('nonsense').action, 'hand');
});

test('pendingAction: the newest sent action of this run while the PC still shows the state before it', () => {
  const section = { runId: RUN, wheel: 'running' };
  const mirror = mirrorOf([wheelUnit(RUN, 'back', NOW), wheelUnit(RUN, 'hand', NOW + 1), wheelUnit('lwold', 'back', NOW + 2)]);
  assert.equal(pendingAction(section, mirror), 'hand');
  assert.equal(pendingAction({ runId: RUN, wheel: 'requested' }, mirror), null, 'the PC picked it up');
  assert.equal(pendingAction({ runId: 'lwnew', wheel: 'running' }, mirror), null);
  assert.equal(pendingAction(null, mirror), null);
  assert.equal(pendingAction(section, {}), null);
});
