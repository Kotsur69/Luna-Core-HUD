// ============================================================================
// LunaCore - God Mode v2 supervisor rules (ORCHESTRATOR_PLAN.md slice 4)
// ----------------------------------------------------------------------------
// Pure decisions only - no timers, no git, no tabs. src/orchestra.js owns the
// state and the side effects and asks this module what a signal means:
//
//   turn end   -> did the worker print LUNA_DONE / LUNA_BLOCKED for ITS
//                 package? none -> nudge (max MAX_NUDGES) -> stalled
//   finish     -> verify failed -> paste it back (max MAX_VERIFY_ROUNDS)
//   slot freed -> which pending packages have every dependency pushed
//   restart    -> anything that was running is stalled (tab ids do not
//                 survive a restart), its worktree kept for a Retry
//
// Package phases: pending -> launched -> finishing -> pushed, with failed
// (could not launch), stalled, closed (tab closed by hand) and killed (kill
// switch) as the ways out. Only launched/finishing hold a worker slot.
// ============================================================================

'use strict';

const path = require('path');
const { findTurnEndMessage, textBlocks } = require('./ttsExtract');
const { WORKTREE_DIR, BRANCH_PREFIX } = require('./worktrees');

const MAX_NUDGES = 3;
const MAX_VERIFY_ROUNDS = 2;
// Active working time per worker, usage-limit pauses excluded.
const WORKER_CAP_MS = 120 * 60 * 1000;
// Lines from the end of the final message searched for the marker - a worker
// sometimes adds a sentence after it despite the brief.
const MARKER_TAIL_LINES = 6;
const MAX_DETAIL_CHARS = 300;
const MAX_VERIFY_OUTPUT_CHARS = 3000;

const ACTIVE_STATES = new Set(['launched', 'finishing']);
const STATES = new Set(['pending', 'launched', 'finishing', 'pushed', 'stalled', 'failed', 'closed', 'killed']);
// States a Retry may start from.
const RETRYABLE_STATES = new Set(['stalled', 'closed', 'killed']);

const isActive = (pkg) => ACTIVE_STATES.has(pkg.state);

/**
 * Finds this package's completion marker in a turn-end transcript fragment.
 * Only the LAST finished assistant message counts, and only a marker naming
 * this package's own id - a worker quoting its brief mid-turn must not finish
 * it, nor may one package's marker finish another.
 * @param {string} fragment raw JSONL appended since the last read
 * @param {string} pkgId
 * @returns {null | {kind:'done'} | {kind:'blocked', reason:string}}
 */
function markerFrom(fragment, pkgId) {
  const message = findTurnEndMessage(fragment);
  if (!message) return null;
  const lines = textBlocks(message)
    .split(/\r?\n/)
    .map((l) => l.replace(/[`*>]/g, '').trim())
    .filter(Boolean)
    .slice(-MARKER_TAIL_LINES)
    .reverse();
  for (const line of lines) {
    const m = /^LUNA_(DONE|BLOCKED)\s+([A-Za-z0-9.-]+)\s*(?::\s*(.*))?$/.exec(line);
    if (!m || m[2] !== pkgId) continue;
    if (m[1] === 'DONE') return { kind: 'done' };
    return { kind: 'blocked', reason: String(m[3] || '').slice(0, MAX_DETAIL_CHARS) };
  }
  return null;
}

/**
 * What a finished turn of a running worker leads to.
 * @param {{nudges:number}} pkg
 * @param {ReturnType<typeof markerFrom>} marker
 * @returns {{type:'finish'} | {type:'nudge'} | {type:'stall', reason:string, detail?:string}}
 */
function turnEndAction(pkg, marker) {
  if (marker && marker.kind === 'done') return { type: 'finish' };
  if (marker && marker.kind === 'blocked') return { type: 'stall', reason: 'blocked', detail: marker.reason };
  if ((pkg.nudges || 0) < MAX_NUDGES) return { type: 'nudge' };
  return { type: 'stall', reason: 'noMarker' };
}

/**
 * What a failed verify leads to: back to the worker, or stalled.
 * @param {{verifyRounds:number}} pkg
 * @returns {'retry'|'stall'}
 */
function verifyFailAction(pkg) {
  return (pkg.verifyRounds || 0) < MAX_VERIFY_ROUNDS ? 'retry' : 'stall';
}

function nudgeText(pkgId) {
  return `Continue until the task in your brief is fully done and verified, then commit and end your final message with the line LUNA_DONE ${pkgId} (or LUNA_BLOCKED ${pkgId}: <reason> if you cannot finish).`;
}

function verifyFailText(pkgId, verify, output) {
  const tail = String(output || '').slice(-MAX_VERIFY_OUTPUT_CHARS);
  return [
    `LunaCore ran \`${verify}\` in your worktree after your LUNA_DONE and it FAILED:`,
    '',
    '```',
    tail,
    '```',
    '',
    `Fix it, commit, and end with LUNA_DONE ${pkgId} again.`,
  ].join('\n');
}

const RESUME_TEXT = 'Continue the task you were working on - the usage limit has reset.';

/**
 * Pending packages that may start now: every dependency pushed, within the
 * free worker slots. Plan order is kept, so the planner's ordering decides.
 * @param {Array<{id:string, state:string, dependsOn:string[]}>} packages
 * @param {number} maxParallel
 */
function readyToLaunch(packages, maxParallel) {
  const free = maxParallel - packages.filter(isActive).length;
  if (free <= 0) return [];
  const pushed = new Set(packages.filter((p) => p.state === 'pushed').map((p) => p.id));
  return packages.filter((p) => p.state === 'pending' && p.dependsOn.every((d) => pushed.has(d))).slice(0, free);
}

/**
 * True once a started run has nothing left to do on its own: no worker
 * running and nothing launchable. Whatever is still pending then waits on a
 * dependency that did not get pushed.
 */
function isSettled(packages, maxParallel) {
  const started = packages.some((p) => p.state !== 'pending');
  return started && !packages.some(isActive) && readyToLaunch(packages, maxParallel).length === 0;
}

/** Counts per state, for the run summary and the end-of-run cue. */
function tally(packages) {
  const out = {};
  for (const p of packages) out[p.state] = (out[p.state] || 0) + 1;
  return out;
}

/**
 * Has this worker used up its working time? Pauses (usage limit) do not count.
 * @param {{startedAt:number|null, pausedMs:number}} pkg
 */
function timedOut(pkg, now, capMs = WORKER_CAP_MS) {
  if (!Number.isFinite(pkg.startedAt)) return false;
  return now - pkg.startedAt - (pkg.pausedMs || 0) > capMs;
}

// ---- second pass: escalation, schedule, overlap, stall learning -----------

// Stall reasons a stronger model can plausibly get past. Not needsApproval
// (a permission question), not restarted / noTab / push trouble (machinery).
const ESCALATE_REASONS = new Set(['noMarker', 'blocked', 'verifyFailed', 'timeout', 'noCommitsFailed']);
const ESCALATE_AFTER_STALLS = 2;

/**
 * Idea #6: a Sonnet worker that stalled twice on the same package is
 * restarted ONCE on Opus, in its own worktree, with the stall reason.
 * @param {{stalls?:number, escalated?:boolean, root:string|null, branch:string|null}} pkg
 * @param {string|null} model the model the package ran on
 * @param {string} reason this stall's reason
 */
function shouldEscalate(pkg, model, reason) {
  return (
    model === 'sonnet' &&
    !pkg.escalated &&
    (pkg.stalls || 0) >= ESCALATE_AFTER_STALLS &&
    ESCALATE_REASONS.has(reason) &&
    !!pkg.root &&
    !!pkg.branch
  );
}

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
// Start a little after the window resets, like the usage-limit resume.
const RESET_START_GRACE_MS = 2 * 60 * 1000;

/**
 * Idea #2: when a scheduled run starts.
 * @param {unknown} spec {kind:'time', at:'HH:MM'} | {kind:'reset'}
 * @param {number} nowMs
 * @param {number|null} resetAt epoch ms the current 5 h window resets, if known
 * @returns {{ok:true, at:number} | {ok:false, error:'badSchedule'|'noReset'}}
 */
function scheduleTime(spec, nowMs, resetAt) {
  const o = spec && typeof spec === 'object' ? spec : {};
  if (o.kind === 'reset') {
    if (!Number.isFinite(resetAt) || resetAt <= nowMs) return { ok: false, error: 'noReset' };
    return { ok: true, at: resetAt + RESET_START_GRACE_MS };
  }
  const m = o.kind === 'time' && typeof o.at === 'string' ? HHMM_RE.exec(o.at) : null;
  if (!m) return { ok: false, error: 'badSchedule' };
  const at = new Date(nowMs);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  // A time already past today means tomorrow.
  if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1);
  return { ok: true, at: at.getTime() };
}

const MAX_TOUCHED = 300;
const MAX_APPROVAL_LOG = 50;

/** A repo-relative path we are willing to keep: posix, no `..`, not absolute. */
function isRelPath(p) {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= 300 &&
    !p.startsWith('/') &&
    !/^[A-Za-z]:/.test(p) &&
    !p.split('/').includes('..')
  );
}

/**
 * Idea #7: files a worker changed, as paths relative to its worktree root
 * (so two worktrees of one repo compare). Files outside the root are dropped.
 * @param {string} root
 * @param {string[]} absFiles
 */
function relTouched(root, absFiles) {
  const out = [];
  for (const f of absFiles || []) {
    if (typeof f !== 'string') continue;
    const rel = path.relative(path.resolve(root), path.resolve(root, f)).split(path.sep).join('/');
    if (isRelPath(rel)) out.push(rel);
  }
  return out;
}

/** Union of two touched lists, capped; same array back when nothing is new. */
function mergeTouched(existing, add) {
  const have = new Set(existing || []);
  const fresh = (add || []).filter((f) => !have.has(f));
  if (!fresh.length) return existing || [];
  return [...(existing || []), ...fresh].slice(0, MAX_TOUCHED);
}

/**
 * Pairs of started packages that changed the same files. A dependent package
 * builds on its dependency's branch, so that pair is expected, not a clash.
 * @param {Array<{id:string, state:string, dependsOn:string[], touched?:string[]}>} packages
 * @returns {Array<{a:string, b:string, files:string[]}>}
 */
function liveOverlaps(packages) {
  const started = packages.filter((p) => p.state !== 'pending' && (p.touched || []).length);
  const out = [];
  for (let i = 0; i < started.length; i += 1) {
    for (let j = i + 1; j < started.length; j += 1) {
      const a = started[i];
      const b = started[j];
      if (a.dependsOn.includes(b.id) || b.dependsOn.includes(a.id)) continue;
      const bs = new Set(b.touched);
      const files = a.touched.filter((f) => bs.has(f));
      if (files.length) out.push({ a: a.id, b: b.id, files: files.slice(0, 20) });
    }
  }
  return out;
}

/**
 * The tool call a permission prompt is asking about: the last tool_use in the
 * transcript tail that has no tool_result yet.
 * @param {string} text JSONL tail
 * @returns {{name:string, input:object}|null}
 */
function lastOpenToolUse(text) {
  const open = new Map();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || (!line.includes('"tool_use"') && !line.includes('"tool_result"'))) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj && obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
        open.delete(part.id); // re-inserted last: Map order = recency
        open.set(part.id, { name: part.name, input: part.input && typeof part.input === 'object' ? part.input : {} });
      } else if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        open.delete(part.tool_use_id);
      }
    }
  }
  const all = [...open.values()];
  return all.length ? all[all.length - 1] : null;
}

// An allow rule as LunaCore passes it to a worker's --allowedTools, inside
// single quotes: no quote, `$`, backtick or shell operator can be in it.
const ALLOW_RULE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}(\([A-Za-z0-9 _.:*/@=-]{1,100}\))?$/;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Commands whose first word alone says too little ("npm" = anything).
const RUNNERS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'uv', 'uvx', 'git', 'cargo', 'go', 'dotnet', 'pip']);
// Never suggested: a prefix rule on any of these allows ANY command
// (shells, interpreters), reaches the network, or destroys data. The
// transcript the suggestion comes from is worker-written, so it could be
// steered toward exactly these.
const DENY_COMMANDS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'env', 'xargs', 'eval', 'exec', 'source',
  'node', 'deno', 'bun', 'python', 'python3', 'py', 'perl', 'ruby', 'php', 'lua',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp',
  'rm', 'rmdir', 'del', 'rd', 'dd', 'mkfs', 'format', 'shred', 'chmod', 'chown', 'sudo', 'su', 'runas',
  'kill', 'pkill', 'taskkill', 'shutdown', 'reboot', 'reg', 'schtasks', 'crontab',
]);
// Runner sub-commands that publish, rewrite history or run arbitrary packages.
const DENY_SUBCOMMANDS = new Set([
  'push', 'reset', 'clean', 'checkout', 'rebase', 'restore', 'switch', 'branch', 'remote', 'config',
  'filter-branch', 'update-ref', 'worktree', 'gc', 'prune', 'publish', 'exec', 'x', 'dlx', 'run-script',
  'login', 'logout', 'token', 'unpublish', 'owner', 'uninstall',
]);
// Non-shell tools a suggestion may name: read, search and in-place edits.
const SUGGESTABLE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CMD_WORD_RE = /^[A-Za-z0-9_.@/-]+$/;
const MAX_EXAMPLE_CHARS = 160;

/** A command line as shown next to a suggestion: one line, no control chars, capped. */
function cleanExample(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const line = v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_EXAMPLE_CHARS);
  return line || null;
}

/**
 * Idea #5: the allow rule that would have let a stalled tool call through,
 * e.g. Bash `npx tsc --noEmit` -> `Bash(npx tsc:*)`. Null when unsure.
 * @param {{name:string, input:object}|null} toolUse
 * @returns {string|null}
 */
function allowRuleFor(toolUse) {
  if (!toolUse || typeof toolUse.name !== 'string') return null;
  const { name, input } = toolUse;
  if (SHELL_TOOLS.has(name)) {
    const cmd = typeof input.command === 'string' ? input.command.split('\n')[0].trim() : '';
    const words = cmd.split(/\s+/).filter(Boolean);
    if (!words.length || !CMD_WORD_RE.test(words[0])) return null;
    const first = words[0].toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
    if (DENY_COMMANDS.has(first)) return null;
    const second = words[1] && !words[1].startsWith('-') && CMD_WORD_RE.test(words[1]) ? words[1] : null;
    if (RUNNERS.has(first)) {
      // A bare runner rule would allow every sub-command.
      if (!second || DENY_SUBCOMMANDS.has(second.toLowerCase())) return null;
    }
    const prefix = RUNNERS.has(first) ? `${words[0]} ${second}` : words[0];
    const rule = `${name}(${prefix}:*)`;
    return ALLOW_RULE_RE.test(rule) ? rule : null;
  }
  return SUGGESTABLE_TOOLS.has(name) ? name : null;
}

/** The command a stalled tool call ran, for the board (null for non-shell tools). */
function exampleFor(toolUse) {
  if (!toolUse || !SHELL_TOOLS.has(toolUse.name)) return null;
  return cleanExample(typeof toolUse.input.command === 'string' ? toolUse.input.command.split('\n')[0] : '');
}

const isAllowRule = (v) => typeof v === 'string' && ALLOW_RULE_RE.test(v);

/**
 * Approval stalls grouped by rule, most workers first.
 * @param {Array<{pkgId:string, rule:string|null}>} log
 * @returns {Array<{rule:string, count:number, ids:string[]}>}
 */
function allowSuggestions(log) {
  const byRule = new Map();
  for (const e of log || []) {
    if (!e || !isAllowRule(e.rule)) continue;
    const entry = byRule.get(e.rule) || { ids: new Set(), example: null };
    entry.ids.add(e.pkgId);
    entry.example = entry.example || cleanExample(e.example);
    byRule.set(e.rule, entry);
  }
  return [...byRule.entries()]
    .map(([rule, { ids, example }]) => ({ rule, count: ids.size, ids: [...ids], example }))
    .sort((x, y) => y.count - x.count);
}

// ---- persistence shape ----------------------------------------------------

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const strOrNull = (v, max = 4000) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 200) : []);

// Restored values that later reach git argv, a shell cwd or a new tab must
// have exactly the shape LunaCore itself creates - the file is on disk and
// anything local can edit it. A value that does not fit is dropped (Retry
// then relaunches the package in a FRESH worktree instead of trusting it).
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
// BRANCH_PREFIX is 'luna/' (worktrees.js); a regex-safe prefix check plus
// the slug alphabet, so no value can start with '-' or contain '..'.
const isBranch = (v) =>
  typeof v === 'string' && v.startsWith(BRANCH_PREFIX) && SLUG_RE.test(v.slice(BRANCH_PREFIX.length));

/** root = <parent>/.luna-worktrees/<repo>/<slug> (worktrees.worktreePathFor). */
function isWorktreeRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return false;
  const abs = path.resolve(root);
  return SLUG_RE.test(path.basename(abs)) && path.basename(path.dirname(path.dirname(abs))) === WORKTREE_DIR;
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Location fields of a restored package, or all null when any is off-shape. */
function storedLocation(raw) {
  const none = { root: null, cwd: null, branch: null, baseSha: null };
  if (!isWorktreeRoot(raw.root) || !isBranch(raw.branch)) return none;
  const cwd = typeof raw.cwd === 'string' && isInside(raw.cwd, raw.root) ? path.resolve(raw.cwd) : path.resolve(raw.root);
  const baseSha = typeof raw.baseSha === 'string' && SHA_RE.test(raw.baseSha) ? raw.baseSha : null;
  return { root: path.resolve(raw.root), cwd, branch: raw.branch, baseSha };
}

function normalizePackage(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !SLUG_RE.test(raw.id)) return null;
  return {
    id: raw.id,
    title: str(raw.title, 200),
    prompt: str(raw.prompt, 20000),
    files: strList(raw.files),
    dependsOn: strList(raw.dependsOn),
    // One line only: it runs through a shell (orchestraFinish.runVerify).
    verify: /[\r\n]/.test(str(raw.verify, 500)) ? '' : str(raw.verify, 500),
    model: strOrNull(raw.model, 32),
    todoAts: Array.isArray(raw.todoAts) ? raw.todoAts.filter(Number.isFinite) : [],
    state: STATES.has(raw.state) ? raw.state : 'pending',
    sessionId: strOrNull(raw.sessionId, 64),
    ...storedLocation(raw),
    // Never restored: recomputed from the brief folder + worktree name.
    briefPath: null,
    headSha: typeof raw.headSha === 'string' && SHA_RE.test(raw.headSha) ? raw.headSha : null,
    error: strOrNull(raw.error, 64),
    detail: strOrNull(raw.detail, MAX_DETAIL_CHARS),
    nudges: num(raw.nudges),
    verifyRounds: num(raw.verifyRounds),
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
    pausedMs: num(raw.pausedMs),
    stalls: num(raw.stalls),
    escalated: raw.escalated === true,
    modelOverride: raw.modelOverride === 'opus' ? 'opus' : null,
    touched: strList(raw.touched).filter(isRelPath).slice(0, MAX_TOUCHED),
    prUrl: typeof raw.prUrl === 'string' && PR_URL_RE.test(raw.prUrl) ? raw.prUrl : null,
    merged: raw.merged === true,
    cleaned: raw.cleaned === true,
  };
}

const PR_URL_RE = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d{1,9}$/;
// A branch name as `git rev-parse --abbrev-ref HEAD` prints it; never an
// option, never `..`.
const BASE_BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const isBaseBranch = (v) => typeof v === 'string' && BASE_BRANCH_RE.test(v) && !v.includes('..') && !v.endsWith('.lock');
const INTEGRATION_MODES = ['pr', 'merge', 'branches'];
const INTEGRATION_STATES = new Set(['idle', 'running', 'done', 'failed']);

function normalizeIntegration(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    // A run interrupted mid-integration comes back idle; it reruns safely
    // (every package records what was already done for it).
    state: INTEGRATION_STATES.has(o.state) && o.state !== 'running' ? o.state : 'idle',
    error: strOrNull(o.error, 64),
    detail: strOrNull(o.detail, MAX_DETAIL_CHARS),
    at: Number.isFinite(o.at) ? o.at : null,
  };
}

/**
 * Validates a plan read back from orchestra.local.json. A broken file yields
 * null (no run on the board), never a crash - the config-loader contract.
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeStoredPlan(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.repoPath !== 'string') return null;
  if (!path.isAbsolute(raw.repoPath)) return null;
  const packages = (Array.isArray(raw.packages) ? raw.packages : []).map(normalizePackage).filter(Boolean);
  if (!packages.length) return null;
  const todoText = Array.isArray(raw.todoText)
    ? raw.todoText.filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && typeof e[1] === 'string')
    : [];
  return {
    id: raw.id.slice(0, 64),
    projectId: strOrNull(raw.projectId, 200),
    repoPath: raw.repoPath,
    profileId: str(raw.profileId, 200),
    notes: str(raw.notes, 4000),
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    errors: Array.isArray(raw.errors) ? raw.errors : [],
    estimate:
      raw.estimate && typeof raw.estimate === 'object' ? raw.estimate : { wallMinutes: 0, workMinutes: 0, workers: 0 },
    costUsd: Number.isFinite(raw.costUsd) ? raw.costUsd : null,
    dirty: Number.isFinite(raw.dirty) ? raw.dirty : null,
    workerModel: strOrNull(raw.workerModel, 32),
    permissionMode: strOrNull(raw.permissionMode, 32),
    allowedTools: strList(raw.allowedTools).filter(isAllowRule).slice(0, 50),
    integrationMode: INTEGRATION_MODES.includes(raw.integrationMode) ? raw.integrationMode : null,
    baseBranch: isBaseBranch(raw.baseBranch) ? raw.baseBranch : null,
    scheduledAt: Number.isFinite(raw.scheduledAt) ? raw.scheduledAt : null,
    approvalLog: (Array.isArray(raw.approvalLog) ? raw.approvalLog : [])
      .filter((e) => e && typeof e.pkgId === 'string' && SLUG_RE.test(e.pkgId))
      .map((e) => ({ pkgId: e.pkgId, rule: isAllowRule(e.rule) ? e.rule : null, example: cleanExample(e.example) }))
      .slice(-MAX_APPROVAL_LOG),
    integration: normalizeIntegration(raw.integration),
    todoText: new Map(todoText),
    packages,
  };
}

/** The plan as JSON-safe data (todoText is a Map in memory). */
function serializePlan(plan) {
  return { ...plan, todoText: [...plan.todoText.entries()] };
}

/**
 * After a LunaCore restart no worker tab exists any more: whatever was running
 * becomes stalled, worktree and branch kept so Retry can pick it up.
 */
function restoreAfterRestart(plan) {
  return {
    ...plan,
    packages: plan.packages.map((p) =>
      isActive(p) ? { ...p, state: 'stalled', error: 'restarted', sessionId: null } : { ...p, sessionId: null },
    ),
  };
}

module.exports = {
  ESCALATE_REASONS,
  INTEGRATION_MODES,
  MAX_APPROVAL_LOG,
  shouldEscalate,
  scheduleTime,
  relTouched,
  mergeTouched,
  liveOverlaps,
  lastOpenToolUse,
  allowRuleFor,
  exampleFor,
  cleanExample,
  isAllowRule,
  PR_URL_RE,
  isBaseBranch,
  allowSuggestions,
  isWorktreeRoot,
  isBranch,
  MAX_NUDGES,
  MAX_VERIFY_ROUNDS,
  WORKER_CAP_MS,
  RETRYABLE_STATES,
  RESUME_TEXT,
  isActive,
  markerFrom,
  turnEndAction,
  verifyFailAction,
  nudgeText,
  verifyFailText,
  readyToLaunch,
  isSettled,
  tally,
  timedOut,
  normalizeStoredPlan,
  serializePlan,
  restoreAfterRestart,
};
