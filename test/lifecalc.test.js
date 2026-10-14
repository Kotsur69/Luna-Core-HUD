// ============================================================================
// LunaCore - Life dashboard amount calculator (renderer/modules/lifecalc.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evalAmount } = require('../src/renderer/modules/lifecalc.js');

test('plain numbers, with a dot or a Polish decimal comma', () => {
  assert.equal(evalAmount('45'), 45);
  assert.equal(evalAmount('45.5'), 45.5);
  assert.equal(evalAmount('45,5'), 45.5);
  assert.equal(evalAmount(' 1 200 '), 1200);
});

test('arithmetic with precedence and parentheses, rounded to grosze', () => {
  assert.equal(evalAmount('45+120.5'), 165.5);
  assert.equal(evalAmount('2*12.99+5'), 30.98);
  assert.equal(evalAmount('(100-20)/3'), 26.67);
  assert.equal(evalAmount('0.1+0.2'), 0.3);
  assert.equal(evalAmount('-5+10'), 5);
});

test('anything that is not arithmetic is rejected, never evaluated', () => {
  for (const bad of ['', 'abc', '1+', '(1', '1)', '2**3', 'alert(1)', '1/0', '1e5', '1..2', '++1', 'x'.repeat(5)]) {
    assert.equal(evalAmount(bad), null, bad);
  }
  assert.equal(evalAmount('1+'.repeat(100) + '1'), null); // over the length cap
});
