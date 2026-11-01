// ============================================================================
// LunaCore - Luna's Work mid-run feedback (docs/LUNAS_WORK_PLAN.md B17)
// ----------------------------------------------------------------------------
// The run NEVER pauses for feedback. Mati (or later a client) gives input
// whenever he looks at the run; the next iteration plans it in. This module
// is the pure half - no timers, no IO; the run controller (src/lunaswork.js)
// keeps the items inside the stored run.
//
//   channels  a steer card from the phone (exists, src/lunasworkipc.js) and
//             the feedback link in the run emails, which opens the phone /
//             web app's feedback form. The form writes one unit into the
//             existing `todos` cloud scope under `lunaswork-feedback:<id>`
//             ({runId, text}); only Mati's own account can write there, so
//             the author of such an item is always Mati. The third channel
//             is the client widget on a staging build (src/lunasworkWidget.js):
//             its items are always author `client`, with context lines
//             (withContext) that the card shows and triage skips.
//   store     createItem / restoreFeedback: {id, author, text (capped),
//             createdAt, status, parts} per run
//   triage    triageText: free text -> parts, one card each ("the header is
//             too big and the PDF export is missing" -> a look card and a
//             scope card). Rule-based, done at the start of every iteration.
//             look / bug parts become cards straight away, tagged `feedback`,
//             which the Director schedules right after Mati's steer cards.
//             A scope part becomes a card held by a decision (scopeDecision).
//   trust     Mati's feedback can change anything: his scope change goes
//             through the queue with `approve` as the default. A client's
//             scope change waits for Mati's yes - `clientScope`, no default,
//             the rest of the run continues. Client look / bug cards go in
//             directly, like Mati's.
//   status    itemStatus: new -> planned -> built -> verified, from the cards
//             behind the item; `waiting` while a scope decision is pending,
//             `declined` once it was refused, `noted` for praise only
//   phone     publicFeedback (the snapshot the phone reads, also its reader
//             side), feedbackUnit (the way in) and feedbackFromTodoPeers
//   email     emailLines: per-item status and the feedback link
//
// No `fs` / `path`: the phone imports this module too.
// ============================================================================

'use strict';

const { APPROVE, REJECT } = require('./lunasworkDecisions');
const { cleanWheel } = require('./lunasworkWheel');

const AUTHORS = ['mati', 'client'];
const STATUSES = ['new', 'waiting', 'planned', 'built', 'verified', 'declined', 'noted'];
const PART_TYPES = ['look', 'bug', 'scope'];
// Card tags: every feedback card, and who it came from (trust rules).
const FEEDBACK_TAG = 'feedback';
const FROM_MATI_TAG = 'from:mati';
const FROM_CLIENT_TAG = 'from:client';
const FEEDBACK_LIST_KEY = 'lunaswork-feedback';
// The phone / web app; the feedback form sits on its God Mode page.
const FEEDBACK_URL = 'https://luna-core-hud.vercel.app/#godmode';

const MAX_TEXT = 1000;
const MAX_PART_TEXT = 300;
const MAX_PARTS = 8;
// Items kept per run; an item that would go past it is refused.
const MAX_ITEMS = 100;
const MAX_PUBLIC = 30;
const MIN_FRAGMENT_WORDS = 3;
const MAX_PRAISE_WORDS = 6;

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const ID_RE = /^[1-9][0-9]{0,15}$/;

// The card each part becomes (Critic card shape, src/lunasworkCritic.js).
const PART_CARD = Object.freeze({
  look: { kind: 'feel', severity: 'medium' },
  bug: { kind: 'bug', severity: 'high' },
  scope: { kind: 'missing', severity: 'medium' },
});
const STATUS_RANK = { new: 0, waiting: 1, planned: 2, built: 3, verified: 4 };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => Number.isFinite(v) && v > 0;
const validId = (v) => Number.isSafeInteger(v) && v > 0 && ID_RE.test(String(v));
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/** Feedback text: control characters out, line breaks kept (they split parts), capped. */
function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT);
}

// Context lines LunaCore appends to a client widget item (src/lunasworkWidget.js):
// they reach the card's details, never triage, so a page path is never a card.
const CONTEXT_LINE_RE = /^\[(?:page|screenshot)\] /;
const MAX_CONTEXT_CHARS = 200;

/**
 * Client text with its context lines: the page it was sent from and the
 * screenshot file. The text is cut first, so the lines always fit MAX_TEXT.
 * Client lines that look like context lines are dropped: only LunaCore adds them.
 * @param {string} text
 * @param {{page?:string|null, screenshot?:string|null}} [ctx]
 * @returns {string}
 */
function withContext(text, ctx = {}) {
  const lines = [
    ctx.page ? `[page] ${oneLine(ctx.page, MAX_CONTEXT_CHARS)}` : null,
    ctx.screenshot ? `[screenshot] ${oneLine(ctx.screenshot, MAX_CONTEXT_CHARS)}` : null,
  ].filter(Boolean);
  const room = MAX_TEXT - lines.reduce((n, l) => n + l.length + 1, 0);
  const own = cleanText(text)
    .split('\n')
    .filter((line) => !CONTEXT_LINE_RE.test(line))
    .join('\n');
  return [own.slice(0, room).trim(), ...lines].filter(Boolean).join('\n');
}

// ---- triage ---------------------------------------------------------------------

const LEADING_JOIN_RE = /^(?:but|and|also|plus|ale|oraz|i|a)\s+/i;
const JOIN_RE = /(\s+(?:but|and|also|plus|ale|oraz|i)\s+)/i;
const PRAISE_RE =
  /^(?:(?:it|this|that|everything|all)\s+)?(?:(?:looks?|is|works?|seems?)\s+)?(?:really\s+|very\s+|so\s+|pretty\s+)?(?:good|great|nice|fine|ok|okay|awesome|perfect|cool|lovely|amazing|super|swietnie|świetnie|dobrze|fajnie)\b|^(?:thanks?|thank you|love it|well done|good job|nice work|dzieki|dzięki|dziekuje|dziękuję)\b/i;

const SCOPE_RE =
  /\bmissing\b|(?:^|please\s+|could you\s+|can you\s+|should\s+|we need to\s+)add\b|\bnew (?:feature|page|screen|section|option)\b|\b(?:feature|integration|integrate|export|import)\b|\b(?:remove|drop|get rid of)\b|\binstead of\b|\bshould (?:also|have|be able|support|let)\b|\b(?:would like|i want|we want)\b|\bscope\b|\bbrief(?:\.md)?\b|\bbrakuje\b|\bbrak\b|\bdodaj\w*|\bpotrzeb\w*|\busu[nń]\w*|\bzamiast\b|\bnowa funkcj\w*/i;
const BUG_RE =
  /\b(?:bug|broken|breaks?|crash\w*|errors?|exception|fail\w*|not working|doesn'?t work|does not work|won'?t (?:load|open|save|work)|can'?t|cannot|404|500|freez\w*|hangs?|stuck|blank|wrong|glitch\w*)\b|nie dzia\w*|b[lł][aą]d\w*|wywala\w*|zepsu\w*/i;
const LOOK_RE =
  /\btoo (?:big|small|large|tiny|wide|narrow|bright|dark|long|short|close|far)\b|\b(?:fonts?|colou?rs?|spacing|padding|margins?|align\w*|ugly|looks?|layout|style|bold|contrast|icons?|size|smaller|bigger|larger|darker|lighter|centered|overlap\w*)\b|za (?:du[zż]\w*|ma[lł]\w*)|kolor\w*|czcionk\w*|odst[eę]p\w*|wygl[aą]d\w*|brzydk\w*/i;

/**
 * The kind of one feedback fragment, or null for praise. Scope wins over a
 * bug or a look word, and an unknown fragment counts as scope: neither can
 * slip a client's scope change past Mati.
 * @param {string} fragment
 * @returns {'look'|'bug'|'scope'|null}
 */
function classify(fragment) {
  const text = oneLine(fragment, MAX_PART_TEXT);
  if (!text) return null;
  if (words(text) <= MAX_PRAISE_WORDS && PRAISE_RE.test(text) && !SCOPE_RE.test(text) && !BUG_RE.test(text)) return null;
  if (SCOPE_RE.test(text)) return 'scope';
  if (BUG_RE.test(text)) return 'bug';
  if (LOOK_RE.test(text)) return 'look';
  return 'scope';
}

/**
 * Comma-separated clauses: a clause shorter than MIN_FRAGMENT_WORDS stays
 * with the one before ("make it smaller, bolder" is one clause). Praise
 * never takes a neighbour in.
 */
function foldClauses(pieces) {
  const out = [];
  for (const raw of pieces) {
    const piece = raw.trim().replace(LEADING_JOIN_RE, '').trim();
    if (!piece) continue;
    const last = out.length ? out[out.length - 1] : null;
    if (last !== null && words(piece) < MIN_FRAGMENT_WORDS && classify(last) !== null) out[out.length - 1] = `${last}, ${piece}`;
    else out.push(piece);
  }
  return out;
}

/**
 * Splits one clause on and / but, keeping short pieces together ("header
 * and footer are too big" stays one, "the header is too big and the export
 * is missing" becomes two).
 */
function splitJoins(clause) {
  const bits = clause.split(JOIN_RE);
  const out = [];
  let current = bits[0].trim();
  for (let i = 1; i < bits.length; i += 2) {
    const next = (bits[i + 1] || '').trim();
    if (words(current) >= MIN_FRAGMENT_WORDS && words(next) >= MIN_FRAGMENT_WORDS) {
      out.push(current);
      current = next;
    } else {
      current = `${current}${bits[i]}${next}`.trim();
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Free text -> the parts the Critic files as cards, in reading order.
 * Praise is dropped; past MAX_PARTS the rest joins the last part.
 * @param {string} text
 * @returns {Array<{type:'look'|'bug'|'scope', text:string}>}
 */
function triageText(text) {
  const clean = cleanText(text)
    .split('\n')
    .filter((line) => !CONTEXT_LINE_RE.test(line))
    .join('\n');
  if (!clean) return [];
  const clauses = foldClauses(clean.split(/[\n;!?]+|\.(?=\s|$)|,/));
  const kept = clauses.flatMap(splitJoins).filter((f) => classify(f) !== null);
  const capped = kept.length > MAX_PARTS ? [...kept.slice(0, MAX_PARTS - 1), kept.slice(MAX_PARTS - 1).join('; ')] : kept;
  return capped.map((f) => ({ type: classify(f), text: oneLine(f, MAX_PART_TEXT) }));
}

// ---- cards + decisions ------------------------------------------------------------

const capitalized = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const whoOf = (author) => (author === 'client' ? 'Client' : 'Mati');
const quote = (s) => s.replace(/"/g, "'");

/**
 * The card a part becomes (lunasworkCards.fileCards / Critic applyCards
 * shape), tagged `feedback` and with its author.
 * @param {{type:string, text:string}} part
 * @param {{id:number, author:string, text:string}} item
 */
function cardFor(part, item) {
  const { kind, severity } = PART_CARD[part.type] || PART_CARD.scope;
  const acceptance = [`Checked in the running app: "${quote(part.text)}" is resolved`];
  if (part.type === 'bug') acceptance.push('A test reproduces the bug (fails before the fix, passes after)');
  return {
    kind,
    severity,
    text: capitalized(part.text),
    details: `${whoOf(item.author)}'s feedback #${item.id} (${part.type}): "${quote(oneLine(item.text, MAX_TEXT))}"`,
    acceptance,
    files: [],
    updatesCardId: null,
    splitsCardId: null,
    extraTags: [FEEDBACK_TAG, item.author === 'client' ? FROM_CLIENT_TAG : FROM_MATI_TAG],
  };
}

/**
 * The decision that holds a scope part's card. Mati's own scope change
 * defaults to approve; a client's waits for Mati with no default.
 * @returns {object} lunasworkDecisions.createDecision spec
 */
function scopeDecision(part, item, at) {
  const question = `${whoOf(item.author)} feedback asks for a scope change: ${part.text}`;
  if (item.author === 'client') {
    return { kind: 'clientScope', question, detail: 'scope change from a client - waits for your yes', cardIds: [at] };
  }
  return {
    kind: 'feedbackScope',
    question,
    detail: 'your feedback changes the scope - approved unless you say no',
    options: [APPROVE, REJECT],
    defaultAnswer: APPROVE,
    cardIds: [at],
  };
}

/** Whether a card is a feedback card from Mati (his feedback may change anything). */
const isMatiFeedbackCard = (card) => isObj(card) && Array.isArray(card.tags) && card.tags.includes(FROM_MATI_TAG);

// ---- the store --------------------------------------------------------------------

const cleanAt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

function cleanPart(raw) {
  if (!isObj(raw) || !PART_TYPES.includes(raw.type)) return null;
  const text = oneLine(raw.text, MAX_PART_TEXT);
  if (!text) return null;
  return { type: raw.type, text, at: cleanAt(raw.at), decisionId: raw.type === 'scope' && validId(raw.decisionId) ? raw.decisionId : null };
}

/** One item read back from the stored run, or null. */
function cleanItem(raw) {
  if (!isObj(raw) || !validId(raw.id) || !AUTHORS.includes(raw.author)) return null;
  const text = cleanText(raw.text);
  if (!text) return null;
  // null = not triaged yet; [] = praise only.
  const parts = Array.isArray(raw.parts) ? raw.parts.slice(0, MAX_PARTS).map(cleanPart).filter(Boolean) : null;
  return {
    id: raw.id,
    author: raw.author,
    text,
    createdAt: isTime(raw.createdAt) ? raw.createdAt : raw.id,
    status: parts !== null && STATUSES.includes(raw.status) ? raw.status : 'new',
    parts,
    triagedAt: parts !== null && isTime(raw.triagedAt) ? raw.triagedAt : null,
  };
}

/**
 * A new feedback item, or why not.
 * @param {{text:string, author?:string, id?:number}} spec untrusted; id = the phone unit's key
 * @param {{now:number, list:object[]}} ctx list = the run's items (ids stay unique)
 * @returns {{ok:true, item:object}|{ok:false, error:string}}
 */
function createItem(spec, ctx) {
  if (!isObj(spec)) return { ok: false, error: 'badFeedback' };
  const list = Array.isArray(ctx.list) ? ctx.list : [];
  if (list.length >= MAX_ITEMS) return { ok: false, error: 'feedbackFull' };
  const author = spec.author === undefined ? 'mati' : spec.author;
  if (!AUTHORS.includes(author)) return { ok: false, error: 'badAuthor' };
  const text = cleanText(spec.text);
  if (!text) return { ok: false, error: 'badText' };
  if (spec.id !== undefined && !validId(spec.id)) return { ok: false, error: 'badId' };
  if (spec.id !== undefined && list.some((i) => i.id === spec.id)) return { ok: false, error: 'duplicate' };
  // Unique and increasing, like a decision id: two items in one ms still differ.
  const id = spec.id !== undefined ? spec.id : Math.max(Math.floor(ctx.now), ...list.map((i) => i.id + 1));
  return { ok: true, item: { id, author, text, createdAt: ctx.now, status: 'new', parts: null, triagedAt: null } };
}

/**
 * The run's items read back from disk: well-formed, unique ids, oldest first.
 * @returns {object[]}
 */
function restoreFeedback(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_ITEMS * 2)
    .map(cleanItem)
    .filter((i) => i && !seen.has(i.id) && seen.add(i.id))
    .sort((a, b) => a.id - b.id)
    .slice(0, MAX_ITEMS);
}

const needsTriage = (item) => item.parts === null;

/** Scope parts with a card but no decision yet (the queue refused it): held until asked. */
function unaskedScopeCards(list) {
  return list.flatMap((i) => (i.parts || []).filter((p) => p.type === 'scope' && p.at !== null && p.decisionId === null).map((p) => p.at));
}

// ---- status -----------------------------------------------------------------------

const HOLD_ANSWERS = new Set([REJECT, 'no']);

/**
 * The status of one part. A held scope part is `waiting` / `declined`;
 * otherwise its card decides: open -> planned, built -> built, done ->
 * verified. A card no longer in the store counts as planned.
 */
function partStatus(part, cards, decisions) {
  if (part.at === null) return null;
  if (part.type === 'scope') {
    const d = part.decisionId === null ? null : decisions.find((x) => x.id === part.decisionId);
    if (!d || d.status === 'pending') return 'waiting';
    if (HOLD_ANSWERS.has(d.answer)) return 'declined';
  }
  const state = cards.get(part.at);
  if (state === 'done') return 'verified';
  if (state === 'built') return 'built';
  return 'planned';
}

/**
 * An item's status: the least advanced of its parts that still count.
 * @param {object} item
 * @param {{cards:Map<number,'open'|'built'|'done'>, decisions:object[]}} ctx
 * @returns {string}
 */
function itemStatus(item, ctx) {
  if (item.parts === null) return 'new';
  const cards = ctx.cards instanceof Map ? ctx.cards : new Map();
  const decisions = Array.isArray(ctx.decisions) ? ctx.decisions : [];
  const all = item.parts.map((p) => partStatus(p, cards, decisions)).filter(Boolean);
  if (!all.length) return 'noted';
  const live = all.filter((s) => s !== 'declined');
  if (!live.length) return 'declined';
  return live.reduce((low, s) => (STATUS_RANK[s] < STATUS_RANK[low] ? s : low));
}

/**
 * The items with fresh statuses.
 * @returns {{list:object[], changed:object[]}} changed = the items whose status moved
 */
function withStatuses(list, ctx) {
  const changed = [];
  const next = list.map((item) => {
    const status = itemStatus(item, ctx);
    if (status === item.status) return item;
    const moved = { ...item, status };
    changed.push(moved);
    return moved;
  });
  return { list: changed.length ? next : list, changed };
}

/** Every card `at` the items point at. */
const cardAts = (list) => [...new Set(list.flatMap((i) => (i.parts || []).map((p) => p.at).filter((at) => at !== null)))];

// ---- phone ------------------------------------------------------------------------

/**
 * One item as the phone sees it - the writer side of the snapshot (a stored
 * item: `cards` counted from its parts), and the reader side for a row
 * another machine wrote. Null drops it.
 */
function publicItem(raw) {
  if (!isObj(raw) || !validId(raw.id) || !AUTHORS.includes(raw.author) || !STATUSES.includes(raw.status)) return null;
  const text = oneLine(raw.text, MAX_TEXT);
  if (!text) return null;
  const cards = Array.isArray(raw.parts)
    ? raw.parts.filter((p) => isObj(p) && cleanAt(p.at) !== null).length
    : Number.isInteger(raw.cards) ? raw.cards : 0;
  return {
    id: raw.id,
    author: raw.author,
    text,
    status: raw.status,
    createdAt: isTime(raw.createdAt) ? raw.createdAt : null,
    cards: Math.max(0, Math.min(MAX_PARTS, cards)),
  };
}

/**
 * The feedback section of the phone snapshot: the run it is for (the form
 * needs it even before any item), its newest items, and who has the wheel
 * (C11, lunasworkWheel - the phone's hand / hand-back button), or null.
 * @param {unknown} raw {runId, repoName, items, wheel?}
 * @returns {{runId:string, repoName:string|null, items:object[], wheel:'running'|'requested'|'handed'}|null}
 */
function publicFeedback(raw) {
  if (!isObj(raw) || typeof raw.runId !== 'string' || !RUN_ID_RE.test(raw.runId)) return null;
  const seen = new Set();
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .slice(-MAX_ITEMS)
    .map(publicItem)
    .filter((i) => i && !seen.has(i.id) && seen.add(i.id))
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_PUBLIC);
  return { runId: raw.runId, repoName: oneLine(raw.repoName, 100) || null, items, wheel: cleanWheel(raw.wheel) };
}

/** The `todos` cloud key the phone writes a feedback item under. */
const feedbackKey = (id) => `${FEEDBACK_LIST_KEY}:${id}`;

/**
 * Feedback from the phone / web form as a cloud unit for the `todos` scope,
 * or null when the PC would refuse it.
 * @param {string} runId the run in the snapshot's feedback section
 * @param {string} text
 * @param {number} [now]
 * @returns {{k:string, v:{runId:string, text:string}, u:number, d:null}|null}
 */
function feedbackUnit(runId, text, now = Date.now()) {
  const clean = cleanText(text);
  const id = Math.floor(now);
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || !clean || !validId(id)) return null;
  return { k: feedbackKey(id), v: { runId, text: clean }, u: id, d: null };
}

/**
 * Raw feedback out of the cloud's `todos` peers (cloudrows.todoPeer output:
 * {<key>: {items:[{...v, at, u}]}}). Untrusted: the controller checks each
 * against its own run.
 * @returns {{id:number, runId:string, text:string}[]}
 */
function feedbackFromTodoPeers(peers) {
  const out = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    const list = isObj(peer) && Object.hasOwn(peer, FEEDBACK_LIST_KEY) && isObj(peer[FEEDBACK_LIST_KEY]) ? peer[FEEDBACK_LIST_KEY].items : null;
    for (const item of Array.isArray(list) ? list.slice(0, MAX_ITEMS * 4) : []) {
      if (!isObj(item) || !validId(item.at) || typeof item.runId !== 'string' || !RUN_ID_RE.test(item.runId)) continue;
      if (typeof item.text !== 'string' || item.text.length > MAX_TEXT * 2) continue;
      out.push({ id: item.at, runId: item.runId, text: item.text });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

// ---- email ------------------------------------------------------------------------

const STATUS_LABEL = {
  new: 'received, planned next iteration',
  waiting: 'waiting for your decision',
  planned: 'planned',
  built: 'built, not verified yet',
  verified: 'verified in the app',
  declined: 'declined',
  noted: 'noted (nothing to build)',
};

/**
 * The feedback block of a run email: one line per item with its status, and
 * the feedback link (the phone / web form).
 * @param {object[]} items the run's feedback
 * @param {{link?:string|null}} [opts] link: null leaves it out
 * @returns {string[]}
 */
function emailLines(items, opts = {}) {
  const list = (Array.isArray(items) ? items : []).map(cleanItem).filter(Boolean).slice(-MAX_PUBLIC);
  const link = opts.link === undefined ? FEEDBACK_URL : opts.link;
  const lines = ['FEEDBACK'];
  if (!list.length) lines.push('- none yet');
  for (const i of list) {
    lines.push(`- [${STATUS_LABEL[i.status]}] ${i.author === 'client' ? '(client) ' : ''}${oneLine(i.text, 200)}`);
  }
  if (link) lines.push('', `Send feedback while it runs: ${link}`);
  return lines;
}

module.exports = {
  AUTHORS,
  STATUSES,
  PART_TYPES,
  FEEDBACK_TAG,
  FROM_MATI_TAG,
  FROM_CLIENT_TAG,
  FEEDBACK_LIST_KEY,
  FEEDBACK_URL,
  MAX_TEXT,
  MAX_ITEMS,
  cleanText,
  withContext,
  classify,
  triageText,
  cardFor,
  scopeDecision,
  isMatiFeedbackCard,
  createItem,
  restoreFeedback,
  needsTriage,
  unaskedScopeCards,
  itemStatus,
  withStatuses,
  cardAts,
  publicItem,
  publicFeedback,
  feedbackKey,
  feedbackUnit,
  feedbackFromTodoPeers,
  emailLines,
};
