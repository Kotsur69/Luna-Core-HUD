// ============================================================================
// LunaCore - skill cheat-sheet by category (7A)
// ----------------------------------------------------------------------------
// Lists the skills a Claude Code session really loads with the CURRENT setup,
// reads `name` and `description` out of each SKILL.md frontmatter, and groups
// skills heuristically into categories (frontend / backend / devops / tests /
// data-ml / security / git-review / docs / other).
//
// What counts as loaded (Claude Code's user-level rules; project-level
// .claude/ skills and plugin switches are out of scope for this global widget):
//   * user skills: ~/.claude/skills/<name>/SKILL.md, one level deep only
//     (synced/ and learned/ hold nested copies the CLI does not load);
//   * plugin skills: only plugins switched on in settings(.local).json
//     `enabledPlugins`, at the installPath installed_plugins.json records -
//     never old cached versions or disabled plugins. Skill folders come from
//     plugin.json `skills`, else the marketplace entry's `skills` list, else
//     ./skills. Plugin skills are named `<plugin>:<skill>`, as you invoke them.
// A switched Claude setup (luna-setup profile) therefore shows its own count.
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

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULT_SKILL_PATHS = Object.freeze(['./skills']);
const SKILL_FILE = 'SKILL.md';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const defaultLog = (line) => console.error(line);

/** Parsed JSON, or null when the file is missing. A broken file is logged, then null. */
async function readJson(file, log) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') log(`[skills] cannot read ${file}: ${errText(err)}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    log(`[skills] broken JSON in ${file}: ${errText(err)}`);
    return null;
  }
}

async function isFile(p) {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false; // missing is the normal "not a skill" answer
  }
}

/** `dir` itself when it holds SKILL.md, else its direct subfolders that do. */
async function skillFilesIn(dir) {
  const own = path.join(dir, SKILL_FILE);
  if (await isFile(own)) return [own];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // folder missing / not readable: no skills there
  }
  // Symlinked/junctioned skill folders count too (Claude Code follows them):
  // the stat in isFile() decides whether a SKILL.md is really behind the link.
  const candidates = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(dir, e.name, SKILL_FILE));
  const found = await Promise.all(candidates.map(async (f) => ((await isFile(f)) ? f : null)));
  return found.filter(Boolean);
}

/** Resolves a manifest path under `root`; null when it would climb out of it. */
function insideRoot(root, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  const climbs = back === '..' || back.startsWith(`..${path.sep}`);
  return climbs || path.isAbsolute(back) ? null : abs;
}

const asList = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null);

/** Plugin keys switched on: settings.json, overridden by settings.local.json. */
async function enabledPluginKeys(claudeDir, log) {
  const merged = {};
  for (const name of ['settings.json', 'settings.local.json']) {
    const settings = await readJson(path.join(claudeDir, name), log);
    if (isObj(settings) && isObj(settings.enabledPlugins)) Object.assign(merged, settings.enabledPlugins);
  }
  return Object.keys(merged).filter((key) => merged[key] === true);
}

/** The install folder installed_plugins.json records for a key (user scope first). */
function installPathOf(registry, key) {
  const entries = isObj(registry) && isObj(registry.plugins) ? registry.plugins[key] : null;
  if (!Array.isArray(entries)) return null;
  const valid = entries.filter((e) => isObj(e) && typeof e.installPath === 'string' && e.installPath);
  const pick = valid.find((e) => e.scope === 'user') || valid[0];
  return pick ? pick.installPath : null;
}

/** Skill folders a plugin declares: plugin.json, else its marketplace entry, else ./skills. */
async function declaredSkillPaths(claudeDir, installPath, pluginName, marketplace, log) {
  const manifest = await readJson(path.join(installPath, '.claude-plugin', 'plugin.json'), log);
  const fromManifest = isObj(manifest) ? asList(manifest.skills) : null;
  if (fromManifest) return fromManifest;
  const catalogs = [path.join(installPath, '.claude-plugin', 'marketplace.json')];
  // A marketplace name is a folder name here: never let it climb out.
  const shared = insideRoot(path.join(claudeDir, 'plugins', 'marketplaces'), marketplace);
  if (shared) catalogs.push(path.join(shared, '.claude-plugin', 'marketplace.json'));
  for (const file of catalogs) {
    const catalog = await readJson(file, log);
    const plugins = isObj(catalog) && Array.isArray(catalog.plugins) ? catalog.plugins : [];
    const entry = plugins.find((p) => isObj(p) && p.name === pluginName);
    const fromEntry = entry ? asList(entry.skills) : null;
    if (fromEntry) return fromEntry;
  }
  return DEFAULT_SKILL_PATHS;
}

/** SKILL.md files of one enabled plugin, tagged with its `<plugin>:` prefix. */
async function pluginSkillFiles(claudeDir, registry, key, log) {
  const installPath = installPathOf(registry, key);
  if (!installPath) return [];
  const [pluginName, marketplace = ''] = key.split('@');
  const rels = await declaredSkillPaths(claudeDir, installPath, pluginName, marketplace, log);
  const dirs = rels.map((rel) => insideRoot(installPath, rel)).filter(Boolean);
  const files = (await Promise.all(dirs.map(skillFilesIn))).flat();
  return files.map((file) => ({ file, prefix: `${pluginName}:` }));
}

/** [{file, prefix}] for every SKILL.md the current setup loads. */
async function loadedSkillFiles(claudeDir, log) {
  const userRoot = path.join(claudeDir, 'skills');
  // Only <root>/<name>/SKILL.md: a stray SKILL.md in the root itself is not a skill.
  const userFiles = (await skillFilesIn(userRoot)).filter((f) => path.dirname(path.dirname(f)) === userRoot);
  const registry = await readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'), log);
  const keys = await enabledPluginKeys(claudeDir, log);
  const perPlugin = await Promise.all(keys.map((key) => pluginSkillFiles(claudeDir, registry, key, log)));
  return userFiles.map((file) => ({ file, prefix: '' })).concat(perPlugin.flat());
}

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

/** Extracts name + description from a SKILL.md frontmatter block. */
async function parseSkill({ file, prefix }, log) {
  let text;
  try {
    text = (await fs.promises.readFile(file, 'utf8')).slice(0, 4096); // frontmatter is at the top
  } catch (err) {
    log(`[skills] cannot read ${file}: ${errText(err)}`);
    return null;
  }
  const nameM = text.match(/^name:\s*(.+?)\s*$/m);
  const descM = text.match(/^description:\s*(.+?)\s*$/m);
  // Name from the frontmatter, falling back to the skill's directory name.
  const name = (nameM && stripQuotes(nameM[1])) || path.basename(path.dirname(file));
  const description = descM ? stripQuotes(descM[1]) : '';
  return { name: `${prefix}${name}`, description, file };
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
 * @param {{claudeDir?: string, log?: (line: string) => void}} [opts]
 *   claudeDir defaults to ~/.claude (injectable for tests).
 * @returns {Promise<{categories: Array<{id:string, skills:Array}>, total:number}>}
 */
async function scanSkills({ claudeDir = DEFAULT_CLAUDE_DIR, log = defaultLog } = {}) {
  const files = await loadedSkillFiles(claudeDir, log);

  // Parse + dedupe by name (two plugin paths may point at the same skill).
  const parsed = await Promise.all(files.map((f) => parseSkill(f, log)));
  const byName = new Map();
  for (const skill of parsed) {
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

// Cache is the PROMISE, not the resolved value: this dedupes concurrent
// callers that land while a scan is still in flight (first IPC call during
// startup, plus whatever else asks before it resolves), so two callers never
// trigger two walks.
let cachePromise = null;

/** Returns (and caches) the scan result. */
function loadSkills() {
  if (!cachePromise) cachePromise = scanSkills();
  return cachePromise;
}

/** Forces a fresh scan (rescan button - A5), replacing the cache. */
function rescanSkills() {
  cachePromise = scanSkills();
  return cachePromise;
}

// categorize is pure (object -> category name) - exported for the tests.
module.exports = { loadSkills, rescanSkills, scanSkills, categorize };
