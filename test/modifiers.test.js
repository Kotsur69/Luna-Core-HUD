// ============================================================================
// LunaCore - modifier axis tests (v0.10)
// ----------------------------------------------------------------------------
// The modifier axes are split across three files on purpose: modifiers.js knows
// which ids exist, styles.css knows what they mean, uiprefs.js knows which ones
// may be persisted. That split is the right one - only the stylesheet can apply
// a multiplier, and only main can validate a write - but it means the same list
// of ids is written down three times, and three copies of a list rot.
//
// So the point of this file is not "does normalizeModifiers work". It is the
// three drift guards: an id in the table with no CSS block behind it, a CSS
// block no table row points at, or an id main would refuse to store, each fails
// here rather than shipping as an axis that silently does nothing.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  MODIFIER_AXES,
  normalizeModifiers,
  applyModifiers,
} = require('../src/renderer/modules/modifiers.js');
const { clampModifierPrefs } = require('../src/uiprefs.js');

const STYLES = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const css = () => fs.readFileSync(STYLES, 'utf8');

/**
 * The declaration lines of the first rule whose selector text contains `needle`.
 * Deliberately crude - the modifier blocks are flat token lists with no nesting,
 * so finding the selector and reading to the next `}` is enough, and a real CSS
 * parser would be a dependency this repo does not have and does not want.
 */
function blockDeclarations(needle) {
  const text = css();
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, `styles.css must contain ${needle}`);
  const open = text.indexOf('{', at);
  const close = text.indexOf('}', open);
  assert.ok(open !== -1 && close !== -1, `${needle} must be a closed block`);
  return text
    .slice(open + 1, close)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('--'))
    .map((l) => l.replace(/\s*!important\s*/, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * Every [data-*='value'] selector the stylesheet defines FOR A MODIFIER ATTRIBUTE.
 *
 * Scoped to the four attributes in the table rather than every data-* in the
 * file: the HUD uses attribute selectors for plenty of unrelated state (a
 * telemetry tile's [data-level='warn'], for one), and a guard that treated
 * those as stray modifier blocks would fail on code it has no opinion about.
 * A typo INSIDE a modifier attribute is still caught, which is the real risk.
 */
function declaredSelectors() {
  const attrs = new Set(MODIFIER_AXES.map((a) => a.attr));
  return new Set(
    [...css().matchAll(/\[(data-[a-z-]+)='([a-z-]+)'\]/g)]
      .filter((m) => attrs.has(m[1]))
      .map((m) => `${m[1]}=${m[2]}`)
  );
}

// ---- drift guard 1: the table and the stylesheet ---------------------------

test('every non-default axis value has a [data-*] block in styles.css', () => {
  const declared = declaredSelectors();
  for (const axis of MODIFIER_AXES) {
    for (const value of axis.values) {
      const key = `${axis.attr}=${value}`;
      if (value === axis.fallback) {
        // The default is :root itself - modifiers.js REMOVES the attribute for
        // it, so a block here would be unreachable and misleading.
        assert.ok(!declared.has(key), `${key} is the default; it must not have its own block`);
      } else {
        assert.ok(declared.has(key), `${key} is offered in the UI but no CSS block applies it`);
      }
    }
  }
});

test('every [data-*] block in styles.css is offered by an axis', () => {
  const known = new Set();
  for (const axis of MODIFIER_AXES) {
    for (const value of axis.values) known.add(`${axis.attr}=${value}`);
  }
  for (const sel of declaredSelectors()) {
    assert.ok(known.has(sel), `styles.css defines ${sel}, which no axis can ever set`);
  }
});

// ---- drift guard 2: motion:off must equal the OS reduced-motion block ------

test("[data-motion='off'] and prefers-reduced-motion declare the same tokens", () => {
  const inApp = blockDeclarations(":root[data-motion='off']");
  const os = blockDeclarations('@media (prefers-reduced-motion: reduce)');
  assert.ok(inApp.length > 0, 'the in-app off block must declare something');
  // Same tokens, same values. If someone retunes one and forgets the other, the
  // in-app switch and the OS switch quietly stop meaning the same thing.
  assert.deepEqual(inApp.slice().sort(), os.slice().sort());
});

test('the reduced-motion block outranks the in-app motion axis', () => {
  const text = css();
  // Both conditions are needed and both are easy to break by accident: without
  // !important a theme's inline --dur-fast wins, and without the [data-motion]
  // selector [data-motion='reduced'] out-specifies the media block, so an
  // accessibility setting would lose to an app preference.
  const at = text.indexOf('@media (prefers-reduced-motion: reduce)');
  const block = text.slice(at, text.indexOf('\n}', text.indexOf('}', at)));
  assert.ok(block.includes(':root[data-motion]'), 'must match the modifier specificity');
  assert.ok(block.includes('!important'), 'must beat a theme inline style');
  assert.ok(at > text.indexOf(":root[data-motion='reduced']"), 'must come after the axis blocks');
});

// ---- drift guard 3: main will actually persist every id the UI offers ------

test('every axis value survives uiprefs validation', () => {
  for (const axis of MODIFIER_AXES) {
    for (const value of axis.values) {
      assert.equal(
        clampModifierPrefs({ [axis.key]: value })[axis.key],
        value,
        `${axis.key}='${value}' is offered in the UI but main would reject it`
      );
    }
  }
});

test('an id no axis offers falls back to the default', () => {
  for (const axis of MODIFIER_AXES) {
    assert.equal(clampModifierPrefs({ [axis.key]: 'nonsense' })[axis.key], axis.fallback);
  }
});

// ---- the module itself -----------------------------------------------------

test('normalizeModifiers: a missing or bad input -> every axis at its default', () => {
  const defaults = Object.fromEntries(MODIFIER_AXES.map((a) => [a.key, a.fallback]));
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    assert.deepEqual(normalizeModifiers(bad), defaults);
  }
});

test('normalizeModifiers: each axis falls back independently', () => {
  const out = normalizeModifiers({ density: 'dense', fontPack: 'nope', glow: 'off' });
  assert.equal(out.density, 'dense');
  assert.equal(out.fontPack, 'theme'); // the one bad id costs its own axis only
  assert.equal(out.glow, 'off');
  assert.equal(out.motion, 'full');
});

/** Minimal stand-in for documentElement - this is why applyModifiers takes a root. */
function fakeRoot() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
  };
}

test('applyModifiers writes non-defaults and REMOVES defaults', () => {
  const root = fakeRoot();
  applyModifiers({ density: 'dense', glow: 'reduced' }, root);
  assert.equal(root.attrs.get('data-density'), 'dense');
  assert.equal(root.attrs.get('data-glow'), 'reduced');
  // fontPack and motion are at their defaults: no attribute at all, so :root
  // stays the single source of the unmodified look.
  assert.ok(!root.attrs.has('data-font-pack'));
  assert.ok(!root.attrs.has('data-motion'));
});

test('applyModifiers going back to a default clears the attribute it set', () => {
  const root = fakeRoot();
  applyModifiers({ density: 'dense' }, root);
  assert.equal(root.attrs.get('data-density'), 'dense');
  applyModifiers({ density: 'cozy' }, root);
  assert.ok(!root.attrs.has('data-density'), 'a stale attribute would pin the HUD at dense');
});

test('applyModifiers ignores an unknown id rather than writing it', () => {
  const root = fakeRoot();
  applyModifiers({ glow: 'ultra' }, root);
  assert.ok(!root.attrs.has('data-glow'));
});
