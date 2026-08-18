// ============================================================================
// LunaCore - git station
// ----------------------------------------------------------------------------
// Branch, working-tree state and ahead/behind for the repos you care about, in
// one place, without opening a shell in each of them.
//
// The bug this exists to catch: a repo that lives on two machines. Both clones
// look fine locally and neither says a word about the other, so the way you
// find out is a merge conflict, or 71 commits of divergence discovered the hard
// way. Ahead/behind is the number that would have told you, and nothing shows
// it to you unless you go and ask.
//
// WHICH REPOS: an explicit list in config/repos.local.json (gitignored by the
// config/*.local.* rule, since a list of paths on your disk is nobody else's
// business). `discoverRepos` seeds that list on demand rather than scanning the
// disk on a timer - an autodiscovered list changes under you, and a panel whose
// contents move on their own is not a status board.
//
// WHAT IT DOES: reads, plus fetch. Fetch touches the network and updates
// ahead/behind; it cannot alter a working tree, so it is safe to fire from a
// glanceable panel. Pull, commit and push are deliberately absent from THIS
// panel - those belong in a terminal where you can see what happened, and
// this panel sits one stray click away from your whole afternoon.
//
// commitAll/pushCurrent/fetchDir (below) exist for a DIFFERENT caller: the
// Ctrl+G quick-menu (modules/gitquick.js), a deliberate multi-keystroke path
// (open menu, pick action, type a commit message) on the tab's own repo, not
// a whitelist or a stray click. Same execFile safety, different UI contract.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const paths = require('./paths');

const localFile = () => paths.local('repos.local.json');

// Repos are usually in one of a handful of places. These are only SEEDS for the
// scan button - nothing here is watched, and a root that does not exist on this
// machine is skipped rather than reported.
const DEFAULT_ROOTS = Object.freeze([
  path.join(os.homedir(), 'source', 'repos'),
  path.join(os.homedir(), 'repos'),
  path.join(os.homedir(), 'projects'),
  path.join(os.homedir(), 'dev'),
  path.join(os.homedir(), '.local', 'bin'),
]);

// How deep under a root a .git may sit. One level covers ~/repos/<name>; two
// covers the extra folder a downloaded zip leaves behind
// (<name>-main/<name>-main), which is exactly how this repo is checked out.
const SCAN_DEPTH = 2;

// A fetch waits on the network, so it gets a longer leash than a status read.
const STATUS_TIMEOUT_MS = 10000;
const FETCH_TIMEOUT_MS = 30000;

/** Safe read + JSON parse. Returns null when the file is missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Runs git in a directory. Resolves { ok, stdout, stderr } - never rejects.
 *
 * Captures stderr too, not just stdout: `git push`'s entire human-readable
 * output (progress, "Everything up-to-date", rejection reasons) goes to
 * stderr by convention - a helper that dropped it would make every push
 * result look silently empty.
 */
function git(dir, args, timeout = STATUS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' })
    );
  });
}

/** Is this a directory holding a .git entry (dir for a clone, file for a worktree)? */
function isRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * Walks the roots looking for repos, at most SCAN_DEPTH deep.
 *
 * Stops descending as soon as it finds one: the interesting unit is the repo,
 * and walking into node_modules looking for more is how a "quick scan" turns
 * into a minute of disk I/O.
 */
function discoverRepos(roots = DEFAULT_ROOTS, depth = SCAN_DEPTH) {
  const found = [];

  const walk = (dir, left) => {
    if (left < 0) return;
    if (isRepo(dir)) {
      found.push(dir);
      return;
    }
    if (left === 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), left - 1);
    }
  };

  for (const root of roots) {
    if (!root) continue;
    try {
      if (fs.statSync(root).isDirectory()) walk(root, depth);
    } catch {
      /* a root that is not on this machine is not an error */
    }
  }
  return [...new Set(found)];
}

/**
 * Parses `git status --porcelain=v2 --branch`.
 *
 * Pure, because this is where the whole panel's truth comes from and it has to
 * be right: v2 gives branch, upstream, ahead/behind and every changed path from
 * ONE process, which is what keeps a refresh over eight repos cheap.
 */
function parseStatus(stdout) {
  const out = {
    branch: '',
    upstream: '',
    ahead: 0,
    behind: 0,
    staged: 0,
    changed: 0,
    untracked: 0,
    conflicts: 0,
    detached: false,
  };
  if (typeof stdout !== 'string') return out;

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      // v2 spells a detached HEAD as the literal "(detached)".
      out.detached = head === '(detached)';
      out.branch = head;
    } else if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        out.ahead = Number(m[1]);
        out.behind = Number(m[2]);
      }
    } else if (line[0] === '1' || line[0] === '2') {
      // "1 XY ..." - X is the staged status, Y the unstaged one. A file can be
      // both, so these two counters deliberately overlap.
      const xy = line.slice(2, 4);
      if (xy[0] && xy[0] !== '.') out.staged += 1;
      if (xy[1] && xy[1] !== '.') out.changed += 1;
    } else if (line[0] === 'u') {
      out.conflicts += 1;
    } else if (line[0] === '?') {
      out.untracked += 1;
    }
  }
  return out;
}

/**
 * Parses `git log -1 --format=%h%x00%ct%x00%s` into { hash, at, subject }.
 *
 * NUL-separated rather than space- or pipe-separated: a commit subject is free
 * text and will eventually contain whichever printable character you picked as
 * a delimiter.
 */
function parseLastCommit(stdout) {
  if (typeof stdout !== 'string') return null;
  const parts = stdout.trim().split('\0');
  if (parts.length < 3 || !parts[0].trim()) return null;
  const at = Number(parts[1]) * 1000;
  return {
    hash: parts[0].trim(),
    at: Number.isFinite(at) ? at : null,
    subject: parts.slice(2).join('\0').trim(),
  };
}

/**
 * Is this repo asking for attention, and how loudly?
 *
 * Ordered by what actually costs you time: a conflicted tree blocks everything,
 * divergence is the two-machine trap, behind is a pull away, dirty is just
 * work in progress. Pure so the wording is decided in one place.
 */
function repoState(status) {
  if (!status) return 'unknown';
  if (status.conflicts > 0) return 'conflict';
  if (status.ahead > 0 && status.behind > 0) return 'diverged';
  if (status.behind > 0) return 'behind';
  if (status.ahead > 0) return 'ahead';
  if (status.staged + status.changed + status.untracked > 0) return 'dirty';
  if (!status.upstream && !status.detached) return 'noUpstream';
  return 'clean';
}

/** Reads one repo. Never throws: a missing or broken repo becomes a row with an error. */
async function readRepoStatus(dir) {
  const name = path.basename(dir);
  if (!isRepo(dir)) {
    return { path: dir, name, error: 'notARepo', status: null, lastCommit: null, state: 'unknown' };
  }

  const [status, log] = await Promise.all([
    git(dir, ['status', '--porcelain=v2', '--branch']),
    git(dir, ['log', '-1', '--format=%h%x00%ct%x00%s']),
  ]);

  if (!status.ok) {
    return { path: dir, name, error: 'gitFailed', status: null, lastCommit: null, state: 'unknown' };
  }

  const parsed = parseStatus(status.stdout);
  return {
    path: dir,
    name,
    error: '',
    status: parsed,
    // A repo with no commits yet has no log, which is not a failure.
    lastCommit: log.ok ? parseLastCommit(log.stdout) : null,
    state: repoState(parsed),
  };
}

/** The configured list, or an empty one before the first scan. */
function loadRepoList() {
  const data = readJson(localFile());
  const repos = data && Array.isArray(data.repos) ? data.repos : [];
  const roots = data && Array.isArray(data.roots) ? data.roots : DEFAULT_ROOTS;
  return {
    repos: repos.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim()),
    roots: roots.filter((r) => typeof r === 'string' && r.trim()),
  };
}

/** Writes the list back. This file is the panel's own state, not user config. */
function saveRepoList(repos, roots) {
  const file = localFile();
  const body = {
    repos: Array.from(new Set(repos.filter((r) => typeof r === 'string' && r.trim()))),
    roots: roots && roots.length ? roots : DEFAULT_ROOTS,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Reads every configured repo, in parallel. */
async function readAllRepos() {
  const { repos } = loadRepoList();
  const rows = await Promise.all(repos.map((dir) => readRepoStatus(dir)));
  // Attention first, name second - the same principle as the MCP panel: the
  // rows you have to do something about should not need looking for.
  const rank = {
    conflict: 0,
    diverged: 1,
    behind: 2,
    ahead: 3,
    dirty: 4,
    noUpstream: 5,
    clean: 6,
    unknown: 7,
  };
  return rows.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

/** Fetches one repo, then re-reads it so the caller gets fresh ahead/behind. */
async function fetchRepo(dir) {
  const { repos } = loadRepoList();
  // Only ever act on a path the user put in the list. The renderer sends this
  // path back to us, and a fetch runs a network command in whatever directory
  // it names - so the list is the whitelist.
  if (!repos.includes(dir)) return { ok: false, error: 'notListed', repo: null };
  return fetchDir(dir);
}

/**
 * Fetches one repo with no whitelist check, then re-reads it.
 *
 * Used by the Ctrl+G quick-menu: the trust boundary there is the active tab's
 * OWN working directory (resolved server-side from the session, never a path
 * the renderer names directly), not the panel's `repos.local.json` list -
 * see main.js's `git:quickAction` handler.
 */
async function fetchDir(dir) {
  const res = await git(dir, ['fetch', '--all', '--prune'], FETCH_TIMEOUT_MS);
  return { ok: res.ok, error: res.ok ? '' : 'fetchFailed', output: res.stderr || res.stdout, repo: await readRepoStatus(dir) };
}

/**
 * Stages everything and commits. Two git calls, not `commit -a`: `-a` skips
 * untracked files, and "quick save" should not quietly leave new files
 * behind. Never throws - a failed add or commit becomes an error field.
 */
async function commitAll(dir, message) {
  const add = await git(dir, ['add', '-A']);
  if (!add.ok) return { ok: false, error: 'addFailed', output: add.stderr || add.stdout };
  const commit = await git(dir, ['commit', '-m', message]);
  return { ok: commit.ok, error: commit.ok ? '' : 'commitFailed', output: commit.stdout || commit.stderr };
}

/**
 * Pushes the current branch to its upstream. Network call, same timeout as
 * fetch. `output` reads from stderr first - see the git() header comment.
 */
async function pushCurrent(dir) {
  const res = await git(dir, ['push'], FETCH_TIMEOUT_MS);
  return { ok: res.ok, error: res.ok ? '' : 'pushFailed', output: res.stderr || res.stdout };
}

/** Runs the scan and merges what it finds into the saved list. */
function scanForRepos() {
  const { repos, roots } = loadRepoList();
  const found = discoverRepos(roots);
  const merged = [...new Set([...repos, ...found])];
  saveRepoList(merged, roots);
  return merged;
}

// Same split as ports.js: the parsers are pure text -> rows and carry every
// rule worth pinning, while anything that spawns git is left to manual checks.
module.exports = {
  readAllRepos,
  readRepoStatus,
  fetchRepo,
  fetchDir,
  commitAll,
  pushCurrent,
  scanForRepos,
  loadRepoList,
  saveRepoList,
  discoverRepos,
  parseStatus,
  parseLastCommit,
  repoState,
  DEFAULT_ROOTS,
};
