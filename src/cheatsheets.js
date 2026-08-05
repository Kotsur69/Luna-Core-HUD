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
const paths = require('./paths');
const { hasText, normalizeText, mergeKey } = require('./localized');

// Wysylane sciagawki czytamy z katalogu bundled; override uzytkownika lezy w
// katalogu ZAPISYWALNYM i liczymy go leniwie, bo modul jest wymagany przed
// app.whenReady(). Szczegoly w paths.js.
const BASE_FILE = paths.bundled('cheatsheets.json');
const localFile = () => paths.local('cheatsheets.local.json');

/** Bezpieczny odczyt + parse JSON. Zwraca null przy braku/bledzie. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Waliduje pojedyncza komende. Zwraca { label, command } lub null.
 * `label` moze byc stringiem albo obiektem { pl, en } - patrz src/localized.js.
 * Sama `command` NIE jest tlumaczona: `!npm test` znaczy to samo w kazdym jezyku.
 */
function normalizeCommand(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.command !== 'string' || !c.command) return null;
  const label = hasText(c.label) ? normalizeText(c.label) : c.command;
  return { label, command: c.command };
}

/** Waliduje grupe. Zwraca { title, note, commands } lub null (gdy brak komend). */
function normalizeGroup(g) {
  if (!g || typeof g !== 'object') return null;
  if (!hasText(g.title)) return null;
  const commands = Array.isArray(g.commands)
    ? g.commands.map(normalizeCommand).filter(Boolean)
    : [];
  if (commands.length === 0) return null;
  const note = hasText(g.note) ? normalizeText(g.note) : '';
  return { title: normalizeText(g.title), note, commands };
}

/**
 * Laduje grupy sciagawek: base scalone z local (local po title nadpisuje base,
 * dodatkowe grupy dopisane na koncu).
 * @returns {{groups: Array}}
 */
function loadCheatsheets() {
  const base = readJson(BASE_FILE);
  const local = readJson(localFile());

  const byTitle = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.groups)) return;
    for (const raw of src.groups) {
      const g = normalizeGroup(raw);
      // Klucz przez mergeKey(): zlokalizowany tytul to OBIEKT, a obiekty w Mapie
      // porownuja sie przez tozsamosc - kazda grupa wygladalaby na unikalna
      // i override z *.local.json po cichu przestalby dzialac.
      if (g) byTitle.set(mergeKey(g.title), g);
    }
  };
  collect(base);
  collect(local);

  return { groups: [...byTitle.values()] };
}

module.exports = { loadCheatsheets };
