// ============================================================================
// LunaCore - Profile uruchomieniowe (Faza 4)
// ----------------------------------------------------------------------------
// Laduje definicje profili z config/profiles.json (+ opcjonalny override z
// config/profiles.local.json, gitignore). Kazdy profil opisuje JAK wystartowac
// sesje: komenda do wpisania w powloce (np. "claude") oraz nadpisania srodowiska
// (np. ANTHROPIC_BASE_URL dla lokalnego endpointu LM Studio).
//
// Walidacja na granicy: odrzucamy profile bez id/label/command. Gdy config jest
// pusty lub uszkodzony - wracamy do wbudowanego profilu domyslnego.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'profiles.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'profiles.local.json');

// Awaryjny profil, gdy brak/uszkodzony config - zawsze cos dziala.
const FALLBACK = {
  activeProfile: 'claude-cloud',
  profiles: [
    { id: 'claude-cloud', label: 'Claude Cloud', command: 'claude', args: [], env: {} },
  ],
};

/** Bezpieczny odczyt + parse JSON. Zwraca null przy braku/bledzie. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // plik nie istnieje lub niepoprawny JSON
  }
}

/** Waliduje i normalizuje pojedynczy profil. Zwraca obiekt lub null. */
function normalizeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.id !== 'string' || !p.id) return null;
  if (typeof p.label !== 'string' || !p.label) return null;
  // command moze byc pusty ("" = sama powloka), ale musi byc stringiem.
  const command = typeof p.command === 'string' ? p.command : '';
  const args = Array.isArray(p.args) ? p.args.filter((a) => typeof a === 'string') : [];
  const env =
    p.env && typeof p.env === 'object' && !Array.isArray(p.env)
      ? Object.fromEntries(
          Object.entries(p.env).filter(([, v]) => typeof v === 'string')
        )
      : {};
  return { id: p.id, label: p.label, command, args, env };
}

/**
 * Laduje profile: base (profiles.json) scalone z local (profiles.local.json).
 * Local moze nadpisac activeProfile oraz dodac/podmienic profile po id.
 * @returns {{profiles: Array, activeProfile: string}}
 */
function loadProfiles() {
  const base = readJson(BASE_FILE) || FALLBACK;
  const local = readJson(LOCAL_FILE);

  // Mapa po id, zeby local nadpisywal profile o tym samym id.
  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.profiles)) return;
    for (const raw of src.profiles) {
      const p = normalizeProfile(raw);
      if (p) byId.set(p.id, p);
    }
  };
  collect(base);
  collect(local);

  let profiles = [...byId.values()];
  if (profiles.length === 0) profiles = [...FALLBACK.profiles];

  // activeProfile: local > base > pierwszy dostepny.
  let activeProfile =
    (local && typeof local.activeProfile === 'string' && local.activeProfile) ||
    (typeof base.activeProfile === 'string' && base.activeProfile) ||
    profiles[0].id;
  // Upewnij sie, ze wskazany aktywny profil istnieje.
  if (!byId.has(activeProfile)) activeProfile = profiles[0].id;

  return { profiles, activeProfile };
}

/** Zwraca profil po id (lub null). */
function getProfile(profiles, id) {
  return profiles.find((p) => p.id === id) || null;
}

module.exports = { loadProfiles, getProfile };
