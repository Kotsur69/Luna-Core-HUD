// ============================================================================
// LunaCore - mirror the applied Claude setup into Antigravity (agy)
// ----------------------------------------------------------------------------
// After `luna-setup use <profile>` rewrites ~/.claude (src/claudesetup.js),
// this module writes the agy equivalents into agy's machine-wide config, so
// both CLIs follow the same setup. Where agy reads its global config (checked
// against agy's built-in `agy-customizations` docs and its changelog):
//
//   ~/.gemini/config/AGENTS.md          global rules (always on). agy also
//                                       reads ~/.gemini/GEMINI.md, but Gemini
//                                       CLI reads that one too - this file is
//                                       agy's alone.
//   ~/.gemini/config/mcp_config.json    {"mcpServers": {...}}
//   ~/.gemini/config/skills/<name>/     SKILL.md folders
//
// What LunaCore writes, and nothing else:
//   * AGENTS.md: one marked block (src/lunasync.js upsertManagedBlock) with
//     ~/.claude/CLAUDE.md, the always-loaded rules inline (no `paths:`
//     frontmatter) and pointers to the path-scoped ones. Text outside the
//     block is never touched; a block without its end marker is a refusal.
//   * mcp_config.json: the user-level Claude servers (~/.claude.json
//     `mcpServers`). Ownership is by NAME, recorded in the manifest - agy's
//     schema has no room for a tag key. A name the user already has is left
//     alone and reported as `name-taken`; a managed server the user disabled
//     in agy stays disabled.
//   * skills: copies of ~/.claude/skills (src/lunasyncio.js writeSkills); only
//     folders named in the manifest are ever removed.
//   * ~/.gemini/config/.lunacore-mirror.json: the manifest (owned server and
//     skill names, the profile mirrored and when).
//
// Safety: every file is read and every change computed before the first
// write. A target that exists but cannot be read, or JSON that does not
// parse, is a refusal - never "treat as empty and overwrite". Each target
// gets a one-time backup in ~/.gemini/lunacore-backup/ before LunaCore first
// changes it, and every write is temp file + rename. Nothing is created when
// agy is not installed (~/.gemini/config or ~/.gemini/antigravity-cli).
//
// The on/off setting lives in LunaCore's own config dir (agy-mirror.local.json),
// not in ~/.gemini. With no setting saved it is on exactly when agy is found.
// Results hold names and counts only, never MCP env/header values.
// ============================================================================

'use strict';

const nodeFs = require('fs');
const os = require('os');
const path = require('path');
const { buildInstructions, upsertManagedBlock, normalizeMcpServers, stripBom } = require('./lunasync');
const { readClaudeSetup, writeSkills } = require('./lunasyncio');

const AGY_HOME = '.gemini';
const AGY_CONFIG = 'config';
const AGY_CLI_DIR = 'antigravity-cli';
const RULES_FILE = 'AGENTS.md';
const MCP_FILE = 'mcp_config.json';
const SKILLS_DIR = 'skills';
const MANIFEST_FILE = '.lunacore-mirror.json';
const BACKUP_DIR = 'lunacore-backup';
const SETTINGS_FILE = 'agy-mirror.local.json';
const SETUP_STATE = ['.claude', 'luna-setup', 'state.json'];

/** agy truncates a rule file past this many bytes (agy-customizations docs, rules.md). */
const RULES_BYTE_CAP = 24000;
const MANIFEST_VERSION = 1;
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const MAX_NAMES = 500;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errCode = (err) => (err && typeof err.code === 'string' ? err.code : err instanceof Error ? err.message : String(err));

/** A planned refusal: the code the caller reports, plus a short detail (a file name). */
class MirrorRefusal extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail || '';
  }
}

/** All the paths, from one home dir. */
function layoutFor(home) {
  const agyHome = path.join(home, AGY_HOME);
  const config = path.join(agyHome, AGY_CONFIG);
  return {
    agyHome,
    config,
    cliDir: path.join(agyHome, AGY_CLI_DIR),
    rules: path.join(config, RULES_FILE),
    mcp: path.join(config, MCP_FILE),
    skills: path.join(config, SKILLS_DIR),
    manifest: path.join(config, MANIFEST_FILE),
    backups: path.join(agyHome, BACKUP_DIR),
    claudeHome: path.join(home, '.claude'),
    claudeJson: path.join(home, '.claude.json'),
    setupState: path.join(home, ...SETUP_STATE),
  };
}

/** True when a rule file opens with frontmatter that scopes it to `paths:` (Claude loads it on demand only). */
function isPathScoped(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(stripBom(text));
  return !!m && /^paths\s*:/m.test(m[1]);
}

/** A list of unique, plain names from untrusted JSON. */
function nameList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((n) => typeof n === 'string' && n && n.length <= 100))].slice(0, MAX_NAMES);
}

/** One neutral server (normalizeMcpServers) -> agy's mcp_config.json shape, or null when agy cannot run it. */
function toAgyServer(server, previous) {
  const disabled = isObj(previous) && previous.disabled === true ? { disabled: true } : {};
  if (server.kind === 'stdio') {
    const env = Object.keys(server.env).length ? { env: server.env } : {};
    return { command: server.command, args: server.args, ...env, ...disabled };
  }
  if (server.kind === 'http') {
    const headers = Object.keys(server.headers).length ? { headers: server.headers } : {};
    return { url: server.url, ...headers, ...disabled };
  }
  // agy speaks Streamable HTTP only; the legacy SSE transport is not supported.
  return null;
}

/**
 * Merges LunaCore's servers into agy's MCP config. Entries named in
 * `ownedNames` (what the previous sync wrote) are dropped and re-emitted;
 * every other entry and every other top-level key is kept as it was.
 * @param {Object|null} existing parsed mcp_config.json (null = none yet)
 * @param {Object<string,Object>} servers normalizeMcpServers() output
 * @param {string[]} ownedNames
 * @returns {{config:Object, written:string[], skipped:Array<{kind:string,name:string,reason:string}>}}
 */
function mergeMcpConfig(existing, servers, ownedNames) {
  const base = isObj(existing) ? existing : {};
  const current = isObj(base.mcpServers) ? base.mcpServers : {};
  const owned = new Set(ownedNames);
  // fromEntries defines own properties, so a "__proto__" key stays a plain key.
  const kept = Object.entries(current).filter(([name]) => !owned.has(name));
  const taken = new Set(kept.map(([name]) => name));
  const added = [];
  const written = [];
  const skipped = [];
  for (const [name, server] of Object.entries(servers)) {
    if (taken.has(name)) {
      skipped.push({ kind: 'mcp', name, reason: 'name-taken' });
      continue;
    }
    const previous = owned.has(name) && Object.prototype.hasOwnProperty.call(current, name) ? current[name] : null;
    const entry = toAgyServer(server, previous);
    if (!entry) {
      skipped.push({ kind: 'mcp', name, reason: 'sse-unsupported' });
      continue;
    }
    added.push([name, entry]);
    written.push(name);
  }
  return { config: { ...base, mcpServers: Object.fromEntries([...kept, ...added]) }, written, skipped };
}

/**
 * @param {{home?:string, fs?:typeof nodeFs, settingsFile?:string, now?:()=>Date,
 *   log?:(line:string)=>void, readSetup?:typeof readClaudeSetup,
 *   copySkills?:typeof writeSkills}} [deps]
 */
function createAgyMirror(deps = {}) {
  const fs = deps.fs || nodeFs;
  const home = deps.home || os.homedir();
  const now = deps.now || (() => new Date());
  const log = deps.log || ((line) => console.error(line));
  const readSetup = deps.readSetup || readClaudeSetup;
  const copySkills = deps.copySkills || writeSkills;
  const settingsFile = () => deps.settingsFile || require('./paths').local(SETTINGS_FILE);
  const p = layoutFor(home);
  let lastError = null;

  function exists(file) {
    try {
      return fs.existsSync(file);
    } catch (err) {
      log(`[agymirror] cannot check ${file}: ${errCode(err)}`);
      return false;
    }
  }

  /** A target's text: '' when missing, a refusal when present but unreadable. */
  function readTarget(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return '';
      throw new MirrorRefusal('unreadable', `${path.basename(file)} (${errCode(err)})`);
    }
  }

  /** A JSON object file: null when missing or empty, a refusal when it does not parse to an object. */
  function readJsonTarget(file, raw = readTarget(file)) {
    const text = stripBom(raw);
    if (!text.trim()) return null;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new MirrorRefusal('broken-json', path.basename(file));
    }
    if (!isObj(data)) throw new MirrorRefusal('broken-json', path.basename(file));
    return data;
  }

  function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.lunacore-tmp`;
    try {
      // A leftover from a crashed run would keep its old mode: remove it, then
      // create the temp file fresh ('wx') so the 0600 mode really applies.
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch (cleanupErr) {
        if (!cleanupErr || cleanupErr.code !== 'ENOENT') log(`[agymirror] could not remove ${tmp}: ${errCode(cleanupErr)}`);
      }
      throw err;
    }
  }

  /** Copies `file` into the backup folder once; a backup already there is the original and is kept. */
  function backupOnce(file, made) {
    if (!exists(file)) return;
    const rel = path.relative(p.agyHome, file).split(path.sep).join('__');
    const dest = path.join(p.backups, `${rel}.bak`);
    if (exists(dest)) return;
    fs.mkdirSync(p.backups, { recursive: true });
    fs.copyFileSync(file, dest, nodeFs.constants.COPYFILE_EXCL);
    // mcp_config.json holds MCP env/header values: the backup is owner-only too.
    fs.chmodSync(dest, 0o600);
    made.push(dest);
  }

  /** Is agy installed for this user? Its config root or its CLI data folder must exist. */
  function available() {
    return exists(p.config) || exists(p.cliDir);
  }

  /** The saved on/off, or null when never set. A broken settings file reads as off (and is logged). */
  function savedEnabled() {
    let text;
    try {
      text = fs.readFileSync(settingsFile(), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      log(`[agymirror] cannot read ${SETTINGS_FILE}: ${errCode(err)} - treating the mirror as off`);
      return false;
    }
    try {
      const data = JSON.parse(stripBom(text));
      if (isObj(data) && typeof data.enabled === 'boolean') return data.enabled;
    } catch {
      /* reported below */
    }
    log(`[agymirror] ${SETTINGS_FILE} is not valid - treating the mirror as off`);
    return false;
  }

  /** On when saved on; with nothing saved, on exactly when agy is installed. */
  function isEnabled() {
    const saved = savedEnabled();
    return saved === null ? available() : saved;
  }

  function setEnabled(on) {
    if (typeof on !== 'boolean') throw new TypeError('setEnabled expects a boolean');
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify({ enabled: on }, null, 2)}\n`);
  }

  /** The manifest, validated. Missing = nothing owned yet. */
  function readManifest() {
    const data = readJsonTarget(p.manifest) || {};
    return {
      servers: nameList(data.servers),
      skills: nameList(data.skills),
      profile: typeof data.profile === 'string' && PROFILE_RE.test(data.profile) ? data.profile : null,
      mirroredAt: typeof data.mirroredAt === 'string' ? data.mirroredAt.slice(0, 40) : null,
    };
  }

  /** The profile luna-setup last applied, or null. Only used for a manual sync. */
  function appliedProfile() {
    try {
      const data = JSON.parse(stripBom(fs.readFileSync(p.setupState, 'utf8')));
      return isObj(data) && typeof data.profile === 'string' && PROFILE_RE.test(data.profile) ? data.profile : null;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') log(`[agymirror] cannot read luna-setup state: ${errCode(err)}`);
      return null;
    }
  }

  /** User-level Claude servers. Missing file = none; a broken one is a refusal (it would drop every managed server). */
  function readClaudeServers() {
    let text;
    try {
      text = fs.readFileSync(p.claudeJson, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return {};
      throw new MirrorRefusal('source-unreadable', `.claude.json (${errCode(err)})`);
    }
    let data;
    try {
      data = JSON.parse(stripBom(text));
    } catch {
      throw new MirrorRefusal('source-unreadable', '.claude.json');
    }
    return normalizeMcpServers(isObj(data) ? data.mcpServers : null);
  }

  /** Always-loaded rules go inline; path-scoped ones become pointers to their ~/.claude file. */
  function splitRules(rules, skipped) {
    const inlineRules = [];
    const referencedRules = [];
    for (const rule of rules) {
      let text;
      try {
        text = fs.readFileSync(rule.abs, 'utf8');
      } catch (err) {
        skipped.push({ kind: 'rule', name: rule.rel, reason: 'unreadable' });
        log(`[agymirror] skipped rule ${rule.rel}: ${errCode(err)}`);
        continue;
      }
      if (isPathScoped(text)) referencedRules.push({ rel: rule.rel, path: rule.abs.split(path.sep).join('/') });
      else inlineRules.push({ rel: rule.rel, text });
    }
    return { inlineRules, referencedRules };
  }

  /**
   * A folder LunaCore writes or deletes in must be a real folder: through a
   * symlink or junction, a managed skill removal would land in its target.
   */
  function refuseLinked(dir) {
    let stat;
    try {
      stat = fs.lstatSync(dir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw new MirrorRefusal('unreadable', `${path.basename(dir)} (${errCode(err)})`);
    }
    if (stat.isSymbolicLink()) throw new MirrorRefusal('linked-folder', path.relative(p.agyHome, dir).split(path.sep).join('/'));
  }

  /** Reads everything and computes every write. Throws MirrorRefusal; writes nothing. */
  function plan(profile) {
    // A linked AGENTS.md or mcp_config.json would be replaced by a plain file
    // (temp + rename); a linked folder would take deletions into its target.
    for (const target of [p.config, p.skills, p.rules, p.mcp, p.manifest]) refuseLinked(target);
    const manifest = readManifest();
    const setup = readSetup({ claudeHome: p.claudeHome, claudeJson: p.claudeJson });
    const servers = readClaudeServers();
    const skipped = [];
    const warnings = [];

    const rulesBefore = readTarget(p.rules);
    const { inlineRules, referencedRules } = splitRules(Array.isArray(setup.rules) ? setup.rules : [], skipped);
    const body = buildInstructions({ globalMd: setup.globalMd, inlineRules, referencedRules });
    const rulesText = upsertManagedBlock(rulesBefore, body);
    if (rulesText === null) throw new MirrorRefusal('block-damaged', RULES_FILE);
    if (Buffer.byteLength(rulesText, 'utf8') > RULES_BYTE_CAP) warnings.push(`${RULES_FILE} is over ${RULES_BYTE_CAP} bytes; agy truncates it`);

    const mcpBefore = readTarget(p.mcp);
    const mcpData = readJsonTarget(p.mcp, mcpBefore);
    if (mcpData && mcpData.mcpServers !== undefined && !isObj(mcpData.mcpServers)) throw new MirrorRefusal('broken-json', MCP_FILE);
    const merged = mergeMcpConfig(mcpData, servers, manifest.servers);
    skipped.push(...merged.skipped);

    return {
      profile,
      manifest,
      skills: Array.isArray(setup.personalSkills) ? setup.personalSkills : [],
      rules: { before: rulesBefore, text: rulesText },
      mcp: { before: mcpBefore, text: `${JSON.stringify(merged.config, null, 2)}\n`, written: merged.written },
      skipped,
      warnings,
    };
  }

  function writeManifest(data) {
    writeAtomic(p.manifest, `${JSON.stringify({ v: MANIFEST_VERSION, ...data }, null, 2)}\n`);
  }

  /** Applies a plan. Ownership is recorded before each write, so a crash midway leaves nothing orphaned. */
  function apply(work) {
    const backups = [];
    fs.mkdirSync(p.config, { recursive: true });
    // A folder the user already has under that name is theirs: never record it
    // as owned, or a crash before the final manifest would get it removed next run.
    const owned = new Set(work.manifest.skills);
    const intendedSkills = work.skills
      .map((s) => s.name)
      .filter((n) => owned.has(n) || !exists(path.join(p.skills, n)));
    writeManifest({
      profile: work.manifest.profile,
      mirroredAt: work.manifest.mirroredAt,
      servers: [...new Set([...work.manifest.servers, ...work.mcp.written])],
      skills: [...new Set([...work.manifest.skills, ...intendedSkills])],
    });
    if (work.rules.text !== work.rules.before) {
      backupOnce(p.rules, backups);
      writeAtomic(p.rules, work.rules.text);
    }
    if (work.mcp.text !== work.mcp.before) {
      backupOnce(p.mcp, backups);
      writeAtomic(p.mcp, work.mcp.text);
    }
    const copied = copySkills(p.skills, work.manifest.skills, work.skills, {
      onCopyError: (name, err) => log(`[agymirror] could not copy skill ${name}: ${errCode(err)}`),
    });
    const at = now().toISOString();
    writeManifest({ profile: work.profile, mirroredAt: at, servers: work.mcp.written, skills: copied.copied });
    return {
      ok: true,
      profile: work.profile,
      mirroredAt: at,
      rulesFile: p.rules,
      servers: work.mcp.written,
      skills: copied.copied,
      skipped: [...work.skipped, ...copied.skipped],
      warnings: work.warnings,
      backups,
    };
  }

  /**
   * Mirrors the applied Claude setup into agy. Never throws.
   * @param {string|null} [profile] the profile just applied; null = read luna-setup's state
   * @returns {{ok:true, profile:string|null, mirroredAt:string, rulesFile:string, servers:string[],
   *   skills:string[], skipped:Array, warnings:string[], backups:string[]}
   *   |{ok:false, error:string, detail?:string}}
   */
  function sync(profile = null) {
    const name = typeof profile === 'string' && PROFILE_RE.test(profile) ? profile : appliedProfile();
    let res;
    let phase = 'read';
    try {
      if (!available()) {
        res = { ok: false, error: 'agy-not-found' };
      } else {
        const work = plan(name);
        phase = 'write';
        res = apply(work);
      }
    } catch (err) {
      if (err instanceof MirrorRefusal) res = { ok: false, error: err.code, detail: err.detail };
      else res = { ok: false, error: phase === 'write' ? 'write-failed' : 'failed', detail: errCode(err) };
    }
    if (res.ok) lastError = null;
    else {
      lastError = { error: res.error, detail: res.detail || '' };
      log(`[agymirror] sync failed: ${res.error}${res.detail ? ` (${res.detail})` : ''}`);
    }
    return res;
  }

  /** What the widget shows: installed, on/off, the last mirror, the last error. Never throws. */
  function status() {
    let manifest = { profile: null, mirroredAt: null };
    let manifestError = null;
    try {
      manifest = readManifest();
    } catch (err) {
      manifestError = err instanceof MirrorRefusal ? { error: err.code, detail: err.detail } : { error: 'failed', detail: errCode(err) };
    }
    return {
      ok: true,
      available: available(),
      enabled: isEnabled(),
      profile: manifest.profile,
      mirroredAt: manifest.mirroredAt,
      lastError: lastError || manifestError,
    };
  }

  return { available, isEnabled, setEnabled, sync, status, paths: p };
}

module.exports = {
  createAgyMirror,
  mergeMcpConfig,
  isPathScoped,
  layoutFor,
  RULES_BYTE_CAP,
  SETTINGS_FILE,
};
