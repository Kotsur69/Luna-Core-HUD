// clampTermPrefs() - the pure validator behind the Terminal Appearance
// Customizer (TERMINAL_CUSTOMIZER_PLAN.md). readUiPrefs()/writeUiPrefs()
// themselves are thin fs wrappers (same category as soundManager.js/tts.js)
// and are not covered here - only the pure sanitize-a-raw-object boundary is.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { clampTermPrefs, cleanCollapsed, cleanLayoutSizes } = require('../src/uiprefs.js');

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

// ---- C2: collapsed / layoutSizes -------------------------------------------
//
// Same reject-don't-repair boundary as clampTermPrefs above. Both of these come
// out of a hand-editable file AND back in over IPC, and layoutSizes ends up in
// an inline style, so neither may be trusted on the way through.

test('cleanCollapsed: keeps ids, drops junk, dedupes', () => {
  assert.deepEqual(cleanCollapsed(['ports', 'ports', '', null, 42, 'todo']), ['ports', 'todo']);
});

test('cleanCollapsed: a non-array is an empty list, never a crash', () => {
  for (const bad of [null, undefined, 'ports', 42, {}]) {
    assert.deepEqual(cleanCollapsed(bad), []);
  }
});

test('cleanCollapsed: caps the list and the id length', () => {
  const many = Array.from({ length: 200 }, (_v, i) => `w${i}`);
  assert.equal(cleanCollapsed(many).length, 64);
  assert.deepEqual(cleanCollapsed(['x'.repeat(65)]), []);
});

test('cleanLayoutSizes: keeps a plausible columns string', () => {
  assert.deepEqual(cleanLayoutSizes({ classic: '300px 1fr 280px' }), {
    classic: '300px 1fr 280px',
  });
});

test('cleanLayoutSizes: drops anything that could carry CSS of its own', () => {
  assert.deepEqual(cleanLayoutSizes({ classic: '1fr; background: url(http://x)' }), {});
  assert.deepEqual(cleanLayoutSizes({ classic: 'var(--x) 1fr' }), {});
  assert.deepEqual(cleanLayoutSizes({ classic: 'x'.repeat(200) }), {});
  assert.deepEqual(cleanLayoutSizes({ classic: 42 }), {});
  assert.deepEqual(cleanLayoutSizes({ classic: '' }), {});
});

test('cleanLayoutSizes: a non-object is an empty map', () => {
  for (const bad of [null, undefined, 'classic', 42, ['1fr']]) {
    assert.deepEqual(cleanLayoutSizes(bad), {});
  }
});
