// ============================================================================
// LunaCore - theme tests (C3)
// ----------------------------------------------------------------------------
// Two things to check: normalizeTheme()/loadThemes() as a boundary (what it
// accepts, what it rejects, what it only warns about), and that the token
// dictionary in theme.js hasn't drifted from :root in styles.css.
//
// This second test is the whole reason duplicating the token list is safe at
// all: KNOWN_TOKENS exists so a typo in a theme is visible, but the list
// itself can also go stale. Here, it won't.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { loadThemes, normalizeTheme, KNOWN_TOKENS } = require('../src/theme');

const STYLES = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');

/** Tokens declared in the :root { ... } block in styles.css. */
function rootTokens() {
  const css = fs.readFileSync(STYLES, 'utf8');
  const start = css.indexOf(':root {');
  assert.ok(start !== -1, 'styles.css must have a :root block');
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end);
  return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));
}

// ---- boundary: what normalizeTheme accepts vs rejects ---------------------

test('normalizeTheme rejects anything that is not an object', () => {
  for (const bad of [null, undefined, 42, 'theme', []]) {
    assert.strictEqual(normalizeTheme(bad), null);
  }
});

test('normalizeTheme rejects a theme without id', () => {
  assert.strictEqual(normalizeTheme({ vars: { '--bg': '#000' } }), null);
  assert.strictEqual(normalizeTheme({ id: '', vars: { '--bg': '#000' } }), null);
});

test('normalizeTheme rejects a theme without tokens and without inheritance', () => {
  assert.strictEqual(normalizeTheme({ id: 'empty', vars: {} }), null);
  assert.strictEqual(normalizeTheme({ id: 'empty' }), null);
});

test('normalizeTheme accepts a theme without tokens when it inherits', () => {
  const t = normalizeTheme({ id: 'variant', extends: 'matrix' });
  assert.ok(t);
  assert.strictEqual(t.extends, 'matrix');
});

test('normalizeTheme substitutes id as label when label is missing', () => {
  const t = normalizeTheme({ id: 'void', vars: { '--bg': '#000' } });
  assert.strictEqual(t.label, 'void');
});

test('normalizeTheme skips values that are not strings', () => {
  const t = normalizeTheme({ id: 'x', vars: { '--bg': '#000', '--radius': 10 } });
  assert.deepStrictEqual(Object.keys(t.vars), ['--bg']);
});

test('normalizeTheme warns about an unknown token and skips it', () => {
  const warns = [];
  // "--radius-small" doesn't exist - the correct name is "--radius-sm".
  const t = normalizeTheme(
    { id: 'x', vars: { '--bg': '#000', '--radius-small': '4px' } },
    (m) => warns.push(m)
  );
  assert.deepStrictEqual(Object.keys(t.vars), ['--bg']);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /--radius-small/);
});

test('a typo in a token does not reject the whole theme', () => {
  const t = normalizeTheme({ id: 'x', vars: { '--bg': '#000', '--not-real': 'x' } });
  assert.ok(t, 'the theme should survive a single typo');
  assert.strictEqual(t.vars['--bg'], '#000');
});

// ---- the token dictionary must not drift from the styles ---------------------

test('KNOWN_TOKENS matches the :root block in styles.css', () => {
  const inCss = rootTokens();
  const missingFromCss = [...KNOWN_TOKENS].filter((t) => !inCss.has(t));
  const missingFromList = [...inCss].filter((t) => !KNOWN_TOKENS.has(t));

  assert.deepStrictEqual(
    missingFromCss,
    [],
    `theme.js knows tokens that are not in :root: ${missingFromCss.join(', ')}`
  );
  assert.deepStrictEqual(
    missingFromList,
    [],
    `:root has tokens no theme can set: ${missingFromList.join(', ')}`
  );
});

// ---- inheritance ---------------------------------------------------------

test('shipped themes load with no warnings', () => {
  const warns = [];
  const { themes } = loadThemes((m) => warns.push(m));
  assert.deepStrictEqual(warns, []);
  assert.ok(themes.length >= 9, `expected >=9 themes, got ${themes.length}`);
});

test('every shipped theme has a full token set once extends is resolved', () => {
  const { themes } = loadThemes(() => {});
  for (const t of themes) {
    // Colors are mandatory - without them a theme is not a theme, just an accent.
    for (const must of ['--bg', '--bg-panel', '--text', '--text-dim', '--term-bg']) {
      assert.ok(t.vars[must], `theme "${t.id}" does not set ${must}`);
    }
    assert.ok(t.terminal.background, `theme "${t.id}" does not set the terminal background`);
  }
});

test('extends inherits the parent tokens, its own win', () => {
  const { themes } = loadThemes(() => {});
  const matrix = themes.find((t) => t.id === 'matrix');
  const amber = themes.find((t) => t.id === 'amber-crt');
  assert.ok(matrix && amber);
  // Form comes from matrix...
  assert.strictEqual(amber.vars['--radius'], matrix.vars['--radius']);
  assert.strictEqual(amber.vars['--font-ui'], matrix.vars['--font-ui']);
  // ...but the colors are its own.
  assert.notStrictEqual(amber.vars['--bg'], matrix.vars['--bg']);
  assert.strictEqual(amber.vars['--bg'], '#0d0800');
});

test('a resolved theme no longer carries the extends key to the renderer', () => {
  const { themes } = loadThemes(() => {});
  for (const t of themes) {
    assert.ok(!('extends' in t), `theme "${t.id}" leaks extends to the renderer`);
  }
});

// ---- themes that Mati may have saved in ui.local.json -----------------

test('none of the existing theme ids have disappeared', () => {
  const { themes } = loadThemes(() => {});
  const ids = new Set(themes.map((t) => t.id));
  // Removing any of these would orphan a saved choice in ui.local.json.
  for (const id of ['cyberpunk', 'synthwave', 'matrix', 'nord', 'light']) {
    assert.ok(ids.has(id), `theme "${id}" disappeared from config/themes.json`);
  }
});

test('matrix is no longer just a green filter', () => {
  const { themes } = loadThemes(() => {});
  const matrix = themes.find((t) => t.id === 'matrix');
  // This is C3's whole thesis: a theme should change shape, not just hue.
  assert.strictEqual(matrix.vars['--radius'], '0px');
  assert.match(matrix.vars['--font-ui'], /Mono|Consolas/);
  assert.notStrictEqual(matrix.vars['--texture'], 'none');
  assert.ok(matrix.vars['--text-glow'] && matrix.vars['--text-glow'] !== 'none');
});

test('flat themes genuinely turn off the glow', () => {
  const { themes } = loadThemes(() => {});
  for (const id of ['nord', 'paper', 'void', 'light']) {
    const t = themes.find((x) => x.id === id);
    assert.strictEqual(t.vars['--glow-size'], '0px', `theme "${id}"`);
    assert.strictEqual(t.vars['--text-glow'], 'none', `theme "${id}"`);
  }
});
