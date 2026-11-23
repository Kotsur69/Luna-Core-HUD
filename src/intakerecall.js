// ============================================================================
// LunaCore - the intake server's POST /recall (main)
// ----------------------------------------------------------------------------
// Opt-in auto-recall (src/memoryrecall.js): a tab's UserPromptSubmit hook
// (src/memoryrecallhook.js) posts its hook input here with the tab's bearer
// token; src/intake.js checks host, origin, token and method exactly as for
// /mcp and hands the body over. The answer is the hook's JSON output: up to
// two memories of the tab's project as additionalContext, or {} for nothing.
//
// A tab whose store has no `recall` (switched off, memory off for its
// project) gets {}: the hook of a tab started earlier stays quiet instead of
// failing. A failing recall is logged and answered {}, so the prompt goes on
// without memories rather than with a hook error.
//
// Split out of src/intake.js to keep that file under the size ceiling.
// ============================================================================

'use strict';

const RECALL_PATH = '/recall';
/** The one hook event /recall answers. */
const RECALL_HOOK_EVENT = 'UserPromptSubmit';
/** A prompt is cut to this before it is handed on; recall embeds its start only. */
const MAX_RECALL_PROMPT_CHARS = 8000;
/** The additionalContext /recall returns at most (two short memory lines fit many times over). */
const MAX_RECALL_CONTEXT_CHARS = 4000;

const errText = (err) => (err && (err.code || err.message)) || 'error';

/**
 * A /recall body (Claude Code's UserPromptSubmit hook input) -> the prompt.
 * Other hook fields (session_id, cwd, transcript_path) are ignored: the tab
 * is known from the token, never from the body.
 * @param {unknown} raw parsed JSON
 * @returns {{ok: true, prompt: string}|{ok: false, error: string}}
 */
function recallRequestOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'body must be an object' };
  if (raw.hook_event_name !== undefined && raw.hook_event_name !== RECALL_HOOK_EVENT) {
    return { ok: false, error: `hook_event_name must be ${RECALL_HOOK_EVENT}` };
  }
  if (typeof raw.prompt !== 'string') return { ok: false, error: 'prompt must be a string' };
  return { ok: true, prompt: raw.prompt.slice(0, MAX_RECALL_PROMPT_CHARS) };
}

/**
 * The hook output for a recall result: its text as additionalContext, or {}
 * (nothing to add, which the hook treats as success).
 * @param {{text?: string|null}|null} hit
 * @returns {object}
 */
function recallReply(hit) {
  const text = hit && typeof hit.text === 'string' ? hit.text.slice(0, MAX_RECALL_CONTEXT_CHARS) : '';
  return text ? { hookSpecificOutput: { hookEventName: RECALL_HOOK_EVENT, additionalContext: text } } : {};
}

/**
 * Answers one authenticated /recall request.
 * @param {string} body the request body, already size-capped by the server
 * @param {{recall?: (prompt: string) => Promise<{text?: string|null}|null>}} store the tab's store
 * @param {(status: number, body: object) => void} reply sends one JSON response
 */
function answerRecall(body, store, reply) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    reply(400, { error: 'Parse error' });
    return;
  }
  const request = recallRequestOf(parsed);
  if (!request.ok) {
    reply(400, { error: request.error });
    return;
  }
  if (typeof store.recall !== 'function') {
    reply(200, {});
    return;
  }
  Promise.resolve()
    .then(() => store.recall(request.prompt))
    .then(
      (hit) => reply(200, recallReply(hit)),
      (err) => {
        console.error('[intake] recall failed:', errText(err));
        reply(200, {});
      },
    )
    // A reply that cannot be sent (the socket went away) must not become an unhandled rejection.
    .catch((err) => console.error('[intake] recall reply failed:', errText(err)));
}

module.exports = {
  answerRecall,
  recallRequestOf,
  recallReply,
  RECALL_PATH,
  RECALL_HOOK_EVENT,
  MAX_RECALL_PROMPT_CHARS,
  MAX_RECALL_CONTEXT_CHARS,
};
