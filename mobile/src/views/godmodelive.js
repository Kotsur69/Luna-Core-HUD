// ============================================================================
// LunaCore phone - God Mode: the run going on right now
// ----------------------------------------------------------------------------
// A PC publishes `live` + `tabs` in its `godmode` snapshot while a run goes
// (godmodelivepub.js, at least every minute). This draws, on top of the
// God Mode page: counters, a "paused until" banner, the packages grouped by
// state with the HUD's tab-light glyphs, and every PC's tab lights. A
// snapshot older than LIVE_STALE_MS gets a 'stale' badge - the PC may be
// asleep or offline. Today shows the short card while the run is going.
// Every string goes in as text; PR links are github.com only (the reader
// already dropped anything else).
// ============================================================================

import { h, icon, ICONS } from '../dom.js';
import { t, tf, locale } from '../i18n.js';
import { godmodeLiveFrom, godmodeTabsFrom, godmodeLiveCounts } from '../snapmodel.js';
import { when } from './snapshotview.js';

/** A finished (settled / killed) live run stays on top this long, then the history has it. */
const FINISHED_SHOWN_MS = 6 * 60 * 60 * 1000;
const PR_PREFIX = 'https://github.com/';
const MINUTE = 60 * 1000;

/** The HUD's tab-light glyphs (src/renderer/modules/sessions.js), plus 'failed'. */
const GLYPH = { working: '●', done: '✓', approval: '!', limit: '◷', idle: '○', dead: '–', failed: '✕' };

/** Which light a package state shows. */
const PKG_LIGHT = { queued: 'idle', launched: 'working', working: 'working', verifying: 'working', approval: 'approval', pushed: 'done', failed: 'failed', killed: 'dead' };

/** Groups top to bottom: what needs Mati first. */
const GROUPS = [
  { key: 'godmodeGroupApproval', states: ['approval'] },
  { key: 'godmodeGroupFailed', states: ['failed'] },
  { key: 'godmodeGroupWorking', states: ['working', 'launched', 'verifying'] },
  { key: 'godmodeGroupQueued', states: ['queued'] },
  { key: 'godmodeGroupPushed', states: ['pushed'] },
  { key: 'godmodeGroupKilled', states: ['killed'] },
];

const PKG_STATE_KEY = {
  queued: 'godmodePkgQueued',
  launched: 'godmodePkgLaunched',
  working: 'godmodePkgWorking',
  approval: 'godmodePkgApproval',
  verifying: 'godmodePkgVerifying',
  pushed: 'godmodePkgPushed',
  failed: 'godmodePkgFailed',
  killed: 'godmodePkgKilled',
};

const RUN_STATE_KEY = { running: 'godmodeStateRunning', paused: 'godmodeStatePaused', settled: 'godmodeStateSettled', killed: 'godmodeStateKilled' };

const TAB_STATE_KEY = { working: 'tabWorking', done: 'tabDone', idle: 'tabIdle', approval: 'tabApproval', limit: 'tabLimit', dead: 'tabDead' };

const hhmm = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
const isGoing = (live) => live.state === 'running' || live.state === 'paused';

/** How often a shown page redraws what it holds: elapsed times and the 'stale' badge follow the clock. */
const REPAINT_MS = 30 * 1000;

/**
 * Redraws `view` every REPAINT_MS while `node` is on screen. Realtime brings
 * every new put; this only lets a PC that went quiet turn 'stale'. Stops
 * once the page is left (main.js mounts each page into a fresh node).
 */
export function repaintWhileShown(node, view) {
  const timer = setInterval(() => {
    if (!node.isConnected) clearInterval(timer);
    else if (document.visibilityState === 'visible') view.repaint();
  }, REPAINT_MS);
}

/** The live run worth showing: going, or finished in the last few hours. */
export function liveToShow(rows, now) {
  const live = godmodeLiveFrom(rows, now);
  if (!live) return null;
  return isGoing(live) || now - live.at < FINISHED_SHOWN_MS ? live : null;
}

function light(state, label) {
  return h('span', { class: `light is-${state}`, role: 'img', 'aria-label': label, title: label }, GLYPH[state] || GLYPH.idle);
}

function elapsedText(ms) {
  const min = Math.floor(ms / MINUTE);
  return min >= 60 ? tf('godmodeElapsedH', { h: Math.floor(min / 60), min: min % 60 }) : tf('godmodeElapsed', { min });
}

function staleBadge(live) {
  return live.stale ? h('span', { class: 'tag is-warn', title: tf('godmodeStaleHint', { time: hhmm(live.at) }) }, t('godmodeStale')) : null;
}

function pausedBanner(live) {
  if (live.state !== 'paused' || !live.pausedUntil) return null;
  return h('p', { class: 'banner is-warn', role: 'status' }, tf('godmodePausedUntil', { time: hhmm(live.pausedUntil) }));
}

/** pushed / working / waiting for you / pending / failed, as tiles. */
function counters(live) {
  const c = godmodeLiveCounts(live);
  const tile = (n, key, tone) => h('li', { class: `counter ${n && tone ? tone : ''}`.trim() }, h('span', { class: 'counter-n num' }, String(n)), h('span', { class: 'hint' }, t(key)));
  return h(
    'ul',
    { class: 'counters' },
    tile(c.pushed, 'godmodeCountPushed', 'is-good'),
    tile(c.working, 'godmodeCountWorking', ''),
    tile(c.waiting, 'godmodeCountWaiting', 'is-warn'),
    tile(c.pending, 'godmodeCountPending', ''),
    tile(c.failed, 'godmodeCountFailed', 'is-bad'),
  );
}

function prLink(url) {
  if (typeof url !== 'string' || !url.startsWith(PR_PREFIX)) return null;
  return h(
    'a',
    { class: 'link-row', href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${t('godmodePr')} (${tf('opensSite', { host: 'github.com' })})` },
    h('span', { class: 'grow' }, t('godmodePr')),
    icon(ICONS.external),
  );
}

function packageRow(p) {
  const stateLabel = t(PKG_STATE_KEY[p.state] || 'godmodePkgQueued');
  const meta = [
    stateLabel,
    p.elapsedMs !== null ? elapsedText(p.elapsedMs) : '',
    p.sha7 || '',
    p.dependsOn.length ? tf('godmodeAfter', { ids: p.dependsOn.join(', ') }) : '',
  ].filter(Boolean);
  const why = [p.error, p.detail].filter(Boolean).join(' - ');
  return h(
    'li',
    { class: 'row-col' },
    h('div', { class: 'row' }, light(PKG_LIGHT[p.state] || 'idle', stateLabel), h('span', { class: 'grow' }, p.title || p.id)),
    h('span', { class: 'hint num' }, meta.join(' · ')),
    why ? h('span', { class: `hint ${p.state === 'approval' ? 'is-warn' : 'is-bad'}` }, why) : null,
    p.todos.length ? h('ul', { class: 'todo-list' }, p.todos.map((x) => h('li', { class: 'hint' }, x))) : null,
    prLink(p.prUrl),
  );
}

function groups(live) {
  return GROUPS.map(({ key, states }) => {
    const pkgs = live.packages.filter((p) => states.includes(p.state));
    if (!pkgs.length) return null;
    return h('div', { class: 'stack-sm' }, h('h3', { class: 'group-title' }, `${t(key)} (${pkgs.length})`), h('ul', { class: 'rows' }, pkgs.map(packageRow)));
  });
}

function optionTags(live) {
  const tags = [live.options.sleepOnLimit ? t('godmodeSleepOnLimit') : '', live.options.shutdownWhenDone ? t('godmodeShutdown') : ''].filter(Boolean);
  return tags.length ? h('div', { class: 'tags' }, tags.map((x) => h('span', { class: 'tag' }, x))) : null;
}

function runTone(state) {
  if (state === 'killed') return 'tag is-bad';
  if (state === 'paused') return 'tag is-warn';
  return state === 'settled' ? 'tag is-good' : 'tag';
}

/** The full live card on the God Mode page. */
export function liveCard(live, now) {
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'godmode-live' },
    h(
      'div',
      { class: 'row' },
      h('h2', { class: 'section-title grow', id: 'godmode-live' }, `${t('godmodeLive')} · ${live.title || live.id}`),
      staleBadge(live),
      h('span', { class: runTone(live.state) }, t(RUN_STATE_KEY[live.state])),
    ),
    h('span', { class: 'hint' }, [live.machine, live.baseBranch, tf('godmodeStarted', { time: when(live.startedAt, now) }), tf('godmodeReported', { time: hhmm(live.at) })].filter(Boolean).join(' · ')),
    pausedBanner(live),
    optionTags(live),
    counters(live),
    live.packages.length ? groups(live) : h('p', { class: 'hint' }, t('godmodeNoPackages')),
  );
}

/** Every PC's terminal tab lights, or null when no PC sent any. */
export function tabsCard(rows, now) {
  const pcs = godmodeTabsFrom(rows, now);
  if (!pcs.length) return null;
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'godmode-tabs' },
    h('h2', { class: 'section-title', id: 'godmode-tabs' }, t('godmodeTabs')),
    pcs.map((pc) =>
      h(
        'div',
        { class: 'stack-sm' },
        h('div', { class: 'row' }, h('span', { class: 'hint grow' }, tf('godmodeReportedBy', { machine: pc.machine, time: hhmm(pc.at) })), pc.stale ? h('span', { class: 'tag is-warn' }, t('godmodeStale')) : null),
        h(
          'ul',
          { class: 'rows' },
          pc.tabs.map((tab) => {
            const label = t(TAB_STATE_KEY[tab.state] || 'tabIdle');
            return h('li', { class: 'row' }, light(tab.state, label), h('span', { class: 'grow' }, [tab.folder, tab.profile].filter(Boolean).join(' · ')), h('span', { class: 'hint' }, label));
          }),
        ),
      ),
    ),
  );
}

/** Today's card while a run is going: title, counters line, pause banner, stale badge. Null otherwise. */
export function liveTodayCard(rows, now) {
  const live = godmodeLiveFrom(rows, now);
  if (!live || !isGoing(live)) return null;
  const c = godmodeLiveCounts(live);
  const line = [
    tf('godmodePushed', { n: c.pushed, total: live.packages.length }),
    c.working ? `${c.working} ${t('godmodeCountWorking')}` : '',
    c.waiting ? `${c.waiting} ${t('godmodeCountWaiting')}` : '',
    c.failed ? `${c.failed} ${t('godmodeCountFailed')}` : '',
  ].filter(Boolean);
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'today-godmode' },
    h('div', { class: 'row' }, h('h2', { class: 'section-title grow', id: 'today-godmode' }, t('godmodeLive')), staleBadge(live), h('span', { class: runTone(live.state) }, t(RUN_STATE_KEY[live.state]))),
    pausedBanner(live),
    h(
      'a',
      { class: 'link-row', href: '#godmode' },
      h('span', { class: 'grow' }, h('span', { class: 'link-title' }, live.title || live.id), h('span', { class: `hint ${c.waiting ? 'is-warn' : ''}`.trim() }, line.join(' · '))),
      h('span', { class: 'hint num' }, when(live.startedAt, now)),
    ),
  );
}
