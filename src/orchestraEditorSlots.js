// ============================================================================
// LunaCore - God Mode: packages that run their own Unity editor on their worktree
// ----------------------------------------------------------------------------
// A Luna's Work Unity build briefs some packages to open their own Unity
// editor on their worktree (src/lunasworkWorktreeEditors.js: the scene worker
// and editor-code packages). A Unity editor with a fresh import holds several
// GB of RAM, so:
//
//   cap     at most `max` of them hold a worker slot at once. A ready one
//           beyond the cap is masked and the ready list read again, so a
//           package without an editor takes the free slot instead; the held
//           one launches once a slot frees up (the tick retries). Editors
//           still being closed count as open.
//   reaper  a package that settles (pushed, stalled, failed, closed, killed)
//           gets the editors on its worktree closed once per launch - the
//           brief tells the worker to close it, this is the safety net.
//           Worktree removal closes editors on its own (src/worktrees.js).
//
// God Mode only gets the policy {max, needs, close} through deps.worktreeEditors
// while such a build runs (src/orchestraWiring.js); every other run launches
// exactly as before. `close` must never touch the editor on the main
// checkout (src/unityWorktreeEditors.js closeEditors holds that rule).
// ============================================================================

'use strict';

/** A ready package held back for an editor slot is masked with this state. */
const EDITOR_HELD_STATE = 'editor_held';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * The policy in shape, or null (no cap applies).
 * @param {unknown} raw {max, needs, close?}
 * @returns {{max:number, needs:(pkg:object)=>boolean, close:((root:string, repoPath:string)=>Promise<unknown>)|null}|null}
 */
function editorPolicyOf(raw) {
  if (!isObj(raw) || typeof raw.needs !== 'function' || !Number.isInteger(raw.max) || raw.max < 1) return null;
  return { max: raw.max, needs: raw.needs, close: typeof raw.close === 'function' ? raw.close : null };
}

/** `needs` that never throws: a broken classifier counts the package as editor-free. */
function safeNeeds(needs, log) {
  return (pkg) => {
    try {
      return needs(pkg) === true;
    } catch (err) {
      log(`[orchestra] worktree editor check failed for ${isObj(pkg) ? pkg.id : '?'}: ${errText(err)}`);
      return false;
    }
  };
}

/**
 * Which ready packages may launch under the editor cap.
 * @param {object[]} packages the run's packages (other masks already applied)
 * @param {{readyOf:(packages:object[])=>object[], isActive:(pkg:object)=>boolean,
 *   needs:(pkg:object)=>boolean, max:number, closing?:number}} opts
 *   readyOf: the run's ready list for a package list (global and kind caps applied);
 *   closing: editors of settled packages still being closed
 * @returns {{ready:object[], held:string[]}} held = ids waiting for an editor slot
 */
function capEditorLaunches(packages, { readyOf, isActive, needs, max, closing = 0 }) {
  const list = Array.isArray(packages) ? packages : [];
  const open = list.filter((p) => isActive(p) && needs(p)).length + (Number.isInteger(closing) && closing > 0 ? closing : 0);
  const held = new Set();
  let masked = list;
  // Each round masks at least one more package, so this ends.
  for (let round = 0; round <= list.length; round += 1) {
    const ready = readyOf(masked);
    let used = open;
    const over = [];
    const ok = ready.filter((p) => {
      if (!needs(p)) return true;
      if (used < max) {
        used += 1;
        return true;
      }
      over.push(p.id);
      return false;
    });
    if (!over.length) return { ready: ok, held: [...held] };
    for (const id of over) held.add(id);
    masked = masked.map((p) => (held.has(p.id) && p.state === 'pending' ? { ...p, state: EDITOR_HELD_STATE } : p));
  }
  return { ready: [], held: [...held] };
}

/** One launch of a package on one worktree: a relaunch (new worktree or start) is a new key. */
const launchKey = (pkg) => [pkg.id, pkg.root, pkg.startedAt || ''].join('\u0000');

/**
 * Closes the worktree editors of settled editor packages, once per launch.
 * @param {{isSettled:(pkg:object)=>boolean, onClosed?:()=>void, log?:(line:string)=>void}} deps
 *   onClosed: an editor close finished (a held package may launch now)
 */
function createEditorReaper({ isSettled, onClosed = () => {}, log = () => {} }) {
  const done = new Set();
  let closing = 0;

  function report(pkg, res) {
    const closed = isObj(res) && Array.isArray(res.closed) ? res.closed : [];
    const failed = isObj(res) && Array.isArray(res.failed) ? res.failed : [];
    if (closed.length) log(`[orchestra] ${pkg.id} settled: closed ${closed.length} Unity editor(s) on its worktree`);
    for (const f of failed) log(`[orchestra] ${pkg.id} settled: a Unity editor on its worktree did not close: ${errText(isObj(f) ? f.detail : f)}`);
  }

  async function closeOne(policy, pkg, repoPath) {
    closing += 1;
    try {
      report(pkg, await policy.close(pkg.root, repoPath));
    } catch (err) {
      log(`[orchestra] ${pkg.id} settled: closing its Unity editor failed: ${errText(err)}`);
    } finally {
      closing -= 1;
      onClosed();
    }
  }

  /**
   * Starts closing the editors of every editor package that settled since the last sweep.
   * @param {object[]} packages
   * @param {string} repoPath the main checkout (never closed)
   * @param {object|null} policy editorPolicyOf()
   * @param {(pkg:object)=>boolean} needs the policy's classifier, made safe (safeNeeds)
   * @returns {Promise<void>[]} the closes started (tests wait for them)
   */
  function sweep(packages, repoPath, policy, needs) {
    if (!policy || !policy.close) return [];
    const started = [];
    for (const pkg of Array.isArray(packages) ? packages : []) {
      if (!isObj(pkg) || typeof pkg.root !== 'string' || !pkg.root || !isSettled(pkg) || !needs(pkg)) continue;
      const key = launchKey(pkg);
      if (done.has(key)) continue;
      done.add(key);
      started.push(closeOne(policy, pkg, repoPath));
    }
    return started;
  }

  return { sweep, closing: () => closing };
}

module.exports = { EDITOR_HELD_STATE, editorPolicyOf, safeNeeds, capEditorLaunches, createEditorReaper };
