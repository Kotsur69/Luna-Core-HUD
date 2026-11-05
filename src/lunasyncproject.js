// ============================================================================
// LunaCore - Luna sync: the open project's MCP servers, for that tab only
// ----------------------------------------------------------------------------
// docs/done_docs/DONE_FREE_PROVIDERS_SYNC_PLAN.md, "Project MCP servers". The shared
// overlay (src/lunasyncio.js) holds the user-level setup and is the same for
// every project, so its fingerprint/copy-skip is untouched by which folder a
// tab opens in. A project's servers go into a small per-project layer next to
// it instead, and only the tab started in that project is pointed at it:
//   codex:  <root>/luna<hash>.config.toml, launched with `--profile luna<hash>`
//           (Codex 0.146 layers <CODEX_HOME>/<name>.config.toml on config.toml,
//           mcp_servers merged by name, the profile winning - verified live)
//   gemini: an extension <root>/.gemini/extensions/luna<hash>/ that
//           extension-enablement.json switches on for that folder only
//           (verified live, Gemini 0.60: started in the project, not in its
//           parent). A system-settings/defaults layer was tried first and is
//           refused by Gemini unless its folder is admin-owned.
//
// Which servers: what Claude Code itself would load for that folder - every
// `.mcp.json` from the folder up to the drive root (nearer wins), only in a
// folder whose Claude trust dialog was accepted, APPROVED ones only
// (enableAllProjectMcpServers / enabledMcpjsonServers, minus
// disabledMcpjsonServers), plus Claude's local-scope servers for the folder
// (~/.claude.json projects[<dir>].mcpServers). An unapproved server from a
// freshly cloned repo is never started in another CLI either.
// ============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeMcpServers, codexProfileText, geminiProjectExtension, geminiExtensionEnablement, stripBom } = require('./lunasync');
const { writeAtomic, samePathKey } = require('./lunasyncio');

/** How far up from the project folder `.mcp.json` files are looked for. */
const MAX_PARENT_LEVELS = 64;

/** A profile already chosen by the tab's own args (`-p x`, `-px`, `--profile[=x]`, `-c profile=x`) - a second one would clash. */
const PROFILE_ARG_RE = /^(?:-p.*|--profile(?:=.*)?|(?:-c)?profile\s*=.*)$/;

/** A legacy profile selector in config.toml makes Codex refuse `--profile` outright (verified live). */
const CODEX_LEGACY_PROFILE_RE = /^\s*(?:profile\s*=|\[profiles[.\]])/m;

function readJsonOrNull(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Every `.mcp.json` from `dir` up to the root, NEAREST first. */
function mcpJsonChain(dir) {
  const files = [];
  let current = path.resolve(dir);
  for (let i = 0; i < MAX_PARENT_LEVELS; i += 1) {
    files.push(path.join(current, '.mcp.json'));
    const up = path.dirname(current);
    if (up === current) break;
    current = up;
  }
  return files;
}

/** ~/.claude.json keeps one entry per folder, keyed by its path with forward slashes. */
function claudeProjectEntry(userJson, projectDir) {
  const projects = userJson && userJson.projects && typeof userJson.projects === 'object' ? userJson.projects : {};
  const key = samePathKey(projectDir);
  const hit = Object.keys(projects).find((k) => samePathKey(k) === key);
  const entry = hit ? projects[hit] : null;
  return entry && typeof entry === 'object' ? entry : {};
}

/**
 * True when the user accepted Claude Code's workspace-trust dialog for the
 * folder or one of its parents. Claude loads no `.mcp.json` server - and reads
 * no approval from the repo's own .claude/ settings - before that, so neither
 * does this: a cloned repo cannot approve its own servers.
 */
function isTrustedInClaude(userJson, projectDir) {
  let current = path.resolve(projectDir);
  for (let i = 0; i < MAX_PARENT_LEVELS; i += 1) {
    if (claudeProjectEntry(userJson, current).hasTrustDialogAccepted === true) return true;
    const up = path.dirname(current);
    if (up === current) return false;
    current = up;
  }
  return false;
}

const stringList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * Claude Code's approval of a folder's `.mcp.json` servers, unioned over the
 * places it can be stored. Only consulted for a folder Claude trusts (the
 * repo's .claude/ files are the repo's own words until then).
 * @returns {(name:string) => null|'not-approved'|'disabled-in-claude'} null = approved
 */
function approvalFor(projectDir, claudeHome, userJson) {
  const sources = [
    readJsonOrNull(path.join(claudeHome, 'settings.json')),
    readJsonOrNull(path.join(projectDir, '.claude', 'settings.json')),
    readJsonOrNull(path.join(projectDir, '.claude', 'settings.local.json')),
    claudeProjectEntry(userJson, projectDir),
  ].filter((s) => s && typeof s === 'object');
  const enabled = new Set(sources.flatMap((s) => stringList(s.enabledMcpjsonServers)));
  const disabled = new Set(sources.flatMap((s) => stringList(s.disabledMcpjsonServers)));
  const all = sources.some((s) => s.enableAllProjectMcpServers === true);
  return (name) => {
    if (disabled.has(name)) return 'disabled-in-claude';
    return all || enabled.has(name) ? null : 'not-approved';
  };
}

/**
 * The servers Claude Code would load for `projectDir` on top of the user-level ones.
 * Never throws: a missing or broken file contributes nothing.
 * @param {{projectDir:string, claudeHome?:string, claudeJson?:string}} args
 * @returns {{servers:Object<string,Object>, skipped:Array<{kind:string,name:string,reason:string}>}}
 */
function readProjectServers({ projectDir, claudeHome = path.join(os.homedir(), '.claude'), claudeJson = path.join(os.homedir(), '.claude.json') }) {
  const userJson = readJsonOrNull(claudeJson) || {};
  const shared = {};
  // Farthest first, so a nearer .mcp.json overrides a parent's same-named server.
  for (const file of mcpJsonChain(projectDir).reverse()) {
    const raw = readJsonOrNull(file);
    Object.assign(shared, normalizeMcpServers(raw && raw.mcpServers));
  }
  const trusted = isTrustedInClaude(userJson, projectDir);
  const verdict = trusted ? approvalFor(projectDir, claudeHome, userJson) : () => 'folder-not-trusted';
  const servers = {};
  const skipped = [];
  for (const [name, server] of Object.entries(shared)) {
    const reason = verdict(name);
    if (reason) skipped.push({ kind: 'mcp', name, reason });
    else servers[name] = server;
  }
  // Local scope: added by the user for this folder only, so no approval step - and it wins, as in Claude.
  Object.assign(servers, normalizeMcpServers(claudeProjectEntry(userJson, projectDir).mcpServers));
  return { servers, skipped: skipped.filter((s) => !Object.hasOwn(servers, s.name)) };
}

/** `luna` + 12 hex chars: a plain name Codex accepts for --profile, stable per folder. */
function projectLayerName(projectDir) {
  return `luna${crypto.createHash('sha256').update(samePathKey(projectDir)).digest('hex').slice(0, 12)}`;
}

/** Writes only when the content differs, so an unchanged project costs one read per spawn. */
function writeIfChanged(file, text) {
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // Missing: written below.
  }
  if (current === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, text);
}

/** Every server skipped for one reason - the tab notice says why. */
const skipAll = (servers, reason) => Object.keys(servers).map((name) => ({ kind: 'mcp', name, reason }));

function codexLayer({ overlayRoot, projectDir, servers, profileArgs }) {
  if ((profileArgs || []).some((a) => typeof a === 'string' && PROFILE_ARG_RE.test(a))) {
    clearProjectLayer('codex', overlayRoot, projectDir);
    return { servers: [], skipped: skipAll(servers, 'profile-in-use') };
  }
  let config = '';
  try {
    config = fs.readFileSync(path.join(overlayRoot, 'config.toml'), 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return { servers: [], skipped: skipAll(servers, 'overlay-unreadable') };
  }
  if (CODEX_LEGACY_PROFILE_RE.test(config)) return { servers: [], skipped: skipAll(servers, 'codex-legacy-profile') };

  const name = projectLayerName(projectDir);
  const file = path.join(overlayRoot, `${name}.config.toml`);
  const { text, written, skipped } = codexProfileText(servers);
  const skips = skipped.map((s) => ({ kind: 'mcp', ...s }));
  if (!written.length) {
    clearProjectLayer('codex', overlayRoot, projectDir);
    return { servers: [], skipped: skips };
  }
  writeIfChanged(file, text);
  return { args: ['--profile', name], servers: written, skipped: skips };
}

/**
 * Gemini's extension-enablement.json: {} when missing, null when present but
 * not plain JSON - Gemini owns that file too, so it is never overwritten blind.
 */
function readEnablement(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err && err.code === 'ENOENT' ? {} : null;
  }
  try {
    const parsed = JSON.parse(stripBom(text));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function geminiLayer({ overlayRoot, projectDir, servers, baseServers }) {
  const name = projectLayerName(projectDir);
  const extensionsDir = path.join(overlayRoot, '.gemini', 'extensions');
  const extensionDir = path.join(extensionsDir, name);
  const enablementFile = path.join(extensionsDir, 'extension-enablement.json');
  // A same-named server in the user-level settings.json beats an extension's in Gemini.
  const taken = new Set(baseServers || []);
  const ours = Object.fromEntries(Object.entries(servers).filter(([n]) => !taken.has(n)));
  const skipped = Object.keys(servers).filter((n) => taken.has(n)).map((s) => ({ kind: 'mcp', name: s, reason: 'name-taken' }));

  if (!Object.keys(ours).length) {
    clearProjectLayer('gemini', overlayRoot, projectDir);
    return { servers: [], skipped };
  }
  const enablement = readEnablement(enablementFile);
  if (enablement === null) {
    fs.rmSync(extensionDir, { recursive: true, force: true });
    return { servers: [], skipped: [...skipped, ...skipAll(ours, 'overlay-unreadable')] };
  }
  // Enablement first: an extension folder without its folder rule would be on everywhere.
  writeIfChanged(enablementFile, `${JSON.stringify(geminiExtensionEnablement(enablement, name, projectDir), null, 2)}\n`);
  writeIfChanged(path.join(extensionDir, 'gemini-extension.json'), `${JSON.stringify(geminiProjectExtension(name, ours), null, 2)}\n`);
  return { servers: Object.keys(ours), skipped };
}

/**
 * Removes one folder's layer: the Codex profile file, or the Gemini extension
 * and its enablement rule (an unreadable enablement file is left alone - with
 * the extension folder gone there is nothing for its rule to switch on).
 */
function clearProjectLayer(cli, overlayRoot, projectDir) {
  const name = projectLayerName(projectDir);
  if (cli === 'codex') {
    fs.rmSync(path.join(overlayRoot, `${name}.config.toml`), { force: true });
    return;
  }
  const extensionsDir = path.join(overlayRoot, '.gemini', 'extensions');
  fs.rmSync(path.join(extensionsDir, name), { recursive: true, force: true });
  const enablementFile = path.join(extensionsDir, 'extension-enablement.json');
  const enablement = readEnablement(enablementFile);
  if (enablement && Object.hasOwn(enablement, name)) {
    writeIfChanged(enablementFile, `${JSON.stringify(geminiExtensionEnablement(enablement, name, null), null, 2)}\n`);
  }
}

/**
 * Builds the project layer for one tab. Never throws - a failure leaves the
 * tab on the shared overlay and says so in its skip list.
 * @param {{cli:'codex'|'gemini', overlayRoot:string, projectDir:string, baseServers?:string[],
 *   profileArgs?:string[], claudeHome?:string, claudeJson?:string, clear?:boolean}} args
 *   baseServers: names the shared overlay already has; profileArgs: the tab's own CLI args;
 *   clear: only remove this folder's layer (a tab on the overlay with the Luna switch off)
 * @returns {null|{args?:string[], servers:string[], skipped:Array}} null = no project;
 *   args: extra CLI args for the tab (Codex --profile; Gemini needs none - it picks the extension by folder)
 */
function projectLayerFor({ cli, overlayRoot, projectDir, baseServers = [], profileArgs = [], claudeHome, claudeJson, clear = false }) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return null;
  if (typeof overlayRoot !== 'string' || !path.isAbsolute(overlayRoot)) return null;
  try {
    if (clear) {
      clearProjectLayer(cli, overlayRoot, projectDir);
      return null;
    }
    const project = readProjectServers({ projectDir, claudeHome, claudeJson });
    if (!Object.keys(project.servers).length) {
      // A server revoked in Claude (or removed from .mcp.json) must stop loading here too.
      clearProjectLayer(cli, overlayRoot, projectDir);
      return { servers: [], skipped: project.skipped };
    }
    const layer = cli === 'codex'
      ? codexLayer({ overlayRoot, projectDir, servers: project.servers, profileArgs })
      : geminiLayer({ overlayRoot, projectDir, servers: project.servers, baseServers });
    return { ...layer, skipped: [...project.skipped, ...layer.skipped] };
  } catch (err) {
    return { servers: [], skipped: [{ kind: 'mcp', name: '.mcp.json', reason: `project-write-failed${err && err.code ? `:${err.code}` : ''}` }] };
  }
}

module.exports = { readProjectServers, projectLayerFor, projectLayerName };
