// ============================================================================
// LunaCore - Sciagawka skilli wg kategorii (7A)
// ----------------------------------------------------------------------------
// Auto-skan katalogow skilli Claude Code: znajduje pliki SKILL.md, czyta z
// frontmatter `name` i `description`, i grupuje skille heurystycznie w kategorie
// (FRONTEND / BACKEND / DevOps / Testy / Data-ML / Security / Git / Docs / Inne).
//
// Read-only, czysto lokalne - zero tokenow. Wynik cache'owany po pierwszym skanie.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Katalogi, w ktorych szukamy SKILL.md (rekursywnie, z limitem glebokosci).
const SCAN_ROOTS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.claude', 'plugins'),
];
const MAX_DEPTH = 7;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out']);

// Kategorie w kolejnosci dopasowania (pierwsze trafienie wygrywa). Slowa-klucze
// szukane w nazwie + opisie + sciezce skilla (lowercase).
const CATEGORIES = [
  { name: 'Frontend', keys: ['frontend', 'react', 'vue', 'svelte', 'css', 'tailwind', 'ui', 'ux', 'component', 'landing', 'motion', 'animation', 'design'] },
  { name: 'Backend', keys: ['backend', 'api', 'server', 'endpoint', 'fastapi', 'django', 'express', 'rest', 'graphql', 'microservice'] },
  { name: 'Data / ML', keys: ['machine learning', ' ml ', 'mlops', 'model', 'dataset', 'pytorch', 'tensor', 'embedding', 'llm', 'graph', 'data ', 'pandas'] },
  { name: 'DevOps / Deploy', keys: ['deploy', 'docker', 'kubernetes', 'k8s', 'terraform', 'ci/cd', 'pipeline', 'infra', 'cloud', 'aws', 'vercel'] },
  { name: 'Testy', keys: ['test', 'tdd', 'e2e', 'playwright', 'jest', 'pytest', 'coverage', 'qa'] },
  { name: 'Security', keys: ['security', 'auth', 'owasp', 'vulnerab', 'secret', 'crypto', 'pentest'] },
  { name: 'Database', keys: ['database', 'sql', 'postgres', 'mysql', 'mongo', 'redis', 'migration', 'schema'] },
  { name: 'Git / Review', keys: ['git', 'commit', 'pull request', ' pr ', 'review', 'branch', 'merge'] },
  { name: 'Docs', keys: ['documentation', 'docs', 'readme', 'markdown', 'changelog'] },
];
const FALLBACK_CATEGORY = 'Inne';

/** Rekursywnie zbiera sciezki plikow SKILL.md w danym korzeniu. */
function findSkillFiles(root, depth, acc) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // katalog nie istnieje / brak dostepu
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      findSkillFiles(path.join(root, e.name), depth + 1, acc);
    } else if (e.name.toLowerCase() === 'skill.md') {
      acc.push(path.join(root, e.name));
    }
  }
}

/** Wyciaga name + description z frontmatter SKILL.md. */
function parseSkill(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').slice(0, 4096); // frontmatter jest na gorze
  } catch {
    return null;
  }
  const nameM = text.match(/^name:\s*(.+?)\s*$/m);
  const descM = text.match(/^description:\s*(.+?)\s*$/m);
  // Nazwa z frontmatter, a jak brak - z nazwy katalogu skilla.
  const name = (nameM && stripQuotes(nameM[1])) || path.basename(path.dirname(file));
  const description = descM ? stripQuotes(descM[1]) : '';
  return { name, description, file };
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '').trim();
}

/** Dobiera kategorie po slowach-kluczach (name + description + sciezka). */
function categorize(skill) {
  const hay = ` ${skill.name} ${skill.description} ${skill.file} `.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keys.some((k) => hay.includes(k))) return cat.name;
  }
  return FALLBACK_CATEGORY;
}

/**
 * Skanuje katalogi skilli i zwraca skille pogrupowane w kategorie.
 * @returns {{categories: Array<{name:string, skills:Array}>, total:number}}
 */
function scanSkills() {
  const files = [];
  for (const root of SCAN_ROOTS) findSkillFiles(root, 0, files);

  // Parsuj + deduplikuj po nazwie (ta sama skill moze byc w kilku miejscach).
  const byName = new Map();
  for (const file of files) {
    const skill = parseSkill(file);
    if (skill && skill.name && !byName.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }

  // Grupuj w kategorie (zachowana kolejnosc CATEGORIES + Inne na koncu).
  const groups = new Map();
  for (const cat of CATEGORIES) groups.set(cat.name, []);
  groups.set(FALLBACK_CATEGORY, []);
  for (const skill of byName.values()) {
    groups.get(categorize(skill)).push({ name: skill.name, description: skill.description });
  }

  const categories = [...groups.entries()]
    .filter(([, skills]) => skills.length > 0)
    .map(([name, skills]) => ({
      name,
      skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    }));

  return { categories, total: byName.size };
}

// Cache - skan robimy raz (katalogi skilli nie zmieniaja sie w trakcie sesji).
let cache = null;

/** Zwraca (i cache'uje) wynik skanu. */
function loadSkills() {
  if (!cache) cache = scanSkills();
  return cache;
}

module.exports = { loadSkills, scanSkills };
