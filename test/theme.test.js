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

/** The declaration lines inside the :root { ... } block of styles.css. */
function rootBlockLines() {
  const lines = fs.readFileSync(STYLES, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === ':root {');
  assert.ok(start !== -1, 'styles.css must have a :root block');
  const end = lines.findIndex((l, i) => i > start && l.trim() === '}');
  assert.ok(end !== -1, ':root block must be closed');
  return lines.slice(start + 1, end);
}

/** The value a token defaults to in :root, with any trailing comment cut off. */
function rootValue(token) {
  for (const line of rootBlockLines()) {
    // `token + ':'` and not just the token, so --glow-size does not match the
    // --glow-size-md line two rows below it.
    const at = line.indexOf(token + ':');
    if (at === -1) continue;
    const rest = line.slice(at + token.length + 1);
    const semi = rest.indexOf(';');
    return (semi === -1 ? rest : rest.slice(0, semi)).trim();
  }
  return assert.fail(`${token} must be declared in :root`);
}

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

// ---- the space + type scales must not rot back into literals ----------------

/**
 * Declarations that must go through the v0.10 scales.
 *
 * `width`/`height` are deliberately NOT here: those are component geometry (a
 * 14px range thumb, a 28px close button), not spacing, and forcing them onto
 * the space scale would fit worse than a literal does.
 */
const SCALED_PROPS =
  /^\s*(font-size|padding|margin|gap|row-gap|column-gap|(?:padding|margin)-(?:top|right|bottom|left))\s*:\s*([^;{}]+);/;

/**
 * Every scaled declaration outside :root that still carries a px literal.
 *
 * NEGATIVE values pass: the one that exists is an optical nudge pinned to
 * non-scaled geometry (centring a fixed-size range thumb on its track). A
 * negative offset that pairs with a SCALED padding is written as
 * `calc(-1 * var(--space-n))`, which has no bare literal to catch anyway.
 */
function literalSizeDeclarations() {
  const lines = fs.readFileSync(STYLES, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === ':root {');
  const end = lines.findIndex((l, i) => i > start && l.trim() === '}');

  const hits = [];
  let inComment = false;
  lines.forEach((line, i) => {
    const opens = (line.match(/\/\*/g) || []).length;
    const closes = (line.match(/\*\//g) || []).length;
    const wasInComment = inComment;
    if (opens > closes) inComment = true;
    else if (closes > opens) inComment = false;
    if (wasInComment || (i >= start && i <= end)) return;

    const m = SCALED_PROPS.exec(line);
    if (m && /(^|[^-\w.])\d+(\.\d+)?px/.test(m[2])) {
      hits.push(`${i + 1}: ${m[1]}: ${m[2].trim()}`);
    }
  });
  return hits;
}

test('no size or spacing literals outside the :root scales', () => {
  // This is the guard that makes the density modifier survive contact with the
  // next twenty features. Without it the scale erodes one hurried `padding:
  // 7px` at a time, and the erosion stays invisible until someone switches to
  // `dense` and finds half the HUD ignored it. Same reasoning as the
  // KNOWN_TOKENS drift test above: duplicating a decision is only safe when
  // something fails loudly the moment the copies disagree.
  assert.deepStrictEqual(
    literalSizeDeclarations(),
    [],
    'use the --space-* / --fs-* scales instead of px literals'
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
  // Nord used to be in this list. It moved to the neon group below on a
  // deliberate call - a Nord with no glow and light slate surfaces read as
  // grey rather than as a colour scheme. The themes left here are flat by
  // PURPOSE (paper and light are lit surfaces; void is an absence), and a
  // glow on any of them would be a bug, not a preference.
  for (const id of ['paper', 'void', 'light']) {
    const t = themes.find((x) => x.id === id);
    assert.strictEqual(t.vars['--glow-size'], '0px', `theme "${id}"`);
    assert.strictEqual(t.vars['--text-glow'], 'none', `theme "${id}"`);
  }
});

/** A theme's effective --glow-size, honouring the :root default when unset. */
function glowSize(theme) {
  return parseFloat(theme.vars['--glow-size'] ?? rootValue('--glow-size'));
}

test('the neon themes actually glow, on boxes AND on type', () => {
  const { themes } = loadThemes(() => {});
  // The failure this guards against is specific and had already happened: a
  // theme carrying a --glow-size but leaving --text-glow at "none", so the
  // bloom appears on every border and never once on the text - which reads as
  // a rendering fault rather than a style.
  for (const id of ['cyberpunk', 'synthwave', 'nord', 'dracula', 'solarized', 'tokyo-night']) {
    const t = themes.find((x) => x.id === id);
    // An absent --glow-size is not a missing glow: :root's own default IS the
    // cyberpunk look, and cyberpunk is the one theme that inherits it rather
    // than restating it. What must never appear here is an explicit 0.
    assert.ok(glowSize(t) > 0, `theme "${id}" has --glow-size ${t.vars['--glow-size']}`);
    // --text-glow is different: its :root default really is `none`, so a neon
    // theme has to say so itself or the bloom lands on every border and never
    // once on the type, which reads as a rendering fault rather than a style.
    assert.ok(
      t.vars['--text-glow'] && t.vars['--text-glow'] !== 'none',
      `theme "${id}" glows on boxes but not on type`
    );
  }
});

test('solarized stays restrained while the others burn', () => {
  const { themes } = loadThemes(() => {});
  const size = (id) => glowSize(themes.find((t) => t.id === id));
  // Solarized's identity is a deliberately narrow contrast range; it earns a
  // glow but must never out-bloom the themes built for neon.
  assert.ok(size('solarized') < size('cyberpunk'), 'solarized must stay under cyberpunk');
  assert.ok(size('solarized') < size('synthwave'), 'solarized must stay under synthwave');
  assert.ok(size('synthwave') >= size('cyberpunk'), 'synthwave is the loudest by design');
});

// ---- contrast: a theme has to be readable, not just good-looking ------------
//
// Phase 5 adds themes in bulk, and a palette is the one kind of change that
// looks finished the moment it looks nice. This runs over EVERY theme, old and
// new: the 18 that shipped before v0.10 were never audited, and the whole point
// of auditing them with a test rather than by eye is that the next ten themes
// inherit the check for free.

/**
 * WCAG 2.1 minimum for text. Small secondary text is still text, so --text-dim
 * is held to the same bar; 3:1 only ever covered large type and UI chrome, and
 * a HUD's metadata rows are neither.
 */
const MIN_CONTRAST = 4.5;

/**
 * A CSS colour string as [r, g, b], or null when it is not a flat colour.
 *
 * Only the forms themes.json actually uses are handled. Returning null is NOT
 * treated as "skip" by the callers below - see the parse-coverage test, which
 * exists so that a theme written in `oklch()` fails loudly instead of quietly
 * opting itself out of every contrast check in this file.
 */
function parseColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

/** WCAG relative luminance of an [r, g, b] triple. */
function luminance([r, g, b]) {
  const channel = (c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two [r, g, b] triples: 1 (same) to 21 (b/w). */
function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Every foreground/background pair the contrast test below walks, per theme. */
const CONTRAST_PAIRS = [
  { fg: '--text', bg: '--bg-panel', what: 'body text on a panel' },
  { fg: '--text', bg: '--bg', what: 'body text on the page' },
  { fg: '--text-dim', bg: '--bg-panel', what: 'dim text on a panel' },
];

// ---- the dark themes come first, the light ones last -----------------------

/**
 * Whether a theme reads as a light one, from its own page background.
 *
 * Measured rather than listed, so a new theme lands in the right group without
 * anyone remembering to add it to an array. The threshold is nowhere near
 * delicate: the darks top out around 0.02 and the lights start around 0.69,
 * so the whole middle of the range is empty.
 */
function isLightTheme(theme) {
  return luminance(parseColor(theme.vars['--bg'])) > 0.5;
}

test('the light themes are all at the bottom of the picker', () => {
  const { themes } = loadThemes(() => {});
  // The switcher renders themes in file order (appearance.js walks the Map's
  // insertion order, which is the themes.json array order), so this array IS
  // the menu. Mati's ask: darks from the top, whites grouped at the bottom -
  // switching to a light theme mid-session is a deliberate act, not something
  // to scroll past on the way to the next dark one.
  const flipped = themes.findIndex(isLightTheme);
  assert.notStrictEqual(flipped, -1, 'expected at least one light theme');
  const strays = themes
    .slice(flipped)
    .filter((t) => !isLightTheme(t))
    .map((t) => t.id);
  assert.deepStrictEqual(
    strays,
    [],
    `dark themes sitting below the first light one (${themes[flipped].id}): ${strays.join(', ')}`
  );
  // Guard the other direction too, so "move every theme to the light group"
  // could never satisfy the test above.
  assert.ok(flipped > 0, 'the picker must open on a dark theme, not a light one');
});

test('contrastRatio agrees with the WCAG reference values', () => {
  // Anchors, not a reimplementation: without these the helper could be wrong in
  // the same direction for every theme and the suite would still be green.
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  assert.strictEqual(Math.round(contrastRatio(black, white) * 100) / 100, 21);
  assert.strictEqual(contrastRatio(white, white), 1);
  // Symmetric - the ratio does not care which one is the ink.
  assert.strictEqual(contrastRatio(black, white), contrastRatio(white, black));
  // #767676 on white is the canonical "just passes 4.5:1" grey.
  assert.ok(contrastRatio(parseColor('#767676'), white) >= MIN_CONTRAST);
  assert.ok(contrastRatio(parseColor('#8a8a8a'), white) < MIN_CONTRAST);
});

test('parseColor reads every colour the contrast checks rely on', () => {
  const { themes } = loadThemes(() => {});
  const unparsed = [];
  for (const t of themes) {
    for (const { fg, bg } of CONTRAST_PAIRS) {
      for (const token of [fg, bg]) {
        if (!parseColor(t.vars[token])) unparsed.push(`${t.id} ${token}=${t.vars[token]}`);
      }
    }
    for (const key of ['background', 'foreground']) {
      if (!parseColor(t.terminal[key])) {
        unparsed.push(`${t.id} terminal.${key}=${t.terminal[key]}`);
      }
    }
  }
  assert.deepStrictEqual(
    unparsed,
    [],
    `unreadable to parseColor, so their contrast goes unchecked: ${unparsed.join('; ')}`
  );
});

test('every theme clears 4.5:1 on text against its own surfaces', () => {
  const { themes } = loadThemes(() => {});
  const failures = [];
  for (const t of themes) {
    for (const { fg, bg, what } of CONTRAST_PAIRS) {
      const ratio = contrastRatio(parseColor(t.vars[fg]), parseColor(t.vars[bg]));
      if (ratio < MIN_CONTRAST) {
        failures.push(
          `${t.id}: ${what} (${fg} ${t.vars[fg]} on ${bg} ${t.vars[bg]}) = ${ratio.toFixed(2)}:1`
        );
      }
    }
  }
  assert.deepStrictEqual(failures, [], `below ${MIN_CONTRAST}:1 -\n  ${failures.join('\n  ')}`);
});

test('every theme clears 4.5:1 in the terminal, where the output actually is', () => {
  const { themes } = loadThemes(() => {});
  // The panel tokens and the xterm palette are separate blocks that nothing
  // forces to agree, so a theme can read perfectly in the HUD and still put
  // grey-on-grey in the one pane the work is actually read from.
  const failures = [];
  for (const t of themes) {
    const fg = parseColor(t.terminal.foreground);
    const bg = parseColor(t.terminal.background);
    const ratio = contrastRatio(fg, bg);
    if (ratio < MIN_CONTRAST) {
      failures.push(
        `${t.id}: ${t.terminal.foreground} on ${t.terminal.background} = ${ratio.toFixed(2)}:1`
      );
    }
  }
  assert.deepStrictEqual(failures, [], `below ${MIN_CONTRAST}:1 -\n  ${failures.join('\n  ')}`);
});
