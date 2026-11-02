// ============================================================================
// LunaCore - Luna sync launch glue (main process)
// ----------------------------------------------------------------------------
// docs/DONE_FREE_PROVIDERS_SYNC_PLAN.md, S3. Two jobs:
//   - the picked plugin skills (config/lunasync.local.json, gitignored), which
//     the Settings picker writes over IPC - so validated here, at the boundary;
//   - lunaLaunchFor(): whether a tab gets a Luna overlay, and building it.
// Only a NATIVE Codex/Gemini profile with `lunaSync: true` ever does; for any
// other tab this returns null and nothing is read or written.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const { readClaudeSetup, syncOverlay, overlayEnv } = require('./lunasyncio');
const { projectLayerFor } = require('./lunasyncproject');
const { overlayFingerprint, syncIfChanged } = require('./lunasyncfingerprint');
const { DEFAULT_GATEWAY_PORT } = require('./freellmgateway');

/** `<plugin>:<skill>`, both halves a safe folder-ish name (src/lunasyncio.js listPluginSkills ids). */
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}:[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Upper bound on picked skills - far above any sane pick, low enough to keep the file small. */
const MAX_PICKED = 500;

/** CLIs that have an overlay layout. */
const SYNC_CLIS = new Set(['codex', 'gemini']);

/** What a gateway home gets with the Luna switch off: nothing from ~/.claude. */
const EMPTY_SETUP = Object.freeze({ globalMd: '', rules: [], personalSkills: [], plugins: [], mcpServers: {} });

const prefsFile = () => paths.local('lunasync.local.json');

/**
 * Unique, valid `<plugin>:<skill>` ids, capped at MAX_PICKED.
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizePickedSkills(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  // An IPC payload: never walk an arbitrarily long array.
  for (const id of list.slice(0, MAX_PICKED * 4)) {
    if (typeof id === 'string' && SKILL_ID_RE.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_PICKED) break;
  }
  return out;
}

/**
 * @param {string} [file]
 * @returns {{pickedSkills:string[]}} an empty list for a missing/broken file
 */
function loadLunaSyncPrefs(file = prefsFile()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { pickedSkills: normalizePickedSkills(raw && raw.pickedSkills) };
  } catch {
    return { pickedSkills: [] };
  }
}

/**
 * Validates and saves (tmp + rename).
 * @param {{pickedSkills?:unknown}} prefs
 * @param {string} [file]
 * @returns {{ok:true, prefs:{pickedSkills:string[]}}|{ok:false, reason:'save-failed'}}
 */
function saveLunaSyncPrefs(prefs, file = prefsFile()) {
  const clean = { pickedSkills: normalizePickedSkills(prefs && prefs.pickedSkills) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ok: true, prefs: clean };
  } catch {
    return { ok: false, reason: 'save-failed' };
  }
}

/**
 * Builds the overlay for one tab, when it should have one. Skips the rebuild
 * (src/lunasyncfingerprint.js) when no input changed since the last good one.
 * @param {{profile:Object, template:Object|null, overlayBase:string, pickedSkillIds?:string[],
 *   gatewayPort?:number, claudeHome?:string, claudeJson?:string,
 *   readSetup?:Function, sync?:Function}} args readSetup/sync/claude paths are injectable for tests
 * @returns {null|ReturnType<typeof syncOverlay>} null = this tab runs without an overlay
 */
function lunaLaunchFor({
  profile,
  template,
  overlayBase,
  pickedSkillIds = [],
  gatewayPort = DEFAULT_GATEWAY_PORT,
  claudeHome = path.join(os.homedir(), '.claude'),
  claudeJson = path.join(os.homedir(), '.claude.json'),
  readSetup = () => readClaudeSetup({ claudeHome, claudeJson }),
  sync = syncOverlay,
  projectDir = null,
  projectLayer = projectLayerFor,
}) {
  if (!profile || !template || template.wireVia !== 'native' || !SYNC_CLIS.has(template.command)) return null;
  const cli = template.command;
  const lunaOn = profile.lunaSync === true;
  // A gateway template (FreeLLMAPI Gemini) ALWAYS runs on its own home, pinned
  // to API-key auth - the user's own ~/.gemini may be set to Google login,
  // which wins over every env var. The Luna setup goes in only when switched on.
  const gatewayHome = template.gatewayHome === true;
  if (!gatewayHome && !lunaOn) return null;
  const options = {
    cli,
    overlayRoot: path.join(overlayBase, gatewayHome ? `${cli}-${template.id}` : cli),
    pickedSkillIds: lunaOn ? [...pickedSkillIds].sort() : [],
    ...(gatewayHome ? { geminiAuthType: cli === 'gemini' ? 'gemini-api-key' : undefined } : {}),
  };
  const fingerprint = overlayFingerprint({
    options: { ...options, lunaOn, gatewayPort },
    claudeHome,
    claudeJson,
    withSources: lunaOn,
  });
  const result = syncIfChanged({
    overlayRoot: options.overlayRoot,
    fingerprint,
    build: () => sync({ ...options, setup: lunaOn ? readSetup() : EMPTY_SETUP }),
    env: overlayEnv(cli, options.overlayRoot),
    overlayFiles: (built) => overlayFilesOf(cli, options.overlayRoot, built.skills),
  });
  // The project's own servers (src/lunasyncproject.js): a per-tab layer on top
  // of the shared overlay, outside its fingerprint - so switching projects
  // never rebuilds the overlay or re-copies skills.
  if (!projectDir || !result || result.ok !== true) return result;
  if (!lunaOn) {
    // A gateway home with the switch off still runs on this overlay: a layer
    // left from when it was on must not keep loading the project's servers.
    projectLayer({ cli, overlayRoot: options.overlayRoot, projectDir, clear: true });
    return result;
  }
  const layer = projectLayer({
    cli,
    overlayRoot: options.overlayRoot,
    projectDir,
    baseServers: result.servers || [],
    profileArgs: Array.isArray(profile.args) ? profile.args : [],
    claudeHome,
    claudeJson,
  });
  if (!layer) return result;
  return {
    ...result,
    env: { ...result.env, ...(layer.env || {}) },
    args: layer.args || [],
    projectServers: layer.servers || [],
    skipped: [...(result.skipped || []), ...(layer.skipped || [])],
  };
}

/** Files (and skill folders) syncOverlay() writes; src/lunasyncio.js header has the layout. */
function overlayFilesOf(cli, overlayRoot, skills) {
  const configDir = cli === 'gemini' ? path.join(overlayRoot, '.gemini') : overlayRoot;
  const own = cli === 'gemini' ? ['GEMINI.md', 'settings.json'] : ['AGENTS.md', 'config.toml'];
  return [
    path.join(overlayRoot, '.lunacore-sync.json'),
    ...own.map((name) => path.join(configDir, name)),
    ...(Array.isArray(skills) ? skills : []).map((name) => path.join(configDir, 'skills', String(name))),
  ];
}

/** Dim cyan, so the line reads as LunaCore talking, not the CLI. */
const NOTICE_STYLE = { start: '\x1b[2;36m', end: '\x1b[0m' };

/** Why something was not carried over, in words (skip reasons from src/lunasync*.js). */
const SKIP_REASONS = {
  'connector-auth': { en: 'claude.ai connector - its login stays with Claude', pl: 'konektor claude.ai - logowanie zostaje w Claude' },
  'env-placeholder': { en: '${VAR} this CLI cannot fill', pl: '${VAR}, ktorego to CLI nie uzupelni' },
  'sse-unsupported': { en: 'SSE, not supported by Codex', pl: 'SSE, Codex tego nie obsluguje' },
  'name-taken': { en: 'name already used', pl: 'nazwa juz zajeta' },
  'not-approved': { en: 'not approved in Claude for this project', pl: 'niezatwierdzony w Claude dla tego projektu' },
  'disabled-in-claude': { en: 'disabled in Claude', pl: 'wylaczony w Claude' },
  'folder-not-trusted': { en: 'folder not trusted in Claude yet', pl: 'folder jeszcze niezaufany w Claude' },
  'profile-in-use': { en: 'the tab already sets --profile', pl: 'karta juz ustawia --profile' },
  'codex-legacy-profile': { en: 'overlay config.toml has a legacy profile', pl: 'config.toml overlayu ma stary profil' },
  'overlay-unreadable': { en: 'overlay file unreadable', pl: 'plik overlayu nieczytelny' },
  'copy-failed': { en: 'copy failed', pl: 'kopiowanie nie powiodlo sie' },
};

/** Names shown per skip reason before the rest are counted. */
const MAX_NAMES_PER_REASON = 8;

/** Printable name only: no escape sequences from a config file reach the terminal. */
const shownName = (name) => String(name).replace(/[^A-Za-z0-9._ :-]/g, '').slice(0, 60);
const shownNames = (names) => (names || []).filter((n) => /^[A-Za-z0-9._-]+$/.test(n)).join(', ');

function reasonText(reason, pl) {
  const code = String(reason || 'unknown');
  const known = SKIP_REASONS[code];
  if (known) return pl ? known.pl : known.en;
  if (code.startsWith('project-write-failed')) return pl ? 'nie udalo sie zapisac warstwy projektu' : 'could not write the project layer';
  return shownName(code);
}

/** `a, b (reason); c (reason)` - every skip, grouped by reason, in first-seen order. */
function skippedDetail(skipped, pl) {
  const groups = new Map();
  for (const s of skipped) {
    const key = String((s && s.reason) || 'unknown');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shownName(s && s.name));
  }
  return [...groups.entries()]
    .map(([reason, names]) => {
      const more = names.length > MAX_NAMES_PER_REASON ? ` +${names.length - MAX_NAMES_PER_REASON}` : '';
      return `${names.slice(0, MAX_NAMES_PER_REASON).join(', ')}${more} (${reasonText(reason, pl)})`;
    })
    .join('; ');
}

/**
 * Terminal line(s) saying what the Luna overlay loaded, or why it did not -
 * a failed sync starts the tab without the overlay, and must never be silent.
 * Every skipped skill/server/connector is named with its reason on a second line.
 * @param {{ok:boolean, reason?:string, skills?:string[], servers?:string[],
 *   projectServers?:string[], skipped?:Array}} result
 * @param {'pl'|'en'} lang
 * @returns {string}
 */
function lunaSyncNotice(result, lang) {
  const pl = lang === 'pl';
  const lines = [];
  if (!result || !result.ok) {
    const reason = (result && result.reason) || 'unknown';
    lines.push(pl
      ? `[LunaCore] Setup Luny NIE zostal wczytany (${reason}) - start bez niego.`
      : `[LunaCore] Luna setup not loaded (${reason}) - starting without it.`);
  } else {
    const skills = (result.skills || []).length;
    const servers = (result.servers || []).length;
    const project = (result.projectServers || []).length;
    const skipped = result.skipped || [];
    const tail = skipped.length ? (pl ? `, ${skipped.length} pominieto` : `, ${skipped.length} skipped`) : '';
    // Server NAMES, not just a count: these processes may run in this tab, so they must be visible.
    const names = servers ? ` (${shownNames(result.servers)})` : '';
    const projectPart = project ? (pl ? `, projekt: ${project} (${shownNames(result.projectServers)})` : `, project: ${project} (${shownNames(result.projectServers)})`) : '';
    lines.push(pl
      ? `[LunaCore] Setup Luny wczytany: ${skills} skilli, ${servers} serwerow MCP${names}${projectPart}${tail}.`
      : `[LunaCore] Luna setup loaded: ${skills} skills, ${servers} MCP servers${names}${projectPart}${tail}.`);
    if (skipped.length) lines.push(`[LunaCore] ${pl ? 'Pominieto' : 'Skipped'}: ${skippedDetail(skipped, pl)}.`);
  }
  return lines.map((text) => `${NOTICE_STYLE.start}${text}${NOTICE_STYLE.end}\r\n`).join('');
}

module.exports = { normalizePickedSkills, loadLunaSyncPrefs, saveLunaSyncPrefs, lunaLaunchFor, lunaSyncNotice };
