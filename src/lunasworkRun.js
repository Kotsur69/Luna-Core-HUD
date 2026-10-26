// ============================================================================
// LunaCore - Luna's Work run record (docs/LUNAS_WORK_PLAN.md, 1.5b)
// ----------------------------------------------------------------------------
// The pure half of the outer loop controller (src/lunaswork.js): no timers,
// no IO, nothing kept between calls.
//
//   risky cards   riskReason / isRiskyCard, conflictedPaths (God Mode merge)
//   landed cards  landedCards - only merged work counts as a closed card;
//                 landedFiles - what a card's merged work changed (idea #3)
//   models        parseModelOverride, effectiveModels (run > project > global)
//   self-check    checkCommandFor (the profile's, else God Mode's setting)
//   SHIP          shipAgrees (the second, fresh Playtester)
//   stored run    restoreRun and the clean* helpers for what comes back from
//                 lunaswork.local.json; emptyCurrent, scoresByMilestone
//   laps          buildLap / cleanLap - one summary per finished iteration
//                 (cards, score, merge, checkpoint tag or rollback, evidence
//                 folder, decisions) for the run report (lunasworkReport.js)
//   loop hooks    HOOK_KEYS / cleanHookNotes (src/lunasworkLoopHooks.js),
//                 cleanLighthouse (per-iteration results), cleanGateHold
//   return pack   a lap's gate / changes / screens and keyScreens (LW 2.18),
//                 gatesMailed, cleanShipDocs (LW 2.22a docs iteration)
// ============================================================================

'use strict';

const path = require('path');
const { PHASES, ROLES, MODEL_CHOICES, normalizeModels, normalizeStoredRun } = require('./lunasworkRules');
const settingsStore = require('./lunasworkSettings');
const { keyFor } = require('./todo');
const { MAX_DETAILS_CHARS, MAX_TEXT_CHARS: MAX_CARD_TEXT_CHARS } = require('./todorows');
const { restoreQueue } = require('./lunasworkDecisions');
const { restoreFeedback } = require('./lunasworkFeedback');
const { HANDED } = require('./lunasworkWheel');
const { appendResult } = require('./lunasworkLighthouse');
const { cleanLedger } = require('./lunasworkUsage');

const PREPROD = 'preprod';
const DONE = 'done';
// C11: `handed` - paused between iterations while Mati works by hand.
const ALL_PHASES = [PREPROD, ...PHASES, HANDED, DONE];
const FINAL_VERDICTS = ['ship', 'plateau', 'red', 'stop'];
const BUILDER_MODELS = ['haiku', 'sonnet', 'opus'];
const MODEL_SOURCES = ['run', 'project', 'global'];

const MAX_LOG = 400;
const MAX_LOG_TEXT = 300;
const MAX_CONFLICT_ITERATIONS = 20;
const MAX_CONFLICT_FILES = 100;
const MAX_RECENT_SCORES = 10;
const MAX_PATH_CHARS = 500;
const MAX_TEXT_CHARS = 2000;
const MAX_REPORT_ITEMS = 100;
const MAX_ITEMS = 50;
const MAX_PLAN_IDS = 50;
const MAX_LAPS = 200;
const MAX_DECISIONS = 20;
const MAX_HOOK_NOTES = 20;
const MAX_LIGHTHOUSE_ENTRIES = 200;
const GATE_HOLD_REASONS = ['verdict', 'blockingFindings'];
const SHA_RE = /^[0-9a-f]{7,40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const finite = (v) => (Number.isFinite(v) ? v : null);

/** A one-line command within the settings cap, trimmed; '' when unusable. */
function cleanCommand(raw) {
  if (typeof raw !== 'string' || raw.length > settingsStore.MAX_COMMAND_CHARS || CONTROL_CHARS.test(raw)) return '';
  return raw.trim();
}

// ---- risky cards ------------------------------------------------------------------

// A card's files: IPC, auth, migrations / schema. "author" is not auth;
// "authorization" / "authorise" are.
const RISKY_FILE_RE = /preload|ipc|contextbridge|auth(?!or(?!i[sz]))|migrat|schema/i;
// A card's text: the same areas, as words.
const RISKY_TEXT_RE = /\bpreload\b|\bipc|contextbridge|\bo?auth(?!or(?!i[sz]))|\bmigrat|\bschema/i;

const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

const cardFiles = (card) => (Array.isArray(card && card.files) ? card.files.filter((f) => typeof f === 'string' && f) : []);

/** True when `conflict` is `file`, or sits inside it (the card names a folder). */
const touches = (file, conflict) => conflict === file || conflict.startsWith(`${file}/`);

/** Which risky area a matching file or text is about. */
function areaOf(hit) {
  if (/preload|ipc|contextbridge/i.test(hit)) return 'ipc';
  if (/migrat|schema/i.test(hit)) return 'migration';
  return 'auth';
}

/**
 * Why a builder card counts as risky, or null. Risky = its files or text touch
 * IPC (preload, ipcMain, contextBridge), auth or migrations / schema, or one of
 * its files had a merge conflict in the previous iteration.
 * @param {object} card a to-do card ({text, details?, files?})
 * @param {Array<{n:number, files:string[]}>} history conflicted paths per iteration, oldest first
 * @returns {'ipc'|'auth'|'migration'|'conflict'|null}
 */
function riskReason(card, history) {
  if (!isObj(card)) return null;
  const files = cardFiles(card);
  const fileHit = files.find((f) => RISKY_FILE_RE.test(f));
  if (fileHit) return areaOf(fileHit);
  const text = [card.text, card.details].filter((t) => typeof t === 'string').join('\n');
  const textHit = RISKY_TEXT_RE.exec(text);
  if (textHit) return areaOf(textHit[0]);
  const list = Array.isArray(history) ? history.filter((h) => isObj(h) && Array.isArray(h.files)) : [];
  const previous = list[list.length - 1];
  if (!previous || !files.length) return null;
  const conflicts = previous.files.filter((f) => typeof f === 'string' && f).map(normPath);
  return files.map(normPath).some((f) => conflicts.some((c) => touches(f, c))) ? 'conflict' : null;
}

/** @returns {boolean} see riskReason */
function isRiskyCard(card, history) {
  return riskReason(card, history) !== null;
}

/**
 * Paths that conflicted in one God Mode merge: packages the integration
 * skipped on a conflict, and packages whose launch hit one (dependency merge).
 * @param {{integration?:object, plan?:object}|null} settled the build result (onRunSettled)
 * @returns {string[]}
 */
function conflictedPaths(settled) {
  const s = isObj(settled) ? settled : {};
  const skipped = isObj(s.integration) && Array.isArray(s.integration.skipped) ? s.integration.skipped : [];
  const packages = isObj(s.plan) && Array.isArray(s.plan.packages) ? s.plan.packages : [];
  const files = [
    ...skipped.filter((k) => isObj(k) && k.stage === 'conflict').flatMap((k) => (Array.isArray(k.files) ? k.files : [])),
    ...packages
      .filter((p) => isObj(p) && isObj(p.failure) && p.failure.code === 'conflict')
      .flatMap((p) => (Array.isArray(p.failure.files) ? p.failure.files : [])),
  ];
  const clean = files.filter((f) => typeof f === 'string' && f).map((f) => f.slice(0, MAX_PATH_CHARS));
  return [...new Set(clean)].slice(0, MAX_CONFLICT_FILES);
}

/**
 * The cards whose work reached the base branch: the cards of packages God
 * Mode merged, in an integration that is done. God Mode ticks a card when
 * its package is pushed; a red or skipped merge leaves it ticked but off main.
 * The settled view names a package's cards by text (or `at` when it has none).
 * @param {{integration?:object, plan?:object}|null} settled the build result (onRunSettled)
 * @param {Array<{at:number, text:string}>} cards this iteration's cards
 * @returns {number[]}
 */
function landedCards(settled, cards) {
  const s = isObj(settled) ? settled : {};
  if (!isObj(s.integration) || s.integration.state !== 'done') return [];
  const packages = isObj(s.plan) && Array.isArray(s.plan.packages) ? s.plan.packages : [];
  const names = new Set(
    packages.filter((p) => isObj(p) && p.merged === true).flatMap((p) => (Array.isArray(p.todos) ? p.todos : [])),
  );
  return (Array.isArray(cards) ? cards : []).filter((c) => names.has(c.text) || names.has(String(c.at))).map((c) => c.at);
}

/**
 * The paths the merged packages of one card changed (God Mode's `touched`),
 * for the bug-test rule (idea #3). Null when no merged package names the card.
 * @param {{plan?:object}|null} settled the build result (onRunSettled)
 * @param {{at:number, text:string}} card
 * @returns {string[]|null}
 */
function landedFiles(settled, card) {
  const s = isObj(settled) ? settled : {};
  const packages = isObj(s.plan) && Array.isArray(s.plan.packages) ? s.plan.packages : [];
  const names = (p) => (Array.isArray(p.todos) ? p.todos : []);
  const mine = packages.filter((p) => isObj(p) && p.merged === true && isObj(card) && (names(p).includes(card.text) || names(p).includes(String(card.at))));
  if (!mine.length) return null;
  const files = mine.flatMap((p) => (Array.isArray(p.touched) ? p.touched : [])).filter((f) => typeof f === 'string' && f);
  return [...new Set(files)].slice(0, MAX_CONFLICT_FILES);
}

// ---- models and the check command ---------------------------------------------------

/** A partial {role: choice} map, or null when anything in it is unknown. */
function parseModelOverride(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) return null;
  const out = {};
  for (const [role, choice] of Object.entries(raw)) {
    if (!ROLES.includes(role) || !MODEL_CHOICES.includes(choice)) return null;
    out[role] = choice;
  }
  return out;
}

/**
 * The models a run uses. Precedence per role: this run's override, then the
 * project's override, then the global default (Luna's Work settings).
 * @param {object} settings lunasworkSettings.readSettings() result
 * @param {string} projectId
 * @param {object} [override] validated partial {role: choice} for this run only
 * @returns {{models:Record<string,string>, sources:Record<string,'run'|'project'|'global'>}}
 */
function effectiveModels(settings, projectId, override = {}) {
  const s = settingsStore.normalizeSettings(settings);
  const project = s.projects[keyFor(projectId)];
  const projectModels = settingsStore.normalizeModelOverride(project && project.models);
  const runModels = settingsStore.normalizeModelOverride(override);
  const models = normalizeModels({ ...s.models, ...projectModels, ...runModels });
  const sources = {};
  for (const role of ROLES) {
    sources[role] = role in runModels ? 'run' : role in projectModels ? 'project' : 'global';
  }
  return { models, sources };
}

/**
 * The self-check command of a Luna's Work build: the project profile's
 * checkCommand, else God Mode's own 'Final check command' setting (which
 * itself defaults to npm test). God Mode's default is never changed here.
 * @param {{checkCommand?:string}|null} profile
 * @param {string|null|undefined} godModeCommand
 * @returns {string} '' = let God Mode's finalizer use its own default
 */
function checkCommandFor(profile, godModeCommand) {
  const own = profile && typeof profile.checkCommand === 'string' ? profile.checkCommand.trim() : '';
  if (own) return own;
  return typeof godModeCommand === 'string' ? godModeCommand.trim() : '';
}

/**
 * Whether the second, fresh SHIP-confirmation Playtester agrees: its pass
 * worked, every gate passes on ITS scores, and it found no blocker.
 * @param {{ok:boolean, report?:object}|null} pass runPlaytest result (mode shipConfirm)
 * @param {{allPassed:boolean}|null} gate gate status computed from that pass's scores
 * @returns {boolean}
 */
function shipAgrees(pass, gate) {
  if (!isObj(pass) || pass.ok !== true || !isObj(gate) || gate.allPassed !== true) return false;
  const findings = isObj(pass.report) && Array.isArray(pass.report.findings) ? pass.report.findings : [];
  return !findings.some((f) => isObj(f) && f.severity === 'blocker');
}

// ---- stored run ------------------------------------------------------------------

const CARD_KINDS = ['bug', 'feel', 'missing', 'idea'];

/** A card's kind: its own field, else its `kind:<x>` tag (the Critic's), else null. */
function kindOf(raw) {
  if (CARD_KINDS.includes(raw.kind)) return raw.kind;
  const tag = (Array.isArray(raw.tags) ? raw.tags : []).find((t) => typeof t === 'string' && t.startsWith('kind:'));
  return tag && CARD_KINDS.includes(tag.slice(5)) ? tag.slice(5) : null;
}

function cleanCard(raw) {
  if (!isObj(raw) || !Number.isFinite(raw.at)) return null;
  const files = cardFiles(raw).slice(0, MAX_ITEMS).map((f) => f.slice(0, MAX_PATH_CHARS));
  const acceptance = Array.isArray(raw.acceptance) ? raw.acceptance.filter((a) => typeof a === 'string').slice(0, MAX_ITEMS) : [];
  const kind = kindOf(raw);
  return {
    at: raw.at,
    text: str(raw.text, MAX_CARD_TEXT_CHARS) || '',
    // The bug-test rule (idea #3) reads it at finish.
    ...(kind ? { kind } : {}),
    ...(str(raw.details, MAX_DETAILS_CHARS) ? { details: str(raw.details, MAX_DETAILS_CHARS) } : {}),
    ...(files.length ? { files } : {}),
    ...(str(raw.size, 10) ? { size: str(raw.size, 10) } : {}),
    ...(acceptance.length ? { acceptance } : {}),
    ...(str(raw.verify, MAX_PATH_CHARS) ? { verify: str(raw.verify, MAX_PATH_CHARS) } : {}),
    model: BUILDER_MODELS.includes(raw.model) ? raw.model : 'opus',
    reason: str(raw.reason, MAX_LOG_TEXT) || 'setting',
  };
}

function cleanLogEntry(raw) {
  if (!isObj(raw) || !Number.isFinite(raw.at) || !['model', 'event'].includes(raw.kind)) return null;
  return {
    at: raw.at,
    n: Number.isInteger(raw.n) ? raw.n : 0,
    kind: raw.kind,
    ...(ROLES.includes(raw.role) ? { role: raw.role } : {}),
    ...(str(raw.model, 20) ? { model: str(raw.model, 20) } : {}),
    ...(str(raw.reason, MAX_LOG_TEXT) ? { reason: str(raw.reason, MAX_LOG_TEXT) } : {}),
    ...(Number.isFinite(raw.card) ? { card: raw.card } : {}),
    ...(str(raw.text, MAX_LOG_TEXT) ? { text: str(raw.text, MAX_LOG_TEXT) } : {}),
  };
}

function cleanConflicts(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => isObj(c) && Number.isInteger(c.n) && Array.isArray(c.files))
    .map((c) => ({ n: c.n, files: c.files.filter((f) => typeof f === 'string').slice(0, MAX_CONFLICT_FILES) }))
    .slice(-MAX_CONFLICT_ITERATIONS);
}

function cleanMilestone(raw) {
  if (!isObj(raw) || typeof raw.name !== 'string') return null;
  return { name: raw.name.slice(0, 200), passed: raw.passed === true, score: finite(raw.score) };
}

function cleanDecisions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((d) => isObj(d) && str(d.choice, 1) && str(d.because, 1))
    .slice(0, MAX_DECISIONS)
    .map((d) => ({ choice: str(d.choice, MAX_LOG_TEXT), because: str(d.because, MAX_LOG_TEXT) }));
}

/** A count: an integer, or the length of a list (the Critic answers with card lists). */
const countOf = (v) => (Array.isArray(v) ? v.length : Number.isInteger(v) && v > 0 ? v : 0);

function cleanCritic(raw) {
  if (!isObj(raw)) return null;
  const cards = isObj(raw.cards) ? raw.cards : {};
  return {
    ok: raw.ok === true,
    verdict: raw.verdict === 'ship' ? 'ship' : 'continue',
    milestone: cleanMilestone(raw.milestone),
    next: str(raw.next, 200),
    allPassed: raw.allPassed === true,
    cardsOpened: countOf(raw.cardsOpened !== undefined ? raw.cardsOpened : cards.created),
    cardsUpdated: countOf(raw.cardsUpdated !== undefined ? raw.cardsUpdated : cards.updated),
    // B4: the stuck cards this pass split (saved, so a restart never asks about them).
    split: Array.isArray(raw.split) ? raw.split.filter(Number.isFinite).slice(0, MAX_ITEMS) : [],
    decisions: cleanDecisions(raw.decisions),
    ...(str(raw.error, 100) ? { error: str(raw.error, 100) } : {}),
  };
}

const keepList = (v) => (Array.isArray(v) ? v.slice(0, MAX_REPORT_ITEMS) : []);

function cleanReport(raw) {
  if (!isObj(raw)) return null;
  return {
    mode: raw.mode === 'shipConfirm' ? 'shipConfirm' : 'explore',
    findings: keepList(raw.findings),
    scores: keepList(raw.scores),
    journeys: keepList(raw.journeys),
    screens: keepList(raw.screens),
    checks: keepList(raw.checks),
    warnings: keepList(raw.warnings),
    errors: keepList(raw.errors),
  };
}

/** A small progress record: only the listed keys, each of its kind. */
function cleanSmall(raw, keys) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const [key, kind] of Object.entries(keys)) {
    const v = raw[key];
    if (kind === 'bool') out[key] = v === true;
    else if (kind === 'str' && str(v, MAX_LOG_TEXT)) out[key] = str(v, MAX_LOG_TEXT);
    else if (kind === 'num' && Number.isFinite(v)) out[key] = v;
    else if (kind === 'ats' && Array.isArray(v)) out[key] = v.filter(Number.isFinite).slice(0, MAX_ITEMS);
  }
  return out;
}

// ---- checkpoints and laps -----------------------------------------------------------

const ats = (v) => (Array.isArray(v) ? v.filter(Number.isFinite).slice(0, MAX_ITEMS) : []);
const names = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === 'string' && n).slice(0, MAX_ITEMS).map((n) => n.slice(0, 200)) : []);

/** A rollback record (lunasworkCheckpoint.rollback result plus why), or null. */
function cleanRollback(raw) {
  if (!isObj(raw)) return null;
  const reverted = (Array.isArray(raw.reverted) ? raw.reverted : [])
    .filter((c) => isObj(c) && typeof c.sha === 'string' && SHA_RE.test(c.sha))
    .slice(0, MAX_ITEMS)
    .map((c) => ({ sha: c.sha, subject: str(c.subject, 200) || '' }));
  return {
    ok: raw.ok === true,
    ...(Number.isInteger(raw.toIteration) ? { toIteration: raw.toIteration } : {}),
    reason: str(raw.reason, 40) || 'rollback',
    why: str(raw.why, MAX_LOG_TEXT),
    fromTag: str(raw.fromTag, 200),
    toTag: str(raw.toTag, 200),
    reverted,
    cards: ats(raw.cards),
    reopened: ats(raw.reopened),
    decision: raw.decision === true,
    ...(str(raw.error, 100) ? { error: str(raw.error, 100) } : {}),
    ...(str(raw.detail, MAX_LOG_TEXT) ? { detail: str(raw.detail, MAX_LOG_TEXT) } : {}),
  };
}

/** What the checkpoint step did in an iteration: a tag, a rollback, or a note. */
function cleanCheckpoint(raw) {
  if (!isObj(raw)) return null;
  return {
    tag: str(raw.tag, 200),
    tagError: str(raw.tagError, 100),
    rollback: cleanRollback(raw.rollback),
    note: str(raw.note, MAX_LOG_TEXT),
  };
}

function cleanLap(raw) {
  if (!isObj(raw) || !Number.isInteger(raw.n) || raw.n < 1) return null;
  const opt = (key, v) => (v === null || v === undefined || v === '' ? {} : { [key]: v });
  return {
    n: raw.n,
    milestone: str(raw.milestone, 200),
    score: finite(raw.score),
    cardsPlanned: countOf(raw.cardsPlanned),
    cardsClosed: ats(raw.cardsClosed),
    cardsOpened: countOf(raw.cardsOpened),
    cardsUpdated: countOf(raw.cardsUpdated),
    selfCheck: raw.selfCheck === 'red' ? 'red' : 'green',
    skipped: raw.skipped === true,
    ...opt('buildError', str(raw.buildError, MAX_LOG_TEXT)),
    ...opt('integrationBranch', str(raw.integrationBranch, 200)),
    ...opt('fixups', finite(raw.fixups)),
    ...opt('playtestOk', typeof raw.playtestOk === 'boolean' ? raw.playtestOk : null),
    ...opt('playtestError', str(raw.playtestError, 100)),
    criticVerdict: raw.criticVerdict === 'ship' ? 'ship' : 'continue',
    ...opt('shipAgrees', typeof raw.shipAgrees === 'boolean' ? raw.shipAgrees : null),
    checkpoint: cleanCheckpoint(raw.checkpoint),
    rolledBack: raw.rolledBack === true,
    journeysPassed: names(raw.journeysPassed),
    journeysFailed: names(raw.journeysFailed),
    decisions: cleanDecisions(raw.decisions),
    evidenceDir: typeof raw.evidenceDir === 'string' && path.isAbsolute(raw.evidenceDir) ? raw.evidenceDir.slice(0, MAX_PATH_CHARS) : null,
    // LW 2.23 + loop hooks: what failed or was skipped around the iteration.
    notes: cleanHookNotes(raw.notes),
    // LW 2.18: a passed milestone gate, the closed cards' text, the key screenshots (the return pack).
    ...(raw.gate === true ? { gate: true } : {}),
    ...(cleanChanges(raw.changes).length ? { changes: cleanChanges(raw.changes) } : {}),
    ...(cleanScreens(raw.screens).length ? { screens: cleanScreens(raw.screens) } : {}),
  };
}

const MAX_LAP_CHANGES = 30;
const MAX_LAP_SCREENS = 12;
const SCREENSHOT_RE = /\.(png|jpe?g)$/i;

/** LW 2.18: the cards an iteration closed, as {text, kind?}. */
function cleanChanges(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => isObj(c) && str(c.text, 1))
    .slice(0, MAX_LAP_CHANGES)
    .map((c) => ({ text: str(c.text, 200), ...(CARD_KINDS.includes(c.kind) ? { kind: c.kind } : {}) }));
}

/** LW 2.18: the Playtester's screenshots of an iteration - absolute image paths only. */
function cleanScreens(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((s) => isObj(s) && str(s.name, 1) && typeof s.screenshot === 'string' && path.isAbsolute(s.screenshot)
      && SCREENSHOT_RE.test(s.screenshot) && s.screenshot.length <= MAX_PATH_CHARS && !CONTROL_CHARS.test(s.screenshot))
    .slice(0, MAX_LAP_SCREENS)
    .map((s) => ({ name: str(s.name, 80), screenshot: s.screenshot }));
}

// The Playtester names a screen's shots "<screen>-desktop" / "<screen>-mobile".
const screenBase = (name) => name.replace(/-(desktop|mobile|tablet)$/i, '');
const isDesktopShot = (name) => /-desktop$/i.test(name) || !/-(mobile|tablet)$/i.test(name);

/**
 * LW 2.18: one screenshot per key screen across the run - the newest lap's,
 * the desktop one when there are both - in the order the screens first
 * appeared. Pure.
 * @param {object[]} laps cleanLaps() output
 * @returns {{name:string, screenshot:string, n:number}[]}
 */
function keyScreens(laps) {
  const byScreen = new Map();
  for (const lap of Array.isArray(laps) ? laps : []) {
    for (const s of isObj(lap) && Array.isArray(lap.screens) ? lap.screens : []) {
      const name = screenBase(s.name);
      const prev = byScreen.get(name);
      const better = !prev || lap.n > prev.n || (lap.n === prev.n && isDesktopShot(s.name) && !prev.desktop);
      if (better) byScreen.set(name, { name, screenshot: s.screenshot, n: lap.n, desktop: isDesktopShot(s.name) });
    }
  }
  return [...byScreen.values()].slice(0, MAX_LAP_SCREENS).map(({ name, screenshot, n }) => ({ name, screenshot, n }));
}

/** LW 2.22a: the docs iteration at SHIP - its number, its cards, which landed, the release result. */
function cleanShipDocs(raw) {
  if (!isObj(raw) || !Number.isInteger(raw.n) || raw.n < 1) return null;
  const release = isObj(raw.release)
    ? {
      ok: raw.release.ok === true,
      ...(str(raw.release.tag, 60) ? { tag: str(raw.release.tag, 60) } : {}),
      ...(str(raw.release.url, MAX_PATH_CHARS) ? { url: str(raw.release.url, MAX_PATH_CHARS) } : {}),
      ...(str(raw.release.error, 100) ? { error: str(raw.release.error, 100) } : {}),
      ...(str(raw.release.detail, MAX_LOG_TEXT) ? { detail: str(raw.release.detail, MAX_LOG_TEXT) } : {}),
    }
    : null;
  return { n: raw.n, cards: ats(raw.cards), landed: ats(raw.landed), release };
}

/**
 * One finished iteration for the run report, from the iteration's progress
 * (run.current) and its history record.
 * @param {object} current run.current at the end of the iteration
 * @param {object} record the history record (lunasworkRules shape)
 * @param {{evidenceDir?:string|null, gate?:boolean, changes?:{text:string, kind?:string}[]}} [extra]
 *   gate = a milestone gate passed; changes = the cards closed (LW 2.18)
 */
function buildLap(current, record, extra = {}) {
  const c = isObj(current) ? current : {};
  const build = isObj(c.build) ? c.build : {};
  const critic = isObj(c.critic) ? c.critic : {};
  const journeys = isObj(c.report) && Array.isArray(c.report.journeys) ? c.report.journeys.filter(isObj) : [];
  return cleanLap({
    n: record.n,
    milestone: record.milestone,
    score: record.score,
    cardsPlanned: (c.cards || []).length,
    // B1: a card counts as closed once the Playtester confirmed it.
    cardsClosed: isObj(c.verify) ? c.verify.closed : build.closed,
    cardsOpened: critic.cardsOpened,
    cardsUpdated: critic.cardsUpdated,
    selfCheck: record.selfCheck,
    skipped: build.skipped,
    buildError: build.error,
    integrationBranch: build.integrationBranch,
    fixups: build.fixups,
    playtestOk: c.playtest ? c.playtest.ok : null,
    playtestError: c.playtest ? c.playtest.error : null,
    criticVerdict: critic.verdict,
    shipAgrees: c.ship ? c.ship.agrees : null,
    checkpoint: c.checkpoint,
    rolledBack: record.rolledBack,
    journeysPassed: journeys.filter((j) => j.passed === true).map((j) => j.name),
    journeysFailed: journeys.filter((j) => j.passed === false).map((j) => j.name),
    decisions: critic.decisions,
    evidenceDir: extra.evidenceDir,
    notes: c.hookNotes,
    gate: extra.gate === true,
    changes: extra.changes,
    screens: isObj(c.report) ? c.report.screens : [],
  });
}

function cleanLaps(raw) {
  const byN = new Map();
  for (const lap of (Array.isArray(raw) ? raw : []).map(cleanLap)) if (lap) byN.set(lap.n, lap);
  return [...byN.values()].sort((a, b) => a.n - b.n).slice(-MAX_LAPS);
}

// closed = cards whose work landed on main; built = of those, the ones now
// waiting for the Playtester (B1); noTest = bug cards kept open (idea #3).
const BUILD_KEYS = {
  selfCheck: 'str', error: 'str', integrationBranch: 'str', fixups: 'num', closed: 'ats', built: 'ats', noTest: 'ats', skipped: 'bool',
};
const PASS_KEYS = { ok: 'bool', agrees: 'bool', error: 'str', model: 'str', reason: 'str' };
// B1: what the Playtester's pass did to the built cards; failed = this
// iteration's cards that ended open (B4 counts them).
const VERIFY_KEYS = { closed: 'ats', reopened: 'ats', waiting: 'ats', failed: 'ats' };
const MAX_QUARANTINE = 50;
// Loop hooks done this iteration (src/lunasworkLoopHooks.js): a restart never repeats one.
const HOOK_KEYS = { refreshed: 'bool', i18n: 'bool', lighthouse: 'bool', reviewed: 'bool', skills: 'bool' };
const MAX_GATES_MAILED = 50;

/** The loop hooks' notes of one iteration (failures, skips) for the run report. */
function cleanHookNotes(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((n) => typeof n === 'string' && n.trim())
    // eslint-disable-next-line no-control-regex
    .map((n) => n.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_LOG_TEXT))
    .slice(-MAX_HOOK_NOTES);
}

/** Per-iteration Lighthouse results (the dashboard trend), validated, sorted, capped. */
function cleanLighthouse(raw) {
  const list = (Array.isArray(raw) ? raw : []).reduce(
    (history, e) => (isObj(e) && Number.isInteger(e.iteration) ? appendResult(history, e.iteration, e.results) : history),
    [],
  );
  return [...list].slice(-MAX_LIGHTHOUSE_ENTRIES);
}

/** A milestone gate the second opinion keeps closed until the next Critic or Mati's answer. */
function cleanGateHold(raw) {
  if (!isObj(raw) || !str(raw.milestone, 200) || !Number.isInteger(raw.n)) return null;
  return {
    milestone: str(raw.milestone, 200),
    next: str(raw.next, 200),
    n: raw.n,
    reason: GATE_HOLD_REASONS.includes(raw.reason) ? raw.reason : 'verdict',
    cli: str(raw.cli, 20),
    decisionId: Number.isSafeInteger(raw.decisionId) ? raw.decisionId : null,
    // Mati opened it while its iteration was still ending (applied as it ends).
    approved: raw.approved === true,
  };
}

function emptyCurrent() {
  return {
    cards: [], notes: null, planId: null, build: null, launch: null, report: null, playtest: null, verify: null,
    critic: null, ship: null, replay: null, checkpoint: null, hooks: null, hookNotes: [],
  };
}

/** B9: the journeys a same-code replay saw ({name, passed}), or null. */
function cleanReplay(raw) {
  if (!isObj(raw) || !Array.isArray(raw.journeys)) return null;
  return {
    ok: raw.ok === true,
    journeys: raw.journeys
      .filter((j) => isObj(j) && typeof j.name === 'string' && j.name && typeof j.passed === 'boolean')
      .slice(0, MAX_ITEMS)
      .map((j) => ({ name: j.name.slice(0, 200), passed: j.passed })),
  };
}

/** B4: failed iterations per card `at`. */
function cleanFailCounts(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [at, n] of Object.entries(raw)) if (Number.isFinite(Number(at)) && Number.isInteger(n) && n > 0) out[at] = n;
  return out;
}

/** B9: the run's quarantined (flaky) tests, one entry per name. */
function cleanQuarantine(raw) {
  const byName = new Map();
  for (const q of Array.isArray(raw) ? raw : []) {
    if (!isObj(q) || typeof q.name !== 'string' || !q.name || byName.has(q.name)) continue;
    byName.set(q.name, { name: q.name.slice(0, 200), n: Number.isInteger(q.n) ? q.n : 0, ...(Number.isFinite(q.card) ? { card: q.card } : {}) });
  }
  return [...byName.values()].slice(-MAX_QUARANTINE);
}

function cleanCurrent(raw) {
  const c = isObj(raw) ? raw : {};
  const build = cleanSmall(c.build, BUILD_KEYS);
  return {
    cards: (Array.isArray(c.cards) ? c.cards : []).map(cleanCard).filter(Boolean).slice(0, MAX_ITEMS),
    notes: str(c.notes, MAX_TEXT_CHARS),
    // The God Mode plan of this iteration's build: a restart finishes it (lunasworkBuild).
    planId: str(c.planId, 100),
    build: build && ['green', 'red'].includes(build.selfCheck) ? build : null,
    launch: cleanSmall(c.launch, { ok: 'bool', error: 'str' }),
    report: cleanReport(c.report),
    playtest: cleanSmall(c.playtest, PASS_KEYS),
    verify: cleanSmall(c.verify, VERIFY_KEYS),
    critic: cleanCritic(c.critic),
    ship: cleanSmall(c.ship, PASS_KEYS),
    replay: cleanReplay(c.replay),
    // Saved before the iteration ends: a restart never tags or reverts twice.
    checkpoint: cleanCheckpoint(c.checkpoint),
    hooks: cleanSmall(c.hooks, HOOK_KEYS),
    hookNotes: cleanHookNotes(c.hookNotes),
  };
}

function cleanSources(raw) {
  const src = isObj(raw) ? raw : {};
  const out = {};
  for (const role of ROLES) out[role] = MODEL_SOURCES.includes(src[role]) ? src[role] : 'global';
  return out;
}

/**
 * A run read back from the store, or null. The core fields go through
 * lunasworkRules.normalizeStoredRun; the controller's own fields are checked
 * here. preprod and done are controller phases the rules module does not know.
 * @param {unknown} raw
 * @returns {object|null}
 */
function restoreRun(raw) {
  if (!isObj(raw)) return null;
  const phase = ALL_PHASES.includes(raw.phase) ? raw.phase : 'directing';
  const core = normalizeStoredRun({ ...raw, phase: PHASES.includes(phase) ? phase : 'directing' });
  if (!core) return null;
  const verdict = FINAL_VERDICTS.includes(raw.verdict) ? raw.verdict : null;
  return {
    ...core,
    phase,
    // A done run without a verdict was stopped.
    verdict: phase === DONE ? verdict || 'stop' : null,
    modelSources: cleanSources(raw.modelSources),
    phaseStartedAt: finite(raw.phaseStartedAt),
    waitUntil: phase === DONE ? null : finite(raw.waitUntil),
    waitReason: str(raw.waitReason, 40),
    limitedUntil: finite(raw.limitedUntil),
    stopRequested: raw.stopRequested === true,
    endedAt: finite(raw.endedAt),
    endNotified: raw.endNotified === true,
    log: (Array.isArray(raw.log) ? raw.log : []).map(cleanLogEntry).filter(Boolean).slice(-MAX_LOG),
    conflicts: cleanConflicts(raw.conflicts),
    lastCritic: cleanCritic(raw.lastCritic),
    evidenceDir:
      typeof raw.evidenceDir === 'string' && path.isAbsolute(raw.evidenceDir) ? raw.evidenceDir.slice(0, MAX_PATH_CHARS) : null,
    current: cleanCurrent(raw.current),
    // Pinned when Mati confirmed the start: the commands he saw are the ones
    // that run, whatever the settings say later. Re-validated like settings.
    profile: settingsStore.validateProfile(raw.profile).profile,
    checkCommand: cleanCommand(raw.checkCommand),
    // Consecutive failed tries of one phase (retried, then STOP).
    failures:
      isObj(raw.failures) && ALL_PHASES.includes(raw.failures.phase) && Number.isInteger(raw.failures.count) && raw.failures.count > 0
        ? { phase: raw.failures.phase, count: raw.failures.count }
        : null,
    // Every God Mode plan this run made: only those may be replaced by its next build.
    // One summary per finished iteration (the run report).
    laps: cleanLaps(raw.laps),
    // The decision queue (lunasworkDecisions.js): pending ones survive a restart.
    decisions: restoreQueue(raw.decisions),
    // B17: mid-run feedback items with their triage and status (lunasworkFeedback.js).
    feedback: restoreFeedback(raw.feedback),
    // B4: failed iterations per card; B9: quarantined flaky tests, per run.
    failCounts: cleanFailCounts(raw.failCounts),
    quarantine: cleanQuarantine(raw.quarantine),
    // B7: Lighthouse results per iteration (the dashboard trend).
    lighthouse: cleanLighthouse(raw.lighthouse),
    // LW 2.17a: tokens / cost per role and iteration, phase durations (src/lunasworkUsage.js).
    usage: cleanLedger(raw.usage),
    // B8: a gate the second opinion disagreed with stays closed until resolved.
    gateHold: phase === DONE ? null : cleanGateHold(raw.gateHold),
    // C11 "Hand me the wheel": asked for (pauses at the end of the iteration),
    // when it was handed and main's commit then, a hand-back under way, and
    // the newest phone wheel action applied (never applied twice).
    handRequested: phase !== DONE && raw.handRequested === true,
    handedAt: phase === HANDED ? finite(raw.handedAt) : null,
    handBase: phase === HANDED && typeof raw.handBase === 'string' && SHA_RE.test(raw.handBase) ? raw.handBase : null,
    handBackRequested: phase === HANDED && raw.handBackRequested === true,
    wheelSeq: Number.isSafeInteger(raw.wheelSeq) && raw.wheelSeq > 0 ? raw.wheelSeq : 0,
    // LW 2.18: the milestone gates already mailed - one email per gate, across restarts.
    gatesMailed: names(raw.gatesMailed).slice(-MAX_GATES_MAILED),
    // LW 2.22a: the docs iteration SHIP waits for.
    shipDocs: cleanShipDocs(raw.shipDocs),
    planIds: (Array.isArray(raw.planIds) ? raw.planIds : [])
      .filter((id) => typeof id === 'string' && id && id.length <= 100)
      .slice(-MAX_PLAN_IDS),
  };
}

/** Recent scores per milestone, oldest first, for the status view. */
function scoresByMilestone(history) {
  const out = {};
  for (const r of Array.isArray(history) ? history : []) {
    if (!isObj(r) || !Number.isFinite(r.score)) continue;
    const key = r.milestone || '';
    out[key] = [...(out[key] || []), { n: r.n, score: r.score }].slice(-MAX_RECENT_SCORES);
  }
  return out;
}

module.exports = {
  PREPROD,
  HANDED,
  DONE,
  ALL_PHASES,
  MAX_PLAN_IDS,
  MAX_LOG,
  MAX_LOG_TEXT,
  MAX_TEXT_CHARS,
  BUILD_KEYS,
  PASS_KEYS,
  VERIFY_KEYS,
  HOOK_KEYS,
  riskReason,
  isRiskyCard,
  conflictedPaths,
  landedCards,
  landedFiles,
  parseModelOverride,
  effectiveModels,
  checkCommandFor,
  shipAgrees,
  cleanCard,
  cleanLogEntry,
  cleanConflicts,
  cleanCritic,
  cleanReport,
  cleanSmall,
  cleanReplay,
  cleanRollback,
  cleanCheckpoint,
  buildLap,
  cleanLap,
  cleanLaps,
  cleanHookNotes,
  cleanLighthouse,
  cleanGateHold,
  cleanShipDocs,
  emptyCurrent,
  restoreRun,
  scoresByMilestone,
  keyScreens,
  kindOf,
};
