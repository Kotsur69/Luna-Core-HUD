// ============================================================================
// LunaCore - which memories a God Mode package's brief carried, and how the
// package ended (main)
// ----------------------------------------------------------------------------
// docs/tbc_docs/RAG_STYLE_MEMORY_PLAN.md, phase 7 lite. A worker's brief gets
// a "## Project memory" section (src/memoryinject.js). orchestra.js keeps the
// keys of the memories it showed on the package (`briefMemory`), so they
// survive a restart with the rest of the run. When the run settles, the
// finalizer (src/orchestraFinalize.js) logs one `brief-outcome` line per
// package into the memory log (src/memorylog.js):
//
//   clean    pushed with no stall, retry, fix-up or red verify on the way
//   retried  pushed, but only after one of those
//   stalled  stopped and waiting for Mati
//   failed   failed for good
//
// A package closed or killed by hand says nothing about its memories and is
// not logged. A package is logged again only when its outcome changed (a
// Retry after the run settled); src/memoryuse.js counts the latest line of a
// package. Memories that keep going into failed packages are flagged for
// review (src/memoryreview.js 'failing').
//
// Pure functions: orchestra.js and the finalizer own the state.
// ============================================================================

'use strict';

const { splitKey, projectFromRepoKey } = require('./memoryrecord');
const { BRIEF_OUTCOMES, MAX_BRIEF_KEYS } = require('./memorylog');

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * A package's brief memory from untrusted input (a stored run, the injector's answer), or null.
 * @param {unknown} raw {project, keys}
 * @returns {{project: string, keys: string[]}|null}
 */
function normalizeBriefMemory(raw) {
  if (!isObject(raw) || typeof raw.project !== 'string') return null;
  const project = projectFromRepoKey(raw.project);
  if (!project || project !== raw.project) return null;
  const keys = Array.isArray(raw.keys) ? [...new Set(raw.keys.filter((k) => typeof k === 'string' && splitKey(k)))].slice(0, MAX_BRIEF_KEYS) : [];
  return keys.length ? { project, keys } : null;
}

/**
 * What deps.projectMemory answered, split: the section text for the brief and
 * the memories it shows. A plain string (an older injector, a test) carries no keys.
 * @param {unknown} res a string, or {text, keys, project}
 * @returns {{text: string|null, briefMemory: {project: string, keys: string[]}|null}}
 */
function readInjection(res) {
  if (typeof res === 'string') return { text: res || null, briefMemory: null };
  if (!isObject(res)) return { text: null, briefMemory: null };
  const text = typeof res.text === 'string' && res.text ? res.text : null;
  return { text, briefMemory: text ? normalizeBriefMemory({ project: res.project, keys: res.keys }) : null };
}

/**
 * The package's brief memory after one more brief: the keys of every brief it
 * got (a resume may show others), newest last, capped. Another project
 * replaces it.
 * @param {unknown} prev the package's stored briefMemory
 * @param {{project: string, keys: string[]}} next
 * @returns {{project: string, keys: string[]}}
 */
function withInjected(prev, next) {
  const old = normalizeBriefMemory(prev);
  if (!old || old.project !== next.project) return next;
  const keys = [...new Set([...old.keys, ...next.keys])];
  return { project: next.project, keys: keys.slice(-MAX_BRIEF_KEYS) };
}

/**
 * The package fields after one more brief (orchestra.js projectMemoryFor):
 * the merged brief memory, and a cleared `briefOutcome` when the memories
 * changed, so the next settle logs a line that names all of them.
 * @param {unknown} prev the package's stored briefMemory
 * @param {{project: string, keys: string[]}} next
 * @returns {{briefMemory: object, briefOutcome?: null}}
 */
function injectedFields(prev, next) {
  const merged = withInjected(prev, next);
  const old = normalizeBriefMemory(prev);
  const same = old && old.project === merged.project && old.keys.length === merged.keys.length && old.keys.every((k, i) => k === merged.keys[i]);
  return same ? { briefMemory: merged } : { briefMemory: merged, briefOutcome: null };
}

/**
 * How a package ended, for the memories of its brief.
 * @param {{state: string, stalls?: number, autoRetries?: number, verifyRounds?: number, stallHistory?: object[]}} pkg
 * @returns {'clean'|'retried'|'stalled'|'failed'|null} null = not settled, or closed / killed by hand
 */
function briefOutcomeOf(pkg) {
  if (!isObject(pkg)) return null;
  if (pkg.state === 'failed' || pkg.state === 'stalled') return pkg.state;
  if (pkg.state !== 'pushed') return null;
  const history = Array.isArray(pkg.stallHistory) ? pkg.stallHistory : [];
  const bumpy = (pkg.stalls || 0) > 0 || (pkg.autoRetries || 0) > 0 || (pkg.verifyRounds || 0) > 0 || history.length > 0;
  return bumpy ? 'retried' : 'clean';
}

/**
 * The `brief-outcome` lines a settled run still owes the memory log: one per
 * package with brief memories whose outcome is new or changed since it was
 * last logged (`briefOutcome` on the package). A pushed package the
 * integration did not land (`held`: skipped at its merge verify, or the
 * whole pass failed) is not logged yet: its push alone is not a clean pass.
 * @param {{id: string, packages: object[]}} plan
 * @param {{held?: Set<string>}} [opts] held = ids of pushed packages to leave for a later pass
 * @returns {{pkgId: string, outcome: string, event: object}[]} event = a memorylog add() argument
 */
function briefOutcomeUpdates(plan, { held = new Set() } = {}) {
  const packages = plan && Array.isArray(plan.packages) ? plan.packages : [];
  const out = [];
  for (const pkg of packages) {
    const memory = isObject(pkg) ? normalizeBriefMemory(pkg.briefMemory) : null;
    const outcome = memory ? briefOutcomeOf(pkg) : null;
    if (!outcome || pkg.briefOutcome === outcome) continue;
    if (pkg.state === 'pushed' && held.has(pkg.id)) continue;
    out.push({
      pkgId: pkg.id,
      outcome,
      event: { ev: 'brief-outcome', project: memory.project, runId: plan.id, pkgId: pkg.id, keys: memory.keys, outcome },
    });
  }
  return out;
}

/**
 * Logs the lines a settled run owes (briefOutcomeUpdates) and marks each
 * logged package with its outcome, so a later pass logs only what changed.
 * A line the log refused (add() answered false) is tried again next pass.
 * @param {{id: string, packages: object[]}} plan
 * @param {{log: (event: object) => boolean|void, patch: (id: string, fields: object) => void, held?: Set<string>}} io
 *   held = pushed packages the integration did not land (briefOutcomeUpdates)
 * @returns {number} lines logged
 */
function logBriefOutcomes(plan, { log, patch, held }) {
  let logged = 0;
  for (const { pkgId, outcome, event } of briefOutcomeUpdates(plan, { held })) {
    if (log(event) === false) continue;
    patch(pkgId, { briefOutcome: outcome });
    logged += 1;
  }
  return logged;
}

/**
 * The brief memory fields of a stored package (orchestraSupervisor.normalizePackage):
 * none when it has no valid one.
 * @param {object} raw
 * @returns {{briefMemory?: object, briefOutcome?: string}}
 */
function storedBriefFields(raw) {
  const briefMemory = isObject(raw) ? normalizeBriefMemory(raw.briefMemory) : null;
  if (!briefMemory) return {};
  return { briefMemory, ...(BRIEF_OUTCOMES.includes(raw.briefOutcome) ? { briefOutcome: raw.briefOutcome } : {}) };
}

module.exports = {
  BRIEF_OUTCOMES,
  MAX_BRIEF_KEYS,
  normalizeBriefMemory,
  readInjection,
  withInjected,
  injectedFields,
  briefOutcomeOf,
  briefOutcomeUpdates,
  logBriefOutcomes,
  storedBriefFields,
};
