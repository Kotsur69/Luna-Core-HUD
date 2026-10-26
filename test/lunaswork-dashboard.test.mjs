// Luna's Work live dashboard (src/renderer/modules/lunasworkDashboard.js,
// LW 2.17a): the pure helpers behind the charts and the timeline marks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTokens,
  formatUsd,
  tokenRows,
  scoreLines,
  cardLines,
  lighthouseLines,
  timelineMarks,
} from '../src/renderer/modules/lunasworkDashboard.js';

test('formatTokens / formatUsd: short, readable numbers', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(12345), '12k');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(4_100_000), '4.1M');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(1.234), '$1.23');
});

test('tokenRows: roles with usage, biggest first, split by token kind', () => {
  const rows = tokenRows({
    byRole: {
      director: { calls: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 },
      critic: { calls: 1, inputTokens: 100, outputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 0, costUsd: 0.5 },
      reviewer: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    },
  }, (r) => r.toUpperCase());
  assert.deepEqual(rows.map((r) => r.role), ['critic', 'director']);
  assert.equal(rows[0].label, 'CRITIC');
  assert.deepEqual(rows[0].values, { inputTokens: 100, outputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 0 });
  assert.deepEqual(tokenRows(null), []);
});

test('scoreLines / cardLines / lighthouseLines build chart series', () => {
  const scores = scoreLines({ m1: [{ n: 1, score: 40 }, { n: 2, score: 55 }], '': [{ n: 3, score: 10 }] }, 'unnamed');
  assert.deepEqual(scores[0].points, [{ x: 1, y: 40 }, { x: 2, y: 55 }]);
  assert.equal(scores[1].label, 'unnamed');
  const [opened, closed] = cardLines({ series: [{ n: 1, opened: 3, closed: 1 }, { n: 2, opened: 1, closed: 2 }] });
  assert.deepEqual(opened.points, [{ x: 1, y: 3 }, { x: 2, y: 4 }], 'cumulative');
  assert.deepEqual(closed.points, [{ x: 1, y: 1 }, { x: 2, y: 3 }]);
  const lh = lighthouseLines([{ iteration: 1, scores: { performance: 80, seo: null } }, { iteration: 2, scores: { performance: 85 } }]);
  assert.deepEqual(lh.map((s) => s.label), ['performance'], 'unmeasured categories are left out');
  assert.deepEqual(lh[0].points, [{ x: 1, y: 80 }, { x: 2, y: 85 }]);
});

test('timelineMarks: rollback, gate, SHIP and failures; plain continue otherwise', () => {
  assert.deepEqual(timelineMarks({ verdict: 'continue' }), [{ key: 'lw.dash.mark.continue', tone: 'dim' }]);
  const keys = timelineMarks({ verdict: 'ship', shipAgrees: false, rolledBack: true, gate: true, selfCheck: 'red' }).map((m) => m.key);
  assert.deepEqual(keys, ['lw.dash.mark.shipRefused', 'lw.dash.mark.gate', 'lw.dash.mark.rollback', 'lw.dash.mark.red']);
});
