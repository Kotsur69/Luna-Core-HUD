// Shared Luna's Work screenshot lightbox (src/renderer/modules/lightbox.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCloseKey, openLightbox } from '../src/renderer/modules/lightbox.js';

test('isCloseKey: Escape closes, other keys do not', () => {
  assert.equal(isCloseKey('Escape'), true);
  assert.equal(isCloseKey('Esc'), true);
  for (const k of ['Enter', ' ', 'a', undefined]) assert.equal(isCloseKey(k), false);
});

test('openLightbox: refuses a src that is not a data:image URL (no DOM touched)', () => {
  for (const src of ['https://x/y.png', 'javascript:1', '', null]) {
    assert.equal(typeof openLightbox({ src }), 'function');
  }
});
