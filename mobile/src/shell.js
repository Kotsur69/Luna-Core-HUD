// ============================================================================
// LunaCore phone - app shell: top bar, slide-out nav, toast
// ----------------------------------------------------------------------------
// A section not built yet stays in the menu, disabled and marked "soon". The
// page is picked from the URL hash (#today, #mission, #todos, #life, #body,
// #repos, #godmode, #pair)
// so a home-screen reload keeps it. The sync button carries a badge while
// writes wait to be sent (phase 4d), and iOS Safari outside the home screen
// gets a one-time "Add to Home Screen" hint.
// ============================================================================

import { h, icon, ICONS } from './dom.js';
import { t, tf } from './i18n.js';

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
  { id: 'pair', label: 'navPair', icon: ICONS.key, ready: true },
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
 * @returns {{main: HTMLElement, toast: (msg: string, bad?: boolean) => void, setPage: (id: string) => void, setPending: (n: number) => void}}
 */
export function mountShell(root, { who, current, onNavigate, onSync, onLogout }) {
  const menuBtn = h('button', { class: 'icon-btn', 'aria-label': t('menu'), 'aria-expanded': 'false', 'aria-controls': 'drawer' }, icon(ICONS.menu));
  const badge = h('span', { class: 'badge', hidden: true, 'aria-hidden': 'true' });
  const syncBtn = h('button', { class: 'icon-btn has-badge', 'aria-label': t('sync') }, icon(ICONS.sync), badge);
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

  const hint = installHint();
  root.replaceChildren(...[h('header', { class: 'topbar' }, menuBtn, title, syncBtn), hint, main, scrim, drawer, toastEl].filter(Boolean));

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

  /** Shows how many writes wait to be sent (0 hides the badge). */
  function setPending(n) {
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    syncBtn.setAttribute('aria-label', n ? `${t('sync')} (${tf('pendingLabel', { n })})` : t('sync'));
  }

  return { main, toast, setPage, setPending };
}
