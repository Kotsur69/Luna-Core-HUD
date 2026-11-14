// ============================================================================
// LunaCore - opt-in auto-accept for low-risk memory types (main + CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, question 4 and "Improvements proposed
// after phase 4", item 8. Every captured memory waits for Mati's approval,
// unless he has switched auto-accept on for its type. The switch is OFF by
// default for every type and is only offered once this PC's memory log
// (src/memorylog.js) shows the type is nearly always approved:
//
//   >= AUTO_MIN_DECISIONS decisions in the last AUTO_WINDOW_DAYS days, and
//   approved / (approved + rejected) >= AUTO_ON_RATE
//
// An approval after an edit counts as approved (shown apart). An auto-accept
// that was not undone counts as approved too; an undo (or retiring it later)
// counts as rejected. So once a switch is on, the undos keep measuring it:
// when the rate falls under AUTO_OFF_RATE, on at least AUTO_OFF_MIN_DECISIONS
// decisions, the switch turns itself off (enforceAutoOff), the log gets an
// `auto-off` line and the hub says so.
//
// The switch syncs, the log does not. A PC auto-accepts only while its own log
// holds AUTO_MIN_DECISIONS decisions for the type; with fewer (a fresh PC, a
// switch that came from the cloud) its candidates wait as if the switch were off.
//
// Even with the switch on, a candidate is NEVER auto-accepted when it
//   - proposes to supersede a memory (that would take another one off the card),
//   - is global or was suggested global (it would reach every project's card),
//   - comes from a session that read outside content (decision 61), or
//   - is a near-duplicate of an entry that waits in the inbox.
//
// An auto-accepted memory is `confirmed` at once, its source ends in
// ', auto-accepted', and the log gets an `auto-accepted` line. The memory
// window lists the last AUTO_UNDO_DAYS days of them with an Undo (= reject:
// the file is deleted on every PC, the title goes back to the extractor as
// "not wanted").
//
// One more switch, 'Auto-save memories scored 90+' (SCORE_SWITCH), also OFF
// by default. With it on, a candidate whose capture score reaches
// AUTO_SAVE_FROM (src/memoryextract.js, where every score threshold lives) is
// treated as if its type were switched on: everything else above still holds
// (this PC's evidence for the type, its rate, the exclusions), and its type
// must also meet the bar that would offer its own switch (isOffered, so a
// type approved 80-89% of the time does not slip in by score). It lands
// the same way (confirmed, labelled, `auto-accepted` line, Undo). The switch
// keeps its own numbers too (scoreStats: the auto-accepts scored 90+ and how
// many were undone) and turns itself off under AUTO_OFF_RATE, like a type.
//
// The switches sync like the per-project memory switch (src/memoryprojects.js):
//
//   memory-autoaccept.local.json = {types: ["gotcha", ...], score: true|false}
//   config-scope unit              memory-auto:<type> = {on: true}
//                                  memory-auto:score  = {on: true}
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { readDoc, writeAtomic } = require('./projectsync');
const { GLOBAL, checkRecord, splitKey } = require('./memoryrecord');
const { scan, removeRecord } = require('./memorystore');
const { CANDIDATE_TYPES, nearDuplicate, sourceNotes, withNote, captureScore, scoreLane, AUTO_SAVE_FROM } = require('./memoryextract');
const { DAY_MS, SCORE_SWITCH } = require('./memorylog');

/** Decisions a type needs in the window before its switch is offered. */
const AUTO_MIN_DECISIONS = 20;
/** The window the decisions are counted in. */
const AUTO_WINDOW_DAYS = 28;
/** The approval rate a type needs before its switch is offered. */
const AUTO_ON_RATE = 0.9;
/** Under this rate a switched-on type turns itself off. */
const AUTO_OFF_RATE = 0.8;
/**
 * Decisions this PC needs before its rate may turn a switch off: one reject
 * among three must not undo a switch another PC earned with thirty.
 */
const AUTO_OFF_MIN_DECISIONS = 5;
/** How long an auto-accepted memory can be undone from the memory window (calendar days, today included). */
const AUTO_UNDO_DAYS = 7;
/** Auto-accepts the memory window lists at most. */
const MAX_RECENT = 50;
/** How long the hub keeps saying that a switch turned itself off. */
const AUTO_OFF_NOTICE_DAYS = 7;
/** The note an auto-accepted memory's source ends in. */
const AUTO_SUFFIX = ', auto-accepted';
const PREFIX = 'memory-auto:';
/** The config unit of the score switch; 'score' is no memory type, so it cannot clash with one. */
const SCORE_UNIT = PREFIX + SCORE_SWITCH;
const SETTINGS_FILE = 'memory-autoaccept.local.json';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const typeOf = (k) => (typeof k === 'string' && k.startsWith(PREFIX) && CANDIDATE_TYPES.includes(k.slice(PREFIX.length)) ? k.slice(PREFIX.length) : null);
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const errText = (err) => (err && (err.code || err.message)) || 'error';

// ---------------------------------------------------------------- the switches

/** Every switch in the file: {types, score}; throws when the file exists but is unreadable. */
function readSettingsStrict(file) {
  const doc = readDoc(file);
  const list = isObject(doc) && Array.isArray(doc.types) ? doc.types : [];
  // Only a literal true switches it on: anything else in a hand-edited file is off.
  return { types: [...new Set(list.filter((t) => CANDIDATE_TYPES.includes(t)))].sort(), score: isObject(doc) && doc.score === true };
}

/** The switched-on types, sorted; throws when the file exists but is unreadable. */
const readAutoStrict = (file) => readSettingsStrict(file).types;

/** The switched-on types; an unreadable file reads as none (nothing is auto-accepted). */
function readAuto(file) {
  try {
    return readAutoStrict(file);
  } catch (err) {
    console.error('[memory] auto-accept settings unreadable, all off:', errText(err));
    return [];
  }
}

/** Whether the score switch is on; an unreadable file reads as off. */
function readScoreAuto(file) {
  try {
    return readSettingsStrict(file).score;
  } catch (err) {
    console.error('[memory] auto-accept settings unreadable, score switch off:', errText(err));
    return false;
  }
}

function writeSettings(file, { types, score }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify({ types, score })}\n`);
}

/**
 * Switches auto-accept on or off for one type. The score switch is kept as it is.
 * @returns {string[]} the switched-on types afterwards
 */
function setAuto(file, type, on) {
  if (!CANDIDATE_TYPES.includes(type)) throw new Error('bad-type');
  const settings = readSettingsStrict(file);
  const rest = settings.types.filter((t) => t !== type);
  const next = on ? [...rest, type].sort() : rest;
  writeSettings(file, { types: next, score: settings.score });
  return next;
}

/**
 * Switches 'Auto-save memories scored 90+' on or off. The type switches are kept as they are.
 * @returns {boolean} the score switch afterwards
 */
function setScoreAuto(file, on) {
  if (typeof on !== 'boolean') throw new Error('bad-switch');
  writeSettings(file, { types: readAutoStrict(file), score: on });
  return on;
}

/** The switches as a configsync.js provider (scope `config`), like memory-on:<project>. */
function createAutoAcceptProvider(file) {
  return {
    name: 'memory-autoaccept',
    owns: (k) => typeOf(k) !== null || k === SCORE_UNIT,
    valid: (k, v) => ((typeOf(k) || k === SCORE_UNIT) && isObject(v) && v.on === true ? { on: true } : null),
    read(now) {
      const fresh = !fs.existsSync(file);
      const base = fresh ? 0 : Math.floor(Math.min(fs.statSync(file).mtimeMs, now));
      const { types, score } = readSettingsStrict(file);
      // A missing file is a fresh PC, not "every type switched off".
      const units = types.map((t) => [PREFIX + t, { on: true }]);
      return { units: score ? [...units, [SCORE_UNIT, { on: true }]] : units, base, fresh };
    },
    write(units) {
      writeSettings(file, { types: units.map(([k]) => typeOf(k)).filter(Boolean).sort(), score: units.some(([k]) => k === SCORE_UNIT) });
    },
  };
}

// ---------------------------------------------------------------- the numbers

const emptyStat = () => ({ approved: 0, edited: 0, auto: 0, rejected: 0, undone: 0 });

/**
 * Per type, what was decided in the last AUTO_WINDOW_DAYS days on this PC.
 * @param {object[]} events memorylog readLog()
 * @param {number} now ms
 * @returns {Object<string, {approved: number, edited: number, auto: number, rejected: number,
 *   undone: number, decisions: number, rate: number|null}>}
 *   approved = by hand (edited = of those, after an edit); auto = auto-accepted and not undone;
 *   rejected includes the undos (undone = of those, undos); rate = (approved + auto) / decisions
 */
function typeStats(events, now) {
  const since = now - AUTO_WINDOW_DAYS * DAY_MS;
  const editedKeys = new Set();
  const autoKeys = new Map(); // key -> type, auto-accepted in the window and not undone yet
  const stats = Object.create(null);
  const bump = (type, field) => {
    stats[type] = stats[type] || emptyStat();
    stats[type][field]++;
  };
  for (const e of Array.isArray(events) ? events : []) {
    // An edit may be older than the window its approval falls in.
    if (e.ev === 'edited') editedKeys.add(e.key);
    if (e.at < since || !e.type) continue;
    if (e.ev === 'approved') {
      bump(e.type, 'approved');
      if (editedKeys.has(e.key)) bump(e.type, 'edited');
    } else if (e.ev === 'auto-accepted') {
      autoKeys.set(e.key, e.type);
    } else if (e.ev === 'rejected' || (e.ev === 'retired' && autoKeys.has(e.key))) {
      // Retiring an auto-accepted memory from 'To check' says the same as Undo.
      bump(e.type, 'rejected');
      if (autoKeys.delete(e.key)) bump(e.type, 'undone');
    }
  }
  for (const type of autoKeys.values()) bump(type, 'auto');
  for (const s of Object.values(stats)) {
    s.decisions = s.approved + s.auto + s.rejected;
    s.rate = s.decisions ? (s.approved + s.auto) / s.decisions : null;
  }
  return stats;
}

/** Whether a candidate's capture score makes it eligible for the score switch. */
const isHighScore = (record) => scoreLane(captureScore(record)) === 'auto-save';

/**
 * What the score switch has done in the last AUTO_WINDOW_DAYS days on this PC:
 * the auto-accepts scored AUTO_SAVE_FROM or more (whichever switch let them
 * through: each says whether a 90+ score can be trusted) and how many of them
 * were undone or retired since.
 * @param {object[]} events memorylog readLog()
 * @param {number} now ms
 * @returns {{auto: number, undone: number, decisions: number, rate: number|null}}
 *   auto = not undone; rate = auto / decisions
 */
function scoreStats(events, now) {
  const since = now - AUTO_WINDOW_DAYS * DAY_MS;
  const high = new Set();
  let undone = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.at < since) continue;
    if (e.ev === 'auto-accepted' && Number.isInteger(e.usefulness) && e.usefulness >= AUTO_SAVE_FROM) high.add(e.key);
    else if ((e.ev === 'rejected' || e.ev === 'retired') && high.delete(e.key)) undone++;
  }
  const decisions = high.size + undone;
  return { auto: high.size, undone, decisions, rate: decisions ? high.size / decisions : null };
}

/** Whether a type's numbers earn it the switch. */
const isOffered = (stat) => Boolean(stat) && stat.decisions >= AUTO_MIN_DECISIONS && stat.rate !== null && stat.rate >= AUTO_ON_RATE;
/** Whether a switched-on type's numbers, on a big enough sample, have fallen under the bar that keeps it on. */
const isFailing = (stat) => Boolean(stat) && stat.decisions >= AUTO_OFF_MIN_DECISIONS && stat.rate !== null && stat.rate < AUTO_OFF_RATE;
/**
 * Whether this PC's own log backs auto-accepting the type. The switch syncs,
 * but a PC with too few decisions of its own (a fresh PC, a switch that came
 * from the cloud, a quiet month) lets candidates wait until it has them.
 */
const hasEvidence = (stat) => Boolean(stat) && stat.decisions >= AUTO_MIN_DECISIONS;

/**
 * What the memory window shows: every type that is offered or switched on.
 * @param {string[]} enabled readAuto()
 * @returns {{type: string, on: boolean, offered: boolean, approved: number, edited: number,
 *   auto: number, rejected: number, undone: number, decisions: number, rate: number|null}[]}
 */
function autoStatus(enabled, stats) {
  return CANDIDATE_TYPES.filter((type) => enabled.includes(type) || isOffered(stats[type])).map((type) => {
    const s = stats[type] || { ...emptyStat(), decisions: 0, rate: null };
    return { type, on: enabled.includes(type), offered: isOffered(s), ...s };
  });
}

// ---------------------------------------------------------------- one candidate

/**
 * Why a candidate must wait for Mati even with its type switched on, or null.
 * @param {object} record a candidate from memoryextract.candidatesFrom
 * @param {object[]} pending the records waiting in the inbox (not confirmed)
 * @returns {'supersedes'|'global'|'outside'|'duplicate'|null}
 */
function exclusion(record, pending) {
  const notes = sourceNotes(record.source);
  if (Array.isArray(record.supersedes) && record.supersedes.length) return 'supersedes';
  if (record.project === GLOBAL || notes.suggestedGlobal) return 'global';
  if (notes.outside > 0) return 'outside';
  const twin = pending.some((r) => (r.project === record.project || r.project === GLOBAL) && !(r.project === record.project && r.id === record.id) && nearDuplicate(r, record));
  return twin ? 'duplicate' : null;
}

/**
 * Whether a captured candidate is auto-accepted.
 * @param {object} record
 * @param {{enabled: string[], stats: object, pending: object[], scoreOn?: boolean, scoreStat?: object|null}} ctx
 *   scoreOn = the score switch (readScoreAuto); scoreStat = scoreStats()
 * @returns {{accept: boolean, reason: string}} reason = 'auto', 'off', 'no-evidence', 'failing',
 *   'not-offered' (score path only) or the exclusion
 */
function decide(record, { enabled, stats, pending, scoreOn = false, scoreStat = null }) {
  if (!record) return { accept: false, reason: 'off' };
  const byType = enabled.includes(record.type);
  // The score switch stands in for the type's switch only: every rule below still applies.
  if (!byType && !(scoreOn && isHighScore(record))) return { accept: false, reason: 'off' };
  const stat = stats[record.type];
  if (!hasEvidence(stat)) return { accept: false, reason: 'no-evidence' };
  // A rate that fell under the bar stops auto-accept even before the switch is turned off.
  if (isFailing(stat) || (!byType && isFailing(scoreStat))) return { accept: false, reason: 'failing' };
  // By score alone, the type must still earn what its own switch would need to be offered.
  if (!byType && !isOffered(stat)) return { accept: false, reason: 'not-offered' };
  const why = exclusion(record, pending);
  return why ? { accept: false, reason: why } : { accept: true, reason: 'auto' };
}

/** The candidate as an auto-accepted memory: confirmed today, its source labelled. Throws on a bad record. */
function asAutoAccepted(record, today) {
  const res = checkRecord({ ...record, confidence: 'confirmed', last_verified: today, source: withNote(record.source || '', AUTO_SUFFIX) });
  if (!res.record) throw new Error(`auto-accept: ${res.error}`);
  // A confirmed memory without its label could never be undone: refuse rather than write it.
  if (!isAutoAccepted(res.record)) throw new Error('auto-accept: label lost');
  return res.record;
}

function isAutoAccepted(record) {
  return typeof record.source === 'string' && record.source.endsWith(AUTO_SUFFIX);
}

/** The log line of an auto-accept (src/memorylog.js). */
const autoEvent = (record) => ({
  ev: 'auto-accepted',
  key: `${record.project}/${record.id}`,
  type: record.type,
  ...(Number.isInteger(record.usefulness) ? { usefulness: record.usefulness } : {}),
});

/**
 * The landing step for capture: decides each candidate before it is written.
 * The log is read once per piece; the inbox is read per candidate, so a
 * candidate that repeats one written a moment ago still waits.
 * @param {{file: string, dir: string, log: {read: () => object[], add: (e: object) => boolean}|null, now: number}} opts
 *   file = the switches (memoryPaths().autoAccept); no log = no numbers = nothing is auto-accepted
 * @returns {(record: object) => {record: object, auto: boolean}} never throws: when the
 *   check fails the candidate waits in the inbox, as it would with every switch off
 */
function createLanding({ file, dir, log, now }) {
  const waits = (record) => ({ record, auto: false });
  if (!log) return waits;
  let ctx;
  try {
    const events = log.read();
    enforceAutoOff({ file, events, now, log });
    ctx = { enabled: readAuto(file), stats: typeStats(events, now), scoreOn: readScoreAuto(file), scoreStat: scoreStats(events, now), today: isoDate(now) };
  } catch (err) {
    console.error('[memory] auto-accept unavailable, candidates wait:', errText(err));
    return waits;
  }
  return (record) => {
    if (!ctx.enabled.includes(record.type) && !(ctx.scoreOn && isHighScore(record))) return waits(record);
    try {
      const pending = scan(dir)
        .records.map(([, r]) => r)
        .filter((r) => r.confidence !== 'confirmed');
      const { accept } = decide(record, { ...ctx, pending });
      return accept ? { record: asAutoAccepted(record, ctx.today), auto: true } : waits(record);
    } catch (err) {
      console.error('[memory] auto-accept check failed, the candidate waits:', errText(err));
      return waits(record);
    }
  };
}

/**
 * Turns off every switched-on type whose rate fell under AUTO_OFF_RATE, and
 * the score switch when its own rate did, and logs it (the hub reads that
 * line). Never throws: it runs on capture and on every inbox read.
 * @returns {{type: string, rate: number}[]} the switches turned off now;
 *   type = SCORE_SWITCH for the score switch
 */
function enforceAutoOff({ file, events, now, log }) {
  // Each kind in its own try: a failure on the score switch must not hide
  // (and leave unsynced) the type switches already turned off.
  return [...typeAutoOffs({ file, events, now, log }), ...scoreAutoOff({ file, events, now, log })];
}

/** The type half of enforceAutoOff. Never throws. */
function typeAutoOffs({ file, events, now, log }) {
  const done = [];
  try {
    const enabled = readAuto(file);
    if (!enabled.length) return done;
    const stats = typeStats(events, now);
    for (const type of enabled.filter((t) => isFailing(stats[t]))) {
      setAuto(file, type, false);
      done.push({ type, rate: stats[type].rate });
      if (log) log.add({ ev: 'auto-off', type, rate: stats[type].rate });
    }
  } catch (err) {
    console.error('[memory] auto-accept check failed:', errText(err));
  }
  return done;
}

/** The score-switch half of enforceAutoOff. Never throws. */
function scoreAutoOff({ file, events, now, log }) {
  try {
    if (!readScoreAuto(file)) return [];
    const score = scoreStats(events, now);
    if (!isFailing(score)) return [];
    setScoreAuto(file, false);
    if (log) log.add({ ev: 'auto-off', type: SCORE_SWITCH, rate: score.rate });
    return [{ type: SCORE_SWITCH, rate: score.rate }];
  } catch (err) {
    console.error('[memory] auto-accept score check failed:', errText(err));
    return [];
  }
}

/**
 * The switches that turned themselves off lately, newest first: what the hub
 * says. The score switch's notice carries its threshold as `from`.
 */
function recentAutoOffs(events, now) {
  const since = now - AUTO_OFF_NOTICE_DAYS * DAY_MS;
  return (Array.isArray(events) ? events : [])
    .filter((e) => e.ev === 'auto-off' && e.at >= since)
    .map((e) => ({ type: e.type, rate: e.rate, at: e.at, ...(e.type === SCORE_SWITCH ? { from: AUTO_SAVE_FROM } : {}) }))
    .reverse();
}

// ---------------------------------------------------------------- undo

/**
 * The auto-accepted memories of the last AUTO_UNDO_DAYS days, newest first.
 * @param {[string, object][]} records memorystore.scan().records
 * @param {string} today YYYY-MM-DD
 */
function recentAutoAccepted(records, today) {
  // Today and the six days before it: seven calendar days.
  const since = isoDate(Date.parse(`${today}T00:00:00Z`) - (AUTO_UNDO_DAYS - 1) * DAY_MS);
  return records
    .filter(([, r]) => r.confidence === 'confirmed' && isAutoAccepted(r) && r.created >= since)
    .map(([key, r]) => ({ key, project: r.project, type: r.type, title: r.title, created: r.created }))
    .sort((a, b) => b.created.localeCompare(a.created) || a.key.localeCompare(b.key))
    .slice(0, MAX_RECENT);
}

/**
 * Undoes one auto-accept: the memory is deleted (on every PC, by the sync),
 * like a reject. Only a memory on the recent list can be undone.
 * @param {(event: string, record: object) => void} [decided] called with 'rejected' and the deleted memory
 * @returns {{ok: true, key: string}|{ok: false, reason: string}}
 */
function undoAutoAccept(dir, key, today, decided = () => {}) {
  if (!splitKey(key)) return { ok: false, reason: 'bad-key' };
  const { records } = scan(dir);
  const found = records.find(([k]) => k === key);
  if (!found) return { ok: false, reason: 'not-found' };
  if (!recentAutoAccepted([found], today).length) return { ok: false, reason: 'not-auto' };
  removeRecord(dir, key);
  decided('rejected', found[1]);
  return { ok: true, key };
}

module.exports = {
  readAuto,
  setAuto,
  readScoreAuto,
  setScoreAuto,
  createAutoAcceptProvider,
  typeStats,
  scoreStats,
  isHighScore,
  isOffered,
  isFailing,
  autoStatus,
  exclusion,
  decide,
  asAutoAccepted,
  isAutoAccepted,
  autoEvent,
  createLanding,
  enforceAutoOff,
  recentAutoOffs,
  recentAutoAccepted,
  undoAutoAccept,
  AUTO_MIN_DECISIONS,
  AUTO_WINDOW_DAYS,
  AUTO_ON_RATE,
  AUTO_OFF_RATE,
  AUTO_OFF_MIN_DECISIONS,
  AUTO_UNDO_DAYS,
  MAX_RECENT,
  AUTO_OFF_NOTICE_DAYS,
  AUTO_SUFFIX,
  PREFIX,
  SCORE_SWITCH,
  SCORE_UNIT,
  AUTO_SAVE_FROM,
  SETTINGS_FILE,
};
