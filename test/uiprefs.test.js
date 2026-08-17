// clampTermPrefs() - the pure validator behind the Terminal Appearance
// Customizer (TERMINAL_CUSTOMIZER_PLAN.md). readUiPrefs()/writeUiPrefs()
// themselves are thin fs wrappers (same category as soundManager.js/tts.js)
// and are not covered here - only the pure sanitize-a-raw-object boundary is.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { clampTermPrefs } = require('../src/uiprefs.js');

const DEFAULTS = {
  termFontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
  termFontSize: 14,
  termLineHeight: 1.0,
  termLetterSpacing: 0,
  termCursorStyle: 'block',
  termCursorBlink: true,
  termScrollback: 5000,
  termBgOpacity: 100,
  termBgBlur: 0,
  termBgImage: null,
};

test('a missing/bad input object -> pure DEFAULTS', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    assert.deepEqual(clampTermPrefs(bad), DEFAULTS);
  }
});

test('an empty object -> pure DEFAULTS (every field independent)', () => {
  assert.deepEqual(clampTermPrefs({}), DEFAULTS);
});

test('valid values pass through unchanged', () => {
  const raw = {
    termFontFamily: 'JetBrains Mono, monospace',
    termFontSize: 18,
    termLineHeight: 1.4,
    termLetterSpacing: 2,
    termCursorStyle: 'underline',
    termCursorBlink: false,
    termScrollback: 10000,
    termBgOpacity: 80,
    termBgBlur: 6,
    termBgImage: 'data:image/png;base64,AAAA',
  };
  assert.deepEqual(clampTermPrefs(raw), raw);
});

test('termFontSize: clamps to 8-32, rounds', () => {
  assert.equal(clampTermPrefs({ termFontSize: 4 }).termFontSize, 8);
  assert.equal(clampTermPrefs({ termFontSize: 999 }).termFontSize, 32);
  assert.equal(clampTermPrefs({ termFontSize: 20.6 }).termFontSize, 21);
  assert.equal(clampTermPrefs({ termFontSize: 'nan' }).termFontSize, DEFAULTS.termFontSize);
});

test('termLineHeight: clamps to 0.8-3, no rounding', () => {
  assert.equal(clampTermPrefs({ termLineHeight: 0.1 }).termLineHeight, 0.8);
  assert.equal(clampTermPrefs({ termLineHeight: 9 }).termLineHeight, 3);
  assert.equal(clampTermPrefs({ termLineHeight: 1.25 }).termLineHeight, 1.25);
});

test('termLetterSpacing: clamps to -5..20', () => {
  assert.equal(clampTermPrefs({ termLetterSpacing: -100 }).termLetterSpacing, -5);
  assert.equal(clampTermPrefs({ termLetterSpacing: 100 }).termLetterSpacing, 20);
});

test('termScrollback: clamps negatives to 0, rejects non-numbers, rounds', () => {
  // Matches the existing clampVolume precedent: out-of-range numbers clamp
  // into range, only a non-number falls back to DEFAULT.
  assert.equal(clampTermPrefs({ termScrollback: -1 }).termScrollback, 0);
  assert.equal(clampTermPrefs({ termScrollback: 0 }).termScrollback, 0);
  assert.equal(clampTermPrefs({ termScrollback: 2500.9 }).termScrollback, 2501);
  assert.equal(clampTermPrefs({ termScrollback: 'lots' }).termScrollback, DEFAULTS.termScrollback);
});

test('termBgOpacity/termBgBlur: clamp to their own ranges', () => {
  assert.equal(clampTermPrefs({ termBgOpacity: -10 }).termBgOpacity, 0);
  assert.equal(clampTermPrefs({ termBgOpacity: 250 }).termBgOpacity, 100);
  assert.equal(clampTermPrefs({ termBgBlur: -5 }).termBgBlur, 0);
  assert.equal(clampTermPrefs({ termBgBlur: 50 }).termBgBlur, 20);
});

test('termCursorStyle: only block/underline/bar, otherwise DEFAULT', () => {
  assert.equal(clampTermPrefs({ termCursorStyle: 'bar' }).termCursorStyle, 'bar');
  assert.equal(clampTermPrefs({ termCursorStyle: 'laser' }).termCursorStyle, DEFAULTS.termCursorStyle);
  assert.equal(clampTermPrefs({ termCursorStyle: 42 }).termCursorStyle, DEFAULTS.termCursorStyle);
});

test('termCursorBlink: only boolean, otherwise DEFAULT', () => {
  assert.equal(clampTermPrefs({ termCursorBlink: false }).termCursorBlink, false);
  assert.equal(clampTermPrefs({ termCursorBlink: 'no' }).termCursorBlink, DEFAULTS.termCursorBlink);
});

test('termFontFamily: empty/bad string -> DEFAULT, whitespace also rejected', () => {
  assert.equal(clampTermPrefs({ termFontFamily: '' }).termFontFamily, DEFAULTS.termFontFamily);
  assert.equal(clampTermPrefs({ termFontFamily: '   ' }).termFontFamily, DEFAULTS.termFontFamily);
  assert.equal(clampTermPrefs({ termFontFamily: 42 }).termFontFamily, DEFAULTS.termFontFamily);
  assert.equal(clampTermPrefs({ termFontFamily: 'Fira Code' }).termFontFamily, 'Fira Code');
});

test('termBgImage: only a data:image/ string, otherwise null (CSP img-src)', () => {
  assert.equal(clampTermPrefs({}).termBgImage, null);
  assert.equal(clampTermPrefs({ termBgImage: null }).termBgImage, null);
  assert.equal(clampTermPrefs({ termBgImage: 'file:///C:/photo.png' }).termBgImage, null);
  assert.equal(clampTermPrefs({ termBgImage: 'not an image' }).termBgImage, null);
  assert.equal(clampTermPrefs({ termBgImage: 42 }).termBgImage, null);
  assert.equal(
    clampTermPrefs({ termBgImage: 'data:image/png;base64,AAAA' }).termBgImage,
    'data:image/png;base64,AAAA'
  );
});
