// ============================================================================
// LunaCore - Luna's Work Critic: the design-pack writes (split out of
// lunasworkCritic.js)
// ----------------------------------------------------------------------------
// After a Critic pass: one PLAYTEST_LOG.md entry, the new ARCHITECTURE.md, the
// DECISIONS.md lines and new TEST_PLAN.md journeys - all through
// lunasworkPack, so only design/ pack files can be written. Model text is
// flattened to one line or has its headings demoted, so it cannot add a
// section of its own.
// ============================================================================

'use strict';

const pack = require('./lunasworkPack');

// Model text on one line, so it cannot open a "## " heading of its own.
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const bullets = (items) => (items.length ? items.map((i) => `- ${oneLine(i)}`) : ['- none']);
// A journey's own "#"/"##" lines would split TEST_PLAN.md's sections.
const demoteHeadings = (text) => text.replace(/^#{1,2}(?=\s)/gm, '####');

/** One PLAYTEST_LOG.md entry, within lunasworkPack's append cap. */
function formatLogEntry({ iteration, date, logEntry, gate, verdict }) {
  const milestone = gate.current
    ? `Milestone: ${gate.current} - gate ${gate.currentPassed ? 'passed' : 'not passed'}${gate.score === null ? '' : `, score ${gate.score}/100`}`
    : 'Milestone: none defined';
  const text = [
    `## Iteration ${iteration} - ${date} - ${verdict.toUpperCase()}`,
    '',
    milestone,
    '',
    `**Played:** ${oneLine(logEntry.played) || '-'}`,
    '', '**Good:**', ...bullets(logEntry.good),
    '', '**Bad:**', ...bullets(logEntry.bad),
    '', '**Broken:**', ...bullets(logEntry.broken),
    '', '**Missing:**', ...bullets(logEntry.missing),
    '', `**Scores:** ${oneLine(logEntry.scores) || '-'}`,
    '', `**Verdict:** ${oneLine(logEntry.verdict) || verdict.toUpperCase()}`,
  ].join('\n');
  return text.slice(0, pack.MAX_APPEND_CHARS);
}

/**
 * PLAYTEST_LOG.md entry, ARCHITECTURE.md, DECISIONS.md, TEST_PLAN.md journeys -
 * all through lunasworkPack, so only design/ pack files can be written.
 * @returns {{written:string[], warnings:object[]}}
 */
function writePack(repoDir, critique, { iteration, date, gate, architectureCut = false }) {
  const written = [];
  const warnings = [];
  const source = `critic, iteration ${iteration}`;
  const ops = [
    ['PLAYTEST_LOG.md', pack.appendPlaytestLog(formatLogEntry({ iteration, date, logEntry: critique.logEntry, gate, verdict: critique.verdict }))],
    ['ARCHITECTURE.md', critique.architecture && !architectureCut ? pack.writeArchitecture(critique.architecture) : undefined],
    ...critique.decisions.map((d) => ['DECISIONS.md', pack.appendDecision({ ...d, source })]),
    ...critique.newJourneys.map((j) => ['TEST_PLAN.md', pack.appendJourney(demoteHeadings(j))]),
  ];
  // The model saw a cut copy: a rewrite from it would lose the rest.
  if (critique.architecture && architectureCut) warnings.push({ code: 'architectureTooLongToRewrite' });
  for (const [file, op] of ops) {
    if (op === undefined) continue; // nothing to write (empty architecture keeps the old one)
    if (op === null) {
      warnings.push({ code: 'packRejected', file });
      continue;
    }
    const res = pack.applyWrite(repoDir, op);
    if (!res.ok) warnings.push({ code: 'packWriteFailed', file, detail: res.error });
    else if (!written.includes(file)) written.push(file);
  }
  return { written, warnings };
}

module.exports = { formatLogEntry, writePack };
