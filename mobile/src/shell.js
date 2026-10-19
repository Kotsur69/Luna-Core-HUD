// ============================================================================
// LunaCore phone - app shell: top bar, slide-out nav, toast
// ----------------------------------------------------------------------------
// Sections not built yet stay in the menu, disabled and marked "soon", so the
// phone shows where Mission and Life will live (plan phase 4b / 4c).
// ============================================================================

import { h, icon, ICONS } from './dom.js';
import { t } from './i18n.js';

const NAV = [
  { id: 'mission', label: 'navMission', icon: ICONS.radar, ready: false },
  { id: 'todos', label: 'navTodos', icon: ICONS.list, ready: true },
  { id: 'life', label: 'navLife', icon: ICONS.wallet, ready: false },
];
const TOAST_MS = 3500;

/**
 * @param {HTMLElement} root
 * @param {{who: string, current: string, onSync: () => Promise<void>, onLogout: () => void}} opts
 * @returns {{main: HTMLElement, toast: (msg: string, bad?: boolean) => void}}
 */
export function mountShell(root, { who, current, onSync, onLogout }) {
  const menuBtn = h('button', { class: 'icon-btn', 'aria-label': t('menu'), 'aria-expanded': 'false', 'aria-controls': 'drawer' }, icon(ICONS.menu));
  const syncBtn = h('button', { class: 'icon-btn', 'aria-label': t('sync') }, icon(ICONS.sync));
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': t('closeMenu') }, icon(ICONS.close));

  const page = NAV.find((n) => n.id === current);
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': t('menu') },
    NAV.map((n) =>
      h(
        'button',
        { class: 'nav-item', disabled: !n.ready, 'aria-current': n.id === current ? 'page' : null, onclick: () => openDrawer(false) },
        icon(n.icon),
        t(n.label),
        n.ready ? null : h('span', { class: 'soon' }, t('soon')),
      ),
    ),
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

  root.replaceChildren(h('header', { class: 'topbar' }, menuBtn, h('h1', {}, t(page.label)), syncBtn), main, scrim, drawer, toastEl);

  function toast(msg, bad = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('is-bad', bad);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, TOAST_MS);
  }

  return { main, toast };
}
