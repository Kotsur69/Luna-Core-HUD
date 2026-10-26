// ============================================================================
// LunaCore - Luna's Work decision queue (docs/LUNAS_WORK_PLAN.md idea #11, 1.6)
// ----------------------------------------------------------------------------
// Risky choices go to Mati's phone with a default answer and a deadline. The
// run never blocks on one: the cards a decision covers are held, every other
// card goes on. This module is the pure half - no timers, no IO; the run
// controller (src/lunaswork.js) keeps the queue inside the stored run.
//
//   triggers   needsDecision(change) - a new dependency in a manifest, a
//              schema / migration, deleting a feature, changing DESIGN.md
//              beyond an append, or a scope change from a client
//   queue      createDecision / answerDecision / expireDue / heldCards over
//              the run's list; restoreQueue for what comes back from disk
//   log        decisionLine - one DECISIONS.md line per answer, "answered by
//              Mati" or "default after deadline"
//   phone      publicDecision (the snapshot the phone reads, also its reader
//              side) and answersFromTodoPeers (the way back, see below)
//
// A stuck card (B4) or an out-of-scope card (B5) defaults to reject: the
// card stays parked and the run keeps to the design. A scope change from
// Mati's own feedback (B17, src/lunasworkFeedback.js) defaults to approve.
// Defaults are the choice that loses nothing: adding a dependency or a
// migration is approved (a checkpoint rollback reverts it), deleting a
// feature or rewriting DESIGN.md is rejected (it would lose what Mati asked
// for). A client's scope change has NO default: it waits for Mati, however
// long, while the rest of the run continues (B17 "Trust").
//
// The way back: the phone writes one unit into the existing `todos` cloud
// scope under `lunaswork-answer:<decision id>` ({runId, answer}). That key is
// not a project key (missionledgersync KEY_RE), so neither todosync on a PC
// nor the phone's to-do lists ever read it as a list. Rows are untrusted: the
// PC accepts only a pending decision id of the current run and only a listed
// option, or capped free text where the decision allows it.
//
// No `fs` / `path`: the phone imports this module too.
// ============================================================================

'use strict';

// stuckCard: a card that failed two iterations and the Critic did not split
// (B4). outOfScope: a card outside DESIGN.md / ROADMAP.md (B5). Both are
// asked by the controller, never by needsDecision(). designVariant (LW 2.25a)
// and prototype (LW 2.25b) are the toggles' own questions, asked by
// lunasworkVariantFlow / lunasworkPrototype with their own options.
const KINDS = [
  'dependency', 'migration', 'featureDelete', 'designChange', 'stuckCard', 'outOfScope', 'feedbackScope', 'clientScope',
  'designVariant', 'prototype', 'other',
];
const ANSWERED_BY = ['mati', 'default'];
const STATUSES = ['pending', 'answered'];

const MINUTE = 60 * 1000;
const DEFAULT_DEADLINE_MS = 2 * 60 * MINUTE;
const MIN_DEADLINE_MS = MINUTE;
const MAX_DEADLINE_MS = 7 * 24 * 60 * MINUTE;

const MAX_QUESTION = 500;
const MAX_DETAIL = 300;
const MAX_OPTION = 80;
const MAX_OPTIONS = 6;
const MAX_FREE_TEXT = 500;
const MAX_CARD_IDS = 20;
// Pending decisions are never dropped; answered ones are kept up to this many.
const MAX_ANSWERED = 100;
const MAX_PENDING = 50;
const MAX_CONTENT = 200000;
const MAX_FILES = 500;
const MAX_NAMES = 10;

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const ID_RE = /^[1-9][0-9]{0,15}$/;
const ANSWER_LIST_KEY = 'lunaswork-answer';

/** A card decision: approve to build the card, reject to keep it held for good. */
const APPROVE = 'approve';
const REJECT = 'reject';
const CARD_CHOICES = Object.freeze({
  dependency: { options: [APPROVE, REJECT], defaultAnswer: APPROVE },
  migration: { options: [APPROVE, REJECT], defaultAnswer: APPROVE },
  featureDelete: { options: [APPROVE, REJECT], defaultAnswer: REJECT },
  designChange: { options: [APPROVE, REJECT], defaultAnswer: REJECT },
  // approve = try the card again; the default keeps it parked.
  stuckCard: { options: [APPROVE, REJECT], defaultAnswer: REJECT },
  // approve = build it anyway; the default keeps the run inside the design.
  outOfScope: { options: [APPROVE, REJECT], defaultAnswer: REJECT },
  // B17: Mati's feedback may change anything; the queue only records it.
  feedbackScope: { options: [APPROVE, REJECT], defaultAnswer: APPROVE },
});
const CLIENT_OPTIONS = Object.freeze(['yes', 'no']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => Number.isFinite(v) && v > 0;
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const validId = (v) => Number.isSafeInteger(v) && v > 0 && ID_RE.test(String(v));

/** A decision id from a number or its digit string, or null. */
function idOf(v) {
  const n = typeof v === 'string' && ID_RE.test(v) ? Number(v) : v;
  return validId(n) ? n : null;
}

// ---- triggers ------------------------------------------------------------------

const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const baseName = (p) => normPath(p).split('/').filter(Boolean).pop() || '';

function statusOf(raw) {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (['a', 'added', 'new', 'created'].includes(s)) return 'added';
  if (['d', 'deleted', 'removed'].includes(s)) return 'deleted';
  return 'modified';
}

const content = (v) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').slice(0, MAX_CONTENT) : null);

/** Changed files as {path, status, before, after}; a plain string is a modified path. */
function fileChanges(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_FILES)
    .map((f) => {
      if (typeof f === 'string' && f) return { path: normPath(f), status: 'modified', before: null, after: null };
      if (!isObj(f) || typeof f.path !== 'string' || !f.path) return null;
      return { path: normPath(f.path), status: statusOf(f.status), before: content(f.before), after: content(f.after) };
    })
    .filter(Boolean);
}

function textOf(change) {
  return [change.text, change.details, change.notes].filter((t) => typeof t === 'string').join('\n').slice(0, MAX_CONTENT);
}

// -- dependencies --

const jsonDeps = (keys) => (text) => {
  try {
    const doc = JSON.parse(text);
    return isObj(doc) ? keys.flatMap((k) => (isObj(doc[k]) ? Object.keys(doc[k]) : [])) : null;
  } catch {
    return null;
  }
};

const matches = (re) => (text) => [...text.matchAll(re)].map((m) => m[1]);

/** Names under every TOML section whose header mentions dependencies (Cargo, poetry, Pipfile). */
function tomlDeps(text) {
  const out = [];
  let inDeps = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      inDeps = /dependencies|packages/i.test(header[1]);
      continue;
    }
    const name = inDeps && /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (name && name[1] !== 'python') out.push(name[1]);
  }
  // PEP 621 lists: dependencies = ["requests>=2", ...], one entry per line.
  for (const m of text.matchAll(/^\s*["']([A-Za-z0-9_.-]+)[^"'\n]*["']\s*,?\s*$/gm)) out.push(m[1]);
  return out;
}

/** Names under a `dependencies:` / `dev_dependencies:` block (pubspec). */
function yamlDeps(text) {
  const out = [];
  let inDeps = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inDeps = /^(dev_)?dependencies\s*:/.test(line);
    else if (inDeps) {
      const name = /^ {2}([A-Za-z0-9_]+)\s*:/.exec(line);
      if (name) out.push(name[1]);
    }
  }
  return out;
}

const MANIFESTS = [
  { test: (b) => b === 'package.json', names: jsonDeps(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) },
  { test: (b) => b === 'composer.json', names: jsonDeps(['require', 'require-dev']) },
  { test: (b) => /^requirements.*\.txt$/.test(b), names: matches(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/gm) },
  { test: (b) => b === 'go.mod', names: matches(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/\S+)\s+v\d/gm) },
  { test: (b) => b === 'cargo.toml' || b === 'pyproject.toml' || b === 'pipfile', names: tomlDeps },
  { test: (b) => b === 'gemfile', names: matches(/^\s*gem\s+['"]([^'"]+)['"]/gm) },
  { test: (b) => b === 'pubspec.yaml', names: yamlDeps },
  { test: (b) => b.endsWith('.csproj'), names: matches(/<PackageReference\s+Include="([^"]+)"/g) },
  { test: (b) => b === 'build.gradle' || b === 'build.gradle.kts', names: matches(/\b(?:implementation|api|compile|runtimeOnly|testImplementation)\s*\(?\s*['"]([^:'"]+:[^:'"]+)/g) },
  { test: (b) => b === 'pom.xml', names: matches(/<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g) },
];

const manifestOf = (p) => MANIFESTS.find((m) => m.test(baseName(p).toLowerCase())) || null;

/** Dependency names `after` has and `before` did not; null when the content cannot be read. */
function newDeps(manifest, before, after) {
  const now = manifest.names(after);
  if (!now) return null;
  const had = before === null ? [] : manifest.names(before) || [];
  const old = new Set(had.map((n) => n.toLowerCase()));
  return [...new Set(now)].filter((n) => !old.has(n.toLowerCase()));
}

const DEPENDENCY_TEXT_RE = new RegExp(
  [
    '\\b(?:install|add|introduce)\\s+(?:a\\s+|an\\s+|the\\s+)?(?:new\\s+)?(?:npm\\s+|pip\\s+|python\\s+|js\\s+)?(?:dependency|dependencies|package|library|crate|gem)\\b',
    '\\bnew\\s+(?:npm\\s+|pip\\s+)?(?:dependency|dependencies|library)\\b',
    '\\b(?:npm|pnpm|yarn)\\s+(?:add|install|i)\\s+[@a-z]',
    '\\bpip\\s+install\\s+[a-z]',
    '\\bcargo\\s+add\\b',
    '\\bgo\\s+get\\s+[a-z]',
  ].join('|'),
  'i',
);

function dependencyHit(files, text) {
  const names = [];
  for (const f of files) {
    const manifest = manifestOf(f.path);
    if (!manifest || f.status === 'deleted') continue;
    if (f.after !== null) {
      const added = newDeps(manifest, f.status === 'added' ? null : f.before, f.after);
      if (added && added.length) names.push(...added);
      else if (!added && f.status === 'added') names.push(baseName(f.path));
    } else if (f.status === 'added') {
      names.push(baseName(f.path));
    }
  }
  if (names.length) return `new dependency: ${[...new Set(names)].slice(0, MAX_NAMES).join(', ')}`;
  const m = DEPENDENCY_TEXT_RE.exec(text);
  return m ? `new dependency ("${oneLine(m[0], 60)}")` : null;
}

// -- schema / migrations --

const MIGRATION_PATH_RE = /(^|\/)migrations?\/|migrat|(^|\/)schema\.(prisma|sql|rb|graphql|gql)$|\.sql$|(^|\/)db\/schema/i;
const MIGRATION_TEXT_RE =
  /\b(?:migration|migrate the (?:db|database)|(?:database|db|table) schema|schema (?:change|migration)|alter table|create table|drop table|drop column|add (?:a )?column|new (?:db |database )?(?:column|table))\b/i;

function migrationHit(files, text) {
  const hit = files.find((f) => MIGRATION_PATH_RE.test(f.path));
  if (hit) return `schema / migration: ${baseName(hit.path)}`;
  const m = MIGRATION_TEXT_RE.exec(text);
  return m ? `schema / migration ("${oneLine(m[0], 60)}")` : null;
}

// -- deleting a feature --

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[a-z0-9]+$/i;
const NOT_A_FEATURE_RE = /\.(md|txt|log|lock|map)$|(^|\/)design\//i;
const FEATURE_DELETE_TEXT_RE =
  /\b(?:remove|delete|drop|rip out|get rid of)\s+(?:the\s+|a\s+|an\s+)?(?:[\w-]+\s+){0,3}?(?:feature|screen|page|view|endpoint|mode|flow|tab)s?\b/i;

function featureDeleteHit(files, text) {
  const gone = files.filter((f) => f.status === 'deleted' && !TEST_PATH_RE.test(f.path) && !NOT_A_FEATURE_RE.test(f.path));
  if (gone.length) return `deletes ${gone.slice(0, MAX_NAMES).map((f) => baseName(f.path)).join(', ')}`;
  const m = FEATURE_DELETE_TEXT_RE.exec(text);
  return m ? `deletes a feature ("${oneLine(m[0], 60)}")` : null;
}

// -- DESIGN.md beyond an append --

const isDesignDoc = (p) => /(^|\/)DESIGN\.md$/i.test(p);
const DESIGN_TEXT_RE =
  /\b(?:rewrite|rework|restructure|replace|edit|change|remove from|delete from)\b[^.\n]{0,40}\bDESIGN\.md\b|\bDESIGN\.md\b[^.\n]{0,20}\b(?:rewrite|rewritten|replaced|restructured)\b/i;

/** True when `after` is `before` with text added at the end, and nothing else. */
const isAppend = (before, after) => after.startsWith(before.replace(/\s+$/, ''));

function designHit(files, text) {
  for (const f of files.filter((x) => isDesignDoc(x.path))) {
    if (f.status === 'deleted') return 'deletes DESIGN.md';
    if (f.status === 'added') continue;
    // Without both versions an edit cannot be shown to be an append.
    if (f.before === null || f.after === null || !isAppend(f.before, f.after)) return 'changes DESIGN.md beyond an append';
  }
  const m = DESIGN_TEXT_RE.exec(text);
  return m ? `changes DESIGN.md ("${oneLine(m[0], 60)}")` : null;
}

const CHECKS = [
  ['designChange', designHit],
  ['featureDelete', featureDeleteHit],
  ['migration', migrationHit],
  ['dependency', dependencyHit],
];

/**
 * Whether a planned or made change must go through the decision queue.
 * Pure. The first matching kind wins, in the order: DESIGN.md, deleting a
 * feature, schema / migration, new dependency. A client's scope change
 * always does, with no default answer; Mati's own instructions never do.
 *
 * @param {{text?:string, details?:string, notes?:string,
 *   files?:Array<string|{path:string, status?:string, before?:string, after?:string}>,
 *   from?:'mati'|'client'|'director'|'critic', scope?:boolean}|null} change
 *   files: plain strings are modified paths (a card's predicted files); with
 *   before / after the content diff decides (manifests, DESIGN.md)
 * @returns {{kind:string, reason:string, options:string[], defaultAnswer:string|null, freeText:boolean}|null}
 */
function needsDecision(change) {
  if (!isObj(change)) return null;
  if (change.from === 'client' && change.scope === true) {
    return { kind: 'clientScope', reason: 'scope change from a client', options: [...CLIENT_OPTIONS], defaultAnswer: null, freeText: true };
  }
  // Mati's feedback can change anything (B17 "Trust").
  if (change.from === 'mati') return null;
  const files = fileChanges(change.files);
  const text = textOf(change);
  for (const [kind, check] of CHECKS) {
    const reason = check(files, text);
    if (reason) return { kind, reason, options: [...CARD_CHOICES[kind].options], defaultAnswer: CARD_CHOICES[kind].defaultAnswer, freeText: false };
  }
  return null;
}

// ---- the queue -------------------------------------------------------------------

function cleanOptions(raw) {
  const list = (Array.isArray(raw) ? raw : []).map((o) => oneLine(o, MAX_OPTION)).filter(Boolean);
  return [...new Set(list)].slice(0, MAX_OPTIONS);
}

const cardIdsOf = (raw) => [...new Set((Array.isArray(raw) ? raw : []).filter((at) => Number.isSafeInteger(at) && at > 0))].slice(0, MAX_CARD_IDS);

/** A free-text answer: one line, capped, never empty; null when unusable or too long. */
function freeTextOf(raw) {
  if (typeof raw !== 'string') return null;
  const text = oneLine(raw, MAX_FREE_TEXT + 1);
  return text && text.length <= MAX_FREE_TEXT ? text : null;
}

/**
 * A new pending decision, or why not.
 * @param {{question:string, options?:string[], defaultAnswer?:string|null, deadlineMs?:number,
 *   kind?:string, cardIds?:number[], detail?:string, freeText?:boolean}} spec
 * @param {{now:number, list:object[], iteration?:number}} ctx list = the run's queue (ids stay unique)
 * @returns {{ok:true, decision:object}|{ok:false, error:string}}
 */
function createDecision(spec, ctx) {
  if (!isObj(spec)) return { ok: false, error: 'badSpec' };
  const list = Array.isArray(ctx.list) ? ctx.list : [];
  if (pendingOf(list).length >= MAX_PENDING) return { ok: false, error: 'queueFull' };
  const kind = KINDS.includes(spec.kind) ? spec.kind : 'other';
  const question = oneLine(spec.question, MAX_QUESTION);
  if (!question) return { ok: false, error: 'badQuestion' };
  const client = kind === 'clientScope';
  const options = cleanOptions(spec.options === undefined && client ? CLIENT_OPTIONS : spec.options);
  if (!options.length) return { ok: false, error: 'badOptions' };
  // A client's scope change never defaults; everything else must.
  const defaultAnswer = client ? null : oneLine(spec.defaultAnswer, MAX_OPTION);
  if (!client && !options.includes(defaultAnswer)) return { ok: false, error: 'badDefault' };
  const span = Number.isFinite(spec.deadlineMs) ? Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, spec.deadlineMs)) : DEFAULT_DEADLINE_MS;
  // Unique and increasing, like a to-do `at`: two asks in one ms still differ.
  const id = Math.max(Math.floor(ctx.now), ...list.map((d) => d.id + 1));
  return {
    ok: true,
    decision: {
      id,
      kind,
      question,
      detail: oneLine(spec.detail, MAX_DETAIL) || null,
      options,
      defaultAnswer,
      freeText: client ? spec.freeText !== false : spec.freeText === true,
      askedAt: ctx.now,
      deadline: client ? null : ctx.now + span,
      iteration: Number.isInteger(ctx.iteration) ? ctx.iteration : 0,
      cardIds: cardIdsOf(spec.cardIds),
      status: 'pending',
      answer: null,
      answeredBy: null,
      answeredAt: null,
    },
  };
}

/**
 * The answer a pending decision accepts for `raw`, or null: a listed option
 * (exact), or capped free text where the decision allows it.
 */
function acceptedAnswer(decision, raw) {
  if (typeof raw !== 'string') return null;
  if (decision.options.includes(raw)) return raw;
  return decision.freeText ? freeTextOf(raw) : null;
}

/**
 * Applies one answer to the queue.
 * @param {object[]} list the run's queue
 * @param {{id:number|string, answer?:string}} raw untrusted (phone, renderer); no answer for a default
 * @param {{by:'mati'|'default', now:number}} ctx
 * @returns {{ok:true, list:object[], decision:object}|{ok:false, error:string}}
 */
function answerDecision(list, raw, ctx) {
  if (!isObj(raw)) return { ok: false, error: 'badAnswer' };
  if (!ANSWERED_BY.includes(ctx.by)) return { ok: false, error: 'badSource' };
  const id = idOf(raw.id);
  const current = id === null ? null : list.find((d) => d.id === id);
  if (!current) return { ok: false, error: 'unknownDecision' };
  if (current.status !== 'pending') return { ok: false, error: 'alreadyAnswered' };
  const answer = ctx.by === 'default' ? current.defaultAnswer : acceptedAnswer(current, raw.answer);
  if (answer === null || answer === undefined) return { ok: false, error: ctx.by === 'default' ? 'noDefault' : 'badAnswer' };
  const decision = { ...current, status: 'answered', answer, answeredBy: ctx.by, answeredAt: ctx.now };
  return { ok: true, list: list.map((d) => (d.id === id ? decision : d)), decision };
}

/** Pending decisions whose deadline passed and which have a default to take. */
function dueDecisions(list, now) {
  return list.filter((d) => d.status === 'pending' && d.defaultAnswer !== null && isTime(d.deadline) && d.deadline <= now);
}

/**
 * Takes the default of every decision past its deadline. A client scope
 * change (no default) stays pending.
 * @returns {{list:object[], answered:object[]}}
 */
function expireDue(list, now) {
  let next = list;
  const answered = [];
  for (const d of dueDecisions(list, now)) {
    const res = answerDecision(next, { id: d.id }, { by: 'default', now });
    if (!res.ok) continue;
    next = res.list;
    answered.push(res.decision);
  }
  return { list: next, answered };
}

/** The earliest deadline that will take a default, or null. */
function nextDeadline(list) {
  const times = list.filter((d) => d.status === 'pending' && d.defaultAnswer !== null && isTime(d.deadline)).map((d) => d.deadline);
  return times.length ? Math.min(...times) : null;
}

// Answers that keep a decision's cards out of the build for good.
const HOLD_ANSWERS = new Set([REJECT, 'no']);

/** True while a decision keeps its cards held: pending, or answered `reject` / `no`. */
function holdsCards(decision) {
  return decision.status === 'pending' || HOLD_ANSWERS.has(decision.answer);
}

/**
 * Cards the Director must not schedule: every card of a pending decision,
 * and the cards of a decision answered `reject` / `no` (held for good).
 * @returns {Set<number>}
 */
function heldCards(list) {
  const held = new Set();
  for (const d of list) {
    if (holdsCards(d)) for (const at of d.cardIds) held.add(at);
  }
  return held;
}

/** The newest decision that covers card `at`, or null. */
function decisionForCard(list, at) {
  return [...list].reverse().find((d) => d.cardIds.includes(at)) || null;
}

function pendingOf(list) {
  return list.filter((d) => d.status === 'pending');
}

/** One decision read back from the stored run, or null. */
function cleanDecision(raw) {
  if (!isObj(raw) || !validId(raw.id) || !STATUSES.includes(raw.status)) return null;
  const options = cleanOptions(raw.options);
  const question = oneLine(raw.question, MAX_QUESTION);
  if (!options.length || !question) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'other';
  const client = kind === 'clientScope';
  const defaultAnswer = !client && options.includes(raw.defaultAnswer) ? raw.defaultAnswer : null;
  // Only a client scope change may lack a default.
  if (!client && defaultAnswer === null) return null;
  const answered = raw.status === 'answered';
  const freeText = raw.freeText === true;
  // Free text only where the decision allowed it, as answerDecision does.
  const answer = !answered ? null : options.includes(raw.answer) ? raw.answer : freeText ? freeTextOf(raw.answer) : null;
  if (answered && (answer === null || !ANSWERED_BY.includes(raw.answeredBy))) return null;
  return {
    id: raw.id,
    kind,
    question,
    detail: oneLine(raw.detail, MAX_DETAIL) || null,
    options,
    defaultAnswer,
    freeText,
    askedAt: isTime(raw.askedAt) ? raw.askedAt : raw.id,
    deadline: client ? null : isTime(raw.deadline) ? raw.deadline : raw.id + DEFAULT_DEADLINE_MS,
    iteration: Number.isInteger(raw.iteration) && raw.iteration >= 0 ? raw.iteration : 0,
    cardIds: cardIdsOf(raw.cardIds),
    status: raw.status,
    answer,
    answeredBy: answered ? raw.answeredBy : null,
    answeredAt: answered && isTime(raw.answeredAt) ? raw.answeredAt : null,
  };
}

/** Keeps every pending decision and the newest MAX_ANSWERED answered ones. */
function trimQueue(list) {
  const answered = list.filter((d) => d.status === 'answered');
  const drop = new Set(answered.slice(0, Math.max(0, answered.length - MAX_ANSWERED)).map((d) => d.id));
  return list.filter((d) => !drop.has(d.id));
}

/**
 * The run's queue read back from disk: well-formed entries with unique ids,
 * oldest first, every pending one kept, at most MAX_ANSWERED answered ones.
 * @param {unknown} raw
 * @returns {object[]}
 */
function restoreQueue(raw) {
  const seen = new Set();
  const list = (Array.isArray(raw) ? raw : [])
    .map(cleanDecision)
    .filter((d) => d && !seen.has(d.id) && seen.add(d.id))
    .sort((a, b) => a.id - b.id);
  return trimQueue(list);
}

// ---- DECISIONS.md ---------------------------------------------------------------------

const quote = (s) => s.replace(/"/g, "'");

/** "2026-10-26 14:05 UTC" */
const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * The DECISIONS.md line for an answered decision.
 * @returns {string|null}
 */
function decisionLine(decision) {
  if (!isObj(decision) || decision.status !== 'answered') return null;
  const who = decision.answeredBy === 'default' ? 'default after deadline' : 'answered by Mati';
  const when = isTime(decision.answeredAt) ? `, ${utc(decision.answeredAt)}` : '';
  const detail = decision.detail ? ` (${quote(decision.detail)})` : '';
  const cards = decision.cardIds.length ? ` [cards ${decision.cardIds.join(', ')}]` : '';
  return `- Decision queue, ${decision.kind}: "${quote(decision.question)}"${detail} -> ${quote(decision.answer)} - ${who}${when}${cards}`;
}

// ---- phone ----------------------------------------------------------------------------

/**
 * A pending decision as the phone and the HUD see it - the writer side of the
 * snapshot, and the reader side for a row another machine wrote. Null drops it.
 * @param {unknown} raw a decision (or a published copy), plus runId / repoName
 * @returns {object|null}
 */
function publicDecision(raw) {
  if (!isObj(raw) || idOf(raw.id) === null) return null;
  if (raw.status !== undefined && raw.status !== 'pending') return null;
  const options = cleanOptions(raw.options);
  const question = oneLine(raw.question, MAX_QUESTION);
  if (!options.length || !question) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'other';
  const defaultAnswer = kind !== 'clientScope' && options.includes(raw.defaultAnswer) ? raw.defaultAnswer : null;
  return {
    id: idOf(raw.id),
    runId: typeof raw.runId === 'string' && RUN_ID_RE.test(raw.runId) ? raw.runId : null,
    repoName: oneLine(raw.repoName, 100) || null,
    kind,
    question,
    detail: oneLine(raw.detail, MAX_DETAIL) || null,
    options,
    defaultAnswer,
    freeText: raw.freeText === true,
    askedAt: isTime(raw.askedAt) ? raw.askedAt : null,
    deadline: defaultAnswer !== null && isTime(raw.deadline) ? raw.deadline : null,
    cardIds: cardIdsOf(raw.cardIds),
  };
}

/** A list of public decisions, oldest first, unique, capped. */
function publicDecisions(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_PENDING * 2)
    .map(publicDecision)
    .filter((d) => d && !seen.has(d.id) && seen.add(d.id))
    .sort((a, b) => a.id - b.id)
    .slice(0, MAX_PENDING);
}

/** The `todos` cloud key the phone writes an answer under. */
const answerKey = (id) => `${ANSWER_LIST_KEY}:${id}`;

/**
 * The phone's answer as a cloud unit for the `todos` scope, or null when the
 * decision would not accept it (so the phone never sends what the PC drops).
 * @param {object} decision publicDecision() output
 * @param {string} answer
 * @param {number} [now]
 * @returns {{k:string, v:{runId:string, answer:string}, u:number, d:null}|null}
 */
function answerUnit(decision, answer, now = Date.now()) {
  const d = publicDecision(decision);
  if (!d || !d.runId) return null;
  const accepted = acceptedAnswer(d, answer);
  if (accepted === null) return null;
  return { k: answerKey(d.id), v: { runId: d.runId, answer: accepted }, u: Math.floor(now), d: null };
}

/**
 * Raw answers out of the cloud's `todos` peers (cloudrows.todoPeer output:
 * {<key>: {items:[{...v, at, u}]}}). Untrusted: the controller checks each
 * one against its own queue.
 * @param {object[]|null} peers
 * @returns {{id:number, runId:string, answer:string, u:number}[]}
 */
function answersFromTodoPeers(peers) {
  const out = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    const list = isObj(peer) && Object.hasOwn(peer, ANSWER_LIST_KEY) && isObj(peer[ANSWER_LIST_KEY]) ? peer[ANSWER_LIST_KEY].items : null;
    for (const item of Array.isArray(list) ? list.slice(0, MAX_PENDING * 4) : []) {
      if (!isObj(item) || !validId(item.at) || typeof item.runId !== 'string' || !RUN_ID_RE.test(item.runId)) continue;
      if (typeof item.answer !== 'string' || item.answer.length > MAX_FREE_TEXT * 2) continue;
      out.push({ id: item.at, runId: item.runId, answer: item.answer, u: Number.isFinite(item.u) ? item.u : 0 });
    }
  }
  return out;
}

module.exports = {
  KINDS,
  APPROVE,
  REJECT,
  CARD_CHOICES,
  ANSWER_LIST_KEY,
  DEFAULT_DEADLINE_MS,
  MAX_FREE_TEXT,
  MAX_PENDING,
  needsDecision,
  createDecision,
  answerDecision,
  acceptedAnswer,
  dueDecisions,
  expireDue,
  nextDeadline,
  holdsCards,
  heldCards,
  decisionForCard,
  pendingOf,
  restoreQueue,
  trimQueue,
  decisionLine,
  publicDecision,
  publicDecisions,
  answerKey,
  answerUnit,
  answersFromTodoPeers,
};
