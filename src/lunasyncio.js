// ============================================================================
// LunaCore - Luna sync file I/O: read ~/.claude, write an overlay home
// ----------------------------------------------------------------------------
// docs/DONE_FREE_PROVIDERS_SYNC_PLAN.md, S2. readClaudeSetup() only READS the
// user's Claude setup; syncOverlay() only WRITES inside the overlay root it is
// given (LunaCore's userData) and refuses any root that is, contains, or sits
// inside a real CLI home (~/.claude, ~/.codex, ~/.gemini, ~/.agents). The
// translation itself lives in src/lunasync.js.
//
// The overlay is shared with the other CLI (its login, trust, memories, own
// skills live there too). So: everything is read and computed BEFORE the first
// write, a file that exists but cannot be read or parsed is a refusal - never
// "treat as empty and overwrite" - and every write is tmp + rename.
//
// Overlay layout (verified live, plan S0):
//   gemini: <root>/.gemini/{GEMINI.md, settings.json, skills/}  GEMINI_CLI_HOME=<root>
//   codex:  <root>/{AGENTS.md, config.toml, skills/}            CODEX_HOME=<root>
//   both:   <root>/luna-rules/   copies of the referenced rule files
//   both:   <root>/.lunacore-sync.json   skill folders + Codex servers LunaCore wrote
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildInstructions,
  upsertManagedBlock,
  normalizeMcpServers,
  geminiSettings,
  codexConfigMerge,
  isSafeSkillName,
  stripBom,
} = require('./lunasync');

const MANIFEST = '.lunacore-sync.json';
const RULES_DIR = 'luna-rules';

/** Personal-skill subfolders that are not the user's own skills (claude.ai-synced Anthropic skills). */
const SKIPPED_SKILL_DIRS = new Set(['synced']);

/** Never copied along with a skill folder. */
const SKIPPED_COPY_NAMES = new Set(['.git', 'node_modules']);

/** Rule files under a `common/` folder (or at the rules root) go inline; the rest are referenced. */
const INLINE_RULE_RE = /(^|\/)common\/[^/]+$|^[^/]+$/;

/** A one-file skill must open with frontmatter that names it. */
const SKILL_FRONTMATTER_RE = /^---\r?\n(?:.*\r?\n)*?name:\s*\S/;

/** Home folders of the CLIs an overlay must never be, contain, or live inside. */
const CLI_HOME_DIRS = ['.claude', '.codex', '.gemini', '.agents'];

const LAYOUT = {
  gemini: { configDir: '.gemini', instructions: 'GEMINI.md', envKey: 'GEMINI_CLI_HOME' },
  codex: { configDir: '', instructions: 'AGENTS.md', envKey: 'CODEX_HOME' },
};

/** A refusal with a typed reason, thrown inside syncOverlay() and turned into its result. */
class OverlayRefusal extends Error {
  constructor(reason, detail) {
    super(detail || reason);
    this.reason = reason;
  }
}

// ---- reading the SOURCE setup (missing = empty, never throws) -----------------

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Directory test that follows symlinks (personal skills are often links into ~/.agents/skills). */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Every .md file under `dir`, as `{rel, abs}` with forward-slash rels, sorted. Symlink cycles are visited once. */
function listMarkdown(dir) {
  const out = [];
  const seen = new Set();
  const walk = (d) => {
    const real = realOrSelf(d);
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of listDir(d)) {
      const full = path.join(d, entry.name);
      if (isDir(full)) walk(full);
      else if (entry.name.endsWith('.md')) out.push({ rel: path.relative(dir, full).split(path.sep).join('/'), abs: full });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Folders directly under `dir` that hold a SKILL.md. */
function skillDirsIn(dir) {
  return listDir(dir)
    .filter((e) => isSafeSkillName(e.name) && isDir(path.join(dir, e.name)))
    .filter((e) => fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => ({ name: e.name, kind: 'dir', path: path.join(dir, e.name) }));
}

/** One-file skills (`<name>.md` with skill frontmatter) directly in a group folder. */
function skillFilesIn(dir) {
  return listDir(dir)
    .filter((e) => e.name.endsWith('.md') && !isDir(path.join(dir, e.name)))
    .map((e) => ({ name: e.name.replace(/\.md$/, ''), path: path.join(dir, e.name) }))
    .filter((s) => isSafeSkillName(s.name) && SKILL_FRONTMATTER_RE.test(readText(s.path)))
    .map((s) => ({ ...s, kind: 'file' }));
}

/** The user's own skills: `~/.claude/skills/<name>/SKILL.md`, plus one level of grouping folders (e.g. `learned/`). */
function readPersonalSkills(skillsDir) {
  const skills = skillDirsIn(skillsDir);
  for (const entry of listDir(skillsDir)) {
    const group = path.join(skillsDir, entry.name);
    if (SKIPPED_SKILL_DIRS.has(entry.name) || !isDir(group) || fs.existsSync(path.join(group, 'SKILL.md'))) continue;
    skills.push(...skillDirsIn(group), ...skillFilesIn(group));
  }
  return skills;
}

/** Enabled plugins with their newest install path. */
function readPlugins(claudeHome) {
  const settings = readJson(path.join(claudeHome, 'settings.json')) || {};
  const enabled = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  const installed = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json')) || {};
  const registry = installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : {};
  const plugins = [];
  for (const [id, installs] of Object.entries(registry)) {
    if (enabled[id] !== true || !Array.isArray(installs)) continue;
    const newest = installs
      .filter((i) => i && typeof i.installPath === 'string')
      .sort((a, b) => String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || '')))[0];
    if (newest) plugins.push({ id, name: id.split('@')[0], installPath: newest.installPath });
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Reads the parts of a Claude Code setup the sync carries over. Never throws:
 * a missing file just contributes nothing. The result holds MCP env/header
 * values - keep it in the main process, never send it over IPC.
 * @param {{claudeHome?:string, claudeJson?:string}} [opts] default ~/.claude and ~/.claude.json
 * @returns {{globalMd:string, rules:Array<{rel:string,abs:string}>, personalSkills:Array,
 *   plugins:Array<{id:string,name:string,installPath:string}>, mcpServers:Object}}
 */
function readClaudeSetup({ claudeHome = path.join(os.homedir(), '.claude'), claudeJson = path.join(os.homedir(), '.claude.json') } = {}) {
  const plugins = readPlugins(claudeHome);
  const pluginServers = {};
  for (const plugin of plugins) {
    const raw = readJson(path.join(plugin.installPath, '.mcp.json'));
    const map = raw && raw.mcpServers ? raw.mcpServers : raw;
    Object.assign(pluginServers, normalizeMcpServers(map, { pluginRoot: plugin.installPath.split(path.sep).join('/') }));
  }
  const userJson = readJson(claudeJson) || {};
  return {
    globalMd: readText(path.join(claudeHome, 'CLAUDE.md')),
    rules: listMarkdown(path.join(claudeHome, 'rules')),
    personalSkills: readPersonalSkills(path.join(claudeHome, 'skills')),
    plugins,
    // The user's own servers win a name clash with a plugin's.
    mcpServers: { ...pluginServers, ...normalizeMcpServers(userJson.mcpServers) },
  };
}

/**
 * Skills of the enabled plugins, for the Settings picker.
 * @returns {Array<{id:string, plugin:string, name:string, path:string}>} id = `<plugin>:<skill>`
 */
function listPluginSkills(setup) {
  return setup.plugins.flatMap((plugin) =>
    skillDirsIn(path.join(plugin.installPath, 'skills')).map((s) => ({
      id: `${plugin.name}:${s.name}`,
      plugin: plugin.id,
      name: s.name,
      path: s.path,
    })),
  );
}

/** Env vars that point a CLI at its overlay home, or null for a CLI without one. */
function overlayEnv(cli, overlayRoot) {
  const layout = LAYOUT[cli];
  return layout ? { [layout.envKey]: overlayRoot } : null;
}

// ---- the OVERLAY: guarded root, strict reads, atomic writes -------------------

/** Case-folds on Windows, where the filesystem does. */
function samePathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `child` is strictly inside `parent`. */
function isInside(child, parent) {
  const rel = path.relative(samePathKey(parent), samePathKey(child));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True for a root that is, contains, or sits inside a real CLI home - or is the home itself. */
function isForbiddenRoot(root, homeDir) {
  const cliHomes = CLI_HOME_DIRS.map((d) => path.join(homeDir, d));
  const key = samePathKey(root);
  if ([homeDir, ...cliHomes].some((p) => samePathKey(p) === key)) return true;
  if ([homeDir, ...cliHomes].some((p) => isInside(p, root))) return true;
  return cliHomes.some((p) => isInside(root, p));
}

/** An overlay file's text: '' when it does not exist yet, a refusal when it exists but cannot be read. */
function readOverlayText(file) {
  try {
    return stripBom(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw new OverlayRefusal('overlay-unreadable', `${path.basename(file)}: ${err && err.code}`);
  }
}

/** An overlay JSON file: null when missing, a refusal when present but not plain JSON (e.g. JSONC). */
function readOverlayJson(file) {
  const text = readOverlayText(file);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new OverlayRefusal('overlay-unreadable', `${path.basename(file)}: not plain JSON`);
  }
}

/** tmp + rename: a concurrent reader never sees half a file, and a symlinked target is replaced, not written through. */
function writeAtomic(file, text) {
  const tmp = `${file}.lunacore-tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Personal skills first, then picked plugin skills; first name wins, case-insensitively. */
function selectSkills(setup, pickedSkillIds) {
  const picked = new Set(Array.isArray(pickedSkillIds) ? pickedSkillIds : []);
  const chosen = new Map();
  const add = (s) => {
    const key = s.name.toLowerCase();
    if (!chosen.has(key)) chosen.set(key, s);
  };
  setup.personalSkills.forEach(add);
  for (const s of listPluginSkills(setup)) {
    if (picked.has(s.id)) add({ name: s.name, kind: 'dir', path: s.path });
  }
  return [...chosen.values()];
}

/**
 * Replaces the overlay's managed skill folders. A folder LunaCore did not
 * create (not in the previous manifest) is never removed or overwritten - the
 * skill is skipped as `name-taken` instead.
 * @returns {{copied:string[], skipped:Array}}
 */
function writeSkills(skillsDir, previous, skills) {
  for (const name of previous) {
    if (isSafeSkillName(name)) fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  const copied = [];
  const skipped = [];
  for (const skill of skills) {
    const dest = path.join(skillsDir, skill.name);
    if (fs.existsSync(dest)) {
      skipped.push({ kind: 'skill', name: skill.name, reason: 'name-taken' });
      continue;
    }
    try {
      if (skill.kind === 'file') {
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(skill.path, path.join(dest, 'SKILL.md'));
      } else {
        // The skill folder itself may be a link (into ~/.agents/skills); links
        // INSIDE it are never followed - one could point at any file on disk,
        // which would then be handed to a third-party CLI.
        const root = fs.realpathSync(skill.path);
        fs.cpSync(root, dest, {
          recursive: true,
          filter: (src) => src === root || (!SKIPPED_COPY_NAMES.has(path.basename(src)) && !fs.lstatSync(src).isSymbolicLink()),
        });
      }
      copied.push(skill.name);
    } catch {
      // A half-copied folder is not in the manifest, so remove it now or it would be orphaned.
      fs.rmSync(dest, { recursive: true, force: true });
      skipped.push({ kind: 'skill', name: skill.name, reason: 'copy-failed' });
    }
  }
  return { copied, skipped };
}

/** Copies the referenced rule files into <root>/luna-rules and splits all rules into inline / referenced. */
function writeRules(overlayRoot, rules) {
  const rulesDir = path.join(overlayRoot, RULES_DIR);
  fs.rmSync(rulesDir, { recursive: true, force: true });
  const inlineRules = [];
  const referencedRules = [];
  for (const rule of rules) {
    if (INLINE_RULE_RE.test(rule.rel)) {
      inlineRules.push({ rel: rule.rel, text: readText(rule.abs) });
      continue;
    }
    const dest = path.join(rulesDir, ...rule.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(rule.abs, dest);
    referencedRules.push({ rel: rule.rel, path: dest.split(path.sep).join('/') });
  }
  return { inlineRules, referencedRules };
}

/** Everything the sync will write, computed from the current overlay without touching it. */
function planOverlay(cli, overlayRoot, setup, geminiAuthType) {
  const layout = LAYOUT[cli];
  const configDir = path.join(overlayRoot, layout.configDir);
  const manifest = readOverlayJson(path.join(overlayRoot, MANIFEST)) || {};
  const instructionsFile = path.join(configDir, layout.instructions);
  const instructionsBefore = readOverlayText(instructionsFile);
  // Validate the instructions block up front; the real body (with rule paths) is built after the rules are copied.
  if (upsertManagedBlock(instructionsBefore, '') === null) {
    throw new OverlayRefusal('overlay-damaged', `${layout.instructions}: LunaCore block has no end marker`);
  }
  const plan = {
    configDir,
    instructionsFile,
    instructionsBefore,
    previousSkills: Array.isArray(manifest.skills) ? manifest.skills : [],
  };
  if (cli === 'gemini') {
    const settingsFile = path.join(configDir, 'settings.json');
    const settings = geminiSettings(readOverlayJson(settingsFile), setup.mcpServers, { authType: geminiAuthType });
    return { ...plan, configFile: settingsFile, configText: `${JSON.stringify(settings, null, 2)}\n`, servers: Object.keys(setup.mcpServers), serverSkips: [] };
  }
  const configFile = path.join(configDir, 'config.toml');
  const owned = Array.isArray(manifest.codexServers) ? manifest.codexServers : [];
  const merged = codexConfigMerge(readOverlayText(configFile), setup.mcpServers, owned);
  return {
    ...plan,
    configFile,
    configText: merged.text,
    servers: merged.written,
    serverSkips: merged.skipped.map((s) => ({ kind: 'mcp', ...s })),
  };
}

/**
 * Builds (or refreshes) one CLI's overlay home from a Claude setup.
 * @param {{cli:'gemini'|'codex', overlayRoot:string, setup:Object, pickedSkillIds?:string[], homeDir?:string}} args
 * @returns {{ok:true, env:Object, skills:string[], servers:string[], skipped:Array<{kind:string,name:string,reason:string}>}
 *   |{ok:false, reason:'unknown-cli'|'invalid-root'|'forbidden-root'|'overlay-unreadable'|'overlay-damaged'|'write-failed', detail?:string}}
 */
function syncOverlay({ cli, overlayRoot, setup, pickedSkillIds = [], homeDir = os.homedir(), geminiAuthType }) {
  if (!LAYOUT[cli]) return { ok: false, reason: 'unknown-cli' };
  if (typeof overlayRoot !== 'string' || !path.isAbsolute(overlayRoot)) return { ok: false, reason: 'invalid-root' };
  if (isForbiddenRoot(overlayRoot, homeDir)) return { ok: false, reason: 'forbidden-root' };

  let plan;
  try {
    plan = planOverlay(cli, overlayRoot, setup, geminiAuthType);
  } catch (err) {
    if (err instanceof OverlayRefusal) return { ok: false, reason: err.reason, detail: err.message };
    return { ok: false, reason: 'overlay-unreadable', detail: err && err.message };
  }

  try {
    fs.mkdirSync(plan.configDir, { recursive: true });
    const { inlineRules, referencedRules } = writeRules(overlayRoot, setup.rules);
    // A gateway home with the Luna switch off gets an empty setup: no persona
    // block at all, rather than a "Luna setup" header with nothing under it.
    if (setup.globalMd.trim() || setup.rules.length) {
      const body = buildInstructions({ globalMd: setup.globalMd, inlineRules, referencedRules });
      writeAtomic(plan.instructionsFile, upsertManagedBlock(plan.instructionsBefore, body));
    }

    const skills = selectSkills(setup, pickedSkillIds);
    const manifestFile = path.join(overlayRoot, MANIFEST);
    // Record the intended folders first, so a crash mid-copy still leaves them owned (and cleaned next run).
    writeAtomic(manifestFile, JSON.stringify({ skills: skills.map((s) => s.name), codexServers: plan.servers }, null, 2));
    const { copied, skipped } = writeSkills(path.join(plan.configDir, 'skills'), plan.previousSkills, skills);
    writeAtomic(manifestFile, JSON.stringify({ skills: copied, codexServers: cli === 'codex' ? plan.servers : [] }, null, 2));

    writeAtomic(plan.configFile, plan.configText);

    return { ok: true, env: overlayEnv(cli, overlayRoot), skills: copied, servers: plan.servers, skipped: [...skipped, ...plan.serverSkips] };
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: err && err.code ? err.code : 'unknown' };
  }
}

module.exports = { readClaudeSetup, listPluginSkills, syncOverlay, overlayEnv };
