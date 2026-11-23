// ============================================================================
// LunaCore - the #orchestra board's Board | Live Web tabs
// ----------------------------------------------------------------------------
// Slice 3 of #agymap. The God Mode board (orchestra.js) gets a header tab
// strip (static markup in index.html: [data-orch-view], #orchestra-web);
// this module owns it, so orchestra.js only calls three hooks:
//   opened()   the overlay opened
//   refresh()  the board re-rendered (a push, an action's answer)
//   closed()   the overlay closed: the web stops (frame, feeds) and the next
//              open starts on the Board again
// The Live Web (liveWebView.js) is built on the first switch to it. Its
// "Show on board" switches back to the Board and highlights the card.
// Esc: a diff opened from the web closes first, then the web's selection;
// only then does the board's own Esc close the overlay.
// ============================================================================

'use strict';

import { createLiveWeb } from './liveWebView.js';
import { closeDiffModal } from './activefiles.js';

const VIEWS = ['board', 'web'];
// How long the located card stays highlighted (same as the live map's Show on board).
const LOCATE_HIGHLIGHT_MS = 2400;

/**
 * Wires the Board | Live Web tabs of the #orchestra overlay.
 * @param {{overlay: HTMLElement, getView: () => (object|null), getRunLabel: () => string,
 *   getProject: () => (string|null|undefined), onGoto: (sessionId: string) => void}} deps
 *   getProject: the board's run (a change resets the web's layout and selection)
 * @returns {{opened: () => void, refresh: () => void, closed: () => void}|null} null without the markup
 */
export function mountBoardWeb(deps) {
  const { overlay } = deps;
  const tabs = [...overlay.querySelectorAll('[data-orch-view]')];
  const body = overlay.querySelector('#orchestra-body');
  const host = overlay.querySelector('#orchestra-web');
  if (tabs.length !== VIEWS.length || !body || !host) return null;
  let current = 'board';
  let open = false;
  let web = null;
  // The run the web last showed: another one starts it fresh (no carried layout or selection).
  let shownProject;

  function syncProject() {
    const project = typeof deps.getProject === 'function' ? deps.getProject() : undefined;
    if (project === shownProject) return;
    shownProject = project;
    if (web) web.resetRun();
  }

  function ensureWeb() {
    if (!web) {
      web = createLiveWeb({
        bridge: window.lunacore,
        getView: deps.getView,
        getRunLabel: deps.getRunLabel,
        gotoWorker: deps.onGoto,
        showOnBoard: locate,
      });
      host.append(web.root);
    }
    return web;
  }

  function select(view, { focus = false } = {}) {
    if (!VIEWS.includes(view)) return;
    current = view;
    for (const tab of tabs) {
      const on = tab.dataset.orchView === view;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    body.hidden = view === 'web';
    host.hidden = view !== 'web';
    if (view === 'web' && open) {
      ensureWeb();
      syncProject();
      web.show();
      web.refresh();
    } else if (web) {
      web.hide();
    }
  }

  /** Back to the Board, scrolled to the package's card. */
  function locate(pkgId) {
    select('board');
    const card = [...body.querySelectorAll('.orchestra__pkg')].find((c) => {
      const idEl = c.querySelector('.orchestra__id');
      return idEl && idEl.textContent === pkgId;
    });
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    card.classList.add('is-located');
    setTimeout(() => card.classList.remove('is-located'), LOCATE_HIGHLIGHT_MS);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.orchView));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const i = VIEWS.indexOf(current);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? VIEWS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length;
      select(VIEWS[next], { focus: true });
    });
  }
  // Capture: ahead of the overlay's own Esc, which closes the board.
  overlay.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || current !== 'web') return;
      if (closeDiffModal() || (web && web.onKey(e))) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );

  return {
    opened() {
      open = true;
      if (current === 'web') select('web');
    },
    refresh() {
      if (!web || current !== 'web' || !open) return;
      // A run chip clicked on the board: a different run.
      syncProject();
      web.refresh();
    },
    closed() {
      open = false;
      select('board');
    },
  };
}
