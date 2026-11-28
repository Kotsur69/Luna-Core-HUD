// ============================================================================
// LunaCore - Luna's Work decision gates: ask Mati instead of building on a regression
// ----------------------------------------------------------------------------
// Two safety nets the run controller (src/lunaswork.js) runs as an iteration
// ends and before the next one is directed. Seen live in run lwmwzajado
// (10 iterations, ~$28, Milestone 1 never passed).
//
//   failed rollback  the score fell past the margin (or a core journey broke),
//                    the rollback was triggered and FAILED: main still has the
//                    broken iteration. The next iteration does not start: the
//                    decision queue asks "revert by hand and resume / keep this
//                    iteration and continue / stop the run". Default at the
//                    deadline: keep (the behaviour before this gate). Revert by
//                    hand reopens the iteration's cards and marks it rolled back
//                    (Mati put main back), then the checkout is synced. Stop
//                    ends the run (stopReason rollbackFailed). State:
//                    run.rollbackHold {n, decisionId, toIteration, cards}
//   harness loop     src/lunasworkHarnessLoop.js: K iterations on a milestone
//                    without a pass, or a harness-heavy last three iterations.
//                    Asked once per trigger and milestone; the next iteration
//                    waits for the answer. Keep going (default), drop the
//                    unscorable criterion (a DECISIONS.md line the Critic reads),
//                    or stop (stopReason harnessLoop). State: run.harnessLoop
//
// The wait is the run's wait timer (waitReason rollbackFailed / harnessLoop)
// up to the decision's deadline; an earlier answer wakes it (onAnswered). The
// decision deadline itself is taken by the controller's decision timer and
// by the step loop's expireDecisions(), so a timeout always resolves.
// ============================================================================

'use strict';

const loop = require('./lunasworkHarnessLoop');

const REVERT_BY_HAND = 'revert-by-hand';
const KEEP = 'keep';
const STOP = 'stop';
const ROLLBACK_OPTIONS = Object.freeze([REVERT_BY_HAND, KEEP, STOP]);
const ROLLBACK_DEADLINE_MS = 2 * 60 * 60 * 1000;
const ROLLBACK_WAIT = 'rollbackFailed';
const HARNESS_WAIT = 'harnessLoop';
const MAX_TEXT = 300;
const MAX_CARDS = 50;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ats = (v) => [...new Set((Array.isArray(v) ? v : []).filter((a) => Number.isSafeInteger(a) && a > 0))].slice(0, MAX_CARDS);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const utcTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** run.rollbackHold read back from disk, or null (an old run has none). */
function cleanRollbackHold(raw) {
  if (!isObj(raw) || !Number.isInteger(raw.n) || raw.n < 1) return null;
  return {
    n: raw.n,
    decisionId: Number.isSafeInteger(raw.decisionId) && raw.decisionId > 0 ? raw.decisionId : null,
    toIteration: Number.isInteger(raw.toIteration) && raw.toIteration > 0 ? raw.toIteration : null,
    cards: ats(raw.cards),
  };
}

/**
 * The decision-queue spec for a failed rollback.
 * @param {{n:number, rollback:{reason?:string, why?:string, error?:string, detail?:string, toIteration?:number, toTag?:string}}} o
 */
function rollbackDecision({ n, rollback }) {
  const r = isObj(rollback) ? rollback : {};
  const to = Number.isInteger(r.toIteration) ? ` to iteration ${r.toIteration}` : '';
  const why = oneLine(r.why, 120) || oneLine(r.reason, 40) || 'a regression';
  const error = oneLine(r.error, 40) || 'failed';
  return {
    kind: 'rollbackFailed',
    question: `Iteration ${n} regressed (${why}) and the rollback${to} failed (${error}), so main still has it. Revert main by hand and resume, keep this iteration and continue, or stop the run?`,
    detail: oneLine([r.toTag ? `last good tag ${r.toTag}` : '', r.detail || ''].filter(Boolean).join('; '), MAX_TEXT) || null,
    options: [...ROLLBACK_OPTIONS],
    defaultAnswer: KEEP,
    deadlineMs: ROLLBACK_DEADLINE_MS,
    cardIds: [],
  };
}

/**
 * @param {{
 *   run: ()=>object,
 *   update: (fields:object)=>void,
 *   logEvent: (text:string)=>void,
 *   ask: (spec:object)=>({ok:true, id:number}|{ok:false}),
 *   armWait: (until:number, reason:string)=>void,
 *   wake: (reason:string)=>void,
 *   finish: (verdict:string, fields?:object)=>void,
 *   cardBook: {lookup:(projectId:string, ats:number[])=>object[], reopen:(projectId:string, ats:number[])=>void},
 *   syncCheckout: ()=>Promise<void>,
 *   writeDecisionLine: (line:string, decision:object, label:string)=>boolean,
 *   now: ()=>number,
 * }} ctx
 */
function createDecisionGates(ctx) {
  const { run, update, logEvent, ask, armWait, wake, finish, cardBook } = ctx;
  const rollbackHold = () => cleanRollbackHold(run().rollbackHold);
  const harnessState = () => loop.restoreLoop(run().harnessLoop);
  const decisionOf = (id) => (id === null ? null : (run().decisions || []).find((d) => d.id === id) || null);
  const answeredBy = (d) => (d.answeredBy === 'default' ? 'default after deadline' : 'answered by Mati');

  // ---- as an iteration ends ----

  /** The failed rollback goes to Mati; true when the next iteration waits for it. */
  function askRollback(n, rollback, closed) {
    const held = rollbackHold();
    // A restart that ends the same iteration again: asked already.
    if (held && held.n === n) return held.decisionId !== null;
    const asked = ask(rollbackDecision({ n, rollback }));
    if (!asked || !asked.ok) {
      logEvent(`rollback failed and the question could not be queued - main keeps iteration ${n}`);
      return false;
    }
    const d = decisionOf(asked.id);
    update({ rollbackHold: { n, decisionId: asked.id, toIteration: rollback.toIteration || null, cards: ats(closed) } });
    const by = d && Number.isFinite(d.deadline) ? ` - default keep at ${utcTime(d.deadline)}` : '';
    logEvent(`rollback failed: iteration ${n + 1} waits for Mati (decision ${asked.id}): revert main by hand and resume, keep iteration ${n}, or stop the run${by}`);
    return true;
  }

  /** The iteration's cards with the to-do store's tags and files. */
  function iterationCards(current) {
    const own = (Array.isArray(current.cards) ? current.cards : []).filter(isObj);
    if (!own.length) return [];
    let stored = [];
    try {
      stored = cardBook.lookup(run().projectId, own.map((c) => c.at));
    } catch (err) {
      logEvent(`harness check: cards not read (${errText(err).slice(0, 150)})`);
    }
    const byAt = new Map((Array.isArray(stored) ? stored : []).filter(isObj).map((t) => [t.at, t]));
    return own.map((c) => ({ ...c, ...(byAt.has(c.at) ? { tags: byAt.get(c.at).tags, files: c.files || byAt.get(c.at).files } : {}) }));
  }

  /** The harness-loop state after this iteration; asks Mati when a new trigger holds. */
  function checkHarness({ n, milestone, passed, current, critic, mayAsk }) {
    const tally = loop.harnessTally(iterationCards(current), current.merges);
    let state = loop.recordIteration(harnessState(), { n, milestone, passed, ...tally });
    const hit = mayAsk && state.decisionId === null ? loop.loopTrigger(state) : null;
    if (hit) {
      const counts = loop.loopCounts(state);
      const asked = ask(loop.loopDecision({ triggers: hit.triggers, counts, critic, report: current.report, milestone }));
      if (asked && asked.ok) {
        state = {
          ...state,
          asked: [...state.asked, ...hit.keys],
          decisionId: asked.id,
          trigger: hit.triggers[0],
          criterion: loop.unscoredCriterion(current.report, milestone),
        };
        const share = counts.harnessPercent === null ? '' : `, harness ${counts.harnessPercent}% of the last ${counts.window} iterations' cards`;
        logEvent(`harness loop on ${milestone || 'the milestone'} (${counts.iterations} iteration(s) without a pass${share}): iteration ${n + 1} waits for Mati (decision ${asked.id})`);
      } else {
        logEvent('harness loop: the question could not be queued - the run goes on');
      }
    }
    update({ harnessLoop: state });
  }

  /**
   * As a continuing iteration ends (its verdict is continue): a failed
   * rollback, then the harness loop. Never throws: a bug here is a log line.
   * @param {{n:number, milestone:string|null, passed:boolean, current:object, critic:object, checkpoint:object|null}} o
   */
  function afterIteration(o) {
    try {
      const rb = isObj(o.checkpoint) && isObj(o.checkpoint.rollback) ? o.checkpoint.rollback : null;
      const closed = isObj(o.current.build) && Array.isArray(o.current.build.closed) ? o.current.build.closed : [];
      const waits = rb && rb.ok === false ? askRollback(o.n, rb, closed) : false;
      // One question at a time: the harness check still counts this iteration.
      checkHarness({ ...o, mayAsk: !waits });
    } catch (err) {
      logEvent(`decision gates failed: ${errText(err).slice(0, 200)}`);
    }
  }

  // ---- before the next iteration ----

  /** Mati reverted main by hand: the iteration counts as rolled back, its cards are open again. */
  async function revertedByHand(hold) {
    const r = run();
    cardBook.reopen(r.projectId, hold.cards);
    const mark = (list) => (Array.isArray(list) ? list.map((x) => (isObj(x) && x.n === hold.n ? { ...x, rolledBack: true } : x)) : list);
    update({ history: mark(r.history), laps: mark(r.laps) });
    logEvent(`iteration ${hold.n} reverted by hand: ${hold.cards.length} card(s) reopened, checkout synced - the run resumes`);
    await ctx.syncCheckout();
  }

  /** @returns {Promise<boolean>} true = the run waits or ended */
  async function rollbackGate() {
    const hold = rollbackHold();
    if (!hold) return false;
    const d = decisionOf(hold.decisionId);
    if (d && d.status === 'pending') {
      armWait(d.deadline, ROLLBACK_WAIT);
      return true;
    }
    update({ rollbackHold: null });
    const answer = d ? d.answer : KEEP;
    const by = d ? ` (decision ${d.id}, ${answeredBy(d)})` : '';
    if (answer === STOP) {
      logEvent(`failed rollback of iteration ${hold.n}: the run stops${by}`);
      finish('stop', { stopReason: 'rollbackFailed' });
      return true;
    }
    if (answer === REVERT_BY_HAND) await revertedByHand(hold);
    else logEvent(`failed rollback of iteration ${hold.n}: main keeps it and the run continues${by}`);
    return false;
  }

  function harnessGate() {
    const state = harnessState();
    if (state.decisionId === null) return false;
    const d = decisionOf(state.decisionId);
    if (d && d.status === 'pending') {
      armWait(d.deadline, HARNESS_WAIT);
      return true;
    }
    update({ harnessLoop: { ...state, decisionId: null } });
    const answer = d ? d.answer : loop.KEEP_GOING;
    const by = d ? ` (decision ${d.id}, ${answeredBy(d)})` : '';
    const milestone = state.milestone || 'the current milestone';
    if (answer === loop.STOP) {
      logEvent(`harness loop on ${milestone}: the run stops${by}`);
      finish('stop', { stopReason: 'harnessLoop' });
      return true;
    }
    if (answer === loop.DROP_CRITERION) {
      const date = new Date(ctx.now()).toISOString().slice(0, 10);
      const line = loop.dropCriterionLine({ milestone, criterion: state.criterion, date });
      const written = ctx.writeDecisionLine(line, d || { kind: 'harnessLoop' }, 'harness loop');
      logEvent(`harness loop on ${milestone}: ${state.criterion ? `"${state.criterion}"` : 'the unscorable criterion'} dropped from the gate${written ? ' (DECISIONS.md)' : ''}${by}`);
      return false;
    }
    logEvent(`harness loop on ${milestone}: keep going${by}`);
    return false;
  }

  /**
   * At the start of every directing step. true = the run waits for Mati (or
   * his answer ended it); false = go on.
   */
  async function gate() {
    if (await rollbackGate()) return true;
    return harnessGate();
  }

  /** An early answer to a gate's question wakes the waiting run. */
  function onAnswered(answered) {
    const ids = new Set((Array.isArray(answered) ? answered : []).filter(isObj).map((d) => d.id));
    const hold = rollbackHold();
    if (hold && ids.has(hold.decisionId)) wake(ROLLBACK_WAIT);
    const state = harnessState();
    if (state.decisionId !== null && ids.has(state.decisionId)) wake(HARNESS_WAIT);
  }

  return { afterIteration, gate, onAnswered };
}

module.exports = {
  REVERT_BY_HAND,
  KEEP,
  STOP,
  ROLLBACK_OPTIONS,
  ROLLBACK_DEADLINE_MS,
  ROLLBACK_WAIT,
  HARNESS_WAIT,
  cleanRollbackHold,
  rollbackDecision,
  createDecisionGates,
};
