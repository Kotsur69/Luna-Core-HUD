// ============================================================================
// LunaCore - "/ask <question>" command parsing (pure)
// ----------------------------------------------------------------------------
// Split out of modules/ask.js for exactly one reason: ask.js does module-scope
// document.getElementById() (the overlay's own DOM refs) the moment it is
// imported, same as every other overlay module in this app (libraries.js,
// gitquick.js, palette.js) - so it cannot be require()'d from a plain
// `node --test` run with no DOM. gitquick.js hit the same wall and split its
// pure formatting helpers into gitquick-format.js; this is that same split,
// for the same reason - see that file's header and test/gitquick.test.js.
//
// ask.js still owns these functions as far as anything outside this pair of
// files is concerned - it re-exports them, so modules/libraries.js's
// `import { isAskCommand, parseAskQuery, openAsk } from './ask.js'` needs no
// awareness that they actually live here.
// ============================================================================

'use strict';

/** The command prefix libraries.js's Enter-handler checks for. */
export const ASK_PREFIX = '/ask';

const ASK_COMMAND_RE = /^\/ask\s+/i;

/**
 * Does this raw filter-box value start a "/ask <question>" command?
 * @param {string} raw
 * @returns {boolean}
 */
export function isAskCommand(raw) {
  return typeof raw === 'string' && ASK_COMMAND_RE.test(raw.trim());
}

/**
 * Strips the "/ask" prefix (and the whitespace after it) off a raw command,
 * leaving just the question.
 * @param {string} raw
 * @returns {string}
 */
export function parseAskQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(ASK_COMMAND_RE, '').trim();
}
