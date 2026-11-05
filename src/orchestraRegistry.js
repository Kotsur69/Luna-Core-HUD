// ============================================================================
// LunaCore - multi God Mode registry (docs/MULTI_GODMODE_PLAN.md A2)
// ----------------------------------------------------------------------------
// One God Mode controller (src/orchestra.js createOrchestra, still single-plan)
// per project, several projects at once. A tab with no project plans under
// projectId null, like todo.js keeps a list for it. Pure: the controllers are
// built by the injected makeController(projectId); no Electron, no IO.
//
//   routing   session events go to the controller that owns the session
//             (ownsSession). A fix-up worker's tab is not a package, so a
//             turn end or a tab close nobody owns is offered to every
//             controller - each one ignores a session that is not its own.
//   lookups   ensure / get by project, bySession, byPlanId, views
//   fan-out   tick, onSystemResume, restoreAll, killAll - one controller
//             throwing never stops the others
//   guards    anyRunning (the Ctrl+Shift+K hotkey), othersActive (shutdown
//             waits for every run), repoBusy (the same repo twice is refused:
//             resolved, case-insensitive paths)
// ============================================================================

'use strict';

const path = require('path');

/** The registry key: a project id, or null for "no project". */
const keyOf = (projectId) => (typeof projectId === 'string' ? projectId : null);

/** A repo path compared resolved and case-insensitive (Windows folders), or null. */
function repoKey(repoPath) {
  return typeof repoPath === 'string' && repoPath ? path.resolve(repoPath).toLowerCase() : null;
}

const errText = (err) => (err instanceof Error ? err.message : String(err));
const label = (projectId) => (projectId === null ? '(none)' : projectId);

/**
 * @param {{makeController: (projectId:string|null) => object, log?: (line:string) => void}} deps
 *   makeController: a createOrchestra() for that project, deps bound to it
 */
function createOrchestraRegistry(deps) {
  if (!deps || typeof deps.makeController !== 'function') throw new TypeError('makeController is required');
  const log = deps.log || (() => {});
  /** @type {Map<string|null, object>} */
  const runs = new Map();

  /** The project's controller, created on first use. */
  function ensure(projectId) {
    const key = keyOf(projectId);
    let controller = runs.get(key);
    if (!controller) {
      controller = deps.makeController(key);
      runs.set(key, controller);
    }
    return controller;
  }

  /** The project's controller, or null when it has none. */
  const get = (projectId) => runs.get(keyOf(projectId)) || null;

  function find(pred) {
    for (const [projectId, controller] of runs) {
      if (pred(controller)) return { projectId, controller };
    }
    return null;
  }

  /** @returns {{projectId:string|null, controller:object}|null} */
  const bySession = (sessionId) =>
    typeof sessionId === 'string' && sessionId ? find((c) => c.ownsSession(sessionId)) : null;

  /**
   * The run whose plan has this id. Plan ids are millisecond stamps, so two
   * projects could in theory share one: an ambiguous id names no run (the
   * caller fails closed) rather than whichever project comes first.
   * @returns {{projectId:string|null, controller:object}|null}
   */
  function byPlanId(planId) {
    if (typeof planId !== 'string' || !planId) return null;
    const hits = [...runs].filter(([, c]) => {
      const view = c.view();
      return !!view && view.id === planId;
    });
    return hits.length === 1 ? { projectId: hits[0][0], controller: hits[0][1] } : null;
  }

  /** Every run that has a plan: [{projectId, view, running}]. */
  function views() {
    const out = [];
    for (const [projectId, controller] of runs) {
      const view = controller.view();
      if (view) out.push({ projectId, view, running: controller.isRunning() });
    }
    return out;
  }

  /** Runs `fn` on every controller; one throwing is logged, the rest still run. */
  function each(fn, where) {
    for (const [projectId, controller] of runs) {
      try {
        fn(controller, projectId);
      } catch (err) {
        log(`[orchestra] ${where} failed for project ${label(projectId)}: ${errText(err)}`);
      }
    }
  }

  // A plan that is not settled yet - held, running, paused, or killed with its
  // worktrees still there (Retry brings it back) - holds its repo.
  const holdsRepo = (controller) => {
    const view = controller.view();
    return !!view && !view.settled;
  };

  // Planning, a worker or finalize going, or a started run that is neither
  // killed nor settled (e.g. every worker waiting on Mati).
  const isLive = (controller) => {
    if (controller.isBusy() || controller.isRunning()) return true;
    const view = controller.view();
    return !!view && view.started === true && !view.killed && !view.settled;
  };

  const others = (projectId) => {
    const key = keyOf(projectId);
    return [...runs].filter(([id]) => id !== key).map(([, c]) => c);
  };

  /** Another project's run is live (shutdownWhenDone waits for every run). */
  const othersActive = (projectId) => others(projectId).some(isLive);

  /**
   * Another project's run holds this repo, or is planning for it right now.
   * @param {string|null} projectId the project asking
   * @param {string} repoPath
   */
  function repoBusy(projectId, repoPath) {
    const want = repoKey(repoPath);
    if (!want) return false;
    return others(projectId).some(
      (c) => (holdsRepo(c) && repoKey(c.repoPath()) === want) || repoKey(c.planningRepo()) === want,
    );
  }

  /**
   * Brings back the stored runs (held - nothing launches). A project whose
   * stored run is not restored gets no controller.
   * @param {Array<string|null>} projectIds
   * @returns {Array<string|null>} the projects whose run came back
   */
  function restoreAll(projectIds) {
    const restored = [];
    for (const projectId of new Set((Array.isArray(projectIds) ? projectIds : []).map(keyOf))) {
      const existed = runs.has(projectId);
      let ok = false;
      try {
        ok = ensure(projectId).restore() === true;
      } catch (err) {
        log(`[orchestra] restore failed for project ${label(projectId)}: ${errText(err)}`);
      }
      if (ok) restored.push(projectId);
      else if (!existed) runs.delete(projectId);
    }
    return restored;
  }

  /** The kill switch for every run. @returns {number} how many runs were stopped */
  function killAll() {
    let killed = 0;
    each((c) => {
      if (c.kill()) killed += 1;
    }, 'kill');
    return killed;
  }

  /** A session event for its owner or - nobody owns it - for every controller. */
  function routeOrOffer(sessionId, fn, where) {
    const owner = bySession(sessionId);
    if (owner) return fn(owner.controller);
    let handled = false;
    each((c) => {
      if (fn(c)) handled = true;
    }, where);
    return handled;
  }

  /** A session event only the owning controller can act on. */
  function route(sessionId, fn) {
    const owner = bySession(sessionId);
    return owner ? fn(owner.controller) : undefined;
  }

  return {
    ensure,
    get,
    bySession,
    byPlanId,
    views,
    /** Every controller, with or without a plan: [{projectId, controller}]. */
    entries: () => [...runs].map(([projectId, controller]) => ({ projectId, controller })),
    ownsSession: (sessionId) => !!bySession(sessionId),
    anyRunning: () => [...runs.values()].some((c) => c.isRunning()),
    anyOpen: () =>
      [...runs.values()].some((c) => {
        const view = c.view();
        return !!view && !view.settled && !view.killed;
      }),
    othersActive,
    repoBusy,
    tick: () => each((c) => c.tick(), 'tick'),
    // powerMonitor 'suspend': the start of a sleep that is not worker time.
    onSystemSuspend: () => each((c) => c.onSystemSuspend(), 'suspend'),
    onSystemResume: () => each((c) => c.onSystemResume(), 'resume'),
    restoreAll,
    killAll,
    onTurnEnd: (sessionId, text) => routeOrOffer(sessionId, (c) => c.onTurnEnd(sessionId, text), 'turnEnd'),
    onSessionClosed: (sessionId) =>
      routeOrOffer(sessionId, (c) => c.onSessionClosed(sessionId) === true, 'sessionClosed'),
    onUsageLimit: (sessionId, resetsAt) => route(sessionId, (c) => c.onUsageLimit(sessionId, resetsAt)),
    onApproval: (sessionId, rule, example) => route(sessionId, (c) => c.onApproval(sessionId, rule, example)),
    onFiles: (sessionId, files) => route(sessionId, (c) => c.onFiles(sessionId, files)),
  };
}

module.exports = { createOrchestraRegistry, repoKey };
