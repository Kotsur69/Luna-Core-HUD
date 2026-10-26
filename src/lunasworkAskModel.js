// ============================================================================
// LunaCore - "Ask Luna about the run" (LW 2.27), the pure half
// ----------------------------------------------------------------------------
// Shared by the PC (src/lunasworkAsk.js) and the phone (mobile/src): no `fs`,
// no `path`, no child processes.
//
//   question   one line, trimmed, 1..MAX_QUESTION chars (cleanQuestion)
//   way in     the phone writes one unit into the existing `todos` cloud
//              scope under `lunaswork-ask:<id>` ({text}); the PC reads them
//              with asksFromTodoPeers after each pull - only Mati's own
//              account can write there
//   way back   the PC publishes its answered questions as the `asks` section
//              of its `godmode` snapshot (publicAsks); the phone reads it
//              with asksFrom. Every field is re-checked on both sides.
//   answer     capped text plus the sources it came from: a source name of
//              ALLOWED_SOURCES and, when it is about one, an iteration
// ============================================================================

'use strict';

const ASK_LIST_KEY = 'lunaswork-ask';
const MAX_QUESTION = 500;
const MAX_ANSWER = 2000;
const MAX_SOURCES = 6;
// Items kept in the store and published to the phone, newest last.
const MAX_ITEMS = 20;
// Questions per rolling hour, phone and HUD together - enforced on the PC.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const STATUSES = ['answering', 'answered', 'limited', 'failed'];
// The only things an answer may cite (the names the prompt gives them).
const ALLOWED_SOURCES = Object.freeze(['run-state', 'run-report', 'PLAYTEST_LOG.md', 'DECISIONS.md', 'rollbacks']);
const VERSION = 1;

const ID_RE = /^[1-9][0-9]{0,15}$/;
const MACHINE_RE = /^[A-Za-z0-9._ -]{1,64}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (v) => Number.isSafeInteger(v) && v > 0 && ID_RE.test(String(v));
const isTime = (v) => Number.isFinite(v) && v > 0;

/** One line: control characters and runs of whitespace become one space. */
// eslint-disable-next-line no-control-regex
const oneLine = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '');

/**
 * A question as the PC accepts it, or null: a string, at most twice the cap
 * before cleaning, 1..MAX_QUESTION chars after.
 * @param {unknown} raw
 * @returns {string|null}
 */
function cleanQuestion(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_QUESTION * 2) return null;
  const text = oneLine(raw);
  return text && text.length <= MAX_QUESTION ? text : null;
}

/** Answer text: line breaks kept, other control characters out, capped. */
function cleanAnswer(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_ANSWER);
}

/** The cited sources: known names only, an iteration when one is given, deduplicated. */
function cleanSources(raw) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(raw) ? raw.slice(0, MAX_SOURCES * 4) : []) {
    if (!isObj(s) || !ALLOWED_SOURCES.includes(s.file)) continue;
    const iteration = Number.isSafeInteger(s.iteration) && s.iteration >= 0 && s.iteration < 100000 ? s.iteration : null;
    const key = `${s.file}#${iteration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(iteration === null ? { file: s.file } : { file: s.file, iteration });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

/** One stored / published item, or null. */
function cleanItem(raw) {
  if (!isObj(raw) || !validId(raw.id) || !STATUSES.includes(raw.status)) return null;
  const question = cleanQuestion(raw.question);
  if (!question) return null;
  return {
    id: raw.id,
    question,
    status: raw.status,
    answer: cleanAnswer(raw.answer),
    sources: cleanSources(raw.sources),
    from: raw.from === 'phone' ? 'phone' : 'hud',
    at: isTime(raw.at) ? raw.at : raw.id,
  };
}

/** The items as a list: valid ones only, unique ids, oldest first, the last MAX_ITEMS. */
function cleanItems(raw) {
  const byId = new Map();
  for (const item of (Array.isArray(raw) ? raw.slice(-MAX_ITEMS * 4) : []).map(cleanItem)) {
    if (item) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-MAX_ITEMS);
}

/**
 * The `asks` section of the `godmode` snapshot, or null when there is nothing.
 * @param {object[]} items
 * @returns {{v:number, items:object[]}|null}
 */
function publicAsks(items) {
  const list = cleanItems(items);
  return list.length ? { v: VERSION, items: list } : null;
}

/** The `todos` cloud key the phone writes a question under. */
const askKey = (id) => `${ASK_LIST_KEY}:${id}`;

/**
 * A phone question as a cloud unit for the `todos` scope, or null when the
 * PC would refuse it.
 * @param {string} text
 * @param {number} [now]
 * @returns {{k:string, v:{text:string}, u:number, d:null}|null}
 */
function askUnit(text, now = Date.now()) {
  const clean = cleanQuestion(text);
  const id = Math.floor(now);
  if (!clean || !validId(id)) return null;
  return { k: askKey(id), v: { text: clean }, u: id, d: null };
}

/**
 * The phone's questions in the `todos` peers (cloudrows.todoPeer shape:
 * `{'lunaswork-ask': {items:[{text, at}]}}`), oldest first. Malformed ones
 * are dropped and every text goes through cleanQuestion again.
 * @param {unknown} peers
 * @returns {{id:number, text:string}[]}
 */
function asksFromTodoPeers(peers) {
  const out = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    const list = isObj(peer) && Object.hasOwn(peer, ASK_LIST_KEY) && isObj(peer[ASK_LIST_KEY]) ? peer[ASK_LIST_KEY].items : null;
    for (const item of Array.isArray(list) ? list.slice(0, MAX_ITEMS * 20) : []) {
      if (!isObj(item) || !validId(item.at)) continue;
      const text = cleanQuestion(item.text);
      if (text) out.push({ id: item.at, text });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * The phone's reader: the newest PC's `asks` section with its machine, or null.
 * @param {object[]} rows parsed `godmode` rows ({machine, data})
 * @returns {{machine:string, items:object[]}|null}
 */
function asksFrom(rows) {
  const newest = (items) => items[items.length - 1].at;
  const found = (Array.isArray(rows) ? rows : [])
    .filter((r) => isObj(r) && typeof r.machine === 'string' && MACHINE_RE.test(r.machine) && isObj(r.data) && isObj(r.data.asks))
    .map((r) => ({ machine: r.machine, items: cleanItems(r.data.asks.items) }))
    .filter((r) => r.items.length)
    .sort((a, b) => newest(b.items) - newest(a.items));
  return found[0] || null;
}

/**
 * The rate limiter's decision: the times still inside the window and
 * whether one more question fits.
 * @param {number[]} window accepted-question times
 * @param {number} now
 * @returns {{ok:boolean, window:number[], retryAt:number|null}}
 */
function rateCheck(window, now) {
  const recent = (Array.isArray(window) ? window : []).filter((t) => isTime(t) && t <= now && now - t < RATE_WINDOW_MS).sort((a, b) => a - b);
  if (recent.length < RATE_LIMIT) return { ok: true, window: recent, retryAt: null };
  return { ok: false, window: recent, retryAt: recent[recent.length - RATE_LIMIT] + RATE_WINDOW_MS };
}

module.exports = {
  ASK_LIST_KEY,
  MAX_QUESTION,
  MAX_ANSWER,
  MAX_SOURCES,
  MAX_ITEMS,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  STATUSES,
  ALLOWED_SOURCES,
  cleanQuestion,
  cleanAnswer,
  cleanSources,
  cleanItems,
  publicAsks,
  askKey,
  askUnit,
  asksFromTodoPeers,
  asksFrom,
  rateCheck,
};
