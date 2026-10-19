// ============================================================================
// LunaCore phone - app shell: top bar, slide-out nav, toast
// ----------------------------------------------------------------------------
// Sections not built yet stay in the menu, disabled and marked "soon", so the
// phone shows where Mission will live (plan phase 4c). The page is picked
// from the URL hash (#todos, #life) so a home-screen reload keeps it.
// ============================================================================

import { h, icon, ICONS } from './dom.js';
import { t } from './i18n.js';

const NAV = [
  { id: 'mission', label: 'navMission', icon: ICONS.radar, ready: false },
  { id: 'todos', label: 'navTodos', icon: ICONS.list, ready: true },
  { id: 'life', label: 'navLife', icon: ICONS.wallet, ready: true },
];
const TOAST_MS = 3500;

/** The page named by the URL hash, or the first ready one. */
export function pageFromHash(hash = location.hash) {
  const id = hash.replace(/^#/, '');
  return NAV.some((n) => n.ready && n.id === id) ? id : 'todos';
}

/**
 * @param {HTMLElement} root
 * @param {{who: string, current: string, onNavigate: (id: string) => void, onSync: () => Promise<void>, onLogout: () => void}} opts
 * @returns {{main: HTMLElement, toast: (msg: string, bad?: boolean) => void, setPage: (id: string) => void}}
 */
export function mountShell(root, { who, current, onNavigate, onSync, onLogout }) {
  const menuBtn = h('button', { class: 'icon-btn', 'aria-label': t('menu'), 'aria-expanded': 'false', 'aria-controls': 'drawer' }, icon(ICONS.menu));
  const syncBtn = h('button', { class: 'icon-btn', 'aria-label': t('sync') }, icon(ICONS.sync));
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': t('closeMenu') }, icon(ICONS.close));

  const title = h('h1', {});
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

  const drawer = h(
    'aside',
    { class: 'drawer', id: 'drawer', 'aria-label': t('menu') },
    h('div', { class: 'drawer-head' }, 'LUNACORE', closeBtn),
    nav,
    h('div', { class: 'drawer-foot' }, h('div', { class: 'who' }, who), h('button', { class: 'btn btn-ghost', onclick: onLogout }, icon(ICONS.logout), t('logout'))),
  );
  drawer.inert = true;

  function openDrawer(open) {
    document.body.classList.toggle('drawer-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    drawer.inert = !open;
    (open ? closeBtn : menuBtn).focus();
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

  root.replaceChildren(h('header', { class: 'topbar' }, menuBtn, title, syncBtn), main, scrim, drawer, toastEl);

  function toast(msg, bad = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('is-bad', bad);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, TOAST_MS);
  }

  /** Marks `id` as the current page in the title and the menu. */
  function setPage(id) {
    const page = NAV.find((n) => n.id === id);
    title.textContent = t(page.label);
    for (const [key, item] of items) {
      if (key === id) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
  }
  setPage(current);

  return { main, toast, setPage };
}
