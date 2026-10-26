// ============================================================================
// LunaCore - Luna's Work loop hooks (docs/LUNAS_WORK_PLAN.md, LW 2.23 + the
// wiring of 2.15, 2.20, 2.21b and 2.19b)
// ----------------------------------------------------------------------------
// The extra steps the outer loop controller (src/lunaswork.js) runs around
// its phases. None of them can stop a run: a throw, a rejection or a failed
// result becomes a note - in the run log and in the iteration's lap, so the
// run report lists it (lunasworkReport "Notes") - and the run goes on.
//
//   afterMerge(build)    after a merged (green) build:
//                        - refreshGraph: re-index the code graph and commit
//                          the refreshed docs/CODEMAPS (LW 2.23, B19)
//                        - i18n: the single missing-keys card, when there is
//                          one (B11, src/lunasworkI18n.js)
//   afterLaunch(url)     with the app up, every iteration: Lighthouse on the
//                        TEST_PLAN.md routes; the results are kept with the run
//                        (run.lighthouse, the dashboard trend) and budget
//                        breaches become cards (B7, src/lunasworkLighthouse.js)
//   afterCritic(critic, criticCards) -> critic
//                        - reviews due this iteration (security / performance
//                          / cleanup, src/lunasworkReviews.js)
//                        - at a milestone gate, the second opinion
//                          (src/lunasworkSecondOpinion.js): its new findings
//                          are filed; a disagreement keeps the gate closed
//                          (run.gateHold) and asks Mati in the decision queue
//   onAnswered(answered) Mati's answer to a held gate: approve opens it (the
//                        run moves on to the next milestone), reject keeps it
//                        closed for the next Critic to judge again. An approve
//                        that comes in while the held iteration is still
//                        ending is kept (gateHold.approved) and applied by
//                        withApproval(critic) as that iteration ends.
//   atGate(critic, {rolledBack, milestone})
//                        LW 2.16, ONLY at a passed gate that stayed on main:
//                        project skills proposed, reviewed by the Critic,
//                        written to .claude/skills and committed locally
//                        (src/lunasworkSkills.js); the git log starts at the
//                        previous gate's iteration (a lap with gate: true)
//
// A held gate is resolved by the next Critic too: its own call stands, and
// no second opinion runs on that pass.
//
// Each hook marks itself done in run.current.hooks, so a restart never files
// its cards twice. Cards are filed through the card book (Critic shape,
// lunasworkCritic.applyCards); a card whose text - numbers aside - matches
// an open card is not filed again.
//
// Injected (all optional; a missing one is skipped):
//   deps.refreshGraph({repoPath, runId, iteration}) -> Promise<{ok:boolean, notes?:string[], committed?:boolean}>
//   deps.i18n({repoPath, runId, iteration}) -> i18nCards() result
//   deps.lighthouse({projectId, repoPath, runId, iteration, url, evidenceDir})
//       -> Promise<{results, notes, budgets?}|null>   (null: nothing to measure)
//   deps.reviews({iteration, isGate, runId, repoPath}) -> Promise<runReviews() result>
//   deps.secondOpinion({isGate, repoPath, runId, iteration, report, allPassed})
//       -> Promise<runSecondOpinion() result|null>    (null: off, no CLI order set)
//   deps.skills({isGate, repoPath, runId, iteration, milestone, models, sinceIteration})
//       -> Promise<runGateSkills() result>
// ============================================================================

'use strict';

const { appendResult, budgetCards } = require('./lunasworkLighthouse');
const { mergeFindings, gateVerdict, SECOND_OPINION_SOURCE } = require('./lunasworkSecondOpinion');
const { APPROVE, REJECT } = require('./lunasworkDecisions');

const MAX_NOTE_CHARS = 300;
const MAX_NOTES = 20;
const FAILED = Symbol('failed');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const errText = (err) => (err instanceof Error ? err.message : String(err));
// Two card texts that differ only in their numbers ("3 keys missing" / "4 keys missing") are one finding.
const shape = (text) => String(text || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/** A gate this iteration: the Critic passes the milestone or says SHIP. */
const isGateOf = (critic) => isObj(critic) && (critic.verdict === 'ship' || !!(isObj(critic.milestone) && critic.milestone.passed));

/**
 * @param {{
 *   deps: object,
 *   run: ()=>object,
 *   update: (fields:object)=>void,
 *   logEvent: (text:string)=>void,
 *   cardBook: {fileCards:(projectId:string, runId:string, cards:object[])=>number[]},
 *   ask: (spec:object)=>({ok:true, id:number}|{ok:false}),
 *   onGateOpened?: (milestone:string)=>void,
 * }} ctx
 */
function createLoopHooks(ctx) {
  const { deps, run, update, logEvent, cardBook, ask } = ctx;
  const onGateOpened = typeof ctx.onGateOpened === 'function' ? ctx.onGateOpened : () => {};

  // ---- notes and progress ----

  /** One line in the run log and in this iteration's notes (the run report). */
  function note(text) {
    const line = String(text).slice(0, MAX_NOTE_CHARS);
    logEvent(line);
    const c = run().current;
    update({ current: { ...c, hookNotes: [...list(c.hookNotes), line].slice(-MAX_NOTES) } });
  }

  const isDone = (key) => !!(isObj(run().current.hooks) && run().current.hooks[key]);

  function markDone(key) {
    const c = run().current;
    update({ current: { ...c, hooks: { ...(isObj(c.hooks) ? c.hooks : {}), [key]: true } } });
  }

  /** An injected step; a throw or a rejection is a note and FAILED. */
  async function guarded(label, fn) {
    try {
      return await fn();
    } catch (err) {
      note(`${label} failed: ${errText(err).slice(0, 200)}`);
      return FAILED;
    }
  }

  /** A whole hook: a bug in here is a note too, never a failed step. */
  async function safely(label, fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      try {
        note(`${label} failed: ${errText(err).slice(0, 200)}`);
      } catch {
        // ignored on purpose: the note is best effort
      }
      return fallback;
    }
  }

  const base = () => {
    const r = run();
    return { repoPath: r.repoPath, runId: r.id, iteration: r.iteration };
  };

  // ---- cards ----

  function openTexts() {
    try {
      const items = deps.todoStore(run().projectId).read();
      return new Set(list(items).filter((t) => isObj(t) && !t.done).map((t) => shape(t.text)));
    } catch {
      return new Set();
    }
  }

  /** Files the cards no open card already holds. @returns {number} how many were filed */
  function fileNew(label, cards) {
    const open = openTexts();
    const fresh = [];
    for (const card of list(cards).filter((c) => isObj(c) && typeof c.text === 'string' && c.text)) {
      if (open.has(shape(card.text))) continue;
      open.add(shape(card.text));
      fresh.push({ ...card, updatesCardId: null, splitsCardId: null });
    }
    if (!fresh.length) return 0;
    const r = run();
    const ats = cardBook.fileCards(r.projectId, r.id, fresh);
    if (ats.length < fresh.length) note(`${label}: ${fresh.length - ats.length} card(s) not filed`);
    if (ats.length) logEvent(`${label}: ${ats.length} card(s) filed`);
    return ats.length;
  }

  const notesOf = (res) => list(res.notes).filter((n) => typeof n === 'string' && n);

  // ---- after a merge ----

  async function refreshGraph() {
    if (typeof deps.refreshGraph !== 'function') return;
    const res = await guarded('graph refresh', () => deps.refreshGraph(base()));
    if (res === FAILED) return;
    if (!isObj(res)) {
      note('graph refresh failed: no result');
      return;
    }
    for (const n of notesOf(res)) note(n);
    if (res.ok === false && !notesOf(res).length) note('graph refresh failed');
    if (res.ok !== false) logEvent(`code graph refreshed${res.committed ? ', codemaps committed' : ''}`);
  }

  async function i18nCheck() {
    if (typeof deps.i18n !== 'function') return;
    const res = await guarded('i18n check', () => deps.i18n(base()));
    if (res === FAILED || !isObj(res)) return;
    for (const n of notesOf(res)) note(n);
    // Only the one missing-keys card (a bug); the hard-coded-strings heuristic stays out of the loop.
    fileNew('i18n', list(res.cards).filter((c) => isObj(c) && c.kind === 'bug').slice(0, 1));
  }

  /** After a merged build: graph + codemaps, then the i18n card. */
  function afterMerge(build) {
    return safely('after-merge hooks', async () => {
      if (!isObj(build) || build.selfCheck !== 'green' || build.skipped) return;
      if (!isDone('refreshed')) {
        await refreshGraph();
        markDone('refreshed');
      }
      if (!isDone('i18n')) {
        await i18nCheck();
        markDone('i18n');
      }
    });
  }

  // ---- after launch ----

  /** The newest Lighthouse entry of an earlier iteration that stayed on main (green, not rolled back). */
  function lastGreen(r) {
    const green = new Set(list(r.history).filter((h) => h.selfCheck === 'green' && !h.rolledBack).map((h) => h.n));
    return [...list(r.lighthouse)].reverse().find((e) => e.iteration < r.iteration && green.has(e.iteration)) || null;
  }

  async function lighthouse(url) {
    const r = run();
    const res = await guarded('lighthouse', () => deps.lighthouse({ ...base(), projectId: r.projectId, url, evidenceDir: r.evidenceDir }));
    if (res === FAILED || !isObj(res)) return;
    for (const n of notesOf(res)) note(n);
    const results = list(res.results);
    if (!results.length) return;
    const now = run();
    update({ lighthouse: [...appendResult(now.lighthouse, now.iteration, results)] });
    logEvent(`lighthouse: ${results.length} result(s) kept`);
    const budget = budgetCards({ results, lastGreen: lastGreen(now), budgets: res.budgets, runId: now.id });
    if (budget.errors.length) note(`lighthouse budgets not checked: ${budget.errors[0].code}`);
    fileNew('lighthouse', budget.cards);
  }

  /** With the app up: Lighthouse once per iteration. */
  function afterLaunch(url) {
    return safely('lighthouse', async () => {
      if (typeof deps.lighthouse !== 'function' || run().iteration < 1 || isDone('lighthouse')) return;
      await lighthouse(url);
      markDone('lighthouse');
    });
  }

  // ---- after the Critic ----

  async function reviews(isGate) {
    if (typeof deps.reviews !== 'function') return;
    const res = await guarded('reviews', () => deps.reviews({ ...base(), isGate }));
    if (res === FAILED || !isObj(res)) return;
    for (const n of notesOf(res)) note(n);
    fileNew('reviews', res.cards);
  }

  /** The Critic's call with the gate closed: no milestone pass, no SHIP. */
  const heldCritic = (critic) => ({
    ...critic,
    verdict: 'continue',
    allPassed: false,
    milestone: isObj(critic.milestone) ? { ...critic.milestone, passed: false } : critic.milestone,
  });

  function holdGate(critic, second, disagreement) {
    const r = run();
    const milestone = (isObj(critic.milestone) && critic.milestone.name) || r.milestone || 'current';
    const blocking = list(disagreement.second && disagreement.second.blocking).slice(0, 3).join('; ');
    const detail = disagreement.reason === 'verdict'
      ? `Critic: ${critic.verdict}, ${second.cli}: ${second.verdict}`
      : `${second.cli} files blocking findings: ${blocking}`;
    const asked = ask({
      kind: 'other',
      question: `The second opinion (${second.cli}) disagrees with the Critic at the ${milestone} gate. Open the gate anyway?`,
      detail,
      options: [APPROVE, REJECT],
      // Losing nothing: the gate stays closed and the next Critic judges again.
      defaultAnswer: REJECT,
    });
    const decisionId = asked && asked.ok ? asked.id : null;
    update({ gateHold: { milestone, next: critic.next || null, n: r.iteration, reason: disagreement.reason, cli: second.cli, decisionId } });
    note(`gate ${milestone} held: the second opinion (${second.cli}) disagrees (${disagreement.reason})`
      + ` - the next Critic${decisionId !== null ? ` or decision ${decisionId}` : ''} resolves it`);
    return heldCritic(critic);
  }

  async function secondOpinion(critic, criticCards) {
    if (typeof deps.secondOpinion !== 'function') return critic;
    const r = run();
    const res = await guarded('second opinion', () => deps.secondOpinion({
      ...base(),
      isGate: true,
      report: r.current.report,
      allPassed: critic.allPassed === true,
    }));
    // null: no CLI order set - the second opinion is off.
    if (res === FAILED || !isObj(res)) return critic;
    if (res.skipped) {
      note(res.note || 'second opinion skipped');
      return critic;
    }
    for (const n of notesOf(res)) note(n);
    if (res.ok !== true) return critic;
    fileNew('second opinion', mergeFindings(criticCards, res.cards).filter((c) => c.source === SECOND_OPINION_SOURCE));
    const verdict = gateVerdict({ passed: isGateOf(critic), verdict: critic.verdict }, res);
    if (!verdict.disagreement) {
      logEvent(`second opinion (${res.cli}) agrees at the gate`);
      return critic;
    }
    return holdGate(critic, res, verdict.disagreement);
  }

  /** The next Critic after a held gate: its call stands. */
  function resolveHold(critic) {
    const hold = run().gateHold;
    update({ gateHold: null });
    note(`gate ${hold.milestone} hold resolved by the Critic: ${isGateOf(critic) ? 'passed' : 'still closed'}`);
    return critic;
  }

  /**
   * After the Critic (saved already): reviews, then the second opinion at a
   * gate. Returns the Critic's call as the gate stands, saved with the hooks done.
   * @param {object} critic the cleaned Critic record
   * @param {object[]} [criticCards] the cards the Critic filed this pass (their texts)
   * @returns {Promise<object>}
   */
  function afterCritic(critic, criticCards = []) {
    return safely('after-Critic hooks', async () => {
      await reviews(isGateOf(critic));
      let judged = critic;
      const hold = run().gateHold;
      // Held on this very iteration (a restart after the hold was saved): it stays held.
      if (hold && hold.n === run().iteration) judged = heldCritic(critic);
      else if (hold) judged = resolveHold(critic);
      else if (isGateOf(critic)) judged = await secondOpinion(critic, list(criticCards));
      const c = run().current;
      update({ current: { ...c, critic: judged, hooks: { ...(isObj(c.hooks) ? c.hooks : {}), reviewed: true } } });
      return judged;
    }, critic);
  }

  /** Mati's answer (or the default) to a held gate's decision. Never throws into answer(). */
  function onAnswered(answered) {
    try {
      settleHold(answered);
    } catch (err) {
      try {
        logEvent(`gate decision not applied: ${errText(err).slice(0, 200)}`);
      } catch {
        // ignored on purpose: the log line is best effort
      }
    }
  }

  function settleHold(answered) {
    const r = run();
    const hold = r && r.gateHold;
    if (!hold || hold.decisionId === null) return;
    const d = list(answered).find((a) => isObj(a) && a.id === hold.decisionId);
    if (!d) return;
    if (d.answer !== APPROVE) {
      logEvent(`gate ${hold.milestone} stays closed (decision ${d.id}): the next Critic judges it again`);
      update({ gateHold: null });
      return;
    }
    if (r.phase === 'critiquing' && hold.n === r.iteration) {
      // The iteration that held the gate is still ending: it opens the gate itself.
      logEvent(`gate ${hold.milestone} opened by decision ${d.id} - as this iteration ends`);
      update({ gateHold: { ...hold, approved: true } });
      return;
    }
    logEvent(`gate ${hold.milestone} opened by decision ${d.id}`);
    update({ gateHold: null, ...(hold.next ? { milestone: hold.next } : {}) });
    onGateOpened(hold.milestone);
  }

  /**
   * The Critic's call as the iteration ends: a gate Mati opened meanwhile
   * passes (the controller then moves on and sends the milestone email).
   * @param {object} critic
   * @returns {object}
   */
  function withApproval(critic) {
    const hold = run().gateHold;
    if (!hold || hold.approved !== true || hold.n !== run().iteration || !isObj(critic.milestone)) return critic;
    update({ gateHold: null });
    return { ...critic, milestone: { ...critic.milestone, passed: true } };
  }

  // ---- at a passed gate ----

  /** The iteration of the run's previous passed gate (its git log starts there), or null. */
  function previousGate() {
    const r = run();
    const gates = list(r.laps).filter((l) => isObj(l) && l.gate === true && l.n < r.iteration);
    return gates.length ? gates[gates.length - 1].n : null;
  }

  /**
   * LW 2.16: the project-skills pass, ONLY at a passed milestone gate that
   * stays on main (not rolled back), once per iteration.
   * @param {object} critic the Critic's call as the iteration ends (withApproval applied)
   * @param {{rolledBack?:boolean, milestone?:string|null}} [opts]
   */
  function atGate(critic, opts = {}) {
    return safely('project skills', async () => {
      if (typeof deps.skills !== 'function' || !isGateOf(critic) || opts.rolledBack === true || isDone('skills')) return;
      const r = run();
      const res = await guarded('project skills', () => deps.skills({
        ...base(),
        isGate: true,
        milestone: opts.milestone || (isObj(critic.milestone) ? critic.milestone.name : null) || r.milestone || null,
        models: r.models,
        sinceIteration: previousGate(),
      }));
      if (res !== FAILED && isObj(res)) {
        for (const n of notesOf(res)) note(n);
        if (res.committed) logEvent('project skills committed - they reach origin with the next merge');
      }
      markDone('skills');
    });
  }

  return { afterMerge, afterLaunch, afterCritic, onAnswered, withApproval, atGate };
}

module.exports = { createLoopHooks, isGateOf };
