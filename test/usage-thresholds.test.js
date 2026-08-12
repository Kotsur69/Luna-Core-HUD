// nextUsageAnnounced() - pure decision behind the 50%/80% voice announcements
// (SOUNDS_IMPLEMENTATION_PLAN.md §3). main.js does the actual
// soundManager.play(); this only tests the state machine.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextUsageAnnounced } = require('../src/usage.js');

const FRESH = { at50: false, at80: false };

test('ponizej 50% nic nie odpala i stan sie nie zmienia', () => {
  const { next, fire } = nextUsageAnnounced(30, FRESH);
  assert.equal(fire, null);
  assert.deepEqual(next, FRESH);
});

test('przekroczenie 50% odpala usage50 raz', () => {
  const first = nextUsageAnnounced(55, FRESH);
  assert.equal(first.fire, 'usage50');
  assert.deepEqual(first.next, { at50: true, at80: false });

  // Drugi odczyt na tym samym poziomie - juz nie odpala ponownie.
  const second = nextUsageAnnounced(60, first.next);
  assert.equal(second.fire, null);
  assert.deepEqual(second.next, { at50: true, at80: false });
});

test('przekroczenie 80% odpala usage80, nawet gdy usage50 nigdy nie odpalilo', () => {
  const { next, fire } = nextUsageAnnounced(85, FRESH);
  assert.equal(fire, 'usage80');
  // Crossing 80 covers 50 too - both flags come back true so a later poll
  // can't fire the now-redundant usage50 after usage80 already announced.
  assert.deepEqual(next, { at50: true, at80: true });
});

test('80% wygrywa nad 50%, gdy oba progi przekroczone naraz', () => {
  const { next, fire } = nextUsageAnnounced(90, FRESH);
  assert.equal(fire, 'usage80');
  // Crossing 80 covers 50 too - both flags come back true so a later poll
  // can't fire the now-redundant usage50 after usage80 already announced.
  assert.deepEqual(next, { at50: true, at80: true });
});

test('po usage80 kolejny odczyt >=50% juz nic nie odpala', () => {
  const after80 = nextUsageAnnounced(90, FRESH).next;
  const { next, fire } = nextUsageAnnounced(95, after80);
  assert.equal(fire, null);
  assert.deepEqual(next, after80);
});

test('spadek ponizej 40% re-uzbraja oba progi', () => {
  const announced = { at50: true, at80: true };
  const { next, fire } = nextUsageAnnounced(35, announced);
  assert.equal(fire, null);
  assert.deepEqual(next, FRESH);
});

test('wahanie dokladnie na 50% miedzy odczytami nie re-uzbraja (strefa 40-50)', () => {
  const afterFirst = nextUsageAnnounced(50, FRESH).next; // { at50: true, at80: false }
  const wobble = nextUsageAnnounced(49, afterFirst);
  assert.equal(wobble.fire, null);
  assert.deepEqual(wobble.next, afterFirst); // wciaz uzbrojone - nie spadlo ponizej 40
});

test('nieznany/brakujacy procent nie zmienia stanu i niczego nie odpala', () => {
  const announced = { at50: true, at80: false };
  assert.deepEqual(nextUsageAnnounced(null, announced), { next: announced, fire: null });
  assert.deepEqual(nextUsageAnnounced(undefined, announced), { next: announced, fire: null });
  assert.deepEqual(nextUsageAnnounced('80', announced), { next: announced, fire: null });
});
