// ============================================================================
// LunaCore - attention inbox: the '!' chip and its overlay (renderer)
// ----------------------------------------------------------------------------
// The chip sits next to Ctrl+Shift+M with a red count badge (hidden at 0).
// Launch only refreshes the badge - nothing opens by itself. The list comes
// from main (src/inbox.js via inbox:list) as plain items:
//   godmode  -> the God Mode run summary window (godmodesummary.js)
//   checkin  -> Ctrl+Shift+N on the Health tab
//   goals    -> Ctrl+Shift+N on the Week tab
//   gmail    -> Settings, scrolled to the report-email section
// The badge refreshes on launch, every few minutes, when the window gets
// focus, and when the check-in or goals change. textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { createTallOverlay } from './talloverlay.js';
import { openRunSummary } from './godmodesummary.js';
import { openLifeTab } from './lifepanel.js';
import { onDaily } from './lifedaily.js';
import { openSettingsAt } from './termcustom.js';

const REFRESH_MS = 5 * 60 * 1000;

let overlay = null;
let items = [];
let failed = false;
let badgeEl = null;
let chipEl = null;

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(() => ({ ok: false, reason: 'ipc' }));

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function paintBadge() {
  if (!badgeEl) return;
  badgeEl.textContent = String(items.length);
  badgeEl.hidden = items.length === 0;
  if (chipEl) chipEl.setAttribute('aria-label', items.length ? t('inbox.chip.count', { n: items.length }) : t('inbox.chip.title'));
}

async function refresh() {
  const res = await call('inboxList');
  failed = !(res && res.ok && Array.isArray(res.items));
  if (!failed) items = res.items;
  paintBadge();
  if (overlay && overlay.isOpen()) renderList();
}

function row(glyph, title, sub, onClick) {
  const b = el('button', 'inbox__item');
  b.type = 'button';
  const text = el('span', 'inbox__text');
  text.append(el('span', 'inbox__title', title), el('span', 'inbox__sub', sub));
  b.append(el('span', 'inbox__glyph', glyph), text);
  b.addEventListener('click', onClick);
  return b;
}

/** Closes the inbox, then opens a Life tab (it would sit under the inbox otherwise). */
function goLife(tab) {
  overlay.close();
  openLifeTab(tab);
}

function itemRow(item) {
  if (item.kind === 'godmode') {
    const sub = [item.machine, when(item.finishedAt), item.needs ? t('inbox.gm.needs', { n: item.needs }) : t('inbox.gm.noNeeds')].join(' · ');
    return row('⚡', t('inbox.gm.title', { repo: item.repoName || '-' }), sub, () => openRunSummary(item.machine, item.id, { onClose: refresh }));
  }
  if (item.kind === 'checkin') return row('☾', t('inbox.checkin.title'), t('inbox.checkin.sub'), () => goLife('health'));
  if (item.kind === 'goals') return row('◎', t('inbox.goals.title'), t('inbox.goals.sub', { week: item.week }), () => goLife('week'));
  if (item.kind === 'gmail') {
    return row('✉', t('inbox.gmail.title'), t(item.configured ? 'inbox.gmail.sub' : 'inbox.gmail.noClient'), () => {
      overlay.close();
      openSettingsAt('mail-section');
    });
  }
  return null;
}

function renderList() {
  const rows = items.map(itemRow).filter(Boolean);
  if (rows.length) {
    const list = el('div', 'inbox__list');
    list.append(...rows);
    overlay.body.replaceChildren(list);
  } else {
    overlay.body.replaceChildren(el('p', 'hint inbox__empty', t(failed ? 'inbox.failed' : 'inbox.empty')));
  }
}

function open() {
  if (!overlay) overlay = createTallOverlay({ id: 'inbox', glyph: '!', titleKey: 'inbox.title' });
  renderList();
  overlay.open();
  refresh();
}

/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountInboxChip(root) {
  chipEl = root.querySelector('#inbox-open');
  badgeEl = root.querySelector('#inbox-count');
  if (!chipEl) return;
  chipEl.addEventListener('click', () => open());
  refresh();
  setInterval(refresh, REFRESH_MS);
  window.addEventListener('focus', () => refresh());
  onDaily((part) => {
    if (part === 'checkin' || part === 'goals') refresh();
  });
  onLangChange(() => {
    paintBadge();
    if (overlay && overlay.isOpen()) renderList();
  });
}
