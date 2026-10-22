// ============================================================================
// LunaCore - the '## Needs you' section of a God Mode report, as plain lines
// ----------------------------------------------------------------------------
// Shared by the run email (godmodemail.js) and the run snapshot
// (godmodesnapshot.js, which the phone imports too - so no Node built-ins).
// ============================================================================

'use strict';

const MAX_LINE = 300;
const MAX_REPORT = 60000;
const MAX_ITEMS = 50;

// eslint-disable-next-line no-control-regex
const clean = (v, max = MAX_LINE) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim().slice(0, max);

/**
 * The report's '## Needs you' section as plain lines ([] for 'Nothing - all
 * done'), or null when the report has no such section (an older layout).
 * The report already strips model output; this strips again - control
 * characters and markdown code marks out, capped.
 * @param {string} text  orchestraReport.buildReport markdown
 * @param {{maxItems?:number, maxLine?:number}} [opts]
 * @returns {string[]|null}
 */
function needsFromReport(text, { maxItems = MAX_ITEMS, maxLine = MAX_LINE } = {}) {
  const lines = String(text || '').slice(0, MAX_REPORT).split(/\r?\n/);
  const start = lines.indexOf('## Needs you');
  if (start < 0) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (out.length >= maxItems) break;
    if (line.startsWith('## ')) break;
    const body = clean(line.replace(/`/g, ''), maxLine);
    if (!body || body === 'Nothing - all done') continue;
    // An indented line is the self-check's output tail: keep it indented.
    out.push(/^\s/.test(line) ? `    ${body}` : body);
  }
  return out;
}

module.exports = { needsFromReport };
