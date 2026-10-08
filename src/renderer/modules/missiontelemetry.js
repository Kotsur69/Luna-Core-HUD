// ============================================================================
// LunaCore - Mission Control: telemetry widget (GitHub velocity + Claude budget)
// ----------------------------------------------------------------------------
// Two free sources, no model call:
//   - GitHub: mission:github (src/missiongithub.js, through the gh CLI) -
//     contribution history, open PRs / review requests / assigned issues.
//     Loaded on mount when older than STALE_MS; the refresh button forces it.
//   - Claude budget: the usage poll the Usage widget already runs
//     (onUsageUpdate, replayed), so this widget adds no request of its own.
// The arithmetic and the anomaly thresholds live in missionpace.js (pure,
// tested); this file only renders.
// ============================================================================

'use strict';

import { t } from './util.js';
import { defineWidget } from './registry.js';
import { onLangChange, onUsageUpdate } from './bus.js';
import { errorText, setStatus, ipcFailed } from './missionshared.js';
import { githubVelocity, heatmap, budgetPace, paceFlags } from './missionpace.js';

const STALE_MS = 10 * 60 * 1000;
const LISTS = ['reviews', 'prs', 'issues'];

// Module state survives unmount, like the other Mission Control widgets.
let github = null;
let fetchedAt = 0;
let loading = false;
let usage = null;
let els = null;

const lang = () => (window.i18n && window.i18n.lang) || 'pl';
const pct = (n) => `${Math.round(n)}%`;

/** "czw 14:00" / "Thu 02:00 PM" in the UI language. */
function shortWhen(ms) {
  return new Intl.DateTimeFormat(lang(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function weeklyLimit() {
  if (!usage || usage.status !== 'ok' || !Array.isArray(usage.limits)) return null;
  return usage.limits.find((l) => l.window === 'weekly') || null;
}

function renderFlags(velocity, budget) {
  const flags = paceFlags({ velocity, budget });
  els.flags.replaceChildren(
    ...flags.map((f) => {
      const vars = f.key === 'overBurn' ? { at: shortWhen(f.vars.at) } : f.vars;
      const li = el('li', `mc-tele__flag mc-tele__flag--${f.level}`);
      // The symbol carries the level too, so it never rests on colour alone.
      li.append(
        el('span', 'mc-tele__flagicon', f.level === 'info' ? 'i' : '!'),
        el('span', '', t(`mc.tele.flag.${f.key}`, vars))
      );
      return li;
    })
  );
  els.flags.hidden = flags.length === 0;
}

function renderBars(weeks) {
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const bars = el('div', 'mc-tele__bars');
  weeks.forEach((w, i) => {
    const bar = el('div', 'mc-tele__bar');
    bar.style.setProperty('--h', String(w.count / max));
    if (i === weeks.length - 1) bar.classList.add('is-current');
    bar.title = t('mc.tele.weekBar', { date: w.start, n: w.count });
    bars.append(bar);
  });
  bars.setAttribute('role', 'img');
  bars.setAttribute('aria-label', t('mc.tele.barsLabel', { list: weeks.map((w) => w.count).join(', ') }));
  return bars;
}

function renderHeat(cells) {
  const heat = el('div', 'mc-tele__heat');
  heat.setAttribute('role', 'img');
  heat.setAttribute('aria-label', t('mc.tele.heatLabel', { n: github.days.reduce((a, d) => a + d.count, 0) }));
  for (const col of cells) {
    const c = el('div', 'mc-tele__heatcol');
    for (const cell of col) {
      const sq = el('span', 'mc-tele__cell');
      if (cell) {
        sq.dataset.level = String(cell.level);
        sq.title = `${cell.date}: ${cell.count}`;
      } else {
        sq.classList.add('is-future');
      }
      c.append(sq);
    }
    heat.append(c);
  }
  return heat;
}

function renderVelocity(velocity, cells) {
  const line =
    velocity.avgWeek === null
      ? t('mc.tele.thisWeekOnly', { n: velocity.thisWeek })
      : t('mc.tele.thisWeek', {
          n: velocity.thisWeek,
          avg: Math.round(velocity.avgWeek),
          pace: velocity.pace === null ? '-' : pct(velocity.pace * 100),
        });
  els.velocity.replaceChildren(el('p', 'mc-tele__stat', line), renderBars(velocity.weeks), renderHeat(cells));
}

function renderBudget(budget) {
  const limit = weeklyLimit();
  if (!limit) {
    // Say why when the usage meter knows (endpoint down, not signed in...).
    const why = usage && usage.status !== 'ok' && usage.errorMessage ? ` (${usage.errorMessage})` : '';
    els.budget.replaceChildren(el('p', 'hint', t('mc.tele.noBudget') + why));
    return;
  }
  const used = Math.max(0, Math.min(100, limit.percentUsed));
  const head = el('div', 'usage-row');
  head.append(el('span', 'usage-row__label', t('mc.tele.weekly')), el('span', 'usage-row__pct', pct(used)));
  const bar = el('div', 'usage-bar mc-tele__budgetbar');
  const fill = el('div', 'usage-bar__fill');
  fill.style.setProperty('--usage', String(used / 100));
  if (budget && budget.hitsAt !== null) fill.dataset.level = 'bad';
  else if (used >= 80) fill.dataset.level = 'warn';
  bar.append(fill);
  const rows = [head, bar];
  if (budget) {
    // Where the fill would be by now if the week were spent evenly.
    const mark = el('span', 'mc-tele__mark');
    mark.style.setProperty('--at', String(budget.elapsed));
    mark.title = t('mc.tele.expectedMark', { pct: pct(budget.expected) });
    bar.append(mark);
    if (budget.pace !== null) {
      const outlook =
        budget.hitsAt !== null
          ? t('mc.tele.hits', { at: shortWhen(budget.hitsAt) })
          : t('mc.tele.projected', { pct: pct(budget.projected), reset: shortWhen(budget.resetsAt) });
      rows.push(
        el('p', 'mc-tele__stat', t('mc.tele.burn', { pace: budget.pace.toFixed(1), expected: pct(budget.expected) })),
        el('p', 'mc-tele__stat', outlook)
      );
    }
  }
  const fiveH = usage.limits.find((l) => l.window === '5h');
  if (fiveH) rows.push(el('p', 'mc-tele__stat', t('mc.tele.fiveH', { pct: pct(fiveH.percentUsed) })));
  els.budget.replaceChildren(...rows);
}

function renderOpen() {
  const groups = LISTS.map((kind) => {
    const list = github.lists[kind];
    const group = el('div', 'mc-bucket');
    group.append(el('h4', 'mc-bucket__title', t(`mc.tele.list.${kind}`, { n: list.count })));
    for (const item of list.items) {
      const btn = el('button', 'mc-tele__item');
      btn.type = 'button';
      // Main resolves the id to the URL it fetched; the renderer never names one.
      btn.addEventListener('click', () => window.lunacore.missionGithubOpen(item.id));
      const note = item.draft ? `${item.repo} · ${t('mc.tele.draft')}` : item.repo;
      btn.append(el('span', 'mc-tele__itemtitle', item.title), el('span', 'mc-row__note', note));
      group.append(btn);
    }
    return group;
  });
  els.open.replaceChildren(...groups);
}

function render() {
  if (!els) return;
  const now = new Date();
  const limit = weeklyLimit();
  const budget = limit ? budgetPace(limit, now) : null;
  const velocity = github ? githubVelocity(github.days, now) : null;
  renderFlags(velocity, budget);
  renderBudget(budget);
  if (github) {
    renderVelocity(velocity, heatmap(github.days, now));
    renderOpen();
  }
}

async function load() {
  if (loading || !els) return;
  loading = true;
  els.refresh.disabled = true;
  setStatus(els.status, t('mc.tele.loading'));
  const res = await window.lunacore.missionGithub().catch(ipcFailed);
  loading = false;
  if (res.ok) {
    github = res.github;
    fetchedAt = Date.now();
  }
  if (!els) return;
  els.refresh.disabled = false;
  if (res.ok) setStatus(els.status, t('mc.tele.loaded', { login: github.login }));
  else setStatus(els.status, errorText(res.reason), true);
  render();
}

defineWidget({
  id: 'missiontelemetry',
  titleKey: 'mc.tele.title',
  template: 'w-missiontele',
  mount(root) {
    els = {
      refresh: root.querySelector('#mc-tele-refresh'),
      status: root.querySelector('#mc-tele-status'),
      flags: root.querySelector('#mc-tele-flags'),
      velocity: root.querySelector('#mc-tele-velocity'),
      budget: root.querySelector('#mc-tele-budget'),
      open: root.querySelector('#mc-tele-open'),
    };
    els.refresh.addEventListener('click', load);
    const offUsage = onUsageUpdate((u) => {
      usage = u;
      render();
    });
    const offLang = onLangChange(render);
    render();
    if (Date.now() - fetchedAt > STALE_MS) load();
    else if (github) setStatus(els.status, t('mc.tele.loaded', { login: github.login }));
    return () => {
      offUsage();
      offLang();
      els = null;
    };
  },
});
