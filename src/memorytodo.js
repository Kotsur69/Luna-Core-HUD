// ============================================================================
// LunaCore - "Make a to-do": a memory that describes a fixable bug becomes a card
// ----------------------------------------------------------------------------
// The memory window (renderer memoryinbox.js / memorybrain.js) offers it on
// inbox, review and "All memories" entries. Main drafts the card from the full
// memory (memory:todo-draft), the user edits it, then memory:to-todo writes it
// (src/memoryipc.js):
//
//   1. the card goes into the To-do list of the LunaCore project whose folder
//      is the memory's project on this PC (todoProjectFor). A global memory,
//      or a project with no LunaCore project here, is refused: never the
//      `_default` bucket (src/todo.js).
//   2. ONLY once that write returned true is the memory removed:
//        waiting   -> the local graveyard (src/memorygraveyard.js), reason
//                     MOVED_REASON, restorable from the Graveyard tab
//        confirmed -> retired (memoryreview.retire): deleted on every PC.
//                     Safe: the card holds the text.
//   3. `to-todo` goes to the memory log with the key and the card's `at`.
//
// No `rejected` decision is logged: a rejected title goes back to the
// extractor as "do not capture this again", and a fixable bug is not a bad
// capture.
//
// No Electron here: the list reads/writes and the project mapping come in as deps.
// ============================================================================

'use strict';

const { GLOBAL, splitKey, keyOf } = require('./memoryrecord');
const { scan, removeRecord } = require('./memorystore');
const { groupPending, isPending } = require('./memoryinbox');
const { retire } = require('./memoryreview');
const { buryRecords } = require('./memorygraveyard');
const { normalizeTodo, SIZES, MAX_ITEMS, MAX_TEXT_CHARS, MAX_DETAILS_CHARS, DEFAULT_KEY } = require('./todo');

/** The tag every card made from a memory carries. */
const TODO_TAG = 'memory';
/** Why a waiting memory is in the graveyard (memorygraveyard caps a reason at 40 characters). */
const MOVED_REASON = 'moved to to-do';
const TITLE_PREFIX = 'Fix: ';

const errText = (err) => (err && (err.code || err.message)) || 'error';
const fail = (reason) => ({ ok: false, reason });

/**
 * The card a memory starts as: "Fix: <title>", and its body with where it came from.
 * The provenance line always survives the cap: the body is cut, never the line.
 * @param {{project: string, id: string, type: string, title: string, body: string, created: string}} record
 * @returns {{text: string, details: string}}
 */
function draftFromMemory(record) {
  const text = `${TITLE_PREFIX}${String(record.title || '').trim()}`.slice(0, MAX_TEXT_CHARS);
  const from = `From memory ${keyOf(record)} (${record.type}, created ${record.created})`;
  const room = Math.max(0, MAX_DETAILS_CHARS - from.length - 2);
  const body = String(record.body || '').trim().slice(0, room).trimEnd();
  return { text, details: body ? `${body}\n\n${from}` : from };
}

/**
 * The card fields the renderer sent, checked: text non-empty and within the
 * card cap, details within its cap, size one of SIZES or absent. Anything
 * else in the object is dropped; anything malformed refuses the whole draft.
 * @param {unknown} raw
 * @returns {{text: string, details?: string, size?: string}|null}
 */
function cleanDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { text, details, size } = raw;
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS || !text.trim()) return null;
  if (details !== undefined && details !== null && (typeof details !== 'string' || details.length > MAX_DETAILS_CHARS)) return null;
  const noSize = size === undefined || size === null || size === '';
  if (!noSize && !SIZES.includes(size)) return null;
  return {
    text: text.trim(),
    ...(typeof details === 'string' && details.trim() ? { details: details.trim() } : {}),
    ...(noSize ? {} : { size }),
  };
}

/**
 * The LunaCore project whose To-do list a memory project's cards go to: the
 * first project (in the app's order) whose folder resolves to that memory
 * project, the same folder -> project mapping the project card and the review
 * list use (main.js memoryProjectOf / memoryRoots).
 * @param {string} memoryProject e.g. 'github.com/kotsur69/luna-core-hud'
 * @param {{id?: unknown, path?: unknown}[]} projects LunaCore's projects
 * @param {(folder: string) => string|null} projectOf a folder -> its memory project
 * @returns {string|null} the project id (the To-do list key), or null
 */
function todoProjectFor(memoryProject, projects, projectOf) {
  if (typeof memoryProject !== 'string' || !memoryProject || memoryProject === GLOBAL) return null;
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id === DEFAULT_KEY) continue;
    if (typeof p.path !== 'string' || !p.path) continue;
    if (projectOf(p.path) === memoryProject) return p.id;
  }
  return null;
}

/** The memory with this key and, for a waiting one, the near-duplicates folded with it; or a reason. */
function findMemory(dir, key) {
  if (!splitKey(key)) return { reason: 'bad-key' };
  const { records } = scan(dir);
  const found = records.find(([k]) => k === key);
  if (!found) return { reason: 'not-found' };
  const record = found[1];
  if (!isPending(record)) return { record, pending: false, twins: [] };
  // The inbox shows a group as one entry: its twins say the same and leave with it.
  const group = groupPending(records).find((g) => g.key === key || g.duplicates.includes(key));
  const byKey = new Map(records);
  const twins = group ? [group.key, ...group.duplicates].filter((k) => k !== key && byKey.has(k)).map((k) => [k, byKey.get(k)]) : [];
  return { record, pending: true, twins };
}

/** The To-do list a memory's card goes to, or why there is none. */
function targetOf(record, projectIdFor) {
  if (record.project === GLOBAL) return { reason: 'global' };
  const projectId = projectIdFor(record.project);
  return typeof projectId === 'string' && projectId && projectId !== DEFAULT_KEY ? { projectId } : { reason: 'no-todo-list' };
}

/**
 * The prefilled form of one memory, or why it cannot become a card here.
 * @param {{dir: string, key: string, projectIdFor: (project: string) => string|null}} ctx
 * @returns {{ok: true, key: string, text: string, details: string}|{ok: false, reason: string}}
 */
function draftFor({ dir, key, projectIdFor }) {
  const found = findMemory(dir, key);
  if (!found.record) return fail(found.reason);
  const target = targetOf(found.record, projectIdFor);
  if (!target.projectId) return fail(target.reason);
  return { ok: true, key, ...draftFromMemory(found.record) };
}

/** An `at` no card of the list has: now, or one past the newest (src/intake.js freshAts). */
function freshAt(list, now) {
  const newest = list.reduce((m, item) => Math.max(m, Number(item && item.at) || 0), 0);
  return Math.max(now, newest + 1);
}

/** Takes the memory out once its card exists. Throws when it could not: the memory then stays. */
function removeMemory({ dir, key, found, graveyardFile, log, now }) {
  if (!found.pending) {
    const res = retire(dir, key, { log });
    if (!res.ok) throw new Error(`retire refused: ${res.reason}`);
    return;
  }
  const file = graveyardFile();
  if (!file) throw new Error('no graveyard file');
  // Kept first, deleted second: a failed burial leaves the memory where it was.
  const all = [[key, found.record], ...found.twins];
  buryRecords(file, all.map(([, r]) => r), MOVED_REASON, now);
  for (const [k] of all) removeRecord(dir, k);
}

/**
 * Write-then-remove: the card is written, and the memory is removed only
 * after that write returned true.
 * @param {{dir: string, key: string, draft: {text: string, details?: string, size?: string},
 *   now: number, projectIdFor: (project: string) => string|null,
 *   todos: {read: (projectId: string) => object[], write: (projectId: string, list: object[]) => boolean,
 *     changed?: (projectId: string) => void},
 *   graveyardFile: () => string|null, log?: {add: (event: object) => boolean}|null}} ctx
 *   draft = cleanDraft()'s result
 * @returns {{ok: true, key: string, projectId: string, at: number}|{ok: false, reason: string, projectId?: string, at?: number}}
 *   reason 'remove-failed' = the card was written but the memory is still there
 */
function moveToTodo({ dir, key, draft, now, projectIdFor, todos, graveyardFile, log = null }) {
  const found = findMemory(dir, key);
  if (!found.record) return fail(found.reason);
  const target = targetOf(found.record, projectIdFor);
  if (!target.projectId) return fail(target.reason);
  const { projectId } = target;
  const list = todos.read(projectId);
  if (!Array.isArray(list)) return fail('todo-failed');
  // normalizeTodos would silently drop a card past the cap: refuse instead.
  if (list.length >= MAX_ITEMS) return fail('list-full');
  const at = freshAt(list, now);
  const card = normalizeTodo({ text: draft.text, details: draft.details, size: draft.size, done: false, at, tags: [TODO_TAG] });
  if (!card) return fail('bad-draft');
  if (todos.write(projectId, [...list, card]) !== true) return fail('todo-failed');
  if (todos.changed) todos.changed(projectId);
  try {
    removeMemory({ dir, key, found, graveyardFile, log, now });
  } catch (err) {
    console.error('[memory] to-do card written, memory not removed:', errText(err));
    return { ok: false, reason: 'remove-failed', projectId, at };
  }
  if (log) log.add({ ev: 'to-todo', key, type: found.record.type, title: found.record.title, card: at });
  return { ok: true, key, projectId, at };
}

module.exports = {
  draftFromMemory,
  cleanDraft,
  todoProjectFor,
  draftFor,
  moveToTodo,
  TODO_TAG,
  MOVED_REASON,
  TITLE_PREFIX,
};
