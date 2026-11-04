// ============================================================================
// LunaCore - report email composition root (main process)
// ----------------------------------------------------------------------------
// Builds the Gmail sender, the opt-in reply reader (gmail.readonly, off by
// default - src/gmailread.js), the mail settings store, the God Mode run
// mailer and the nightly summary once, from main's accessors, so main.js only wires
// them (it is far past the file-size guideline).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { createGmailSender } = require('./gmailsend');
const { createGmailReader } = require('./gmailread');
const { createMailPrefs, godmodeEmailOn } = require('./mailprefs');
const { createGodModeMailer } = require('./godmodemail');
const { createPendingRunMail } = require('./godmodePending');
const { createNightlyDigest } = require('./nightlydigest');
const { runJob } = require('./missionrunner');

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

/** <runsDir>/<id>.html (written by main's writeReport), or null when missing, too big or the id is bad. */
function readRunHtml(runsDir, id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id) || typeof runsDir !== 'string' || !runsDir) return null;
  const file = path.join(runsDir, `${id}.html`);
  try {
    if (fs.statSync(file).size > MAX_HTML_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[reportmail] html report unreadable:', err.message);
    return null;
  }
}

// The line orchestraFinalize appends to the .md when the first email failed.
const EMAIL_FAILED_LINE_RE = /\n- Email failed: [^\n]*\n?$/;

/**
 * <runsDir>/<id>.md (the run's markdown report), or null when missing, too
 * big or the id is bad. The "- Email failed" line a failed first try left at
 * the end is cut off: a later send of the same report succeeds.
 */
function readRunText(runsDir, id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id) || typeof runsDir !== 'string' || !runsDir) return null;
  const file = path.join(runsDir, `${id}.md`);
  try {
    if (fs.statSync(file).size > MAX_HTML_BYTES) return null;
    return fs.readFileSync(file, 'utf8').replace(EMAIL_FAILED_LINE_RE, '\n');
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[reportmail] run report unreadable:', err.message);
    return null;
  }
}

/**
 * @param {{runsDir:()=>string, listProjects:()=>Array<{id:string, name:string, todos:Array}>,
 *   getUsage:()=>object|null, getEnv:()=>object, onResume:(fn:Function)=>void,
 *   onRunMailResult?:(runId:string, res:{sent:boolean, reason:string|null})=>void}} deps
 *   onRunMailResult: a pending / resent run email's outcome, for the board
 */
function createReportMail(deps) {
  const sender = createGmailSender();
  const reader = createGmailReader();
  const prefs = createMailPrefs();
  const godmode = createGodModeMailer({ sender, prefs, enabled: godmodeEmailOn, readHtml: (id) => readRunHtml(deps.runsDir(), id) });
  // The run email's first try, the pending ones after Gmail connects, Resend.
  const runMail = createPendingRunMail({
    prefs,
    send: (id, text, summary, opts) => godmode.onReport(id, text, summary, opts),
    readReport: (id) => readRunText(deps.runsDir(), id),
    connected: () => sender.status().connected,
    onResult: deps.onRunMailResult,
  });
  const gitstation = () => require('./gitstation');
  const nightly = createNightlyDigest({
    prefs,
    sender,
    runsDir: deps.runsDir,
    listRepos: () => gitstation().loadRepoList().repos,
    runGit: (dir, args, timeoutMs) => gitstation().git(dir, args, timeoutMs),
    listProjects: deps.listProjects,
    getUsage: deps.getUsage,
    run: runJob,
    getEnv: deps.getEnv,
    onResume: deps.onResume,
  });
  return { sender, reader, prefs, godmode, runMail, nightly };
}

module.exports = { createReportMail, readRunHtml, readRunText };
