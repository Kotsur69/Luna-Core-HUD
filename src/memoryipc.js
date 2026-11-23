// ============================================================================
// LunaCore - memory inbox IPC (main)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 4. The HUD's inbox panel
// (renderer memoryinbox.js) reviews what capture proposed:
//
//   memory:inbox   ()             -> {ok, items, total, conflicts: {items, total}, capture, search}
//                                    search = how memory_search answers here: by meaning
//                                    (which model) or by keywords only (why)
//   memory:approve (key)          -> {ok, key, removed} | {ok:false, reason}
//   memory:reject  (key)          -> same
//   memory:update  ({key, edits}) -> {ok, key} | {ok:false, reason}
//   memory:make-global (key)      -> {ok, key} | {ok:false, reason}   key = the new global key
//   memory:changed (push)            the mirror changed: repaint
//
// Phase 5, the review list (src/memoryreview.js): confirmed memories that are
// stale, name a file that is gone, or were reported wrong by a session.
// 'changed' (a named file has newer commits) comes from the git cache of
// src/memorychanges.js: the list uses the cached answer and starts a refresh
// in the background; when that lands with a different answer, onChanged
// repaints the window. git never runs while the list is built.
//
//   memory:review  ()             -> {ok, items, total}
//   memory:verify  (key)          -> {ok, key} | {ok:false, reason}   "still true"
//   memory:retire  (key)          -> same                             deleted on every PC
//   Both refuse a memory that is not on the review list (`not-flagged`).
//
// Every listed memory (inbox entries, review entries, both sides of a conflict)
// carries `final`, its computed final score (memoryrecord.finalScore): this
// PC's reads of the last 30 days count.
//
// memory:inbox also carries `stats`: what capture proposed in the last week
// and what was approved (src/memorylog.js). Every decision is written to that log.
//
// Auto-accept per type (src/memoryautoaccept.js); memory:inbox carries `auto`
// ({types, score, recent, bar} or null). type 'score' (SCORE_SWITCH) is the
// 'Auto-save memories scored 90+' switch: no numbers gate it, it is opt-in.
//
//   memory:auto-set  ({type, on})    -> {ok, type, on} | {ok:false, reason}   'not-offered' = the numbers do not allow it,
//                                                                             'score-failing' = the score switch's own rate is under the bar
//   memory:auto-undo (key)           -> {ok, key} | {ok:false, reason}        'not-auto' = not a recent auto-accept
//
// The graveyard (src/memorygraveyard.js): candidates scored under
// AUTO_REJECT_BELOW (src/memoryextract.js), kept in a LOCAL file. An entry is named by its entry id
// (never a memory key, never a path); main checks its shape and that it is in
// the file.
//
//   memory:graveyard         ()    -> {ok, items, total}
//   memory:graveyard-restore (key) -> {ok, key} | {ok:false, reason}   key = the new inbox key; logs `restored`
//   memory:graveyard-delete  (key) -> {ok, key} | {ok:false, reason}
//
// "Make a to-do" (src/memorytodo.js): a memory becomes a card in the To-do
// list of its project on this PC, then leaves: copied to the local graveyard,
// then deleted (a confirmed one is retired on every PC). Global memories and projects with no list here are refused.
//
//   memory:todo-draft (key)                         -> {ok, key, text, details} | {ok:false, reason}
//   memory:to-todo    (key, {text, details?, size?}) -> {ok, key, projectId, at} | {ok:false, reason}
//
// "Export all" (src/memoryexport.js): every valid memory and note copied to a
// backup folder. The renderer sends nothing: main asks for the folder in its
// own dialog (chooseFolder), so no path ever crosses the bridge.
//
//   memory:export ()  -> {ok, folder, name, files, memories, notes, projects, skipped, skippedCount}
//                        | {ok:false, reason: 'cancelled'|'no-memory-dir'|'bad-target'|'target-missing'|'inside-memory-dir'|'name-taken'|'failed'}
//
// The renderer names a memory only by its key. src/memoryinbox.js checks the
// key (splitKey: never a path) and refuses anything that is not waiting, so
// these channels cannot touch a confirmed memory. Edited text is rebuilt by
// memoryrecord.checkRecord() like every other record.
// ============================================================================

'use strict';

const { listInbox, approve, reject, update, makeGlobal } = require('./memoryinbox');
const { MAX_BODY, MAX_TITLE, finalScore, splitKey } = require('./memoryrecord');
const { recentUsage } = require('./memoryuse');
const { scan } = require('./memorystore');
const { reviewList, verify, retire, findConfirmed } = require('./memoryreview');
const { captureStats, decisionEvent, lastChecks, DAY_MS } = require('./memorylog');
const { checkOf } = require('./memorycheck');
const auto = require('./memoryautoaccept');
const { CANDIDATE_TYPES } = require('./memoryextract');
const { listConflicts } = require('./memoryconflict');
const graveyard = require('./memorygraveyard');
const { cleanDraft, todoProjectFor, draftFor, moveToTodo } = require('./memorytodo');
const { cachedChanges, currentChanges } = require('./memorychanges');
const { sharedVectorStore, vectorLookup, docText } = require('./memoryembed');
const { rememberRejected, forgetSimilar } = require('./memoryshield');
const { exportAll } = require('./memoryexport');

/** The window of the approval-rate line under the inbox. */
const STATS_DAYS = 7;

const MAX_KEY_CHARS = 200;
const EDIT_LIMITS = { title: MAX_TITLE * 2, body: MAX_BODY * 2, type: 20, area: 40 };

const errText = (err) => (err && (err.code || err.message)) || 'error';
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const keyOf = (v) => (typeof v === 'string' && v.length <= MAX_KEY_CHARS ? v : '');
/** A memory key from the renderer that splitKey accepts, or null. */
const memoryKeyOf = (v) => (keyOf(v) && splitKey(v) ? v : null);
/** A graveyard entry id from the renderer, or '' (refused as 'bad-key'). */
const entryIdOf = (v) => (graveyard.isEntryId(v) ? v : '');

/** Only the four editable fields, strings of a sane length; anything else is dropped. */
function cleanEdits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const edits = {};
  for (const [field, max] of Object.entries(EDIT_LIMITS)) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > max) return null;
    edits[field] = value;
  }
  return edits;
}

/**
 * A listed memory with its final score (memoryrecord.finalScore), read from
 * the record of its key; an item whose record is gone is left as it is.
 * @param {{key: string}} item
 * @param {Map<string, object>} byKey the mirror's records
 * @param {{reads: Map<string, number>, today: string}} usage memoryuse.recentUsage()
 */
function withFinal(item, byKey, usage) {
  const record = byKey.get(item.key);
  return record ? { ...item, final: finalScore(record, { reads: usage.reads.get(item.key) || 0, today: usage.today }) } : item;
}

/** The inbox's conflict pairs, each side with its final score. */
const conflictsWithFinal = (conflicts, byKey, usage) => ({
  ...conflicts,
  items: conflicts.items.map((pair) => ({ ...pair, a: withFinal(pair.a, byKey, usage), b: withFinal(pair.b, byKey, usage) })),
});

const SEARCH_REASONS = new Set(['checking', 'not-local', 'no-server', 'no-model', 'failed', 'building']);
const MAX_MODEL_CHARS = 120;
const count = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);

/**
 * What the status line under the inbox may show of the vector store's mode()
 * (src/memoryembed.js): a model name comes from LM Studio, so it is cut and
 * nothing else passes.
 * @returns {{mode: 'meaning', model: string, embedded: number, total: number}|{mode: 'keywords', reason: string}|null}
 */
function cleanSearchMode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.mode === 'meaning' && typeof raw.model === 'string') {
    return { mode: 'meaning', model: raw.model.slice(0, MAX_MODEL_CHARS), embedded: count(raw.embedded), total: count(raw.total) };
  }
  if (raw.mode === 'keywords') return { mode: 'keywords', reason: SEARCH_REASONS.has(raw.reason) ? raw.reason : 'failed' };
  return null;
}

/**
 * @param {{ipcMain: object, dir: () => string, onChanged?: () => void,
 *   captureStatus?: () => object|null, now?: () => number,
 *   log?: {add: Function, read: Function}|null, roots?: () => object,
 *   searchStatus?: () => object|null}} deps
 *   dir = the mirror folder; onChanged fires after a write (sync soon, repaint);
 *   log = the memory log; roots = {<project>: its folder on this PC}, for the anchor check;
 *   searchStatus = how memory_search answers on this PC (the vector store's mode());
 *   todoProjects = LunaCore's projects ({id, path}); memoryProjectOf = a folder -> its memory
 *   project; todos = {read, write, changed} of the per-project To-do lists (src/todo.js);
 *   changes = memorychanges.createChangeTracker() ('changed' flags), null = none;
 *   vectors = the vector store (src/memoryembed.js): near-duplicates by meaning, and the
 *   Rejected-Embedding Shield (src/memoryshield.js); null = by words, no shield;
 *   chooseFolder = main's folder dialog for "Export all": (event) => Promise<string|null>, null = cancelled
 */
function registerMemoryIpc({
  ipcMain,
  dir,
  onChanged = () => {},
  captureStatus = () => null,
  now = Date.now,
  log = null,
  roots = () => ({}),
  searchStatus = () => null,
  autoFile = () => null,
  onSettingsChanged = () => {},
  graveyardFile = () => null,
  todoProjects = () => [],
  memoryProjectOf = () => null,
  todos = null,
  changes = null,
  vectors = sharedVectorStore,
  chooseFolder = null,
}) {
  /** The vector store right now, or null; a failure there means "by words", never a failed call. */
  const store = () => {
    try {
      return vectors() || null;
    } catch (err) {
      console.error('[memory] vector store unavailable:', errText(err));
      return null;
    }
  };
  /** A memory's cached vector right now: the conflict list (a pair is settled only as listed). */
  const vectorOf = () => vectorLookup(store());
  /**
   * The vectors the inbox was last listed with, per key, with the text each was
   * made of. A decision groups with these, never with vectors that appeared
   * since (the store fills in the background): approving or rejecting an entry
   * removes the twins the inbox showed folded into it, and no other memory.
   * @type {Map<string, {text: string, vec: Float32Array}>}
   */
  let listed = new Map();
  const snapshot = (records) => {
    const lookup = vectorOf();
    const next = new Map();
    if (lookup) {
      for (const [key, r] of records) {
        const vec = lookup(r);
        if (vec) next.set(key, { text: docText(r), vec });
      }
    }
    listed = next;
  };
  const listedVectorOf = (record) => {
    const seen = listed.get(`${record.project}/${record.id}`);
    return seen && seen.text === docText(record) ? seen.vec : undefined;
  };
  /**
   * Writes an inbox decision to the memory log. Only a rejected title is kept: it goes back to the extractor.
   * A rejection (an inbox reject, an auto-accept undone) also goes to the shield, in the background;
   * an approval makes the shield forget the rejections it is close to (src/memoryshield.js).
   */
  const decided = (ev, record) => {
    if (log) log.add(decisionEvent(ev, record));
    if (ev === 'rejected') rememberRejected(store(), record, now());
    if (ev === 'approved') forgetSimilar(store(), record);
  };
  const events = () => (log ? log.read() : []);
  /** The anchor check walks folders main named: a failure there must not hide the list. */
  const knownRoots = () => {
    try {
      return roots() || {};
    } catch (err) {
      console.error('[memory] project folders unavailable:', errText(err));
      return {};
    }
  };
  /** How memory_search answers on this PC, or null: a failure there must not hide the list. */
  const searchMode = () => {
    try {
      return cleanSearchMode(searchStatus());
    } catch (err) {
      console.error('[memory] search status unavailable:', errText(err));
      return null;
    }
  };
  /**
   * The cached 'changed' answers for reviewList, and a background refresh that
   * repaints when its answer differs. A failure there must not hide the list.
   */
  const changesFor = (records, rootsHere) => cachedChanges(changes, records, rootsHere, onChanged);
  /** A write: never throws to the renderer, and tells main when files changed. */
  const guarded = (label, fn) => {
    try {
      const res = fn();
      if (res.ok) onChanged();
      return res;
    } catch (err) {
      console.error(`[memory] ${label} failed:`, errText(err));
      return { ok: false, reason: 'failed' };
    }
  };

  /** Turns off the auto-accept switches whose rate fell (memoryautoaccept.js); a change is synced. */
  const enforceAuto = (file, evs) => {
    if (auto.enforceAutoOff({ file, events: evs, now: now(), log }).length) onSettingsChanged();
  };
  /** The auto-accept part of the inbox, or null. Its failure must not hide the inbox. */
  const autoState = () => {
    try {
      const file = autoFile();
      if (!file) return null;
      const evs = events();
      enforceAuto(file, evs);
      return {
        types: auto.autoStatus(auto.readAuto(file), auto.typeStats(evs, now())),
        score: { id: auto.SCORE_SWITCH, on: auto.readScoreAuto(file), ...auto.scoreStats(evs, now()) },
        recent: auto.recentAutoAccepted(scan(dir()).records, isoDate(now())),
        bar: {
          min: auto.AUTO_MIN_DECISIONS,
          days: auto.AUTO_WINDOW_DAYS,
          on: auto.AUTO_ON_RATE,
          off: auto.AUTO_OFF_RATE,
          undoDays: auto.AUTO_UNDO_DAYS,
          saveFrom: auto.AUTO_SAVE_FROM,
        },
      };
    } catch (err) {
      console.error('[memory] auto-accept status failed:', errText(err));
      return null;
    }
  };

  ipcMain.handle('memory:inbox', () => {
    try {
      const evs = events();
      const { captures, proposed, approved, rejected, edited, rate } = captureStats(evs, { since: now() - STATS_DAYS * DAY_MS });
      const usage = recentUsage(evs, now());
      const { records } = scan(dir());
      snapshot(records);
      return {
        ok: true,
        ...listInbox(dir(), { ...usage, vectorOf: listedVectorOf }),
        // Memories that contradict each other wait here too (src/memoryconflict.js).
        conflicts: conflictsWithFinal(listConflicts(records, { events: evs, vectorOf: vectorOf() }), new Map(records), usage),
        capture: captureStatus(),
        search: searchMode(),
        stats: { days: STATS_DAYS, captures, proposed, approved, rejected, edited, rate },
        auto: autoState(),
      };
    } catch (err) {
      console.error('[memory] inbox failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });
  ipcMain.handle('memory:approve', (_event, key) => guarded('approve', () => approve(dir(), keyOf(key), isoDate(now()), decided, { vectorOf: listedVectorOf })));
  ipcMain.handle('memory:reject', (_event, key) => guarded('reject', () => reject(dir(), keyOf(key), decided, { vectorOf: listedVectorOf })));
  ipcMain.handle('memory:update', (_event, req) => {
    const edits = cleanEdits(req && req.edits);
    if (!edits) return { ok: false, reason: 'bad-edits' };
    return guarded('update', () => update(dir(), keyOf(req.key), edits, decided));
  });
  ipcMain.handle('memory:make-global', (_event, key) => guarded('make-global', () => makeGlobal(dir(), keyOf(key))));

  ipcMain.handle('memory:review', () => {
    try {
      const evs = events();
      const { records } = scan(dir());
      const rootsHere = knownRoots();
      const res = reviewList({ records, today: isoDate(now()), events: evs, roots: rootsHere, changes: changesFor(records, rootsHere) });
      const byKey = new Map(records);
      const usage = recentUsage(evs, now());
      // Each entry's last "Check if still true" answer on this PC (src/memorycheck.js), or null.
      const checks = lastChecks(evs);
      return { ok: true, ...res, items: res.items.map((item) => ({ ...withFinal(item, byKey, usage), check: checkOf(checks, item.key) })) };
    } catch (err) {
      console.error('[memory] review failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });
  /**
   * The renderer may settle only what the review list shows: these channels
   * are no way to delete or re-date an arbitrary confirmed memory.
   * @returns {{ok: false, reason: string}|null} null = the key is on the list
   */
  const refusal = (key, knownHere) => {
    const found = findConfirmed(dir(), key);
    if (!found.record) return { ok: false, reason: found.reason };
    // The cached answers only: a memory flagged 'changed' in the window is on the list here too.
    const { items } = reviewList({ records: scan(dir()).records, today: isoDate(now()), events: events(), roots: knownHere, changes: currentChanges(changes) });
    return items.some((item) => item.key === key) ? null : { ok: false, reason: 'not-flagged' };
  };
  ipcMain.handle('memory:verify', (_event, key) =>
    guarded('verify', () => {
      const knownHere = knownRoots();
      return refusal(keyOf(key), knownHere) || verify(dir(), keyOf(key), isoDate(now()), { log, roots: knownHere });
    }),
  );
  ipcMain.handle('memory:retire', (_event, key) => guarded('retire', () => refusal(keyOf(key), knownRoots()) || retire(dir(), keyOf(key), { log })));

  // Auto-accept (src/memoryautoaccept.js). A switch can be turned on only while
  // this PC's numbers offer it; off always works. Undo deletes only a memory on
  // the recent auto-accept list, never another confirmed one.
  ipcMain.handle('memory:auto-set', (_event, req) => {
    const known = (t) => CANDIDATE_TYPES.includes(t) || t === auto.SCORE_SWITCH;
    const type = req && typeof req === 'object' && known(req.type) ? req.type : null;
    if (!type || typeof req.on !== 'boolean') return { ok: false, reason: 'bad-request' };
    try {
      const file = autoFile();
      if (!file) return { ok: false, reason: 'failed' };
      if (type === auto.SCORE_SWITCH) {
        // Opt-in, no numbers to earn (decide() still asks the type's per candidate),
        // but a switch whose own undo rate failed would only turn itself off again.
        if (req.on && auto.isFailing(auto.scoreStats(events(), now()))) return { ok: false, reason: 'score-failing' };
        auto.setScoreAuto(file, req.on);
        onSettingsChanged();
        return { ok: true, type, on: req.on };
      }
      if (req.on && !auto.isOffered(auto.typeStats(events(), now())[type])) return { ok: false, reason: 'not-offered' };
      auto.setAuto(file, type, req.on);
      onSettingsChanged();
      return { ok: true, type, on: req.on };
    } catch (err) {
      console.error('[memory] auto-accept switch failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });
  // The graveyard. Restore writes to the mirror (onChanged: sync, repaint);
  // delete touches only the local file, so nothing is synced.
  ipcMain.handle('memory:graveyard', () => {
    try {
      const file = graveyardFile();
      return { ok: true, ...(file ? graveyard.listGraveyard(file, now()) : { items: [], total: 0 }) };
    } catch (err) {
      console.error('[memory] graveyard failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });
  ipcMain.handle('memory:graveyard-restore', (_event, key) => {
    const id = entryIdOf(key);
    if (!id) return { ok: false, reason: 'bad-key' };
    return guarded('graveyard-restore', () => {
      const file = graveyardFile();
      return file ? graveyard.restoreEntry({ file, dir: dir(), id, now: now(), log }) : { ok: false, reason: 'failed' };
    });
  });
  ipcMain.handle('memory:graveyard-delete', (_event, key) => {
    const id = entryIdOf(key);
    if (!id) return { ok: false, reason: 'bad-key' };
    try {
      const file = graveyardFile();
      return file ? graveyard.removeEntry(file, id, now()) : { ok: false, reason: 'failed' };
    } catch (err) {
      console.error('[memory] graveyard delete failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });

  // "Make a to-do" (src/memorytodo.js). The project's list is looked up per
  // call: projects can be added or moved while the window is open.
  const projectIdFor = (project) => todoProjectFor(project, todoProjects(), memoryProjectOf);
  ipcMain.handle('memory:todo-draft', (_event, key) => {
    const k = memoryKeyOf(key);
    if (!k) return { ok: false, reason: 'bad-key' };
    try {
      return draftFor({ dir: dir(), key: k, projectIdFor });
    } catch (err) {
      console.error('[memory] to-do draft failed:', errText(err));
      return { ok: false, reason: 'failed' };
    }
  });
  ipcMain.handle('memory:to-todo', (_event, key, raw) => {
    const k = memoryKeyOf(key);
    if (!k) return { ok: false, reason: 'bad-key' };
    const draft = cleanDraft(raw);
    if (!draft) return { ok: false, reason: 'bad-draft' };
    if (!todos) return { ok: false, reason: 'failed' };
    const res = guarded('to-todo', () => moveToTodo({ dir: dir(), key: k, draft, now: now(), projectIdFor, todos, graveyardFile, log, vectorOf: listedVectorOf }));
    // Some of a group's files may be gone even so: sync and repaint what is left.
    if (res.reason === 'remove-failed') onChanged();
    return res;
  });

  // "Export all". Takes no payload: the folder comes from main's own dialog.
  // Writes outside the mirror only, so nothing syncs and nothing repaints.
  let exporting = false;
  ipcMain.handle('memory:export', async (event) => {
    if (typeof chooseFolder !== 'function') return { ok: false, reason: 'failed' };
    if (exporting) return { ok: false, reason: 'busy' };
    exporting = true;
    try {
      const folder = await chooseFolder(event);
      if (folder === null || folder === undefined) return { ok: false, reason: 'cancelled' };
      if (typeof folder !== 'string') return { ok: false, reason: 'bad-target' };
      return exportAll({ dir: dir(), destDir: folder, now: now() });
    } catch (err) {
      console.error('[memory] export failed:', errText(err));
      return { ok: false, reason: 'failed' };
    } finally {
      exporting = false;
    }
  });

  ipcMain.handle('memory:auto-undo', (_event, key) => {
    const res = guarded('auto-undo', () => auto.undoAutoAccept(dir(), keyOf(key), isoDate(now()), decided));
    // An undo counts as a rejection: the type's rate may have fallen under the bar.
    if (res.ok) {
      try {
        const file = autoFile();
        if (file) enforceAuto(file, events());
      } catch (err) {
        console.error('[memory] auto-accept check after undo failed:', errText(err));
      }
    }
    return res;
  });
}

/**
 * How many confirmed memories on the review list need a look (the hub counts
 * them with the inbox). A memory flagged only as "never opened" is on the
 * list but not in this number: it is a low-priority hint, not a reason to nag.
 * Never throws: a count is not worth a failed hub tick.
 * @param {{dir: string, today: string, events?: object[], roots?: object, changes?: object}} ctx
 *   changes = the cached 'changed' answers (memorychanges tracker current()); the hub never starts git
 */
function reviewCount({ dir, today, events = [], roots = {}, changes = {} }) {
  try {
    return reviewList({ records: scan(dir).records, today, events, roots, changes }).urgent;
  } catch (err) {
    console.error('[memory] review count failed:', errText(err));
    return 0;
  }
}

module.exports = { registerMemoryIpc, cleanEdits, cleanSearchMode, reviewCount, STATS_DAYS };
