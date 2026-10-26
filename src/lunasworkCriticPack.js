// ============================================================================
// LunaCore - Luna's Work Critic: the design-pack writes (split out of
// lunasworkCritic.js)
// ----------------------------------------------------------------------------
// After a Critic pass: one PLAYTEST_LOG.md entry, the new ARCHITECTURE.md, the
// DECISIONS.md lines and new TEST_PLAN.md journeys - all through
// lunasworkPack, so only design/ pack files can be written. Model text is
// flattened to one line or has its headings demoted, so it cannot add a
// section of its own.
//
// LW 2.22a: the iteration's CHANGELOG.md entry (Keep a Changelog), built from
// the cards the Playtester closed (changelogEntry, pure) and merged into the
// project root's CHANGELOG.md under "## [Unreleased]" (withChangelogEntry,
// pure; appendChangelog writes it). The file is not committed here: it rides
// in the working tree until SHIP (src/lunasworkShipDocs.js), where the release
// card turns Unreleased into the version section.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
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

// ---- LW 2.22a: CHANGELOG.md -------------------------------------------------------------

const CHANGELOG_FILE = 'CHANGELOG.md';
// Keep a Changelog's change types, in its order.
const CHANGE_TYPES = Object.freeze(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
// Critic card kind -> change type; a card without one (Mati's steer card) is a change.
const KIND_TYPE = Object.freeze({ bug: 'Fixed', missing: 'Added', idea: 'Added', feel: 'Changed' });
const CHANGELOG_HEAD = [
  '# Changelog',
  '',
  'All notable changes to this project are documented in this file.',
  '',
  'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),',
  'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
].join('\n');
const UNRELEASED_HEADING = '## [Unreleased]';
const MAX_CHANGELOG_CARDS = 30;
const MAX_CHANGELOG_LINE_CHARS = 200;
// Never rewritten past this: a huge file is a human's, not an append target.
const MAX_CHANGELOG_BYTES = 1024 * 1024;

const UNRELEASED_RE = /^##\s+\[?unreleased\]?\s*$/i;
const H2_RE = /^##\s/;
const H3_RE = /^###\s+(.+?)\s*$/;
const bulletKey = (line) => line.replace(/^-\s+/, '').toLowerCase().replace(/\s+/g, ' ').trim();
const typeRank = (title) => {
  const i = CHANGE_TYPES.findIndex((t) => t.toLowerCase() === String(title).toLowerCase());
  return i < 0 ? CHANGE_TYPES.length : i;
};

/**
 * The iteration's changelog entry from the cards closed in it. Pure.
 * @param {{iteration?:number, cards:{text:string, kind?:string|null}[]}} input
 * @returns {Record<string,string[]>|null} change type -> "- text" lines, in
 *   Keep a Changelog order; null when no card closed
 */
function changelogEntry({ cards } = {}) {
  const seen = new Set();
  const byType = {};
  for (const card of (Array.isArray(cards) ? cards : []).slice(0, MAX_CHANGELOG_CARDS)) {
    const text = card && typeof card.text === 'string' ? oneLine(card.text).slice(0, MAX_CHANGELOG_LINE_CHARS) : '';
    const line = `- ${text}`;
    if (!text || seen.has(bulletKey(line))) continue;
    seen.add(bulletKey(line));
    const type = KIND_TYPE[card.kind] || 'Changed';
    byType[type] = [...(byType[type] || []), line];
  }
  const types = CHANGE_TYPES.filter((t) => byType[t]);
  return types.length ? Object.fromEntries(types.map((t) => [t, byType[t]])) : null;
}

/** The Unreleased section split into its lines before the first "### " and its subsections. */
function parseSection(lines) {
  const firstSub = lines.findIndex((l) => H3_RE.test(l));
  const pre = firstSub < 0 ? lines : lines.slice(0, firstSub);
  const subs = [];
  for (const line of firstSub < 0 ? [] : lines.slice(firstSub)) {
    const m = line.match(H3_RE);
    if (m) subs.push({ title: m[1], lines: [] });
    else subs[subs.length - 1].lines.push(line);
  }
  return { pre, subs };
}

const trimBlank = (lines) => {
  const start = lines.findIndex((l) => l.trim());
  if (start < 0) return [];
  const end = lines.length - [...lines].reverse().findIndex((l) => l.trim());
  return lines.slice(start, end);
};

/** Each entry type merged into its "### " subsection (made in canonical order when missing); repeats skipped. */
function mergeSection(section, entry) {
  const known = new Set([...section.pre, ...section.subs.flatMap((s) => s.lines)].filter((l) => /^-\s/.test(l)).map(bulletKey));
  let subs = section.subs.map((s) => ({ ...s, lines: trimBlank(s.lines) }));
  for (const type of CHANGE_TYPES) {
    const fresh = (entry[type] || []).filter((l) => !known.has(bulletKey(l)));
    fresh.forEach((l) => known.add(bulletKey(l)));
    if (!fresh.length) continue;
    const at = subs.findIndex((s) => s.title.toLowerCase() === type.toLowerCase());
    if (at >= 0) {
      subs = subs.map((s, i) => (i === at ? { ...s, lines: [...s.lines, ...fresh] } : s));
      continue;
    }
    const before = subs.findIndex((s) => typeRank(s.title) > typeRank(type));
    const sub = { title: type, lines: fresh };
    subs = before < 0 ? [...subs, sub] : [...subs.slice(0, before), sub, ...subs.slice(before)];
  }
  const pre = trimBlank(section.pre);
  return [
    ...(pre.length ? ['', ...pre] : []),
    ...subs.flatMap((s) => ['', `### ${s.title}`, ...s.lines]),
  ];
}

/**
 * CHANGELOG.md text with the entry merged into "## [Unreleased]" (made before
 * the first release section when missing; the Keep a Changelog header when the
 * file is new). Lines already in Unreleased are not repeated. Pure.
 * @param {string} current the file's text ('' when missing)
 * @param {Record<string,string[]>|null} entry a changelogEntry() result
 * @returns {string}
 */
function withChangelogEntry(current, entry) {
  const text = String(current || '').replace(/\r\n/g, '\n');
  if (!entry) return text;
  const lines = (text.trim() ? text.replace(/\s+$/, '') : CHANGELOG_HEAD).split('\n');
  let start = lines.findIndex((l) => UNRELEASED_RE.test(l));
  let all = lines;
  if (start < 0) {
    const firstH2 = lines.findIndex((l) => H2_RE.test(l));
    start = firstH2 < 0 ? lines.length : firstH2;
    all = [...lines.slice(0, start), UNRELEASED_HEADING, ...lines.slice(start)];
  }
  const after = all.findIndex((l, i) => i > start && H2_RE.test(l));
  const end = after < 0 ? all.length : after;
  const body = mergeSection(parseSection(all.slice(start + 1, end)), entry);
  const head = trimBlank(all.slice(0, start));
  const rest = all.slice(end);
  return [
    ...head, ...(head.length ? [''] : []),
    all[start], ...body,
    ...(rest.length ? ['', ...rest] : []),
  ].join('\n').replace(/\s+$/, '') + '\n';
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Writes the entry into <repo>/CHANGELOG.md - that one file at the repo root,
 * never through a symlink, never one past MAX_CHANGELOG_BYTES.
 * @returns {{ok:boolean, written:boolean, error?:string}}
 */
function appendChangelog(repoDir, entry) {
  if (!entry) return { ok: true, written: false };
  try {
    if (typeof repoDir !== 'string' || !path.isAbsolute(repoDir)) return { ok: false, written: false, error: 'noRepo' };
    const target = path.join(fs.realpathSync(repoDir), CHANGELOG_FILE);
    let current = '';
    // lstat, not exists: a dangling symlink is refused too.
    const stat = lstatOrNull(target);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, written: false, error: 'notAFile' };
      if (stat.size > MAX_CHANGELOG_BYTES) return { ok: false, written: false, error: 'tooLarge' };
      current = fs.readFileSync(target, 'utf8');
    }
    const next = withChangelogEntry(current, entry);
    if (next === current) return { ok: true, written: false };
    fs.writeFileSync(target, next, 'utf8');
    return { ok: true, written: true };
  } catch (err) {
    return { ok: false, written: false, error: (err && err.code) || 'writeFailed' };
  }
}

/**
 * PLAYTEST_LOG.md entry, ARCHITECTURE.md, DECISIONS.md, TEST_PLAN.md journeys -
 * all through lunasworkPack, so only design/ pack files can be written - and
 * LW 2.22a's CHANGELOG.md entry from `closedCards`.
 * @returns {{written:string[], warnings:object[]}}
 */
function writePack(repoDir, critique, { iteration, date, gate, architectureCut = false, closedCards = [] }) {
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
  const changelog = appendChangelog(repoDir, changelogEntry({ iteration, cards: closedCards }));
  if (!changelog.ok) warnings.push({ code: 'changelogWriteFailed', file: CHANGELOG_FILE, detail: changelog.error });
  else if (changelog.written) written.push(CHANGELOG_FILE);
  return { written, warnings };
}

module.exports = {
  CHANGELOG_FILE,
  CHANGE_TYPES,
  formatLogEntry,
  writePack,
  changelogEntry,
  withChangelogEntry,
  appendChangelog,
};
