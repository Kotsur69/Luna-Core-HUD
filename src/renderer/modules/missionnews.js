// ============================================================================
// LunaCore - Mission Control: News widget (Agent-Reach fetch + Haiku summary)
// ----------------------------------------------------------------------------
// Saved sources (a feed: YouTube channel, RSS, web page, GitHub repo) and
// topics (keywords searched on YouTube / GitHub / Bilibili / Hacker News).
// Click a source or topic name to scan just that one; tick several and press
// Scan for one combined run. Either way: Agent-Reach fetches (main ->
// helpers/agent-reach), then ONE Haiku call writes the briefing and the
// per-section summaries, and the cost is shown like in the mail widget.
//
// The renderer never holds a URL: entries come with keys, and opening one is
// window.lunacore.missionNewsOpen(key) - main resolves it.
// ============================================================================

'use strict';

import { t } from './util.js';
import { defineWidget } from './registry.js';
import { onLangChange } from './bus.js';
import { errorText, costSuffix, setStatus, ipcFailed } from './missionshared.js';

const SOURCE_PLATFORMS = ['youtube', 'rss', 'web', 'github'];
const TOPIC_PLATFORMS = ['youtube', 'github', 'bilibili', 'hackernews'];
const MAX_TOPICS_PER_ADD = 10;

// Module state survives unmount (closing the panel never re-bills a scan).
let news = { sources: [], topics: [] };
let status = null;
let result = null;
let scanning = false;
const picked = new Set();
let els = null;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(cls, text, onClick, title) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  b.addEventListener('click', onClick);
  return b;
}

const platformName = (p) => t(`mc.news.platform.${p}`);

// ---- Saved lists -------------------------------------------------------------

async function save(next) {
  const res = await window.lunacore.missionNewsSave(next).catch(ipcFailed);
  if (!res.ok) {
    if (els) setStatus(els.status, errorText(res.reason), true);
    return;
  }
  news = res.news;
  const ids = new Set([...news.sources, ...news.topics].map((x) => x.id));
  for (const id of [...picked]) if (!ids.has(id)) picked.delete(id);
  renderLists();
}

function removeItem(kind, id) {
  const key = kind === 'source' ? 'sources' : 'topics';
  save({ ...news, [key]: news[key].filter((x) => x.id !== id) });
}

function row(item, label, meta, kind) {
  const li = el('li', 'mc-news__row');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = picked.has(item.id);
  box.setAttribute('aria-label', t('mc.news.pick', { name: label }));
  box.addEventListener('change', () => {
    if (box.checked) picked.add(item.id);
    else picked.delete(item.id);
    renderScanButton();
  });
  const scanThis = () => (kind === 'source' ? scan([item.id], []) : scan([], [item.id]));
  const name = button('mc-news__name', label, scanThis, t('mc.news.scanOne', { name: label }));
  const remove = button('port-btn mc-news__remove', '×', () => removeItem(kind, item.id), t('mc.news.remove'));
  li.append(box, name, el('span', 'mc-news__meta', meta), remove);
  return li;
}

function renderLists() {
  if (!els) return;
  els.sources.replaceChildren(...news.sources.map((s) => row(s, s.label, platformName(s.platform), 'source')));
  els.topics.replaceChildren(
    ...news.topics.map((tp) => row(tp, tp.query, tp.platforms.map(platformName).join(' · '), 'topic'))
  );
  els.sourcesEmpty.hidden = news.sources.length > 0;
  els.topicsEmpty.hidden = news.topics.length > 0;
  renderScanButton();
}

function addSource(e) {
  e.preventDefault();
  const target = els.sourceTarget.value.trim();
  if (!target) return;
  const platform = els.sourcePlatform.value;
  const before = news.sources.length;
  const next = { ...news, sources: [...news.sources, { platform, target, label: els.sourceLabel.value.trim() }] };
  save(next).then(() => {
    if (!els) return;
    // Main dropped it: the target does not fit the platform.
    if (news.sources.length === before) {
      setStatus(els.status, t(`mc.news.badSource.${platform}`), true);
      return;
    }
    els.sourceTarget.value = '';
    els.sourceLabel.value = '';
  });
}

function addTopics(e) {
  e.preventDefault();
  const platforms = els.topicPlatforms.filter((b) => b.checked).map((b) => b.value);
  const queries = els.topicInput.value
    .split(/[,\n]/)
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, MAX_TOPICS_PER_ADD);
  if (!queries.length) return;
  if (!platforms.length) {
    setStatus(els.status, t('mc.news.noPlatform'), true);
    return;
  }
  save({ ...news, topics: [...news.topics, ...queries.map((query) => ({ query, platforms }))] }).then(() => {
    if (els) els.topicInput.value = '';
  });
}

// ---- Setup / status ----------------------------------------------------------

function renderStatus() {
  if (!els) return;
  const ready = Boolean(status && status.ready);
  els.setup.hidden = !status || ready;
  els.picker.hidden = !ready;
  if (status && !ready) setStatus(els.status, t(status.installed ? 'mc.news.broken' : 'mc.news.notSetup'));
}

async function loadStatus() {
  const res = await window.lunacore.missionNewsStatus().catch(ipcFailed);
  status = res.ok ? res.status : { ready: false, installed: false };
  renderStatus();
  if (els && status.ready && !result) setStatus(els.status, t('mc.news.ready', { version: status.agentReach }));
}

async function setup() {
  els.setup.disabled = true;
  setStatus(els.status, t('mc.news.installing'));
  const res = await window.lunacore.missionNewsSetup().catch(ipcFailed);
  if (res.ok) status = res.status;
  if (!els) return;
  els.setup.disabled = false;
  if (!res.ok) setStatus(els.status, errorText(res.reason), true);
  else if (status.ready) setStatus(els.status, t('mc.news.ready', { version: status.agentReach }));
  renderStatus();
}

// ---- Scan + results ------------------------------------------------------------

function renderScanButton() {
  if (!els) return;
  els.scan.disabled = scanning || picked.size === 0;
  els.scan.textContent = picked.size ? t('mc.news.scanN', { n: picked.size }) : t('mc.news.scan');
}

async function scan(sourceIds, topicIds) {
  if (scanning || (!sourceIds.length && !topicIds.length)) return;
  scanning = true;
  renderScanButton();
  setStatus(els.status, t('mc.news.scanning'));
  const lang = (window.i18n && window.i18n.lang) || 'pl';
  const res = await window.lunacore.missionNewsScan({ sourceIds, topicIds, lang }).catch(ipcFailed);
  scanning = false;
  // A failed summary still carries the fetched sections - show those.
  if (res.ok || res.sections) result = res;
  if (!els) return;
  renderScanButton();
  if (!res.ok) setStatus(els.status, errorText(res.reason) + costSuffix(res.costUsd), true);
  else setStatus(els.status, t('mc.news.done') + costSuffix(res.costUsd));
  renderResults();
}

function entryButton(entry, isPick) {
  const b = button(`mc-tele__item${isPick ? ' mc-news__pickitem' : ''}`, '', () => window.lunacore.missionNewsOpen(entry.key));
  b.append(el('span', 'mc-tele__itemtitle', entry.title));
  if (entry.published) b.append(el('span', 'mc-row__note', entry.published));
  return b;
}

function sectionError(code) {
  const key = `mc.news.err.${code}`;
  const text = t(key);
  return text === key ? t('mc.news.err.fetch-failed') : text;
}

function renderSection(s) {
  const box = el('section', 'mc-bucket mc-news__section');
  box.append(el('h4', 'mc-bucket__title', `${s.label} · ${platformName(s.platform)}`));
  if (!s.ok) {
    box.append(el('p', 'hint is-fail', sectionError(s.error)));
    return box;
  }
  if (s.summary) box.append(el('p', 'mc-summary', s.summary));
  const pickSet = new Set(s.picks);
  for (const e of s.entries.filter((x) => pickSet.has(x.key))) box.append(entryButton(e, true));
  const rest = s.entries.filter((x) => !pickSet.has(x.key));
  if (rest.length) {
    const more = el('details', 'mc-news__more');
    more.append(el('summary', '', t('mc.news.more', { n: rest.length })), ...rest.map((e) => entryButton(e, false)));
    box.append(more);
  }
  if (!s.entries.length) box.append(el('p', 'hint', t('mc.news.empty')));
  return box;
}

function renderResults() {
  if (!els) return;
  if (!result) {
    els.results.replaceChildren();
    return;
  }
  const parts = [];
  if (result.briefing && result.briefing.length) {
    const brief = el('section', 'mc-bucket mc-news__briefing');
    const list = el('ul', 'mc-news__bullets');
    list.append(...result.briefing.map((b) => el('li', '', b)));
    brief.append(el('h4', 'mc-bucket__title', t('mc.news.briefing')), list);
    parts.push(brief);
  }
  parts.push(...(result.sections || []).map(renderSection));
  els.results.replaceChildren(...parts);
}

function buildPlatformPickers(root) {
  root.querySelector('#mc-news-src-platform').replaceChildren(
    ...SOURCE_PLATFORMS.map((p) => {
      const opt = el('option', '', platformName(p));
      opt.value = p;
      return opt;
    })
  );
  const boxes = TOPIC_PLATFORMS.map((p) => {
    const label = el('label', 'mc-news__tp');
    const box = el('input');
    box.type = 'checkbox';
    box.value = p;
    box.checked = p !== 'bilibili';
    label.append(box, el('span', '', platformName(p)));
    return label;
  });
  root.querySelector('#mc-news-tp').replaceChildren(...boxes);
  return boxes.map((l) => l.querySelector('input'));
}

defineWidget({
  id: 'missionnews',
  titleKey: 'mc.news.title',
  template: 'w-missionnews',
  mount(root) {
    const q = (sel) => root.querySelector(sel);
    els = {
      status: q('#mc-news-status'),
      setup: q('#mc-news-setup'),
      picker: q('#mc-news-picker'),
      sources: q('#mc-news-sources'),
      topics: q('#mc-news-topics'),
      sourcesEmpty: q('#mc-news-sources-empty'),
      topicsEmpty: q('#mc-news-topics-empty'),
      sourcePlatform: q('#mc-news-src-platform'),
      sourceTarget: q('#mc-news-src-target'),
      sourceLabel: q('#mc-news-src-label'),
      topicInput: q('#mc-news-topic-input'),
      scan: q('#mc-news-scan'),
      results: q('#mc-news-results'),
    };
    els.topicPlatforms = buildPlatformPickers(root);
    q('#mc-news-addsource').addEventListener('submit', addSource);
    q('#mc-news-addtopic').addEventListener('submit', addTopics);
    els.setup.addEventListener('click', setup);
    els.scan.addEventListener('click', () => {
      const sourceIds = news.sources.filter((s) => picked.has(s.id)).map((s) => s.id);
      const topicIds = news.topics.filter((tp) => picked.has(tp.id)).map((tp) => tp.id);
      scan(sourceIds, topicIds);
    });
    const offLang = onLangChange(() => {
      renderLists();
      renderResults();
    });
    window.lunacore
      .missionNewsConfig()
      .then((saved) => {
        news = saved;
        renderLists();
      })
      .catch((err) => console.error('[mission] news config:', err && err.message));
    renderLists();
    renderResults();
    renderStatus();
    loadStatus();
    return () => {
      offLang();
      els = null;
    };
  },
});
