// ============================================================================
// LunaCore - skill cheat-sheet by category (7A)
// ----------------------------------------------------------------------------
// Auto-scans the Claude Code skill directories: finds SKILL.md files, reads
// `name` and `description` out of the frontmatter, and groups skills
// heuristically into categories (frontend / backend / devops / tests / data-ml /
// security / git-review / docs / other).
//
// Read-only and purely local - zero tokens. The result is cached after the
// first scan.
//
// NOTE: categories are emitted as language-neutral ids, never as display text.
// The renderer translates them through `skills.cat.<id>`.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Roots to search for SKILL.md (recursively, with a depth limit).
const SCAN_ROOTS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.claude', 'plugins'),
];
const MAX_DEPTH = 7;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out']);

// Categories in match order (first hit wins). Keywords are searched in the
// skill's name + description + file path (lowercased).
//
// `id` is a stable, language-neutral slug - NOT a display name. The renderer
// resolves it through i18n (`skills.cat.<id>`), which is what lets the category
// headers switch language with the rest of the HUD. Two of them used to be
// Polish literals ("Testy", "Inne") and showed up untranslated in the English
// UI; an id also means renaming a category for display never breaks a test.
const CATEGORIES = [
  { id: 'frontend', keys: ['frontend', 'react', 'vue', 'svelte', 'css', 'tailwind', 'ui', 'ux', 'component', 'landing', 'motion', 'animation', 'design'] },
  { id: 'backend', keys: ['backend', 'api', 'server', 'endpoint', 'fastapi', 'django', 'express', 'rest', 'graphql', 'microservice'] },
  { id: 'data-ml', keys: ['machine learning', ' ml ', 'mlops', 'model', 'dataset', 'pytorch', 'tensor', 'embedding', 'llm', 'graph', 'data ', 'pandas'] },
  { id: 'devops', keys: ['deploy', 'docker', 'kubernetes', 'k8s', 'terraform', 'ci/cd', 'pipeline', 'infra', 'cloud', 'aws', 'vercel'] },
  { id: 'tests', keys: ['test', 'tdd', 'e2e', 'playwright', 'jest', 'pytest', 'coverage', 'qa'] },
  { id: 'security', keys: ['security', 'auth', 'owasp', 'vulnerab', 'secret', 'crypto', 'pentest'] },
  { id: 'database', keys: ['database', 'sql', 'postgres', 'mysql', 'mongo', 'redis', 'migration', 'schema'] },
  { id: 'git-review', keys: ['git', 'commit', 'pull request', ' pr ', 'review', 'branch', 'merge'] },
  { id: 'docs', keys: ['documentation', 'docs', 'readme', 'markdown', 'changelog'] },
];
const FALLBACK_CATEGORY = 'other';

/** Recursively collects SKILL.md paths under a root. */
function findSkillFiles(root, depth, acc) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // directory missing / not readable
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

/** Extracts name + description from a SKILL.md frontmatter block. */
function parseSkill(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').slice(0, 4096); // frontmatter is at the top
  } catch {
    return null;
  }
  const nameM = text.match(/^name:\s*(.+?)\s*$/m);
  const descM = text.match(/^description:\s*(.+?)\s*$/m);
  // Name from the frontmatter, falling back to the skill's directory name.
  const name = (nameM && stripQuotes(nameM[1])) || path.basename(path.dirname(file));
  const description = descM ? stripQuotes(descM[1]) : '';
  return { name, description, file };
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '').trim();
}

/** Picks a category by keyword match (name + description + path). */
function categorize(skill) {
  const hay = ` ${skill.name} ${skill.description} ${skill.file} `.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keys.some((k) => hay.includes(k))) return cat.id;
  }
  return FALLBACK_CATEGORY;
}

/**
 * Scans the skill directories and returns skills grouped into categories.
 * `id` is a slug, not a label - the renderer translates it. See CATEGORIES.
 * @returns {{categories: Array<{id:string, skills:Array}>, total:number}}
 */
function scanSkills() {
  const files = [];
  for (const root of SCAN_ROOTS) findSkillFiles(root, 0, files);

  // Parse + dedupe by name (the same skill can live in several places).
  const byName = new Map();
  for (const file of files) {
    const skill = parseSkill(file);
    if (skill && skill.name && !byName.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }

  // Group into categories (CATEGORIES order preserved, fallback last).
  const groups = new Map();
  for (const cat of CATEGORIES) groups.set(cat.id, []);
  groups.set(FALLBACK_CATEGORY, []);
  for (const skill of byName.values()) {
    groups.get(categorize(skill)).push({ name: skill.name, description: skill.description });
  }

  const categories = [...groups.entries()]
    .filter(([, skills]) => skills.length > 0)
    .map(([id, skills]) => ({
      id,
      skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    }));

  return { categories, total: byName.size };
}

// Cache - we scan once (skill directories do not change mid-session).
let cache = null;

/** Returns (and caches) the scan result. */
function loadSkills() {
  if (!cache) cache = scanSkills();
  return cache;
}

// categorize is pure (object -> category name) - exported for the tests.
module.exports = { loadSkills, scanSkills, categorize };
