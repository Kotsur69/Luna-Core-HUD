// ============================================================================
// LunaCore - repo status over the cloud (main + phone)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md, slice U2. A PC puts the git station's view of its
// repos as its `repos` snapshot; the phone reads every PC's row and merges
// them by repo, so "pushed on one PC, behind on the other" shows at a glance.
//
// A repo is keyed by its normalised origin remote (missionrepokey.js), so the
// same repo cloned at different paths on several PCs is one card. Local
// paths never leave the PC: only the key, the folder name and git facts.
//
// A row is written by another machine: untrusted. Only the known fields
// survive, strings are capped and stripped of control characters, numbers
// are clamped; a malformed repo is dropped, a malformed row reads as null.
// ============================================================================

'use strict';

const VERSION = 1;
const MACHINE_RE = /^[A-Za-z0-9-]{1,63}$/;
/** "git:github.com/owner/repo" or "local:<folder>"; never a path. */
const KEY_RE = /^(git:[a-z0-9.-]+(\/[a-z0-9._-]+)+|local:[^\\/:]{1,100})$/;
const SHA_RE = /^[0-9a-f]{4,40}$/;
/** More repos than anyone keeps in one git station; a flood stops here. */
const MAX_REPOS = 100;
const MAX_KEY = 200;
const MAX_NAME = 100;
const MAX_BRANCH = 120;
const MAX_SUBJECT = 200;
/** Ahead/behind past this is a broken counter, not a backlog. */
const MAX_COUNT = 1000000;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
// eslint-disable-next-line no-control-regex
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');
const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_COUNT, Math.max(0, Math.round(v))) : 0);
/** A repo key as missionrepokey.js makes it: no '.' / '..' segments, capped. */
const isKey = (k) => typeof k === 'string' && k.length <= MAX_KEY && KEY_RE.test(k) && !k.split('/').some((p) => p === '.' || p === '..');
const timeOrNull = (v, now) => (isTime(v) ? Math.min(v, now) : null);

/**
 * One gitstation.js readRepoStatus() row -> a snapshot repo, or null (no
 * status, or a repo with no usable key).
 */
function fromStatusRow(row, keyOf, fetchedAtOf, now) {
  if (!isObject(row) || !isObject(row.status) || typeof row.path !== 'string') return null;
  const id = keyOf(row.path);
  if (!id || !isKey(id.key)) return null;
  const s = row.status;
  const lc = isObject(row.lastCommit) ? row.lastCommit : null;
  return {
    key: id.key,
    name: clean(id.name, MAX_NAME) || id.key.split('/').pop(),
    branch: clean(s.branch, MAX_BRANCH),
    dirty: count(s.staged) + count(s.changed) + count(s.untracked) + count(s.conflicts) > 0,
    ahead: count(s.ahead),
    behind: count(s.behind),
    lastCommit: lc
      ? {
          sha: SHA_RE.test(String(lc.hash || '').toLowerCase()) ? String(lc.hash).toLowerCase().slice(0, 7) : null,
          subject: clean(lc.subject, MAX_SUBJECT),
          at: timeOrNull(lc.at, now),
        }
      : null,
    fetchedAt: timeOrNull(fetchedAtOf(row.path), now),
  };
}

/**
 * This PC's `repos` snapshot from gitstation.js readAllRepos() rows.
 * `keyOf(path)` -> {key, name} (missionrepokey resolve), `fetchedAtOf(path)`
 * -> ms of the last fetch or null. One entry per key: readAllRepos sorts by
 * attention, so the clone that needs it most wins. No path is copied.
 * @returns {{v: number, at: number, machine: string, repos: object[]}}
 */
function reposSnapshot(rows, { machine, keyOf, fetchedAtOf = () => null, now = Date.now() }) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const repo = fromStatusRow(row, keyOf, fetchedAtOf, now);
    if (repo && !byKey.has(repo.key)) byKey.set(repo.key, repo);
    if (byKey.size >= MAX_REPOS) break;
  }
  const repos = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { v: VERSION, at: now, machine: MACHINE_RE.test(machine) ? machine : 'unknown', repos };
}

/** One repo from a peer row, or null to drop it. */
function cleanRepo(r, now) {
  if (!isObject(r) || !isKey(r.key)) return null;
  const lc = isObject(r.lastCommit) ? r.lastCommit : null;
  const sha = lc && typeof lc.sha === 'string' && SHA_RE.test(lc.sha) ? lc.sha.slice(0, 7) : null;
  return {
    key: r.key,
    name: clean(r.name, MAX_NAME) || r.key.split('/').pop(),
    branch: clean(r.branch, MAX_BRANCH),
    dirty: r.dirty === true,
    ahead: count(r.ahead),
    behind: count(r.behind),
    lastCommit: lc ? { sha, subject: clean(lc.subject, MAX_SUBJECT), at: timeOrNull(lc.at, now) } : null,
    fetchedAt: timeOrNull(r.fetchedAt, now),
  };
}

/** A `repos` row ({machine, data}) -> {machine, at, repos} or null. Never throws. */
function parseReposPeer(row, now = Date.now()) {
  try {
    if (!isObject(row) || typeof row.machine !== 'string' || !MACHINE_RE.test(row.machine)) return null;
    const d = row.data;
    if (!isObject(d) || d.v !== VERSION || !isTime(d.at) || !Array.isArray(d.repos)) return null;
    const seen = new Set();
    const repos = [];
    for (const r of d.repos.slice(0, MAX_REPOS)) {
      const repo = cleanRepo(r, now);
      if (repo && !seen.has(repo.key)) {
        seen.add(repo.key);
        repos.push(repo);
      }
    }
    // A far-future clock must not make a copy look fresh forever.
    return { machine: row.machine, at: Math.min(d.at, now), repos };
  } catch {
    return null;
  }
}

/** Whether the PCs holding one repo disagree on the branch or HEAD commit. */
function isDiverged(entries) {
  if (entries.length < 2) return false;
  const branches = new Set(entries.map((e) => e.branch));
  const shas = new Set(entries.map((e) => e.lastCommit && e.lastCommit.sha).filter(Boolean));
  return branches.size > 1 || shas.size > 1;
}

/**
 * Parsed peers (parseReposPeer output) -> one entry per repo key with a row
 * per PC and the flags the phone shows. One copy per machine name
 * (case-insensitive), the newer wins. Flagged repos first, then by name.
 * @returns {Array<{key, name, machines: object[], needsPush, behind, dirty, diverged}>}
 */
function mergeRepos(peers) {
  const byMachine = new Map();
  for (const p of Array.isArray(peers) ? peers : []) {
    if (!p || !Array.isArray(p.repos)) continue;
    const id = p.machine.toLowerCase();
    const prev = byMachine.get(id);
    if (!prev || p.at > prev.at) byMachine.set(id, p);
  }
  const byKey = new Map();
  for (const p of byMachine.values()) {
    for (const r of p.repos) {
      const list = byKey.get(r.key) || [];
      byKey.set(r.key, [...list, { ...r, machine: p.machine, at: p.at }]);
    }
  }
  const merged = [...byKey.entries()].map(([key, entries]) => {
    const machines = [...entries].sort((a, b) => a.machine.localeCompare(b.machine));
    return {
      key,
      name: machines[0].name,
      machines,
      needsPush: machines.some((m) => m.ahead > 0),
      behind: machines.some((m) => m.behind > 0),
      dirty: machines.some((m) => m.dirty),
      diverged: isDiverged(machines),
    };
  });
  const flagged = (e) => (e.diverged || e.needsPush || e.behind || e.dirty ? 0 : 1);
  return merged.sort((a, b) => flagged(a) - flagged(b) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** Raw rows ({machine, data}) from every PC -> mergeRepos() output. */
function reposFrom(rows, now = Date.now()) {
  const peers = (Array.isArray(rows) ? rows : []).map((r) => parseReposPeer(r, now)).filter(Boolean);
  return mergeRepos(peers);
}

module.exports = { reposSnapshot, parseReposPeer, mergeRepos, reposFrom, VERSION, MAX_REPOS };
