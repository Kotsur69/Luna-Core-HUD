// ============================================================================
// LunaCore - God Mode v2 to-do picker rules (pure half of orchestraPick.js)
// ----------------------------------------------------------------------------
// Which to-dos the picker offers, what starts ticked, and which ticked cards
// lean on an open card that is NOT ticked (its dependsOn holds other cards'
// `at` values). No DOM, no imports: node --test reads it directly.
// ============================================================================

'use strict';

/**
 * Cards God Mode can take: open and not marked manual ([Mati] cards are the
 * user's own job - makePlan drops them too).
 * @param {Array<{at:number, done?:boolean, manual?:boolean}>} todos
 */
export function pickable(todos) {
  return (Array.isArray(todos) ? todos : []).filter((t) => t && !t.done && t.manual !== true && Number.isFinite(t.at));
}

/** Open cards God Mode skips because only Mati can do them. */
export function manualCount(todos) {
  return (Array.isArray(todos) ? todos : []).filter((t) => t && !t.done && t.manual === true).length;
}

/**
 * The selection after (re)loading the list: what was ticked and still exists
 * stays ticked, what was unticked stays unticked, a card never seen before
 * starts ticked - so the first open is "everything", like before the picker.
 * @param {Array<{at:number}>} cards pickable cards
 * @param {Set<number>} selected previous selection
 * @param {Set<number>} seen every `at` shown before
 * @returns {Set<number>}
 */
export function mergeSelection(cards, selected, seen) {
  const next = new Set();
  for (const c of cards) {
    if (selected.has(c.at) || !seen.has(c.at)) next.add(c.at);
  }
  return next;
}

/**
 * For each ticked card: the titles of open cards it depends on that are not
 * ticked. A worker cannot build on a branch nobody makes this run.
 * @param {Array<{at:number, text:string, dependsOn?:number[]}>} cards
 * @param {Set<number>} selected
 * @returns {Map<number, string[]>} only cards with a missing dependency
 */
export function missingDeps(cards, selected) {
  const byAt = new Map(cards.map((c) => [c.at, c]));
  const out = new Map();
  for (const c of cards) {
    if (!selected.has(c.at) || !Array.isArray(c.dependsOn)) continue;
    const missing = c.dependsOn.filter((at) => byAt.has(at) && !selected.has(at)).map((at) => byAt.get(at).text);
    if (missing.length) out.set(c.at, missing);
  }
  return out;
}

/**
 * The selection plus every open card it depends on, transitively.
 * @param {Array<{at:number, dependsOn?:number[]}>} cards
 * @param {Set<number>} selected
 * @returns {Set<number>}
 */
export function withDeps(cards, selected) {
  const byAt = new Map(cards.map((c) => [c.at, c]));
  const next = new Set(selected);
  const stack = [...selected];
  while (stack.length) {
    const card = byAt.get(stack.pop());
    for (const at of (card && Array.isArray(card.dependsOn) ? card.dependsOn : [])) {
      if (byAt.has(at) && !next.has(at)) {
        next.add(at);
        stack.push(at);
      }
    }
  }
  return next;
}
