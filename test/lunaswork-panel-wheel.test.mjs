// Luna's Work HUD panel (src/renderer/modules/lunasworkPanel.js), C11: which
// wheel button shows for a run status, and the summary line it reads as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wheelControls, summaryKey } from '../src/renderer/modules/lunasworkPanel.js';

const run = (extra) => ({ runId: 'lwabc1', active: true, ...extra });

test('wheelControls: hand while the run drives, cancel while the pause waits, hand back while handed', () => {
  assert.deepEqual(wheelControls(run({ wheel: 'running' })), {
    hand: { hidden: false, disabled: false },
    back: { hidden: true, label: 'lw.run.back', hint: 'lw.run.back.hint' },
  });
  const requested = wheelControls(run({ wheel: 'requested' }));
  assert.equal(requested.hand.disabled, true);
  assert.equal(requested.back.hidden, false);
  assert.equal(requested.back.label, 'lw.run.cancelHand');
  const handed = wheelControls(run({ wheel: 'handed' }));
  assert.equal(handed.hand.hidden, true);
  assert.equal(handed.back.label, 'lw.run.back');
  // A stopping run cannot be handed over; no run or an ended one shows neither.
  assert.equal(wheelControls(run({ wheel: 'running', stopRequested: true })).hand.disabled, true);
  for (const s of [null, { active: false, runId: null }, run({ active: false, wheel: 'handed' })]) {
    const c = wheelControls(s);
    assert.equal(c.hand.hidden && c.back.hidden, true, JSON.stringify(s));
  }
  // An older main without the field reads as running.
  assert.equal(wheelControls(run({})).hand.hidden, false);
});

test('summaryKey: stopping wins, then the wheel', () => {
  assert.equal(summaryKey(null), 'lw.run.none');
  assert.equal(summaryKey(run({ active: false })), 'lw.run.ended');
  assert.equal(summaryKey(run({ wheel: 'handed', stopRequested: true })), 'lw.run.stopping');
  assert.equal(summaryKey(run({ wheel: 'handed' })), 'lw.run.handed');
  assert.equal(summaryKey(run({ wheel: 'requested' })), 'lw.run.handRequested');
  assert.equal(summaryKey(run({ wheel: 'running' })), 'lw.run.active');
});
