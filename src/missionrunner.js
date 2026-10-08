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
// Same "always resolves, never rejects" shape as runAsk(): every failure is a
// typed { ok:false, reason }.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const os = require('os');

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

/** Models the user can pick for Mission Control jobs (Settings -> missionModel). */
const MISSION_MODELS = ['haiku', 'sonnet', 'opus'];
const DEFAULT_MISSION_MODEL = 'haiku';

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Pure argv builder. Never a shell string. Unknown tool names in `allowed`
 * are dropped (only real connector tools can ever be allowed), and every
 * connector tool NOT allowed lands in --disallowedTools.
 * @param {{prompt:string, model?:string, allowed?:string[], lean?:boolean}} job
 * @returns {string[]}
 */
function buildJobArgs({ prompt, model, allowed = [], lean = false }) {
  const safeModel = MISSION_MODELS.includes(model) ? model : DEFAULT_MISSION_MODEL;
  const allowedSet = new Set(allowed.filter((tool) => ALL_CONNECTOR_TOOLS.includes(tool)));
  const args = ['-p', prompt, '--model', safeModel, '--output-format', 'json', '--tools', ''];
  args.push('--permission-mode', 'dontAsk', '--setting-sources', '');
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

/**
 * Runs one job. Resolves { ok:true, answer, costUsd } or
 * { ok:false, reason:'no-claude'|'timeout'|'generic'|'bad-json'|'cli-error' }.
 * cwd is the OS temp dir so no project CLAUDE.md is pulled into the context.
 * @param {{prompt:string, model?:string, allowed?:string[], lean?:boolean,
 *          env:Record<string,string>, timeoutMs?:number, exec?:Function}} job
 */
function runJob({ prompt, model, allowed, lean, env, timeoutMs = DEFAULT_TIMEOUT_MS, exec = execFile }) {
  return new Promise((resolve) => {
    exec(
      'claude',
      buildJobArgs({ prompt, model, allowed, lean }),
      { env, cwd: os.tmpdir(), timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
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
  DEFAULT_MISSION_MODEL,
  buildJobArgs,
  unwrapJobOutput,
  parseLooseJson,
  runJob,
  clampString,
};
