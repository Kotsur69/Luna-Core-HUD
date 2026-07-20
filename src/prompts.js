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
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'prompts.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'prompts.local.json');

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

  let text = p.text;
  if (Array.isArray(text)) {
    text = text.filter((line) => typeof line === 'string').join('\n');
  }
  if (typeof text !== 'string' || !text.trim()) return null;

  const label = typeof p.label === 'string' && p.label ? p.label : text.slice(0, 40);
  const note = typeof p.note === 'string' ? p.note : '';
  return { label, text, note };
}

/** Waliduje grupe. Zwraca { title, note, prompts } lub null (gdy brak promptow). */
function normalizeGroup(g) {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.title !== 'string' || !g.title) return null;
  const prompts = Array.isArray(g.prompts)
    ? g.prompts.map(normalizePrompt).filter(Boolean)
    : [];
  if (prompts.length === 0) return null;
  const note = typeof g.note === 'string' ? g.note : '';
  return { title: g.title, note, prompts };
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
      if (g) byTitle.set(g.title, g);
    }
  };
  collect(readJson(BASE_FILE));
  collect(readJson(LOCAL_FILE));

  return { groups: [...byTitle.values()] };
}

module.exports = { loadPrompts };
