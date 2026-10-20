// ============================================================================
// LunaCore - God Mode v2 run email (orchestraFinalize.js report -> Gmail)
// ----------------------------------------------------------------------------
// When a run is finalized, Mati gets one email:
//   subject  'God Mode: <repo name> - N of M pushed'  (or '- integration failed')
//   body     'Needs you' first (packages that did not make it + why, approval
//            prompts that stalled workers, a failed integration), then the PR
//            links, then the full markdown report as plain text.
//
// Only the repo NAME goes out, never its path (the report's Repo line is
// rewritten). Every string is stripped of control characters; nothing is HTML.
//
// Dedupe: (run id, pushed count, integration state) is persisted in
// mail-state.local.json. A re-finalize with the same result sends nothing; a
// changed result sends one email marked 'updated'. Sending is async and never
// throws into finalize: a failure is logged and handed back as a reason for
// the board and the report.
// ============================================================================

'use strict';

const MAX_LINE = 300;
const MAX_REPORT = 60000;
const MAX_ITEMS = 50;

// eslint-disable-next-line no-control-regex
const clean = (v, max = MAX_LINE) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim().slice(0, max);

/** The report as plain text: control characters out (newlines kept), path-free Repo line. */
function reportText(text, repoName) {
  return String(text || '')
    .slice(0, MAX_REPORT)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/^- Repo: `[^`\n]*`/m, `- Repo: ${repoName || '-'}`);
}

/** The dedupe key of a run's result. */
const resultKey = (s) => `${Math.max(0, Math.min(9999, s.pushed | 0))}|${/^[a-z]{1,24}$/.test(s.integrationState) ? s.integrationState : 'idle'}`;

/**
 * @param {string} text  orchestraReport.buildReport markdown
 * @param {object} summary  godmodesnapshot.runEntry(view, extra) plus
 *   integrationError (string|null)
 * @param {{updated?:boolean}} [opts]
 * @returns {{subject:string, text:string}}
 */
function buildRunEmail(text, summary, opts = {}) {
  const repo = clean(summary.repoName, 100) || 'repo';
  const failed = summary.integrationState === 'failed';
  const head = failed ? 'integration failed' : `${summary.pushed} of ${summary.total} pushed`;
  const subject = `God Mode: ${repo} - ${head}${opts.updated ? ' (updated)' : ''}`;

  const needs = [];
  for (const p of (summary.packages || []).slice(0, MAX_ITEMS)) {
    if (p.state === 'pushed') continue;
    needs.push(`- ${clean(p.id, 64)} ${clean(p.title, 120)}: ${clean(p.state, 24)}${p.reason ? ` - ${clean(p.reason)}` : ''}`);
  }
  for (const rule of (summary.approvalSuggestions || []).slice(0, MAX_ITEMS)) needs.push(`- Approval prompt stalled a worker: ${clean(rule, 200)}`);
  if (failed) needs.push(`- Integration failed${summary.integrationError ? `: ${clean(summary.integrationError)}` : ''}`);

  const prs = (summary.packages || []).filter((p) => p.prUrl).slice(0, MAX_ITEMS).map((p) => `- ${clean(p.id, 64)}: ${clean(p.prUrl)}`);

  const lines = [];
  if (opts.updated) lines.push('This run was finalized again with a different result.', '');
  lines.push('NEEDS YOU', ...(needs.length ? needs : ['- nothing']), '');
  if (prs.length) lines.push('PULL REQUESTS', ...prs, '');
  lines.push('FULL REPORT', '', reportText(text, repo));
  return { subject, text: lines.join('\n') };
}

/**
 * @param {{sender:{status:Function, send:Function}, prefs:{loadPrefs:Function, loadState:Function, updateState:Function},
 *   enabled:(prefs:object, connected:boolean)=>boolean}} deps
 */
function createGodModeMailer({ sender, prefs, enabled, maxRuns = 50 }) {
  // One send at a time per run: two quick re-finalizes must not both pass the dedupe.
  const inFlight = new Set();

  /**
   * @returns {Promise<{sent:boolean, skipped?:string, error?:string}>} never rejects
   */
  async function onReport(runId, text, summary) {
    try {
      if (!summary || typeof runId !== 'string') return { sent: false, skipped: 'bad-input' };
      const st = sender.status();
      if (!enabled(prefs.loadPrefs(), st.connected)) return { sent: false, skipped: 'off' };
      const key = resultKey(summary);
      const prev = prefs.loadState().godmode[runId];
      if (prev === key) return { sent: false, skipped: 'duplicate' };
      if (inFlight.has(runId)) return { sent: false, skipped: 'busy' };
      inFlight.add(runId);
      try {
        const mail = buildRunEmail(text, summary, { updated: !!prev });
        await sender.send({ subject: mail.subject, text: mail.text });
        prefs.updateState((s) => {
          const godmode = { ...s.godmode };
          delete godmode[runId];
          godmode[runId] = key;
          const ids = Object.keys(godmode);
          for (const id of ids.slice(0, Math.max(0, ids.length - maxRuns))) delete godmode[id];
          return { ...s, godmode };
        });
        return { sent: true };
      } finally {
        inFlight.delete(runId);
      }
    } catch (err) {
      const reason = (err && err.reason) || 'gmail-failed';
      console.error('[godmodemail] run email failed:', reason, err && err.message);
      return { sent: false, error: reason };
    }
  }

  return { onReport };
}

module.exports = { buildRunEmail, createGodModeMailer, resultKey, reportText };
