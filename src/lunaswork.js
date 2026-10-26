// ============================================================================
// LunaCore - Luna's Work outer loop controller (docs/LUNAS_WORK_PLAN.md, 1.5b)
// ----------------------------------------------------------------------------
// The run state machine:
//
//   preprod -> directing -> building -> launching -> playtesting -> critiquing
//                  ^                                                   |
//                  +----------------------- CONTINUE ------------------+
//                                     SHIP / PLATEAU / RED / STOP -> done
//
// Every transition is written to the run store (lunaswork.local.json) before
// the next step starts, so resume() after a restart picks the run up at its
// phase. Work inside a phase that must not repeat (the Critic's cards, the
// SHIP pass) is saved as progress too.
//
// All IO is injected: the store, the Director / builder / adapter / Playtester
// / Critic calls, the to-do store (via lunasworkCards.js), the checkout sync,
// the clock and the timers. Decisions come from lunasworkRules.js (pickModel,
// stopVerdict) and the pure lunasworkRun.js (isRiskyCard, effectiveModels,
// checkCommandFor, shipAgrees, landedCards, the stored-run shape).
//
// Verdicts:
//   SHIP     the Critic says every gate passes AND a fresh SHIP-confirmation
//            Playtester (opus, never the free providers) agrees
//   PLATEAU  3 iterations with no score gain and no card closed - a card only
//            counts once its package merged; ticked-but-unmerged cards reopen
//   RED      the merged result stayed red after fix-up 2 iterations in a row
//   STOP     the kill switch (stop()) or a `stop` steer card; the step that
//            is running finishes first. Also after MAX_STEP_FAILURES failed
//            tries of one phase (stepFailed) - never an endless retry.
//   WAIT     a usage limit: the run pauses until the reset and goes on, no
//            cap. With freeFallback the builders and the Playtester first
//            switch to the free providers until the reset instead.
//
// The profile (start command, URL) and the self-check command are pinned in
// the run when Mati confirms the start; later settings changes never reach it.
//
// The merged result never reaches `main` red: God Mode's self-check gate
// (orchestraSelfCheck.selfCheckGate) runs inside the build and pushes a red
// result to luna/<slug>-integration after one fix-up try. This module has no
// push of its own; after each build it only fast-forwards the checkout.
//
// Extension seams: status(), subscribe(listener) - an event on every phase
// transition - and deps.onRunEnd, called once per run at its final verdict.
//
// Size: past the 800-line guideline on purpose. The steps share one closure
// (the run, the wait timer, the app under test); the pure parts and the card
// writes already live in lunasworkRun.js / lunasworkCards.js.
// ============================================================================

'use strict';

const path = require('path');
const { ROLES, pickModel, stopVerdict } = require('./lunasworkRules');
const {
  PREPROD,
  DONE,
  ALL_PHASES,
  MAX_PLAN_IDS,
  MAX_LOG,
  MAX_LOG_TEXT,
  MAX_TEXT_CHARS,
  BUILD_KEYS,
  PASS_KEYS,
  riskReason,
  isRiskyCard,
  conflictedPaths,
  landedCards,
  parseModelOverride,
  effectiveModels,
  checkCommandFor,
  shipAgrees,
  cleanCard,
  cleanLogEntry,
  cleanConflicts,
  cleanCritic,
  cleanReport,
  cleanSmall,
  emptyCurrent,
  restoreRun,
  scoresByMilestone,
} = require('./lunasworkRun');
const { createCardBook } = require('./lunasworkCards');

const PHASE_ROLE = {
  preprod: null,
  directing: 'director',
  building: 'builder',
  launching: 'playtester',
  playtesting: 'playtester',
  critiquing: 'critic',
  done: null,
};
// Roles the optional free-provider fallback covers (plan: "Models per role").
const FREE_ROLES = new Set(['builder', 'playtester']);
// No reset time known for a usage limit: look again after this long.
const FALLBACK_WAIT_MS = 30 * 60 * 1000;
// God Mode is busy with another project's run: try the build again later.
const GODMODE_RETRY_MS = 5 * 60 * 1000;
// A failed step (a throw, a build or Critic error) is retried after this
// long; this many failures of one phase in a row end the run with STOP.
const ERROR_RETRY_MS = 5 * 60 * 1000;
const MAX_STEP_FAILURES = 3;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const errText = (err) => (err instanceof Error ? err.message : String(err));

// ---- controller -----------------------------------------------------------------

/**
 * @param {{
 *   store: {load:()=>unknown, save:(data:object|null)=>boolean},
 *   settings: ()=>object,
 *   projectOf: (projectId:string)=>({id:string, repoPath:string|null}|null),
 *   profileFor: (projectId:string)=>object|null,
 *   packStatus?: (repoPath:string)=>{complete:boolean, missing?:string[]},
 *   godModeActive: (ctx:{projectId:string, repoPath:string})=>boolean,
 *   godModeCheckCommand?: ()=>string,
 *   confirmStart?: (ctx:{projectId:string, repoPath:string, profile:object, checkCommand:string})=>Promise<boolean>|boolean,
 *   todoStore: (projectId:string)=>{read:Function, write:Function},
 *   director: (opts:object)=>Promise<object>,
 *   build: (opts:object)=>Promise<object>,
 *   createAdapter: (name:string, opts:object)=>{evidenceDir:string, start:Function, stop:Function, tools:Function},
 *   playtest: (opts:object)=>Promise<object>,
 *   shipGate: (ctx:{repoPath:string, scores:object[]})=>{allPassed:boolean},
 *   critic: (opts:object)=>Promise<object>,
 *   gitLog?: (repoPath:string)=>Promise<string>,
 *   syncCheckout?: (repoPath:string)=>Promise<{ok:boolean, detail?:string}>,
 *   limitResumeAt?: (res:object)=>number|null,
 *   awake?: {hold:()=>void, release:()=>void},
 *   onRunEnd?: Array<(run:object)=>void>|((run:object)=>void),
 *   newRunId?: ()=>string, now?: ()=>number, setTimer?: Function, clearTimer?: Function,
 *   log?: (line:string)=>void,
 * }} deps
 */
function createLunasWork(deps) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || (() => {});
  const runEndHooks = (Array.isArray(deps.onRunEnd) ? deps.onRunEnd : [deps.onRunEnd]).filter((fn) => typeof fn === 'function');
  const listeners = new Set();
  // Lowercase letters and digits: the adapters' evidence-dir rule is the strictest.
  const newRunId = deps.newRunId || (() => `lw${now().toString(36)}`);
  const cardBook = createCardBook({ store: (projectId) => deps.todoStore(projectId), now, log });

  /** The current run, or the last finished one (status). Replaced, never edited in place. */
  let run = null;
  let looping = false;
  let waitTimer = null;
  let awakeHeld = false;
  // start() is waiting on Mati's confirmation dialog.
  let starting = false;
  // Not saved: the running app under test and the role of a sub-step.
  const live = { adapter: null, url: null, role: null };

  const active = () => !!run && run.phase !== DONE;

  // ---- persistence + events ----

  function save() {
    if (!deps.store.save({ ...run })) log(`[lunaswork] could not save run ${run.id}`);
  }

  function emit(type) {
    const event = { type, status: status() };
    for (const fn of [...listeners]) {
      try {
        fn(event);
      } catch (err) {
        log(`[lunaswork] listener failed: ${errText(err)}`);
      }
    }
  }

  function update(fields) {
    run = { ...run, ...fields };
    save();
  }

  /** Every phase change goes through here: saved first, then announced. */
  function transition(phase, fields = {}) {
    run = { ...run, ...fields, phase, phaseStartedAt: now(), failures: null };
    save();
    emit('phase');
  }

  function addLog(fields) {
    const item = cleanLogEntry({ at: now(), n: run.iteration, ...fields });
    if (item) run = { ...run, log: [...run.log, item].slice(-MAX_LOG) };
  }

  const logEvent = (text) => addLog({ kind: 'event', text });

  /** Every model choice goes into the run history with its reason. */
  function logModel(role, model, reason, card) {
    if (!model) return;
    addLog({ kind: 'model', role, model, reason: reason || 'setting', ...(Number.isFinite(card) ? { card } : {}) });
  }

  // ---- keep awake ----

  function holdAwake() {
    if (awakeHeld || !deps.awake) return;
    awakeHeld = true;
    try {
      deps.awake.hold();
    } catch (err) {
      log(`[lunaswork] keep-awake failed: ${errText(err)}`);
    }
  }

  function releaseAwake() {
    if (!awakeHeld || !deps.awake) return;
    awakeHeld = false;
    try {
      deps.awake.release();
    } catch (err) {
      log(`[lunaswork] keep-awake release failed: ${errText(err)}`);
    }
  }

  // ---- final verdict ----

  function notifyRunEnd() {
    if (!run || run.endNotified) return;
    const snapshot = { ...run };
    for (const fn of runEndHooks) {
      try {
        Promise.resolve(fn(snapshot)).catch((err) => log(`[lunaswork] onRunEnd failed: ${errText(err)}`));
      } catch (err) {
        log(`[lunaswork] onRunEnd failed: ${errText(err)}`);
      }
    }
    update({ endNotified: true });
  }

  function finish(verdict, fields = {}) {
    if (waitTimer) clearTimer(waitTimer);
    waitTimer = null;
    const reason = fields.stopReason || run.stopReason;
    logEvent(`verdict ${verdict.toUpperCase()}${verdict === 'stop' && reason ? ` (${reason})` : ''}`);
    transition(DONE, { ...fields, verdict, waitUntil: null, waitReason: null, endedAt: now() });
    releaseAwake();
    notifyRunEnd();
  }

  // ---- waiting ----

  function armWait(until, reason) {
    if (waitTimer) clearTimer(waitTimer);
    // A Stop that came in during the step: end now rather than wait first.
    if (run.stopRequested) {
      finish('stop');
      return;
    }
    update({ waitUntil: until, waitReason: reason });
    emit('wait');
    waitTimer = setTimer(() => {
      waitTimer = null;
      if (!active()) return;
      update({ waitUntil: null, waitReason: null });
      emit('resume');
      kick();
    }, Math.max(0, until - now()));
  }

  /** On the free providers right now (freeFallback, during a usage limit). */
  const onFree = () => Number.isFinite(run.limitedUntil) && run.limitedUntil > now();

  /**
   * A step hit the usage limit. Builders and the Playtester may switch to the
   * free providers (freeFallback); everything else waits for the reset.
   */
  function limited(res, role) {
    const at = Number.isFinite(res && res.resumeAt) ? res.resumeAt : deps.limitResumeAt ? deps.limitResumeAt(res) : null;
    const until = Number.isFinite(at) && at > now() ? at : now() + FALLBACK_WAIT_MS;
    const settings = deps.settings();
    if (settings && settings.freeFallback === true && FREE_ROLES.has(role) && !onFree()) {
      logEvent(`usage limit: ${role} switches to the free providers until ${new Date(until).toISOString()}`);
      update({ limitedUntil: until });
      return;
    }
    logEvent(`usage limit (${role}): waiting until ${new Date(until).toISOString()}`);
    armWait(until, 'limit');
  }

  const isLimit = (res) => isObj(res) && res.error === 'limit';

  /**
   * A step failed in a way a later try may fix (a throw, a build or Critic
   * error): the phase is retried after ERROR_RETRY_MS, and MAX_STEP_FAILURES
   * failures of it in a row end the run - never an endless retry.
   */
  function retryLater(why) {
    const count = (run.failures && run.failures.phase === run.phase ? run.failures.count : 0) + 1;
    logEvent(`${run.phase} failed (${String(why).slice(0, 200)}), ${count} of ${MAX_STEP_FAILURES}`);
    if (count >= MAX_STEP_FAILURES) {
      finish('stop', { stopReason: 'stepFailed' });
      return;
    }
    update({ failures: { phase: run.phase, count } });
    armWait(now() + ERROR_RETRY_MS, 'error');
  }

  function requestStop(reason) {
    if (run.stopRequested) return;
    logEvent(`stop requested (${reason})`);
    update({ stopRequested: true, stopReason: reason });
    // A `stop` steer card is done once it stopped this run.
    if (reason === 'steer') cardBook.closeStopCards(run.projectId);
  }

  // ---- the app under test ----

  async function stopApp() {
    const adapter = live.adapter;
    live.adapter = null;
    live.url = null;
    if (!adapter) return;
    try {
      await adapter.stop();
    } catch (err) {
      log(`[lunaswork] could not stop the app: ${errText(err)}`);
    }
  }

  /** Starts the project's app with the profile pinned at start. @returns {Promise<{ok:boolean, error?:string}>} */
  async function startApp() {
    await stopApp();
    const profile = run.profile;
    if (!profile) return { ok: false, error: 'no profile' };
    try {
      live.adapter = deps.createAdapter(profile.adapter, { projectDir: run.repoPath, runId: run.id, iteration: run.iteration });
      if (live.adapter.evidenceDir) update({ evidenceDir: live.adapter.evidenceDir });
      const started = await live.adapter.start(profile);
      live.url = started && started.url;
      return { ok: true };
    } catch (err) {
      await stopApp();
      return { ok: false, error: errText(err).slice(0, MAX_LOG_TEXT) };
    }
  }

  /** One Playtester pass on the started app; the app is always stopped after. */
  async function playtestAndStop(mode) {
    try {
      const res = await deps.playtest({
        projectDir: run.repoPath,
        adapter: live.adapter,
        url: live.url,
        mode,
        models: run.models,
        // The SHIP confirmation is always the paid opus pass, never a free one.
        free: mode === 'explore' && onFree(),
      });
      return isObj(res) ? res : { ok: false, error: 'failed' };
    } finally {
      await stopApp();
    }
  }

  // ---- steps ----

  function stepPreprod() {
    const pack = deps.packStatus ? deps.packStatus(run.repoPath) : { complete: true };
    if (!pack || !pack.complete) {
      finish('stop', { stopReason: 'packIncomplete' });
      return;
    }
    transition('directing', { iteration: run.iteration + 1, current: emptyCurrent() });
  }

  async function stepDirecting() {
    const res = await deps.director({
      repoDir: run.repoPath,
      runId: run.id,
      iteration: run.iteration,
      todoStore: deps.todoStore(run.projectId),
      lastCritic: run.lastCritic,
      models: run.models,
    });
    if (isLimit(res)) return limited(res, 'director');
    const r = isObj(res) ? res : {};
    logModel('director', r.model, r.modelReason);
    if (r.error) logEvent(`director: ${r.error}${r.fallback ? ' (fallback order)' : ''}`);
    if (r.stop) requestStop('steer');
    const cards = (Array.isArray(r.cards) ? r.cards : [])
      .map((card) => {
        const risk = riskReason(card, run.conflicts);
        const pick = pickModel('builder', run.models, { size: card && card.size, risky: !!risk }) || { model: 'opus', reason: 'default' };
        const reason = risk ? `${pick.reason} (${risk})` : pick.reason;
        logModel('builder', pick.model, reason, card && card.at);
        return cleanCard({ ...card, model: pick.model, reason });
      })
      .filter(Boolean);
    transition('building', { current: { ...run.current, cards, notes: str(r.notes, MAX_TEXT_CHARS) } });
  }

  function buildRecord(r, cards, free) {
    const integration = isObj(r.integration) ? r.integration : {};
    const selfCheck = isObj(integration.selfCheck) ? integration.selfCheck : {};
    // Red = the merged result did not reach main (self-check, merge, verify).
    // A build that never got as far as merging leaves main as it was.
    const red = integration.state === 'failed';
    // God Mode ticks a card at push; it only counts once its package merged.
    // Ticked but not on main (red, skipped): open again for the Director.
    const ticked = cardBook.ticked(run.projectId, cards.map((c) => c.at));
    const landed = new Set(landedCards(r, cards));
    const closed = ticked.filter((at) => landed.has(at));
    const unlanded = r.nothing ? [] : ticked.filter((at) => !landed.has(at));
    cardBook.reopen(run.projectId, unlanded);
    if (unlanded.length) logEvent(`${unlanded.length} card(s) reopened: their work did not reach main`);
    const build = cleanSmall(
      {
        selfCheck: red ? 'red' : 'green',
        error: integration.error || r.error || null,
        integrationBranch: selfCheck.pushedIntegrationBranch || null,
        fixups: selfCheck.fixups,
        closed,
      },
      BUILD_KEYS,
    );
    logEvent(
      `build ${build.selfCheck}${build.error ? ` (${build.error})` : ''}, ${closed.length}/${cards.length} cards closed`
        + `${build.integrationBranch ? `, red result kept on ${build.integrationBranch}` : ''}${free ? ', free providers' : ''}`,
    );
    return build;
  }

  async function stepBuilding() {
    const cards = run.current.cards;
    if (!cards.length) {
      logEvent('nothing to build this iteration');
      transition('launching', { current: { ...run.current, build: { selfCheck: 'green', skipped: true, closed: [] } } });
      return;
    }
    const free = onFree();
    const res = await deps.build({
      runId: run.id,
      iteration: run.iteration,
      projectId: run.projectId,
      repoPath: run.repoPath,
      cards,
      // Pinned at start (the profile's, else God Mode's setting).
      checkCommand: run.checkCommand,
      free,
      // Set after a restart mid-build: the builder finishes that plan first.
      resumePlanId: run.current.planId,
      // Plans this run made may be replaced; anyone else's open plan may not.
      ownPlanIds: run.planIds,
      onPlan: (planId) => {
        const id = str(planId, 100);
        update({ current: { ...run.current, planId: id }, planIds: [...run.planIds, id].slice(-MAX_PLAN_IDS) });
      },
    });
    const r = isObj(res) ? res : { ok: false, error: 'failed' };
    if (isLimit(r)) return limited(r, 'builder');
    // No free profile to fall back to: wait for the reset after all.
    if (free && r.error === 'noFreeProfile') return armWait(run.limitedUntil, 'limit');
    if (r.error === 'godModeBusy') {
      logEvent('God Mode is busy with another run - building later');
      return armWait(now() + GODMODE_RETRY_MS, 'godModeBusy');
    }
    if (r.killed) requestStop('godModeKilled');
    // God Mode's own error (planner, launch, a discarded plan): try the build again.
    else if (!r.ok) return retryLater(`build: ${r.error || 'failed'}`);
    const files = conflictedPaths(r);
    const build = buildRecord(r, cards, free);
    await syncCheckout();
    transition('launching', {
      conflicts: cleanConflicts([...run.conflicts.filter((c) => c.n !== run.iteration), { n: run.iteration, files }]),
      current: { ...run.current, build },
    });
  }

  /**
   * The merge went to origin from God Mode's integration worktree; the
   * project checkout (where the app runs and builders branch from) is
   * fast-forwarded to it, or the next lap would test and build stale code.
   */
  async function syncCheckout() {
    if (!deps.syncCheckout) return;
    try {
      const res = await deps.syncCheckout(run.repoPath);
      if (isObj(res) && res.ok === false) logEvent(`checkout not updated: ${String(res.detail || 'failed').slice(0, 200)}`);
    } catch (err) {
      logEvent(`checkout not updated: ${errText(err).slice(0, 200)}`);
    }
  }

  async function stepLaunching() {
    const started = await startApp();
    if (!started.ok) logEvent(`app did not start: ${started.error}`);
    transition('playtesting', { current: { ...run.current, launch: started } });
  }

  async function stepPlaytesting() {
    const launch = run.current.launch;
    let res = launch && launch.ok === false ? { ok: false, error: 'launchFailed', detail: launch.error } : null;
    // After a restart the app from 'launching' is gone: start it again.
    if (!res && !live.adapter) {
      const started = await startApp();
      if (!started.ok) res = { ok: false, error: 'launchFailed', detail: started.error };
    }
    if (!res) res = await playtestAndStop('explore');
    if (isLimit(res)) return limited(res, 'playtester');
    logModel('playtester', res.model, res.modelReason);
    if (!res.ok) logEvent(`playtest failed: ${res.error}`);
    const report = cleanReport(res.report) || cleanReport({ errors: [{ code: res.error || 'failed', detail: res.detail || null }] });
    const playtest = cleanSmall({ ok: res.ok === true, error: res.error, model: res.model, reason: res.modelReason }, PASS_KEYS);
    transition('critiquing', { current: { ...run.current, report, playtest } });
  }

  async function runCriticOnce() {
    let gitLog = '';
    try {
      gitLog = deps.gitLog ? String((await deps.gitLog(run.repoPath)) || '') : '';
    } catch (err) {
      log(`[lunaswork] git log failed: ${errText(err)}`);
    }
    return deps.critic({
      repoDir: run.repoPath,
      runId: run.id,
      iteration: run.iteration,
      milestone: run.milestone,
      report: run.current.report || cleanReport({}),
      history: run.history,
      gitLog,
      models: run.models,
      todoStore: deps.todoStore(run.projectId),
    });
  }

  /** The SHIP confirmation pass: a fresh Playtester (opus) on the SHIP criteria only. */
  async function shipPass() {
    live.role = 'playtester';
    try {
      const started = await startApp();
      if (!started.ok) return { ok: false, agrees: false, error: 'launchFailed' };
      const res = await playtestAndStop('shipConfirm');
      if (isLimit(res)) return { limit: res };
      const gate = res.ok ? deps.shipGate({ repoPath: run.repoPath, scores: (res.report && res.report.scores) || [] }) : null;
      return { ok: res.ok === true, agrees: shipAgrees(res, gate), error: res.error, model: res.model, reason: res.modelReason };
    } finally {
      live.role = null;
    }
  }

  async function stepCritiquing() {
    let critic = run.current.critic;
    if (!critic) {
      const res = await runCriticOnce();
      if (isLimit(res)) return limited(res, 'critic');
      const r = isObj(res) ? res : { ok: false, error: 'failed' };
      logModel('critic', r.model, r.modelReason);
      // A failed Critic applied nothing: try it again rather than score the lap 0.
      if (!r.ok) return retryLater(`critic: ${r.error || 'failed'}`);
      critic = cleanCritic(r);
      // Saved before the SHIP pass: the Critic's cards must not be made twice.
      update({ current: { ...run.current, critic } });
    }

    let shipConfirmed = false;
    if (critic.verdict === 'ship') {
      let ship = run.current.ship;
      if (!ship) {
        const pass = await shipPass();
        // Not 'playtester': the SHIP pass never falls back to the free providers.
        if (pass.limit) return limited(pass.limit, 'shipConfirm');
        ship = cleanSmall(pass, PASS_KEYS);
        logModel('playtester', ship.model, ship.reason || 'SHIP confirmation pass');
        logEvent(`SHIP confirmation ${ship.agrees ? 'agrees' : 'does not agree'}${ship.error ? ` (${ship.error})` : ''}`);
        update({ current: { ...run.current, ship } });
      }
      shipConfirmed = ship.agrees === true;
    }
    endIteration(critic, shipConfirmed);
  }

  function endIteration(critic, shipConfirmed) {
    const c = run.current;
    const milestone = critic.milestone ? critic.milestone.name : run.milestone;
    const journeys = c.report ? c.report.journeys : [];
    const record = {
      n: run.iteration,
      milestone: milestone || null,
      // No gate score (the Critic could not compute one) counts as no progress.
      score: critic.milestone && Number.isFinite(critic.milestone.score) ? critic.milestone.score : 0,
      cardsClosed: c.build ? (c.build.closed || []).length : 0,
      selfCheck: c.build ? c.build.selfCheck : 'green',
      coreJourneysOk: journeys.every((j) => !isObj(j) || j.passed !== false),
      rolledBack: false,
    };
    const history = [...run.history.filter((h) => h.n !== record.n), record];
    const verdict = stopVerdict({ history, critic: { verdict: critic.verdict }, shipConfirmed, stopRequested: run.stopRequested });
    const lastCritic = { verdict: critic.verdict, milestone: critic.milestone, next: critic.next, allPassed: critic.allPassed };
    if (verdict.type !== 'continue') {
      finish(verdict.type, { history, lastCritic });
      return;
    }
    transition('directing', {
      history,
      lastCritic,
      // A passed gate moves the run on to the next milestone.
      milestone: (critic.milestone && critic.milestone.passed && critic.next) || milestone || null,
      iteration: run.iteration + 1,
      current: emptyCurrent(),
    });
  }

  const STEPS = {
    preprod: stepPreprod,
    directing: stepDirecting,
    building: stepBuilding,
    launching: stepLaunching,
    playtesting: stepPlaytesting,
    critiquing: stepCritiquing,
  };

  /** Runs steps until the run ends or waits. One loop at a time. */
  async function loop() {
    if (looping) return;
    looping = true;
    try {
      while (active() && !waitTimer) {
        // STOP: the step that was running has finished - end here.
        if (run.stopRequested) {
          await stopApp();
          finish('stop');
          break;
        }
        await STEPS[run.phase]();
      }
    } catch (err) {
      log(`[lunaswork] ${run && run.phase} failed: ${errText(err)}`);
      await stopApp();
      if (active()) retryLater(errText(err));
    } finally {
      looping = false;
    }
  }

  let loopDone = Promise.resolve();

  function kick() {
    loopDone = loop().catch((err) => log(`[lunaswork] loop failed: ${errText(err)}`));
  }

  // ---- public API ----

  const refuse = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });
  const RUN_ACTIVE = () => refuse('run-active', "A Luna's Work run is already going. Stop it before starting another.");
  const GOD_MODE_ACTIVE = () =>
    refuse('god-mode-active', "God Mode has a plan or run on this project. Finish or discard it before starting Luna's Work.");

  /** Everything start() checks before it asks Mati; null when the run may start. */
  function startProblem(p) {
    if (active()) return { refusal: RUN_ACTIVE() };
    const project = typeof p.projectId === 'string' ? deps.projectOf(p.projectId) : null;
    if (!project) return { refusal: refuse('bad-project', 'Unknown project.') };
    if (typeof project.repoPath !== 'string' || !path.isAbsolute(project.repoPath)) {
      return { refusal: refuse('no-folder', "The project's folder does not exist on this PC.") };
    }
    const override = parseModelOverride(p.models);
    if (!override) return { refusal: refuse('bad-models', 'Unknown role or model in the run models.') };
    const profile = deps.profileFor(project.id);
    if (!profile) {
      return { refusal: refuse('no-profile', "Set the project profile (start command, URL) in Luna's Work settings first.") };
    }
    const pack = deps.packStatus ? deps.packStatus(project.repoPath) : { complete: true };
    if (!pack || !pack.complete) {
      const missing = pack && Array.isArray(pack.missing) ? pack.missing : [];
      return { refusal: refuse('pack-incomplete', 'The design pack is not complete yet - finish the interview first.', { missing }) };
    }
    if (deps.godModeActive({ projectId: project.id, repoPath: project.repoPath })) return { refusal: GOD_MODE_ACTIVE() };
    const checkCommand = checkCommandFor(profile, deps.godModeCheckCommand ? deps.godModeCheckCommand() : '');
    return { project, override, profile, checkCommand };
  }

  /**
   * Starts a run on a known project.
   * @param {{projectId:string, models?:object}} payload models: per-role override for this run only
   * @returns {Promise<{ok:true, status:object}|{ok:false, reason:string, message:string, missing?:string[]}>}
   */
  async function start(payload) {
    // One confirmation dialog at a time: a second start cannot stack another.
    if (starting) return refuse('busy', "Luna's Work is already asking to start a run.");
    const checked = startProblem(isObj(payload) ? payload : {});
    if (checked.refusal) return checked.refusal;
    const { project, override, profile, checkCommand } = checked;
    starting = true;
    let confirmed = true;
    try {
      // Mati sees the commands that will run; the run keeps exactly these.
      if (deps.confirmStart) {
        confirmed = (await deps.confirmStart({ projectId: project.id, repoPath: project.repoPath, profile, checkCommand })) === true;
      }
    } finally {
      starting = false;
    }
    if (!confirmed) return refuse('declined', 'Start cancelled.');
    // The dialog took time: the same two checks again.
    if (active()) return RUN_ACTIVE();
    if (deps.godModeActive({ projectId: project.id, repoPath: project.repoPath })) return GOD_MODE_ACTIVE();

    const { models, sources } = effectiveModels(deps.settings(), project.id, override);
    const at = now();
    const created = restoreRun({
      id: newRunId(),
      projectId: project.id,
      repoPath: project.repoPath,
      phase: PREPROD,
      iteration: 0,
      models,
      modelSources: sources,
      history: [],
      startedAt: at,
      phaseStartedAt: at,
      log: [],
      current: emptyCurrent(),
      profile,
      checkCommand,
      planIds: [],
    });
    if (!created || !created.profile) return refuse('failed', 'Could not create the run.');
    run = created;
    logEvent(`started; models ${ROLES.map((role) => `${role}=${models[role]} (${sources[role]})`).join(', ')}`);
    save();
    emit('phase');
    holdAwake();
    kick();
    return { ok: true, status: status() };
  }

  /**
   * The kill switch: the step that is running finishes, then the run ends
   * with STOP. A run that is waiting ends at once.
   */
  function stop() {
    if (!active()) return { ok: false, reason: 'no-run', message: "No Luna's Work run is going." };
    requestStop('killSwitch');
    if (waitTimer || !looping) finish('stop');
    else emit('stopping');
    return { ok: true, status: status() };
  }

  /**
   * Brings back the stored run after a LunaCore start: a finished one only
   * for status (and its pending onRunEnd), an active one from its phase.
   * @returns {boolean} whether an active run was resumed
   */
  function resume() {
    if (run) return false;
    const stored = restoreRun(deps.store.load());
    if (!stored) return false;
    run = stored;
    if (!active()) {
      notifyRunEnd();
      return false;
    }
    const project = deps.projectOf(run.projectId);
    const repo = project && typeof project.repoPath === 'string' ? path.resolve(project.repoPath) : null;
    if (repo !== path.resolve(run.repoPath)) {
      finish('stop', { stopReason: 'projectMissing' });
      return false;
    }
    // No valid pinned profile: nothing confirmed to run - never fill one in.
    if (!run.profile) {
      finish('stop', { stopReason: 'noProfile' });
      return false;
    }
    logEvent(`resumed at ${run.phase}`);
    save();
    holdAwake();
    emit('phase');
    if (Number.isFinite(run.waitUntil) && run.waitUntil > now()) {
      armWait(run.waitUntil, run.waitReason || 'limit');
    } else {
      update({ waitUntil: null, waitReason: null });
      kick();
    }
    return true;
  }

  /** The read-only view the HUD panel, reports and checkpoints build on. */
  function status() {
    if (!run) return { active: false, runId: null };
    return {
      active: active(),
      runId: run.id,
      projectId: run.projectId,
      iteration: run.iteration,
      phase: run.phase,
      role: live.role || PHASE_ROLE[run.phase] || null,
      models: { ...run.models },
      modelSources: { ...run.modelSources },
      milestone: run.milestone,
      verdict: run.verdict,
      stopRequested: run.stopRequested,
      stopReason: run.stopReason,
      startedAt: run.startedAt,
      phaseStartedAt: run.phaseStartedAt,
      waitUntil: run.waitUntil,
      waitReason: run.waitReason,
      freeUntil: onFree() ? run.limitedUntil : null,
      scores: scoresByMilestone(run.history),
      evidenceDir: run.evidenceDir,
      endedAt: run.endedAt,
    };
  }

  /** @param {(event:{type:string, status:object})=>void} listener @returns {()=>void} unsubscribe */
  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * God Mode's side of the mutual exclusion: a refusal while a Luna's Work
   * run is going on that project, else null.
   * @param {string|null} projectId
   */
  function godModeBlock(projectId) {
    if (!active() || run.projectId !== projectId) return null;
    return {
      ok: false,
      error: 'lunasWorkActive',
      message: "Luna's Work is running on this project. Stop it before using God Mode here.",
    };
  }

  /** Quit path: the app under test is stopped and the timer cleared; the run stays saved. */
  async function dispose() {
    if (waitTimer) clearTimer(waitTimer);
    waitTimer = null;
    await stopApp();
    releaseAwake();
  }

  return {
    start,
    stop,
    resume,
    status,
    subscribe,
    godModeBlock,
    isActiveOn: (projectId) => active() && run.projectId === projectId,
    /** The run's history log: every model choice with its reason, and the run's events. */
    runLog: () => (run ? run.log.map((e) => ({ ...e })) : []),
    /** Test seam: settles when the current step loop has stopped. */
    idle: () => loopDone,
    dispose,
  };
}

module.exports = {
  PREPROD,
  DONE,
  ALL_PHASES,
  FALLBACK_WAIT_MS,
  GODMODE_RETRY_MS,
  isRiskyCard,
  riskReason,
  conflictedPaths,
  landedCards,
  parseModelOverride,
  effectiveModels,
  checkCommandFor,
  shipAgrees,
  restoreRun,
  createLunasWork,
};
