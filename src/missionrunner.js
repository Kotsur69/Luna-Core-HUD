// ============================================================================
// LunaCore - Mission Control job runner (headless, tool-gated `claude -p`)
// ----------------------------------------------------------------------------
// Mission Control's mail and calendar jobs talk to Gmail / Google Calendar
// through the claude.ai connectors the user's `claude` login already carries
// (verified live 2026-10-08: a headless `claude -p --model haiku` lists the
// mcp__claude_ai_Gmail__* and mcp__claude_ai_Google_Calendar__* tools). So
// there is no Google OAuth client in this app at all - same "reuse the CLI,
// no new API key" idea as src/ask.js.
//
// THE SECURITY BOUNDARY IS THE ARGV, NOT THE PROMPT
// --------------------------------------------------
// A prompt that says "never send mail" is a request; the CLI flags are a
// guarantee. Every job is launched with:
//   --tools ""                  no built-in tools (no Bash, no file writes)
//   --permission-mode dontAsk   anything not pre-approved is denied, never asked
//   --allowedTools <exact list> the one or two connector tools the job needs
//   --disallowedTools <rest>    every OTHER Gmail/Calendar tool, by name
//   --setting-sources ""        no user/project settings: no allow rules, no
//                               hooks, no local MCP servers (supabase, ...)
// Verified live 2026-10-08: with --setting-sources "" only the claude.ai
// connectors load, so under dontAsk nothing outside --allowedTools is
// callable. The deny list is defence in depth on top of that: a disallowed
// tool is removed from the session entirely ("No such tool available").
//
// `lean` jobs (pure text parsing, no connector needed) additionally pass
// --strict-mcp-config, which drops the claude.ai connectors too: much
// cheaper, but only a job with no tools may use it.
//
// ANTIGRAVITY (`agy`, model AGY_MODEL)
// ------------------------------------
// A lean job without tools (calendar parse, News summary, a trending README,
// the weekly review) may run on the Antigravity CLI instead: one `agy --print`
// in the OS temp dir, prompt on stdin, in the agy profile's env (agyEnv - never
// the Claude env). Every other job is refused with 'agy-needs-claude': agy has
// no claude.ai Gmail / Calendar connectors and no tool allow-list, so the
// argv boundary above cannot be built for it. Known difference on agy: "no
// tools" is not enforced by flags - agy runs without `--mode accept-edits`
// (an edit needs an approval nobody gives) but keeps its own read tools and
// the MCP servers in ~/.gemini/config/mcp_config.json. The answer is parsed
// and validated by the caller exactly like a Claude answer.
//
// Same "always resolves, never rejects" shape as runAsk(): every failure is a
// typed { ok:false, reason }.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const { AGY_MODEL } = require('./claudeModels');
const { isAgyModel } = require('./workerModels');

/** Every Gmail connector tool, so a job can deny all but the ones it uses. */
const GMAIL_TOOLS = [
  'apply_sensitive_message_label', 'apply_sensitive_thread_label', 'create_draft', 'create_label',
  'delete_draft', 'delete_label', 'forward', 'get_draft', 'get_message', 'get_thread', 'label_message',
  'label_thread', 'list_drafts', 'list_labels', 'mark_message_spam', 'mark_thread_spam', 'reply',
  'search_threads', 'send_message', 'trash_message', 'trash_thread', 'unlabel_message',
  'unlabel_thread', 'unmark_message_spam', 'unmark_thread_spam', 'untrash_message', 'untrash_thread',
  'update_draft', 'update_label', 'update_message_labels',
].map((name) => `mcp__claude_ai_Gmail__${name}`);

/** Every Google Calendar connector tool. */
const CALENDAR_TOOLS = [
  'create_event', 'delete_event', 'get_event', 'list_calendars', 'list_events',
  'respond_to_event', 'search_events', 'suggest_time', 'update_event',
].map((name) => `mcp__claude_ai_Google_Calendar__${name}`);

const ALL_CONNECTOR_TOOLS = [...GMAIL_TOOLS, ...CALENDAR_TOOLS];

/**
 * The Claude models a Mission Control job can run on. Alone they are the
 * choice for a job that always needs the claude.ai connectors (the brief).
 */
const MISSION_MODELS = ['haiku', 'sonnet', 'opus'];
/**
 * Every model a picker may offer when the jobs behind it can be lean
 * (Settings -> missionModel, the weekly review): the Claude models plus agy.
 * runJob runs only a lean, tool-less job on agy and refuses any other.
 */
const JOB_MODELS = Object.freeze([...MISSION_MODELS, AGY_MODEL]);
const DEFAULT_MISSION_MODEL = 'haiku';

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Appended to every agy job's prompt. A request, not a boundary (agy has no
 * flag that removes its tools), but the jobs' data blocks are untrusted text.
 */
const AGY_NO_TOOLS = 'Use no tools: do not read or write files, run commands or call any MCP server. Answer only from the text above.';

/**
 * execAgy's failure -> the job's reason (the renderer maps reasons to text).
 * Every one names agy, so a report that failed there says which provider did.
 */
const AGY_REASONS = Object.freeze({
  noAgyProfile: 'no-agy-profile',
  badAgyModel: 'agy-bad-model',
  noAgy: 'no-agy',
  timeout: 'agy-timeout',
  limit: 'agy-limit',
  failed: 'agy-failed',
});

/**
 * The built-in tools of a `readOnly` job (the memory check, src/memorycheck.js):
 * they read files and search them, nothing else. No Bash, no edits, no web.
 * Verified live 2026-11-15 under --permission-mode dontAsk: a Read inside the
 * job's cwd works; a Read outside it, a Read through a junction inside cwd
 * pointing outside, and a Grep or Glob given a path outside cwd are all
 * denied (permission_denials); Bash and Write do not exist in the session.
 */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
/** Tool rounds a readOnly job may take before the CLI stops it: a bound on cost. */
const READ_ONLY_MAX_TURNS = 40;

/**
 * Pure argv builder. Never a shell string. Unknown tool names in `allowed`
 * are dropped (only real connector tools can ever be allowed), and every
 * connector tool NOT allowed lands in --disallowedTools.
 * `readOnly` (only together with `lean`) gives the job READ_ONLY_TOOLS and
 * nothing else; without lean it is ignored (no tools).
 * @param {{prompt:string, model?:string, allowed?:string[], lean?:boolean, readOnly?:boolean}} job
 * @returns {string[]}
 */
function buildJobArgs({ prompt, model, allowed = [], lean = false, readOnly = false }) {
  const safeModel = MISSION_MODELS.includes(model) ? model : DEFAULT_MISSION_MODEL;
  const allowedSet = new Set(allowed.filter((tool) => ALL_CONNECTOR_TOOLS.includes(tool)));
  const tools = lean && readOnly ? READ_ONLY_TOOLS.join(',') : '';
  const args = ['-p', prompt, '--model', safeModel, '--output-format', 'json', '--tools', tools];
  args.push('--permission-mode', 'dontAsk', '--setting-sources', '');
  if (lean && readOnly) args.push('--max-turns', String(READ_ONLY_MAX_TURNS));
  if (lean) {
    // No connector may be allowed on a lean job - it would not exist anyway.
    args.push('--strict-mcp-config');
    return args;
  }
  if (allowedSet.size > 0) args.push('--allowedTools', [...allowedSet].join(','));
  args.push('--disallowedTools', ALL_CONNECTOR_TOOLS.filter((tool) => !allowedSet.has(tool)).join(','));
  return args;
}

/**
 * Pulls the model's JSON answer out of `claude --output-format json`'s
 * envelope. The model is asked for bare JSON but sometimes wraps it in a code
 * fence or a sentence, so the inner text falls back to its outermost {...}.
 * @param {string} stdout
 * @returns {{answer:object|null, isError:boolean, costUsd:number|null}}
 */
function unwrapJobOutput(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    return { answer: null, isError: true, costUsd: null };
  }
  const costUsd = typeof outer.total_cost_usd === 'number' ? outer.total_cost_usd : null;
  const isError = outer.is_error === true;
  const text = typeof outer.result === 'string' ? outer.result : '';
  return { answer: parseLooseJson(text), isError, costUsd };
}

/** Parses `text` as a JSON object, tolerating a fence or prose around it. */
function parseLooseJson(text) {
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? tryParse(text.slice(start, end + 1)) : null;
}

/** The text of execAgy's result envelope, or '' when it is unreadable. */
function agyResultText(stdout) {
  try {
    const outer = JSON.parse(stdout);
    return outer && typeof outer.result === 'string' ? outer.result : '';
  } catch {
    return '';
  }
}

/**
 * One job on the Antigravity CLI: `agy --print` in the OS temp dir, prompt on
 * stdin, in the agy profile's env, through execAgy (src/agyexec.js). Only a
 * lean job without tools can run there - agy has no claude.ai connectors, no
 * tool allow-list and no --strict-mcp-config - so any other job is refused,
 * never run on claude instead. `model` is 'agy' (agy's default model) or
 * 'agy:<id>': execAgy passes the id as agy's `--model` once the live `agy
 * models` list holds it, and refuses it otherwise ('agy-bad-model'). agy
 * reports no cost.
 * @param {{prompt:string, model:string, allowed?:string[], lean?:boolean, readOnly?:boolean, agyEnv?:object|null,
 *          timeoutMs:number, exec:Function, agyModels?:object}} job
 * @returns {Promise<{ok:true, answer:object, costUsd:null}|{ok:false, reason:string, costUsd?:null}>}
 */
async function runAgyJob({ prompt, model, allowed, lean, readOnly, agyEnv, timeoutMs, exec, agyModels }) {
  // A job that names connector tools needs them, even when it also says lean.
  const wantsTools = Array.isArray(allowed) && allowed.length > 0;
  if (lean !== true || readOnly || wantsTools) return { ok: false, reason: 'agy-needs-claude' };
  if (!agyEnv || typeof agyEnv !== 'object' || Array.isArray(agyEnv)) return { ok: false, reason: 'no-agy-profile' };
  // Required lazily: agyexec pulls in the agy model cache, which main sets up.
  const { execAgy } = require('./agyexec');
  const text = `${String(prompt || '')}\n\n${AGY_NO_TOOLS}`;
  const res = await execAgy({
    args: ['-p', '--model', model],
    prompt: text,
    cwd: os.tmpdir(),
    env: agyEnv,
    timeoutMs,
    execImpl: exec,
    ...(agyModels ? { agyModels } : {}),
  });
  if (res.error) {
    console.error('[mission] agy job failed:', res.error, res.detail || '');
    return { ok: false, reason: AGY_REASONS[res.error] || 'agy-failed', costUsd: null };
  }
  const answer = parseLooseJson(agyResultText(res.stdout));
  return answer ? { ok: true, answer, costUsd: null } : { ok: false, reason: 'bad-json', costUsd: null };
}

/**
 * Runs one job. Resolves { ok:true, answer, costUsd } or
 * { ok:false, reason:'no-claude'|'timeout'|'generic'|'bad-json'|'cli-error' }.
 * cwd is the OS temp dir so no project CLAUDE.md is pulled into the context,
 * except for a `readOnly` lean job: it runs in `cwd` (an absolute folder, the
 * project it reads), which is also the only folder its Read tool may open.
 * model 'agy' (AGY_MODEL) or 'agy:<id>' runs the job on agy in `agyEnv` (the
 * agy profile's env; `env` is never used for agy) - see runAgyJob; its extra
 * reasons are 'agy-needs-claude' (not a lean, tool-less job), 'no-agy-profile',
 * 'agy-bad-model', 'no-agy', 'agy-timeout', 'agy-limit' and 'agy-failed'.
 * @param {{prompt:string, model?:string, allowed?:string[], lean?:boolean, readOnly?:boolean, cwd?:string,
 *          env:Record<string,string>, agyEnv?:Record<string,string>|null, timeoutMs?:number, exec?:Function}} job
 */
function runJob({ prompt, model, allowed, lean, readOnly = false, cwd = null, env, agyEnv = null, timeoutMs = DEFAULT_TIMEOUT_MS, exec = execFile, stdin = false, agyModels = null }) {
  if (isAgyModel(model)) return runAgyJob({ prompt, model, allowed, lean, readOnly, agyEnv, timeoutMs, exec, agyModels });
  return new Promise((resolve) => {
    // A read-only job without a real project folder would read the temp dir: refused instead.
    if (readOnly && !(lean && typeof cwd === 'string' && path.isAbsolute(cwd))) return resolve({ ok: false, reason: 'bad-cwd' });
    const args = buildJobArgs({ prompt, model, allowed, lean, readOnly });
    // `stdin`: the prompt is piped in instead of passed as an argument. A long
    // prompt does not fit a Windows command line (32,767 characters); `-p`
    // with no prompt reads it from standard input.
    if (stdin) args.splice(1, 1);
    const child = exec(
      'claude',
      args,
      { env, cwd: readOnly ? cwd : os.tmpdir(), timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          if (error.code === 'ENOENT') return resolve({ ok: false, reason: 'no-claude' });
          // Same timeout detection as runAsk() - see the note there on Windows.
          if (error.killed && (error.signal === 'SIGTERM' || !error.signal)) {
            return resolve({ ok: false, reason: 'timeout' });
          }
          if (!stdout) return resolve({ ok: false, reason: 'generic' });
        }
        const { answer, isError, costUsd } = unwrapJobOutput(stdout || '');
        if (isError) return resolve({ ok: false, reason: 'cli-error', costUsd });
        if (!answer) return resolve({ ok: false, reason: 'bad-json', costUsd });
        return resolve({ ok: true, answer, costUsd });
      }
    );
    if (stdin && child && child.stdin) {
      // A CLI that exits early closes the pipe: the exec callback reports that failure.
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    }
  });
}

/** Trims a value to a plain string capped at maxLen; anything else -> ''. */
function clampString(value, maxLen) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

module.exports = {
  GMAIL_TOOLS,
  CALENDAR_TOOLS,
  MISSION_MODELS,
  JOB_MODELS,
  DEFAULT_MISSION_MODEL,
  READ_ONLY_TOOLS,
  READ_ONLY_MAX_TURNS,
  buildJobArgs,
  unwrapJobOutput,
  parseLooseJson,
  runJob,
  clampString,
};
