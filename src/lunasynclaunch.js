// ============================================================================
// LunaCore - Luna sync launch glue (main process)
// ----------------------------------------------------------------------------
// docs/FREE_PROVIDERS_SYNC_PLAN.md, S3. Two jobs:
//   - the picked plugin skills (config/lunasync.local.json, gitignored), which
//     the Settings picker writes over IPC - so validated here, at the boundary;
//   - lunaLaunchFor(): whether a tab gets a Luna overlay, and building it.
// Only a NATIVE Codex/Gemini profile with `lunaSync: true` ever does; for any
// other tab this returns null and nothing is read or written.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { readClaudeSetup, syncOverlay } = require('./lunasyncio');

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
 * Builds the overlay for one tab, when it should have one.
 * @param {{profile:Object, template:Object|null, overlayBase:string, pickedSkillIds?:string[],
 *   readSetup?:Function, sync?:Function}} args readSetup/sync are injectable for tests
 * @returns {null|ReturnType<typeof syncOverlay>} null = this tab runs without an overlay
 */
function lunaLaunchFor({ profile, template, overlayBase, pickedSkillIds = [], readSetup = readClaudeSetup, sync = syncOverlay }) {
  if (!profile || !template || template.wireVia !== 'native' || !SYNC_CLIS.has(template.command)) return null;
  const cli = template.command;
  const lunaOn = profile.lunaSync === true;
  // A gateway template (FreeLLMAPI Gemini) ALWAYS runs on its own home, pinned
  // to API-key auth - the user's own ~/.gemini may be set to Google login,
  // which wins over every env var. The Luna setup goes in only when switched on.
  if (template.gatewayHome === true) {
    return sync({
      cli,
      overlayRoot: path.join(overlayBase, `${cli}-${template.id}`),
      setup: lunaOn ? readSetup() : EMPTY_SETUP,
      pickedSkillIds: lunaOn ? pickedSkillIds : [],
      geminiAuthType: cli === 'gemini' ? 'gemini-api-key' : undefined,
    });
  }
  if (!lunaOn) return null;
  return sync({ cli, overlayRoot: path.join(overlayBase, cli), setup: readSetup(), pickedSkillIds });
}

/** Dim cyan, so the line reads as LunaCore talking, not the CLI. */
const NOTICE_STYLE = { start: '\x1b[2;36m', end: '\x1b[0m' };

/**
 * One terminal line saying what the Luna overlay loaded, or why it did not -
 * a failed sync starts the tab without the overlay, and must never be silent.
 * @param {{ok:boolean, reason?:string, skills?:string[], servers?:string[], skipped?:Array}} result
 * @param {'pl'|'en'} lang
 * @returns {string}
 */
function lunaSyncNotice(result, lang) {
  const pl = lang === 'pl';
  let text;
  if (!result || !result.ok) {
    const reason = (result && result.reason) || 'unknown';
    text = pl
      ? `[LunaCore] Setup Luny NIE zostal wczytany (${reason}) - start bez niego.`
      : `[LunaCore] Luna setup not loaded (${reason}) - starting without it.`;
  } else {
    const skills = (result.skills || []).length;
    const servers = (result.servers || []).length;
    const skipped = (result.skipped || []).length;
    const tail = skipped ? (pl ? `, ${skipped} pominieto` : `, ${skipped} skipped`) : '';
    // Server NAMES, not just a count: these processes may run in this tab, so they must be visible.
    const names = servers ? ` (${result.servers.filter((n) => /^[A-Za-z0-9._-]+$/.test(n)).join(', ')})` : '';
    text = pl
      ? `[LunaCore] Setup Luny wczytany: ${skills} skilli, ${servers} serwerow MCP${names}${tail}.`
      : `[LunaCore] Luna setup loaded: ${skills} skills, ${servers} MCP servers${names}${tail}.`;
  }
  return `${NOTICE_STYLE.start}${text}${NOTICE_STYLE.end}\r\n`;
}

module.exports = { normalizePickedSkills, loadLunaSyncPrefs, saveLunaSyncPrefs, lunaLaunchFor, lunaSyncNotice };
