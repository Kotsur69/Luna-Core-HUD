// ============================================================================
// LunaCore - Themes (theming system)
// ----------------------------------------------------------------------------
// Loads themes from config/themes.json (+ an optional override
// config/themes.local.json, gitignored). Each theme is a map of CSS tokens
// (`vars`) + xterm terminal colors (`terminal`). The renderer applies `vars` to
// document.documentElement and sets the xterm palette - a live switch, no reload.
//
// Validation at the boundary, same as profiles.js: themes without id/vars are
// rejected. An empty or broken config => the built-in FALLBACK (cyberpunk),
// never an empty window.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

// The themes shipped with the app are read from the bundled directory - in a
// packaged build it sits inside app.asar, which is plenty for reading. The
// user's override lives in the WRITABLE directory and is resolved lazily, since
// this module is required before app.whenReady(). Details in paths.js.
const BASE_FILE = paths.bundled('themes.json');
const localFile = () => paths.local('themes.local.json');

// Emergency theme for a missing or broken config - something always works.
const FALLBACK = {
  themes: [
    {
      id: 'cyberpunk',
      label: 'Cyberpunk',
      vars: {
        '--bg': '#0a0710',
        '--bg-panel': '#120c1c',
        '--bg-panel-2': '#170f24',
        '--edge': '#2a1e3d',
        '--edge-glow': '#5a2ea0',
        '--text': '#e6dcff',
        '--text-dim': '#9b8bc0',
        '--neon-magenta': '#c774ff',
        '--neon-cyan': '#5ff2d6',
        '--good': '#7cff9b',
        '--warn': '#ffd86b',
        '--bad': '#ff6b8a',
        '--radius': '10px',
        '--term-bg': '#0c0912',
        '--btn-grad': 'linear-gradient(135deg, #1a1030, #241442)',
        '--btn-grad-hover': 'linear-gradient(135deg, #241442, #341d5c)',
        '--glow': 'rgba(199, 116, 255, 0.32)',
      },
      terminal: {
        background: '#0c0912',
        foreground: '#e6dcff',
        cursor: '#c774ff',
      },
    },
  ],
};

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isPlainObject(o) {
  return o && typeof o === 'object' && !Array.isArray(o);
}

/**
 * Every token a theme is allowed to set (C3). MUST stay in sync with the :root
 * block in src/renderer/styles.css - test/theme.test.js parses that block and
 * fails if the two drift, so this list cannot silently rot.
 *
 * Why have it at all: before C3 the vocabulary was 17 tokens and a typo was
 * obvious. It is ~45 now, and `--radius-small` (there is no such token; it is
 * `--radius-sm`) would otherwise be dropped in silence, leaving the author
 * staring at a theme that "just doesn't apply that one thing".
 */
const KNOWN_TOKENS = new Set([
  // colour
  '--bg', '--bg-panel', '--bg-panel-2', '--edge', '--edge-glow', '--text',
  '--text-dim', '--neon-magenta', '--neon-cyan', '--good', '--warn', '--bad',
  '--term-bg', '--btn-grad', '--btn-grad-hover', '--glow',
  // form
  '--radius', '--radius-lg', '--radius-md', '--radius-sm', '--radius-xs',
  '--radius-pill', '--border-w', '--pad-panel', '--panel-gap',
  // typography
  '--font-ui', '--font-mono', '--font-display', '--tracking-title',
  '--tracking-brand', '--case-title',
  // depth
  '--glow-size', '--glow-size-md', '--glow-size-sm', '--text-glow', '--shadow-panel',
  // texture
  '--texture', '--texture-size', '--texture-opacity', '--texture-blend',
  // motion
  '--dur-instant', '--dur-fast', '--dur-normal', '--dur-slow',
  '--ease-smooth', '--ease-sharp', '--ease-bounce', '--stagger',
  // interaction: how far a row rises on hover, how far a control sinks on press
  '--lift', '--press-scale',
]);

/**
 * Validates and normalizes a single theme. Returns an object or null.
 *
 * An unknown token is a warning, not a rejection: one typo should cost the
 * author that token, not the whole theme. Malformed *structure* (no id, no
 * usable vars) still rejects - that is the reject-don't-repair boundary.
 */
function normalizeTheme(t, warn = () => {}) {
  if (!isPlainObject(t)) return null;
  if (typeof t.id !== 'string' || !t.id) return null;
  const label = typeof t.label === 'string' && t.label ? t.label : t.id;

  const vars = {};
  if (isPlainObject(t.vars)) {
    for (const [k, v] of Object.entries(t.vars)) {
      if (typeof k !== 'string' || !k.startsWith('--') || typeof v !== 'string') continue;
      if (!KNOWN_TOKENS.has(k)) {
        warn(`theme "${t.id}": unknown token "${k}" - ignored`);
        continue;
      }
      vars[k] = v;
    }
  }

  const terminal = isPlainObject(t.terminal)
    ? Object.fromEntries(Object.entries(t.terminal).filter(([, v]) => typeof v === 'string'))
    : {};
  // A theme that sets no tokens at all is useless - UNLESS it inherits them.
  const extend = typeof t.extends === 'string' && t.extends ? t.extends : null;
  if (Object.keys(vars).length === 0 && !extend) return null;
  return { id: t.id, label, extends: extend, vars, terminal };
}

/**
 * Resolves `extends`: a theme inherits its parent's tokens, its own win.
 *
 * The vocabulary is ~45 tokens now. Without inheritance every variant of a look
 * (a dimmer cyberpunk, a sharper nord) has to restate all of them, and the
 * restatements drift apart the first time one is edited. With it, a variant is
 * the handful of tokens that actually differ.
 *
 * A missing parent or a cycle costs the theme its inheritance, not its
 * existence: it falls back to its own tokens and says so. Resolution is
 * memoized, so a chain is walked once however many children hang off it.
 */
function resolveInheritance(byId, warn) {
  const resolved = new Map();

  const resolve = (id, seen) => {
    if (resolved.has(id)) return resolved.get(id);
    const t = byId.get(id);
    if (!t) return null;

    let base = { vars: {}, terminal: {} };
    if (t.extends) {
      if (seen.has(t.extends)) {
        warn(`theme "${id}": extends cycle via "${t.extends}" - inheritance dropped`);
      } else if (!byId.has(t.extends)) {
        warn(`theme "${id}": extends unknown theme "${t.extends}" - inheritance dropped`);
      } else {
        base = resolve(t.extends, new Set(seen).add(id)) || base;
      }
    }

    const out = {
      id: t.id,
      label: t.label,
      vars: { ...base.vars, ...t.vars },
      terminal: { ...base.terminal, ...t.terminal },
    };
    resolved.set(id, out);
    return out;
  };

  const out = [];
  for (const id of byId.keys()) {
    const t = resolve(id, new Set([id]));
    // Inheriting from a theme that turned out not to exist can leave nothing
    // behind. An empty theme would render as "no theme at all" while still
    // sitting in the switcher, so drop it the same way normalizeTheme() would.
    if (t && Object.keys(t.vars).length > 0) out.push(t);
    else warn(`theme "${id}": no tokens after resolving extends - dropped`);
  }
  return out;
}

/**
 * Loads themes: base (themes.json) merged with local (themes.local.json).
 * Local overrides/adds themes by id.
 * @param {(msg: string) => void} [warn] where malformed-config complaints go
 * @returns {{themes: Array<{id:string,label:string,vars:Object,terminal:Object}>}}
 */
function loadThemes(warn = (msg) => console.warn(msg)) {
  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.themes)) return;
    for (const raw of src.themes) {
      const t = normalizeTheme(raw, warn);
      if (t) byId.set(t.id, t);
    }
  };
  collect(readJson(BASE_FILE) || FALLBACK);
  collect(readJson(localFile()));

  let themes = resolveInheritance(byId, warn);
  if (themes.length === 0) themes = [...FALLBACK.themes];
  return { themes };
}

module.exports = { loadThemes, normalizeTheme, KNOWN_TOKENS };
