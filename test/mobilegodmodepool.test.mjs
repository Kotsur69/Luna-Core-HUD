// The phone's per-model line of a pool run (mobile/src/views/godmodepool.js):
// the counts that are not zero, the wall time, the emergency row by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolRowText } from '../mobile/src/views/godmodepool.js';

const EN = {
  godmodePoolPlanned: '{n} planned',
  godmodePoolLanded: '{n} landed',
  godmodePoolStalled: '{n} stalled',
  godmodePoolEscalated: '{n} escalated',
  godmodePoolEmergencyTaken: '{n} taken by emergency Opus',
  godmodePoolLimitMoves: '{n} limit moves',
  godmodePoolWall: '{min} min',
  godmodePoolEmergency: 'Opus (emergency)',
  godmodePoolNone: 'no packages',
};
const tn = (key) => EN[key];
const tfn = (key, p) => EN[key].replace(/\{(\w+)\}/g, (_, k) => String(p[k]));
const row = (extra) => ({ key: 'agy-argon', name: 'Argon (agy)', planned: 0, landed: 0, stalled: 0, escalated: 0, emergency: 0, limitMoves: 0, wallMs: 0, ...extra });

test('a row reads its non-zero counts and wall time', () => {
  assert.equal(
    poolRowText(row({ planned: 3, landed: 1, escalated: 1, emergency: 1, limitMoves: 2, wallMs: 12 * 60_000 }), tfn, tn),
    'Argon (agy): 3 planned · 1 landed · 1 escalated · 1 taken by emergency Opus · 2 limit moves · 12 min',
  );
  assert.equal(poolRowText(row({}), tfn, tn), 'Argon (agy): no packages');
});

test('the emergency row is named by the phone, not by the PC', () => {
  assert.equal(poolRowText(row({ key: 'opus-emergency', name: 'whatever', landed: 2, emergency: 2 }), tfn, tn), 'Opus (emergency): 2 landed · 2 taken by emergency Opus');
});

test('the phone i18n has every key in both languages', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../mobile/src/i18n.js', import.meta.url), 'utf8'));
  for (const key of Object.keys(EN)) assert.equal(src.split(`${key}:`).length - 1, 2, `${key} in pl and en`);
});
