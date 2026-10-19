// ============================================================================
// LunaCore - Life dashboard: budget store (main process)
// ----------------------------------------------------------------------------
// config/life-budget.local.json (gitignored by the *.local.json rule):
//   currency:   'PLN'
//   income:     {amount, payday 1-31}
//   categories: [{id, name, kind 'planned'|'free', plan}]  name '' = a
//               built-in one, localized by id in the renderer. 'planned' =
//               a monthly envelope (food, fuel): its plan is set aside from
//               free money up front. 'free' = quick spending (snacks, fun)
//               that comes straight out of free money. Older files with
//               {limit} migrate: limit > 0 -> planned with plan = limit.
//   expenses:   [{id, date 'YYYY-MM-DD', amount, category, note}]
//   bills:      [{id, name, expected, dueDay 1-31,
//                 kind 'bill'|'subscription'|'saving', every 'month'|'year',
//                 month 1-12 (yearly only, else 0), category, goal}]
//               'saving' = a planned monthly transfer (Revolut Investing):
//               counted out of free money like a bill, but as saved, not
//               spent; `goal` optionally names the pot it grows.
//   payments:   {'YYYY-MM': {billId: {amount, paidOn 'YYYY-MM-DD'}}}  the
//               actual amount paid, editable after the fact (expected 400,
//               paid 200)
//   goals:      [{id, name, target (0 = open-ended pot), saved (starting
//                balance), by 'YYYY-MM' | ''}]
//   deposits:   [{id, date, goal, amount, note}]  one-off "+ Save" entries,
//               kept as rows so a mistaken deposit can be deleted
//
// Same contract as the other config loaders: safe read, validate at the
// boundary, a broken file yields the default store rather than a crash; a
// hand-edited file keeps only its valid rows. Every write goes through
// apply(op, data): a fixed op table, each op validates its whole payload and
// throws on bad input. Row ids are minted here, never taken from the renderer
// on create.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { defaults, normalize, applyOp, OP_NAMES } = require('./lifebudgetrows');

const FILE_NAME = 'life-budget.local.json';

const defaultFile = () => paths.local(FILE_NAME);

/** For display: never throws, a missing or broken file shows the defaults. */
function loadBudget(file = defaultFile()) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return defaults();
  }
}

const rowCount = (b) => ['categories', 'expenses', 'bills', 'goals', 'deposits'].reduce((n, k) => n + (Array.isArray(b && b[k]) ? b[k].length : 0), 0);

/**
 * For writes: only a MISSING file means "start from the defaults". Any other
 * read or parse failure (antivirus / sync lock, a half-written file) throws,
 * so the write that follows can never replace real data with an empty store.
 * `lossy` = normalizing dropped rows a hand edit broke (the caller backs up).
 */
function loadForWrite(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { budget: defaults(), text: null, lossy: false };
    throw new Error('unreadable');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('unreadable');
  }
  const budget = normalize(raw);
  const lossy = Array.isArray(raw && raw.categories) ? rowCount(raw) !== rowCount(budget) : rowCount(raw) !== rowCount(budget) - budget.categories.length;
  return { budget, text, lossy };
}

/**
 * A file next to the budget, still named *.local.json so the config/ gitignore
 * rule covers it: life-budget.local.json -> life-budget.<tag>.local.json.
 */
function sibling(file, tag) {
  return file.endsWith('.local.json') ? `${file.slice(0, -'.local.json'.length)}.${tag}.local.json` : `${file}.${tag}`;
}

/** Temp file + rename: a crash mid-write never leaves a truncated budget. */
function save(next, file) {
  if (file === defaultFile()) paths.ensureUserDir();
  const tmp = sibling(file, `${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return next;
}

/**
 * Applies one validated change and saves. Throws on a bad op or payload.
 * @returns {object} the new store
 */
function apply(op, data, file = defaultFile(), nowMs = Date.now()) {
  // A bad op or payload is refused before the file is read, as it always was.
  if (!OP_NAMES.includes(op)) throw new Error('bad op');
  if (!data || typeof data !== 'object') throw new Error('bad payload');
  const { budget, text, lossy } = loadForWrite(file);
  const next = applyOp(budget, op, data, nowMs);
  // This write would persist rows a hand edit broke: keep the original first.
  if (lossy && text !== null) fs.writeFileSync(sibling(file, 'bak'), text, 'utf8');
  return save(next, file);
}

/**
 * For the sync with other PCs (src/lifesync.js): the whole store as it is on
 * disk. Same rule as apply(): only a missing file counts as empty
 * (`exists: false`); an unreadable one throws, so a sync can never mistake a
 * locked file for "everything was deleted". `suspect` = the file parses but
 * is not what save() writes (a hand edit dropped rows, or `{}`): a sync must
 * not publish that as deletions.
 * @returns {{budget: object, exists: boolean, suspect: boolean, mtimeMs: number}}
 */
function readForSync(file = defaultFile()) {
  const { budget, text, lossy } = loadForWrite(file);
  if (text === null) return { budget, exists: false, suspect: false, mtimeMs: 0 };
  const raw = JSON.parse(text);
  const shaped = Boolean(raw) && typeof raw === 'object' && ['categories', 'expenses', 'bills', 'goals', 'deposits'].every((k) => Array.isArray(raw[k]));
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // Gone between the read and the stat: the read is what counts.
  }
  return { budget, exists: true, suspect: lossy || !shaped, mtimeMs };
}

/** Replaces the whole store (a sync merge), validated like a loaded file. */
function replaceBudget(raw, file = defaultFile()) {
  const { text, lossy } = loadForWrite(file);
  if (lossy && text !== null) fs.writeFileSync(sibling(file, 'bak'), text, 'utf8');
  return save(normalize(raw), file);
}

module.exports = { loadBudget, apply, normalize, readForSync, replaceBudget, OP_NAMES };
