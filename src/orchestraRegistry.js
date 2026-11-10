// ============================================================================
// LunaCore - multi God Mode registry (docs/tbc_docs/MULTI_GODMODE_PLAN.md A2)
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
//
// A3 - accounts and power (docs/tbc_docs/MULTI_GODMODE_PLAN.md):
//   limits    a worker that hits its 5 h / weekly wall first moves to another
//             Claude account (main's failoverTab) and nothing pauses. Only
//             when every account is out does onUsageLimit call pauseAll: each
//             run with a worker on a Claude account pauses until the EARLIEST
//             reset, so the first account back resumes every run. Runs whose
//             workers use their own backend (a provider profile) go on.
//   memory    accounts known to be out, until their reset (noteAccountLimit,
//             fed by worker limits and the usage meter). claudeaccounts.js
//             merges it into every pick, so a worker launched later starts on
//             an account with room.
//   power     ONE sleep / shutdown flow (orchestraPower.js) for every run,
//             handed to each controller; its view is aggregatePowerRun over
//             the runs. Its view, cancel and wake check are global.
// ============================================================================

'use strict';

const path = require('path');
const { createPowerFlow, aggregatePowerRun } = require('./orchestraPower');
const { UNKNOWN_RESET_MS } = require('./claudeaccounts');

/** The registry key: a project id, or null for "no project". */
const keyOf = (projectId) => (typeof projectId === 'string' ? projectId : null);

/** A repo path compared resolved and case-insensitive (Windows folders), or null. */
function repoKey(repoPath) {
  return typeof repoPath === 'string' && repoPath ? path.resolve(repoPath).toLowerCase() : null;
}

const errText = (err) => (err instanceof Error ? err.message : String(err));
const label = (projectId) => (projectId === null ? '(none)' : projectId);

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isAccountId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 64;

/**
 * @param {{
 *   makeController: (projectId:string|null, shared:{powerFlow:object|null}) => object,
 *   log?: (line:string) => void,
 *   now?: () => number,
 *   power?: object,
 *   accounts?: () => Array<{id:string, limitedUntil:number|null}>,
 *   onClaudeAccount?: (sessionId:string) => boolean,
 * }} deps
 *   makeController: a createOrchestra() for that project, deps bound to it;
 *     `shared.powerFlow` is the registry's flow (null without `power`)
 *   power: createPowerFlow deps minus getRun - the one sleep / shutdown flow
 *   accounts: the Claude accounts in preference order (claudeAccounts.list(),
 *     never a token); empty = none set up, the one /login account
 *   onClaudeAccount: the tab runs on a Claude subscription, not on its own
 *     backend (default: every tab does)
 */
function createOrchestraRegistry(deps) {
  if (!deps || typeof deps.makeController !== 'function') throw new TypeError('makeController is required');
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const onClaudeAccount = deps.onClaudeAccount || (() => true);
  /** @type {Map<string|null, object>} */
  const runs = new Map();
  /** accountId -> epoch ms its limit resets; replaced, never edited in place. */
  let accountLimits = {};

  const powerStates = () =>
    [...runs.values()].map((c) => (typeof c.powerState === 'function' ? c.powerState() : null));
  const powerFlow = deps.power
    ? createPowerFlow({ ...(deps.now ? { now: deps.now } : {}), ...deps.power, getRun: () => aggregatePowerRun(powerStates()) })
    : null;

  /** The project's controller, created on first use. */
  function ensure(projectId) {
    const key = keyOf(projectId);
    let controller = runs.get(key);
    if (!controller) {
      controller = deps.makeController(key, { powerFlow });
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

  // ---- A3: accounts known to be out --------------------------------------

  /** The remembered limits that have not reset yet. */
  function limitedAccounts() {
    const t = now();
    return Object.fromEntries(Object.entries(accountLimits).filter(([, at]) => at > t));
  }

  const limitOf = (accountId) => limitedAccounts()[accountId] || 0;

  /**
   * Remembers that `accountId` is out until `until` - a later reset already
   * known wins (a weekly wall outlasts a 5 h one). No readable reset: an
   * hour, like claudeaccounts.js.
   */
  function noteAccountLimit(accountId, until) {
    if (!isAccountId(accountId)) return;
    const t = now();
    const at = isTime(until) && until > t ? until : t + UNKNOWN_RESET_MS;
    if (limitOf(accountId) >= at) return;
    accountLimits = { ...limitedAccounts(), [accountId]: at };
  }

  /** The usage meter read the real reset: it replaces whatever was remembered. */
  function setAccountLimit(accountId, until) {
    if (!isAccountId(accountId) || !isTime(until) || until <= now()) return;
    accountLimits = { ...limitedAccounts(), [accountId]: until };
  }

  /** The account has room again (the meter saw its window reset, or Mati said so). */
  function clearAccountLimit(accountId) {
    if (!Object.prototype.hasOwnProperty.call(accountLimits, accountId)) return;
    const { [accountId]: _gone, ...rest } = accountLimits;
    accountLimits = rest;
  }

  function readAccounts() {
    try {
      const list = deps.accounts ? deps.accounts() : [];
      return Array.isArray(list) ? list.filter((a) => a && isAccountId(a.id)) : [];
    } catch (err) {
      log(`[orchestra] could not read the Claude accounts: ${errText(err)}`);
      return [];
    }
  }

  /**
   * Whether every Claude account is out, and until when the first one is.
   * No accounts set up: the one /login account is, until `resetsAt`.
   * @param {number|null} resetsAt the limit the worker just hit
   * @returns {{out:boolean, until:number|null}}
   */
  function allAccountsOut(resetsAt) {
    const list = readAccounts();
    if (!list.length) return { out: true, until: isTime(resetsAt) ? resetsAt : null };
    const t = now();
    const untils = list.map((a) => Math.max(limitOf(a.id), isTime(a.limitedUntil) ? a.limitedUntil : 0));
    if (untils.some((at) => at <= t)) return { out: false, until: null };
    return { out: true, until: Math.min(...untils) };
  }

  /**
   * Every Claude account is out: each run with a worker on a Claude account
   * pauses until `until`. A run whose workers all use their own backend goes on.
   * @param {number|null} until epoch ms (null: the controller's default pause)
   * @returns {number} how many runs paused
   */
  function pauseAll(until) {
    let paused = 0;
    each((c) => {
      const tabs = typeof c.workerSessions === 'function' ? c.workerSessions() : [];
      if (!tabs.some((id) => onClaudeAccount(id))) return;
      if (c.pauseExternal(until)) paused += 1;
    }, 'pauseAll');
    if (paused) log(`[orchestra] every Claude account is out - ${paused} run(s) paused until ${new Date(until || now()).toISOString()}`);
    return paused;
  }

  /**
   * A worker hit the usage limit and its tab could not move to another
   * account (main's failoverTab said no). On a Claude account with every
   * account out, every run waits for the earliest reset. Otherwise - its own
   * backend's limit, or another account still has room and only the
   * failover loop guard said no - just its own run waits.
   * @param {string} sessionId
   * @param {number|null} resetsAt
   * @param {{onAccount?:boolean}} [scope]
   */
  function onUsageLimit(sessionId, resetsAt, scope) {
    const owner = bySession(sessionId);
    if (!owner) return undefined;
    if (scope && scope.onAccount === true) {
      const all = allAccountsOut(resetsAt);
      if (all.out && pauseAll(all.until) > 0) return undefined;
    }
    return owner.controller.onUsageLimit(sessionId, resetsAt);
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
    // A run that is live anywhere (the battery warning).
    anyLive: () => [...runs.values()].some(isLive),
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
    onUsageLimit,
    onApproval: (sessionId, rule, example) => route(sessionId, (c) => c.onApproval(sessionId, rule, example)),
    onFiles: (sessionId, files) => route(sessionId, (c) => c.onFiles(sessionId, files)),
    // A tab's transcript token totals: offered to every run, because a fix-up
    // worker's tab is not a package (ownsSession does not know it).
    onSessionUsage: (sessionId, byModel) =>
      each((c) => (typeof c.onSessionUsage === 'function' ? c.onSessionUsage(sessionId, byModel) : undefined), 'sessionUsage'),
    // Free God Mode v2 F3: the model that really answered a free worker
    // (src/fallbackproxy.js onRoute) - each free run notes it in its log.
    onFreeRoute: (info) => each((c) => (typeof c.onFreeRoute === 'function' ? c.onFreeRoute(info) : undefined), 'freeRoute'),
    // A3: accounts and the shared power flow.
    pauseAll,
    noteAccountLimit,
    setAccountLimit,
    clearAccountLimit,
    limitedAccounts,
    allAccountsOut,
    powerFlow,
  };
}

module.exports = { createOrchestraRegistry, repoKey };
