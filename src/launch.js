// ============================================================================
// LunaCore - building the session start command
// ----------------------------------------------------------------------------
// Pure string logic, deliberately kept out of main.js so it can be tested
// without booting Electron.
//
// This decides whether a session can be PINNED. Transcripts are named after the
// session id, so when we pass `--session-id <uuid>` ourselves we know the exact
// file a tab writes to. Without it the watcher has to infer ownership from file
// timestamps - and two sessions started seconds apart in one folder race, which
// is what made an Opus tab show a Sonnet tab's numbers.
//
// If this function wrongly refuses, nothing crashes: the app just silently falls
// back to the old guessing. That is precisely why it is unit-tested.
// ============================================================================

'use strict';

const path = require('path');

// Flags meaning "the session id is already decided" - the CLI resumes an
// existing conversation, or the profile stated an id itself. Adding a second
// --session-id would either conflict or quietly override the user's intent.
const SESSION_ID_DECIDED =
  /(^|\s)(-c|--continue|-r|--resume|--from-pr|--fork-session|--session-id)(\s|$)/;

/**
 * Appends `--session-id <uuid>` to a start command when it is safe to do so.
 *
 * Conservative by design: anything that is not a plain `claude` launch is left
 * alone and keeps the heuristic fallback.
 * @param {string} command full start command, e.g. "claude --model opus"
 * @param {string} uuid session id to pin
 * @returns {string|null} modified command, or null when it must not be pinned
 */
function withSessionId(command, uuid) {
  const cmd = String(command || '').trim();
  if (!cmd || !uuid) return null; // bare shell - the user launches what they like

  const first = cmd.split(/\s+/)[0].replace(/^["']|["']$/g, '');
  const bin = path
    .basename(first)
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  if (bin !== 'claude') return null; // some other program - not ours to label
  if (SESSION_ID_DECIDED.test(cmd)) return null;

  return `${cmd} --session-id ${uuid}`;
}

/**
 * Appends `--mcp-config '<path>'` (the tab's task-intake server, src/intake.js)
 * to a plain `claude` start command. Left alone: non-claude commands, and a
 * command already running under --strict-mcp-config (a lean local-model tab
 * asked for NO extra MCP servers - honour that). The path is single-quoted for
 * the shell it is typed into, so one containing a quote is refused.
 * @param {string} command
 * @param {string|null} configPath
 * @returns {string} the command, with or without the flag
 */
function withIntakeMcp(command, configPath) {
  const cmd = String(command || '').trim();
  if (!cmd || typeof configPath !== 'string' || !configPath || configPath.includes("'")) return cmd;
  const first = cmd.split(/\s+/)[0].replace(/^["']|["']$/g, '');
  const bin = path.basename(first).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  if (bin !== 'claude' || /(^|\s)--strict-mcp-config(\s|$)/.test(cmd)) return cmd;
  return `${cmd} --mcp-config '${configPath}'`;
}

/** True when a start command launches the `claude` CLI itself. */
function isClaudeCommand(command) {
  const first = String(command || '').trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
  return path.basename(first).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() === 'claude';
}

/**
 * Hands a God Mode worker tab its task (ORCHESTRATOR_PLAN.md slice 3): the
 * brief sits in a file, `--add-dir` lets the tab read it without a
 * permission prompt, and the first message - a positional argument - tells
 * Claude to read it. A positional prompt is delivered by the CLI itself, so
 * nothing is typed into a shell that might not have started Claude yet.
 *
 * The prompt goes right after the binary, before any profile flag, so a
 * variadic option (`--add-dir <dirs...>`, `--allowedTools <tools...>`) can
 * never swallow it. Single quotes suit both shells LunaCore types into
 * (PowerShell, POSIX sh); a path containing one is refused instead of escaped.
 *
 * `permissionMode` (slice 4, Settings -> God Mode workers) is appended unless
 * the profile already decides it - same rule as `--model`.
 * @param {string} command
 * @param {{briefPath:string, model?:string|null, permissionMode?:string|null}} task
 * @returns {string|null} the command, or null when it cannot carry the task
 */
function withTaskBrief(command, task) {
  const cmd = String(command || '').trim();
  const briefPath = task && typeof task.briefPath === 'string' ? task.briefPath : '';
  // U+2018-U+201B: PowerShell treats the typographic quotes as ' too.
  if (!isClaudeCommand(cmd) || !briefPath || /['`\r\n‘-‛]/.test(briefPath)) return null;
  const [bin, ...rest] = cmd.split(/\s+/);
  // Backticks around the path: unquoted, the model cut a path at its first
  // space and asked for the wrong file (verified live).
  const message = `Your task brief is in the file \`${briefPath}\` - read it first, then carry it out.`;
  const parts = [bin, `'${message}'`, ...rest, '--add-dir', `'${path.dirname(briefPath)}'`];
  if (task.model && /^[a-z0-9.-]+$/i.test(task.model) && !/(^|\s)--model(\s|=|$)/.test(cmd)) {
    parts.push('--model', task.model);
  }
  if (WORKER_PERMISSION_MODES.includes(task.permissionMode) && !PERMISSION_DECIDED.test(cmd)) {
    parts.push('--permission-mode', task.permissionMode);
  }
  // Allow rules learned from stalled prompts (God Mode idea #5). Single
  // quotes are literal in PowerShell and POSIX shells alike; the shape check
  // keeps a quote, `$` or backtick out of them.
  const rules = Array.isArray(task.allowedTools) ? task.allowedTools.filter((r) => ALLOW_RULE_RE.test(r)) : [];
  if (rules.length && !/(^|\s)--allowed-?tools(\s|=|$)/i.test(cmd)) {
    parts.push('--allowedTools', ...rules.map((r) => `'${r}'`));
  }
  return parts.join(' ');
}

// Permission modes a God Mode worker may be started in. 'default' adds no
// flag on purpose: it is what the CLI does anyway.
const WORKER_PERMISSION_MODES = ['acceptEdits', 'bypassPermissions'];
const PERMISSION_DECIDED = /(^|\s)(--permission-mode|--dangerously-skip-permissions)(\s|=|$)/;
// Same shape as orchestraSupervisor's ALLOW_RULE_RE.
const ALLOW_RULE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}(\([A-Za-z0-9 _.:*/@=-]{1,100}\))?$/;

// Extensions Windows will actually execute for a bare name. The empty string is
// last on purpose: `claude` with no extension is the POSIX case and also catches
// an extensionless shim, but on Windows the .cmd/.exe forms are what npm and the
// native installer really drop, so they should win.
const WIN_EXTS = ['.exe', '.cmd', '.bat', '.ps1', ''];

/**
 * Looks up an executable on a PATH string. Pure: the filesystem arrives as an
 * `exists` callback, so this is unit-testable without touching a real disk.
 *
 * D3 uses it to answer one question honestly - is Claude Code installed at all?
 * Without it a newcomer gets a shell printing `command not found` and no idea
 * what to install. Note this runs on the env AFTER withClaudeOnPath() has had
 * its say, so a native install in ~/.local/bin counts as found.
 *
 * @param {string} name bare command name, e.g. "claude"
 * @param {string} pathEnv the PATH value to search
 * @param {boolean} isWindows
 * @param {(p: string) => boolean} exists
 * @returns {string|null} full path to the executable, or null when absent
 */
function findExecutable(name, pathEnv, isWindows, exists) {
  if (!name) return null;
  const sep = isWindows ? ';' : ':';
  const exts = isWindows ? WIN_EXTS : [''];
  // Join with the TARGET platform's rules, not the host's. path.join alone would
  // hand back backslashes while isWindows said false, so the flag and the
  // separator could disagree - harmless while we only ship Windows, and a
  // silent wrong answer the moment anyone runs this anywhere else.
  const join = isWindows ? path.win32.join : path.posix.join;
  for (const raw of String(pathEnv || '').split(sep)) {
    const dir = raw.trim().replace(/^["']|["']$/g, '');
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      try {
        if (exists(full)) return full;
      } catch {
        // An unreadable or malformed PATH entry must not abort the search -
        // one bad directory should never make a present binary look absent.
      }
    }
  }
  return null;
}

module.exports = {
  withSessionId,
  withIntakeMcp,
  withTaskBrief,
  WORKER_PERMISSION_MODES,
  isClaudeCommand,
  SESSION_ID_DECIDED,
  findExecutable,
  WIN_EXTS,
};
