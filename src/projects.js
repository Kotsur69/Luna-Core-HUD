// ============================================================================
// LunaCore - Przelacznik projektu / katalogu roboczego
// ----------------------------------------------------------------------------
// Laduje liste katalogow roboczych z config/projects.json (+ opcjonalny override
// z config/projects.local.json, gitignore). Kazdy wpis mowi, W JAKIM FOLDERZE
// wystartowac sesje PTY. Przelaczenie projektu = restart sesji z nowym `cwd`.
//
// Sciezki moga zaczynac sie od "~" (rozwijane na katalog domowy) - dzieki temu
// config jest PRZENOSNY miedzy maszynami (rozne litery dyskow / nazwy userow).
// Walidacja na granicy: odrzucamy wpisy bez id/label/path. Istnienie katalogu
// sprawdza dopiero main.js tuz przed spawnem (repo moze byc tylko na 1 maszynie).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'projects.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'projects.local.json');

// Awaryjna lista, gdy brak/uszkodzony config - zawsze mamy dokad wystartowac.
const FALLBACK = {
  activeProject: 'home',
  projects: [{ id: 'home', label: 'Home (~)', path: '~' }],
};

/** Bezpieczny odczyt + parse JSON. Zwraca null przy braku/bledzie. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // plik nie istnieje lub niepoprawny JSON
  }
}

/** Rozwija wiodace "~" na katalog domowy; zwraca znormalizowana sciezke. */
function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Waliduje i normalizuje pojedynczy wpis projektu. Zwraca obiekt lub null. */
function normalizeProject(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.id !== 'string' || !p.id) return null;
  if (typeof p.label !== 'string' || !p.label) return null;
  if (typeof p.path !== 'string' || !p.path) return null;
  return { id: p.id, label: p.label, path: path.normalize(expandHome(p.path)) };
}

/**
 * Laduje projekty: base (projects.json) scalony z local (projects.local.json).
 * Local moze nadpisac activeProject oraz dodac/podmienic projekt po id.
 * @returns {{projects: Array<{id:string,label:string,path:string}>, activeProject: string}}
 */
function loadProjects() {
  const base = readJson(BASE_FILE) || FALLBACK;
  const local = readJson(LOCAL_FILE);

  // Mapa po id, zeby local nadpisywal wpisy o tym samym id (zachowana kolejnosc).
  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.projects)) return;
    for (const raw of src.projects) {
      const p = normalizeProject(raw);
      if (p) byId.set(p.id, p);
    }
  };
  collect(base);
  collect(local);

  let projects = [...byId.values()];
  if (projects.length === 0) {
    projects = [{ id: 'home', label: 'Home (~)', path: os.homedir() }];
  }

  // activeProject: local > base > pierwszy dostepny.
  let activeProject =
    (local && typeof local.activeProject === 'string' && local.activeProject) ||
    (typeof base.activeProject === 'string' && base.activeProject) ||
    projects[0].id;
  if (!byId.has(activeProject)) activeProject = projects[0].id;

  return { projects, activeProject };
}

/** Zwraca projekt po id (lub null). */
function getProject(projects, id) {
  return projects.find((p) => p.id === id) || null;
}

module.exports = { loadProjects, getProject };
