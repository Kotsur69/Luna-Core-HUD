// ============================================================================
// LunaCore - Luna's Work card rules in the run (docs/LUNAS_WORK_PLAN.md B1,
// #3, B4, B5, B9)
// ----------------------------------------------------------------------------
// The controller's side of the card rules, split out of src/lunaswork.js. The
// decisions themselves are pure (lunasworkRules.js); this module applies them
// to the run and the to-do store through the controller's own functions:
//
//   landedToBuilt   after the build: a landed `bug` card whose work changed
//                   no test file stays open with a note (#3); the rest are
//                   *built* (B1)
//   settleBuilt     after the Playtester: built cards close, reopen with the
//                   evidence, or stay built (B1); which cards failed the
//                   iteration (B4)
//   stuckNow / askAboutStuck / askAboutScope
//                   stuck cards for the Critic, and the decision-queue entries
//                   for what it did not split (B4) or what is out of scope (B5)
//   coreJourneys / quarantineFlaky
//                   the rollback's journey input without quarantined tests,
//                   and the same-code replay that finds flaky ones (B9)
//
// ctx.run() is read on every call: the controller replaces the run record,
// never edits it, so nothing here holds on to an old one.
// ============================================================================

'use strict';

const { bugTestVerdict, stuckOf, flakyTests, withoutQuarantined } = require('./lunasworkRules');
const { cardVerdicts } = require('./lunasworkChecks');
const { regressedJourneys, journeysPassedBefore } = require('./lunasworkCheckpoint');
const { landedFiles, cleanSmall, cleanReplay, VERIFY_KEYS } = require('./lunasworkRun');
const { CARD_CHOICES, heldCards } = require('./lunasworkDecisions');
const { BUILT_STATE } = require('./todorows');

const MAX_QUESTION_CHARS = 400;
const MAX_NAME_CHARS = 120;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** B9: the card a quarantined test gets. Critic card shape (lunasworkCritic.applyCards). */
function flakyCard(name, iteration) {
  const short = name.slice(0, MAX_NAME_CHARS);
  return {
    kind: 'bug',
    severity: 'medium',
    text: `Flaky test: "${short}" failed, then passed on the same code`,
    details: `The core journey "${name}" failed in iteration ${iteration}'s playtest and passed when it was replayed on the same code. It is quarantined for this run: it no longer triggers a rollback. Find why it is flaky (timing, data, order) and make it pass every time.`,
    acceptance: [`The "${short}" journey completes end to end at both widths`],
    files: [],
    updatesCardId: null,
  };
}

/**
 * @param {{run:()=>object, update:(fields:object)=>void, logEvent:(text:string)=>void,
 *   cardBook:object, ask:(spec:object)=>object, replayPass:()=>Promise<{ok:boolean, journeys:object[]}>}} ctx
 */
function createCardFlow(ctx) {
  const { cardBook, logEvent } = ctx;

  /**
   * B1 + #3, for the cards whose work landed. Iteration 0's scaffold cards
   * have no app to be played yet: they stay done.
   * @returns {{built:number[], noTest:number[]}}
   */
  function landedToBuilt(settled, cards, landed) {
    const run = ctx.run();
    if (run.iteration === 0) return { built: [], noTest: [] };
    const byAt = new Map(cards.map((c) => [c.at, c]));
    const noTest = [];
    for (const at of landed) {
      const verdict = bugTestVerdict(byAt.get(at), landedFiles(settled, byAt.get(at)));
      if (verdict.ok) continue;
      noTest.push(at);
      cardBook.reopen(run.projectId, [at], verdict.note);
    }
    if (noTest.length) logEvent(`${noTest.length} bug card(s) kept open: no test file changed`);
    const built = landed.filter((at) => !noTest.includes(at));
    cardBook.markBuilt(run.projectId, built);
    return { built, noTest };
  }

  /**
   * B1 after the Playtester's pass, then B4: this iteration's cards and the
   * reopened ones that are open now (not done, not built) failed the
   * iteration. Read back from the store, so a pass repeated after a restart
   * counts the same.
   * @param {object[]} built the built cards the pass was given
   * @param {{checks?:object[]}} report the cleaned playtest report
   * @returns {{closed:number[], reopened:number[], waiting:number[], failed:number[]}}
   */
  function settleBuilt(built, report) {
    const run = ctx.run();
    const verdicts = cardVerdicts(built, report.checks, run.iteration);
    cardBook.settle(run.projectId, verdicts);
    const ats = [...new Set([...run.current.cards.map((c) => c.at), ...built.map((c) => c.at)])];
    const cards = cardBook.lookup(run.projectId, ats);
    const of = (fn) => cards.filter(fn).map((c) => c.at);
    const verify = cleanSmall({
      closed: of((c) => c.done === true),
      reopened: verdicts.filter((v) => v.outcome === 'reopen').map((v) => v.at),
      waiting: of((c) => !c.done && c.state === BUILT_STATE),
      failed: of((c) => !c.done && c.state !== BUILT_STATE),
    }, VERIFY_KEYS);
    if (built.length) {
      logEvent(`${built.length} built card(s): ${verify.closed.length} confirmed in the app, ${verify.reopened.length} reopened, ${verify.waiting.length} still built`);
    }
    return verify;
  }

  /** B4: the stuck cards no decision holds. */
  function stuckNow() {
    const run = ctx.run();
    const held = heldCards(run.decisions);
    return stuckOf(Object.keys(run.failCounts).map(Number), run.failCounts).filter((at) => !held.has(at));
  }

  /** A card decision the controller asks itself (B4 stuck, B5 out of scope). */
  function askAboutCard(kind, at, question, detail) {
    const choice = CARD_CHOICES[kind];
    ctx.ask({
      question: question.slice(0, MAX_QUESTION_CHARS),
      detail,
      kind,
      options: [...choice.options],
      defaultAnswer: choice.defaultAnswer,
      cardIds: [at],
    });
  }

  /** B4: stuck cards the Critic did not split go to Mati, once per decision. */
  function askAboutStuck(ats) {
    const run = ctx.run();
    const held = heldCards(run.decisions);
    for (const card of cardBook.lookup(run.projectId, ats.filter((at) => !held.has(at)))) {
      askAboutCard('stuckCard', card.at, `Failed twice: ${card.text}`, 'approve = try it again; reject = park it for good');
    }
  }

  /** B5: the cards the Director left out as outside DESIGN.md / ROADMAP.md. */
  function askAboutScope(outOfScope) {
    for (const c of (Array.isArray(outOfScope) ? outOfScope : []).filter(isObj)) {
      const missing = Array.isArray(c.missing) && c.missing.length ? ` (not in the design: ${c.missing.slice(0, 8).join(', ')})` : '';
      askAboutCard('outOfScope', c.at, `Outside DESIGN.md / ROADMAP.md: ${String(c.text || '')}`, `approve = build it anyway${missing}`);
    }
  }

  /**
   * B9: the core journeys the rollback rules see - quarantined ones left
   * out. Broken = one that passed before fails now (regressed null: nothing
   * known about before, then every journey must pass).
   * @returns {{regressed:string[]|null, ok:boolean, failing:string[]}}
   */
  function coreJourneys(journeys, earlierRecords) {
    const run = ctx.run();
    const list = withoutQuarantined(journeys, run.quarantine);
    const regressed = regressedJourneys(list, journeysPassedBefore(run.laps, earlierRecords));
    const failing = regressed || list.filter((j) => isObj(j) && j.passed === false).map((j) => j.name);
    return { regressed, ok: failing.length === 0, failing };
  }

  /**
   * B9: replays the playtest on the same code (once per iteration, saved in
   * the run); a failing journey that passes now is quarantined for the run
   * and gets a card.
   * @param {object[]} journeys this iteration's journeys
   * @param {string[]} failing the names that would roll main back
   */
  async function quarantineFlaky(journeys, failing) {
    let replay = ctx.run().current.replay;
    if (!replay) {
      replay = cleanReplay(await ctx.replayPass()) || { ok: false, journeys: [] };
      ctx.update({ current: { ...ctx.run().current, replay } });
    }
    const run = ctx.run();
    const rev = `iter-${run.iteration}`;
    const seen = [...journeys, ...replay.journeys].filter(isObj).map((j) => ({ name: j.name, passed: j.passed === true, rev }));
    const known = new Set(run.quarantine.map((q) => q.name));
    const flaky = flakyTests(seen).filter((name) => failing.includes(name) && !known.has(name));
    if (!flaky.length) return;
    const ats = cardBook.fileCards(run.projectId, run.id, flaky.map((name) => flakyCard(name, run.iteration)));
    const entries = flaky.map((name, i) => ({ name, n: run.iteration, ...(Number.isFinite(ats[i]) ? { card: ats[i] } : {}) }));
    logEvent(`quarantined flaky test(s): ${flaky.map((n) => `"${n.slice(0, 80)}"`).join(', ')}`);
    ctx.update({ quarantine: [...run.quarantine, ...entries] });
  }

  return { landedToBuilt, settleBuilt, stuckNow, askAboutStuck, askAboutScope, coreJourneys, quarantineFlaky };
}

module.exports = { createCardFlow, flakyCard };
