// ============================================================================
// LunaCore - Luna's Work project queue (docs/LUNAS_WORK_PLAN.md, B16)
// ----------------------------------------------------------------------------
// config/lunaswork-queue.local.json (per machine, gitignored like every
// *.local.*): the projects waiting for a Luna's Work run, in order.
//
//   { v: 1, entries: [{ projectId, label, profile, checkCommand, addedAt }] }
//
// Joining: only from the HUD panel (lunasworkipc.js), only a registered
// project with a folder on this PC, a valid project profile in LunaCore's
// local settings and a complete design pack (lunasworkPack.packCompleteness),
// and only after Mati confirmed the commands in a native dialog (main.js) -
// the renderer can write a profile, so the queue never trusts it alone. The
// profile and the effective self-check command are pinned in the entry: a
// queued start whose commands changed since is refused.
//
// Advancing (the controller's notifyRunEnd, src/lunaswork.js): only a run
// that ended with SHIP starts the next entry - after the step loop settled,
// through the controller's own start(), so every start check (God Mode on
// the project, pack, profile) still applies. PLATEAU / RED / STOP leave the
// queue as it is: the run email says the queue is paused (queueEmailNote,
// added in lunasworkWiring.js). An entry leaves the queue only once its run
// has started.
//
// Same contract as the other config loaders: a missing or broken file reads
// as an empty queue, a write returns false on failure, nothing here throws.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { validateProfile } = require('./lunasworkSettings');

const VERSION = 1;
const FILE_NAME = 'lunaswork-queue.local.json';
const defaultFile = () => paths.local(FILE_NAME);
const MAX_ENTRIES = 20;
const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 100;
const MAX_COMMAND_CHARS = 500;
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(CONTROL_CHARS, ' ').trim().slice(0, max) : '');

/** A project id the queue may hold, or null. */
function cleanProjectId(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_ID_CHARS || UNSAFE_IDS.has(raw)) return null;
  return /[\u0000-\u001f\u007f]/.test(raw) ? null : raw;
}

/** One stored entry, re-validated (the profile through validateProfile), or null. */
function normalizeEntry(raw) {
  if (!isObj(raw)) return null;
  const projectId = cleanProjectId(raw.projectId);
  const { profile } = validateProfile(raw.profile);
  if (!projectId || !profile) return null;
  const check = typeof raw.checkCommand === 'string' ? raw.checkCommand : '';
  if (check.length > MAX_COMMAND_CHARS || /[\u0000-\u001f\u007f]/.test(check)) return null;
  return {
    projectId,
    label: oneLine(raw.label, MAX_LABEL_CHARS) || projectId.slice(0, MAX_LABEL_CHARS),
    profile,
    checkCommand: check.trim(),
    addedAt: Number.isFinite(raw.addedAt) && raw.addedAt > 0 ? raw.addedAt : 0,
  };
}

/** @returns {{v:number, entries:object[]}} capped, one entry per project */
function normalizeQueue(raw) {
  const list = isObj(raw) && Array.isArray(raw.entries) ? raw.entries : [];
  const seen = new Set();
  const entries = [];
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.projectId)) continue;
    seen.add(entry.projectId);
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return { v: VERSION, entries };
}

const emptyQueue = () => normalizeQueue(null);

// ---- edits (pure, no mutation) -------------------------------------------------------

/**
 * Why a project may not join, or null when it may.
 * @param {{project:object|null, repoPath:string|null, profile:object|null, pack:{complete:boolean}|null}} ctx
 * @returns {string|null} a lunaswork error reason
 */
function joinProblem({ project, repoPath, profile, pack }) {
  if (!project || !cleanProjectId(project.id)) return 'bad-project';
  if (!repoPath) return 'no-folder';
  if (!profile || !validateProfile(profile).profile) return 'no-profile';
  if (!pack || pack.complete !== true) return 'pack-incomplete';
  return null;
}

/**
 * @param {object} queue
 * @param {{projectId:string, label?:string, profile:object, addedAt?:number}} entry
 * @returns {{queue:object, reason:string|null}}
 */
function addEntry(queue, entry) {
  const q = normalizeQueue(queue);
  const clean = normalizeEntry(entry);
  if (!clean) return { queue: q, reason: 'bad-project' };
  if (q.entries.some((e) => e.projectId === clean.projectId)) return { queue: q, reason: 'queued-already' };
  if (q.entries.length >= MAX_ENTRIES) return { queue: q, reason: 'queue-full' };
  return { queue: { ...q, entries: [...q.entries, clean] }, reason: null };
}

/** @returns {{queue:object, reason:string|null}} */
function removeEntry(queue, projectId) {
  const q = normalizeQueue(queue);
  const entries = q.entries.filter((e) => e.projectId !== projectId);
  if (entries.length === q.entries.length) return { queue: q, reason: 'not-queued' };
  return { queue: { ...q, entries }, reason: null };
}

/**
 * Moves one entry up (-1) or down (+1).
 * @returns {{queue:object, reason:string|null}}
 */
function moveEntry(queue, projectId, delta) {
  const q = normalizeQueue(queue);
  if (delta !== -1 && delta !== 1) return { queue: q, reason: 'bad-move' };
  const from = q.entries.findIndex((e) => e.projectId === projectId);
  if (from < 0) return { queue: q, reason: 'not-queued' };
  const to = from + delta;
  if (to < 0 || to >= q.entries.length) return { queue: q, reason: 'bad-move' };
  const entries = [...q.entries];
  [entries[from], entries[to]] = [entries[to], entries[from]];
  return { queue: { ...q, entries }, reason: null };
}

/** The renderer's copy: names and the pinned commands Mati confirmed, never a path. */
function publicQueue(queue, isKnownProject = () => true) {
  return normalizeQueue(queue)
    .entries.filter((e) => isKnownProject(e.projectId))
    .map((e) => ({ projectId: e.projectId, label: e.label, startCommand: e.profile.startCommand, url: e.profile.url, addedAt: e.addedAt }));
}

/** The phone's copy: labels only (the snapshot leaves the PC). */
function phoneQueue(queue, isKnownProject = () => true) {
  return normalizeQueue(queue)
    .entries.filter((e) => isKnownProject(e.projectId))
    .map((e) => ({ label: e.label }));
}

/** True when the start's profile is exactly the one pinned when the project was queued. */
function sameProfile(pinned, profile) {
  const a = validateProfile(pinned).profile;
  const b = validateProfile(profile).profile;
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True when a start would run exactly what Mati confirmed when he queued
 * the entry: the same profile, the same self-check command, no scaffold.
 * @param {object} entry a queue entry
 * @param {{profile?:object, checkCommand?:string, scaffold?:object}} ctx start()'s confirmation context
 */
function sameCommands(entry, ctx) {
  if (!isObj(entry) || !isObj(ctx) || ctx.scaffold) return false;
  return sameProfile(entry.profile, ctx.profile) && (ctx.checkCommand || '') === (entry.checkCommand || '');
}

// ---- advancing ---------------------------------------------------------------------

/**
 * What a finished run does to the queue. Pure apart from `preflight`.
 * @param {object} queue
 * @param {{verdict:string, projectId?:string}} run the finished run
 * @param {(projectId:string)=>({refusal?:{message?:string, reason?:string}, profile?:object})} preflight
 *   the controller's start checks (startProblem): a refusal, or the profile a start would use
 * @returns {{next:object|null, note:object}|null} null when nothing waits
 */
function planAfterRun(queue, run, preflight = () => ({})) {
  // The project that just ran is never its own successor: a queued project
  // started by hand would otherwise restart itself unattended after SHIP.
  const ranId = isObj(run) ? run.projectId : null;
  const entries = normalizeQueue(queue).entries.filter((e) => e.projectId !== ranId);
  if (!entries.length) return null;
  const head = entries[0];
  const verdict = isObj(run) && typeof run.verdict === 'string' ? run.verdict : 'stop';
  const base = { verdict, waiting: entries.length, nextLabel: head.label };
  if (verdict !== 'ship') return { next: null, note: { ...base, state: 'paused' } };
  let why = null;
  try {
    const checked = preflight(head.projectId) || {};
    if (checked.refusal) why = checked.refusal.message || checked.refusal.reason || 'refused';
    else if (!sameCommands(head, checked)) why = 'its commands changed since it was queued - queue it again';
  } catch {
    // A thrown message may carry a local path: it never goes into the email.
    why = 'the start check failed';
  }
  if (why) return { next: null, note: { ...base, state: 'blocked', why: oneLine(why, 200) } };
  return { next: head, note: { ...base, state: 'advancing', waiting: entries.length - 1 } };
}

/**
 * The run email's QUEUE block for a planAfterRun note, or '' without one.
 * @param {unknown} note
 */
function queueEmailNote(note) {
  if (!isObj(note) || !Number.isInteger(note.waiting)) return '';
  const label = oneLine(note.nextLabel, MAX_LABEL_CHARS) || 'the next project';
  const more = (n) => `${n} project${n === 1 ? '' : 's'}`;
  let line;
  if (note.state === 'advancing') {
    line = `Next in the queue: "${label}" starts now. ${note.waiting ? `${more(note.waiting)} wait after it.` : 'The queue is empty after it.'}`;
  } else if (note.state === 'blocked') {
    line = `Queue paused: "${label}" could not start (${oneLine(note.why, 200)}). ${more(note.waiting)} wait - start it by hand from Luna's Work.`;
  } else {
    const verdict = oneLine(note.verdict, 20).toUpperCase() || 'STOP';
    line = `Queue paused: the run ended with ${verdict}, so the queue does not advance (only SHIP does). ${more(note.waiting)} wait, next "${label}" - start it by hand from Luna's Work.`;
  }
  return ['QUEUE', `- ${line}`].join('\n');
}

/**
 * Starts the planned entry through the controller and takes it off the queue
 * once its run has started. A refused start leaves the queue as it is.
 * @param {{store:{read:()=>object, write:(q:object)=>boolean}, entry:object,
 *   start:(payload:object, confirm:(ctx:object)=>boolean)=>Promise<object>, log?:(line:string)=>void}} ctx
 * @returns {Promise<boolean>} whether a run started
 */
async function startQueued({ store, entry, start, log = () => {} }) {
  try {
    // The confirmation Mati gave when he queued it, for exactly those commands.
    const confirm = (ctx) => sameCommands(entry, ctx);
    const res = await start({ projectId: entry.projectId }, confirm);
    if (!res || !res.ok) {
      log(`[lunaswork] queued project ${entry.projectId} not started: ${(res && (res.message || res.reason)) || 'refused'}`);
      return false;
    }
    log(`[lunaswork] queue: started ${entry.projectId} after SHIP`);
    if (!store.write(removeEntry(store.read(), entry.projectId).queue)) log('[lunaswork] could not save the queue');
    return true;
  } catch (err) {
    log(`[lunaswork] queued start failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---- disk -------------------------------------------------------------------------

/** Reads the queue; empty when the file is missing or broken. Never throws. */
function readQueue(filePath = defaultFile()) {
  try {
    return normalizeQueue(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return emptyQueue();
  }
}

/** Validates and writes the queue. @returns {boolean} whether the write succeeded */
function writeQueue(queue, filePath = defaultFile()) {
  try {
    if (filePath === defaultFile() && !paths.ensureUserDir()) return false;
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalizeQueue(queue), null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

/** The file-backed store the controller and the IPC share. */
function fileQueueStore(filePath) {
  return {
    read: () => (filePath ? readQueue(filePath) : readQueue()),
    write: (q) => (filePath ? writeQueue(q, filePath) : writeQueue(q)),
  };
}

module.exports = {
  MAX_ENTRIES,
  MAX_LABEL_CHARS,
  cleanProjectId,
  normalizeQueue,
  emptyQueue,
  joinProblem,
  addEntry,
  removeEntry,
  moveEntry,
  publicQueue,
  phoneQueue,
  sameProfile,
  sameCommands,
  planAfterRun,
  queueEmailNote,
  startQueued,
  readQueue,
  writeQueue,
  fileQueueStore,
};
