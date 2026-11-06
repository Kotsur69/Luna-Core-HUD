// ============================================================================
// LunaCore phone - app shell: top bar, slide-out nav, toast
// ----------------------------------------------------------------------------
// A section not built yet stays in the menu, disabled and marked "soon". The
// page is picked from the URL hash (#today, #mission, #todos, #life, #body,
// #repos, #godmode, #lunaswork, #host, #pair)
// so a home-screen reload keeps it. The sync button carries a badge while
// writes wait to be sent (phase 4d), and iOS Safari outside the home screen
// gets a one-time "Add to Home Screen" hint.
// ============================================================================

import { h, icon, ICONS } from './dom.js';
import { t, tf } from './i18n.js';
import { chatHash, chatRoute, sessionLight } from './hostmodel.js';

const HINT_KEY = 'lunacore.installHint.dismissed';

/** iOS Safari in a tab, not the installed app. iPadOS reports itself as a Mac with touch. */
function needsInstallHint() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  try {
    return ios && !installed && localStorage.getItem(HINT_KEY) !== '1';
  } catch {
    return ios && !installed;
  }
}

function installHint() {
  if (!needsInstallHint()) return null;
  const el = h(
    'div',
    { class: 'install-hint', role: 'note' },
    h('span', {}, t('installHint')),
    h(
      'button',
      {
        class: 'icon-btn',
        'aria-label': t('dismiss'),
        onclick: () => {
          el.remove();
          try {
            localStorage.setItem(HINT_KEY, '1');
          } catch {
            // Private mode: the hint comes back next time.
          }
        },
      },
      icon(ICONS.close),
    ),
  );
  return el;
}

const NAV = [
  { id: 'today', label: 'navToday', icon: ICONS.sun, ready: true },
  { id: 'mission', label: 'navMission', icon: ICONS.radar, ready: true },
  { id: 'todos', label: 'navTodos', icon: ICONS.list, ready: true },
  { id: 'life', label: 'navLife', icon: ICONS.wallet, ready: true },
  { id: 'body', label: 'navBody', icon: ICONS.activity, ready: true },
  { id: 'repos', label: 'navRepos', icon: ICONS.branch, ready: true },
  { id: 'godmode', label: 'navGodmode', icon: ICONS.zap, ready: true },
  { id: 'lunaswork', label: 'navLunasWork', icon: ICONS.compass, ready: true },
  { id: 'host', label: 'navHost', icon: ICONS.terminal, ready: true },
  { id: 'pair', label: 'navPair', icon: ICONS.key, ready: true },
];
const TOAST_MS = 3500;

/** The page named by the URL hash ('chat' for #chat/<host>/<id>), or the to-do list. */
export function pageFromHash(hash = location.hash) {
  if (chatRoute(hash)) return 'chat';
  const id = hash.replace(/^#/, '');
  return NAV.some((n) => n.ready && n.id === id) ? id : 'todos';
}

/**
 * @param {HTMLElement} root
 * @param {{who: string, current: string, onNavigate: (id: string) => void, onSync: () => Promise<void>, onLogout: () => void}} opts
 * @returns {{main: HTMLElement, toast: (msg: string, bad?: boolean) => void, setPage: (id: string) => void, setPending: (n: number) => void}}
 */
export function mountShell(root, { who, current, onNavigate, onSync, onLogout, onDrawerOpen = () => {} }) {
  const menuBtn = h('button', { class: 'icon-btn', 'aria-label': t('menu'), 'aria-expanded': 'false', 'aria-controls': 'drawer' }, icon(ICONS.menu));
  const backBtn = h('button', { class: 'icon-btn', 'aria-label': t('chatBack'), hidden: true, onclick: () => onNavigate('host') }, icon(ICONS.back));
  const badge = h('span', { class: 'badge', hidden: true, 'aria-hidden': 'true' });
  const syncBtn = h('button', { class: 'icon-btn has-badge', 'aria-label': t('sync') }, icon(ICONS.sync), badge);
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': t('closeMenu') }, icon(ICONS.close));

  const titleMain = h('span', { class: 'title-main' });
  const titleSub = h('span', { class: 'title-sub', hidden: true });
  const titleLight = h('span', { class: 'light', hidden: true, 'aria-hidden': 'true' }, '●');
  const title = h('h1', {}, h('span', { class: 'title-row' }, titleLight, titleMain), titleSub);
  const items = new Map();
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': t('menu') },
    NAV.map((n) => {
      const item = h(
        'button',
        {
          class: 'nav-item',
          disabled: !n.ready,
          onclick: () => {
            openDrawer(false);
            onNavigate(n.id);
          },
        },
        icon(n.icon),
        t(n.label),
        n.ready ? null : h('span', { class: 'soon' }, t('soon')),
      );
      items.set(n.id, item);
      return item;
    }),
  );

  // Live + last-24 h host sessions (hostmodel.menuSessions), filled by setSessions().
  const sessionsList = h('div', { class: 'nav' });
  const sessionsNav = h('nav', { class: 'nav-sessions', 'aria-label': t('hostSessions'), hidden: true }, h('div', { class: 'nav-label' }, t('hostSessions')), sessionsList);

  const drawer = h(
    'aside',
    { class: 'drawer', id: 'drawer', 'aria-label': t('menu') },
    h('div', { class: 'drawer-head' }, 'LUNACORE', closeBtn),
    nav,
    sessionsNav,
    h('div', { class: 'drawer-foot' }, h('div', { class: 'who' }, who), h('button', { class: 'btn btn-ghost', onclick: onLogout }, icon(ICONS.logout), t('logout'))),
  );
  drawer.inert = true;

  function openDrawer(open) {
    document.body.classList.toggle('drawer-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    drawer.inert = !open;
    (open ? closeBtn : menuBtn).focus();
    if (open) onDrawerOpen();
  }

  menuBtn.addEventListener('click', () => openDrawer(true));
  closeBtn.addEventListener('click', () => openDrawer(false));
  syncBtn.addEventListener('click', async () => {
    if (syncBtn.getAttribute('aria-busy') === 'true') return;
    syncBtn.setAttribute('aria-busy', 'true');
    try {
      await onSync();
    } finally {
      syncBtn.removeAttribute('aria-busy');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) openDrawer(false);
  });

  const scrim = h('div', { class: 'scrim', onclick: () => openDrawer(false) });
  const main = h('main', { id: 'main' });
  const toastEl = h('div', { class: 'toast', role: 'status', hidden: true });
  let toastTimer = 0;

  const hint = installHint();
  root.replaceChildren(...[h('header', { class: 'topbar' }, backBtn, menuBtn, title, syncBtn), hint, main, scrim, drawer, toastEl].filter(Boolean));

  function toast(msg, bad = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('is-bad', bad);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, TOAST_MS);
  }

  /** The top bar title; a chat page adds a status light and a second line. */
  function setHeader({ title: main, sub = '', light = '' }) {
    titleMain.textContent = main;
    titleSub.textContent = sub;
    titleSub.hidden = !sub;
    titleLight.className = `light ${light}`;
    titleLight.hidden = !light;
  }

  let sessionRows = [];
  /** Marks the open chat in the menu's session list. */
  function markSession() {
    const route = chatRoute(location.hash);
    for (const { el, s } of sessionRows) {
      if (route && route.sessionId === s.sessionId) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
  }

  /** Marks `id` as the current page in the title and the menu. */
  function setPage(id) {
    const page = NAV.find((n) => n.id === id);
    const chat = id === 'chat';
    document.body.classList.toggle('page-chat', chat);
    backBtn.hidden = !chat;
    setHeader({ title: chat ? '' : t(page.label) });
    for (const [key, item] of items) {
      if (key === id) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    markSession();
  }
  setPage(current);

  /**
   * The menu's sessions (hostmodel.menuSessions):
   * [{sessionId, host, status, live, at, label}]. Empty hides the section.
   */
  function setSessions(list) {
    sessionRows = list.map((s) => {
      const name = s.label || s.host;
      const state = t(s.live ? `hostStatus_${s.status}` : 'chatEnded') || s.status;
      const el = h(
        'a',
        { class: 'nav-item nav-session', href: chatHash(s.host, s.sessionId), onclick: () => openDrawer(false) },
        h('span', { class: `light ${sessionLight(s)}`, 'aria-hidden': 'true' }, '●'),
        h('span', { class: 'nav-session-text' }, h('span', { class: 'nav-session-name' }, name), h('span', { class: 'nav-session-sub' }, s.label ? `${s.host} · ${state}` : state)),
      );
      return { el, s };
    });
    sessionsList.replaceChildren(...sessionRows.map((r) => r.el));
    sessionsNav.hidden = !sessionRows.length;
    markSession();
  }

  /** Shows how many writes wait to be sent (0 hides the badge). */
  function setPending(n) {
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    syncBtn.setAttribute('aria-label', n ? `${t('sync')} (${tf('pendingLabel', { n })})` : t('sync'));
  }

  return { main, toast, setPage, setPending, setSessions, setHeader };
}
