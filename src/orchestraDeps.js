// ============================================================================
// LunaCore - God Mode package worktree dependencies
// ----------------------------------------------------------------------------
// A package worktree starts with no node_modules, yet LunaCore runs a plain
// `npm test` there after LUNA_DONE. So:
//
//   install  right after addWorktree, LunaCore installs the worktree's own
//            dependencies (`npm ci --ignore-scripts`: no Electron download).
//            Installs run ONE AT A TIME across every God Mode run and the
//            integration worktree (a shared queue), so parallel launches do
//            not fight over the npm cache and the disk.
//   check    before a worker starts and before the post-DONE verify, the
//            node_modules the package will use must exist, be non-empty and
//            hold every declared dependency. A failed check pauses the whole
//            run ('noNodeModules') - it is a machine problem, not the
//            package's - until Mati runs npm install and presses Resume.
//
// Workers never link node_modules to the main checkout: removing such a
// worktree once emptied the main checkout's node_modules.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { ensureInstall } = require('./orchestraIntegrate');
const { runVerify } = require('./orchestraFinish');

const WORKER_NPM_COMMAND = 'npm ci --ignore-scripts';
const MAX_DETAIL_CHARS = 300;

/**
 * A FIFO that runs one async job at a time. A job that throws or rejects
 * resolves as `{ok:false, output}` and never blocks the jobs after it.
 * @returns {{run: (job: () => Promise<{ok:boolean, output:string}>) => Promise<{ok:boolean, output:string}>,
 *   pending: () => number}}
 */
function createInstallQueue() {
  let tail = Promise.resolve();
  let waiting = 0;
  const run = (job) => {
    waiting += 1;
    const result = tail.then(async () => {
      try {
        const res = await job();
        return res && typeof res === 'object' ? res : { ok: false, output: 'install returned nothing' };
      } catch (err) {
        return { ok: false, output: err instanceof Error ? err.message : String(err) };
      } finally {
        waiting -= 1;
      }
    });
    tail = result;
    return result;
  };
  return { run, pending: () => waiting };
}

// One queue per LunaCore process: every run's installs share it.
const sharedQueue = createInstallQueue();

/** Any install job (e.g. the integration worktree's) through the shared queue. */
const runQueued = (job) => sharedQueue.run(job);

/**
 * Installs a package worktree's dependencies (ensureInstall: root lockfile,
 * then direct subfolders with their own lockfile), through the shared queue.
 * Nothing to install (no lockfile, node_modules already there) resolves ok.
 * `fresh`: a failed install's partial node_modules is removed first, or the
 * install would skip the folder.
 * @param {string} root
 * @param {{fresh?: boolean, queue?: {run:Function}, verifyImpl?: Function, installImpl?: Function,
 *   fsImpl?: {lstatSync:Function, promises:{rm:Function}}}} [opts]
 * @returns {Promise<{ok:boolean, output:string}>}
 */
function installWorktreeDeps(root, opts = {}) {
  const queue = opts.queue || sharedQueue;
  const install = opts.installImpl || ensureInstall;
  const verifyImpl = opts.verifyImpl || runVerify;
  return queue.run(async () => {
    if (opts.fresh === true) {
      const cleared = await clearPartialInstall(root, opts.fsImpl || fs);
      if (!cleared.ok) return cleared;
    }
    return install(root, verifyImpl, { npmCommand: WORKER_NPM_COMMAND });
  });
}

/**
 * Removes `<root>/node_modules` when it is a real folder of this worktree.
 * A link (junction / symlink) is never followed or removed: its target may be
 * another checkout's node_modules.
 * @returns {Promise<{ok:boolean, output:string}>}
 */
async function clearPartialInstall(root, fsImpl) {
  const dir = path.join(root, 'node_modules');
  let st;
  try {
    st = fsImpl.lstatSync(dir);
  } catch {
    return { ok: true, output: '' };
  }
  if (st.isSymbolicLink()) return { ok: false, output: `${dir} is a link to another folder - not removed; remove the link, then Retry` };
  if (!st.isDirectory()) return { ok: true, output: '' };
  try {
    await fsImpl.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    return { ok: true, output: '' };
  } catch (err) {
    return { ok: false, output: `could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Names of the dependencies package.json declares (optional ones excluded), or null when unreadable. */
function declaredDeps(root, fsImpl) {
  let pkg;
  try {
    pkg = JSON.parse(fsImpl.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== 'object') return null;
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies']) {
    const group = pkg[field];
    if (group && typeof group === 'object') for (const name of Object.keys(group)) names.add(name);
  }
  const optional = pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object' ? pkg.optionalDependencies : {};
  return [...names].filter((n) => !(n in optional)).sort();
}

/**
 * Does the node_modules this folder's `npm test` will use hold its
 * dependencies? Only a folder with package.json + package-lock.json and at
 * least one declared dependency needs one; anything else passes.
 * A junction whose target is gone fails the stat; one whose target was
 * emptied fails the emptiness check.
 * @param {string} root
 * @param {{existsSync:Function, statSync:Function, readdirSync:Function, readFileSync:Function}} [fsImpl]
 * @returns {{ok:true, needed:boolean} | {ok:false, reason:'missing'|'empty'|'unresolved', dir:string, detail:string}}
 */
function checkNodeModules(root, fsImpl = fs) {
  if (typeof root !== 'string' || !root) return { ok: true, needed: false };
  if (!fsImpl.existsSync(path.join(root, 'package-lock.json'))) return { ok: true, needed: false };
  const names = declaredDeps(root, fsImpl);
  if (!names || !names.length) return { ok: true, needed: false };
  const dir = path.join(root, 'node_modules');
  const bad = (reason, detail) => ({ ok: false, reason, dir: root, detail: detail.slice(0, MAX_DETAIL_CHARS) });
  let isDir = false;
  try {
    isDir = fsImpl.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return bad('missing', `${dir} does not exist`);
  let entries;
  try {
    entries = fsImpl.readdirSync(dir);
  } catch (err) {
    return bad('missing', `${dir} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  // npm's own bookkeeping (.package-lock.json, .bin) is not a dependency.
  if (!entries.some((name) => !String(name).startsWith('.'))) return bad('empty', `${dir} is empty`);
  const missing = names.find((name) => !fsImpl.existsSync(path.join(dir, name, 'package.json')));
  if (missing) return bad('unresolved', `${missing} is not in ${dir}`);
  return { ok: true, needed: true };
}

/** The board / notification text, en (the renderer has pl + en: orch.noNodeModules). */
function noNodeModulesText(dir) {
  return `node_modules in ${dir} is empty - run npm install, then Resume`;
}

module.exports = {
  createInstallQueue,
  installWorktreeDeps,
  runQueued,
  checkNodeModules,
  declaredDeps,
  noNodeModulesText,
  WORKER_NPM_COMMAND,
};
