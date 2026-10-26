// ============================================================================
// LunaCore - Luna's Work: what the controller does to the to-do cards
// ----------------------------------------------------------------------------
// The outer loop controller (src/lunaswork.js) reads and writes the project's
// to-do store only here:
//
//   ticked         which of an iteration's cards God Mode ticked (at push)
//   reopen         ticked or built cards whose work did not reach main, or
//                  failed a rule, go back to open - with a note when there
//                  is a reason to give - so the Director schedules them again
//   markBuilt      B1: a card whose work landed is *built*, not done
//   builtCards     the built cards the next Playtester pass checks
//   settle         B1: after that pass a built card closes (done), reopens
//                  with the evidence, or stays built
//   closeStopCards Mati's `stop` steer card is done once it stopped a run,
//                  or the next run would stop on it at once
//   lookup         the store cards behind some `at`s (state, text)
//   fileCards      new run cards the controller writes itself (B9's flaky
//                  test cards), through the Critic's applyCards
//
// The store is injected ({read, write}); every function is immutable over the
// list and never throws - a failure is logged and changes nothing.
// ============================================================================

'use strict';

const { isStopCard } = require('./lunasworkDirector');
const { applyCards } = require('./lunasworkCritic');
const { BUILT_STATE, MAX_DETAILS_CHARS, runTag } = require('./todorows');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** The card's details with `note` at the end, the start cut to fit the card cap. */
function withNote(details, note) {
  const text = typeof details === 'string' ? details : '';
  if (!note) return text;
  const room = MAX_DETAILS_CHARS - note.length - 2;
  if (room <= 0) return note.slice(0, MAX_DETAILS_CHARS);
  return [text.slice(0, room), note].filter(Boolean).join('\n\n');
}

/** An open card again: not done, not built, the note appended. */
function opened(card, note) {
  const { doneAt: _doneAt, state: _state, ...rest } = card;
  return { ...rest, done: false, ...(note ? { details: withNote(card.details, note) } : {}) };
}

/**
 * @param {{store:(projectId:string)=>{read:Function, write:Function}, now:()=>number, log:(line:string)=>void}} deps
 */
function createCardBook(deps) {
  const listOf = (store) => {
    const list = store.read();
    return Array.isArray(list) ? list : [];
  };

  /** One read-modify-write; `fn` maps each card. A failure is logged as `what`. */
  function rewrite(projectId, what, fn) {
    try {
      const store = deps.store(projectId);
      store.write(listOf(store).map((t) => (isObj(t) ? fn(t) : t)));
    } catch (err) {
      deps.log(`[lunaswork] could not ${what}: ${errText(err)}`);
    }
  }

  /** @returns {number[]} the `ats` that are done in the store, in the given order */
  function ticked(projectId, ats) {
    try {
      const done = new Set(listOf(deps.store(projectId)).filter((t) => isObj(t) && t.done).map((t) => t.at));
      return ats.filter((at) => done.has(at));
    } catch (err) {
      deps.log(`[lunaswork] could not read the cards: ${errText(err)}`);
      return [];
    }
  }

  /** Puts these ticked or built cards back to open, `note` appended to their details. */
  function reopen(projectId, ats, note = '') {
    if (!ats.length) return;
    const wanted = new Set(ats);
    rewrite(projectId, 'reopen the cards', (t) =>
      (wanted.has(t.at) && (t.done || t.state === BUILT_STATE) ? opened(t, note) : t));
  }

  /** B1: these ticked cards are built - open until the Playtester confirms them. */
  function markBuilt(projectId, ats) {
    if (!ats.length) return;
    const wanted = new Set(ats);
    rewrite(projectId, 'mark the cards built', (t) => {
      if (!t.done || !wanted.has(t.at)) return t;
      const { doneAt: _doneAt, ...rest } = t;
      return { ...rest, done: false, state: BUILT_STATE };
    });
  }

  /** @returns {object[]} the project's built cards */
  function builtCards(projectId) {
    try {
      return listOf(deps.store(projectId)).filter((t) => isObj(t) && !t.done && t.state === BUILT_STATE);
    } catch (err) {
      deps.log(`[lunaswork] could not read the cards: ${errText(err)}`);
      return [];
    }
  }

  /**
   * B1: applies the Playtester's verdicts on built cards. `done` closes the
   * card, `reopen` opens it with the evidence note, `built` leaves it.
   * @param {Array<{at:number, outcome:'done'|'reopen'|'built', note?:string}>} verdicts
   */
  function settle(projectId, verdicts) {
    const byAt = new Map(verdicts.filter((v) => v.outcome !== BUILT_STATE).map((v) => [v.at, v]));
    if (!byAt.size) return;
    const at = deps.now();
    rewrite(projectId, 'settle the built cards', (t) => {
      const v = byAt.get(t.at);
      if (!v || t.done || t.state !== BUILT_STATE) return t;
      if (v.outcome === 'reopen') return opened(t, v.note);
      const { state: _state, ...rest } = t;
      return { ...rest, done: true, doneAt: at };
    });
  }

  /** Marks every open `stop` steer card done. */
  function closeStopCards(projectId) {
    try {
      const store = deps.store(projectId);
      const list = listOf(store);
      if (!list.some((t) => isObj(t) && !t.done && isStopCard(t))) return;
      store.write(list.map((t) => (isObj(t) && !t.done && isStopCard(t) ? { ...t, done: true, doneAt: deps.now() } : t)));
    } catch (err) {
      deps.log(`[lunaswork] could not close the stop card: ${errText(err)}`);
    }
  }

  /** @returns {object[]} the store cards with these `at`s (the first of a duplicate `at`) */
  function lookup(projectId, ats) {
    try {
      const wanted = new Set(ats);
      const found = new Map();
      for (const t of listOf(deps.store(projectId))) {
        if (isObj(t) && wanted.has(t.at) && !found.has(t.at)) found.set(t.at, t);
      }
      return [...found.values()];
    } catch (err) {
      deps.log(`[lunaswork] could not read the cards: ${errText(err)}`);
      return [];
    }
  }

  /**
   * New cards of this run (Critic card shape: kind, severity, text, details,
   * acceptance, files, updatesCardId null). @returns {number[]} the new `at`s
   */
  function fileCards(projectId, runId, cards) {
    const tag = runTag(runId);
    if (!tag || !cards.length) return [];
    try {
      const res = applyCards(deps.store(projectId), cards, tag);
      if (res.error) deps.log(`[lunaswork] could not add the cards: ${res.error}`);
      return (res.created || []).map((c) => c.at);
    } catch (err) {
      deps.log(`[lunaswork] could not add the cards: ${errText(err)}`);
      return [];
    }
  }

  return { ticked, reopen, markBuilt, builtCards, settle, lookup, fileCards, closeStopCards };
}

module.exports = { createCardBook, withNote };
