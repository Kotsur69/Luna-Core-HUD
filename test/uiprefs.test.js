// clampTermPrefs() - the pure validator behind the Terminal Appearance
// Customizer (TERMINAL_CUSTOMIZER_PLAN.md). readUiPrefs()/writeUiPrefs()
// themselves are thin fs wrappers (same category as soundManager.js/tts.js)
// and are not covered here - only the pure sanitize-a-raw-object boundary is.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clampTermPrefs,
  clampAutoCompactPrefs,
  cleanCollapsed,
  cleanLayoutSizes,
  cleanRailedRegions,
  clampModifierPrefs,
} = require('../src/uiprefs.js');
const { loadLayouts } = require('../src/layouts.js');

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

// ---- Feature #4: auto-compact trigger mode --------------------------------
//
// Same reject-and-repair boundary as clampTermPrefs: an out-of-range number
// clamps into range, a non-number falls back to its default, every field
// independent. The arm TOGGLE is not here - it stays per-session.

const AC_DEFAULTS = {
  autoCompactMode: 'context',
  autoCompactEveryTurns: 20,
  autoCompactAfterMinutes: 30,
};

test('clampAutoCompactPrefs: a missing/bad input object -> pure DEFAULTS', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    assert.deepEqual(clampAutoCompactPrefs(bad), AC_DEFAULTS);
  }
});

test('clampAutoCompactPrefs: an empty object -> pure DEFAULTS', () => {
  assert.deepEqual(clampAutoCompactPrefs({}), AC_DEFAULTS);
});

test('clampAutoCompactPrefs: valid values pass through unchanged', () => {
  const raw = {
    autoCompactMode: 'turns',
    autoCompactEveryTurns: 12,
    autoCompactAfterMinutes: 45,
  };
  assert.deepEqual(clampAutoCompactPrefs(raw), raw);
});

test('clampAutoCompactPrefs: mode must be context/turns/time, else context', () => {
  assert.equal(clampAutoCompactPrefs({ autoCompactMode: 'time' }).autoCompactMode, 'time');
  assert.equal(clampAutoCompactPrefs({ autoCompactMode: 'nonsense' }).autoCompactMode, 'context');
  assert.equal(clampAutoCompactPrefs({ autoCompactMode: 7 }).autoCompactMode, 'context');
});

test('clampAutoCompactPrefs: everyTurns clamps to 1..999, rounds, rejects non-numbers', () => {
  assert.equal(clampAutoCompactPrefs({ autoCompactEveryTurns: 0 }).autoCompactEveryTurns, 1);
  assert.equal(clampAutoCompactPrefs({ autoCompactEveryTurns: -5 }).autoCompactEveryTurns, 1);
  assert.equal(clampAutoCompactPrefs({ autoCompactEveryTurns: 5000 }).autoCompactEveryTurns, 999);
  assert.equal(clampAutoCompactPrefs({ autoCompactEveryTurns: 12.7 }).autoCompactEveryTurns, 13);
  assert.equal(clampAutoCompactPrefs({ autoCompactEveryTurns: 'lots' }).autoCompactEveryTurns, 20);
});

test('clampAutoCompactPrefs: afterMinutes clamps to 1..1440, rounds, rejects non-numbers', () => {
  assert.equal(clampAutoCompactPrefs({ autoCompactAfterMinutes: 0 }).autoCompactAfterMinutes, 1);
  assert.equal(clampAutoCompactPrefs({ autoCompactAfterMinutes: 99999 }).autoCompactAfterMinutes, 1440);
  assert.equal(clampAutoCompactPrefs({ autoCompactAfterMinutes: 30.4 }).autoCompactAfterMinutes, 30);
  // Matches clampTermPrefs' precedent: Number('soon') is NaN -> fall back; a
  // numeric-ish value clamps instead (readUiPrefs also type-guards the key).
  assert.equal(clampAutoCompactPrefs({ autoCompactAfterMinutes: 'soon' }).autoCompactAfterMinutes, 30);
});

// ---- C2: collapsed / layoutSizes -------------------------------------------
//
// Same reject-don't-repair boundary as clampTermPrefs above. Both of these come
// out of a hand-editable file AND back in over IPC, and layoutSizes ends up in
// an inline style, so neither may be trusted on the way through.

test('cleanCollapsed: keeps ids, drops junk, dedupes', () => {
  assert.deepEqual(cleanCollapsed(['ports', 'ports', '', null, 42, 'todo']), ['ports', 'todo']);
});

// The whole left rail of the `classic` layout. A fresh HUD opens tidy and the
// user unfolds what they use; see the comment on DEFAULTS.collapsed.
const LEFT_RAIL = ['actions', 'appearance', 'project', 'profile', 'cheatsheets', 'prompts', 'skills'];

test('cleanCollapsed: nothing stored means the first-run left rail, folded', () => {
  for (const missing of [null, undefined, 'ports', 42, {}]) {
    assert.deepEqual(cleanCollapsed(missing), LEFT_RAIL);
  }
});

test('cleanCollapsed: the first-run defaults are the classic left rail exactly', () => {
  // Read from the real layout config rather than a second copy of the list, so
  // adding a widget to the left rail fails here instead of silently shipping
  // that one panel open on every new install.
  const classic = loadLayouts().layouts.find((l) => l.id === 'classic');
  assert.deepEqual([...cleanCollapsed(null)].sort(), [...classic.slots.left].sort());
});

test('cleanCollapsed: the live readout is never folded by default', () => {
  const first = cleanCollapsed(null);
  for (const live of ['context', 'usage', 'telemetry', 'terminal']) {
    assert.equal(first.includes(live), false, `${live} must ship open`);
  }
});

test('cleanCollapsed: an arranged list wins over the defaults, empty included', () => {
  // An empty array is "I opened everything", not "nothing stored" - the second
  // launch after unfolding the rail must not fold it all back up.
  assert.deepEqual(cleanCollapsed([]), []);
  assert.deepEqual(cleanCollapsed(['skills']), ['skills']);
});

test('cleanCollapsed: the defaults array cannot be mutated by a caller', () => {
  cleanCollapsed(null).push('terminal');
  assert.equal(cleanCollapsed(null).includes('terminal'), false);
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

// ---- clampModifierPrefs (v0.10) -------------------------------------------
// The four axes are a pure whitelist per axis, and deliberately the strictest
// clamp in this file. An id that is not on the list has no [data-*] block in
// styles.css to match, so letting one through would not produce a wrong look -
// it would produce the DEFAULT look while the prefs file and the Settings
// select both insist otherwise. Silent disagreement is the thing to block.

const MOD_DEFAULTS = { density: 'cozy', fontPack: 'theme', glow: 'full', motion: 'full' };

test('clampModifierPrefs: a missing/bad input object -> pure DEFAULTS', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    assert.deepEqual(clampModifierPrefs(bad), MOD_DEFAULTS);
  }
});

test('clampModifierPrefs: an empty object -> pure DEFAULTS', () => {
  assert.deepEqual(clampModifierPrefs({}), MOD_DEFAULTS);
});

test('clampModifierPrefs: valid ids pass through unchanged', () => {
  const raw = { density: 'dense', fontPack: 'mono', glow: 'off', motion: 'reduced' };
  assert.deepEqual(clampModifierPrefs(raw), raw);
});

test('clampModifierPrefs: every default is the no-op value', () => {
  // Not cosmetic: it is what makes an existing install render exactly as it did
  // before v0.10, and what lets modifiers.js write no attribute at all.
  assert.equal(MOD_DEFAULTS.density, 'cozy');
  assert.equal(MOD_DEFAULTS.fontPack, 'theme');
  assert.deepEqual(clampModifierPrefs({}), MOD_DEFAULTS);
});

test('clampModifierPrefs: an unknown id costs its own axis, not the others', () => {
  const out = clampModifierPrefs({ density: 'ultra', fontPack: 'mono', glow: 'off' });
  assert.equal(out.density, 'cozy');
  assert.equal(out.fontPack, 'mono');
  assert.equal(out.glow, 'off');
  assert.equal(out.motion, 'full');
});

test('clampModifierPrefs: a value from the wrong axis is still rejected', () => {
  // `dense` is a real id - just not one this axis has a block for.
  assert.equal(clampModifierPrefs({ glow: 'dense' }).glow, 'full');
  assert.equal(clampModifierPrefs({ density: 'off' }).density, 'cozy');
});

// ---- v0.10 3.4: railedRegions ----------------------------------------------
//
// Same reject-don't-repair boundary as the rest of this file. A region name is
// deliberately NOT checked against a preset here - panels.js resolves names
// against the live layout and finds no column for a stale one, which is the
// only place that actually knows which regions exist.

test('cleanRailedRegions: a missing or bad input -> nothing railed', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    assert.deepEqual(cleanRailedRegions(bad), {});
  }
});

test('cleanRailedRegions keeps a well-formed map and dedupes within a preset', () => {
  assert.deepEqual(cleanRailedRegions({ classic: ['right', 'right', 'left'] }), {
    classic: ['right', 'left'],
  });
});

test('cleanRailedRegions drops an empty list rather than persisting noise', () => {
  // Otherwise the file grows one key per preset the user has ever opened.
  assert.deepEqual(cleanRailedRegions({ classic: [], focus: ['side'] }), { focus: ['side'] });
});

test('cleanRailedRegions rejects anything that is not id-shaped', () => {
  assert.deepEqual(cleanRailedRegions({ classic: ['ok', '', 42, 'x'.repeat(65)] }), {
    classic: ['ok'],
  });
  assert.deepEqual(cleanRailedRegions({ '': ['side'] }), {});
  assert.deepEqual(cleanRailedRegions({ classic: 'right' }), {});
  assert.deepEqual(cleanRailedRegions({ classic: null }), {});
});

test('cleanRailedRegions caps how much one hand-edited preset may store', () => {
  const many = [...Array(40)].map((_, i) => `r${i}`);
  assert.equal(cleanRailedRegions({ classic: many }).classic.length, 16);
});
