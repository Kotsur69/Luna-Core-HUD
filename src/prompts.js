// ============================================================================
// LunaCore - Biblioteka promptow (§5.5 shortlist, priorytet #1)
// ----------------------------------------------------------------------------
// To samo co sciagawki (7C), ale dla WIELOLINIJKOWYCH promptow do wielokrotnego
// uzycia. Laduje config/prompts.json (+ opcjonalny, gitignorowany override
// config/prompts.local.json na prywatne prompty).
//
// Format promptu:
//   { "label": "Nazwa na przycisku", "text": "tresc\nprompta", "note": "opis" }
// Pole `text` moze byc tez tablica linii - laczymy ja "\n" (czytelniejszy JSON).
//
// Walidacja na granicy: odrzucamy grupy/prompty bez wymaganych pol. Pusty/bledny
// config => pusta lista (sekcja po prostu nic nie pokaze).
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { hasText, normalizeText, mergeKey, isLocalized, LANGS } = require('./localized');

// Wysylane prompty czytamy z katalogu bundled; prywatne (gitignore) leza w
// katalogu ZAPISYWALNYM i liczymy je leniwie, bo modul jest wymagany przed
// app.whenReady(). Szczegoly w paths.js.
const BASE_FILE = paths.bundled('prompts.json');
const localFile = () => paths.local('prompts.local.json');

/** Bezpieczny odczyt + parse JSON. Zwraca null przy braku/bledzie. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Waliduje pojedynczy prompt. Zwraca { label, text, note } lub null.
 * `text` przyjmuje string albo tablice linii (wygodniejsze do pisania w JSON).
 */
function normalizePrompt(p) {
  if (!p || typeof p !== 'object') return null;

  // normalizeText() sklada tablice linii w string - osobno dla kazdego jezyka,
  // gdy tresc jest zlokalizowana. Jezyk wybiera dopiero renderer.
  const text = normalizeText(p.text);
  if (!text) return null;

  const label = hasText(p.label) ? normalizeText(p.label) : fallbackLabel(text);
  const note = hasText(p.note) ? normalizeText(p.note) : '';
  return { label, text, note };
}

/**
 * Etykieta zastepcza, gdy prompt jej nie ma: poczatek tresci. Dla tresci
 * zlokalizowanej robimy skrot PER JEZYK - inaczej przycisk w wersji EN
 * pokazywalby polski poczatek prompta.
 */
function fallbackLabel(text) {
  if (!isLocalized(text)) return text.slice(0, 40);
  const out = {};
  for (const l of LANGS) {
    if (typeof text[l] === 'string') out[l] = text[l].slice(0, 40);
  }
  return out;
}

/** Waliduje grupe. Zwraca { title, note, prompts } lub null (gdy brak promptow). */
function normalizeGroup(g) {
  if (!g || typeof g !== 'object') return null;
  if (!hasText(g.title)) return null;
  const prompts = Array.isArray(g.prompts)
    ? g.prompts.map(normalizePrompt).filter(Boolean)
    : [];
  if (prompts.length === 0) return null;
  const note = hasText(g.note) ? normalizeText(g.note) : '';
  return { title: normalizeText(g.title), note, prompts };
}

/**
 * Laduje grupy promptow: base scalone z local (local po title nadpisuje base,
 * dodatkowe grupy dopisane na koncu).
 * @returns {{groups: Array<{title:string,note:string,prompts:Array}>}}
 */
function loadPrompts() {
  const byTitle = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.groups)) return;
    for (const raw of src.groups) {
      const g = normalizeGroup(raw);
      // Patrz komentarz w src/cheatsheets.js: zlokalizowany tytul to obiekt,
      // wiec klucz scalania musi byc stringiem.
      if (g) byTitle.set(mergeKey(g.title), g);
    }
  };
  collect(readJson(BASE_FILE));
  collect(readJson(localFile()));

  return { groups: [...byTitle.values()] };
}

module.exports = { loadPrompts };
