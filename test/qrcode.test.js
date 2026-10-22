'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeQr, maskHit, formatBits, alignmentPositions, Grid } = require('../src/qrcode');

const at = (qr, x, y) => qr.bits[y * qr.size + x] === '1';

test('picks the smallest version and returns a square bit string', () => {
  const small = encodeQr('https://a.app/');
  assert.equal(small.version, 1);
  assert.equal(small.size, 21);
  assert.equal(small.bits.length, 21 * 21);
  assert.match(small.bits, /^[01]+$/);
  const big = encodeQr(`https://luna.vercel.app/${'x'.repeat(150)}`);
  assert.ok(big.version > 5 && big.version <= 10);
  assert.equal(encodeQr('x'.repeat(300)), null, 'too long for version 10');
  assert.equal(encodeQr(''), null);
});

test('finder patterns and timing are in place', () => {
  const qr = encodeQr('https://luna.vercel.app/');
  const n = qr.size;
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(at(qr, ox + i, oy), true);
      assert.equal(at(qr, ox + i, oy + 6), true);
    }
    assert.equal(at(qr, ox + 1, oy + 1), false);
    assert.equal(at(qr, ox + 3, oy + 3), true);
  }
  for (let i = 8; i < n - 8; i++) assert.equal(at(qr, i, 6), i % 2 === 0);
});

test('format bits decode to level M and the chosen mask', () => {
  const qr = encodeQr('https://luna.vercel.app/');
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= (at(qr, 8, i) ? 1 : 0) << i;
  bits |= (at(qr, 8, 7) ? 1 : 0) << 6;
  bits |= (at(qr, 8, 8) ? 1 : 0) << 7;
  bits |= (at(qr, 7, 8) ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) bits |= (at(qr, 14 - i, 8) ? 1 : 0) << i;
  assert.equal(bits, formatBits(qr.mask));
  const data = (bits ^ 0x5412) >>> 10;
  assert.equal(data >>> 3, 0, 'level M');
  assert.equal(data & 7, qr.mask);
});

test('the data region reads back as a byte-mode segment of the input', () => {
  const text = 'https://luna.vercel.app/';
  const qr = encodeQr(text);
  // Rebuild the function-module map for this version, then walk the zig-zag.
  const g = new Grid(qr.version);
  g.drawFunctionPatterns();
  const bitsOut = [];
  g.eachDataModule((x, y) => bitsOut.push(at(qr, x, y) !== maskHit(qr.mask, x, y) ? 1 : 0));
  // Version 2-M is one block, so the 28 data codewords come first, in order.
  assert.equal(qr.version, 2);
  const bitStr = bitsOut.slice(0, 28 * 8).join('');
  assert.equal(bitStr.slice(0, 4), '0100');
  assert.equal(parseInt(bitStr.slice(4, 12), 2), text.length);
  let decoded = '';
  for (let i = 0; i < text.length; i++) decoded += String.fromCharCode(parseInt(bitStr.slice(12 + i * 8, 20 + i * 8), 2));
  assert.equal(decoded, text);
});

test('alignment pattern positions match the spec table', () => {
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(10), [6, 28, 50]);
});
