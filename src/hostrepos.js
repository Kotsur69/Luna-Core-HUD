// ============================================================================
// LunaCore - the host clones the synced projects it lacks (main, host mode)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, slice H1. Every synced project with a `remote`
// (src/projectsync.js) that this host does not have is cloned into
// <repos root>/<repo name> (~/source/repos/<name>) with the host's own git
// credentials. Only when the owner is on the host's allow-list
// (host.local.json -> owners, default ["Kotsur69"]): a synced row alone can't
// make a host fetch a stranger's repo. `repo.clone` (a signed command, so any
// owner) uses the same folder rules.
//
// A folder that already exists is never touched. git runs through execFile
// with an argv array (never a shell string), with terminal prompts off so a
// missing credential fails instead of hanging. Each project ends up as one of
// cloned / skipped: folder exists / failed: auth / failed: other, which the
// host snapshot (src/hostsnapshot.js) shows on the phone.
//
// A phone chat runs `claude` in a project's folder (src/hostchat.js), and the
// synced `path` of a project can be rewritten by anyone holding the cloud
// session. chatDirOf() therefore only hands out folders that, with symlinks
// and junctions resolved, sit under the repos root or a host-local allow-list
// (host.local.json -> chatDirs): never a folder on the synced path's word alone.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { validRemote } = require('./projectsync');
const { REPO_OWNER } = require('./update');

/** The owner LunaCore itself ships from (src/update.js). */
const DEFAULT_OWNERS = Object.freeze([REPO_OWNER]);
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_RE = /authentication failed|could not read username|terminal prompts disabled|permission denied|repository not found|returned error: 40[13]|invalid username or password/i;

/** A folder name that stays one segment under the repos root. */
const validName = (name) => typeof name === 'string' && NAME_RE.test(name) && name !== '.' && name !== '..' && !/[\\/]/.test(name);

/** "https://github.com/<owner>/<repo>" -> {url, owner, name}, or null. */
function parseRemote(url) {
  const ok = validRemote(url);
  if (!ok) return null;
  const [owner, name] = ok.slice('https://github.com/'.length).split('/');
  return validName(name) ? { url: ok, owner, name } : null;
}

/** host.local.json -> the owner allow-list; anything off -> the default. */
function readOwners(raw) {
  const list = raw && Array.isArray(raw.owners) ? raw.owners.filter((o) => typeof o === 'string' && OWNER_RE.test(o)) : null;
  return list && list.length ? list : [...DEFAULT_OWNERS];
}

/** host.local.json -> extra folders phone chats may run in (absolute paths only). */
function readChatDirs(raw) {
  const list = raw && Array.isArray(raw.chatDirs) ? raw.chatDirs : [];
  return list.filter((d) => typeof d === 'string' && d.length <= 1024 && path.isAbsolute(d));
}

/**
 * Whether `dir` is `root` itself (only when `allowSelf`) or inside it. Both
 * must already be real paths (fs.realpathSync): a junction in the repo list
 * would otherwise pass as a child of the root while pointing anywhere.
 */
function isInside(root, dir, allowSelf) {
  const rel = path.relative(root, dir);
  if (!rel) return allowSelf;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

const OUTSIDE = 'refused: repo outside the repos root';

/** A failed clone -> the status the phone shows. */
const failureOf = (err) => (AUTH_RE.test(`${(err && err.stderr) || ''} ${(err && err.message) || ''}`) ? 'failed: auth' : 'failed: other');

/**
 * @param {{
 *   execFile: Function,                 child_process.execFile (or a fake)
 *   reposRoot?: string,                 ~/source/repos
 *   owners?: () => string[],            the allow-list (readOwners of host.local.json)
 *   chatDirs?: () => string[],          host-local folders chats may use besides the root
 *   realpath?: (p: string) => string,   fs.realpathSync (throws when missing)
 *   exists?: (p: string) => boolean,
 *   mkdir?: (p: string) => void,
 *   log?: (line: string) => void,
 * }} deps
 */
function createHostRepos({
  execFile,
  reposRoot = path.join(os.homedir(), 'source', 'repos'),
  owners = () => [...DEFAULT_OWNERS],
  chatDirs = () => [],
  realpath = (p) => fs.realpathSync(p),
  exists = (p) => fs.existsSync(p),
  mkdir = (p) => fs.mkdirSync(p, { recursive: true }),
  log = (line) => console.error(line),
}) {
  let statuses = new Map(); // project id -> last clone status
  let busy = null;

  const targetOf = (name) => path.join(reposRoot, name);

  function gitClone(url, target) {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['clone', '--', url, target],
        { timeout: CLONE_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, _stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve()),
      );
    });
  }

  /**
   * Clones `url` into <root>/<repo>. Never touches an existing folder.
   * @returns {Promise<{status: string, dir: string|null}>}
   */
  async function cloneInto(url) {
    const r = parseRemote(url);
    if (!r) return { status: 'failed: other', dir: null };
    const target = targetOf(r.name);
    if (exists(target)) return { status: 'skipped: folder exists', dir: target };
    try {
      mkdir(reposRoot);
      await gitClone(r.url, target);
      return { status: 'cloned', dir: target };
    } catch (err) {
      const status = failureOf(err);
      log(`[hostrepos] clone ${r.owner}/${r.name}: ${status}`);
      return { status, dir: null };
    }
  }

  /**
   * One pass over the synced projects ({id, path, remote?}; path already local).
   * A project whose folder exists here is present and left alone.
   */
  async function syncOnce(projects) {
    const allowed = new Set(owners().map((o) => o.toLowerCase()));
    const next = new Map();
    for (const p of Array.isArray(projects) ? projects : []) {
      if (!p || typeof p.id !== 'string') continue;
      const r = parseRemote(p.remote);
      if (!r) continue;
      if (typeof p.path === 'string' && exists(p.path)) continue;
      const prev = statuses.get(p.id);
      // Cloned earlier: the folder is ours now; 'exists' below would misreport it.
      if (prev === 'cloned' && exists(targetOf(r.name))) {
        next.set(p.id, prev);
        continue;
      }
      if (!allowed.has(r.owner.toLowerCase())) continue;
      next.set(p.id, (await cloneInto(r.url)).status);
    }
    statuses = next;
    return new Map(statuses);
  }

  /** Where a project lives on this host: its own folder, else the clone target. */
  function dirOf(p) {
    if (p && typeof p.path === 'string' && exists(p.path)) return p.path;
    const r = parseRemote(p && p.remote);
    return r && exists(targetOf(r.name)) ? targetOf(r.name) : null;
  }

  const realOrNull = (p) => {
    try {
      return realpath(p);
    } catch {
      return null; // gone or unreadable: it can't contain anything
    }
  };

  /**
   * The folder a phone chat may run in, as a real path, or why not.
   * @returns {{dir: string}|{error: string}}
   */
  function chatDirOf(p) {
    const dir = dirOf(p);
    if (!dir) return { error: 'refused: unknown repo' };
    const real = realOrNull(dir);
    if (!real) return { error: 'refused: unknown repo' };
    const root = realOrNull(reposRoot);
    if (root && isInside(root, real, false)) return { dir: real };
    let extra = [];
    try {
      extra = chatDirs();
    } catch (err) {
      log(`[hostrepos] chat allow-list unreadable: ${err && err.message}`);
    }
    for (const d of Array.isArray(extra) ? extra : []) {
      const allowed = typeof d === 'string' ? realOrNull(d) : null;
      if (allowed && isInside(allowed, real, true)) return { dir: real };
    }
    log(`[hostrepos] chat refused for ${p && p.id}: ${real} is outside the repos root`);
    return { error: OUTSIDE };
  }

  return {
    /** One pass at a time; a call during a pass waits for it. */
    sync(projects) {
      busy = (busy || Promise.resolve()).then(() => syncOnce(projects)).catch((err) => {
        log(`[hostrepos] pass failed: ${err && err.message}`);
        return new Map(statuses);
      });
      return busy;
    },
    /** The signed `repo.clone {url}`: any owner, same folder rules. */
    clone: (url) => cloneInto(url),
    /** project id -> status of the last pass. */
    statuses: () => new Map(statuses),
    dirOf,
    chatDirOf,
  };
}

module.exports = { createHostRepos, parseRemote, readOwners, readChatDirs, isInside, validName, failureOf, DEFAULT_OWNERS };
