// ============================================================================
// LunaCore phone - Mission: the last news briefing + the Claude ledger (4c)
// ----------------------------------------------------------------------------
// Both come from the PCs' `snapshots` rows, parsed by snapmodel.js with the
// PC's own validators. News text is LLM output over fetched pages: it goes in
// as text only. Links were re-checked (safeUrl + public host); each one shows
// its host and opens outside the app with noopener noreferrer.
// ============================================================================

import { h, icon, ICONS } from '../dom.js';
import { t, tf, locale } from '../i18n.js';
import { newsFrom, ledgerFrom } from '../snapmodel.js';
import { mountSnapshots, when } from './snapshotview.js';
import ratecalc from '../../../src/ratecalc.js';
import baseRates from '../../../config/rates.json';

const { mergeRates, formatUsd } = ratecalc;
// The shipped price table; a PC's rates.local.json override stays on that PC.
const RATES = mergeRates(baseRates, null);
const TAB_KEY = 'lunacore.mission.tab';
const TABS = [
  ['news', 'tabNews'],
  ['claude', 'tabClaude'],
];
const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

function savedTab() {
  try {
    return sessionStorage.getItem(TAB_KEY) === 'claude' ? 'claude' : 'news';
  } catch {
    return 'news';
  }
}

// The CSP (style-src 'self') blocks style attributes, so sizes go through the CSSOM.
function scaled(f) {
  const bar = h('span');
  bar.style.transform = `scaleX(${Math.max(0, Math.min(1, f))})`;
  return bar;
}

const hostOf = (url) => new URL(url).hostname.replace(/^www\./, '');

function link(e) {
  const host = hostOf(e.url);
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'link-row', href: e.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${e.title || host} (${tf('opensSite', { host })})` },
      h('span', { class: 'grow' }, h('span', { class: 'link-title' }, e.title || host), h('span', { class: 'hint' }, e.pick ? `${t('pick')} · ${host}` : host)),
      icon(ICONS.external),
    ),
  );
}

function section(s, i) {
  const picks = s.entries.filter((e) => e.pick);
  const rest = s.entries.filter((e) => !e.pick);
  const id = `news-s${i}`;
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': id },
    h('h2', { class: 'section-title', id }, s.label || s.platform),
    s.summary ? h('p', { class: 'prose' }, s.summary) : null,
    picks.length ? h('ul', { class: 'links' }, picks.map(link)) : null,
    rest.length ? h('details', { class: 'more' }, h('summary', {}, tf('moreLinks', { n: rest.length })), h('ul', { class: 'links' }, rest.map(link))) : null,
  );
}

function news(rows, now) {
  const r = newsFrom(rows, now);
  if (!r) return h('p', { class: 'empty' }, t('newsEmpty'));
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'hint' }, tf('fromAt', { time: when(r.at, now), machine: r.machine })),
    r.briefing.length
      ? h('section', { class: 'card hero', 'aria-labelledby': 'news-brief' }, h('h2', { class: 'label', id: 'news-brief' }, t('briefing')), h('ul', { class: 'bullets' }, r.briefing.map((b) => h('li', {}, b))))
      : null,
    r.sections.map(section),
  );
}

function projectLine(p, top) {
  const amount = p.usd > 0 ? formatUsd(p.usd) : tf('tokens', { n: compact.format(p.tokens) });
  return h(
    'li',
    { class: 'row-col' },
    h('div', { class: 'row' }, h('span', { class: 'grow' }, p.name), h('span', { class: 'num' }, amount)),
    h('div', { class: 'meter', 'aria-hidden': 'true' }, scaled(top > 0 ? p.usd / top : 0)),
  );
}

function ledger(rows, now) {
  const l = ledgerFrom(rows, now, RATES);
  if (!l.machines.length) return h('p', { class: 'empty' }, t('ledgerEmpty'));
  const top = l.projects.length ? l.projects[0].usd : 0;
  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card hero', 'aria-labelledby': 'ledger-total' },
      h('h2', { class: 'label', id: 'ledger-total' }, t('ledgerWeek')),
      h('div', { class: 'big num' }, formatUsd(l.totalUsd)),
      l.unpricedTokens ? h('div', { class: 'sub' }, tf('ledgerUnpriced', { tokens: compact.format(l.unpricedTokens) })) : null,
    ),
    l.projects.length
      ? h(
          'section',
          { class: 'card' },
          h('ul', { class: 'rows' }, l.projects.map((p) => projectLine(p, top))),
          l.moreProjects ? h('p', { class: 'hint' }, tf('ledgerMore', { n: l.moreProjects })) : null,
        )
      : null,
    h('p', { class: 'hint' }, `${t('ledgerFrom')}: ${l.machines.map((m) => `${m.machine} · ${when(m.updatedAt, now)}`).join(', ')}`),
  );
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountMission(main, deps) {
  let tab = savedTab();
  let last = null; // {byKind, now} once anything has loaded
  const panel = h('div', { role: 'tabpanel' });
  const tabs = h('div', { class: 'segmented', role: 'tablist', 'aria-label': t('navMission') });
  main.replaceChildren(h('div', { class: 'stack' }, tabs, panel));

  const content = () => (tab === 'news' ? news(last.byKind.news, last.now) : ledger(last.byKind.ledger, last.now));

  function select(id) {
    tab = id;
    try {
      sessionStorage.setItem(TAB_KEY, id);
    } catch {
      // Private mode: the tab resets on reload.
    }
    drawTabs();
    if (last) panel.replaceChildren(content());
  }

  function drawTabs() {
    tabs.replaceChildren(...TABS.map(([id, label]) => h('button', { role: 'tab', class: 'seg-btn', 'aria-selected': String(tab === id), onclick: () => select(id) }, t(label))));
  }
  drawTabs();

  return mountSnapshots(panel, deps, ['news', 'ledger'], (byKind, now) => {
    last = { byKind, now };
    return content();
  });
}
