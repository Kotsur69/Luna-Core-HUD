// ============================================================================
// LunaCore - report visuals (renderer)
// ----------------------------------------------------------------------------
// Small DOM building blocks shared by the hub's weekly / daily brief
// (missionbriefview.js) and the God Mode run summary (godmodesummary.js):
// a row of stat tiles, a list of inline bars, one stacked bar with a legend,
// status chips (colour AND an icon glyph, never colour alone) and collapsible
// <details> sections. Plain DOM + CSS (reportvisuals.css), no canvas, no
// library. Everything is built with createElement / textContent: data never
// reaches an HTML parser. Bar widths are computed numbers, not data strings.
//
// The *Stats / *Bars helpers turn the views' data into plain rows, so the
// tests can check them without a DOM. Missing or malformed fields drop the
// tile (or the whole visual) instead of showing "NaN" or "undefined".
// ============================================================================

'use strict';

import { t } from './util.js';

/** Tone -> the glyph shown next to the colour (aria-hidden; the text says it). */
export const TONE_ICON = Object.freeze({ ok: '✓', bad: '✕', warn: '!', info: 'i', muted: '·' });
const TONES = Object.keys(TONE_ICON);
const MAX_BARS = 8;
const MIN_BAR_PCT = 2;

const toneOf = (v) => (TONES.includes(v) ? v : 'muted');
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const r1 = (v) => Math.round(v * 10) / 10;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A tile value worth showing: a finite number or a non-empty string. */
const hasValue = (v) => (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '');

// --- DOM blocks -------------------------------------------------------------

/**
 * A status chip: tinted pill, icon glyph + text.
 * @param {string} text
 * @param {'ok'|'bad'|'warn'|'info'|'muted'} [tone]
 */
export function chip(text, tone) {
  const tn = toneOf(tone);
  const node = el('span', `rv-chip is-${tn}`);
  const icon = el('span', 'rv-chip__icon', TONE_ICON[tn]);
  icon.setAttribute('aria-hidden', 'true');
  node.append(icon, el('span', 'rv-chip__text', String(text)));
  return node;
}

/**
 * A row of stat tiles. Items without a usable value are left out; no items
 * left -> null (the caller appends nothing).
 * @param {Array<{label:string, value:string|number, tone?:string, hint?:string}>} items
 * @param {string} [ariaLabel]
 * @returns {HTMLElement|null}
 */
export function statTiles(items, ariaLabel) {
  const usable = (Array.isArray(items) ? items : []).filter((i) => isObject(i) && hasValue(i.value) && i.label);
  if (!usable.length) return null;
  const list = el('ul', 'rv-tiles');
  if (ariaLabel) list.setAttribute('aria-label', ariaLabel);
  for (const item of usable) {
    const li = el('li', `rv-tile is-${toneOf(item.tone)}`);
    li.append(el('span', 'rv-tile__value', String(item.value)), el('span', 'rv-tile__label', String(item.label)));
    if (item.hint) li.title = String(item.hint);
    list.append(li);
  }
  return list;
}

/**
 * Horizontal bars scaled to the largest value; label and value stay as text,
 * the bar itself is decoration (aria-hidden).
 * @param {Array<{label:string, value:number, text?:string, tone?:string}>} rows
 * @param {string} [ariaLabel]
 * @returns {HTMLElement|null}
 */
export function barList(rows, ariaLabel) {
  const usable = (Array.isArray(rows) ? rows : []).filter((r) => isObject(r) && r.label && count(r.value) > 0).slice(0, MAX_BARS);
  if (!usable.length) return null;
  const max = Math.max(...usable.map((r) => r.value));
  const list = el('ul', 'rv-bars');
  if (ariaLabel) list.setAttribute('aria-label', ariaLabel);
  for (const r of usable) {
    const li = el('li', 'rv-bar');
    const track = el('span', 'rv-bar__track');
    track.setAttribute('aria-hidden', 'true');
    const fill = el('span', `rv-bar__fill is-${toneOf(r.tone || 'info')}`);
    fill.style.width = `${Math.max(MIN_BAR_PCT, Math.round((r.value / max) * 100))}%`;
    track.append(fill);
    li.append(el('span', 'rv-bar__label', String(r.label)), track, el('span', 'rv-bar__value', String(r.text == null ? r.value : r.text)));
    list.append(li);
  }
  return list;
}

/**
 * One stacked bar (shares of a whole) with a chip legend under it.
 * @param {Array<{label:string, value:number, text?:string, tone?:string}>} segments
 * @param {string} [ariaLabel]
 * @returns {HTMLElement|null}
 */
export function stackBar(segments, ariaLabel) {
  const usable = (Array.isArray(segments) ? segments : []).filter((s) => isObject(s) && s.label && Number.isFinite(s.value) && s.value > 0);
  const total = usable.reduce((sum, s) => sum + s.value, 0);
  if (!total) return null;
  const box = el('div', 'rv-stack');
  const bar = el('div', 'rv-stack__bar');
  bar.setAttribute('aria-hidden', 'true');
  for (const s of usable) {
    const part = el('span', `rv-stack__seg is-${toneOf(s.tone)}`);
    part.style.width = `${(s.value / total) * 100}%`;
    bar.append(part);
  }
  const legend = el('ul', 'rv-stack__legend');
  if (ariaLabel) legend.setAttribute('aria-label', ariaLabel);
  for (const s of usable) {
    const li = el('li');
    li.append(chip(`${s.label} ${s.text == null ? s.value : s.text}`, s.tone));
    legend.append(li);
  }
  box.append(bar, legend);
  return box;
}

/**
 * A collapsible section: <details><summary>title (count)</summary>children.
 * Native <details> is keyboard and screen-reader operable as is.
 * @param {string} title
 * @param {number|null} n shown as a count badge when a number
 * @param {Array<Node|null>} children nulls are skipped
 * @param {{open?:boolean, cls?:string}} [opts]
 */
export function details(title, n, children, { open = false, cls = '' } = {}) {
  const box = el('details', `rv-details${cls ? ` ${cls}` : ''}`);
  if (open) box.open = true;
  const summary = el('summary', 'rv-details__head');
  summary.append(el('span', 'rv-details__title', title));
  if (Number.isFinite(n)) summary.append(el('span', 'rv-details__count', String(n)));
  const body = el('div', 'rv-details__body');
  body.append(...(Array.isArray(children) ? children : []).filter(Boolean));
  box.append(summary, body);
  return box;
}

/** A small caption above a visual. */
export const caption = (text) => el('p', 'rv-caption', text);

// --- brief data -------------------------------------------------------------

/** The commits source of a brief: yesterday's (daily) or the weekend's (weekly). */
function commitRepos(inputs) {
  const src = isObject(inputs.yesterday) ? inputs.yesterday : isObject(inputs.weekend) && isObject(inputs.weekend.commits) ? inputs.weekend.commits : null;
  return src && Array.isArray(src.repos) ? src.repos.filter((r) => isObject(r) && typeof r.repo === 'string') : null;
}

/** Commits per repo as bar rows (biggest first, as weeklycollect sorts them). */
export function briefRepoBars(entry) {
  const inputs = isObject(entry) && isObject(entry.inputs) ? entry.inputs : {};
  return (commitRepos(inputs) || []).map((r) => ({ label: r.repo, value: count(r.commits), tone: 'info' })).filter((r) => r.value > 0);
}

/** The week's goals ([{text, status}]) or [] when missing / failed. */
export function briefGoals(entry) {
  const inputs = isObject(entry) && isObject(entry.inputs) ? entry.inputs : {};
  const g = isObject(inputs.goals) && Array.isArray(inputs.goals.goals) ? inputs.goals.goals : [];
  return g.filter((x) => isObject(x) && typeof x.text === 'string' && x.text.trim());
}

/** Goal status -> chip tone ('done' / 'partly' / anything else = not yet). */
export const goalTone = (status) => (status === 'done' ? 'ok' : status === 'partly' ? 'warn' : 'muted');

const CLAUDE_CLASSES = [
  ['work', 'info'],
  ['fun', 'warn'],
  ['other', 'muted'],
  ['unassigned', 'muted'],
];

/** The weekend's Claude hours per class as stack segments (weekly brief only). */
export function briefClaudeSplit(entry) {
  const inputs = isObject(entry) && isObject(entry.inputs) ? entry.inputs : {};
  const claude = isObject(inputs.weekend) && isObject(inputs.weekend.claude) ? inputs.weekend.claude : null;
  const hours = claude && isObject(claude.hours) ? claude.hours : null;
  if (!hours) return [];
  return CLAUDE_CLASSES.map(([cls, tone]) => ({ label: t(`rv.class.${cls}`), value: Number(hours[cls]), text: `${r1(Number(hours[cls]))} h`, tone })).filter(
    (s) => Number.isFinite(s.value) && s.value > 0,
  );
}

/**
 * The brief's stat tiles. Every number comes from the brief's own inputs
 * (or the validated brief); a missing source drops its tile.
 * @param {object} entry a brief entry ({brief, inputs})
 * @returns {Array<{label:string, value:string|number, tone?:string}>}
 */
export function briefStats(entry) {
  if (!isObject(entry)) return [];
  const inputs = isObject(entry.inputs) ? entry.inputs : {};
  const b = isObject(entry.brief) ? entry.brief : null;
  const tiles = [];
  const repos = commitRepos(inputs);
  if (repos) tiles.push({ label: t(inputs.yesterday ? 'rv.brief.commitsYesterday' : 'rv.brief.commitsWeekend'), value: repos.reduce((s, r) => s + count(r.commits), 0), tone: 'info' });
  if (Array.isArray(inputs.events)) tiles.push({ label: t('rv.brief.events'), value: inputs.events.length });
  if (isObject(inputs.todos) && Number.isFinite(inputs.todos.totalOpen)) {
    tiles.push({ label: t('rv.brief.todosOpen'), value: count(inputs.todos.totalOpen), tone: inputs.todos.totalOpen > 0 ? 'warn' : 'ok' });
  }
  if (b && Array.isArray(b.mail)) tiles.push({ label: t('rv.brief.mail'), value: b.mail.length, tone: b.mail.length ? 'warn' : 'ok' });
  const goals = briefGoals(entry);
  if (goals.length) {
    const done = goals.filter((g) => g.status === 'done').length;
    tiles.push({ label: t('rv.brief.goals'), value: `${done}/${goals.length}`, tone: done === goals.length ? 'ok' : 'info' });
  }
  const claudeHours = briefClaudeSplit(entry).reduce((s, x) => s + x.value, 0);
  if (claudeHours > 0) tiles.push({ label: t('rv.brief.claudeHours'), value: `${r1(claudeHours)} h`, tone: 'info' });
  return tiles;
}

// --- God Mode run data ------------------------------------------------------

/** Package state -> chip tone. Unknown states read as muted. */
const STATE_TONE = {
  pushed: 'ok',
  failed: 'bad',
  stalled: 'bad',
  closed: 'bad',
  killed: 'warn',
  pending: 'muted',
  launched: 'info',
  finishing: 'info',
};
const STATE_ORDER = ['pushed', 'launched', 'finishing', 'pending', 'killed', 'stalled', 'failed', 'closed'];
const FAILED_STATES = new Set(['failed', 'stalled', 'closed']);

export const stateTone = (state) => STATE_TONE[state] || 'muted';

/** A package state's label in the UI language (raw state when unknown). */
export function stateLabel(state) {
  const s = typeof state === 'string' && state ? state : '-';
  const key = `rv.state.${s}`;
  const text = t(key);
  return text === key ? s : text;
}

const packagesOf = (run) => (isObject(run) && Array.isArray(run.packages) ? run.packages.filter(isObject) : []);

/** Packages per state as stack segments, in a fixed order (unknown states last). */
export function runStateSegments(run) {
  const counts = new Map();
  for (const p of packagesOf(run)) {
    const s = typeof p.state === 'string' && p.state ? p.state : 'unknown';
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  const order = [...STATE_ORDER.filter((s) => counts.has(s)), ...[...counts.keys()].filter((s) => !STATE_ORDER.includes(s))];
  return order.map((s) => ({ label: stateLabel(s), value: counts.get(s), tone: stateTone(s) }));
}

const SELF_CHECK_TONE = { ok: 'ok', failed: 'bad', none: 'muted' };

/** Self-check state ('ok' | 'failed' | 'none') as {text, tone}. */
export function selfCheckChip(state) {
  const s = Object.prototype.hasOwnProperty.call(SELF_CHECK_TONE, state) ? state : 'none';
  return { text: t(`rv.selfCheck.${s}`), tone: SELF_CHECK_TONE[s] };
}

/**
 * The run summary's stat tiles (godmodesnapshot cleanRun shape).
 * @param {object} run
 */
export function runStats(run) {
  if (!isObject(run)) return [];
  const pkgs = packagesOf(run);
  const total = Math.max(count(run.total), pkgs.length);
  const merge = run.integrationMode === 'merge';
  const landed = count(merge ? run.merged : run.pushed);
  const failed = pkgs.filter((p) => FAILED_STATES.has(p.state)).length;
  const needs = Array.isArray(run.needs) ? run.needs.length : null;
  const sc = selfCheckChip(run.selfCheck);
  const tiles = [
    { label: t(merge ? 'gm.sum.merged' : 'gm.sum.pushed'), value: `${landed}/${total}`, tone: landedTone(landed, total) },
    { label: t('rv.run.failed'), value: failed, tone: failed ? 'bad' : 'ok' },
  ];
  if (Number.isFinite(run.skipped) && run.skipped > 0) tiles.push({ label: t('rv.run.skipped'), value: count(run.skipped), tone: 'warn' });
  if (Number.isFinite(run.blocked) && run.blocked > 0) tiles.push({ label: t('rv.run.blocked'), value: count(run.blocked), tone: 'warn' });
  tiles.push({ label: t('gm.sum.selfCheck'), value: sc.text, tone: sc.tone });
  if (needs !== null) tiles.push({ label: t('gm.sum.needs'), value: needs, tone: needs ? 'warn' : 'ok' });
  return tiles;
}

/** Landed / total -> tone: all landed ok, some warn, none bad, an empty run muted. */
function landedTone(landed, total) {
  if (!total) return 'muted';
  if (landed >= total) return 'ok';
  return landed ? 'warn' : 'bad';
}
