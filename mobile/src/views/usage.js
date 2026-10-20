// ============================================================================
// LunaCore phone - Claude usage limits card (REMOTE_HOST_PLAN U1)
// ----------------------------------------------------------------------------
// The newest PC's `usage` snapshot: two bars (5 h + weekly) with reset
// countdowns. Shown on Today and in the Mission -> Claude tab. All PCs share
// one account, so one row is the whole picture; "from" names the PC.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { usageFrom } from '../snapmodel.js';
import { when } from './snapshotview.js';

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
/** Bar colours: the same thresholds the PC's voice warnings and H4's pushes use. */
const WARN_PCT = 80;
const BAD_PCT = 95;

/** "2 h 14 min", "3 d 4 h", "5 min" - the two largest units. */
function left(ms) {
  const m = Math.max(1, Math.ceil(ms / MIN_MS));
  if (m < 60) return `${m} min`;
  if (ms < DAY_MS) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(ms / DAY_MS)} d ${Math.floor((ms % DAY_MS) / HOUR_MS)} h`;
}

function bar(label, w, now) {
  if (!w) return null;
  const tone = w.pct >= BAD_PCT ? 'meter is-bad' : w.pct >= WARN_PCT ? 'meter is-warn' : 'meter';
  const fill = h('span');
  // The CSP (style-src 'self') blocks style attributes, so the size goes through the CSSOM.
  fill.style.transform = `scaleX(${w.pct / 100})`;
  const reset = w.isReset ? t('usageWasReset') : w.resetsAt ? tf('usageResetsIn', { left: left(w.resetsAt - now) }) : null;
  return h(
    'li',
    { class: 'row-col' },
    h('div', { class: 'row' }, h('span', { class: 'grow' }, label), h('span', { class: 'num' }, `${w.pct}%`)),
    h('div', { class: tone, role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(w.pct) }, fill),
    reset ? h('span', { class: 'hint' }, reset) : null,
  );
}

/** The card for the `usage` rows (snapRows output). */
export function usageCard(rows, now) {
  const u = usageFrom(rows, now);
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'usage-title' },
    h('h2', { class: 'section-title', id: 'usage-title' }, t('usageTitle')),
    u
      ? [h('ul', { class: 'rows' }, bar(t('usage5h'), u.fiveHour, now), bar(t('usageWeek'), u.sevenDay, now)), h('p', { class: 'hint' }, tf('fromAt', { time: when(u.at, now), machine: u.machine }))]
      : h('p', { class: 'hint' }, t('usageEmpty')),
  );
}
