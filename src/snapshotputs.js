// ============================================================================
// LunaCore - the `repos` and `godmode` snapshot puts (main)
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md U2. Glue between the git station / God Mode and
// cloudsnapshots.js, kept out of main.js:
//
//   repos.after(rows)  after a git-station refresh: put these rows
//   repos.refresh()    after a fetch: read every repo again, then put
//   godmode.add(run)   after a finalized run: add it to the local history
//                      file, then put the last runs
//   godmode.live(s)    a live run / tab lights changed (godmodelivepub.js):
//                      put the history with `live` and `tabs` over it
//
// Every put is skipped while logged out, and a failure only logs - it never
// throws into the git station or the end of a God Mode run. cloudsnapshots
// put() itself skips content identical to the last successful put.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const { reposSnapshot } = require('./repossnapshot');
const { addRun, withLive } = require('./godmodesnapshot');
const { createRepoKeys, findRepo } = require('./missionrepokey');

const errText = (err) => (err instanceof Error ? err.message : String(err));

/** Ms of a repo's last fetch (FETCH_HEAD's mtime), or null. Worktrees share the parent's. */
function fetchedAtOf(dir) {
  try {
    const repo = findRepo(dir);
    return repo ? fs.statSync(path.join(repo.gitDir, 'FETCH_HEAD')).mtimeMs : null;
  } catch {
    return null;
  }
}

/** Runs a put; resolves false instead of rejecting, with one log line. */
async function safePut(kind, fn) {
  try {
    return (await fn()) === true;
  } catch (err) {
    console.error(`[cloudsnapshots] put ${kind} failed:`, errText(err));
    return false;
  }
}

/**
 * @param {{
 *   snapshots: () => ({put: Function}|null), loggedIn: () => boolean, machine: string,
 *   readAll: () => Promise<object[]>, historyFile: () => string|null, now?: () => number,
 * }} deps
 */
function createSnapshotPuts({ snapshots, loggedIn, machine, readAll, historyFile, now = Date.now }) {
  const keys = createRepoKeys();
  const ready = () => {
    const s = snapshots();
    return s && loggedIn() ? s : null;
  };

  function putRepos(rows) {
    const s = ready();
    if (!s) return Promise.resolve(false);
    return safePut('repos', () => s.put('repos', reposSnapshot(rows, { machine, keyOf: (dir) => keys.resolve(dir), fetchedAtOf, now: now() })));
  }

  function readHistory(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null; // first run, or a broken file: the history starts over
    }
  }

  const repos = {
    /** Passes `rows` through, so a handler can return what it got. */
    after(rows) {
      putRepos(rows);
      return rows;
    },
    async refresh() {
      if (!ready()) return false;
      return safePut('repos', async () => putRepos(await readAll()));
    },
  };

  // The last live run + tab lights (godmodelivepub.js). Memory only: the
  // history file holds finished runs, and a restart publishes afresh.
  let lastLive = { live: null, tabs: [] };

  const godmode = {
    /** Adds a finalized run (godmodesnapshot runEntry) and puts the history. Never throws. */
    add(run) {
      return safePut('godmode', async () => {
        if (!run) return false;
        const file = historyFile();
        const next = addRun(file ? readHistory(file) : null, run, { machine, now: now() });
        if (file) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 });
        }
        const s = ready();
        return s ? s.put('godmode', withLive(next, lastLive, { machine, now: now() })) : false;
      });
    },
    /** Puts the run history with this live run / tab list over it. Never throws. */
    live(section) {
      lastLive = { live: (section && section.live) || null, tabs: (section && section.tabs) || [] };
      const s = ready();
      if (!s) return Promise.resolve(false);
      return safePut('godmode', async () => {
        const file = historyFile();
        return s.put('godmode', withLive(file ? readHistory(file) : null, lastLive, { machine, now: now() }));
      });
    },
  };

  return { repos, godmode };
}

module.exports = { createSnapshotPuts, fetchedAtOf };
