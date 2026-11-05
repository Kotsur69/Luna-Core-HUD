// ============================================================================
// LunaCore - God Mode questions for Mati (HUD dialog + phone)
// ----------------------------------------------------------------------------
// A post-merge step that needs Mati's yes (orchestraApplyActions.js: apply
// Supabase actions) asks here. One question is the same decision in two
// places, the first answer wins:
//
//   HUD    a native dialog (main's `confirm`), which the renderer can never
//          answer; closed again once the phone or the deadline answered.
//   phone  the decision joins the `godmode` snapshot's `decisions` list, the
//          same list Luna's Work questions use (lunasworkDecisions.js
//          publicDecision); the phone writes `lunaswork-answer:<id>` into the
//          `todos` cloud scope and pullAnswers() reads it back. Rows are
//          untrusted: only a pending id of this queue, with the run id it was
//          asked for, and a listed option are taken.
//
// Every question has a default and a deadline (lunasworkDecisions.js caps);
// past it the default is taken - for the Supabase step that is "do not
// apply". Questions live in memory only: after a restart nobody waits for
// them any more, which is the same safe default.
// ============================================================================

'use strict';

const { createDecision, answerDecision, publicDecision, answersFromTodoPeers } = require('./lunasworkDecisions');

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {{
 *   confirm?: (q:{question:string, detail:string|null, deadline:number}, signal?:AbortSignal) => Promise<boolean|null>,
 *   onChange?: (pending:object[]) => void,
 *   now?: () => number, setTimer?: Function, clearTimer?: Function, log?: (line:string) => void,
 * }} [deps]
 *   confirm: the HUD dialog - true = approve, false = reject, null = no
 *   answer there (no window); the signal closes it once answered elsewhere
 *   onChange: the pending list changed (main republishes the phone snapshot)
 */
function createOrchestraAsk(deps = {}) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const confirm = typeof deps.confirm === 'function' ? deps.confirm : null;
  const onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  let list = [];
  // id -> {resolve, timer, abort, runId, repoName}
  const waiting = new Map();

  /** The pending questions as the phone reads them (publicDecision shape). */
  function pending() {
    return list
      .map((d) => {
        const w = waiting.get(d.id);
        return w ? publicDecision({ ...d, runId: w.runId, repoName: w.repoName }) : null;
      })
      .filter(Boolean);
  }

  function changed() {
    try {
      onChange(pending());
    } catch (err) {
      log(`[orchestra] ask snapshot failed: ${errText(err)}`);
    }
  }

  /** Answers one pending question; by = 'hud' | 'phone' | 'default'. */
  function settle(id, raw, by) {
    const w = waiting.get(id);
    if (!w) return false;
    const res = answerDecision(list, by === 'default' ? { id } : { id, answer: raw }, { by: by === 'default' ? 'default' : 'mati', now: now() });
    if (!res.ok) return false;
    waiting.delete(id);
    list = list.filter((d) => d.id !== id);
    clearTimer(w.timer);
    if (w.abort) w.abort.abort();
    w.resolve({ answer: res.decision.answer, by });
    changed();
    return true;
  }

  function askHud(d, abort) {
    Promise.resolve()
      .then(() => confirm({ question: d.question, detail: d.detail, deadline: d.deadline }, abort ? abort.signal : undefined))
      .then((ok) => {
        // Closed by our own signal: the phone or the deadline answered first.
        if ((abort && abort.signal.aborted) || !waiting.has(d.id)) return;
        if (ok === true) settle(d.id, 'approve', 'hud');
        else if (ok === false) settle(d.id, 'reject', 'hud');
      })
      .catch((err) => log(`[orchestra] ask dialog failed: ${errText(err)}`));
  }

  /**
   * Asks Mati. Resolves with the first answer, or the default at the deadline.
   * @param {{question:string, detail?:string, options:string[], defaultAnswer:string,
   *   deadlineMs?:number, kind?:string, runId:string, repoName?:string}} spec
   * @returns {Promise<{answer:string|null, by:'hud'|'phone'|'default'|'error', error?:string}>}
   */
  function ask(spec) {
    const s = isObj(spec) ? spec : {};
    if (typeof s.runId !== 'string' || !RUN_ID_RE.test(s.runId)) return Promise.resolve({ answer: null, by: 'error', error: 'badRunId' });
    const made = createDecision(s, { now: now(), list });
    if (!made.ok) return Promise.resolve({ answer: null, by: 'error', error: made.error });
    const d = made.decision;
    // A question here must never wait forever: a default and a deadline, always.
    if (d.defaultAnswer === null || !Number.isFinite(d.deadline)) return Promise.resolve({ answer: null, by: 'error', error: 'noDefault' });
    return new Promise((resolve) => {
      list = [...list, d];
      const abort = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimer(() => settle(d.id, null, 'default'), Math.max(0, d.deadline - now()));
      waiting.set(d.id, { resolve, timer, abort, runId: s.runId, repoName: typeof s.repoName === 'string' ? s.repoName : null });
      changed();
      if (confirm) askHud(d, abort);
    });
  }

  /**
   * Answers from the phone (lunasworkDecisions.answersFromTodoPeers). Other
   * runs' answers and unknown ids are skipped quietly.
   * @param {Array<{id:number, runId:string, answer:string}>} answers untrusted
   * @returns {number} how many were taken
   */
  function applyAnswers(answers) {
    let taken = 0;
    for (const a of Array.isArray(answers) ? answers : []) {
      if (!isObj(a)) continue;
      const w = waiting.get(a.id);
      if (!w || a.runId !== w.runId) continue;
      if (settle(a.id, a.answer, 'phone')) taken += 1;
    }
    return taken;
  }

  /** After a `todos` pull: the phone's answers out of the cloud peers. Never throws. */
  function pullAnswers(cloud) {
    if (!waiting.size || !cloud || typeof cloud.hooks !== 'function') return 0;
    try {
      return applyAnswers(answersFromTodoPeers(cloud.hooks('todos').extraPeers()));
    } catch (err) {
      log(`[orchestra] phone answers not read: ${errText(err)}`);
      return 0;
    }
  }

  /** Every pending question takes its default now (e.g. on quit). */
  function cancelAll() {
    for (const id of [...waiting.keys()]) settle(id, null, 'default');
  }

  return { ask, pending, applyAnswers, pullAnswers, cancelAll };
}

module.exports = { createOrchestraAsk };
