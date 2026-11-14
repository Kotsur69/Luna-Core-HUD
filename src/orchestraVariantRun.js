// ============================================================================
// LunaCore - God Mode A/B parallel builds, run side (rules: orchestraVariants.js)
// ----------------------------------------------------------------------------
// Parks a verified variant, decides its group once both variants are done
// (the critic picks / only one was built / neither was), lets the group
// adopt the winner and finish it like any package, and cleans up the loser:
// tab closed, worktree removed, branch kept and named in the report.
// Every effect goes through injected deps; nothing here touches git itself.
// ============================================================================

'use strict';

const ab = require('./orchestraVariants');

// A closed tab's process may still hold files for a moment (orchestraFinalize).
const LOSER_CLEANUP_DELAY_MS = 3000;

/**
 * @param {{
 *   getPlan: () => object|null, findPkg: (id:string) => object|null,
 *   patch: (id:string, fields:object) => void, record: (id:string, entry:object) => void,
 *   commit: () => void, removePackages: (ids:string[]) => void,
 *   finishGroup: (id:string) => void, stallGroup: (id:string, reason:string, detail:string) => void,
 *   runReview: Function|null, reviewDiff: Function|null, reviewEnv: () => object|null,
 *   repoPath: () => string, closeSession: (id:string) => void, sessionAlive: (id:string) => boolean,
 *   removeWorktree: Function|null, setTimer: Function, now: () => number,
 *   onEvent?: (kind:string, data:object) => void, log?: (line:string) => void,
 * }} deps
 *   finishGroup: the group's finish (secret scan, push) once it adopted its winner;
 *   stallGroup: the group stalls terminal, with no automatic resume (it has no worktree)
 */
function createVariantRunner(deps) {
  const log = deps.log || (() => {});
  const onEvent = deps.onEvent || (() => {});
  /** groupId -> token of the critic call in flight (a kill drops them all) */
  const deciding = new Map();
  let seq = 0;

  const livePlan = () => {
    const plan = deps.getPlan();
    return plan && !plan.killed ? plan : null;
  };
  // Paused at the usage limit or held: nothing is decided (the critic would
  // hit the limit too); the pump decides once the run goes on.
  const decidingPlan = () => {
    const plan = livePlan();
    return plan && !plan.pausedUntil && !plan.hold ? plan : null;
  };

  /**
   * A variant's finish succeeded: it parks (state stays 'finishing') instead of pushing.
   * @returns {boolean} false for a package that is no A/B variant
   */
  function onBuilt(id, res) {
    const pkg = deps.findPkg(id);
    if (!pkg || !pkg.abOf) return false;
    const plan = deps.getPlan();
    // Finished after a kill: it stops with the run, its build kept (a Retry parks it again).
    const stopped = !!(plan && plan.killed);
    deps.patch(id, { abBuilt: { headSha: (res && res.headSha) || null, at: deps.now() }, ...(stopped ? { state: 'killed' } : {}) });
    deps.record(id, { at: deps.now(), kind: 'ab', reason: 'abBuilt', detail: `variant ${pkg.abKey.toUpperCase()} verified` });
    onEvent('abBuilt', { id, group: pkg.abOf });
    evaluate(pkg.abOf);
    return true;
  }

  /** Decides every group whose variants are done (the pump calls this). */
  function evaluateAll() {
    const plan = livePlan();
    if (!plan) return;
    for (const g of plan.packages.filter(ab.isUndecidedGroup)) evaluate(g.id);
  }

  function evaluate(groupId) {
    const plan = decidingPlan();
    if (!plan || deciding.has(groupId)) return;
    const group = deps.findPkg(groupId);
    const d = ab.groupDecision(group, plan.packages);
    if (!d || d.kind === 'wait') return;
    if (d.kind === 'none') {
      const detail = d.variants.map((x) => `${x.abKey.toUpperCase()}: ${x.error || x.state}`).join('; ');
      log(`[ab] ${groupId}: neither variant was built (${detail})`);
      deps.stallGroup(groupId, 'abBothFailed', detail);
      return;
    }
    if (d.kind === 'only') {
      adopt(groupId, d.winner.id, d.loser ? d.loser.id : null, { by: 'only', reasons: [] });
      return;
    }
    startCritic(group, d.built);
  }

  function startCritic(group, built) {
    seq += 1;
    const token = seq;
    deciding.set(group.id, token);
    onEvent('abReview', { id: group.id });
    deps.commit();
    const ids = built.map((b) => b.id);
    critic(group, built)
      .catch((err) => ({ ok: false, error: 'failed', detail: err instanceof Error ? err.message : String(err) }))
      .then((res) => onVerdict(group.id, ids, token, res));
  }

  /** The variant's own approach: its prompt after the shared task. */
  const approachOf = (variant, group) =>
    variant.prompt.startsWith(group.prompt) ? variant.prompt.slice(group.prompt.length).trim() : variant.prompt;

  async function critic(group, built) {
    if (!deps.runReview) return { ok: false, error: 'noReview' };
    // Never the main checkout: the folder of both worktrees (orchestraVariants.criticCwd).
    const cwd = ab.criticCwd(built);
    if (!cwd) return { ok: false, error: 'noWorktree' };
    const variants = await Promise.all(
      built.map(async (b) => {
        const head = b.abBuilt && b.abBuilt.headSha;
        const diff = deps.reviewDiff && b.baseSha && head ? await deps.reviewDiff({ cwd: b.root, from: b.baseSha, to: head }) : null;
        const ok = !!(diff && diff.ok);
        return { key: b.abKey, label: b.abLabel, approach: approachOf(b, group), verify: 'passed', stat: ok ? diff.stat : '', diff: ok ? diff.diff : '' };
      }),
    );
    const prompt = ab.buildCriticPrompt({ id: group.id, title: group.title, prompt: group.prompt, verify: group.verify, variants });
    return deps.runReview({ cwd, env: deps.reviewEnv(), prompt, schema: ab.CRITIC_SCHEMA, validate: ab.validateChoice });
  }

  function onVerdict(groupId, builtIds, token, res) {
    // Dropped meanwhile (a kill, a new plan): the answer is not used.
    if (deciding.get(groupId) !== token) return;
    deciding.delete(groupId);
    const plan = livePlan();
    const d = plan ? ab.groupDecision(deps.findPkg(groupId), plan.packages) : null;
    if (!d) return;
    // Something changed during the review (a variant retried): decide again.
    if (d.kind !== 'critic' || d.built.map((b) => b.id).join() !== builtIds.join()) {
      evaluate(groupId);
      return;
    }
    const pick = res && res.ok && ab.VARIANT_KEYS.includes(res.choice) ? res.choice : null;
    // No usable answer: the planner's first approach is kept, and the report says why.
    const winner = d.built.find((b) => b.abKey === (pick || ab.VARIANT_KEYS[0]));
    const loser = d.built.find((b) => b !== winner);
    const verdict = pick
      ? { by: 'critic', reasons: Array.isArray(res.reasons) ? res.reasons : [] }
      : { by: 'fallback', reasons: [`critic unavailable (${(res && res.error) || 'failed'}), variant A kept`] };
    adopt(groupId, winner.id, loser.id, verdict);
  }

  function loserRecord(loser) {
    const head = (loser.abBuilt && loser.abBuilt.headSha) || loser.headSha || null;
    return { key: loser.abKey, label: loser.abLabel, branch: loser.branch || null, headSha: head, outcome: loser.abBuilt ? 'lost' : loser.error || loser.state, removed: false };
  }

  /** The group takes over the winner's worktree, branch and tab, then finishes. */
  function adopt(groupId, winnerId, loserId, verdict) {
    const group = deps.findPkg(groupId);
    const winner = deps.findPkg(winnerId);
    const loser = loserId ? deps.findPkg(loserId) : null;
    if (!group || !winner) return;
    deps.patch(groupId, {
      ...ab.adoptedFields(winner),
      state: 'launched',
      error: null,
      detail: null,
      terminal: false,
      stalledAt: null,
      ab: { ...group.ab, winner: winner.abKey, by: verdict.by, decidedAt: deps.now(), reasons: verdict.reasons, losers: loser ? [loserRecord(loser)] : [] },
    });
    deps.record(groupId, { at: deps.now(), kind: 'ab', reason: 'abWinner', detail: `${winner.abKey.toUpperCase()} won (${verdict.by})` });
    deps.removePackages([winnerId, ...(loser ? [loserId] : [])]);
    log(`[ab] ${groupId}: variant ${winner.abKey.toUpperCase()} won (${verdict.by})`);
    onEvent('abDecided', { id: groupId, winner: winner.abKey, by: verdict.by });
    if (loser) cleanupLoser(groupId, loser, winner);
    deps.commit();
    deps.finishGroup(groupId);
  }

  /**
   * Tab closed; worktree removed after a short settle (a dirty one is kept);
   * branch kept. Only a worktree beside the winner's is ever removed, and only
   * while this plan is still the run's: repo and plan are pinned now.
   */
  function cleanupLoser(groupId, loser, winner) {
    if (loser.sessionId && deps.sessionAlive(loser.sessionId)) deps.closeSession(loser.sessionId);
    if (!loser.root || !deps.removeWorktree) return;
    if (!ab.isSiblingRoot(loser.root, winner.root)) {
      log(`[ab] ${groupId}: the losing variant ${loser.abKey.toUpperCase()}'s worktree was kept: not beside the winner's`);
      return;
    }
    const plan = deps.getPlan();
    const planId = plan ? plan.id : null;
    const repo = deps.repoPath();
    const timer = deps.setTimer(() => {
      const current = deps.getPlan();
      if (!current || current.id !== planId) return;
      Promise.resolve()
        .then(() => deps.removeWorktree(repo, loser.root))
        .then(
          (res) => markRemoved(groupId, loser.abKey, !!(res && res.ok), res && res.error),
          (err) => markRemoved(groupId, loser.abKey, false, err instanceof Error ? err.message : String(err)),
        );
    }, LOSER_CLEANUP_DELAY_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function markRemoved(groupId, key, ok, error) {
    if (!ok) {
      log(`[ab] ${groupId}: the losing variant ${key.toUpperCase()}'s worktree was kept: ${error || 'gitFailed'}`);
      return;
    }
    const group = deps.findPkg(groupId);
    if (!group || !group.ab) return;
    const losers = (group.ab.losers || []).map((l) => (l.key === key ? { ...l, removed: true } : l));
    deps.patch(groupId, { ab: { ...group.ab, losers } });
    deps.commit();
  }

  /** Kill: critic answers are dropped, parked variants stop with the run (abBuilt kept). */
  function onKill() {
    deciding.clear();
    const plan = deps.getPlan();
    if (!plan) return;
    for (const p of plan.packages.filter(ab.isParked)) deps.patch(p.id, { state: 'killed' });
  }

  return {
    onBuilt,
    evaluateAll,
    onKill,
    cancelAll: () => deciding.clear(),
    /** A critic call in flight keeps the run from settling. */
    busy: () => deciding.size > 0,
    /** The board's / report's view of a package's A/B role, or null. */
    view(pkg) {
      if (pkg && pkg.ab) {
        return { role: 'group', ...pkg.ab, reviewing: deciding.has(pkg.id) };
      }
      if (pkg && pkg.abOf) return { role: 'variant', of: pkg.abOf, key: pkg.abKey, label: pkg.abLabel || '', built: !!pkg.abBuilt };
      return null;
    },
  };
}

const cell = (v) => String(v == null ? '' : v).replace(/[|\r\n]+/g, ' ').trim();

/**
 * The report's A/B section: per group the winner, how it was picked and the
 * loser (its branch is kept). [] for a run without A/B groups.
 * @param {{packages?:Array<{id:string, ab?:object|null}>}} view orchestra view()
 * @returns {string[]} markdown lines
 */
function abReportLines(view) {
  const groups = (view && Array.isArray(view.packages) ? view.packages : []).filter((p) => p && p.ab && p.ab.role === 'group');
  if (!groups.length) return [];
  const label = (vs, key) => {
    const v = (vs || []).find((x) => x.key === key);
    return `${String(key).toUpperCase()}: ${cell(v && v.label)}`;
  };
  const rows = groups.map((g) => {
    const a = g.ab;
    if (!a.winner) return `| \`${cell(g.id)}\` | - | not decided (${cell(g.error || g.state)}) | - | - |`;
    const why = [a.by, ...(a.reasons || []).slice(0, 2)].map(cell).join(': ');
    const loser = (a.losers || [])[0];
    const lost = loser ? `${label(a.variants, loser.key)} (${cell(loser.outcome)})` : '-';
    const branch = loser && loser.branch ? `\`${cell(loser.branch)}\`${loser.removed ? ', worktree removed' : ', worktree kept'}` : '-';
    return `| \`${cell(g.id)}\` | ${label(a.variants, a.winner)} | ${why} | ${lost} | ${branch} |`;
  });
  return ['', '## A/B builds', '', '| Package | Winner | Picked by | Loser | Loser branch (kept) |', '|---|---|---|---|---|', ...rows];
}

module.exports = { LOSER_CLEANUP_DELAY_MS, createVariantRunner, abReportLines };
