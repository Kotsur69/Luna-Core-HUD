// ============================================================================
// LunaCore phone - God Mode: the run going on right now
// ----------------------------------------------------------------------------
// A PC publishes `live` + `lives` + `tabs` in its `godmode` snapshot while a
// run goes (godmodelivepub.js, at least every minute) - `lives` holds one run
// per project, an older PC build only `live`. This draws, per run, on top of the
// God Mode page: counters, a "paused until" banner, the packages grouped by
// state with the HUD's tab-light glyphs, and every PC's tab lights. A
// snapshot older than LIVE_STALE_MS gets a 'stale' badge - the PC may be
// asleep or offline. Today shows the short card while the run is going.
// Every string goes in as text; PR links are github.com only (the reader
// already dropped anything else).
// ============================================================================

import { h, icon, ICONS } from '../dom.js';
import { t, tf, locale } from '../i18n.js';
import { godmodeLivesFrom, godmodeTabsFrom, godmodeLiveCounts } from '../snapmodel.js';
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

const worthShowing = (live, now) => isGoing(live) || now - live.at < FINISHED_SHOWN_MS;

/** Every live run worth showing: going, or finished in the last few hours (several projects can run at once). */
export function livesToShow(rows, now) {
  return godmodeLivesFrom(rows, now).filter((live) => worthShowing(live, now));
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

const RETRYABLE = new Set(['failed']);

/** Which controls a live run offers: Kill while going, Retry with a failed package, Finish once settled. */
export function liveActions(live) {
  return {
    kill: isGoing(live),
    retry: live.state !== 'killed' && live.packages.some((p) => RETRYABLE.has(p.state)),
    finish: live.state === 'settled',
  };
}

/**
 * Phone God Mode D: Kill / Retry failed / Finish on a live run, sent signed
 * to the PC that published it - only when that PC's `host` snapshot says
 * godmode: true and the run names its project. Buttons are disabled while a
 * command for the run is in flight; a refusal comes back as a toast
 * (hostrun.js). Kill asks first (`confirm`: sheet.confirmSheet).
 * @param {{toast: (m: string, bad?: boolean) => void}} deps
 * @param {(host: string) => {run: (kind: string, payload: object) => Promise<object|null>}} runnerFor
 * @param {() => void} repaint
 * @param {(opts: object) => Promise<boolean>} confirm
 * @returns {(live: object, host: object|null) => Node|null}
 */
export function createLiveControls(deps, runnerFor, repaint, confirm) {
  const inflight = new Set();
  const keyOf = (live) => `${String(live.machine).toLowerCase()}|${live.projectId}`;

  async function send(live, kind, okKey) {
    const key = keyOf(live);
    if (inflight.has(key)) return;
    inflight.add(key);
    repaint();
    try {
      const res = await runnerFor(live.machine).run(kind, { projectId: live.projectId });
      if (res) deps.toast(tf(okKey, { repo: live.title || live.id }));
    } finally {
      inflight.delete(key);
      repaint();
    }
  }

  async function kill(live) {
    const ok = await confirm({ title: tf('gmKillConfirm', { repo: live.title || live.id }), text: t('gmKillConfirmText'), ok: t('gmKill'), danger: true });
    if (ok) await send(live, 'godmode.kill', 'gmKilled');
  }

  return (live, host) => {
    if (!live.projectId || !host || !host.godmode) return null;
    const can = liveActions(live);
    if (!can.kill && !can.retry && !can.finish) return null;
    const busy = inflight.has(keyOf(live));
    const btn = (show, cls, key, onclick) => (show ? h('button', { class: `btn btn-sm ${cls}`.trim(), type: 'button', disabled: busy, 'aria-busy': busy ? 'true' : null, onclick }, t(key)) : null);
    return h(
      'div',
      { class: 'row gm-actions' },
      btn(can.retry, '', 'gmRetry', () => send(live, 'godmode.retry', 'gmRetried')),
      btn(can.finish, 'btn-primary', 'gmFinish', () => send(live, 'godmode.finish', 'gmFinishing')),
      btn(can.kill, 'btn-danger', 'gmKill', () => kill(live)),
    );
  };
}

/** The full live card on the God Mode page; `index` keeps heading ids unique, `controls` (createLiveControls) sits under the header. */
export function liveCard(live, now, index = 0, controls = null) {
  const headingId = index ? `godmode-live-${index}` : 'godmode-live';
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': headingId },
    h(
      'div',
      { class: 'row' },
      h('h2', { class: 'section-title grow', id: headingId }, `${t('godmodeLive')} · ${live.title || live.id}`),
      staleBadge(live),
      h('span', { class: runTone(live.state) }, t(RUN_STATE_KEY[live.state])),
    ),
    h('span', { class: 'hint' }, [live.machine, live.baseBranch, tf('godmodeStarted', { time: when(live.startedAt, now) }), tf('godmodeReported', { time: hhmm(live.at) })].filter(Boolean).join(' · ')),
    pausedBanner(live),
    optionTags(live),
    controls,
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

/** One going run on Today: pause banner, then a link row with its counters line. */
function todayRunRows(live, now, withState) {
  const c = godmodeLiveCounts(live);
  const line = [
    tf('godmodePushed', { n: c.pushed, total: live.packages.length }),
    c.working ? `${c.working} ${t('godmodeCountWorking')}` : '',
    c.waiting ? `${c.waiting} ${t('godmodeCountWaiting')}` : '',
    c.failed ? `${c.failed} ${t('godmodeCountFailed')}` : '',
  ].filter(Boolean);
  return [
    pausedBanner(live),
    h(
      'a',
      { class: 'link-row', href: '#godmode' },
      h('span', { class: 'grow' }, h('span', { class: 'link-title' }, live.title || live.id), h('span', { class: `hint ${c.waiting ? 'is-warn' : ''}`.trim() }, line.join(' · '))),
      withState ? staleBadge(live) : null,
      withState ? h('span', { class: runTone(live.state) }, t(RUN_STATE_KEY[live.state])) : null,
      h('span', { class: 'hint num' }, when(live.startedAt, now)),
    ),
  ];
}

/**
 * Today's card while runs are going: one row per run (title, counters line,
 * pause banner, stale badge). Null when none is going.
 */
export function liveTodayCard(rows, now) {
  const going = godmodeLivesFrom(rows, now).filter(isGoing);
  if (!going.length) return null;
  const one = going.length === 1 ? going[0] : null;
  const head = h(
    'div',
    { class: 'row' },
    h('h2', { class: 'section-title grow', id: 'today-godmode' }, one ? t('godmodeLive') : `${t('godmodeLive')} (${going.length})`),
    one ? staleBadge(one) : null,
    one ? h('span', { class: runTone(one.state) }, t(RUN_STATE_KEY[one.state])) : null,
  );
  // One run keeps its state in the header; several carry it per row.
  return h('section', { class: 'card stack-sm', 'aria-labelledby': 'today-godmode' }, head, going.flatMap((live) => todayRunRows(live, now, !one)));
}
