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
//            package's. The hold names the real reason (missing / empty /
//            which package is unresolved) and resumes on its own once the
//            check passes (orchestraHoldWatch.js), or on Resume.
//   heal     a fresh install (the recovery playbook) first checks again and
//            removes nothing when node_modules already passes. It removes
//            with the non-asar fs (plainFs.js): Electron's fs would open
//            electron/dist/resources/default_app.asar as an archive and
//            lock it. A remove that still fails on a held file installs in
//            a sibling temp folder and moves the entries in instead.
//
// Workers never link node_modules to the main checkout: removing such a
// worktree once emptied the main checkout's node_modules.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { ensureInstall } = require('./orchestraIntegrate');
const { runVerify } = require('./orchestraFinish');
const { plainFs } = require('./plainFs');

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

// Fresh installs: a failed rm with one of these codes means a file in
// node_modules is held open (EBUSY / EPERM on Windows): the temp-folder route
// takes over.
const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
// The temp-folder install sits next to the worktree (same drive: rename works).
const TEMP_PREFIX = '_deps-';
// Copied into the temp folder so npm resolves exactly what the worktree would.
const INSTALL_FILES = ['package.json', 'package-lock.json', '.npmrc'];
// The last output line of an install that could not get around a held file:
// the recovery playbook (orchestraRecover.js) asks with this exact cause.
const LOCKED_TEXT = 'a file in node_modules is locked by LunaCore - restart LunaCore, then Retry';

/** resolved root -> the install queued or running for it (never two at once). */
const inFlight = new Map();

/**
 * Installs a package worktree's dependencies (ensureInstall: root lockfile,
 * then direct subfolders with their own lockfile), through the shared queue.
 * Nothing to install (no lockfile, node_modules already there) resolves ok.
 * `fresh`: a failed install's partial node_modules is removed first, or the
 * install would skip the folder - unless node_modules already passes the
 * check (fixed by hand meanwhile). A remove that fails on a held file falls
 * back to an install in a sibling temp folder whose entries are moved in.
 * One install per root at a time: a second request joins the one in flight
 * (a fresh one waits for a plain one, then runs), so nothing is ever removed
 * under a running install.
 * @param {string} root
 * @param {{fresh?: boolean, queue?: {run:Function}, verifyImpl?: Function, installImpl?: Function,
 *   checkImpl?: Function, now?: () => number, fsImpl?: object}} [opts]
 * @returns {Promise<{ok:boolean, output:string, locked?:boolean}>}
 */
function installWorktreeDeps(root, opts = {}) {
  const queue = opts.queue || sharedQueue;
  const fresh = opts.fresh === true;
  const key = path.resolve(String(root || ''));
  const current = inFlight.get(key);
  if (current && (current.fresh || !fresh)) return current.promise;
  const before = current ? current.promise : Promise.resolve();
  // The job runs after the one before it however that one ended.
  const start = () => queue.run(() => installJob(root, opts));
  const promise = before.then(start, start);
  const entry = { promise, fresh };
  inFlight.set(key, entry);
  const done = () => {
    if (inFlight.get(key) === entry) inFlight.delete(key);
  };
  promise.then(done, done);
  return promise;
}

/** Is an install for this root queued or running? */
const installInFlight = (root) => inFlight.has(path.resolve(String(root || '')));

async function installJob(root, opts) {
  const install = opts.installImpl || ensureInstall;
  const verifyImpl = opts.verifyImpl || runVerify;
  const fsImpl = opts.fsImpl || plainFs();
  const check = opts.checkImpl || ((dir) => checkNodeModules(dir, fsImpl));
  const plain = () => install(root, verifyImpl, { npmCommand: WORKER_NPM_COMMAND });
  if (opts.fresh !== true) return plain();
  // Fixed by hand (or by an install that just finished): nothing to remove.
  const pre = check(root);
  if (pre.ok && pre.needed) return plain();
  const cleared = await clearPartialInstall(root, fsImpl);
  if (cleared.ok) return plain();
  if (!cleared.locked) return cleared;
  const viaTemp = await installViaTemp(root, { fsImpl, verifyImpl, check, now: opts.now || Date.now });
  if (!viaTemp.ok) return viaTemp;
  // The root is whole again; direct subfolders (e.g. mobile/) still install as usual.
  return plain();
}

/**
 * Removes `<root>/node_modules` when it is a real folder of this worktree.
 * A link (junction / symlink) is never followed or removed: its target may be
 * another checkout's node_modules. `locked`: the remove failed on a held file.
 * @returns {Promise<{ok:boolean, output:string, locked?:boolean}>}
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
    const locked = !!(err && LOCKED_CODES.has(err.code));
    return { ok: false, locked, output: `could not remove ${dir}: ${errMessage(err)}` };
  }
}

const errMessage = (err) => (err instanceof Error ? err.message : String(err));

/**
 * The temp-folder route around a held file: `npm ci --ignore-scripts` in
 * `<worktrees dir>/_deps-<pkg>-<ts>`, then every top-level entry is renamed
 * into the worktree's node_modules, skipping what is already there. Scope
 * folders and .bin merge one level down; electron's package files merge
 * into the existing electron/ folder, its dist/ is never touched. A
 * package folder the failed remove left without its package.json is a husk,
 * not an existing entry: it is moved aside into the temp folder and replaced.
 * The temp folder (and any one an earlier crash left for this package) is
 * removed afterwards, and the check runs again.
 * @returns {Promise<{ok:boolean, output:string, locked?:boolean}>}
 */
async function installViaTemp(root, { fsImpl, verifyImpl, check, now }) {
  const stem = `${TEMP_PREFIX}${path.basename(root)}-`;
  const temp = path.join(path.dirname(root), `${stem}${now()}`);
  const notes = [];
  await removeStaleTemps(path.dirname(root), stem, fsImpl, notes);
  try {
    fsImpl.mkdirSync(temp, { recursive: true });
    for (const name of INSTALL_FILES) {
      const from = path.join(root, name);
      if (fsImpl.existsSync(from)) fsImpl.copyFileSync(from, path.join(temp, name));
    }
    const res = await verifyImpl(WORKER_NPM_COMMAND, temp);
    if (!res || !res.ok) {
      const npmOut = String((res && res.output) || '').trim();
      return { ok: false, locked: true, output: [npmOut, `${WORKER_NPM_COMMAND} in ${temp} failed`, LOCKED_TEXT].filter(Boolean).join('\n') };
    }
    const aside = path.join(temp, 'replaced');
    const moved = moveEntries(path.join(temp, 'node_modules'), path.join(root, 'node_modules'), fsImpl, { top: true, aside });
    notes.push(`moved ${moved.moved} entries in from ${temp}, ${moved.skipped} already there`, ...moved.failed);
  } catch (err) {
    notes.push(`temp-folder install failed: ${errMessage(err)}`);
  } finally {
    try {
      await fsImpl.promises.rm(temp, { recursive: true, force: true, maxRetries: 5 });
    } catch (err) {
      notes.push(`could not remove ${temp}: ${errMessage(err)}`);
    }
  }
  const after = check(root);
  if (!after.ok) return { ok: false, locked: true, output: [...notes, after.detail || 'still incomplete', LOCKED_TEXT].join('\n') };
  return { ok: true, output: notes.join('\n') };
}

function lstatOrNull(p, fsImpl) {
  try {
    return fsImpl.lstatSync(p);
  } catch {
    return null;
  }
}

/** `_deps-<pkg>-*` folders an earlier (crashed) temp-folder install left behind. */
async function removeStaleTemps(dir, stem, fsImpl, notes) {
  let names = [];
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => String(n).startsWith(stem))) {
    const p = path.join(dir, name);
    const st = lstatOrNull(p, fsImpl);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    try {
      await fsImpl.promises.rm(p, { recursive: true, force: true, maxRetries: 5 });
      notes.push(`removed the leftover ${p}`);
    } catch (err) {
      notes.push(`could not remove the leftover ${p}: ${errMessage(err)}`);
    }
  }
}

/**
 * A package folder a failed recursive remove emptied part-way: a real
 * folder without its package.json (scope folders hold packages, not one).
 */
const isHusk = (dir, name, st, fsImpl) =>
  !!(st && st.isDirectory() && !st.isSymbolicLink() && !name.startsWith('.') && !name.startsWith('@') &&
    !fsImpl.existsSync(path.join(dir, 'package.json')));

/**
 * Renames each entry of `fromDir` into `toDir` when `toDir` has none of that
 * name; a husk (isHusk) is first renamed into `aside` (deleted with the temp
 * folder), then replaced. At the top level, scope folders and .bin merge one
 * level down, and electron/ gets its missing package files but never a dist/.
 * @param {{top:boolean, aside:string, scope?:boolean}} where
 * @returns {{moved:number, skipped:number, failed:string[]}}
 */
function moveEntries(fromDir, toDir, fsImpl, where) {
  const out = { moved: 0, skipped: 0, failed: [] };
  fsImpl.mkdirSync(toDir, { recursive: true });
  for (const name of fsImpl.readdirSync(fromDir)) {
    const from = path.join(fromDir, name);
    const to = path.join(toDir, name);
    const existing = lstatOrNull(to, fsImpl);
    const realDir = !!(existing && existing.isDirectory() && !existing.isSymbolicLink());
    if (where.top && realDir && (name === 'electron' || name.startsWith('@') || name === '.bin')) {
      const sub = name === 'electron'
        ? moveElectronFiles(from, to, fsImpl)
        : moveEntries(from, to, fsImpl, { top: false, aside: path.join(where.aside, name), scope: name.startsWith('@') });
      out.moved += sub.moved;
      out.skipped += sub.skipped;
      out.failed.push(...sub.failed);
    } else if (existing && (where.top || where.scope) && isHusk(to, name, existing, fsImpl) && moveAside(to, path.join(where.aside, name), fsImpl, out)) {
      moveOne(from, to, name, fsImpl, out);
    } else if (existing) {
      out.skipped += 1;
    } else {
      moveOne(from, to, name, fsImpl, out);
    }
  }
  return out;
}

/** Renames a husk out of the way; false (kept, counted as skipped) when it will not move. */
function moveAside(from, to, fsImpl, out) {
  try {
    fsImpl.mkdirSync(path.dirname(to), { recursive: true });
    fsImpl.renameSync(from, to);
    return true;
  } catch (err) {
    out.skipped += 1;
    out.failed.push(`could not replace the incomplete ${path.basename(from)}: ${errMessage(err)}`);
    return false;
  }
}

/** electron/'s own files the existing folder lacks; dist/ stays as it is. */
function moveElectronFiles(fromDir, toDir, fsImpl) {
  const out = { moved: 0, skipped: 0, failed: [] };
  for (const name of fsImpl.readdirSync(fromDir)) {
    const to = path.join(toDir, name);
    if (name === 'dist' || lstatOrNull(to, fsImpl)) out.skipped += 1;
    else moveOne(path.join(fromDir, name), to, `electron/${name}`, fsImpl, out);
  }
  return out;
}

function moveOne(from, to, label, fsImpl, out) {
  try {
    fsImpl.renameSync(from, to);
    out.moved += 1;
  } catch (err) {
    out.failed.push(`could not move ${label}: ${errMessage(err)}`);
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
 * @returns {{ok:true, needed:boolean}
 *   | {ok:false, reason:'missing'|'empty'|'unresolved', dir:string, detail:string, missing?:string}}
 *   `missing`: the first declared dependency that is not installed ('unresolved')
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
  if (missing) return { ...bad('unresolved', `${missing} is not in ${dir}`), missing };
  return { ok: true, needed: true };
}

const HOLD_CAUSES = new Set(['missing', 'empty', 'unresolved']);

/** The hold's cause from a failed check: one of HOLD_CAUSES, or null. */
const holdCause = (res) => (res && HOLD_CAUSES.has(res.reason) ? res.reason : null);

/** Why node_modules fails, in words (en; the renderer has orch.noNodeModules.<cause>). */
function whyText(cause, missing) {
  if (cause === 'missing') return 'the folder does not exist';
  if (cause === 'empty') return 'the folder is empty';
  if (cause === 'unresolved') return missing ? `${missing} is not installed` : 'a dependency is not installed';
  return 'it is incomplete';
}

/**
 * The board / notification text, en (the renderer has pl + en:
 * orch.noNodeModules). Names the real reason and the missing package.
 * @param {string} dir
 * @param {{cause?:string|null, missing?:string|null}} [why]
 */
function noNodeModulesText(dir, why = {}) {
  const w = why && typeof why === 'object' ? why : {};
  return `node_modules in ${dir}: ${whyText(w.cause, w.missing)} - run npm install; the run resumes on its own once it is fixed`;
}

module.exports = {
  createInstallQueue,
  installWorktreeDeps,
  installInFlight,
  runQueued,
  checkNodeModules,
  declaredDeps,
  holdCause,
  noNodeModulesText,
  WORKER_NPM_COMMAND,
  LOCKED_TEXT,
};
