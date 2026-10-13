// ============================================================================
// LunaCore - Mission Control: commit moments for focus time (main process)
// ----------------------------------------------------------------------------
// Repos with no Claude session still show up in "Focus" through Mati's own
// commits: every commit of the last HISTORY_DAYS (author time) in the repos
// listed in config/repos.local.json becomes a moment {ms, key, name}, keyed
// like the ledger (missionrepokey.js), so missionfocus.js can turn them into
// blocks next to the Claude replies.
//
// "Mine" = the author email equals that repo's own `git config user.email`
// (work and personal repos often use different addresses). A repo without one
// is skipped - nothing else tells Mati's commits apart from a colleague's.
// `--all` on purpose: a commit pushed from another PC and fetched here is still
// his work; the cross-PC union in missionfocus.js removes the duplicate.
//
// git runs through gitstation's execFile helper (argv array, timeout, no
// shell); repo paths come from the local config and must be absolute, non-UNC.
// Results are cached for ttlMs - a Telemetry refresh must not spawn 2 x N gits.
// The ledger report must never hang on git: a stale cache is returned at once
// while a refresh runs, and a cold first scan is cut off at deadlineMs (its
// result lands in the cache for the next report). A pass where any repo
// failed is retried after RETRY_MS instead of being trusted for the full TTL.
// `-c core.fsmonitor=false`: a repo's config cannot start a hook program.
// ============================================================================

'use strict';

const path = require('path');

const HISTORY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const DEADLINE_MS = 8000;
/** git log --all over 14 days can be slow in a big repo; gitstation's default is for status reads. */
const GIT_TIMEOUT_MS = 15000;
const SAFE = ['-c', 'core.fsmonitor=false'];
const MAX_REPOS = 50;
const MAX_COMMITS = 5000;
const MAX_EMAIL = 254;

/** `%at\t%ae` lines -> epoch ms of this author's commits. */
function parseLog(stdout, email) {
  const me = String(email).trim().toLowerCase();
  const out = [];
  for (const line of String(stdout).split(/\r?\n/).slice(0, MAX_COMMITS)) {
    const m = /^(\d{1,12})\t(.+)$/.exec(line);
    if (!m || m[2].trim().toLowerCase() !== me) continue;
    out.push(Number(m[1]) * 1000);
  }
  return out;
}

/** An absolute local path; UNC would make git touch the network (SMB/NTLM). */
const usableRepo = (dir) => typeof dir === 'string' && path.isAbsolute(dir) && !/^[\\/]{2}/.test(dir);

/**
 * @param {{listRepos?:()=>string[], resolveKey:(dir:string)=>{key:string,name:string},
 *          runGit?:(dir:string,args:string[],timeoutMs:number)=>Promise<{ok:boolean,stdout:string}>,
 *          now?:()=>number, ttlMs?:number, historyDays?:number, deadlineMs?:number}} opts
 */
function createCommits({
  listRepos = () => require('./gitstation').loadRepoList().repos,
  resolveKey,
  runGit = (dir, args, timeoutMs) => require('./gitstation').git(dir, args, timeoutMs),
  now = Date.now,
  ttlMs = TTL_MS,
  historyDays = HISTORY_DAYS,
  deadlineMs = DEADLINE_MS,
}) {
  let cache = null;
  let cachedAt = -Infinity;
  let pending = null;

  /** {events, failed} for one repo; never throws. No user.email is a skip, not a failure. */
  async function repoEvents(dir, sinceMs) {
    try {
      const cfg = await runGit(dir, [...SAFE, 'config', 'user.email'], GIT_TIMEOUT_MS);
      const email = cfg.ok ? cfg.stdout.trim() : '';
      if (!email || email.length > MAX_EMAIL) return { events: [], failed: false };
      const since = `--since=${new Date(sinceMs).toISOString()}`;
      const log = await runGit(dir, [...SAFE, 'log', '--all', '--no-merges', since, '--format=%at%x09%ae'], GIT_TIMEOUT_MS);
      if (!log.ok) {
        console.error('[focus] git log failed:', path.basename(dir));
        return { events: [], failed: true };
      }
      const { key, name } = resolveKey(dir);
      const events = parseLog(log.stdout, email)
        .filter((ms) => ms >= sinceMs)
        .map((ms) => ({ ms, key, name }));
      return { events, failed: false };
    } catch (err) {
      console.error('[focus] git log failed:', path.basename(dir), err && err.message);
      return { events: [], failed: true };
    }
  }

  async function load() {
    const at = now();
    const sinceMs = at - historyDays * DAY_MS;
    let repos = [];
    try {
      repos = listRepos();
    } catch (err) {
      console.error('[focus] repo list unreadable:', err && err.message);
    }
    const dirs = [...new Set((Array.isArray(repos) ? repos : []).filter(usableRepo))].slice(0, MAX_REPOS);
    const all = [];
    let failed = false;
    // One repo at a time: two gits per repo, and nobody is waiting on the exact second.
    for (const dir of dirs) {
      const res = await repoEvents(dir, sinceMs);
      all.push(...res.events);
      failed = failed || res.failed;
    }
    cache = all;
    // A failed repo would otherwise look like "no commits" for the whole TTL.
    cachedAt = failed ? at - ttlMs + Math.min(RETRY_MS, ttlMs) : at;
    return all;
  }

  const refresh = () => pending || (pending = load().finally(() => (pending = null)));

  return {
    /**
     * Commit moments of the last historyDays. Fresh cache -> as is; stale cache
     * -> returned now, refreshed in the background; no cache -> the first scan,
     * or [] if it is not done within deadlineMs.
     */
    async events() {
      if (cache && now() - cachedAt <= ttlMs) return cache;
      const run = refresh();
      if (cache) return cache;
      let timer;
      const late = new Promise((resolve) => (timer = setTimeout(() => resolve([]), deadlineMs)));
      try {
        return await Promise.race([run, late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = { createCommits, parseLog, HISTORY_DAYS };
