// ============================================================================
// LunaCore - Luna's Work: what the controller does to the to-do cards
// ----------------------------------------------------------------------------
// The outer loop controller (src/lunaswork.js) reads and writes the project's
// to-do store in three places only, all here:
//
//   ticked         which of an iteration's cards God Mode ticked (at push)
//   reopen         ticked cards whose work did not reach main go back to
//                  open, so the Director schedules them again
//   closeStopCards Mati's `stop` steer card is done once it stopped a run,
//                  or the next run would stop on it at once
//
// The store is injected ({read, write}); every function is immutable over the
// list and never throws - a failure is logged and changes nothing.
// ============================================================================

'use strict';

const { isStopCard } = require('./lunasworkDirector');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {{store:(projectId:string)=>{read:Function, write:Function}, now:()=>number, log:(line:string)=>void}} deps
 */
function createCardBook(deps) {
  const listOf = (store) => {
    const list = store.read();
    return Array.isArray(list) ? list : [];
  };

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

  /** Puts these ticked cards back to open. */
  function reopen(projectId, ats) {
    if (!ats.length) return;
    try {
      const store = deps.store(projectId);
      const wanted = new Set(ats);
      store.write(
        listOf(store).map((t) => {
          if (!isObj(t) || !t.done || !wanted.has(t.at)) return t;
          const { doneAt: _doneAt, ...rest } = t;
          return { ...rest, done: false };
        }),
      );
    } catch (err) {
      deps.log(`[lunaswork] could not reopen the cards: ${errText(err)}`);
    }
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

  return { ticked, reopen, closeStopCards };
}

module.exports = { createCardBook };
