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

module.exports = { withSessionId, SESSION_ID_DECIDED, findExecutable, WIN_EXTS };
