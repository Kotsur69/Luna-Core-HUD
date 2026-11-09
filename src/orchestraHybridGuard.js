// ============================================================================
// LunaCore - hybrid run guard (FREE_GODMODE_V2_PLAN.md Slice F6, "LunaCore guard")
// ----------------------------------------------------------------------------
// In a "Plan with free models in mind" run the planner may mark a package
// "free". Claude's judgment is checked by rules: a free package is upgraded
// to Sonnet - and the board says why - when it
//   - lists more than 2 files, or none;
//   - touches a protected path (entry point, preload, IPC handlers, auth /
//     keys / secrets, migrations, package.json / lockfiles, build config, CI,
//     test infrastructure);
//   - has no acceptance test or verify step.
//
// The protected list is config/hybrid-protected.json (shipped) plus the
// repo's own .lunacore/hybrid-protected.json, which can only ADD paths. Same
// loader contract as cheatsheets/prompts/layouts/themes: safe read, validate
// at the boundary, a broken or missing shipped file yields the built-in
// defaults below, a broken repo file is ignored - never a crash.
//
// Everything but loadProtected()'s default reader is pure.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { FREE_PACKAGE_CLAUDE_MODEL } = require('./orchestraWorkers');

const BASE_FILE = paths.bundled('hybrid-protected.json');
// Repo-relative: each repo extends the list in its own folder.
const REPO_FILE = path.join('.lunacore', 'hybrid-protected.json');

const MAX_FREE_FILES = 2;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_KINDS = 40;
const MAX_PATTERNS = 100;
const MAX_PATTERN_CHARS = 200;
const MAX_REASONS = 10;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
// A path that climbs out of the repo is never a small, local change.
const OUTSIDE_KIND = 'outside';

/** Built-in defaults: mirror config/hybrid-protected.json (a test keeps them in step). */
const DEFAULT_PROTECTED = Object.freeze([
  { kind: 'entry', patterns: ['src/main.js', 'main.js', 'electron/main.js'] },
  { kind: 'preload', patterns: ['src/preload.js', '**/preload.js', '**/preload.ts'] },
  { kind: 'ipc', patterns: ['**/*ipc*.js', '**/*ipc*.ts', '**/ipc/**'] },
  {
    kind: 'secrets',
    patterns: [
      '**/auth/**', '**/auth*.js', '**/auth*.ts', '**/*secret*', '**/*credential*', '**/keys/**',
      '**/*apikey*', '**/*api-key*', '**/*api_key*', '**/.env', '**/.env.*', '**/*.pem', '**/*.key',
    ],
  },
  { kind: 'migrations', patterns: ['**/migrations/**', '**/*migration*', '**/*.sql'] },
  {
    kind: 'dependencies',
    patterns: [
      '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock',
      '**/pnpm-lock.yaml', '**/bun.lockb', '**/requirements*.txt', '**/poetry.lock', '**/pyproject.toml', '**/Cargo.lock',
    ],
  },
  {
    kind: 'build',
    patterns: [
      '**/electron-builder.*', '**/webpack.config.*', '**/vite.config.*', '**/rollup.config.*', '**/tsconfig*.json',
      '**/babel.config.*', '**/.babelrc', '**/esbuild.*', '**/next.config.*', 'build/**', 'scripts/**', '**/Makefile', '**/Dockerfile',
    ],
  },
  { kind: 'ci', patterns: ['.github/**', '.gitlab-ci.yml', '.circleci/**', 'azure-pipelines.yml', '.husky/**'] },
  {
    kind: 'tests',
    patterns: [
      'test/helpers/**', 'test/fixtures/**', '**/test-utils/**', '**/jest.config.*', '**/vitest.config.*',
      '**/playwright.config.*', '**/.mocharc*', '**/karma.conf.*', '**/.nycrc*', '**/test/setup*',
    ],
  },
  { kind: 'lunacore', patterns: ['.lunacore/**'] },
].map((e) => Object.freeze({ kind: e.kind, patterns: Object.freeze([...e.patterns]) })));

/**
 * A glob as an anchored, case-insensitive RegExp. `**\/` = any folders
 * (also none), `**` = anything, `*` = anything but '/', `?` = one char.
 * @param {string} glob
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * A planner file entry as a repo-relative, forward-slash path. The planner
 * sometimes annotates ("src/a.js:120", "src/a.js - add keys"): only the path
 * part counts.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeFilePath(raw) {
  if (typeof raw !== 'string') return '';
  const first = raw.trim().split(/\s+/)[0] || '';
  return first
    .replace(/\\/g, '/')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '');
}

/**
 * Validates one parsed config file. Off-shape entries and patterns are
 * dropped; a file with no usable entry is null (the caller falls back).
 * @param {unknown} raw
 * @returns {Array<{kind:string, patterns:string[]}>|null}
 */
function normalizeProtected(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.protected) ? raw.protected : null;
  if (!list) return null;
  const out = [];
  for (const entry of list.slice(0, MAX_KINDS)) {
    if (!entry || typeof entry !== 'object' || typeof entry.kind !== 'string' || !KIND_RE.test(entry.kind)) continue;
    const patterns = (Array.isArray(entry.patterns) ? entry.patterns : [])
      .filter((p) => typeof p === 'string')
      .map((p) => p.trim())
      .filter((p) => p && p.length <= MAX_PATTERN_CHARS && !p.includes('\0'))
      .slice(0, MAX_PATTERNS);
    if (patterns.length) out.push({ kind: entry.kind, patterns });
  }
  return out.length ? out : null;
}

/**
 * Base list plus a repo's additions, by kind. Additions never remove a path.
 * @param {Array<{kind:string, patterns:string[]}>} base
 * @param {Array<{kind:string, patterns:string[]}>|null} extra
 */
function mergeProtected(base, extra) {
  const byKind = new Map(base.map((e) => [e.kind, [...e.patterns]]));
  for (const e of extra || []) {
    const have = byKind.get(e.kind) || [];
    byKind.set(e.kind, [...have, ...e.patterns.filter((p) => !have.includes(p))].slice(0, MAX_PATTERNS * 2));
  }
  return [...byKind].map(([kind, patterns]) => ({ kind, patterns }));
}

/** Size-capped utf8 read of a plain file; anything else is null. */
function readCappedFile(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
  return fs.readFileSync(file, 'utf8');
}

/** Safe read + parse: missing, unreadable, too big or invalid JSON -> null. */
function readJson(file, readImpl) {
  try {
    const text = readImpl(file);
    if (typeof text !== 'string' || text.length > MAX_CONFIG_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The protected list for a repo: the shipped file (broken -> built-in
 * defaults) plus the repo's .lunacore/hybrid-protected.json (broken ->
 * ignored). Never throws.
 * @param {{repoPath?:string|null, baseFile?:string, readImpl?:(file:string)=>string|null}} [opts]
 * @returns {Array<{kind:string, patterns:string[]}>}
 */
function loadProtected({ repoPath = null, baseFile = BASE_FILE, readImpl = readCappedFile } = {}) {
  const base = normalizeProtected(readJson(baseFile, readImpl)) || DEFAULT_PROTECTED;
  const extra = typeof repoPath === 'string' && repoPath ? normalizeProtected(readJson(path.join(repoPath, REPO_FILE), readImpl)) : null;
  return mergeProtected(base, extra);
}

/** Compiled rules; an unusable list means the built-in defaults. */
function compileRules(rules) {
  const list = Array.isArray(rules) && rules.length ? rules : DEFAULT_PROTECTED;
  return list.map((e) => ({ kind: e.kind, regexps: e.patterns.map(globToRegExp) }));
}

/**
 * The protected kind a path falls under, or null.
 * @param {string} file planner file entry
 * @param {Array<{kind:string, regexps:RegExp[]}>} compiled
 */
function protectedKindOf(file, compiled) {
  const rel = normalizeFilePath(file);
  if (!rel) return null;
  if (rel.split('/').includes('..') || /^[a-z]:/i.test(rel)) return OUTSIDE_KIND;
  const hit = compiled.find((r) => r.regexps.some((re) => re.test(rel)));
  return hit ? hit.kind : null;
}

/** True when the package names a verify command or an acceptance test. */
function hasVerify(pkg) {
  if (typeof pkg.verify === 'string' && pkg.verify.trim()) return true;
  return typeof pkg.prompt === 'string' && /Acceptance test:/i.test(pkg.prompt);
}

/**
 * Why a "free" package must not stay free; [] = it may.
 * @param {{files?:string[], verify?:string, prompt?:string}} pkg
 * @param {Array<{kind:string, patterns:string[]}>} [rules]
 * @returns {Array<{code:'noFiles'}|{code:'tooManyFiles', n:number}|{code:'protected', kind:string, file:string}|{code:'noVerify'}>}
 */
function guardReasons(pkg, rules) {
  const files = (Array.isArray(pkg.files) ? pkg.files : []).filter((f) => typeof f === 'string' && f.trim());
  const reasons = [];
  if (!files.length) reasons.push({ code: 'noFiles' });
  else if (files.length > MAX_FREE_FILES) reasons.push({ code: 'tooManyFiles', n: files.length });
  const compiled = compileRules(rules);
  for (const file of files) {
    const kind = protectedKindOf(file, compiled);
    if (kind) reasons.push({ code: 'protected', kind, file: normalizeFilePath(file) });
  }
  if (!hasVerify(pkg)) reasons.push({ code: 'noVerify' });
  return reasons.slice(0, MAX_REASONS);
}

/**
 * Runs the guard over a hybrid plan's packages. A free package with any
 * reason becomes a Sonnet package carrying `hybridGuard: {from, reasons}`
 * for the board; every other package is returned as it was.
 * @param {Array<object>} packages validatePlan() packages
 * @param {Array<{kind:string, patterns:string[]}>} [rules]
 * @returns {Array<object>}
 */
function applyHybridGuard(packages, rules) {
  return packages.map((p) => {
    if (p.model !== 'free') return p;
    const reasons = guardReasons(p, rules);
    if (!reasons.length) return p;
    return { ...p, model: FREE_PACKAGE_CLAUDE_MODEL, hybridGuard: { from: 'free', reasons } };
  });
}

/**
 * A stored hybridGuard (state file) back to its shape, or null.
 * @param {unknown} raw
 */
function normalizeStoredGuard(raw) {
  if (!raw || typeof raw !== 'object' || raw.from !== 'free' || !Array.isArray(raw.reasons)) return null;
  const reasons = raw.reasons
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      if (r.code === 'noFiles' || r.code === 'noVerify') return { code: r.code };
      if (r.code === 'tooManyFiles' && Number.isFinite(r.n)) return { code: r.code, n: r.n };
      if (r.code === 'protected' && typeof r.kind === 'string' && KIND_RE.test(r.kind) && typeof r.file === 'string') {
        return { code: r.code, kind: r.kind, file: r.file.slice(0, 300) };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, MAX_REASONS);
  return reasons.length ? { from: 'free', reasons } : null;
}

module.exports = {
  BASE_FILE,
  REPO_FILE,
  MAX_FREE_FILES,
  DEFAULT_PROTECTED,
  globToRegExp,
  normalizeFilePath,
  normalizeProtected,
  mergeProtected,
  loadProtected,
  protectedKindOf,
  compileRules,
  guardReasons,
  applyHybridGuard,
  normalizeStoredGuard,
};
