// ============================================================================
// LunaCore - the agy model FAMILY registry (pure, shared)
// ----------------------------------------------------------------------------
// One place that knows the Antigravity (agy) model families. Adding a family
// (as Neon was) means adding one entry here; the worker pool, the planner
// prompt and the usage tile read it from this list.
//
//   family         the word matched against `agy models` names ('neon'):
//                  src/workerPool.js agyFamilyVariants(). Model ids are never
//                  listed here - variants come from the live list.
//   poolKey        the God Mode worker-pool / planner key ('agy-neon').
//   name           the English product name ('Neon (agy)'): the fallback for
//                  main-process code and the planner text.
//   labelKey       the renderer dictionary key of the translated menu name
//                  ('orch.agy.family.neon'); menus show t(labelKey).
//   plannerText    what the planner prompt says the key runs on.
//   tier           'hard' / 'easy' (src/workerPool.js tierOf).
//   strength       rank among the agy families, strongest = 0.
//   usageRow       the name of the usage-tile row the family's quota shows
//                  under ('Opus' / 'Gemini' / 'Neon' / 'Argon').
//   ownUsageRow    true when agy /usage reports a quota of the family's own,
//                  named apart from the shared "Gemini" one.
//   usageFromSummary  true when the quota is in agy's quota SUMMARY group
//                  ("Claude and GPT models"); the rest come from the
//                  per-model quota (src/agyusage.js).
//   usageAlwaysListed true when the usage tile lists the row even without a
//                  reading (an 'unreported' line); a family without it gets
//                  no empty placeholder row.
//   weeklyOnly     true when the family's quota is weekly only.
//
// Import-free like src/workerModels.js / src/workerPool.js: the renderer and
// the phone import it as an ES module, main and `node --test` require() it.
// ============================================================================

'use strict';

/** The agy families, strongest first. */
export const AGY_FAMILIES = Object.freeze([
  Object.freeze({
    family: 'opus', poolKey: 'agy-opus', labelKey: 'orch.agy.family.opus', name: 'Opus (agy)', plannerText: 'Claude Opus on the Antigravity CLI',
    tier: 'hard', strength: 0, usageRow: 'Opus', ownUsageRow: false, usageFromSummary: true, usageAlwaysListed: false, weeklyOnly: false,
  }),
  // Neon replaces Argon on Google's side; both stay while agy lists both.
  // Neon's own usage bucket is UNVERIFIED (agy /usage listed none on
  // 2026-11-19): it is matched by name, so it gets its own row once reported.
  Object.freeze({
    family: 'neon', poolKey: 'agy-neon', labelKey: 'orch.agy.family.neon', name: 'Neon (agy)', plannerText: 'Gemini Neon on the Antigravity CLI',
    tier: 'hard', strength: 1, usageRow: 'Neon', ownUsageRow: true, usageFromSummary: false, usageAlwaysListed: false, weeklyOnly: false,
  }),
  Object.freeze({
    family: 'argon', poolKey: 'agy-argon', labelKey: 'orch.agy.family.argon', name: 'Argon (agy)', plannerText: 'Gemini Argon on the Antigravity CLI',
    tier: 'hard', strength: 2, usageRow: 'Argon', ownUsageRow: true, usageFromSummary: false, usageAlwaysListed: true, weeklyOnly: true,
  }),
  // Hydrogen shares the Gemini quota (every gemini-* model without its own).
  Object.freeze({
    family: 'hydrogen', poolKey: 'agy-hydrogen', labelKey: 'orch.agy.family.hydrogen', name: 'Hydrogen (agy)', plannerText: 'Gemini Hydrogen on the Antigravity CLI',
    tier: 'easy', strength: 3, usageRow: 'Gemini', ownUsageRow: false, usageFromSummary: false, usageAlwaysListed: false, weeklyOnly: false,
  }),
]);

const byStrength = (a, b) => a.strength - b.strength;
const unique = (names) => [...new Set(names)];

/** The families, strongest first. */
export function agyFamilyList() {
  return [...AGY_FAMILIES].sort(byStrength);
}

/** The family entry of a pool key ('agy-neon'), else null. */
export function agyFamilyByPoolKey(key) {
  return AGY_FAMILIES.find((f) => f.poolKey === key) || null;
}

/** The pool keys of one tier ('hard' / 'easy'), strongest first. */
export function agyPoolKeysOfTier(tier) {
  return agyFamilyList().filter((f) => f.tier === tier).map((f) => f.poolKey);
}

/** The families agy /usage reports an own quota row for, strongest first. */
export function agyOwnUsageFamilies() {
  return agyFamilyList().filter((f) => f.ownUsageRow);
}

/** The usage-row names taken from the per-model quota (not the summary). */
export function agyPerModelUsageRows() {
  return unique(agyFamilyList().filter((f) => !f.usageFromSummary).map((f) => f.usageRow));
}

/** The usage-row names in name-column order: shared rows first, then own rows, each strongest first. */
export function agyUsageRowOrder() {
  const list = agyFamilyList();
  return unique([...list.filter((f) => !f.ownUsageRow), ...list.filter((f) => f.ownUsageRow)].map((f) => f.usageRow));
}

/** The usage-row names the tile lists even without a reading. */
export function agyAlwaysListedUsageRows() {
  return unique(AGY_FAMILIES.filter((f) => f.usageAlwaysListed).map((f) => f.usageRow));
}

/** True for a usage-row name whose quota is weekly only. */
export function isWeeklyOnlyUsageRow(row) {
  return AGY_FAMILIES.some((f) => f.weeklyOnly && f.usageRow === row);
}
