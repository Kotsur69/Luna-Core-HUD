// ============================================================================
// LunaCore - Mission Control: GitHub Trending section (News widget)
// ----------------------------------------------------------------------------
// Renders the repositories main scraped from github.com/trending
// (src/missiontrending.js, no model call). The renderer only names a period and
// an item id; main owns every URL. All text goes in through textContent.
// "Describe" is the one paid action: main reads the repo README and runs a
// single lean Haiku job; the answer is cached per repo, cost shown like News.
// Loaded on mount when older than STALE_MS; the refresh button and the period
// select force a load. State survives unmount, like the other widgets.
// ============================================================================

'use strict';

import { t } from './util.js';
import { errorText, costSuffix, setStatus, ipcFailed } from './missionshared.js';

const STALE_MS = 10 * 60 * 1000;

const lang = () => (window.i18n && window.i18n.lang) || 'pl';
const compact = (n) => new Intl.NumberFormat(lang(), { notation: 'compact' }).format(n);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// period -> {data, at}; a period already loaded is reused until stale.
const loaded = new Map();
// repo -> {description, costUsd} (done) | {error} (failed); keyed by repo, not id, because ids reshuffle per fetch.
const described = new Map();
const describing = new Set();
let period = 'daily';

const FOLD_KEY = 'lunacore.trending.folded';
let folded = readFolded();

function readFolded() {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * @param {HTMLElement} root the widget root
 * @returns {{render:()=>void, unmount:()=>void}}
 */
export function mountTrending(root) {
  const els = {
    period: root.querySelector('#mc-trending-period'),
    refresh: root.querySelector('#mc-trending-refresh'),
    status: root.querySelector('#mc-trending-status'),
    list: root.querySelector('#mc-trending'),
  };
  let alive = true;
  let loading = false;

  function descriptionBlock(repo) {
    const done = described.get(repo);
    if (describing.has(repo)) return el('p', 'hint', t('mc.tele.trending.describing'));
    if (!done) return null;
    if (done.error) return el('p', 'hint is-fail', done.error);
    const { summary, useFor, caveats } = done.description;
    const box = el('div', 'mc-summary');
    box.append(el('p', '', summary));
    if (useFor) box.append(el('p', '', `${t('mc.tele.trending.useFor')}: ${useFor}`));
    if (caveats) box.append(el('p', 'hint', `${t('mc.tele.trending.caveats')}: ${caveats}`));
    box.append(el('p', 'hint', t('mc.tele.trending.modelNote') + costSuffix(done.costUsd)));
    return box;
  }

  async function describe(item) {
    if (describing.has(item.repo)) return;
    describing.add(item.repo);
    described.delete(item.repo);
    render();
    const res = await window.lunacore.missionTrendingDescribe(item.id, lang()).catch(ipcFailed);
    describing.delete(item.repo);
    described.set(item.repo, res.ok ? { description: res.description, costUsd: res.costUsd } : { error: errorText(res.reason) });
    render();
  }

  function row(item, periodName) {
    const li = el('li', 'mc-news__trend');
    const line = el('div', 'mc-news__row');
    const name = el('button', 'mc-news__name', item.repo);
    name.type = 'button';
    // Main resolves the id to the URL it scraped; the renderer never names one.
    name.addEventListener('click', () => window.lunacore.missionTrendingOpen(item.id));
    if (item.description) name.title = item.description;
    const meta = [item.language, t('mc.tele.trending.stars', { n: compact(item.stars) })].filter(Boolean).join(' · ');
    const gained = t(`mc.tele.trending.gained.${periodName}`, { n: compact(item.gained) });
    const ask = el('button', 'port-btn', t('mc.tele.trending.describe'));
    ask.type = 'button';
    ask.disabled = describing.has(item.repo);
    ask.title = t('mc.tele.trending.describeTitle', { repo: item.repo });
    ask.setAttribute('aria-label', ask.title);
    ask.addEventListener('click', () => describe(item));
    line.append(name, el('span', 'mc-news__meta', `${meta} · ${gained}`), ask);
    li.append(line);
    const block = descriptionBlock(item.repo);
    if (block) li.append(block);
    return li;
  }

  function render() {
    if (!alive) return;
    const entry = loaded.get(period);
    els.list.replaceChildren(...(entry ? entry.data.items.map((item) => row(item, entry.data.period)) : []));
  }

  async function load(force = false) {
    if (!alive || loading) return;
    const hit = loaded.get(period);
    if (!force && hit && Date.now() - hit.at < STALE_MS) {
      setStatus(els.status, '');
      render();
      return;
    }
    loading = true;
    const asked = period;
    setStatus(els.status, t('mc.tele.trending.loading'));
    const res = await window.lunacore.missionTrending(asked).catch(ipcFailed);
    loading = false;
    if (res.ok) loaded.set(asked, { data: res.trending, at: Date.now() });
    if (!alive) return;
    setStatus(els.status, res.ok ? '' : errorText(res.reason), !res.ok);
    // The select may have moved on while this was in flight.
    if (asked !== period) load();
    else render();
  }

  const section = root.querySelector('.mc-news__trending');
  const head = root.querySelector('#mc-trending-head');
  function applyFold() {
    if (folded) section.setAttribute('data-collapsed', '');
    else section.removeAttribute('data-collapsed');
    head.setAttribute('aria-expanded', String(!folded));
  }
  function toggleFold() {
    folded = !folded;
    applyFold();
    try {
      if (folded) localStorage.setItem(FOLD_KEY, '1');
      else localStorage.removeItem(FOLD_KEY);
    } catch {
      // Storage can be blocked; the fold still works for this session.
    }
  }
  head.addEventListener('click', (e) => {
    // The refresh button in the title keeps its own job.
    if (e.target.closest('button')) return;
    toggleFold();
  });
  head.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('button')) return;
    e.preventDefault();
    toggleFold();
  });
  applyFold();

  els.period.value = period;
  els.period.addEventListener('change', () => {
    period = els.period.value;
    render();
    load();
  });
  els.refresh.addEventListener('click', () => load(true));
  render();
  load();

  return {
    render,
    unmount() {
      alive = false;
    },
  };
}
