// ============================================================================
// LunaCore - God Mode v2: the merge integration's second pass
// ----------------------------------------------------------------------------
// The first pass merges the packages in plan order and skips what will not
// go in. Some of that is only the ORDER: a package clashed with, or needed,
// something merged after it. So after the first pass, ONE second pass, in
// plan order: each package skipped at conflict / merge / verify is merged
// again onto the CURRENT integration branch (straight to the stronger
// resolver, with the merge fix-up for red tests). Once one goes in, every
// package depSkipped because of it is tried, in dependency order. No loops:
// what still fails keeps its final stage.
//
// Pure orchestration: all git / verify / worker IO comes in as `tryPackage`
// (orchestraIntegrate.js). Never throws.
// ============================================================================

'use strict';

// Stages worth a second try once the rest is merged. depSkipped packages are
// tried when what they wait on goes in; fetch / install / reset are not per
// package.
const RETRY_STAGES = new Set(['conflict', 'merge', 'verify']);
const MAX_DETAIL_CHARS = 300;
const MAX_FILES = 10;

const dependsOnOf = (pkg) => (Array.isArray(pkg.dependsOn) ? pkg.dependsOn : []);

/**
 * The first skipped package `pkg` depends on, directly or through another
 * package of this integration, or null.
 * @param {{dependsOn?:string[]}} pkg
 * @param {Map<string, string[]>} dependsOf id -> dependsOn of every package
 * @param {Set<string>} skippedIds
 * @returns {string|null}
 */
function skippedDependency(pkg, dependsOf, skippedIds) {
  const seen = new Set();
  const walk = (ids) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (skippedIds.has(id)) return id;
      const hit = walk(dependsOf.get(id) || []);
      if (hit) return id;
    }
    return null;
  };
  return walk(dependsOnOf(pkg));
}

/** One integration.skipped entry; `fixup` only when a fix-up was tried. */
function skipEntry(id, res) {
  const entry = {
    id,
    stage: res.stage,
    detail: String(res.detail || '').slice(0, MAX_DETAIL_CHARS),
    files: (res.files || []).slice(0, MAX_FILES),
  };
  return res.fixup ? { ...entry, fixup: res.fixup } : entry;
}

/** The skipped entries in plan order; a depSkipped one names what it waits on NOW. */
function finalSkipped(packages, entries, dependsOf) {
  const ids = new Set(entries.keys());
  return packages
    .filter((p) => entries.has(p.id))
    .map((p) => {
      const entry = entries.get(p.id);
      if (entry.stage !== 'depSkipped') return entry;
      return { ...entry, detail: skippedDependency(p, dependsOf, ids) || entry.detail };
    });
}

/**
 * @param {{packages:Array<{id:string, dependsOn?:string[]}>,
 *   skipped:Array<{id:string, stage:string, detail:string, files:string[]}>,
 *   tryPackage:(pkg:object, opts:{retry:boolean}) => Promise<{ok:true, fixedUp?:true}
 *     | {ok:false, stage:string, detail:string, files?:string[], fixup?:string, fatal?:string}>,
 *   stopped:() => boolean}} args tryPackage: merge + verify (+ fix-up), a
 *   failure reset away; `retry: true` goes straight to the stronger resolver;
 *   `fatal` when that reset failed. stopped: a killed / paused run starts
 *   nothing new.
 * @returns {Promise<{merged:string[], fixedUp:string[], skipped:object[],
 *   fatal?:{detail:string, failedId:string}}>}
 */
async function secondPass({ packages, skipped, tryPackage, stopped }) {
  const dependsOf = new Map(packages.map((p) => [p.id, dependsOnOf(p)]));
  const entries = new Map(skipped.map((s) => [s.id, s]));
  const merged = [];
  const fixedUp = [];
  // Each package gets at most one go per pass: a dependent that failed on
  // its try is not picked up again by the loop below.
  const tried = new Set();
  const result = (extra) => ({ merged, fixedUp, skipped: finalSkipped(packages, entries, dependsOf), ...extra });

  const take = async (pkg, retry) => {
    tried.add(pkg.id);
    const res = await tryPackage(pkg, { retry });
    if (res.ok) {
      entries.delete(pkg.id);
      merged.push(pkg.id);
      if (res.fixedUp) fixedUp.push(pkg.id);
    } else {
      entries.set(pkg.id, skipEntry(pkg.id, res));
    }
    return res;
  };
  // depSkipped packages with nothing skipped left under them, in plan
  // (= dependency) order: a chain frees itself as it goes.
  const freed = (pkg) => {
    const entry = entries.get(pkg.id);
    if (!entry || entry.stage !== 'depSkipped' || tried.has(pkg.id)) return false;
    return !skippedDependency(pkg, dependsOf, new Set(entries.keys()));
  };
  const takeDependents = async () => {
    for (const dep of packages) {
      if (stopped() || !freed(dep)) continue;
      const res = await take(dep, false);
      if (res.fatal) return { detail: res.fatal, failedId: dep.id };
    }
    return null;
  };

  for (const pkg of packages) {
    const entry = entries.get(pkg.id);
    if (!entry || !RETRY_STAGES.has(entry.stage) || tried.has(pkg.id) || stopped()) continue;
    const res = await take(pkg, true);
    if (res.fatal) return result({ fatal: { detail: res.fatal, failedId: pkg.id } });
    if (!res.ok) continue;
    const fatal = await takeDependents();
    if (fatal) return result({ fatal });
  }
  return result({});
}

module.exports = { secondPass, skippedDependency, skipEntry, RETRY_STAGES };
