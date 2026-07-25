// ============================================================================
// LunaCore - budowanie komendy startowej sesji
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

module.exports = { withSessionId, SESSION_ID_DECIDED };
