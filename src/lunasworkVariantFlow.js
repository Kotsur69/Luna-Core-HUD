// ============================================================================
// LunaCore - Luna's Work design variants, the controller side (LW 2.25a)
// ----------------------------------------------------------------------------
// The run's half of the 'Design variants' toggle (pure parts in
// src/lunasworkVariants.js). With the toggle off nothing here does anything:
// the Director makes no variant cards, so no screen is ever ready.
//
//   targetsFrom(director)  the Director's ready screens (autoCards.variants)
//                          not asked about yet -> run.current.variantTargets,
//                          which the explore pass screenshots
//   afterPlaytest(report)  a screen with two or more variant screenshots goes
//                          to the decision queue (default: the Critic picks,
//                          deadline lunasworkVariants.VARIANT_DEADLINE_MS) and
//                          into run.variants; the milestone email shows it
//   settle()               at the start of every iteration: an answered choice
//                          is applied - Mati's letter, or the Critic's pick
//                          (deps.pickVariant) when the default was taken; its
//                          reason goes to DECISIONS.md and one cleanup card
//                          removes the losing variants and the switch
//
// Never throws past the controller: a failed pick keeps the first variant.
// ============================================================================

'use strict';

const variants = require('./lunasworkVariants');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {{deps:object, run:()=>object, update:(fields:object)=>void, logEvent:(text:string)=>void,
 *   cardBook:{fileCards:Function}, ask:(spec:object)=>{ok:boolean, id?:number},
 *   writeDecisionLine:(line:string, decision:object, label:string)=>boolean, now:()=>number}} ctx
 *   deps.pickVariant?(opts) -> Promise<{variant, reason}> (lunasworkVariants.runCriticPick)
 */
function createVariantFlow(ctx) {
  const { deps, run, update, logEvent, cardBook } = ctx;
  const entries = () => (Array.isArray(run().variants) ? run().variants : []);
  const known = (slug) => entries().some((e) => e.slug === slug);

  /** The ready screens of a Director result that have no choice under way. */
  function targetsFrom(director) {
    const auto = isObj(director) && isObj(director.autoCards) ? director.autoCards.variants : null;
    const ready = isObj(auto) ? variants.cleanTargets(auto.ready) : [];
    return ready.filter((t) => !known(t.slug));
  }

  /** The playtest's variant screenshots -> one decision per screen. */
  function afterPlaytest(report) {
    const targets = Array.isArray(run().current.variantTargets) ? run().current.variantTargets : [];
    const shots = isObj(report) && Array.isArray(report.variantShots) ? report.variantShots : [];
    for (const t of targets) {
      const mine = shots.filter((s) => s.slug === t.slug);
      if (known(t.slug)) continue;
      if (mine.length < 2) {
        logEvent(`design variants of "${t.screen}": ${mine.length} screenshot(s), asked again next iteration`);
        continue;
      }
      const asked = ctx.ask(variants.variantDecision({ screen: t.screen, shots: mine }));
      if (!asked.ok) {
        logEvent(`design variants of "${t.screen}": the decision could not be queued`);
        continue;
      }
      const entry = {
        slug: t.slug, screen: t.screen, route: t.route, n: run().iteration, decisionId: asked.id,
        shots: mine.map((s) => ({ variant: s.variant, screenshot: s.screenshot })), status: 'asked',
        choice: null, by: null, reason: null, cleanupAt: null,
      };
      update({ variants: variants.cleanVariants([...entries(), entry]) });
      logEvent(`design variants of "${t.screen}": choice asked (decision ${asked.id})`);
    }
  }

  /** The Critic's pick at the deadline; never rejects. */
  async function criticPick(entry) {
    if (typeof deps.pickVariant !== 'function') {
      return { variant: entry.shots[0].variant, reason: 'no Critic pick configured - the first variant kept' };
    }
    try {
      const res = await deps.pickVariant({ repoDir: run().repoPath, screen: entry.screen, shots: entry.shots, model: run().models.critic });
      if (isObj(res) && entry.shots.some((s) => s.variant === res.variant)) return res;
      return { variant: entry.shots[0].variant, reason: 'the Critic gave no usable pick - the first variant kept' };
    } catch (err) {
      return { variant: entry.shots[0].variant, reason: `the Critic pick failed (${errText(err).slice(0, 100)}) - the first variant kept` };
    }
  }

  /** One answered choice -> the DECISIONS.md line and the cleanup card. */
  async function apply(entry, decision) {
    const letter = variants.VARIANT_LETTERS.includes(decision.answer) ? decision.answer : null;
    const pick = letter ? { variant: letter, reason: null } : await criticPick(entry);
    const by = letter ? 'mati' : 'critic';
    const at = ctx.now();
    const line = variants.pickLine({
      screen: entry.screen, choice: pick.variant, by, reason: pick.reason, at, afterDeadline: decision.answeredBy === 'default',
    });
    ctx.writeDecisionLine(line, { kind: 'designVariant', id: decision.id }, `design variants of "${entry.screen}"`);
    const ats = cardBook.fileCards(run().projectId, run().id, [variants.cleanupCard({ ...entry, choice: pick.variant })]);
    if (!ats.length) logEvent(`design variants of "${entry.screen}": the cleanup card could not be filed`);
    logEvent(`design variants of "${entry.screen}": variant ${pick.variant} kept (${by === 'mati' ? 'Mati' : 'the Critic'})`);
    return { ...entry, status: 'chosen', choice: pick.variant, by, reason: pick.reason, cleanupAt: ats[0] || null };
  }

  /** Applies every choice that was answered (by Mati, or by its default at the deadline). */
  async function settle() {
    for (const entry of entries().filter((e) => e.status === 'asked')) {
      const decision = run().decisions.find((d) => d.id === entry.decisionId);
      // A decision trimmed from the queue was answered long ago: the Critic picks.
      const answered = decision ? decision.status === 'answered' : true;
      if (!answered) continue;
      const done = await apply(entry, decision || { id: entry.decisionId, answer: variants.CRITIC_PICK, answeredBy: 'default' });
      update({ variants: entries().map((e) => (e.slug === done.slug ? done : e)) });
    }
  }

  return { targetsFrom, afterPlaytest, settle };
}

module.exports = { createVariantFlow };
