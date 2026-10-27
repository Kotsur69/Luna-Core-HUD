// ============================================================================
// LunaCore - Luna's Work staging (docs/LUNAS_WORK_PLAN.md #10 + C5, LW 3.28a + 3.29)
// ----------------------------------------------------------------------------
// With a stagingUrl in the project profile, every iteration goes to a staging
// copy before the Playtester sees it. applyIteration() runs in the launching
// phase of src/lunaswork.js, on the checkout God Mode just merged:
//
//   1. guard    the iteration diff (git, since the last staged commit) goes
//               through touchesProduction(); a hit is asked in the decision
//               queue (kind `production`, default reject) and NOTHING runs
//               until Mati approves it
//   2. backup   a schema change in the diff (a migration file) first takes a
//               data snapshot: stagingBackupCommand writes into
//               <runs>/lunaswork-<id>/backups/iter-<N>/ ($LUNA_BACKUP_DIR),
//               and backup.json links it to the checkpoint tag. A failed
//               backup means the migration is NOT applied.
//   3. migrate  stagingMigrateCommand (migrations + edge functions)
//   4. deploy   stagingDeployCommand
//   5. the web adapter then tests stagingUrl instead of a local launch
//
// Every failed step is a bug card (once while it is open) and a run-log note;
// the Playtester then gets no app (launch failed) rather than a stale staging
// build, and nothing ever runs against production.
//
// Rollback (src/lunasworkCheckpoint.js): restoreData() puts back the snapshot
// taken before the first schema change after the good tag, right after the
// code revert reached origin. Retention: the last BACKUP_KEEP_LAST backups,
// every milestone gate / SHIP / rolled-back iteration (the evidence rule of
// src/lunasworkMachine.js), and the one the next rollback would need.
//
// TRUST BOUNDARY: every command comes ONLY from the run's pinned profile,
// which only comes from LunaCore's local settings (src/lunasworkSettings.js).
// The target repo and model output are only ever read here (the diff), never
// run, and no caller can pass a command in any other way.
//
// git / the command runner / the clock are injected, so the tests run fakes.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const paths = require('./paths');
const { applyCards } = require('./lunasworkCritic');
const { tagName, guardedGit } = require('./lunasworkCheckpoint');
const { evidenceDirFor, killTree } = require('./lunasworkAdapters');
const { evidenceToKeep } = require('./lunasworkMachine');
const { APPROVE, REJECT, MIGRATION_PATH_RE } = require('./lunasworkDecisions');
const { runTag } = require('./todorows');

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
// git's empty tree: the diff base when nothing older is known (a new repo).
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const STATE_FILE = 'staging.json';
const BACKUPS_DIR = 'backups';
const MANIFEST_FILE = 'backup.json';
const STAGING_LOG = 'staging.log';
const ITER_DIR_RE = /^iter-(\d{1,6})$/;
const BACKUP_KEEP_LAST = 3;
const STEP_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 10 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// Long lines are scanned in overlapping windows, so nothing hides past the first one.
const MAX_SCAN_CHARS = 2000;
const SCAN_OVERLAP = 300;
// How many hits a question or a card lists; every hit is still gated.
const MAX_HITS = 20;
// Keys one decision can cover; hits past this are asked again (held, never waved through).
const MAX_KEYS = 1000;
const MAX_ENTRIES = 50;
const MAX_NAMES = 20;
const TAIL_CHARS = 600;
// Lock files are huge and never point at an environment.
const DIFF_EXCLUDES = [':(exclude,glob)**/package-lock.json', ':(exclude,glob)**/pnpm-lock.yaml', ':(exclude,glob)**/*.lock'];

// The profile field of each step's command.
const STEP_COMMANDS = {
  backup: 'stagingBackupCommand',
  migrate: 'stagingMigrateCommand',
  deploy: 'stagingDeployCommand',
  restore: 'stagingRestoreCommand',
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = 300) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
// Command output goes into cards (synced) and notes: database CLIs echo
// connection strings on failure, so credentials are masked first.
const redact = (text) =>
  String(text)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@'"`]+@/gi, '$1***@')
    .replace(/\b(password|passwd|pwd|token|secret|apikey|api_key|service_role_key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2***');

/** Staging is on when the pinned profile names a stagingUrl. */
const isStaging = (profile) => isObj(profile) && typeof profile.stagingUrl === 'string' && profile.stagingUrl !== '';

// ---- the production guard (pure) ------------------------------------------------------

// A Supabase project ref: 20 lowercase letters, found where a ref is named.
const REF_PATTERNS = [
  /--project-ref(?:=|\s+)["']?([a-z]{20})\b/g,
  /\b([a-z]{20})\.supabase\.(?:co|in|com)\b/g,
  // Pooler connection strings log in as postgres.<ref>.
  /\bpostgres\.([a-z]{20})\b/g,
];
const URL_HOST_RE = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s@/'"`]*@)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)/gi;
// `--prod` / `--production` (vercel, netlify), except in an install command,
// where both only mean "skip dev dependencies". Checked per shell command, so
// `npm ci --production && vercel deploy --prod` still counts.
const PROD_FLAG_RE = /(?<![\w-])--prod(?:uction)?(?![\w-])/;
const PKG_INSTALL_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|add)\b/;
const SHELL_SPLIT_RE = /&&|\|\||[;|]/;
// Environment selectors set to production. NODE_ENV is left out on purpose:
// it is a build mode (`NODE_ENV=production next build`), not a target; so is
// `--target` (`docker build --target production` names a build stage).
const ENV_ASSIGN_RE = /\b(?:APP_ENV|ENV|ENVIRONMENT|DEPLOY_ENV|TARGET_ENV|DEPLOY_TARGET|STAGE|RAILS_ENV|SUPABASE_ENV|VERCEL_ENV)\s*[:=]\s*["']?(?:prod|production|live)\b/i;
const ENV_FLAG_RE = /(?<![\w-])--(?:env|environment|stage)(?:=|\s+)["']?(?:prod|production|live)\b/i;
const ENV_SECTION_RE = /\[\s*env\.(?:prod|production)\s*\]/i;
// Files that only exist for production: .env.production, config/production.*, k8s/prod/...
const PROD_PATH_RE = /(^|\/)\.env\.prod(uction)?(\.|$)|(^|\/)(prod|production)(\/|\.[a-z0-9]+$)/i;
// Committed templates (.env.production.example) hold no real values.
const TEMPLATE_RE = /\.(?:example|sample|template|dist)$/i;
// Commands that act on whatever remote project is linked - production unless
// the staging ref is on the same line.
const REMOTE_CMD_RE = /\bsupabase\s+(?:db\s+push|db\s+reset\s+--linked|functions\s+deploy|secrets\s+set|link|migration\s+repair)\b/;
const DEPLOY_CMD_RE = /\b(?:flyctl|fly)\s+deploy\b|\brailway\s+up\b|\bgit\s+push\s+heroku\b/;
// Prose never touches anything.
const DOCS_RE = /\.(md|mdx|txt|rst)$|(^|\/)design\//i;

function refsIn(text) {
  const out = [];
  for (const re of REF_PATTERNS) for (const m of String(text).matchAll(re)) out.push(m[1]);
  return [...new Set(out)];
}

function hostsIn(text) {
  return [...new Set([...String(text).matchAll(URL_HOST_RE)].map((m) => m[1].toLowerCase()))];
}

const isProdHost = (host) => host.split(/[.-]/).some((label) => label === 'prod' || label === 'production');

/** The staging project refs and hosts the profile names: those are never production. */
function stagingTargets(profile) {
  const p = isObj(profile) ? profile : {};
  const texts = ['stagingUrl', ...Object.values(STEP_COMMANDS)].map((k) => (typeof p[k] === 'string' ? p[k] : ''));
  return { refs: new Set(texts.flatMap(refsIn)), hosts: new Set(texts.flatMap(hostsIn)) };
}

/**
 * A unified diff -> its files and added lines (removed lines never count).
 * @param {string} text `git diff` output
 * @returns {{files: Array<{path:string, status:'added'|'modified'|'deleted'}>, added: Array<{file:string, text:string}>}}
 */
function parseDiff(text) {
  const files = [];
  const added = [];
  let current = null;
  let inHunk = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git "?a\/.+?"? "?b\/(.+?)"?$/.exec(line);
      current = { path: m ? m[1] : '', status: 'modified' };
      files.push(current);
      inHunk = false;
    } else if (!current) {
      continue;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (!inHunk) {
      if (line.startsWith('new file mode')) current.status = 'added';
      else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    } else if (line.startsWith('+')) {
      added.push({ file: current.path, text: line.slice(1) });
    }
  }
  return { files, added };
}

/** A line in overlapping windows of MAX_SCAN_CHARS: bounded regex work, full coverage. */
function windowsOf(text) {
  if (text.length <= MAX_SCAN_CHARS) return [text];
  const out = [];
  for (let i = 0; ; i += MAX_SCAN_CHARS - SCAN_OVERLAP) {
    out.push(text.slice(i, i + MAX_SCAN_CHARS));
    if (i + MAX_SCAN_CHARS >= text.length) return out;
  }
}

/** Every production hit on one (window of an) added line. */
function lineHits(line, safe) {
  const out = [];
  const refs = refsIn(line);
  for (const ref of refs) if (!safe.refs.has(ref)) out.push({ kind: 'projectRef', text: `project ref ${ref}` });
  for (const host of hostsIn(line)) if (!safe.hosts.has(host) && isProdHost(host)) out.push({ kind: 'url', text: `URL host ${host}` });
  const flag = line
    .split(SHELL_SPLIT_RE)
    .filter((cmd) => !PKG_INSTALL_RE.test(cmd))
    .map((cmd) => PROD_FLAG_RE.exec(cmd))
    .find(Boolean);
  if (flag) out.push({ kind: 'flag', text: `${flag[0]} flag` });
  const env = ENV_ASSIGN_RE.exec(line) || ENV_FLAG_RE.exec(line) || ENV_SECTION_RE.exec(line);
  if (env) out.push({ kind: 'env', text: `production env "${oneLine(env[0], 60)}"` });
  const remote = REMOTE_CMD_RE.exec(line);
  if (remote && !refs.some((r) => safe.refs.has(r))) out.push({ kind: 'command', text: `"${oneLine(remote[0], 60)}" without the staging project ref` });
  const deploy = DEPLOY_CMD_RE.exec(line);
  if (deploy) out.push({ kind: 'command', text: `deploy command "${oneLine(deploy[0], 60)}"` });
  return out;
}

/**
 * Whether a diff touches production: prod project refs and URLs, production
 * deploy commands, `--prod` flags, production environment names and files.
 * Pure. The staging refs and hosts of the profile never count. Every hit is
 * returned. A key names the file and the line, so an approval covers exactly
 * that line: the same hit text in another file or on a changed line is new.
 * @param {string} diff unified diff (`git diff` output)
 * @param {object|null} profile the run's pinned profile
 * @returns {{reason:string, hits:Array<{kind:string, text:string, file:string, key:string}>}|null}
 */
function touchesProduction(diff, profile) {
  const { files, added } = parseDiff(typeof diff === 'string' ? diff : '');
  const safe = stagingTargets(profile);
  const hits = new Map();
  const hit = (kind, text, file, line) => {
    const lineId = line === undefined ? '' : `:${crypto.createHash('sha1').update(line.trim()).digest('hex').slice(0, 12)}`;
    const key = `${kind}:${file}:${text}${lineId}`;
    if (!hits.has(key)) hits.set(key, { kind, text, file, key });
  };
  for (const f of files) {
    if (f.status === 'deleted' || DOCS_RE.test(f.path) || TEMPLATE_RE.test(f.path)) continue;
    if (PROD_PATH_RE.test(f.path)) hit('envFile', `production file ${f.path}`, f.path);
  }
  for (const { file, text } of added) {
    if (DOCS_RE.test(file)) continue;
    for (const part of windowsOf(text)) for (const h of lineHits(part, safe)) hit(h.kind, h.text, file, text);
  }
  if (!hits.size) return null;
  const list = [...hits.values()];
  const shown = [...new Set(list.map((h) => h.text))];
  return { reason: `touches production: ${shown.slice(0, 3).join(', ')}${shown.length > 3 ? ', ...' : ''}`, hits: list };
}

/** The diff's schema changes (the decision queue's migration rule). */
function migrationFiles(diff) {
  return parseDiff(typeof diff === 'string' ? diff : '').files.filter((f) => MIGRATION_PATH_RE.test(f.path)).map((f) => f.path);
}

// ---- backups (paths + retention) --------------------------------------------------------

function runDirFor(runsRoot, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error('runId must be 1-40 lowercase letters or digits');
  const root = path.resolve(runsRoot);
  const dir = path.resolve(root, `lunaswork-${runId}`);
  if (!dir.startsWith(root + path.sep)) throw new Error('run dir escapes the runs folder');
  return dir;
}

/** <runsRoot>/lunaswork-<id>/backups/iter-<N>, from a validated id and iteration only. */
function backupDirFor(runsRoot, runId, iteration) {
  if (!Number.isInteger(iteration) || iteration < 1) throw new Error('iteration must be a whole number from 1');
  return path.join(runDirFor(runsRoot, runId), BACKUPS_DIR, `iter-${iteration}`);
}

/** The last iteration a rollback could go back to (lunasworkRules' isGood), or 0. */
function lastGoodIteration(history) {
  const good = (Array.isArray(history) ? history : []).filter(
    (r) => isObj(r) && Number.isInteger(r.n) && r.selfCheck === 'green' && r.coreJourneysOk !== false && r.rolledBack !== true,
  );
  return good.length ? Math.max(...good.map((r) => r.n)) : 0;
}

/**
 * Pure: which backups stay. The evidence rule (the last `keepLast`, the
 * current iteration, milestone gates, SHIP and rolled-back iterations), plus
 * the first backup after the last good iteration - the one a rollback needs.
 * @param {{iterations:number[], history?:object[], laps?:object[], current?:number, keepLast?:number}} input
 * @returns {Set<number>}
 */
function backupsToKeep({ iterations, history = [], laps = [], current, keepLast = BACKUP_KEEP_LAST }) {
  const keep = evidenceToKeep({ iterations, history, laps, current, keepLast });
  const good = lastGoodIteration(history);
  const needed = (Array.isArray(iterations) ? iterations : []).filter((n) => Number.isInteger(n) && n > good).sort((a, b) => a - b)[0];
  if (needed !== undefined) keep.add(needed);
  return keep;
}

// ---- disk -------------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** The run's staging state; a missing or broken file reads as a fresh one. */
function cleanState(raw) {
  const s = isObj(raw) ? raw : {};
  const production = (Array.isArray(s.production) ? s.production : [])
    .filter((e) => isObj(e) && Number.isSafeInteger(e.decisionId) && Array.isArray(e.keys))
    .map((e) => ({ decisionId: e.decisionId, keys: e.keys.filter((k) => typeof k === 'string').slice(0, MAX_KEYS), cardFiled: e.cardFiled === true }))
    .slice(-MAX_ENTRIES);
  const backups = (Array.isArray(s.backups) ? s.backups : []).filter((n) => Number.isInteger(n) && n > 0).slice(-MAX_ENTRIES);
  return { lastAppliedSha: typeof s.lastAppliedSha === 'string' && SHA_RE.test(s.lastAppliedSha) ? s.lastAppliedSha : null, production, backups };
}

/** A backup's manifest, or null when there is none (a failed or half-written backup). */
function readManifest(dir) {
  const m = readJson(path.join(dir, MANIFEST_FILE));
  return isObj(m) && Number.isInteger(m.iteration) && typeof m.tag === 'string' ? m : null;
}

/** Every backups/iter-N folder of a run: [{n, dir, manifest}], oldest first. */
function listBackups(runDir) {
  const root = path.join(runDir, BACKUPS_DIR);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const m = ITER_DIR_RE.exec(name);
      return m ? { n: Number(m[1]), dir: path.join(root, name) } : null;
    })
    .filter(Boolean)
    .map((b) => ({ ...b, manifest: readManifest(b.dir) }))
    .sort((a, b) => a.n - b.n);
}

// ---- the command runner -----------------------------------------------------------------

const lastLines = (text) => oneLine(String(text).trim().split('\n').slice(-3).join(' | '), 300);

/**
 * Default runner: one profile command through the shell in the project dir,
 * its output appended to logFile, the whole tree killed on a timeout.
 * @returns {Promise<{ok:boolean, code:number|null, detail:string}>}
 */
function runShell({ command, cwd, env, logFile, timeoutMs = STEP_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let log = null;
    let timer = null;
    let settled = false;
    let timedOut = false;
    let tail = '';
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      log = fs.createWriteStream(logFile, { flags: 'a' });
      // Stream errors arrive as events: an unheard one would crash the main process.
      log.on('error', () => {
        log = null;
      });
      log.write(`[lunaswork] $ ${command}\n`);
    } catch {
      log = null;
    }
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!log) return resolve(res);
      log.write(`[lunaswork] ${res.ok ? 'ok' : `failed: ${res.detail}`}\n`);
      return log.end(() => resolve(res));
    };
    let child;
    try {
      child = childProcess.spawn(command, {
        cwd,
        env: { ...process.env, ...env },
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      done({ ok: false, code: null, detail: `could not start: ${errText(err)}` });
      return;
    }
    const onData = (chunk) => {
      if (log) log.write(chunk);
      tail = (tail + String(chunk)).slice(-TAIL_CHARS);
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    const timedOutResult = () => ({ ok: false, code: null, detail: `timed out after ${Math.round(timeoutMs / 60000)} min` });
    timer = setTimeout(() => {
      timedOut = true;
      if (Number.isInteger(child.pid)) killTree(child.pid, { platform: process.platform, execFile: childProcess.execFile, kill: process.kill.bind(process) });
      // A grandchild holding the pipes keeps 'close' away: the step ends anyway.
      timer = setTimeout(() => done(timedOutResult()), KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', (err) => done({ ok: false, code: null, detail: `could not start: ${errText(err)}` }));
    child.on('close', (code) =>
      done(timedOut ? { ...timedOutResult(), code } : { ok: code === 0, code, detail: lastLines(tail) }),
    );
  });
}

/** Default git runner with room for a whole iteration's diff. Never rejects. */
function execStagingGit(cwd, args) {
  return new Promise((resolve) => {
    childProcess.execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: GIT_MAX_BUFFER }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim().split('\n')[0] }),
    );
  });
}

// ---- cards ------------------------------------------------------------------------------

const STEP_CARDS = {
  diff: "Staging is held: Luna's Work could not read the iteration diff",
  backup: 'Staging backup failed - the migration was not applied to staging',
  migrate: 'Staging migration failed - fix the migrations or edge functions so they apply to staging',
  deploy: 'Staging deploy failed - fix the app so it deploys to staging',
  restore: 'Staging data was not restored after a rollback - restore the snapshot by hand',
};

const STEP_ACCEPTANCE = {
  diff: ['The staging step of the next iteration reads the diff and goes on'],
  backup: ['The staging backup command succeeds before the next schema change', 'The held migration is applied to staging'],
  migrate: ['The staging migrate command succeeds in the next iteration'],
  deploy: ['The staging deploy command succeeds in the next iteration', 'The Playtester reaches the staging URL'],
  restore: ['The staging data matches the code on the base branch again'],
};

function stepCard(step, { iteration, detail, logFile, extra = [] }) {
  return {
    kind: 'bug',
    severity: 'high',
    text: STEP_CARDS[step],
    details: [
      `Iteration ${iteration}: the staging ${step} step failed${detail ? `: ${oneLine(detail, 300)}` : ''}.`,
      ...extra,
      ...(logFile ? [`Log: ${logFile}`] : []),
      'Nothing was run against production.',
    ].join('\n'),
    acceptance: STEP_ACCEPTANCE[step],
    files: [],
    updatesCardId: null,
  };
}

function productionCard(hits, decisionId) {
  return {
    kind: 'bug',
    severity: 'high',
    text: 'Remove the production-touching change Mati rejected - staging is held until it is gone',
    details: [
      `Decision ${decisionId} rejected applying this change to staging. What points at production:`,
      ...hitList(hits).map((line) => `- ${line}`),
    ].join('\n'),
    acceptance: ['The iteration diff no longer points at production', 'The change applies to staging again'],
    files: [...new Set(hits.map((h) => h.file).filter(Boolean))].slice(0, MAX_NAMES),
    updatesCardId: null,
  };
}

/** Hits as "<what> (<file>)", the first MAX_HITS and a count of the rest. */
function hitList(hits) {
  const shown = hits.slice(0, MAX_HITS).map((h) => `${h.text}${h.file ? ` (${h.file})` : ''}`);
  return hits.length > MAX_HITS ? [...shown, `and ${hits.length - MAX_HITS} more`] : shown;
}

/** The question a production hit puts in the decision queue. */
function productionDecision(hits) {
  return {
    kind: 'production',
    question: 'This iteration changes something that points at production. Apply it to staging anyway?',
    detail: hitList(hits).join('; '),
    options: [APPROVE, REJECT],
    defaultAnswer: REJECT,
  };
}

/** One card unless an open one with the same text is there already. @returns {boolean} filed */
function fileCard(store, runId, card) {
  const tag = runTag(runId);
  if (!store || !tag) return false;
  try {
    const list = store.read();
    if ((Array.isArray(list) ? list : []).some((t) => isObj(t) && !t.done && t.text === card.text)) return false;
    const res = applyCards(store, [card], tag);
    return res.created.length > 0;
  } catch {
    return false;
  }
}

// ---- the flow ---------------------------------------------------------------------------

/**
 * @param {{runCommand?:(o:{step:string, command:string, cwd:string, env:object, logFile:string})=>Promise<{ok:boolean, code?:number|null, detail?:string}>,
 *   git?:(cwd:string, args:string[])=>Promise<{ok:boolean, out:string, err:string}>,
 *   runsRoot?:()=>string, now?:()=>number, log?:(line:string)=>void}} [deps]
 */
function createStaging(deps = {}) {
  const runCommand = deps.runCommand || runShell;
  const git = guardedGit(deps.git || execStagingGit);
  const runsRoot = deps.runsRoot || (() => path.join(paths.userDir(), 'runs'));
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});

  /** One profile command. Never throws. */
  async function runStep(step, profile, o) {
    const command = profile[STEP_COMMANDS[step]];
    const env = { LUNA_STAGING_STEP: step, LUNA_RUN_ID: o.runId, LUNA_ITERATION: String(o.iteration), ...(o.backupDir ? { LUNA_BACKUP_DIR: o.backupDir } : {}) };
    try {
      const res = await runCommand({ step, command, cwd: o.repoPath, env, logFile: o.logFile });
      return isObj(res) ? { ok: res.ok === true, detail: oneLine(redact(res.detail || (res.ok ? '' : `exit ${res.code}`)), 300) } : { ok: false, detail: 'no result' };
    } catch (err) {
      return { ok: false, detail: oneLine(redact(errText(err)), 300) };
    }
  }

  /** Where the diff starts: the last staged commit, else main before the run, else the empty tree. */
  async function diffBase(repoPath, state, startedAt, head) {
    if (state.lastAppliedSha && (await git(repoPath, ['merge-base', '--is-ancestor', state.lastAppliedSha, head])).ok) return state.lastAppliedSha;
    if (Number.isFinite(startedAt)) {
      const before = new Date(startedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const res = await git(repoPath, ['rev-list', '-n', '1', '--first-parent', `--before=${before}`, head]);
      if (res.ok && SHA_RE.test(res.out)) return res.out;
    }
    return EMPTY_TREE;
  }

  /** The decision queue's side of a production hit: whether every hit is approved. */
  function productionGate(ctx, run, state, prod) {
    const byId = new Map((Array.isArray(run.decisions) ? run.decisions : []).map((d) => [d.id, d]));
    const statusOf = (e) => {
      const d = byId.get(e.decisionId);
      if (!d) return null;
      if (d.status === 'pending') return 'pending';
      return d.answer === APPROVE ? 'approved' : 'rejected';
    };
    // An entry whose decision left the queue is gone; its hits are asked again.
    let entries = state.production.filter((e) => statusOf(e));
    const coverOf = (key) => [...entries].reverse().find((e) => e.keys.includes(key)) || null;
    const uncovered = prod.hits.filter((h) => !coverOf(h.key));
    const covers = [...new Set(prod.hits.map((h) => coverOf(h.key)).filter(Boolean))];
    if (uncovered.length) {
      const asked = ctx.ask(productionDecision(uncovered));
      if (isObj(asked) && asked.ok) entries = [...entries, { decisionId: asked.id, keys: uncovered.map((h) => h.key), cardFiled: false }];
      else ctx.logEvent(`staging: the production question was not queued (${oneLine(asked && asked.reason, 60)}) - staging stays held`);
    }
    for (const e of covers.filter((c) => statusOf(c) === 'rejected' && !c.cardFiled)) {
      const hits = prod.hits.filter((h) => e.keys.includes(h.key));
      fileCard(ctx.todoStore, run.id, productionCard(hits, e.decisionId));
      entries = entries.map((x) => (x.decisionId === e.decisionId ? { ...x, cardFiled: true } : x));
    }
    const clear = !uncovered.length && covers.every((c) => statusOf(c) === 'approved');
    return { clear, state: { ...state, production: entries.slice(-MAX_ENTRIES) } };
  }

  /** Removes the backups the retention rule lets go. */
  function pruneBackups(run, runDir) {
    const backups = listBackups(runDir);
    const keep = backupsToKeep({ iterations: backups.map((b) => b.n), history: run.history, laps: run.laps, current: run.iteration });
    for (const b of backups.filter((x) => !keep.has(x.n))) {
      try {
        fs.rmSync(b.dir, { recursive: true, force: true });
      } catch (err) {
        log(`[lunaswork] staging backup ${b.dir} not removed: ${errText(err)}`);
      }
    }
  }

  /** The data snapshot before this iteration's schema change; one taken before a restart is kept. */
  async function takeBackup(run, o, base, migrations) {
    const dir = backupDirFor(runsRoot(), run.id, run.iteration);
    if (readManifest(dir)) return { ok: true, dir, kept: true };
    fs.mkdirSync(dir, { recursive: true });
    const res = await runStep('backup', run.profile, { ...o, backupDir: dir });
    if (!res.ok) return { ok: false, dir, detail: res.detail };
    const good = lastGoodIteration(run.history);
    const manifest = {
      runId: run.id,
      iteration: run.iteration,
      // The checkpoint this iteration gets when it is green ...
      tag: tagName(run.id, run.iteration),
      // ... and the one whose data the snapshot holds (a rollback target).
      dataOf: good ? tagName(run.id, good) : null,
      base,
      migrations: migrations.slice(0, MAX_NAMES),
      takenAt: now(),
    };
    if (!writeJson(path.join(dir, MANIFEST_FILE), manifest)) return { ok: false, dir, detail: 'backup.json not written' };
    pruneBackups(run, path.dirname(path.dirname(dir)));
    return { ok: true, dir, kept: false };
  }

  /**
   * The launching phase's staging step: guard -> backup -> migrate -> deploy.
   * No staging in the profile: nothing happens. Never throws.
   * @param {{run:()=>object, ask:(spec:object)=>{ok:boolean, id?:number, reason?:string},
   *   logEvent:(text:string)=>void, todoStore:{read:Function, write:Function}}} ctx
   * @returns {Promise<{ok:true, staging:boolean, migrated?:boolean, backup?:string|null}|{ok:false, code:string, error:string}>}
   */
  async function applyIteration(ctx) {
    const run = ctx.run();
    if (!isStaging(run.profile)) return { ok: true, staging: false };
    const note = (text) => ctx.logEvent(`staging: ${text}`);
    let where;
    try {
      const runDir = runDirFor(runsRoot(), run.id);
      where = { runDir, stateFile: path.join(runDir, STATE_FILE), logFile: path.join(evidenceDirFor(runsRoot(), run.id, run.iteration), STAGING_LOG) };
    } catch (err) {
      return { ok: false, code: 'badRun', error: `staging not applied: ${errText(err)}` };
    }
    const o = { repoPath: run.repoPath, runId: run.id, iteration: run.iteration, logFile: where.logFile };
    const fail = (step, detail, extra) => {
      note(`${step} failed (${oneLine(detail, 200)})${step === 'backup' ? ' - the migration was NOT applied' : ''}`);
      fileCard(ctx.todoStore, run.id, stepCard(step, { iteration: run.iteration, detail, logFile: where.logFile, extra }));
      return { ok: false, code: `${step}Failed`, error: `staging ${step} failed${detail ? `: ${oneLine(detail, 200)}` : ''}` };
    };

    // A lost write means the next lap asks / runs again - Mati sees why in the run log.
    const saveState = (next) => {
      if (writeJson(where.stateFile, next)) return;
      log(`[lunaswork] ${where.stateFile} not written`);
      note(`state not saved (${path.basename(where.stateFile)}) - the next lap repeats this one's staging steps`);
    };
    let state = cleanState(readJson(where.stateFile));
    const head = await git(run.repoPath, ['rev-parse', 'HEAD']);
    if (!head.ok || !SHA_RE.test(head.out)) return fail('diff', `HEAD not readable: ${head.err}`);
    if (state.lastAppliedSha === head.out) {
      note(`already at ${head.out.slice(0, 7)}`);
      return { ok: true, staging: true, migrated: false, backup: null };
    }
    const base = await diffBase(run.repoPath, state, run.startedAt, head.out);
    const diff = await git(run.repoPath, ['diff', '--no-color', '--no-ext-diff', '--unified=0', base, head.out, '--', '.', ...DIFF_EXCLUDES]);
    if (!diff.ok) return fail('diff', diff.err);

    const prod = touchesProduction(diff.out, run.profile);
    if (prod) {
      const gate = productionGate(ctx, run, state, prod);
      state = gate.state;
      saveState(state);
      if (!gate.clear) {
        note(`held - ${prod.reason}; waiting for Mati in the decision queue`);
        return { ok: false, code: 'productionHeld', error: `staging held: ${prod.reason}` };
      }
      note(`production-touching change approved by decision (${oneLine(prod.reason, 150)})`);
    }

    const migrations = run.profile.stagingMigrateCommand ? migrationFiles(diff.out) : [];
    let backup = null;
    if (migrations.length) {
      let taken;
      try {
        taken = await takeBackup(run, o, base, migrations);
      } catch (err) {
        taken = { ok: false, detail: errText(err) };
      }
      if (!taken.ok) return fail('backup', taken.detail, [`Schema changes held back: ${migrations.slice(0, MAX_NAMES).join(', ')}`]);
      backup = taken.dir;
      note(`${taken.kept ? 'backup from before the restart kept' : 'data snapshot taken'} (${path.basename(taken.dir)}, ${migrations.length} schema change(s))`);
      // Every snapshot taken, so a rollback can tell a pruned one from none at all.
      state = { ...state, backups: [...new Set([...state.backups, run.iteration])].slice(-MAX_ENTRIES) };
      saveState(state);
    }
    for (const step of ['migrate', 'deploy']) {
      if (!run.profile[STEP_COMMANDS[step]]) continue;
      const res = await runStep(step, run.profile, o);
      if (!res.ok) return fail(step, res.detail);
      note(`${step} ok`);
    }
    saveState({ ...state, lastAppliedSha: head.out });
    return { ok: true, staging: true, migrated: migrations.length > 0, backup };
  }

  /**
   * C5: after a rollback to `toIteration`, the snapshot taken before the first
   * schema change after it goes back (src/lunasworkCheckpoint.js calls this
   * once the revert is on origin). Never throws.
   * @param {{repoPath:string, runId:string, iteration:number, toIteration:number, profile:object,
   *   todoStore?:{read:Function, write:Function}}} o
   * @returns {Promise<{restored:boolean, iteration?:number, note:string, error?:string}|null>} null: no staging data
   */
  async function restoreData(o) {
    const profile = isObj(o) ? o.profile : null;
    if (!isStaging(profile) || !profile.stagingRestoreCommand) return null;
    const toTag = tagName(o.runId, o.toIteration) || `iteration ${o.toIteration}`;
    let backups;
    let taken;
    let logFile;
    try {
      const runDir = runDirFor(runsRoot(), o.runId);
      backups = listBackups(runDir);
      taken = cleanState(readJson(path.join(runDir, STATE_FILE))).backups;
      logFile = path.join(evidenceDirFor(runsRoot(), o.runId, o.iteration), STAGING_LOG);
    } catch (err) {
      return { restored: false, error: 'badRun', note: `staging data not restored: ${errText(err)}` };
    }
    const inRange = (n) => n > o.toIteration && n <= o.iteration;
    const pick = backups.find((b) => b.manifest && inRange(b.n));
    // The first snapshot after the target is the only right one: a later one holds migrated data.
    const needed = taken.filter(inRange).sort((a, b) => a - b)[0];
    if (needed !== undefined && (!pick || pick.n !== needed)) {
      fileCard(o.todoStore, o.runId, stepCard('restore', { iteration: o.iteration, detail: `the snapshot from before iteration ${needed}'s schema change is gone`, logFile }));
      return { restored: false, iteration: needed, error: 'snapshotMissing', note: `staging data NOT restored - the iter-${needed} snapshot is gone` };
    }
    if (!pick) return { restored: false, note: `no staging schema change since ${toTag}, staging data kept` };
    const res = await runStep('restore', profile, { repoPath: o.repoPath, runId: o.runId, iteration: o.iteration, logFile, backupDir: pick.dir });
    if (!res.ok) {
      // The command output stays in the card and the log: this note lands in the repo's DECISIONS.md.
      fileCard(o.todoStore, o.runId, stepCard('restore', { iteration: o.iteration, detail: res.detail, logFile, extra: [`Snapshot: ${pick.dir}`] }));
      return { restored: false, iteration: pick.n, error: 'restoreFailed', note: `staging data NOT restored from the iter-${pick.n} snapshot (the restore command failed)` };
    }
    return { restored: true, iteration: pick.n, note: `staging data restored from the snapshot taken before iteration ${pick.n}'s schema change` };
  }

  return { applyIteration, restoreData };
}

/** The staging part of the start confirmation: Mati sees every command that will run. */
function stagingLines(profile) {
  if (!isStaging(profile)) return [];
  return [
    '',
    `Staging URL (the Playtester tests it): ${profile.stagingUrl}`,
    ...['migrate', 'deploy', 'backup', 'restore'].filter((s) => profile[STEP_COMMANDS[s]]).map((s) => `Staging ${s} command: ${profile[STEP_COMMANDS[s]]}`),
    'Anything that touches production waits for your answer in the decision queue.',
  ];
}

module.exports = {
  BACKUP_KEEP_LAST,
  STAGING_LOG,
  MANIFEST_FILE,
  isStaging,
  touchesProduction,
  parseDiff,
  migrationFiles,
  backupDirFor,
  backupsToKeep,
  stagingLines,
  runShell,
  createStaging,
};
