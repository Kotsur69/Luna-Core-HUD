// ============================================================================
// LunaCore phone - shared loader for the read-only snapshot pages (phase 4c)
// ----------------------------------------------------------------------------
// The copy kept on this device renders first (instant, works offline) unless
// the network answer is already on screen. Kinds load independently: one
// failing kind keeps its cached rows instead of blanking the page. A refresh
// started earlier never paints over a newer one.
// ============================================================================

import { h } from '../dom.js';
import { t, locale } from '../i18n.js';
import { snapRows } from '../snapmodel.js';

/** "14:05" today; the short date in front on another day. */
export function when(ms, now = Date.now()) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @param {string[]} kinds snapshot kinds the page reads
 * @param {(byKind: Record<string, object[]>, now: number) => Node} render rows are parsed by snapmodel.js there
 * @returns {{refresh: () => Promise<void>, repaint: () => void}} repaint() redraws what is held (a clock moved), no pull
 */
export function mountSnapshots(main, { cloud, toast }, kinds, render) {
  let seq = 0;
  let fromNetwork = false;
  let shown = false;
  let lists = kinds.map(() => []);

  function paint() {
    const now = Date.now();
    const byKind = Object.fromEntries(kinds.map((k, i) => [k, snapRows(lists[i], now)]));
    main.replaceChildren(render(byKind, now));
    shown = true;
  }

  async function refresh() {
    const mine = ++seq;
    const got = await Promise.allSettled(kinds.map((k) => cloud.snapshots(k)));
    if (mine !== seq) return;
    const ok = got.filter((g) => g.status === 'fulfilled').length;
    if (ok) {
      lists = got.map((g, i) => (g.status === 'fulfilled' ? g.value : lists[i]));
      fromNetwork = true;
      paint();
    }
    if (ok < kinds.length) {
      toast(t('pullFailed'), true);
      if (!shown) main.replaceChildren(h('p', { class: 'hint is-bad' }, t('pullFailed')));
    }
  }

  main.replaceChildren(h('p', { class: 'hint' }, t('loading')));
  Promise.all(kinds.map((k) => cloud.cachedSnapshots(k))).then(
    (cached) => {
      if (fromNetwork || !cached.some((l) => l.length)) return;
      lists = cached;
      paint();
    },
    // No cached copy (storage blocked): the network answer is all there is.
    () => {},
  );
  return {
    refresh,
    repaint() {
      if (shown) paint();
    },
  };
}
