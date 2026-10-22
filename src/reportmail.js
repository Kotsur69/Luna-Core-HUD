// ============================================================================
// LunaCore - report email composition root (main process)
// ----------------------------------------------------------------------------
// Builds the Gmail sender, the mail settings store, the God Mode run mailer
// and the nightly summary once, from main's accessors, so main.js only wires
// them (it is far past the file-size guideline).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { createGmailSender } = require('./gmailsend');
const { createMailPrefs, godmodeEmailOn } = require('./mailprefs');
const { createGodModeMailer } = require('./godmodemail');
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

/**
 * @param {{runsDir:()=>string, listProjects:()=>Array<{id:string, name:string, todos:Array}>,
 *   getUsage:()=>object|null, getEnv:()=>object, onResume:(fn:Function)=>void}} deps
 */
function createReportMail(deps) {
  const sender = createGmailSender();
  const prefs = createMailPrefs();
  const godmode = createGodModeMailer({ sender, prefs, enabled: godmodeEmailOn, readHtml: (id) => readRunHtml(deps.runsDir(), id) });
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
  return { sender, prefs, godmode, nightly };
}

module.exports = { createReportMail, readRunHtml };
