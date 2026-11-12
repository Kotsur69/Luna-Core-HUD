// ============================================================================
// LunaCore - Claude setup switcher (main process)
// ----------------------------------------------------------------------------
// Machine-wide Claude Code setups are profiles on `setup/<name>` branches of
// github.com/Kotsur69/claude-code-setup; its CLI, tools/luna-setup.mjs,
// rewrites ~/.claude for one of them (`use <profile>`, with a backup). This
// module owns a clone of that repo and runs the CLI for the widget
// (src/renderer/modules/claudesetup.js, IPC in src/claudesetupipc.js).
//
//   * The clone lives in ~/.luna-setup-repo and is made on first use. Every
//     list() runs `git fetch` + a fast-forward first; when that fails (offline)
//     the existing clone is used and the answer carries `stale: true`.
//   * The CLI runs under LunaCore's own binary with ELECTRON_RUN_AS_NODE=1
//     (same as src/lunasworkDemo.js) - no shell, no node on PATH needed. Args
//     are constants plus, for `use`, one profile name that must match NAME_RE
//     AND be one the CLI itself just listed. `--offline` is always passed:
//     LunaCore did the fetching, the CLI need not fetch again.
//   * JSON contract (`--json`): list -> [{name, description, active}],
//     status -> {profile, appliedAt, measure}, use -> {report, measure,
//     running}, use --dry-run -> the same without writing. Output that is not
//     JSON means a switcher from before --json: {ok:false,
//     error:'switcher-too-old'}. `use` is only ever run after a JSON `list`
//     succeeded, so an old switcher (which would read `--json` as a stray word
//     and really apply) never gets that far.
//   * Every spawn has a timeout and kills its whole tree when it fires. Every
//     call resolves {ok:true, ...} or {ok:false, error}; nothing throws.
//     Calls run one at a time, so a fetch never races a `use`.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { killTree } = require('./lunasworkAdapters');

const REPO_URL = 'https://github.com/Kotsur69/claude-code-setup.git';
const REPO_DIRNAME = '.luna-setup-repo';
const SCRIPT_PARTS = Object.freeze(['tools', 'luna-setup.mjs']);

// Profile names as the widget may send them: no dots, slashes or a leading
// dash, so a name can neither climb out of the CLI's cache folder nor be read
// as an option.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

const DEFAULT_TIMEOUTS = Object.freeze({
  clone: 2 * 60 * 1000,
  fetch: 45 * 1000,
  list: 60 * 1000,
  status: 60 * 1000,
  preview: 2 * 60 * 1000,
  // `use` installs missing plugins through `claude plugin install` (up to 90 s each).
  apply: 10 * 60 * 1000,
  count: 15 * 1000,
});

const MAX_BUFFER = 8 * 1024 * 1024;
// How long a timed-out call waits for its tree kill before resolving anyway.
const KILL_WAIT_MS = 5000;
const MAX_DESCRIPTION = 200;
const MAX_LINE = 240;
const MAX_LINES = 60;
const MAX_DETAIL = 200;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);
const bad = (error, detail) => (detail ? { ok: false, error, detail } : { ok: false, error });

/** Is this a profile name the switcher may be asked about? */
function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/**
 * The JSON a CLI printed, or undefined when there is none. Takes the whole
 * output first; failing that, the last block that starts a line with { or [
 * (so a stray progress line printed before the JSON does not hide it).
 */
function parseJsonOutput(text) {
  const s = String(text || '').trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to the line scan */
  }
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const head = lines[i].trimStart();
    if (head[0] !== '{' && head[0] !== '[') continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      /* keep looking further up */
    }
  }
  return undefined;
}

/** measure.approxAlwaysOnTokens as a whole number, or null. */
function tokensOf(measure) {
  const n = isObj(measure) ? measure.approxAlwaysOnTokens : undefined;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

const countOrNull = (n) => (Number.isInteger(n) && n >= 0 ? n : null);

/** A list of short display lines, bounded in count and length. */
function linesOf(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (typeof x === 'string' ? oneLine(x, MAX_LINE) : ''))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

/** `list --json` -> [{name, description, active}], dropping anything malformed. */
function normalizeProfiles(data) {
  const seen = new Set();
  const out = [];
  for (const p of data) {
    if (!isObj(p) || !validName(p.name) || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ name: p.name, description: oneLine(p.description, MAX_DESCRIPTION), active: p.active === true });
  }
  return out;
}

/** A `use` answer (dry run or real) -> what the widget shows. */
function normalizeUse(name, data) {
  const report = isObj(data.report) ? data.report : data;
  return {
    ok: true,
    profile: name,
    from: typeof report.from === 'string' ? oneLine(report.from, 60) || null : null,
    steps: linesOf(report.steps),
    warnings: linesOf(report.warnings),
    running: countOrNull(data.running),
    tokens: tokensOf(data.measure),
  };
}

/** The last non-empty stderr line (the CLI prints `luna-setup: <message>`). */
function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return oneLine(lines.length ? lines[lines.length - 1] : '', MAX_DETAIL);
}

/** Waits for a tree kill, but never longer than KILL_WAIT_MS. */
function killAndWait(kill, pid) {
  let cap = null;
  const capped = new Promise((resolve) => {
    cap = setTimeout(resolve, KILL_WAIT_MS);
  });
  const killed = Promise.resolve()
    .then(() => kill(pid))
    .catch(() => {});
  return Promise.race([killed, capped]).finally(() => clearTimeout(cap));
}

/**
 * Runs one program, no shell. Resolves {ok, code, stdout, stderr, timedOut};
 * never rejects. `code` is the exit code (0 on success, null when the program
 * never ran or was killed). On timeout the whole tree is killed (the CLI
 * spawns git and claude) before this resolves; off Windows the child gets its
 * own process group so that kill reaches the grandchildren too.
 */
function runFile(command, args, { cwd, env, timeoutMs, execFile, kill, platform }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    let child = null;
    try {
      child = execFile(
        command,
        args,
        { cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32', maxBuffer: MAX_BUFFER, encoding: 'utf8' },
        (error, stdout, stderr) => {
          // Killed by our own timer: that is a timeout, not a CLI failure.
          if (timedOut) return finish({ ok: false, code: null, stdout: '', stderr: '', timedOut: true });
          const code = !error ? 0 : Number.isInteger(error.code) ? error.code : null;
          finish({ ok: !error, code, stdout: String(stdout || ''), stderr: String(stderr || '') || (error ? errText(error) : ''), timedOut: false });
        },
      );
    } catch (err) {
      finish({ ok: false, code: null, stdout: '', stderr: errText(err), timedOut: false });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      const done = () => finish({ ok: false, code: null, stdout: '', stderr: '', timedOut: true });
      if (child && Number.isInteger(child.pid)) killAndWait(kill, child.pid).then(done);
      else done();
    }, timeoutMs);
  });
}

const defaultLog = (line) => console.error(line);

/**
 * @param {{repoDir?:string, repoUrl?:string, nodePath?:string,
 *   getEnv?:()=>Record<string,string>, execFile?:Function, kill?:(pid:number)=>Promise<boolean>|boolean,
 *   fs?:{existsSync:(p:string)=>boolean}, platform?:string,
 *   timeouts?:Partial<typeof DEFAULT_TIMEOUTS>, log?:(line:string)=>void}} [deps]
 */
function createClaudeSetup(deps = {}) {
  const repoDir = deps.repoDir || path.join(os.homedir(), REPO_DIRNAME);
  const repoUrl = deps.repoUrl || REPO_URL;
  const nodePath = deps.nodePath || process.execPath;
  const getEnv = deps.getEnv || (() => process.env);
  const execFile = deps.execFile || childProcess.execFile;
  const platform = deps.platform || process.platform;
  const fsImpl = deps.fs || fs;
  const log = deps.log || defaultLog;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(isObj(deps.timeouts) ? deps.timeouts : {}) };
  const kill = deps.kill || ((pid) => killTree(pid, { platform, execFile, kill: process.kill.bind(process) }));
  // Only ever pointed at repoDir after a clone LunaCore itself started there
  // failed (the folder did not exist before). Retries ride out a git child
  // that still holds a file for a moment after the kill.
  const removeDir = deps.removeDir || ((dir) => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const script = path.join(repoDir, ...SCRIPT_PARTS);

  let chain = Promise.resolve();
  let applying = false;

  /** One call at a time: a fetch must never race a `use` on the same clone. */
  function serial(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  function exists(p) {
    try {
      return fsImpl.existsSync(p);
    } catch {
      return false;
    }
  }

  function baseEnv() {
    let source = {};
    try {
      source = getEnv() || {};
    } catch {
      source = process.env;
    }
    // No inherited GIT_* (a stray GIT_DIR or GIT_CONFIG_* would point `git -C`
    // somewhere else), and a private repo must never wait on a credentials
    // prompt nobody can see.
    const env = Object.fromEntries(Object.entries(source).filter(([k]) => !/^GIT_/i.test(k)));
    env.GIT_TERMINAL_PROMPT = '0';
    return env;
  }

  const run = (command, args, timeoutMs, cwd) =>
    runFile(command, args, {
      cwd,
      env: command === nodePath ? { ...baseEnv(), ELECTRON_RUN_AS_NODE: '1' } : baseEnv(),
      timeoutMs,
      execFile,
      kill,
      platform,
    });

  const git = (args, timeoutMs) => run('git', ['-C', repoDir, ...args], timeoutMs);

  /** The clone, made on first use. Never touches a folder that is not one. */
  async function ensureClone() {
    if (exists(path.join(repoDir, '.git'))) return { ok: true, cloned: false };
    if (exists(repoDir)) return bad('repo-broken');
    const res = await run('git', ['clone', '--quiet', repoUrl, repoDir], timeouts.clone);
    if (!res.ok) {
      log(`[claudesetup] clone failed: ${res.timedOut ? 'timeout' : lastLine(res.stderr)}`);
      // A killed clone can leave a half-made .git behind, which every later
      // call would take for a good clone. The folder did not exist before
      // this clone, so it is ours to remove; the next list() clones afresh.
      if (exists(repoDir)) {
        try {
          await removeDir(repoDir);
        } catch (err) {
          log(`[claudesetup] could not remove the failed clone: ${errText(err)}`);
        }
      }
      return bad(res.timedOut ? 'timeout' : 'clone-failed');
    }
    return { ok: true, cloned: true };
  }

  /** The clone with the CLI in it (no fetch). */
  async function ready() {
    const repo = await ensureClone();
    if (!repo.ok) return repo;
    return exists(script) ? repo : bad('no-switcher');
  }

  /** `git fetch` + fast-forward. false = offline or diverged: use the clone as it is. */
  async function update() {
    const fetched = await git(['fetch', '--quiet', 'origin'], timeouts.fetch);
    if (!fetched.ok) {
      log(`[claudesetup] fetch failed, using the existing clone: ${fetched.timedOut ? 'timeout' : lastLine(fetched.stderr)}`);
      return false;
    }
    // The CLI itself lives on the default branch: fast-forward so a newer
    // switcher (e.g. one that learned --json) arrives with the profiles.
    const merged = await git(['merge', '--ff-only', '--quiet', '@{u}'], timeouts.fetch);
    if (!merged.ok) log(`[claudesetup] fast-forward skipped: ${merged.timedOut ? 'timeout' : lastLine(merged.stderr)}`);
    return true;
  }

  /** Runs the CLI with constant args (+ a checked name). -> {ok, data} | {ok:false, error}. */
  async function switcher(args, timeoutMs) {
    const res = await run(nodePath, [script, ...args, '--json', '--offline'], timeoutMs, repoDir);
    if (res.timedOut) return bad('timeout');
    const data = parseJsonOutput(res.stdout);
    if (!res.ok) {
      const detail = isObj(data) && typeof data.error === 'string' ? oneLine(data.error, MAX_DETAIL) : lastLine(res.stderr);
      log(`[claudesetup] luna-setup ${args[0]} failed: ${detail}`);
      return bad('failed', detail);
    }
    if (data === undefined || data === null) return bad('switcher-too-old');
    return { ok: true, data };
  }

  /** The profiles the CLI knows right now (no fetch). */
  async function profiles() {
    const res = await switcher(['list'], timeouts.list);
    if (!res.ok) return res;
    if (!Array.isArray(res.data)) return bad('switcher-too-old');
    return { ok: true, profiles: normalizeProfiles(res.data) };
  }

  /** A claude process count from the OS, or null when it cannot be read. */
  async function countRunning() {
    const res =
      platform === 'win32'
        ? await run(tasklistPath(), ['/FI', 'IMAGENAME eq claude.exe', '/NH', '/FO', 'CSV'], timeouts.count)
        : await run('pgrep', ['-x', 'claude'], timeouts.count);
    if (res.timedOut) return null;
    const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (platform === 'win32') return res.ok ? lines.filter((l) => /^"claude\.exe"/i.test(l)).length : null;
    if (res.ok) return lines.length;
    // pgrep exits 1 when nothing matches: a zero. Anything else (no pgrep,
    // a crash) is unknown, not zero.
    return res.code === 1 ? 0 : null;
  }

  /** tasklist from System32, never whatever a PATH entry offers under that name. */
  function tasklistPath() {
    const env = baseEnv();
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
    return path.win32.join(root, 'System32', 'tasklist.exe');
  }

  /** Validates `name` against the CLI's own list, then runs `use`. */
  async function use(name, { dryRun }) {
    if (!validName(name)) return bad('bad-name');
    const repo = await ready();
    if (!repo.ok) return repo;
    const listed = await profiles();
    if (!listed.ok) return listed;
    if (!listed.profiles.some((p) => p.name === name)) return bad('unknown-profile');
    const args = dryRun ? ['use', name, '--dry-run'] : ['use', name];
    const res = await switcher(args, dryRun ? timeouts.preview : timeouts.apply);
    if (!res.ok) return res;
    if (!isObj(res.data)) return bad('switcher-too-old');
    const out = normalizeUse(name, res.data);
    if (out.running === null) out.running = await countRunning();
    return out;
  }

  // ---- the four calls -----------------------------------------------------------

  /** -> {ok, profiles:[{name, description, active}], stale} | {ok:false, error}. */
  function list() {
    return serial(async () => {
      try {
        const repo = await ensureClone();
        if (!repo.ok) return repo;
        const fresh = repo.cloned ? true : await update();
        // Checked after the fetch: a clone made before the CLI reached the
        // default branch picks it up here instead of staying broken.
        if (!exists(script)) return bad('no-switcher');
        const res = await profiles();
        return res.ok ? { ...res, stale: !fresh } : res;
      } catch (err) {
        log(`[claudesetup] list crashed: ${errText(err)}`);
        return bad('failed');
      }
    });
  }

  /** -> {ok, profile, appliedAt, tokens} | {ok:false, error}. profile null = unmanaged. */
  function status() {
    return serial(async () => {
      try {
        const repo = await ready();
        if (!repo.ok) return repo;
        const res = await switcher(['status'], timeouts.status);
        if (!res.ok) return res;
        if (!isObj(res.data)) return bad('switcher-too-old');
        const d = res.data;
        return {
          ok: true,
          profile: typeof d.profile === 'string' && d.profile ? oneLine(d.profile, 60) : null,
          appliedAt: typeof d.appliedAt === 'string' && d.appliedAt ? oneLine(d.appliedAt, 40) : null,
          tokens: tokensOf(d.measure),
        };
      } catch (err) {
        log(`[claudesetup] status crashed: ${errText(err)}`);
        return bad('failed');
      }
    });
  }

  /** `use <name> --dry-run`: what would change, and how many claude processes run. */
  function preview(name) {
    if (!validName(name)) return Promise.resolve(bad('bad-name'));
    return serial(async () => {
      try {
        return await use(name, { dryRun: true });
      } catch (err) {
        log(`[claudesetup] preview crashed: ${errText(err)}`);
        return bad('failed');
      }
    });
  }

  /** `use <name>` for real: rewrites ~/.claude (the CLI keeps a backup). One at a time. */
  function apply(name) {
    if (!validName(name)) return Promise.resolve(bad('bad-name'));
    if (applying) return Promise.resolve(bad('busy'));
    applying = true;
    return serial(async () => {
      try {
        return await use(name, { dryRun: false });
      } catch (err) {
        log(`[claudesetup] apply crashed: ${errText(err)}`);
        return bad('failed');
      } finally {
        applying = false;
      }
    });
  }

  return { list, status, preview, apply, repoDir };
}

module.exports = {
  REPO_URL,
  REPO_DIRNAME,
  NAME_RE,
  DEFAULT_TIMEOUTS,
  validName,
  parseJsonOutput,
  tokensOf,
  createClaudeSetup,
};
