// ============================================================================
// LunaCore - Luna's Work dashboard: the view the renderer may see (LW 2.17a)
// ----------------------------------------------------------------------------
// dashboardView(run, {runsRoot, isKnownProject}) rebuilds the run record
// (controller.snapshot()) field by field for the HUD dashboard
// (src/renderer/modules/lunasworkDashboard.js), on lunaswork:dashboard:
//
//   timeline     one row per finished iteration (the laps): score, verdict,
//                self-check, rollback, gate, cards, phase durations
//   scores       every score per milestone over the run (the line chart)
//   usage        tokens / cost per role, run totals, per iteration
//   cards        opened vs closed per iteration (lunasworkUsage.cardsSeries)
//   screenshots  the key screens' latest shots - as paths RELATIVE to the
//                run folder, only when they sit inside it; the picture
//                itself comes through lunaswork:screenshot (screenshotFile)
//   lighthouse   the worst score per category per iteration, when measured
//   shipEstimate null: a slot for the time-to-SHIP estimate (later package)
//
// screenshotFile() is the one check before a file is read for the renderer:
// a run id of the right shape, a relative image path, inside
// <runsRoot>/lunaswork-<runId>/ after every symlink is resolved, no hardlink,
// no NTFS stream. readScreenshot() reads it through one checked file handle
// and only when its first bytes are a PNG / JPEG.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { ALL_PHASES, keyScreens } = require('./lunasworkRun');
const { trend } = require('./lunasworkLighthouse');
const { cleanLedger, cardsSeries, phaseTotals } = require('./lunasworkUsage');
const { RUN_ID_RE } = require('./lunasworkWheel');

const VERDICTS = ['ship', 'plateau', 'red', 'stop'];
const MAX_TEXT = 200;
const MAX_MILESTONES = 20;
const MAX_SCORES = 200;
const MAX_TIMELINE = 200;
const MAX_REL_PATH = 300;
// A Playwright PNG is well under this; base64 adds a third on the way to the renderer.
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' && v ? v.slice(0, MAX_TEXT) : null);
const finite = (v) => (Number.isFinite(v) ? v : null);
const time = (v) => (Number.isFinite(v) && v > 0 ? v : null);

/** Every score per milestone, oldest first (the history, not the status' last ten). */
function scoreSeries(history) {
  const out = {};
  for (const r of Array.isArray(history) ? history : []) {
    if (!isObj(r) || !Number.isFinite(r.score) || !Number.isInteger(r.n)) continue;
    const key = text(r.milestone) || '';
    if (!(key in out) && Object.keys(out).length >= MAX_MILESTONES) continue;
    out[key] = [...(out[key] || []), { n: r.n, score: r.score }].slice(-MAX_SCORES);
  }
  return out;
}

function timelineOf(laps, ledger) {
  const phasesOf = new Map(ledger.iterations.map((it) => [it.n, it.phases]));
  return (Array.isArray(laps) ? laps : [])
    .filter((l) => isObj(l) && Number.isInteger(l.n))
    .slice(-MAX_TIMELINE)
    .map((l) => ({
      n: l.n,
      milestone: text(l.milestone),
      score: finite(l.score),
      verdict: l.criticVerdict === 'ship' ? 'ship' : 'continue',
      shipAgrees: typeof l.shipAgrees === 'boolean' ? l.shipAgrees : null,
      selfCheck: l.selfCheck === 'red' ? 'red' : 'green',
      rolledBack: l.rolledBack === true,
      gate: l.gate === true,
      skipped: l.skipped === true,
      buildFailed: typeof l.buildError === 'string' && l.buildError.length > 0,
      playtestOk: typeof l.playtestOk === 'boolean' ? l.playtestOk : null,
      cardsOpened: Number.isInteger(l.cardsOpened) ? l.cardsOpened : 0,
      cardsClosed: Array.isArray(l.cardsClosed) ? l.cardsClosed.length : 0,
      phases: phasesOf.get(l.n) || {},
    }));
}

/** A screenshot's path relative to the run folder ('/' separated), or null when outside it. */
function relativeShot(runDir, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const rel = path.relative(runDir, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function screenshotsOf(laps, runsRoot, runId) {
  if (typeof runsRoot !== 'string' || !path.isAbsolute(runsRoot)) return [];
  const runDir = path.resolve(runsRoot, `lunaswork-${runId}`);
  return keyScreens(laps)
    .map((s) => ({ name: text(s.name) || '', n: s.n, file: relativeShot(runDir, s.screenshot) }))
    .filter((s) => s.file && s.file.length <= MAX_REL_PATH);
}

/**
 * The renderer's dashboard of a run, or null without one.
 * @param {unknown} run controller.snapshot()
 * @param {{runsRoot?:string, isKnownProject:(id:string)=>boolean}} opts
 */
function dashboardView(run, { runsRoot, isKnownProject }) {
  if (!isObj(run) || !RUN_ID_RE.test(String(run.id || ''))) return null;
  const ledger = cleanLedger(run.usage);
  return {
    runId: run.id,
    projectId: typeof run.projectId === 'string' && isKnownProject(run.projectId) ? run.projectId : null,
    active: run.phase !== 'done',
    phase: ALL_PHASES.includes(run.phase) ? run.phase : null,
    iteration: Number.isInteger(run.iteration) && run.iteration >= 0 ? run.iteration : 0,
    milestone: text(run.milestone),
    verdict: VERDICTS.includes(run.verdict) ? run.verdict : null,
    startedAt: time(run.startedAt),
    endedAt: time(run.endedAt),
    timeline: timelineOf(run.laps, ledger),
    scores: scoreSeries(run.history),
    usage: ledger,
    phaseTotals: phaseTotals(ledger),
    cards: cardsSeries(run.laps),
    screenshots: screenshotsOf(run.laps, runsRoot, run.id),
    lighthouse: trend(run.lighthouse),
    // Filled by a later package (time-to-SHIP estimate); the dashboard shows a placeholder.
    shipEstimate: null,
  };
}

/**
 * The file a lunaswork:screenshot request may read, or null. Only an image
 * inside <runsRoot>/lunaswork-<runId>/, after resolving `..` and symlinks;
 * a symlink or a hardlink itself is refused even when it points inside, and
 * so is an NTFS stream (`a.txt:x.png`).
 * @param {unknown} req {runId, file} - file relative to the run folder
 * @param {string} runsRoot
 * @param {{realpathSync:Function, lstatSync:Function}} [fsImpl]
 * @returns {{file:string, mime:string, dev:number, ino:number}|null}
 */
function screenshotFile(req, runsRoot, fsImpl = fs) {
  if (!isObj(req) || typeof runsRoot !== 'string' || !path.isAbsolute(runsRoot)) return null;
  const { runId, file } = req;
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
  if (typeof file !== 'string' || !file || file.length > MAX_REL_PATH || CONTROL_CHARS.test(file)) return null;
  if (path.isAbsolute(file) || file.includes(':') || file.startsWith('\\') || file.startsWith('/')) return null;
  if (file.split(/[\\/]/).some((part) => part === '..')) return null;
  const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!mime) return null;
  try {
    const runDir = fsImpl.realpathSync(path.resolve(runsRoot, `lunaswork-${runId}`));
    const target = path.resolve(runDir, file);
    if (!target.startsWith(runDir + path.sep)) return null;
    const stat = fsImpl.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || stat.size > MAX_SCREENSHOT_BYTES) return null;
    // A folder on the way may still be a link (a junction on Windows).
    const real = fsImpl.realpathSync(target);
    if (!real.startsWith(runDir + path.sep)) return null;
    return { file: real, mime, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/** PNG or JPEG by its first bytes - a renamed text file is no screenshot. */
function looksLikeImage(buf, mime) {
  if (mime === 'image/png') return buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47;
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/**
 * The screenshot as a data URL, or null. The checked file is opened once and
 * that handle is checked again (same file, size cap) before it is read, so a
 * swap after screenshotFile() cannot redirect the read.
 * @param {unknown} req {runId, file}
 * @param {string} runsRoot
 * @param {object} [fsImpl] fs
 * @returns {string|null}
 */
function readScreenshot(req, runsRoot, fsImpl = fs) {
  const target = screenshotFile(req, runsRoot, fsImpl);
  if (!target) return null;
  let fd = null;
  try {
    fd = fsImpl.openSync(target.file, 'r');
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile() || st.dev !== target.dev || st.ino !== target.ino || st.size > MAX_SCREENSHOT_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    const read = fsImpl.readSync(fd, buf, 0, st.size, 0);
    const bytes = buf.subarray(0, read);
    return looksLikeImage(bytes, target.mime) ? `data:${target.mime};base64,${bytes.toString('base64')}` : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fsImpl.closeSync(fd);
  }
}

module.exports = { dashboardView, screenshotFile, readScreenshot, scoreSeries, relativeShot, MAX_SCREENSHOT_BYTES };
