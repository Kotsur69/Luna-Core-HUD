// ============================================================================
// LunaCore - report email composition root (main process)
// ----------------------------------------------------------------------------
// Builds the Gmail sender, the mail settings store, the God Mode run mailer
// and the nightly summary once, from main's accessors, so main.js only wires
// them (it is far past the file-size guideline).
// ============================================================================

'use strict';

const { createGmailSender } = require('./gmailsend');
const { createMailPrefs, godmodeEmailOn } = require('./mailprefs');
const { createGodModeMailer } = require('./godmodemail');
const { createNightlyDigest } = require('./nightlydigest');
const { runJob } = require('./missionrunner');

/**
 * @param {{runsDir:()=>string, listProjects:()=>Array<{id:string, name:string, todos:Array}>,
 *   getUsage:()=>object|null, getEnv:()=>object, onResume:(fn:Function)=>void}} deps
 */
function createReportMail(deps) {
  const sender = createGmailSender();
  const prefs = createMailPrefs();
  const godmode = createGodModeMailer({ sender, prefs, enabled: godmodeEmailOn });
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

module.exports = { createReportMail };
