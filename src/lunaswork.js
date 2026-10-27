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
// Checkpoints (deps.checkpoints, src/lunasworkCheckpoint.js): after the
// Critic, a green iteration is tagged luna-work/<run>/iter-N - unless
// lunasworkRules.rollbackDecision says it broke a core journey that passed
// before or dropped the milestone score past the margin. Then main is
// reverted to the last good tag with revert commits (never a force-push or a
// reset), the iteration's cards reopen, a bug card holds the evidence, and
// the iteration counts as rolled back. One lap summary per iteration (laps)
// feeds the run report (src/lunasworkReport.js, via onRunEnd).
//
// Decision queue (src/lunasworkDecisions.js, idea #11): a card the Director
// schedules that needsDecision() flags (new dependency, migration, deleting a
// feature, DESIGN.md beyond an append) is held and asked about; the rest of
// the iteration goes on. ask() / answer() / applyAnswers() are the public
// side; a timer takes the default at the deadline. Every answer goes to
// design/DECISIONS.md (deps.recordDecision). Mati's steer cards never ask.
//
// Mid-run feedback (src/lunasworkFeedback.js, B17): feedback() / applyFeedback()
// only store an item - the run never pauses for it. At the start of every
// iteration the items are triaged into cards: look / bug parts straight away
// (tagged `feedback`, scheduled right after the steer cards), scope parts
// held by a decision - Mati's defaults to approve, a client's has no default
// and waits for his yes while the run goes on. Each item's status (planned /
// built / verified) follows its cards and goes to the phone with status().
//
// Extension seams: status(), snapshot(), subscribe(listener) - an event on
// every phase transition, decision change and feedback change - deps.onRunEnd,
// called once per run at its final verdict, and deps.onMilestone, called when
// a milestone gate passed and the run goes on (the milestone email).
//
// Card rules (lunasworkRules.js, docs/LUNAS_WORK_PLAN.md B1, #3, B4, B5, B9):
//   built    a landed card is *built*, not done; the next Playtester pass
//            gets its acceptance checks and closes it, or reopens it with
//            the evidence (lunasworkChecks.js). A landed `bug` card whose
//            work changed no test file stays open with a note.
//   stuck    every card that ends an iteration open counts a failure
//            (run.failCounts); a stuck one is offered to the Critic to split,
//            and one it did not split goes to the decision queue.
//   scope    a card the Director left out as outside DESIGN.md / ROADMAP.md
//            is asked about; it is scheduled only once a decision covers it.
//   flaky    before a core-journey rollback, the playtest is replayed on the
//            same code; a journey that fails then passes is quarantined for
//            the run (run.quarantine), gets a card, and is left out of the
//            rollback input from then on.
//
// Iteration 0 (deps.scaffold, src/lunasworkScaffold.js): on an empty repo the
// run goes preprod -> building at iteration 0 with the stack template's
// cards, then on to directing at iteration 1 once the scaffold is green.
//
// Hand me the wheel (C11, src/lunasworkWheel.js + src/lunasworkHandback.js):
// handOver() pauses the run at the END of the current iteration - the step
// that runs finishes, the iteration ends as usual, then the run goes to
// `handed` instead of directing: the app under test is stopped, no step
// (so no builder) runs, and main's commit is noted. A run waiting before its
// Director (a usage limit) has no iteration under way and is handed at once.
// While handed, the usage-limit wait and the decision deadlines keep their
// timers. handBack() reads every commit Mati made since the pause: one
// DECISIONS.md line each and a section in ARCHITECTURE.md, then the run goes
// on from directing. Both come from the HUD panel or the phone (applyWheel).
//
// Size: past the 800-line guideline on purpose. The steps share one closure
// (the run, the wait timer, the app under test); the pure parts and the card
// writes already live in lunasworkRun.js / lunasworkCards.js.
// ============================================================================

'use strict';

const path = require('path');
const {
  ROLES,
  pickModel,
  stopVerdict,
  rollbackDecision,
  nextFailCounts,
  stuckOutcome,
} = require('./lunasworkRules');
const { checkList } = require('./lunasworkChecks');
const { rollbackEvidence, reasonText } = require('./lunasworkCheckpoint');
const {
  PREPROD,
  HANDED,
  DONE,
  ALL_PHASES,
  MAX_PLAN_IDS,
  MAX_LOG,
  MAX_LOG_TEXT,
  MAX_TEXT_CHARS,
  MAX_LAPS,
  BUILD_KEYS,
  PASS_KEYS,
  buildLap,
  cleanCheckpoint,
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
const { createCardFlow } = require('./lunasworkCardFlow');
const { STEER_TAG, BUILT_STATE } = require('./todorows');
const {
  triageText,
  cardFor,
  scopeDecision,
  isMatiFeedbackCard,
  createItem,
  needsTriage,
  unaskedScopeCards,
  withStatuses,
  cardAts,
  publicFeedback,
} = require('./lunasworkFeedback');
const {
  APPROVE,
  needsDecision,
  createDecision,
  answerDecision,
  expireDue,
  nextDeadline,
  holdsCards,
  heldCards,
  decisionForCard,
  pendingOf,
  trimQueue,
  decisionLine,
  publicDecision,
} = require('./lunasworkDecisions');
const { wheelState, newestWheelAction } = require('./lunasworkWheel');
const { handbackDecisionLine, architectureBlock } = require('./lunasworkHandback');

const PHASE_ROLE = {
  preprod: null,
  directing: 'director',
  building: 'builder',
  launching: 'playtester',
  playtesting: 'playtester',
  critiquing: 'critic',
  handed: null,
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
// Stop reasons other callers than the kill switch may give (src/lunasworkMachine.js).
const STOP_CALLERS = ['lowDisk', 'updatesNotPaused'];

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
 *   checkpoints?: {tagIteration:(o:object)=>Promise<object>, rollback:(o:object)=>Promise<object>},
 *   limitResumeAt?: (res:object)=>number|null,
 *   awake?: {hold:()=>void, release:()=>void},
 *   recordDecision?: (ctx:{repoPath:string, line:string, decision:object})=>boolean,
 *   handback?: {head:(repoPath:string)=>Promise<string|null>,
 *     commits:(repoPath:string, base:string)=>Promise<{ok:boolean, commits?:object[], more?:number, error?:string}>,
 *     architecture:(ctx:{repoPath:string, block:string})=>boolean},
 *   onRunEnd?: Array<(run:object)=>void>|((run:object)=>void),
 *   onMilestone?: Array<(run:object, ctx:{milestone:string})=>void>|((run:object, ctx:{milestone:string})=>void),
 *   newRunId?: ()=>string, now?: ()=>number, setTimer?: Function, clearTimer?: Function,
 *   log?: (line:string)=>void,
 * }} deps
 */
function createLunasWork(deps) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || (() => {});
  const hooksOf = (raw) => (Array.isArray(raw) ? raw : [raw]).filter((fn) => typeof fn === 'function');
  const runEndHooks = hooksOf(deps.onRunEnd);
  const milestoneHooks = hooksOf(deps.onMilestone);
  const listeners = new Set();
  // Lowercase letters and digits: the adapters' evidence-dir rule is the strictest.
  const newRunId = deps.newRunId || (() => `lw${now().toString(36)}`);
  const cardBook = createCardBook({ store: (projectId) => deps.todoStore(projectId), now, log });
  // The card rules (B1, #3, B4, B5, B9) applied to this run; the wrappers
  // reach functions defined further down this closure.
  const cardFlow = createCardFlow({
    run: () => run,
    update: (fields) => update(fields),
    logEvent: (text) => logEvent(text),
    cardBook,
    ask: (spec) => ask(spec),
    replayPass: () => replayPass(),
  });

  /** The current run, or the last finished one (status). Replaced, never edited in place. */
  let run = null;
  let looping = false;
  let waitTimer = null;
  // The next decision deadline (takes the default answer).
  let decisionTimer = null;
  let awakeHeld = false;
  // Phone feedback ids refused once (bad text, list full): not logged again on every pull.
  const refusedFeedback = new Set();
  // start() is waiting on Mati's confirmation dialog.
  let starting = false;
  // A hand-back is reading Mati's commits (C11): a second one is refused.
  let handingBack = false;
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

  /**
   * The milestone email (B12 / B17): a gate passed and the run goes on.
   * `evidence` = the gate iteration's playtest report, evidence folder and
   * number (the demo video, B13) - the snapshot is already on the next one.
   */
  function notifyMilestone(milestone, evidence = {}) {
    const snapshot = { ...run };
    for (const fn of milestoneHooks) {
      try {
        Promise.resolve(fn(snapshot, { ...evidence, milestone })).catch((err) => log(`[lunaswork] onMilestone failed: ${errText(err)}`));
      } catch (err) {
        log(`[lunaswork] onMilestone failed: ${errText(err)}`);
      }
    }
  }

  function finish(verdict, fields = {}) {
    if (waitTimer) clearTimer(waitTimer);
    waitTimer = null;
    clearDecisionTimer();
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

  // ---- decision queue ----

  function clearDecisionTimer() {
    if (decisionTimer) clearTimer(decisionTimer);
    decisionTimer = null;
  }

  /** One DECISIONS.md line; a failed write only goes into the run log. @returns {boolean} written */
  function writeDecisionLine(line, decision, label) {
    if (!line || !deps.recordDecision) return false;
    try {
      if (deps.recordDecision({ repoPath: run.repoPath, line, decision }) !== false) return true;
      logEvent(`${label}: DECISIONS.md not updated`);
    } catch (err) {
      logEvent(`${label}: DECISIONS.md not updated (${errText(err).slice(0, 150)})`);
    }
    return false;
  }

  /** One DECISIONS.md line per answer. */
  function recordDecision(decision) {
    writeDecisionLine(decisionLine(decision), decision, `decision ${decision.id}`);
  }

  /** Saves a changed queue, logs and records its new answers, announces it. */
  function decisionsChanged(decisions, answered = []) {
    // B4: an approved stuck card gets a fresh start; a rejected one stays held.
    const retried = answered.filter((d) => d.kind === 'stuckCard' && d.answer === APPROVE).flatMap((d) => d.cardIds);
    run = { ...run, decisions: trimQueue(decisions), failCounts: nextFailCounts(run.failCounts, { closed: retried }) };
    for (const d of answered) {
      logEvent(`decision ${d.id} (${d.kind}): ${d.answer} - ${d.answeredBy === 'default' ? 'default after deadline' : 'answered by Mati'}`);
      recordDecision(d);
    }
    save();
    emit('decision');
    armDecisionTimer();
    // B17: an answered scope decision moves its feedback item on.
    refreshFeedback();
  }

  function armDecisionTimer() {
    clearDecisionTimer();
    const at = active() ? nextDeadline(run.decisions) : null;
    if (at === null) return;
    decisionTimer = setTimer(() => {
      decisionTimer = null;
      expireDecisions();
    }, Math.max(0, at - now()));
  }

  /** Takes the default of every decision past its deadline (never a client scope change). */
  function expireDecisions() {
    if (!active()) return;
    const res = expireDue(run.decisions, now());
    if (res.answered.length) decisionsChanged(res.list, res.answered);
  }

  /**
   * Whether a scheduled card may be built now. A card a decision covers
   * waits for it (and stays held when it was rejected); a card that
   * needsDecision() flags gets a new decision and waits too.
   */
  function mayBuild(card) {
    if (!isObj(card) || !Number.isFinite(card.at)) return true;
    const earlier = decisionForCard(run.decisions, card.at);
    if (earlier) return !holdsCards(earlier);
    // Mati's steer cards and his feedback cards may change anything (B17 "Trust").
    const fromMati = (Array.isArray(card.tags) && card.tags.includes(STEER_TAG)) || isMatiFeedbackCard(card);
    const need = needsDecision({ text: card.text, details: card.details, files: card.files, from: fromMati ? 'mati' : 'director' });
    if (!need) return true;
    ask({ question: card.text, detail: need.reason, kind: need.kind, options: need.options, defaultAnswer: need.defaultAnswer, freeText: need.freeText, cardIds: [card.at] });
    // Asked, or the queue refused it: either way the card is not built yet.
    return false;
  }

  // ---- mid-run feedback (B17) ----

  /** The state of every card the feedback points at: open / built / done. */
  function feedbackCardStates() {
    const ats = cardAts(run.feedback);
    if (!ats.length) return new Map();
    return new Map(cardBook.lookup(run.projectId, ats).map((t) => [t.at, t.done ? 'done' : t.state === BUILT_STATE ? 'built' : 'open']));
  }

  /** Fresh statuses for every item; a change is logged, saved and announced. */
  function refreshFeedback() {
    if (!active() || !run.feedback.length) return;
    const res = withStatuses(run.feedback, { cards: feedbackCardStates(), decisions: run.decisions });
    if (!res.changed.length) return;
    run = { ...run, feedback: res.list };
    for (const item of res.changed) logEvent(`feedback ${item.id}: ${item.status}`);
    save();
    emit('feedback');
  }

  /** A scope part's card goes to the decision queue: the decision id, or null (asked again next iteration). */
  function askScope(part, item) {
    const res = ask(scopeDecision(part, item, part.at));
    return res.ok ? res.id : null;
  }

  /**
   * One item's free text -> cards: look / bug parts straight away, a scope
   * part held by its decision. Null when no card could be filed (tried
   * again next iteration - nothing was created, so nothing doubles).
   */
  function triageItem(item) {
    const parts = triageText(item.text);
    const ats = parts.length ? cardBook.fileCards(run.projectId, run.id, parts.map((p) => cardFor(p, item))) : [];
    if (parts.length && !ats.length) {
      logEvent(`feedback ${item.id}: no card filed - triaged again next iteration`);
      return null;
    }
    if (ats.length < parts.length) logEvent(`feedback ${item.id}: ${parts.length - ats.length} part(s) not filed (the to-do list is full)`);
    const filed = parts.map((p, i) => ({ ...p, at: Number.isFinite(ats[i]) ? ats[i] : null, decisionId: null }));
    const kinds = filed.map((p) => p.type).join(', ') || 'praise only, nothing to build';
    logEvent(`feedback ${item.id} (${item.author}) triaged: ${kinds}`);
    return { ...item, parts: filed.map((p) => (p.type === 'scope' && p.at !== null ? { ...p, decisionId: askScope(p, item) } : p)), triagedAt: now() };
  }

  const isUnasked = (p) => p.type === 'scope' && p.at !== null && p.decisionId === null;

  /**
   * B17, at the start of every iteration: new items become cards, and a
   * scope part the full queue refused before is asked again. Never waits.
   */
  function triageFeedback() {
    if (!run.feedback.length) return;
    for (const item of run.feedback.filter(needsTriage)) {
      const triaged = triageItem(item);
      if (triaged) run = { ...run, feedback: run.feedback.map((i) => (i.id === item.id ? triaged : i)) };
    }
    for (const item of run.feedback.filter((i) => (i.parts || []).some(isUnasked))) {
      const parts = item.parts.map((p) => (isUnasked(p) ? { ...p, decisionId: askScope(p, item) } : p));
      run = { ...run, feedback: run.feedback.map((i) => (i.id === item.id ? { ...i, parts } : i)) };
    }
    save();
    refreshFeedback();
  }

  /** Cards the Director must not schedule: the decision queue's, and scope cards not asked about yet. */
  const heldNow = () => new Set([...heldCards(run.decisions), ...unaskedScopeCards(run.feedback)]);

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
  async function playtestAndStop(mode, checks = []) {
    try {
      const res = await deps.playtest({
        projectDir: run.repoPath,
        adapter: live.adapter,
        url: live.url,
        mode,
        // B1: the built cards' acceptance checks (explore pass only).
        checks,
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
    if (startScaffold()) return;
    transition('directing', { iteration: run.iteration + 1, current: emptyCurrent() });
  }

  /** A scheduled card with its builder model; the choice goes into the run log. */
  function withBuilderModel(card) {
    const risk = riskReason(card, run.conflicts);
    const pick = pickModel('builder', run.models, { size: card && card.size, risky: !!risk }) || { model: 'opus', reason: 'default' };
    const reason = risk ? `${pick.reason} (${risk})` : pick.reason;
    logModel('builder', pick.model, reason, card && card.at);
    return cleanCard({ ...card, model: pick.model, reason });
  }

  /**
   * Iteration 0 (src/lunasworkScaffold.js): an empty repo gets its stack
   * template's cards, built straight away - no Director, no decision queue
   * (fixed template cards), the normal God Mode build + self-check gate.
   * @returns {boolean} whether iteration 0 started
   */
  function startScaffold() {
    if (!deps.scaffold || run.iteration !== 0) return false;
    const plan = deps.scaffold.plan(run.repoPath, run.profile);
    if (!plan) return false;
    const seeded = deps.scaffold.seed(deps.todoStore(run.projectId), { stack: plan.stack, runId: run.id, now: now() });
    if (!seeded.ok) {
      logEvent(`iteration 0: scaffold cards not created (${String(seeded.error).slice(0, 150)}) - going on without them`);
      return false;
    }
    logEvent(`iteration 0: empty repo, scaffolding ${plan.label} (stack from ${plan.source}), ${seeded.cards.length} cards`);
    const cards = seeded.cards.map(withBuilderModel).filter(Boolean);
    if (!cards.length) return false;
    transition('building', { current: { ...emptyCurrent(), cards, notes: `iteration 0: ${plan.label} scaffold` } });
    return true;
  }

  async function stepDirecting() {
    // B17: feedback that came in since the last iteration is planned in first.
    triageFeedback();
    const held = heldNow();
    const res = await deps.director({
      repoDir: run.repoPath,
      runId: run.id,
      iteration: run.iteration,
      todoStore: deps.todoStore(run.projectId),
      lastCritic: run.lastCritic,
      models: run.models,
      // Cards waiting for a decision (or refused by one): never scheduled.
      holdCards: [...held],
      // B4: stuck cards are left out; B5: a card a decision covers passes the scope guard.
      failCounts: run.failCounts,
      decidedCards: [...new Set(run.decisions.flatMap((d) => d.cardIds))],
    });
    if (isLimit(res)) return limited(res, 'director');
    const r = isObj(res) ? res : {};
    logModel('director', r.model, r.modelReason);
    if (r.error) logEvent(`director: ${r.error}${r.fallback ? ' (fallback order)' : ''}`);
    if (r.stop) requestStop('steer');
    // B5: work outside DESIGN.md / ROADMAP.md waits for Mati.
    cardFlow.askAboutScope(r.outOfScope);
    // Read the holds again: a decision may have been answered (or taken its
    // default) while the Director was thinking.
    const stillHeld = heldNow();
    const cards = (Array.isArray(r.cards) ? r.cards : [])
      .filter((card) => !(isObj(card) && stillHeld.has(card.at)))
      .filter(mayBuild)
      .map(withBuilderModel)
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
    // B1 + #3: landed cards are built, or kept open when a bug fix has no test.
    const { built, noTest } = cardFlow.landedToBuilt(r, cards, closed);
    const build = cleanSmall(
      {
        selfCheck: red ? 'red' : 'green',
        error: integration.error || r.error || null,
        integrationBranch: selfCheck.pushedIntegrationBranch || null,
        fixups: selfCheck.fixups,
        closed,
        built,
        noTest,
      },
      BUILD_KEYS,
    );
    logEvent(
      `build ${build.selfCheck}${build.error ? ` (${build.error})` : ''}, ${closed.length}/${cards.length} cards landed`
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
    refreshFeedback();
    await syncCheckout();
    if (run.iteration === 0) return endScaffold(build);
    transition('launching', {
      conflicts: cleanConflicts([...run.conflicts.filter((c) => c.n !== run.iteration), { n: run.iteration, files }]),
      current: { ...run.current, build },
    });
  }

  /**
   * Iteration 0 has no app to play yet: a green scaffold goes straight on to
   * iteration 1. A red one never reached main, so it is built again (its
   * cards reopened) - MAX_STEP_FAILURES red tries end the run.
   */
  function endScaffold(build) {
    if (build.selfCheck !== 'green') return retryLater('iteration 0: the scaffold stayed red');
    logEvent('iteration 0: scaffold on main');
    return nextIteration({ iteration: 1, current: emptyCurrent() });
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
    const built = cardBook.builtCards(run.projectId);
    if (!res) res = await playtestAndStop('explore', checkList(built));
    if (isLimit(res)) return limited(res, 'playtester');
    logModel('playtester', res.model, res.modelReason);
    if (!res.ok) logEvent(`playtest failed: ${res.error}`);
    const report = cleanReport(res.report) || cleanReport({ errors: [{ code: res.error || 'failed', detail: res.detail || null }] });
    const playtest = cleanSmall({ ok: res.ok === true, error: res.error, model: res.model, reason: res.modelReason }, PASS_KEYS);
    // B1: built cards close or reopen; B4: the cards that failed this iteration count.
    const verify = cardFlow.settleBuilt(built, report);
    refreshFeedback();
    transition('critiquing', {
      current: { ...run.current, report, playtest, verify },
      failCounts: nextFailCounts(run.failCounts, { failed: verify.failed, closed: verify.closed }),
    });
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
      // B4: the stuck cards to split (a held one is Mati's to decide already).
      stuckCards: cardFlow.stuckNow(),
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
      const stuck = cardFlow.stuckNow();
      const res = await runCriticOnce();
      if (isLimit(res)) return limited(res, 'critic');
      const r = isObj(res) ? res : { ok: false, error: 'failed' };
      logModel('critic', r.model, r.modelReason);
      // A failed Critic applied nothing: try it again rather than score the lap 0.
      if (!r.ok) return retryLater(`critic: ${r.error || 'failed'}`);
      critic = cleanCritic(r);
      // B4: a split card is done with; the rest of the stuck ones are asked about.
      const outcome = stuckOutcome(stuck, critic.split);
      if (outcome.split.length) logEvent(`${outcome.split.length} stuck card(s) split by the Critic`);
      // Saved before the SHIP pass: the Critic's cards must not be made twice.
      update({ current: { ...run.current, critic }, failCounts: nextFailCounts(run.failCounts, { closed: outcome.split }) });
      cardFlow.askAboutStuck(outcome.ask);
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
    await endIteration(critic, shipConfirmed);
  }

  // ---- checkpoints ----

  async function tagGreen() {
    const res = await deps.checkpoints.tagIteration({ repoPath: run.repoPath, runId: run.id, iteration: run.iteration });
    if (isObj(res) && res.ok) {
      logEvent(`checkpoint ${res.tag}`);
      return { tag: res.tag };
    }
    const error = (isObj(res) && res.error) || 'failed';
    logEvent(`checkpoint tag failed (${error}${isObj(res) && res.detail ? `: ${String(res.detail).slice(0, 150)}` : ''})`);
    return { tagError: error };
  }

  /** Reverts main to the last good tag; the iteration's closed cards reopen. */
  async function rollBack(decision, history, regressed) {
    const c = run.current;
    const closed = c.build ? c.build.closed || [] : [];
    const evidence = rollbackEvidence({
      decision,
      history,
      report: c.report,
      regressed,
      evidenceDir: run.evidenceDir,
      cards: c.cards.filter((k) => closed.includes(k.at)).map((k) => k.text),
    });
    const why = reasonText(decision.reason, evidence);
    logEvent(`rollback to iteration ${decision.toIteration}: ${why}`);
    const res = await deps.checkpoints.rollback({
      repoPath: run.repoPath,
      runId: run.id,
      iteration: run.iteration,
      toIteration: decision.toIteration,
      reason: decision.reason,
      evidence,
      todoStore: deps.todoStore(run.projectId),
    });
    const r = isObj(res) ? res : { ok: false, error: 'failed' };
    const base = { reason: decision.reason, why, toIteration: decision.toIteration };
    if (r.ok && r.nothing) {
      logEvent('rollback: main already matches the last good tag, nothing to revert');
      return { note: 'nothing to revert' };
    }
    if (!r.ok) {
      logEvent(`rollback failed (${r.error || 'failed'}${r.detail ? `: ${String(r.detail).slice(0, 150)}` : ''}) - main keeps this iteration`);
      return { rollback: { ...r, ok: false, ...base } };
    }
    cardBook.reopen(run.projectId, closed);
    const reverted = Array.isArray(r.reverted) ? r.reverted : [];
    logEvent(`rolled back ${r.fromTag} -> ${r.toTag}: ${reverted.length} revert commit(s), ${(r.cards || []).length} card(s)`);
    await syncCheckout();
    return { rollback: { ...r, ...base, reopened: closed } };
  }

  /**
   * Tag or roll back after the Critic. Saved in the iteration's progress
   * before the iteration ends, so a restart never does it twice.
   * @returns {Promise<object|null>} the cleaned checkpoint record
   */
  async function checkpointStep(history, regressed) {
    if (!deps.checkpoints) return null;
    if (run.current.checkpoint) return run.current.checkpoint;
    // A red iteration never reached main: nothing to tag or revert.
    if (history[history.length - 1].selfCheck !== 'green') return null;
    let checkpoint;
    try {
      const decision = rollbackDecision(history);
      checkpoint = decision.rollback ? await rollBack(decision, history, regressed) : await tagGreen();
    } catch (err) {
      checkpoint = { note: `checkpoint failed: ${errText(err).slice(0, 200)}` };
      logEvent(checkpoint.note);
    }
    const clean = cleanCheckpoint(checkpoint);
    update({ current: { ...run.current, checkpoint: clean } });
    return clean;
  }

  // ---- flaky tests (B9) ----

  /** A second explore pass on the same code, for the journeys only. */
  async function replayPass() {
    live.role = 'playtester';
    try {
      const started = await startApp();
      if (!started.ok) return { ok: false, journeys: [] };
      const res = await playtestAndStop('explore');
      logModel('playtester', res.model, `${res.modelReason || 'setting'} (flaky-test replay)`);
      return { ok: res.ok === true, journeys: isObj(res.report) && Array.isArray(res.report.journeys) ? res.report.journeys : [] };
    } finally {
      live.role = null;
    }
  }

  async function endIteration(critic, confirmed) {
    const c = run.current;
    const milestone = critic.milestone ? critic.milestone.name : run.milestone;
    const journeys = c.report ? c.report.journeys : [];
    const earlier = run.history.filter((h) => h.n !== run.iteration);
    // B9: quarantined (flaky) journeys never count against the iteration.
    let core = cardFlow.coreJourneys(journeys, earlier.length);
    const recordOf = (ok) => ({
      n: run.iteration,
      milestone: milestone || null,
      // No gate score (the Critic could not compute one) counts as no progress.
      score: critic.milestone && Number.isFinite(critic.milestone.score) ? critic.milestone.score : 0,
      // B1: a card closes once the Playtester confirmed it in the app.
      cardsClosed: c.verify ? c.verify.closed.length : c.build ? (c.build.closed || []).length : 0,
      selfCheck: c.build ? c.build.selfCheck : 'green',
      coreJourneysOk: ok,
      rolledBack: false,
    });
    let record = recordOf(core.ok);
    // B9: before a broken journey reverts main, make sure it is not just flaky.
    const wouldRevert = rollbackDecision([...earlier, record]);
    if (deps.checkpoints && !c.checkpoint && wouldRevert.rollback && wouldRevert.reason === 'coreJourneyBroken') {
      await cardFlow.quarantineFlaky(journeys, core.failing);
      core = cardFlow.coreJourneys(journeys, earlier.length);
      record = recordOf(core.ok);
    }
    const regressed = core.regressed;
    const checkpoint = await checkpointStep([...earlier, record], regressed);
    const rolledBack = !!(checkpoint && checkpoint.rollback && checkpoint.rollback.ok);
    if (rolledBack) record = { ...record, rolledBack: true };
    const history = [...earlier, record];
    const lap = buildLap(run.current, record, { evidenceDir: run.evidenceDir });
    const laps = [...run.laps.filter((l) => l.n !== record.n), ...(lap ? [lap] : [])].slice(-MAX_LAPS);
    // Main was reverted: whatever the SHIP pass saw is gone.
    const shipConfirmed = confirmed && !rolledBack;
    const verdict = stopVerdict({ history, critic: { verdict: critic.verdict }, shipConfirmed, stopRequested: run.stopRequested });
    const lastCritic = { verdict: critic.verdict, milestone: critic.milestone, next: critic.next, allPassed: critic.allPassed };
    if (verdict.type !== 'continue') {
      finish(verdict.type, { history, lastCritic, laps });
      return;
    }
    await nextIteration({
      history,
      laps,
      lastCritic,
      // A passed gate moves the run on to the next milestone.
      milestone: (critic.milestone && critic.milestone.passed && critic.next) || milestone || null,
      iteration: run.iteration + 1,
      current: emptyCurrent(),
    });
    if (critic.milestone && critic.milestone.passed && milestone) {
      notifyMilestone(milestone, { report: c.report || null, evidenceDir: lap ? lap.evidenceDir : null, iteration: record.n });
    }
  }

  // ---- hand me the wheel (C11) ----

  /** The end of an iteration: on to directing, or to `handed` when Mati asked for the wheel. */
  async function nextIteration(fields) {
    if (run.handRequested) await enterHanded(fields);
    else transition('directing', fields);
  }

  /** main's commit at the pause: the hand-back reads every commit after it. */
  async function headNow() {
    if (!deps.handback) return null;
    try {
      return (await deps.handback.head(run.repoPath)) || null;
    } catch (err) {
      log(`[lunaswork] could not read HEAD: ${errText(err)}`);
      return null;
    }
  }

  /** The run pauses for Mati: the app stops, no step runs until handBack(). */
  async function enterHanded(fields = {}) {
    await stopApp();
    const base = await headNow();
    if (!active()) return;
    // A Stop pressed meanwhile wins: the loop ends the run at its next check.
    if (run.stopRequested) {
      transition('directing', { ...fields, handRequested: false });
      return;
    }
    // Withdrawn meanwhile (a hand then a back in one phone pull): the run goes on.
    if (!run.handRequested) {
      transition('directing', fields);
      return;
    }
    logEvent(`wheel handed to Mati before iteration ${fields.iteration || run.iteration}${base ? `, main at ${base.slice(0, 7)}` : ''}`);
    transition(HANDED, { ...fields, handRequested: false, handBackRequested: false, handedAt: now(), handBase: base });
  }

  /** Mati's commits since the pause -> DECISIONS.md lines and an ARCHITECTURE.md section. */
  async function readManualWork() {
    if (!deps.handback || !run.handBase) {
      logEvent('hand-back: main at the pause unknown - manual commits not read');
      return;
    }
    let res;
    try {
      res = await deps.handback.commits(run.repoPath, run.handBase);
    } catch (err) {
      res = { ok: false, error: errText(err) };
    }
    if (!isObj(res) || !res.ok) {
      logEvent(`hand-back: commits not read (${String((isObj(res) && res.error) || 'failed').slice(0, 150)})`);
      return;
    }
    const commits = Array.isArray(res.commits) ? res.commits : [];
    const date = new Date(now()).toISOString().slice(0, 10);
    const written = commits.filter((c) =>
      writeDecisionLine(handbackDecisionLine(c, { date }), { kind: 'manual', sha: c.sha }, `manual commit ${c.sha.slice(0, 7)}`));
    const block = architectureBlock(commits, { date, iteration: run.iteration, more: res.more || 0 });
    if (block) {
      try {
        if (deps.handback.architecture({ repoPath: run.repoPath, block }) === false) logEvent('hand-back: ARCHITECTURE.md not updated');
      } catch (err) {
        logEvent(`hand-back: ARCHITECTURE.md not updated (${errText(err).slice(0, 150)})`);
      }
    }
    logEvent(`hand-back: ${commits.length} manual commit(s) read, ${written.length} recorded in DECISIONS.md`);
  }

  /** The hand-back itself; saved first, so a restart mid-way does it again. */
  async function takeWheelBack() {
    handingBack = true;
    try {
      if (!run.handBackRequested) update({ handBackRequested: true });
      emit('wheel');
      // Mati may have pushed from another machine: main first.
      await syncCheckout();
      await readManualWork();
      // A Stop during the reading ended the run.
      if (!active() || run.phase !== HANDED) return;
      transition('directing', { handBackRequested: false, handedAt: null, handBase: null });
      // A usage-limit wait that is still on goes first.
      if (!waitTimer) kick();
    } finally {
      handingBack = false;
    }
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
      // Handed (C11): no step runs until Mati hands the wheel back.
      while (active() && !waitTimer && run.phase !== HANDED) {
        // STOP: the step that was running has finished - end here.
        if (run.stopRequested) {
          await stopApp();
          finish('stop');
          break;
        }
        // A deadline that passed while the PC slept: its default goes first.
        expireDecisions();
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
    let profile = deps.profileFor(project.id);
    // An empty repo gets iteration 0; with no profile yet, its template's
    // defaults are suggested - Mati confirms them with the start.
    const scaffold = deps.scaffold ? deps.scaffold.plan(project.repoPath, profile) : null;
    const suggested = !profile && !!scaffold;
    if (suggested) profile = scaffold.profile;
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
    const scaffoldInfo = scaffold ? { stack: scaffold.stack, label: scaffold.label, profileSuggested: suggested } : null;
    return { project, override, profile, checkCommand, scaffold: scaffoldInfo };
  }

  /** The template's suggested profile, confirmed with the start, kept in LunaCore's local settings. */
  function keepSuggestedProfile(projectId, profile) {
    if (!deps.saveProfile) return;
    try {
      if (deps.saveProfile(projectId, profile) === false) log('[lunaswork] the suggested profile was not saved');
    } catch (err) {
      log(`[lunaswork] the suggested profile was not saved: ${errText(err)}`);
    }
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
    const { project, override, profile, checkCommand, scaffold } = checked;
    starting = true;
    let confirmed = true;
    try {
      // Mati sees the commands that will run; the run keeps exactly these.
      if (deps.confirmStart) {
        const ctx = { projectId: project.id, repoPath: project.repoPath, profile, checkCommand, ...(scaffold ? { scaffold } : {}) };
        confirmed = (await deps.confirmStart(ctx)) === true;
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
    if (scaffold && scaffold.profileSuggested) keepSuggestedProfile(project.id, profile);
    run = created;
    logEvent(`started; models ${ROLES.map((role) => `${role}=${models[role]} (${sources[role]})`).join(', ')}`);
    save();
    emit('phase');
    holdAwake();
    kick();
    return { ok: true, status: status() };
  }

  const NO_RUN = () => refuse('no-run', "No Luna's Work run is going.");

  /**
   * Puts a question in the decision queue of the current run. Never blocks
   * the run: only the listed cards wait for the answer.
   * @param {{question:string, options?:string[], defaultAnswer?:string|null, deadlineMs?:number,
   *   kind?:string, cardIds?:number[], detail?:string, freeText?:boolean}} spec
   *   deadlineMs defaults to 2 h; kind 'clientScope' has no default and no deadline
   * @returns {{ok:true, id:number}|{ok:false, reason:string, message:string}}
   */
  function ask(spec) {
    if (!active()) return NO_RUN();
    const res = createDecision(spec, { now: now(), list: run.decisions, iteration: run.iteration });
    if (!res.ok) return refuse(res.error, 'The decision could not be queued.');
    const d = res.decision;
    logEvent(`decision ${d.id} asked (${d.kind})${d.cardIds.length ? `, card(s) ${d.cardIds.join(', ')} held` : ''}`);
    decisionsChanged([...run.decisions, d]);
    return { ok: true, id: d.id };
  }

  /**
   * Mati's answer to a pending decision. Only a known pending id of this run
   * and a listed option (or capped free text where allowed) are accepted.
   * @param {{id:number|string, answer:string, runId?:string}} payload untrusted
   * @returns {{ok:true, status:object}|{ok:false, reason:string, message:string}}
   */
  function answer(payload) {
    if (!active()) return NO_RUN();
    const p = isObj(payload) ? payload : {};
    if (p.runId !== undefined && p.runId !== run.id) return refuse('unknownDecision', 'That decision is not part of this run.');
    const res = answerDecision(run.decisions, { id: p.id, answer: p.answer }, { by: 'mati', now: now() });
    if (!res.ok) return refuse(res.error, 'The answer was not accepted.');
    decisionsChanged(res.list, [res.decision]);
    return { ok: true, status: status() };
  }

  /**
   * Answers that came back from the phone (lunasworkDecisions.answersFromTodoPeers).
   * Already answered ids and other runs' answers are skipped quietly; a bad
   * answer to a pending decision is refused and logged.
   * @param {Array<{id:number, runId:string, answer:string}>} list untrusted
   * @returns {number} how many were applied
   */
  function applyAnswers(list) {
    if (!active() || !Array.isArray(list)) return 0;
    let applied = 0;
    for (const a of list) {
      if (!isObj(a) || a.runId !== run.id || !pendingOf(run.decisions).some((d) => d.id === a.id)) continue;
      const res = answer({ id: a.id, answer: a.answer, runId: a.runId });
      if (res.ok) {
        applied += 1;
      } else {
        logEvent(`decision ${a.id}: answer from the phone refused (${res.reason})`);
        save();
      }
    }
    return applied;
  }

  /**
   * Feedback on the current run, from any channel (B17). Never pauses the
   * run: the item is stored and the next iteration triages it.
   * @param {{text:string, author?:'mati'|'client', id?:number, runId?:string}} payload untrusted
   * @returns {{ok:true, id:number}|{ok:false, reason:string, message:string}}
   */
  function feedback(payload) {
    if (!active()) return NO_RUN();
    const p = isObj(payload) ? payload : {};
    if (p.runId !== undefined && p.runId !== run.id) return refuse('otherRun', 'That feedback is for another run.');
    const res = createItem({ text: p.text, author: p.author, ...(p.id !== undefined ? { id: p.id } : {}) }, { now: now(), list: run.feedback });
    if (!res.ok) return refuse(res.error, 'The feedback was not accepted.');
    run = { ...run, feedback: [...run.feedback, res.item] };
    logEvent(`feedback ${res.item.id} from ${res.item.author}: planned in at the next iteration`);
    save();
    emit('feedback');
    return { ok: true, id: res.item.id };
  }

  /**
   * Feedback from the phone / web form (lunasworkFeedback.feedbackFromTodoPeers).
   * Only Mati's account writes there, so the author is Mati. Other runs' and
   * known ids are skipped quietly; a refused item is logged once.
   * @param {Array<{id:number, runId:string, text:string}>} list untrusted
   * @returns {number} how many were added
   */
  function applyFeedback(list) {
    if (!active() || !Array.isArray(list)) return 0;
    let added = 0;
    for (const f of list) {
      if (!isObj(f) || f.runId !== run.id || refusedFeedback.has(f.id) || run.feedback.some((i) => i.id === f.id)) continue;
      const res = feedback({ text: f.text, author: 'mati', id: f.id, runId: f.runId });
      if (res.ok) {
        added += 1;
      } else {
        refusedFeedback.add(f.id);
        logEvent(`feedback ${String(f.id).slice(0, 20)} from the phone refused (${res.reason})`);
        save();
      }
    }
    return added;
  }

  /** Whether a wheel payload names another run than the current one (none named = current). */
  const otherRun = (p) => p.runId !== undefined && p.runId !== run.id;

  /**
   * "Hand me the wheel" (C11): the run pauses at the end of the current
   * iteration. A run waiting before its Director has none under way and is
   * handed at once (its wait keeps ticking).
   * @param {{runId?:string}} [payload] untrusted
   * @returns {Promise<{ok:true, status:object}|{ok:false, reason:string, message:string}>}
   */
  async function handOver(payload) {
    if (!active()) return NO_RUN();
    const p = isObj(payload) ? payload : {};
    if (otherRun(p)) return refuse('otherRun', 'That is not the current run.');
    if (run.phase === HANDED) return refuse('handed', 'The wheel is already yours.');
    if (run.stopRequested) return refuse('stopping', 'The run is stopping.');
    if (!run.handRequested) {
      logEvent('Mati asked for the wheel: the run pauses at the end of this iteration');
      update({ handRequested: true });
      emit('wheel');
    }
    if (!looping && waitTimer && run.phase === 'directing') {
      // Held like a step: the wait timer firing meanwhile must not start the Director.
      looping = true;
      try {
        await enterHanded();
      } finally {
        looping = false;
      }
      // Not handed after all (a Stop or a withdraw meanwhile), and the wait
      // timer's kick fell on the held loop: run the loop now.
      if (active() && run.phase !== HANDED && !waitTimer) kick();
    }
    return { ok: true, status: status() };
  }

  /**
   * Hands the wheel back: Mati's commits since the pause are recorded, then
   * the run goes on from directing. Before the pause it withdraws the request.
   * @param {{runId?:string}} [payload] untrusted
   * @returns {Promise<{ok:true, status:object}|{ok:false, reason:string, message:string}>}
   */
  async function handBack(payload) {
    if (!active()) return NO_RUN();
    const p = isObj(payload) ? payload : {};
    if (otherRun(p)) return refuse('otherRun', 'That is not the current run.');
    if (run.phase !== HANDED) {
      if (!run.handRequested) return refuse('notHanded', 'The run has the wheel.');
      logEvent('Mati withdrew the wheel request: the run goes on');
      update({ handRequested: false });
      emit('wheel');
      return { ok: true, status: status() };
    }
    if (handingBack) return refuse('busy', 'The hand-back is already under way.');
    await takeWheelBack();
    return { ok: true, status: status() };
  }

  /**
   * Wheel actions from the phone (lunasworkWheel.wheelFromTodoPeers): only the
   * newest of this run that was not applied yet counts, once.
   * @param {Array<{id:number, runId:string, action:string}>} list untrusted
   * @returns {Promise<boolean>} whether one was applied
   */
  async function applyWheel(list) {
    if (!active()) return false;
    const w = newestWheelAction(list, { runId: run.id, seq: run.wheelSeq, now: now() });
    if (!w) return false;
    update({ wheelSeq: w.id });
    const res = await (w.action === 'hand' ? handOver({ runId: w.runId }) : handBack({ runId: w.runId }));
    if (!res.ok) {
      logEvent(`wheel ${w.action} from the phone refused (${res.reason})`);
      save();
    }
    return res.ok;
  }

  /**
   * The kill switch: the step that is running finishes, then the run ends
   * with STOP. A run that is waiting ends at once.
   * @param {string} [reason] one of STOP_CALLERS (the machine guard); anything
   *   else - the IPC passes nothing - is the kill switch
   */
  function stop(reason) {
    if (!active()) return { ok: false, reason: 'no-run', message: "No Luna's Work run is going." };
    requestStop(STOP_CALLERS.includes(reason) ? reason : 'killSwitch');
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
    armDecisionTimer();
    if (Number.isFinite(run.waitUntil) && run.waitUntil > now()) {
      armWait(run.waitUntil, run.waitReason || 'limit');
    } else {
      update({ waitUntil: null, waitReason: null });
      kick();
    }
    // C11: a hand-back cut off by the restart is done again.
    if (active() && run.phase === HANDED && run.handBackRequested) {
      takeWheelBack().catch((err) => log(`[lunaswork] hand-back failed: ${errText(err)}`));
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
      // B9: the flaky tests quarantined in this run.
      quarantine: run.quarantine.map((q) => q.name),
      // C11: who has the wheel (running / requested / handed), and since when.
      wheel: wheelState(run),
      handedAt: run.handedAt,
      evidenceDir: run.evidenceDir,
      endedAt: run.endedAt,
      // What waits for Mati (HUD panel, phone snapshot); none once the run ended.
      pendingDecisions: active()
        ? pendingOf(run.decisions).map((d) => publicDecision({ ...d, runId: run.id, repoName: path.basename(run.repoPath) })).filter(Boolean)
        : [],
      // B17: the run's feedback with each item's status (phone snapshot); null once the run ended.
      // C11: the wheel rides in the same section - the phone's buttons need the run id too.
      feedback: active()
        ? publicFeedback({ runId: run.id, repoName: path.basename(run.repoPath), items: run.feedback, wheel: wheelState(run) })
        : null,
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
    clearDecisionTimer();
    await stopApp();
    releaseAwake();
  }

  return {
    start,
    stop,
    resume,
    ask,
    answer,
    applyAnswers,
    feedback,
    applyFeedback,
    handOver,
    handBack,
    applyWheel,
    status,
    subscribe,
    godModeBlock,
    isActiveOn: (projectId) => active() && run.projectId === projectId,
    /** The run's history log: every model choice with its reason, and the run's events. */
    runLog: () => (run ? run.log.map((e) => ({ ...e })) : []),
    /** A deep copy of the run record (the machine guard's cleanup and decisions), or null. */
    snapshot: () => (run ? JSON.parse(JSON.stringify(run)) : null),
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
