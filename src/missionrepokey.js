// ============================================================================
// LunaCore - Mission Control: project key for a transcript cwd (main process)
// ----------------------------------------------------------------------------
// Maps a working directory to the project it belongs to, for the Claude-per-
// project ledger (src/missionledger.js):
//   - walk up to the nearest `.git`; a worktree (`.git` FILE pointing at
//     <repo>/.git/worktrees/<name>) folds into its parent repo;
//   - key by the normalised origin remote ("git:github.com/owner/repo"), so
//     the same repo cloned at different paths on several PCs is one project;
//     no remote -> "local:<folder name>"; not a repo at all -> "other".
// No git process is spawned: only `.git/config` and a worktree's `.git` file
// are read, both small. Results are cached per cwd for the app's lifetime.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const OTHER = Object.freeze({ key: 'other', name: 'other' });
const MAX_GIT_FILE = 64 * 1024;
const MAX_DEPTH = 64;
const SEGMENT_RE = /^[a-z0-9._-]+$/;

/** Reads a small text file, or null. */
function readSmall(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_GIT_FILE) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The `url` of `[remote "origin"]` in a git config text, or null. */
function originUrl(configText) {
  if (typeof configText !== 'string') return null;
  let inOrigin = false;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    const m = inOrigin && /^url\s*=\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * https / ssh:// / scp-style (git@host:owner/repo) remote -> "host/owner/repo"
 * lower-cased, without credentials or ".git". Local paths and junk -> null.
 */
function normalizeRemote(url) {
  if (typeof url !== 'string' || !url) return null;
  let host;
  let rest;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(url);
  if (scp) {
    [, host, rest] = scp;
  } else {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname) return null;
    host = parsed.hostname;
    rest = parsed.pathname;
  }
  const parts = rest
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  if (parts.length < 2 || !parts.every((p) => SEGMENT_RE.test(p) && p !== '.' && p !== '..')) return null;
  return [host.toLowerCase(), ...parts].join('/');
}

/** {root, gitDir} of the repo holding `dir` (worktrees folded), or null. */
function findRepo(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st && st.isDirectory()) return { root: cur, gitDir: dotGit };
    if (st && st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readSmall(dotGit) || '');
      if (!m) return null;
      const gitDir = path.resolve(cur, m[1].trim());
      // <repo>/.git/worktrees/<name> -> <repo>/.git
      const parent = path.dirname(path.dirname(gitDir));
      if (path.basename(path.dirname(gitDir)) === 'worktrees' && path.basename(parent) === '.git') {
        return { root: path.dirname(parent), gitDir: parent };
      }
      return { root: cur, gitDir };
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/** Git Bash writes "/c/Users/..." into some transcripts; Windows reads that as C:\c\Users. */
function fromGitBash(cwd) {
  if (process.platform !== 'win32') return cwd;
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(cwd);
  return m ? `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}` : cwd;
}

/** The first path segment named like a pinned folder alias, or null. */
function aliasFor(cwd, aliases) {
  if (!aliases || aliases.size === 0) return null;
  for (const segment of cwd.split(/[\\/]+/).reverse()) {
    const hit = aliases.get(segment.toLowerCase());
    if (hit) return { key: hit.key, name: hit.name };
  }
  return null;
}

/**
 * Resolves one cwd to {key, name}; uncached. A cwd that is not inside a repo
 * on this PC (deleted, moved, or another PC's path) can still match a pinned
 * project's folder alias.
 */
function resolveCwd(rawCwd, aliases) {
  if (typeof rawCwd !== 'string' || !rawCwd) return OTHER;
  const cwd = fromGitBash(rawCwd);
  // A UNC path (\\host\share) would make every stat a network round trip and
  // can trigger an SMB/NTLM handshake; a relative one has no stable meaning.
  if (/^[\\/]{2}/.test(cwd) || !path.isAbsolute(cwd)) return OTHER;
  const repo = findRepo(cwd);
  if (!repo) return aliasFor(cwd, aliases) || OTHER;
  const remote = normalizeRemote(originUrl(readSmall(path.join(repo.gitDir, 'config'))));
  const folder = path.basename(repo.root);
  if (remote) return { key: `git:${remote}`, name: folder };
  if (!folder) return OTHER;
  return { key: `local:${folder.toLowerCase()}`, name: folder };
}

/**
 * A cwd -> project resolver with a per-cwd cache.
 * @param {{aliases?:()=>Map<string,{key:string,name:string}>}} [opts] pinned
 *   folder aliases (missionprojects.pinnedAliases), read on a cache miss
 */
function createRepoKeys({ aliases = () => null } = {}) {
  const cache = new Map();
  return {
    resolve(cwd) {
      if (typeof cwd !== 'string') return OTHER;
      if (!cache.has(cwd)) cache.set(cwd, resolveCwd(cwd, aliases()));
      return cache.get(cwd);
    },
  };
}

module.exports = { createRepoKeys, normalizeRemote, originUrl, OTHER };
