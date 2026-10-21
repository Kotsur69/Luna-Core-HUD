// ============================================================================
// LunaCore - a host's heartbeat and menu over the cloud (main + phone)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, slice H1. A PC in host mode puts its `host`
// snapshot every 30 s: what the phone may pick from on that host.
//
//   {v, at, version, os, default, repos: [{id, key, name, cloned, status}],
//    skills, commands, mcp, sessions}
//
// Repos travel by project id (the phone sends an id back, never a path) plus
// the repo key and folder name; no local path ever leaves the host. `at` is
// bumped on every heartbeat, so cloudsnapshots' "skip unchanged" never holds
// one back. Online = the row's updated_at is under 90 s old.
//
// A row is written by another machine: untrusted. Only the known fields
// survive, strings are capped and stripped of control characters, lists are
// capped; a malformed entry is dropped, a malformed row reads as null.
// ============================================================================

'use strict';

const VERSION = 1;
const HEARTBEAT_MS = 30 * 1000;
const ONLINE_MS = 90 * 1000;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
/** "git:github.com/owner/repo" or "local:<folder>"; never a path. */
const KEY_RE = /^(git:[a-z0-9.-]+(\/[a-z0-9._-]+)+|local:[^\\/:]{1,100})$/;
/** A skill, slash command or MCP server name: what the phone inserts as "/name". */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/;
const OS_LIST = ['win32', 'darwin', 'linux'];
const CLONE_STATUS = ['cloned', 'skipped: folder exists', 'failed: auth', 'failed: other'];
const SESSION_STATUS = ['working', 'waiting', 'done', 'error'];
const MAX_REPOS = 200;
const MAX_NAMES = 300;
const MAX_SESSIONS = 20;
const MAX_KEY = 200;
const MAX_NAME = 100;
const MAX_VERSION = 40;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
// eslint-disable-next-line no-control-regex
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');
const isId = (v) => typeof v === 'string' && ID_RE.test(v) && v !== '__proto__';
const isKey = (k) => typeof k === 'string' && k.length <= MAX_KEY && KEY_RE.test(k) && !k.split('/').some((p) => p === '.' || p === '..');

/** One repo entry -> clean copy, or null. `key` may be null (a project that is no repo). */
function cleanRepo(r) {
  if (!isObject(r) || !isId(r.id)) return null;
  const key = isKey(r.key) ? r.key : null;
  return {
    id: r.id,
    key,
    name: clean(r.name, MAX_NAME) || r.id,
    cloned: r.cloned === true,
    status: CLONE_STATUS.includes(r.status) ? r.status : null,
  };
}

/** A list of names -> unique valid names, capped. */
function cleanNames(list) {
  const out = [];
  const seen = new Set();
  for (const n of Array.isArray(list) ? list.slice(0, MAX_NAMES * 2) : []) {
    if (typeof n !== 'string' || !NAME_RE.test(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}

function cleanSession(s) {
  if (!isObject(s) || !isId(s.id)) return null;
  return {
    id: s.id,
    repoId: isId(s.repoId) ? s.repoId : null,
    status: SESSION_STATUS.includes(s.status) ? s.status : 'working',
  };
}

/** Maps, drops nulls and duplicate ids, caps. */
function cleanList(list, fn, max) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(list) ? list.slice(0, max * 2) : []) {
    const c = fn(x);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * This host's `host` snapshot. Everything passes the same cleaning the
 * reader applies, so a put never carries what a reader would drop.
 * @param {{version?: string, os?: string, isDefault?: boolean, repos?: object[],
 *   skills?: string[], commands?: string[], mcp?: string[], sessions?: object[]}} parts
 * @param {number} [now]
 */
function hostSnapshot(parts = {}, now = Date.now()) {
  return {
    v: VERSION,
    at: now,
    version: clean(parts.version, MAX_VERSION),
    os: OS_LIST.includes(parts.os) ? parts.os : 'linux',
    default: parts.isDefault === true,
    repos: cleanList(parts.repos, cleanRepo, MAX_REPOS),
    skills: cleanNames(parts.skills),
    commands: cleanNames(parts.commands),
    mcp: cleanNames(parts.mcp),
    sessions: cleanList(parts.sessions, cleanSession, MAX_SESSIONS),
  };
}

/** Whether a row updated at `updatedAt` counts as a live host at `now`. */
const isOnline = (updatedAt, now) => isTime(updatedAt) && now - updatedAt < ONLINE_MS;

/**
 * A `host` row ({machine, data, updatedAt|updated_at}) -> the parsed host or
 * null. Never throws.
 */
function parseHostPeer(row, now = Date.now()) {
  try {
    if (!isObject(row) || typeof row.machine !== 'string' || !MACHINE_RE.test(row.machine)) return null;
    const d = row.data;
    if (!isObject(d) || d.v !== VERSION || !isTime(d.at)) return null;
    const raw = isTime(row.updatedAt) ? row.updatedAt : Date.parse(row.updated_at);
    // A far-future clock must not make a host look online forever.
    const updatedAt = Number.isFinite(raw) ? Math.min(raw, now) : 0;
    return {
      machine: row.machine,
      at: Math.min(d.at, now),
      updatedAt,
      online: isOnline(updatedAt, now),
      version: clean(d.version, MAX_VERSION),
      os: OS_LIST.includes(d.os) ? d.os : 'linux',
      default: d.default === true,
      repos: cleanList(d.repos, cleanRepo, MAX_REPOS),
      skills: cleanNames(d.skills),
      commands: cleanNames(d.commands),
      mcp: cleanNames(d.mcp),
      sessions: cleanList(d.sessions, cleanSession, MAX_SESSIONS),
    };
  } catch {
    return null;
  }
}

/** Raw rows -> parsed hosts, one per machine (newest wins), online first, then by name. */
function hostsFrom(rows, now = Date.now()) {
  const byMachine = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const h = parseHostPeer(r, now);
    if (!h) continue;
    const id = h.machine.toLowerCase();
    const prev = byMachine.get(id);
    if (!prev || h.updatedAt > prev.updatedAt) byMachine.set(id, h);
  }
  return [...byMachine.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.machine.localeCompare(b.machine));
}

module.exports = { hostSnapshot, parseHostPeer, hostsFrom, isOnline, VERSION, HEARTBEAT_MS, ONLINE_MS, MAX_REPOS, MAX_NAMES, CLONE_STATUS };
