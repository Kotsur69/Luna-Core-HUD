// ============================================================================
// LunaCore - Sciagawki akcji (7C)
// ----------------------------------------------------------------------------
// Laduje grupy komend z config/cheatsheets.json (+ opcjonalny override
// config/cheatsheets.local.json, gitignore). Kazda grupa to zwijka z rzedem
// przyciskow; klikniecie wysyla komende przez Action Injector (pty:command).
//
// Konwencja: command z prefiksem "!" = komenda powloki (bash) w sesji Claude;
// bez prefiksu = wpisywane wprost (slash-komendy typu /compact, /code-review).
//
// Walidacja na granicy: odrzucamy grupy/komendy bez wymaganych pol. Pusty/bledny
// config => pusta lista (panel po prostu nic nie pokaze).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'cheatsheets.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'cheatsheets.local.json');

/** Bezpieczny odczyt + parse JSON. Zwraca null przy braku/bledzie. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Waliduje pojedyncza komende. Zwraca { label, command } lub null. */
function normalizeCommand(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.command !== 'string' || !c.command) return null;
  const label = typeof c.label === 'string' && c.label ? c.label : c.command;
  return { label, command: c.command };
}

/** Waliduje grupe. Zwraca { title, note, commands } lub null (gdy brak komend). */
function normalizeGroup(g) {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.title !== 'string' || !g.title) return null;
  const commands = Array.isArray(g.commands)
    ? g.commands.map(normalizeCommand).filter(Boolean)
    : [];
  if (commands.length === 0) return null;
  const note = typeof g.note === 'string' ? g.note : '';
  return { title: g.title, note, commands };
}

/**
 * Laduje grupy sciagawek: base scalone z local (local po title nadpisuje base,
 * dodatkowe grupy dopisane na koncu).
 * @returns {{groups: Array}}
 */
function loadCheatsheets() {
  const base = readJson(BASE_FILE);
  const local = readJson(LOCAL_FILE);

  const byTitle = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.groups)) return;
    for (const raw of src.groups) {
      const g = normalizeGroup(raw);
      if (g) byTitle.set(g.title, g);
    }
  };
  collect(base);
  collect(local);

  return { groups: [...byTitle.values()] };
}

module.exports = { loadCheatsheets };
