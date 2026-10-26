// ============================================================================
// LunaCore - Luna's Work live dashboard (LW 2.17a, docs/LUNAS_WORK_PLAN.md #12)
// ----------------------------------------------------------------------------
// Opened from the run panel (Settings -> Luna's Work -> Dashboard). Shows the
// current run from lunaswork:dashboard (src/lunasworkDashboardView.js):
//   - KPIs: iteration, phase, tokens and cost so far, cards opened / closed
//   - the iteration timeline: phases with their durations, verdict, rollback
//   - scores per milestone over the iterations (line chart, lifecharts.js)
//   - tokens per role (stacked bars: input / output / cache read / write)
//   - cards opened vs closed, cumulative (line chart)
//   - the latest key-screen screenshots (lunaswork:screenshot, data URLs)
//   - pending decisions with their deadlines (from the live status)
//   - the Lighthouse trend when the run measured it
//   - a slot for the time-to-SHIP estimate (filled by a later package)
// While open it refreshes on every lunaswork:event - no polling, no email.
// Every value from main is painted through textContent / SVG attributes only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { lineChart, stackedBars } from './lifecharts.js';
import { decisionText, elapsed } from './lunasworkPanel.js';

// Series colours, same neon family as the theme variables.
const PALETTE = ['#5ff2d6', '#c774ff', '#ffd86b', '#7cff9b', '#ff6b8a', '#6bb8ff', '#ff9f5f', '#b0b0ff'];
const TOKEN_SERIES = [
  { key: 'inputTokens', color: '#5ff2d6', label: 'lw.dash.tok.input' },
  { key: 'outputTokens', color: '#c774ff', label: 'lw.dash.tok.output' },
  { key: 'cacheReadTokens', color: '#6bb8ff', label: 'lw.dash.tok.cacheRead' },
  { key: 'cacheWriteTokens', color: '#ffd86b', label: 'lw.dash.tok.cacheWrite' },
];
const LIGHTHOUSE_CATEGORIES = ['performance', 'accessibility', 'bestPractices', 'seo'];
const TIMED_PHASES = ['directing', 'building', 'launching', 'playtesting', 'critiquing'];
const REFRESH_DEBOUNCE_MS = 400;
const MAX_SHOT_CACHE = 24;

// ---- pure helpers (tested) -----------------------------------------------------

/** "950", "12.3k", "4.1M" */
export function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/** "$0.42" (two decimals; "<$0.01" for a cost under a cent). */
export function formatUsd(v) {
  if (!Number.isFinite(v) || v <= 0) return '$0.00';
  return v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`;
}

const tokensOf = (u) => (u ? (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) : 0);

/** Rows for the tokens-per-role bars: roles with any usage, biggest first. */
export function tokenRows(usage, roleLabel = (r) => r) {
  const byRole = usage && usage.byRole ? usage.byRole : {};
  return Object.entries(byRole)
    .filter(([, u]) => tokensOf(u) > 0 || (u && u.costUsd > 0))
    .sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]))
    .map(([role, u]) => ({
      role,
      label: roleLabel(role),
      values: Object.fromEntries(TOKEN_SERIES.map((s) => [s.key, u[s.key] || 0])),
      costUsd: u.costUsd || 0,
      calls: u.calls || 0,
    }));
}

/** One line per milestone: [{label, color, points:[{x: iteration, y: score}]}]. */
export function scoreLines(scores, unnamed = '-') {
  return Object.entries(scores || {}).map(([milestone, list], i) => ({
    label: milestone || unnamed,
    color: PALETTE[i % PALETTE.length],
    points: (Array.isArray(list) ? list : []).filter((r) => Number.isInteger(r.n)).map((r) => ({ x: r.n, y: r.score })),
  }));
}

/** Cumulative cards opened and closed over the iterations. */
export function cardLines(cards, labels = { opened: 'opened', closed: 'closed' }) {
  const series = cards && Array.isArray(cards.series) ? cards.series : [];
  const opened = [];
  const closed = [];
  series.reduce(
    (acc, r) => {
      const next = { opened: acc.opened + r.opened, closed: acc.closed + r.closed };
      opened.push({ x: r.n, y: next.opened });
      closed.push({ x: r.n, y: next.closed });
      return next;
    },
    { opened: 0, closed: 0 },
  );
  return [
    { label: labels.opened, color: '#ffd86b', points: opened },
    { label: labels.closed, color: '#7cff9b', points: closed },
  ];
}

/** One line per Lighthouse category, only the measured points. */
export function lighthouseLines(trend, labelOf = (c) => c) {
  const list = Array.isArray(trend) ? trend : [];
  return LIGHTHOUSE_CATEGORIES.map((cat, i) => ({
    label: labelOf(cat),
    color: PALETTE[i % PALETTE.length],
    points: list.filter((e) => e && e.scores && Number.isFinite(e.scores[cat])).map((e) => ({ x: e.iteration, y: e.scores[cat] })),
  })).filter((s) => s.points.length);
}

/**
 * The marks of one timeline row: [{key, tone}] for its verdict, gate,
 * rollback, self-check and failures; the caller translates the keys.
 */
export function timelineMarks(row) {
  const marks = [];
  if (row.verdict === 'ship') {
    const refused = row.shipAgrees === false;
    marks.push({ key: refused ? 'lw.dash.mark.shipRefused' : 'lw.dash.mark.ship', tone: refused ? 'warn' : 'good' });
  }
  if (row.gate) marks.push({ key: 'lw.dash.mark.gate', tone: 'good' });
  if (row.rolledBack) marks.push({ key: 'lw.dash.mark.rollback', tone: 'bad' });
  if (row.selfCheck === 'red') marks.push({ key: 'lw.dash.mark.red', tone: 'bad' });
  if (row.buildFailed) marks.push({ key: 'lw.dash.mark.buildFailed', tone: 'bad' });
  if (row.skipped) marks.push({ key: 'lw.dash.mark.skipped', tone: 'dim' });
  if (row.playtestOk === false) marks.push({ key: 'lw.dash.mark.playtestFailed', tone: 'warn' });
  if (!marks.length) marks.push({ key: 'lw.dash.mark.continue', tone: 'dim' });
  return marks;
}

// ---- DOM ---------------------------------------------------------------------------

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(titleKey, body) {
  const wrap = el('section', 'lw-dash__section');
  wrap.append(el('h3', 'termcustom__section', t(titleKey)), body);
  return wrap;
}

function legend(series) {
  const list = el('ul', 'life-legend life-legend--inline');
  for (const s of series) {
    const item = el('li', 'life-legend__row');
    const dot = el('span', 'lw-dash__dot');
    dot.style.background = s.color;
    item.append(dot, el('span', 'life-legend__name', s.label));
    list.append(item);
  }
  return list;
}

const empty = (key) => el('p', 'termcustom__hint', t(key));

function kpi(labelKey, value, sub) {
  const box = el('div', 'lw-dash__kpi');
  box.append(el('span', 'lw-dash__kpi-label', t(labelKey)), el('span', 'lw-dash__kpi-value', value));
  if (sub) box.append(el('span', 'lw-dash__kpi-sub', sub));
  return box;
}

function kpis(d) {
  const row = el('div', 'lw-dash__kpis');
  const total = d.usage.total;
  row.append(
    kpi('lw.run.iteration', String(d.iteration), d.phase ? t(`lw.phase.${d.phase}`) : ''),
    kpi('lw.dash.tokens', formatTokens(tokensOf(total)), t('lw.dash.calls', { n: total.calls })),
    kpi('lw.dash.cost', formatUsd(total.costUsd)),
    kpi('lw.dash.cards', `${d.cards.closed} / ${d.cards.opened}`, t('lw.dash.cardsSub')),
    // Slot for the time-to-SHIP estimate (a later package fills d.shipEstimate, in ms).
    kpi('lw.dash.eta', Number.isFinite(d.shipEstimate) ? elapsed(d.shipEstimate) : '-', t('lw.dash.etaSoon')),
  );
  return row;
}

function phaseBars(phases) {
  const wrap = el('div', 'lw-dash__phases');
  const totalMs = TIMED_PHASES.reduce((s, p) => s + (phases[p] || 0), 0);
  for (const p of TIMED_PHASES) {
    const ms = phases[p] || 0;
    if (!ms) continue;
    const label = `${t(`lw.phase.${p}`)} ${elapsed(ms)}`;
    const bar = el('span', `lw-dash__phase is-${p}`, label);
    bar.style.flexGrow = String(Math.max(1, Math.round((ms / Math.max(1, totalMs)) * 100)));
    bar.title = label;
    wrap.append(bar);
  }
  return wrap;
}

function timeline(d) {
  if (!d.timeline.length) return empty('lw.dash.noIterations');
  const list = el('ol', 'lw-dash__timeline');
  for (const row of [...d.timeline].reverse()) {
    const item = el('li', 'lw-dash__iter');
    const head = el('div', 'lw-dash__iter-head');
    head.append(el('span', 'lw-dash__iter-n', `#${row.n}`));
    if (row.milestone) head.append(el('span', 'termcustom__hint', row.milestone));
    if (Number.isFinite(row.score)) head.append(el('span', 'lw-dash__iter-score', t('lw.dash.score', { score: row.score })));
    for (const m of timelineMarks(row)) head.append(el('span', `lw-dash__mark is-${m.tone}`, t(m.key)));
    item.append(head);
    const bars = phaseBars(row.phases || {});
    if (bars.childElementCount) item.append(bars);
    item.append(el('span', 'termcustom__hint', t('lw.dash.iterCards', { opened: row.cardsOpened, closed: row.cardsClosed })));
    list.append(item);
  }
  return list;
}

function chartBlock(series, opts) {
  if (!series.some((s) => s.points.length)) return null;
  const wrap = el('div', 'lw-dash__chart');
  wrap.append(lineChart(series, opts), legend(series));
  return wrap;
}

function tokensBlock(d) {
  const rows = tokenRows(d.usage, (r) => t(`lw.role.${r}`));
  if (!rows.length) return empty('lw.dash.noTokens');
  const wrap = el('div', 'lw-dash__chart');
  const series = TOKEN_SERIES.map((s) => ({ ...s, label: t(s.label) }));
  wrap.append(stackedBars(rows, series, { fmt: formatTokens, label: t('lw.dash.tokensPerRole') }), legend(series));
  const table = el('table', 'lw-run__scores');
  const head = el('tr');
  for (const key of ['lw.dash.role', 'lw.dash.tokens', 'lw.dash.callsHead', 'lw.dash.cost']) head.append(el('th', '', t(key)));
  table.append(head);
  for (const r of rows) {
    const tr = el('tr');
    const sum = Object.values(r.values).reduce((s, v) => s + v, 0);
    tr.append(el('td', '', r.label), el('td', '', formatTokens(sum)), el('td', '', String(r.calls)), el('td', '', formatUsd(r.costUsd)));
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

function decisionsBlock(status) {
  const list = status && Array.isArray(status.decisions) ? status.decisions : [];
  if (!list.length) return empty('lw.dash.noDecisions');
  const ul = el('ul', 'lw-run__decisions');
  for (const d of list) {
    const text = decisionText(d);
    const item = el('li', 'lw-run__decision');
    item.append(el('span', 'lw-run__decision-kind', text.kind), el('span', 'lw-run__decision-q', text.question));
    item.append(el('span', 'termcustom__hint', text.options), el('span', 'lw-dash__deadline', text.deadline));
    ul.append(item);
  }
  return ul;
}

/**
 * Mounts the dashboard overlay (#lw-dash).
 * @param {HTMLElement|null} root
 * @returns {{open:()=>void, close:()=>void}}
 */
export function mountLunasWorkDashboard(root) {
  const noop = { open: () => {}, close: () => {} };
  if (!root || typeof window.lunacore.lunasworkDashboard !== 'function') return noop;
  const body = root.querySelector('#lw-dash-content');
  const closeBtn = root.querySelector('#lw-dash-close');
  if (!body || !closeBtn) return noop;

  let isOpen = false;
  let dash = null;
  let status = null;
  let refreshTimer = null;
  let seq = 0;
  // runId/file -> data URL; a screenshot does not change once written.
  const shots = new Map();

  async function loadShot(runId, file, img) {
    const key = `${runId}/${file}`;
    if (!shots.has(key)) {
      const res = await window.lunacore.lunasworkScreenshot(runId, file);
      if (!res || !res.ok || typeof res.dataUrl !== 'string' || !res.dataUrl.startsWith('data:image/')) return;
      if (shots.size >= MAX_SHOT_CACHE) shots.delete(shots.keys().next().value);
      shots.set(key, res.dataUrl);
    }
    img.src = shots.get(key);
  }

  function shotsBlock(d) {
    if (!d.screenshots.length) return empty('lw.dash.noShots');
    const grid = el('div', 'lw-dash__shots');
    for (const s of d.screenshots) {
      const fig = el('figure', 'lw-dash__shot');
      const img = el('img');
      img.alt = s.name;
      fig.append(img, el('figcaption', 'termcustom__hint', `${s.name} · #${s.n}`));
      grid.append(fig);
      loadShot(d.runId, s.file, img);
    }
    return grid;
  }

  function paint() {
    if (!isOpen) return;
    if (!dash) {
      body.replaceChildren(empty('lw.dash.noRun'));
      return;
    }
    const d = dash;
    const summary = el('p', 'termcustom__hint', t(d.active ? 'lw.dash.live' : 'lw.dash.ended', {
      run: d.runId,
      verdict: d.verdict ? t(`lw.verdict.${d.verdict}`) : '-',
    }));
    summary.setAttribute('role', 'status');
    const scores = chartBlock(scoreLines(d.scores, t('lw.run.noMilestone')), { label: t('lw.dash.scores'), min: 0, max: 100 });
    const cardLabels = { opened: t('lw.dash.opened'), closed: t('lw.dash.closed') };
    const cards = chartBlock(cardLines(d.cards, cardLabels), { label: t('lw.dash.cardsChart'), min: 0 });
    const lighthouse = chartBlock(lighthouseLines(d.lighthouse, (c) => t(`lw.dash.lh.${c}`)), { label: t('lw.dash.lighthouse'), min: 0, max: 100 });
    body.replaceChildren(
      summary,
      kpis(d),
      section('lw.dash.timeline', timeline(d)),
      section('lw.dash.scores', scores || empty('lw.dash.noScores')),
      section('lw.dash.tokensPerRole', tokensBlock(d)),
      section('lw.dash.cardsChart', cards || empty('lw.dash.noIterations')),
      section('lw.dash.shots', shotsBlock(d)),
      section('lw.run.pending', decisionsBlock(status)),
      ...(lighthouse ? [section('lw.dash.lighthouse', lighthouse)] : []),
    );
  }

  async function refresh() {
    const mine = ++seq;
    const [res, st] = await Promise.all([window.lunacore.lunasworkDashboard(), window.lunacore.lunasworkStatus()]);
    // A newer refresh started meanwhile, or the overlay was closed.
    if (mine !== seq || !isOpen) return;
    if (res && res.ok) dash = res.dashboard || null;
    if (st && st.ok) status = st.status;
    paint();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    root.hidden = false;
    root.focus();
    body.replaceChildren(empty('lw.dash.loading'));
    refresh();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(refreshTimer);
    root.hidden = true;
  }

  closeBtn.addEventListener('click', close);
  const backdrop = root.querySelector('[data-lw-dash-close]');
  if (backdrop) backdrop.addEventListener('click', close);
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Only the dashboard closes; the Settings overlay under it stays.
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  // Live: every phase transition, wait, decision and stop is a status event.
  window.lunacore.onLunasworkEvent((event) => {
    if (!isOpen) return;
    if (event && event.status) status = event.status;
    scheduleRefresh();
  });
  onLangChange(paint);

  return { open, close };
}
