// ============================================================================
// LunaCore - kill a child process together with everything it started
// ----------------------------------------------------------------------------
// A timed-out step (the end-of-run integrate, a verify) must not leave its
// git / npm / node / claude children running: they hold the worktree folder
// and burn CPU. Two pieces:
//
//   killTree(pid)          - Windows: `taskkill /PID <pid> /T /F` (the whole
//                            tree); elsewhere the descendants are listed with
//                            `pgrep -P` (recursively), then SIGKILL goes to
//                            the process group when the child leads one, else
//                            to the pid, and to every descendant.
//   createProcessScope()   - wraps execFile / exec (or any spawn-like impl)
//                            so every child it starts is remembered until it
//                            exits; killAll() kills the live ones and closes
//                            the scope, so a pass that is still running after
//                            its abort cannot start anything new.
//
// Never throws: every function resolves a typed result.
// ============================================================================

'use strict';

const { execFile, exec } = require('child_process');

const KILL_TIMEOUT_MS = 15 * 1000;
// POSIX tree walk bounds: npm -> node -> workers is a few levels deep.
const MAX_TREE_DEPTH = 8;
const MAX_TREE_SIZE = 256;

const errText = (err) => (err instanceof Error ? err.message : String(err));
const firstLine = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

/** Runs a kill helper binary; resolves {ok, reason?}. */
function runKiller(execFileImpl, bin, args) {
  return new Promise((resolve) => {
    try {
      execFileImpl(bin, args, { windowsHide: true, timeout: KILL_TIMEOUT_MS }, (err, _stdout, stderr) =>
        resolve(err ? { ok: false, reason: firstLine(stderr) || String(err.code || 'failed') } : { ok: true }),
      );
    } catch (err) {
      resolve({ ok: false, reason: errText(err) });
    }
  });
}

/**
 * Kills `pid` and its descendants.
 * @param {number} pid
 * @param {{platform?:string, execFileImpl?:Function, killImpl?:(pid:number, signal:string) => void}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function killTree(pid, opts = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'badPid' };
  const platform = opts.platform || process.platform;
  const execFileImpl = opts.execFileImpl || execFile;
  if (platform === 'win32') return runKiller(execFileImpl, 'taskkill', ['/PID', String(pid), '/T', '/F']);

  const killImpl = opts.killImpl || ((target, signal) => process.kill(target, signal));
  // The whole tree is listed first: once a parent is gone its children are
  // re-parented and can no longer be found by its pid.
  const descendants = await descendantsOf(pid, execFileImpl);
  const quietKill = (target) => {
    try {
      killImpl(target, 'SIGKILL');
      return true;
    } catch {
      return false; // already gone
    }
  };
  // Not a group leader unless spawned detached: then -pid fails, pid is used.
  const root = quietKill(-pid) || quietKill(pid);
  for (const child of descendants) quietKill(child);
  return root ? { ok: true } : { ok: false, reason: 'notFound' };
}

/** `pgrep -P` output: child pids, one per line. */
function listChildren(pid, execFileImpl) {
  return new Promise((resolve) => {
    try {
      execFileImpl('pgrep', ['-P', String(pid)], { windowsHide: true, timeout: KILL_TIMEOUT_MS }, (_err, stdout) =>
        resolve(
          String(stdout || '')
            .split(/\s+/)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0),
        ),
      );
    } catch {
      resolve([]); // no pgrep: only the pid itself is killed
    }
  });
}

/** Every descendant of `pid`, breadth first, bounded. */
async function descendantsOf(pid, execFileImpl) {
  const seen = new Set([pid]);
  const out = [];
  let level = [pid];
  for (let depth = 0; depth < MAX_TREE_DEPTH && level.length; depth += 1) {
    const next = [];
    for (const p of level) {
      for (const c of await listChildren(p, execFileImpl)) {
        if (seen.has(c) || out.length >= MAX_TREE_SIZE) continue;
        seen.add(c);
        out.push(c);
        next.push(c);
      }
    }
    level = next;
  }
  return out;
}

/** The callback a spawn-like call was given (always its last function argument). */
function callbackOf(args) {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    if (typeof args[i] === 'function') return args[i];
  }
  return null;
}

/**
 * Remembers the children started through it, so they can all be killed.
 * @param {{kill?:(pid:number) => Promise<{ok:boolean}>, execFileImpl?:Function, execImpl?:Function}} [opts]
 */
function createProcessScope(opts = {}) {
  const kill = opts.kill || ((pid) => killTree(pid));
  const live = new Set();
  let closed = false;

  function track(child) {
    if (!child || typeof child !== 'object' || !Number.isInteger(child.pid)) return child;
    live.add(child);
    const forget = () => live.delete(child);
    if (typeof child.once === 'function') {
      child.once('exit', forget);
      child.once('error', forget);
    }
    return child;
  }

  /**
   * A spawn-like impl (execFile / exec signature, callback last) whose
   * children are tracked. Once the scope is closed it starts nothing and
   * calls back with an ABORTED error instead.
   */
  function wrap(impl) {
    return (...args) => {
      if (closed) {
        const cb = callbackOf(args);
        const err = Object.assign(new Error('process scope closed'), { code: 'ABORTED', killed: true });
        if (cb) process.nextTick(() => cb(err, '', ''));
        return null;
      }
      return track(impl(...args));
    };
  }

  /**
   * Closes the scope and kills every live child tree.
   * @returns {Promise<{killed:number, failed:number}>}
   */
  async function killAll() {
    closed = true;
    const children = [...live];
    live.clear();
    const results = await Promise.all(
      children.map((c) => Promise.resolve(kill(c.pid)).catch((err) => ({ ok: false, reason: errText(err) }))),
    );
    const killed = results.filter((r) => r && r.ok).length;
    return { killed, failed: results.length - killed };
  }

  return {
    wrap,
    track,
    execFile: wrap(opts.execFileImpl || execFile),
    exec: wrap(opts.execImpl || exec),
    killAll,
    isClosed: () => closed,
    size: () => live.size,
  };
}

module.exports = { killTree, createProcessScope, KILL_TIMEOUT_MS };
