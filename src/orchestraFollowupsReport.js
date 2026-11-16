// ============================================================================
// LunaCore - God Mode follow-up cards in the run report and the run toast
// ----------------------------------------------------------------------------
// A run with "Sessions may file new to-dos" on (plan.followups) records every
// card its sessions filed (orchestraFollowups.js ledger, stored with the run
// as plan.followupsFiled and shown in the view). The morning report lists
// them grouped by kind, then by package (title + to-do `at`); the run-finished
// toast counts them per kind ("2 bugs, 1 deps, 3 ideas"). Nothing filed = no
// section and no count text.
// Titles are untrusted model output: one line, control / format characters
// stripped, capped; markdown metacharacters escaped in the .md, the HTML goes
// through reportHtml.js escaping.
// ============================================================================

'use strict';

const { FOLLOWUP_KINDS, normalizeFollowupEntries } = require('./orchestraFollowups');

const SECTION_TITLE = 'New to-dos from this run';
/** Kind headings in the (English) report. */
const KIND_TITLES = Object.freeze({ gap: 'Gaps', bug: 'Bugs', deps: 'Dependency / build', idea: 'Ideas' });
/** A title as the report shows it. */
const MAX_TITLE_CHARS = 160;

/** Count words per kind and UI language: [one, few, many]; pl without diacritics. */
const COUNT_WORDS = Object.freeze({
  en: { gap: ['gap', 'gaps', 'gaps'], bug: ['bug', 'bugs', 'bugs'], deps: ['deps', 'deps', 'deps'], idea: ['idea', 'ideas', 'ideas'] },
  pl: { gap: ['brak', 'braki', 'brakow'], bug: ['bug', 'bugi', 'bugow'], deps: ['deps', 'deps', 'deps'], idea: ['pomysl', 'pomysly', 'pomyslow'] },
});
const COUNT_PREFIX = Object.freeze({ en: 'New to-dos', pl: 'Nowe to-do' });

// Control, line / paragraph separator and format characters (bidi overrides,
// zero-width) out; capped by code point, so a surrogate pair is never split.
const oneLine = (v, max) =>
  Array.from(String(v == null ? '' : v).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim())
    .slice(0, max)
    .join('');
// A title as plain markdown text: no link, image, HTML tag, emphasis or code span can form.
const mdText = (v) => v.replace(/[\\`*_[\]()<>!#|~&]/g, (c) => `\\${c}`);
const langOf = (lang) => (lang === 'pl' ? 'pl' : 'en');

/** The run's recorded cards from a view (or a stored plan), validated. */
function entriesOf(view) {
  if (!view || typeof view !== 'object' || typeof view.id !== 'string') return [];
  return normalizeFollowupEntries(view.followupsFiled, view.id);
}

/**
 * Cards grouped by kind (FOLLOWUP_KINDS order), then by package (first-filed
 * order), each card in filing order. Empty kinds are left out.
 * @param {Array<{packageId:string, kind:string, title:string, at:number}>} entries
 * @returns {Array<{kind:string, count:number, packages:Array<{packageId:string, cards:Array<{title:string, at:number}>}>}>}
 */
function groupFollowups(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return FOLLOWUP_KINDS.map((kind) => {
    const ofKind = list.filter((e) => e.kind === kind);
    const ids = [...new Set(ofKind.map((e) => e.packageId))];
    const packages = ids.map((packageId) => ({
      packageId,
      cards: ofKind.filter((e) => e.packageId === packageId).map((e) => ({ title: oneLine(e.title, MAX_TITLE_CHARS), at: e.at })),
    }));
    return { kind, count: ofKind.length, packages };
  }).filter((g) => g.count > 0);
}

/**
 * The markdown section, or [] when the run filed nothing.
 * @param {object} view orchestra view() of the run
 * @returns {string[]}
 */
function followupReportLines(view) {
  const groups = groupFollowups(entriesOf(view));
  if (!groups.length) return [];
  const lines = ['', `## ${SECTION_TITLE}`];
  for (const g of groups) {
    lines.push('', `### ${KIND_TITLES[g.kind]} (${g.count})`, '');
    for (const p of g.packages) {
      lines.push(`- \`${p.packageId}\``);
      for (const c of p.cards) lines.push(`  - ${mdText(c.title)} (to-do at ${c.at})`);
    }
  }
  return lines;
}

/**
 * The HTML section, or '' when the run filed nothing.
 * @param {object} view
 * @param {{section:Function, escapeHtml:Function}} h src/reportHtml.js
 * @returns {string}
 */
function followupReportHtml(view, h) {
  const groups = groupFollowups(entriesOf(view));
  if (!groups.length) return '';
  const blocks = groups.map((g) => {
    const items = g.packages.map((p) => {
      const cards = p.cards.map((c) => `<li>${h.escapeHtml(c.title)} (to-do at ${h.escapeHtml(c.at)})</li>`);
      return `<li><code>${h.escapeHtml(p.packageId)}</code><ul class="plain">${cards.join('')}</ul></li>`;
    });
    return `<h3>${h.escapeHtml(`${KIND_TITLES[g.kind]} (${g.count})`)}</h3><ul class="plain">${items.join('')}</ul>`;
  });
  return h.section(SECTION_TITLE, blocks.join('\n'));
}

/**
 * Cards per kind; only kinds with at least one card.
 * @param {Array<{kind:string}>} entries
 * @returns {Record<string, number>}
 */
function followupCounts(entries) {
  const counts = {};
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && FOLLOWUP_KINDS.includes(e.kind)) counts[e.kind] = (counts[e.kind] || 0) + 1;
  }
  return counts;
}

/** Polish plural form index: 0 one, 1 few (2-4, not 12-14), 2 many. */
function plForm(n) {
  if (n === 1) return 0;
  const tens = n % 100;
  return n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14) ? 1 : 2;
}

/**
 * "2 bugs, 1 deps, 3 ideas" in the UI language, or '' when nothing was filed.
 * @param {Record<string, unknown>|null|undefined} counts followupCounts()
 * @param {unknown} lang 'pl' | anything else = en
 * @returns {string}
 */
function followupCountText(counts, lang) {
  const l = langOf(lang);
  return FOLLOWUP_KINDS.map((kind) => {
    const n = counts && Number.isInteger(counts[kind]) && counts[kind] > 0 ? counts[kind] : 0;
    if (!n) return null;
    const words = COUNT_WORDS[l][kind];
    return `${n} ${l === 'pl' ? words[plForm(n)] : words[n === 1 ? 0 : 1]}`;
  })
    .filter(Boolean)
    .join(', ');
}

/**
 * The run-finished toast body: "3/4 pushed", the integration warning, and
 * the follow-up counts when the run filed any.
 * @param {{pushed:number, total:number, failed?:boolean, followups?:Record<string, number>|null}} summary
 * @param {unknown} lang
 * @returns {string}
 */
function runToastBody({ pushed, total, failed, followups }, lang) {
  const base = `${pushed}/${total} pushed${failed ? ' - integration needs you' : ''}`;
  const counts = followupCountText(followups, lang);
  return counts ? `${base} - ${COUNT_PREFIX[langOf(lang)]}: ${counts}` : base;
}

module.exports = {
  SECTION_TITLE,
  entriesOf,
  groupFollowups,
  followupReportLines,
  followupReportHtml,
  followupCounts,
  followupCountText,
  runToastBody,
};
