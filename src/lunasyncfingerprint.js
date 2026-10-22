// ============================================================================
// LunaCore - Luna overlay fingerprint: skip the rebuild when nothing changed
// ----------------------------------------------------------------------------
// lunaLaunchFor() (src/lunasynclaunch.js) runs synchronously on every tab
// spawn. Rebuilding the overlay means reading ~/.claude and copying every
// skill folder - so instead we hash cheap inputs first: the launch options
// (cli, picked skill ids, gateway port, ...) plus path + size + mtime of every
// source file the sync reads. No file CONTENT is read. A match reuses the
// last successful result, as long as the overlay files it wrote are still
// unchanged; anything else rebuilds.
//
// Stored next to the overlay root (`<root>.fingerprint.json`), not inside it:
// the overlay is the CLI's own home and LunaCore keeps its footprint there to
// the manifest. Only successful results are stored - a failure always retries.
// ============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Bump when this fingerprint's inputs change, so old fingerprints never match. */
const FINGERPRINT_VERSION = 1;

/** An app update may change what syncOverlay() writes, so the app version is part of the key. */
const APP_VERSION = (() => {
  try {
    return require('../package.json').version;
  } catch {
    return 'unknown';
  }
})();

/** A walk that hits this many entries stops; the fingerprint still covers what it saw plus the cut-off. */
const MAX_ENTRIES = 20000;

/** Never part of a skill copy (src/lunasyncio.js SKIPPED_COPY_NAMES), so not part of the fingerprint. */
const SKIPPED_NAMES = new Set(['.git', 'node_modules']);

/** `<path>|<size>|<mtimeMs>`, or `<path>|-` for a missing file. Follows symlinks. */
function statLine(file, stat) {
  try {
    const s = stat(file);
    return `${file}|${s.size}|${Math.floor(s.mtimeMs)}`;
  } catch {
    return `${file}|-`;
  }
}

/**
 * Stat lines for every file under `dir` (recursive, symlinks followed, cycles cut).
 * @returns {string[]}
 */
function treeLines(dir, { stat = fs.statSync, readdir = fs.readdirSync, realpath = fs.realpathSync } = {}) {
  const lines = [];
  const seen = new Set();
  const walk = (d) => {
    if (lines.length >= MAX_ENTRIES) return;
    let real;
    try {
      real = realpath(d);
    } catch {
      real = d;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let names;
    try {
      names = readdir(d).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (lines.length >= MAX_ENTRIES) {
        lines.push(`${dir}|truncated`);
        return;
      }
      if (SKIPPED_NAMES.has(name)) continue;
      const full = path.join(d, name);
      let s;
      try {
        s = stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(full);
      else lines.push(`${full}|${s.size}|${Math.floor(s.mtimeMs)}`);
    }
  };
  walk(dir);
  return lines;
}

/**
 * Every install path in installed_plugins.json (a small file). Enabled or not:
 * settings.json decides that, and its own mtime is already in the fingerprint.
 * @returns {string[]} sorted, unique
 */
function pluginInstallPaths(claudeHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), 'utf8'));
    const registry = raw && raw.plugins && typeof raw.plugins === 'object' ? raw.plugins : {};
    const out = new Set();
    for (const installs of Object.values(registry)) {
      if (!Array.isArray(installs)) continue;
      for (const i of installs) if (i && typeof i.installPath === 'string') out.add(i.installPath);
    }
    return [...out].sort();
  } catch {
    return [];
  }
}

/**
 * Hash of the launch options plus the source files' size/mtime: ~/.claude's
 * CLAUDE.md, settings, rules and personal skills, ~/.claude.json, and for each
 * installed plugin its .mcp.json and the folders of the picked skills.
 * @param {{options:Object, claudeHome:string, claudeJson:string, withSources:boolean, fsDeps?:Object}} args
 *   withSources false = the overlay reads nothing from ~/.claude (gateway home, Luna switch off)
 * @returns {string} hex sha256
 */
function overlayFingerprint({ options, claudeHome, claudeJson, withSources, fsDeps = {} }) {
  const stat = fsDeps.stat || fs.statSync;
  const lines = [`v${FINGERPRINT_VERSION}`, `app ${APP_VERSION}`, JSON.stringify(options || {})];
  if (withSources) {
    for (const file of [
      path.join(claudeHome, 'CLAUDE.md'),
      path.join(claudeHome, 'settings.json'),
      path.join(claudeHome, 'plugins', 'installed_plugins.json'),
      claudeJson,
    ]) {
      lines.push(statLine(file, stat));
    }
    lines.push(...treeLines(path.join(claudeHome, 'rules'), fsDeps));
    lines.push(...treeLines(path.join(claudeHome, 'skills'), fsDeps));
    // Picked ids are `<plugin>:<skill>`; only the skill half names a folder.
    const pickedSkills = [...new Set(((options && options.pickedSkillIds) || []).map((id) => String(id).split(':')[1]).filter(Boolean))];
    for (const installPath of pluginInstallPaths(claudeHome)) {
      lines.push(statLine(path.join(installPath, '.mcp.json'), stat));
      for (const skill of pickedSkills) lines.push(...treeLines(path.join(installPath, 'skills', skill), fsDeps));
    }
  }
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

const fingerprintFile = (overlayRoot) => `${overlayRoot}.fingerprint.json`;

/** Stat lines of the overlay files a build produced - a cache hit needs them unchanged. */
function overlayLines(files) {
  return (files || []).map((file) => statLine(file, fs.statSync));
}

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * The stored result for this fingerprint, or null (missing, broken, different,
 * malformed, or one of the overlay files changed or vanished since the build).
 * @param {string} overlayRoot
 * @param {string} fingerprint
 * @returns {{skills:string[], servers:string[], skipped:Array}|null}
 */
function readCachedResult(overlayRoot, fingerprint) {
  try {
    if (!fs.statSync(overlayRoot).isDirectory()) return null;
    const raw = JSON.parse(fs.readFileSync(fingerprintFile(overlayRoot), 'utf8'));
    if (!raw || raw.fingerprint !== fingerprint || !raw.result || raw.result.ok !== true) return null;
    const { skills, servers, skipped } = raw.result;
    if (!isStringArray(skills) || !isStringArray(servers) || !Array.isArray(skipped)) return null;
    if (!isStringArray(raw.files) || !isStringArray(raw.overlay)) return null;
    if (overlayLines(raw.files).join('\n') !== raw.overlay.join('\n')) return null;
    return { skills, servers, skipped };
  } catch {
    return null;
  }
}

/**
 * Stores a successful result (tmp + rename). A failure to store is harmless:
 * the next spawn just rebuilds. The env is not stored - see syncIfChanged().
 */
function writeCachedResult(overlayRoot, fingerprint, result, files) {
  const file = fingerprintFile(overlayRoot);
  try {
    const tmp = `${file}.tmp`;
    const { skills = [], servers = [], skipped = [] } = result;
    fs.writeFileSync(tmp, JSON.stringify({
      fingerprint,
      result: { ok: true, skills, servers, skipped },
      files,
      overlay: overlayLines(files),
    }));
    fs.renameSync(tmp, file);
  } catch {
    // Best effort - see above.
  }
}

/**
 * Runs `build` only when the fingerprint changed; otherwise returns the stored result.
 * @param {{overlayRoot:string, fingerprint:string, build:()=>Object, env:Object,
 *   overlayFiles:(result:Object)=>string[]}} args
 *   env: the overlay env a cache hit gets - rebuilt by the caller, never read back from disk;
 *   overlayFiles: the files a build wrote, re-checked on every hit
 * @returns {Object} the build's result, or the cached one with `cached: true`
 */
function syncIfChanged({ overlayRoot, fingerprint, build, env, overlayFiles }) {
  const cached = readCachedResult(overlayRoot, fingerprint);
  if (cached) return { ok: true, env, ...cached, cached: true };
  // A rebuild that fails half-way must not leave the old fingerprint matching.
  try {
    fs.rmSync(fingerprintFile(overlayRoot), { force: true });
  } catch {
    // Unremovable: the rebuild result below decides what gets written.
  }
  const result = build();
  if (result && result.ok === true) writeCachedResult(overlayRoot, fingerprint, result, overlayFiles(result));
  return result;
}

module.exports = { overlayFingerprint, syncIfChanged, treeLines, FINGERPRINT_VERSION };
