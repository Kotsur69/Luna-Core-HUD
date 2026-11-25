// ============================================================================
// LunaCore - to-do item validation (pure, shared by main and the phone app)
// ----------------------------------------------------------------------------
// The shape rules of one to-do item and one list, with no fs / paths, so the
// phone app (mobile/, docs/done_docs/DONE_CLOUD_SYNC_PLAN.md phase 4) bundles the exact code
// a PC uses: todosync.js drops a pulled item unless normalizeTodo() accepts
// it, so the phone must write items this code already produced.
// src/todo.js re-exports everything here; persistence stays there.
// ============================================================================

'use strict';

const { normalizeEffort } = require('./efforts');
const { CARD_MODELS } = require('./workerModels');

// A pin-board, not an issue tracker. Beyond this the widget stops being a
// glanceable list, and the honest answer is that the work belongs somewhere
// with a real tracker.
const MAX_ITEMS = 100;
// A to-do is often a whole pasted prompt, so the title cap is generous; it
// still bounds one write. The renderer mirrors it (todocards.js).
const MAX_TEXT_CHARS = 20000;

// Task-card fields (DONE_ORCHESTRATOR_PLAN.md "Task cards instead of one-line
// to-dos"). All optional: an item without them is a plain pin-board line and
// round-trips byte-identical to how it did before cards existed. Written
// mostly by Claude through the intake MCP server (src/intake.js), so the caps
// are what stops one runaway tool call from bloating the store.
const MAX_DETAILS_CHARS = 20000;
const MAX_LIST_ENTRIES = 20;
// One definition-of-done bullet. Models write whole sentences with paths and
// commands in them, so it gets more room than a file path or verify command.
const MAX_ACCEPTANCE_CHARS = 1000;
// One files entry, and the verify command.
const MAX_ENTRY_CHARS = 300;
const MAX_FILES = 50;
const MAX_DEPENDS = 50;
const SIZES = ['S', 'M', 'L'];
// A card's suggested worker model. 'fable' and 'agy' (the Antigravity CLI,
// src/claudeModels.js AGY_MODEL) are manual picks: the intake and the God
// Mode planner only ever suggest sonnet / opus. Every God Mode worker model
// but 'plan' (src/workerModels.js CARD_MODELS, also bundled by the phone app).
const MODELS = CARD_MODELS;
// Tags (docs/tbc_docs/LUNAS_WORK_PLAN.md): Luna's Work files its backlog under a run
// tag and reads Mati's `steer` cards. God Mode ignores them.
const MAX_TAGS = 10;
const TAG_RE = /^[a-z0-9][a-z0-9:_-]{0,39}$/;
const STEER_TAG = 'steer';
// Card states beyond open / done (docs/tbc_docs/LUNAS_WORK_PLAN.md B1): a Luna's Work
// card whose work is merged but not yet confirmed in the running app is
// `built` - still open (done: false) until the Playtester confirms it.
const BUILT_STATE = 'built';
const CARD_STATES = [BUILT_STATE];

/** Trimmed, capped string, or null when there is nothing usable. */
function cleanString(raw, max) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().slice(0, max);
  return s || null;
}

/** Array of trimmed, capped, non-empty strings, or null when none survive. */
function cleanStringList(raw, maxEntries, maxChars) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    const s = cleanString(entry, maxChars);
    if (s) out.push(s);
    if (out.length >= maxEntries) break;
  }
  return out.length ? out : null;
}

/** Array of unique finite numbers (other cards' `at`), or null when none. */
function cleanDepends(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    const n = Number(entry);
    if (typeof entry === 'number' && Number.isFinite(n) && !out.includes(n)) out.push(n);
    if (out.length >= MAX_DEPENDS) break;
  }
  return out.length ? out : null;
}

/** One tag, trimmed and lowercased, or null when it does not fit TAG_RE. */
function cleanTag(raw) {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().toLowerCase();
  return TAG_RE.test(tag) ? tag : null;
}

/** Array of unique valid tags in their first-seen order, or null when none. */
function cleanTags(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    const tag = cleanTag(entry);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out.length ? out : null;
}

/**
 * The tag Luna's Work files a run's cards under: `run:<runId>`. The run id
 * is git-tag-safe (lunasworkRules.js) but may hold capitals and dots, so it
 * is lowercased and dots become dashes. Null when the result is not a valid
 * tag (an id longer than 36 characters, or not a string).
 * @param {unknown} runId
 * @returns {string|null}
 */
function runTag(runId) {
  if (typeof runId !== 'string' || !runId) return null;
  return cleanTag(`run:${runId.replace(/\./g, '-')}`);
}

/**
 * The optional card fields of one raw item - only the ones that are present
 * and valid, so a plain item gains no keys.
 * @param {object} raw
 * @returns {object}
 */
function normalizeCardFields(raw) {
  const fields = {
    details: cleanString(raw.details, MAX_DETAILS_CHARS),
    acceptance: cleanStringList(raw.acceptance, MAX_LIST_ENTRIES, MAX_ACCEPTANCE_CHARS),
    files: cleanStringList(raw.files, MAX_FILES, MAX_ENTRY_CHARS),
    verify: cleanString(raw.verify, MAX_ENTRY_CHARS),
    size: SIZES.includes(raw.size) ? raw.size : null,
    model: MODELS.includes(raw.model) ? raw.model : null,
    // Claude CLI --effort for the worker; never below medium (src/efforts.js).
    effort: normalizeEffort(raw.effort),
    dependsOn: cleanDepends(raw.dependsOn),
    // The loose note a card was rewritten from (the to-do widget's "rewrite
    // with Claude"), kept so the user can check the card did not drift from
    // what they meant. Same cap as a title: it WAS a title.
    original: cleanString(raw.original, MAX_TEXT_CHARS),
    // Opt-out: only the user can do this one, so God Mode and Orchestra leave
    // it alone. Stored only when true, so a plain item gains no key.
    manual: raw.manual === true ? true : null,
    tags: cleanTags(raw.tags),
    // Only an open card can be built: ticking it done ends the state.
    state: raw.done !== true && CARD_STATES.includes(raw.state) ? raw.state : null,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
}

/**
 * Validates one item.
 * @param {unknown} raw
 * @returns {{text:string, done:boolean, at:number}|null} plus any valid card fields
 */
function normalizeTodo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.text !== 'string') return null;
  const text = raw.text.trim().slice(0, MAX_TEXT_CHARS);
  if (!text) return null;
  const at = Number(raw.at);
  const done = raw.done === true;
  // When it was ticked (the Life score counts to-dos closed today). Only on a
  // done item, so reopening drops it and a plain item gains no key.
  const doneAt = done && typeof raw.doneAt === 'number' && Number.isFinite(raw.doneAt) && raw.doneAt > 0 ? { doneAt: raw.doneAt } : {};
  return {
    text,
    done,
    at: Number.isFinite(at) ? at : 0,
    ...doneAt,
    ...normalizeCardFields(raw),
  };
}

// ---- limits a writer must be told about -------------------------------------
// normalizeTodo() cuts what is too long, because stored data (the file on
// disk, a peer's list) must always yield a safe value. A model calling the
// intake tools is different: a cut copy loses work nobody notices, so the
// intake refuses the call instead and names what to shorten (cardLimitError).

const STRING_LIMITS = Object.freeze([
  ['text', MAX_TEXT_CHARS],
  ['details', MAX_DETAILS_CHARS],
  ['original', MAX_TEXT_CHARS],
  ['verify', MAX_ENTRY_CHARS],
]);
const LIST_LIMITS = Object.freeze([
  ['acceptance', MAX_LIST_ENTRIES, MAX_ACCEPTANCE_CHARS],
  ['files', MAX_FILES, MAX_ENTRY_CHARS],
]);
const SPLIT_HINT = 'shorten it or split the work into more cards';

/** Non-empty trimmed strings of a list, as cleanStringList keeps them (before its caps). */
const keptEntries = (list) => list.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim());

/** The first list field over its entry count or entry length, as an error, or null. */
function listLimitError(raw, name) {
  for (const [key, maxEntries, maxChars] of LIST_LIMITS) {
    if (!Array.isArray(raw[key])) continue;
    const entries = keptEntries(raw[key]);
    if (entries.length > maxEntries) return `${name(key)} has ${entries.length} entries; the limit is ${maxEntries}`;
    const index = entries.findIndex((e) => e.length > maxChars);
    if (index >= 0) return `${name(`${key}[${index}]`)} is ${entries[index].length} characters; the limit is ${maxChars} - ${SPLIT_HINT}`;
  }
  return null;
}

/** Valid unique tags in `raw`, uncapped (cleanTags stops at MAX_TAGS). */
const countTags = (raw) => new Set((Array.isArray(raw) ? raw : []).map(cleanTag).filter(Boolean)).size;

/**
 * Why normalizeTodo() would cut this raw card, or null when every field fits.
 * Lengths are measured after the trim normalizeTodo applies.
 * @param {unknown} raw a card (or patch) from an untrusted writer
 * @param {string} [where] prefix for the field name, e.g. 'tasks[2]' or 'patch'
 * @returns {string|null} e.g. "tasks[2].details is 20001 characters; the limit is 20000 - ..."
 */
function cardLimitError(raw, where = '') {
  if (!raw || typeof raw !== 'object') return null;
  const name = (key) => (where ? `${where}.${key}` : key);
  for (const [key, max] of STRING_LIMITS) {
    const length = typeof raw[key] === 'string' ? raw[key].trim().length : 0;
    if (length > max) return `${name(key)} is ${length} characters; the limit is ${max} - ${SPLIT_HINT}`;
  }
  const listError = listLimitError(raw, name);
  if (listError) return listError;
  const tags = countTags(raw.tags);
  if (tags > MAX_TAGS) return `${name('tags')} has ${tags} entries; the limit is ${MAX_TAGS}`;
  if (Array.isArray(raw.dependsOn) && raw.dependsOn.length > MAX_DEPENDS) {
    return `${name('dependsOn')} has ${raw.dependsOn.length} entries; the limit is ${MAX_DEPENDS}`;
  }
  return null;
}

// ---- copies an older build cut ----------------------------------------------
// Every device runs this file, but not the same version of it: an installed
// LunaCore that has not updated, or a phone holding a cached app build, still
// cuts at the caps it shipped with. When such a device touches a card (a tick,
// a tag), it publishes the CUT copy with a newer stamp, and newest-wins sync
// hands that copy to every machine. That is how the agy Live Map card
// (at=1795082538257) lost two of its three slices at exactly 4000 characters.
// These are the caps older builds applied; a newer copy whose field is the
// full field cut at one of them is a lossy copy, not an edit.
const LEGACY_CAPS = Object.freeze({
  // Before v0.29.0 (commit 7ec87d0): title 1000, details 4000.
  text: Object.freeze([1000]),
  original: Object.freeze([1000]),
  details: Object.freeze([4000]),
  // Before MAX_ACCEPTANCE_CHARS: every acceptance bullet shared the 300 cap.
  acceptance: Object.freeze([MAX_ENTRY_CHARS]),
});

/** Whether `cut` is `full` cut at one of the caps an older build applied to `key`. */
function isLegacyCut(key, cut, full) {
  return (
    typeof cut === 'string' &&
    typeof full === 'string' &&
    full.length > cut.length &&
    LEGACY_CAPS[key].includes(cut.length) &&
    full.startsWith(cut)
  );
}

/** Whether a bullet list is the full list with at least one bullet cut and nothing else changed. */
function isLegacyCutList(cut, full) {
  if (!Array.isArray(cut) || !Array.isArray(full) || cut.length !== full.length) return false;
  const each = cut.map((entry, i) => (entry === full[i] ? 'same' : isLegacyCut('acceptance', entry, full[i]) ? 'cut' : 'edit'));
  return !each.includes('edit') && each.includes('cut');
}

/**
 * A newer copy of a card with every field an older build cut put back from
 * the older, full copy. The newer copy's real changes (a tick, a tag) stay.
 * @param {object|null} older the full copy (this machine's)
 * @param {object} newer the copy that would win on its stamp
 * @returns {object} `newer` itself when nothing was cut, else a repaired copy
 */
function restoreLegacyCuts(older, newer) {
  if (!older || typeof older !== 'object' || !newer || typeof newer !== 'object') return newer;
  const restored = {};
  for (const key of ['text', 'original', 'details']) {
    if (isLegacyCut(key, newer[key], older[key])) restored[key] = older[key];
  }
  if (isLegacyCutList(newer.acceptance, older.acceptance)) restored.acceptance = older.acceptance;
  return Object.keys(restored).length ? { ...newer, ...restored } : newer;
}

/**
 * Sanitizes a whole list: drops malformed rows, applies the cap.
 * Unlike the clipboard history this does NOT dedupe - two identical reminders
 * are a legitimate thing to write down twice.
 */
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const todo = normalizeTodo(item);
    if (todo) out.push(todo);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * Validates the whole on-disk store: { [projectId]: TodoItem[] }. Unlike a
 * single list, a malformed store is not "start over" - one bad entry must
 * not cost every OTHER project its list, so bad keys/values are dropped
 * individually rather than failing the whole object.
 */
function normalizeStore(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!key) continue;
    out[key] = normalizeTodos(value);
  }
  return out;
}

module.exports = {
  normalizeTodo,
  normalizeCardFields,
  normalizeTodos,
  normalizeStore,
  cleanTags,
  runTag,
  SIZES,
  MODELS,
  MAX_DETAILS_CHARS,
  MAX_ITEMS,
  MAX_TEXT_CHARS,
  MAX_TAGS,
  MAX_LIST_ENTRIES,
  MAX_ACCEPTANCE_CHARS,
  MAX_ENTRY_CHARS,
  MAX_FILES,
  cardLimitError,
  restoreLegacyCuts,
  STEER_TAG,
  BUILT_STATE,
  CARD_STATES,
};
