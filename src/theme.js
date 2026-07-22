// ============================================================================
// LunaCore - Motywy (theming system)
// ----------------------------------------------------------------------------
// Laduje motywy z config/themes.json (+ opcjonalny override config/themes.local.json,
// gitignore). Kazdy motyw = mapa tokenow CSS (`vars`) + kolory terminala xterm
// (`terminal`). Renderer naklada `vars` na document.documentElement i ustawia
// palete xterm - przelaczenie na zywo, bez reloadu.
//
// Walidacja na granicy jak w profiles.js: odrzucamy motywy bez id/vars. Pusty lub
// uszkodzony config => wbudowany FALLBACK (cyberpunk), nigdy puste okno.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'themes.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'themes.local.json');

// Awaryjny motyw, gdy brak/uszkodzony config - zawsze cos dziala.
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

/** Bezpieczny odczyt + parse JSON. Zwraca null przy braku/bledzie. */
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

/** Waliduje i normalizuje pojedynczy motyw. Zwraca obiekt lub null. */
function normalizeTheme(t) {
  if (!isPlainObject(t)) return null;
  if (typeof t.id !== 'string' || !t.id) return null;
  const label = typeof t.label === 'string' && t.label ? t.label : t.id;
  // Bierzemy tylko wlasciwosci CSS ("--*") o wartosci stringowej.
  const vars = isPlainObject(t.vars)
    ? Object.fromEntries(
        Object.entries(t.vars).filter(
          ([k, v]) => typeof k === 'string' && k.startsWith('--') && typeof v === 'string'
        )
      )
    : {};
  const terminal = isPlainObject(t.terminal)
    ? Object.fromEntries(Object.entries(t.terminal).filter(([, v]) => typeof v === 'string'))
    : {};
  if (Object.keys(vars).length === 0) return null; // motyw bez tokenow jest bezuzyteczny
  return { id: t.id, label, vars, terminal };
}

/**
 * Laduje motywy: base (themes.json) scalone z local (themes.local.json).
 * Local nadpisuje/dodaje motywy po id.
 * @returns {{themes: Array<{id:string,label:string,vars:Object,terminal:Object}>}}
 */
function loadThemes() {
  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.themes)) return;
    for (const raw of src.themes) {
      const t = normalizeTheme(raw);
      if (t) byId.set(t.id, t);
    }
  };
  collect(readJson(BASE_FILE) || FALLBACK);
  collect(readJson(LOCAL_FILE));

  let themes = [...byId.values()];
  if (themes.length === 0) themes = [...FALLBACK.themes];
  return { themes };
}

module.exports = { loadThemes };
