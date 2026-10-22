// ============================================================================
// LunaCore phone - God Mode: the recent runs of every PC
// ----------------------------------------------------------------------------
// A PC adds each finalized run to its `godmode` snapshot (godmodesnapshot.js).
// The page lists them (when, repo, "N of M pushed", integration state); a
// tap opens the run's packages with state, branch, PR link and stall reason.
// Today shows a small card for a run finished in the last 24 hours.
// A run going on right now and the PCs' tab lights sit on top
// (godmodelive.js); the snapshots table streams over realtime, so a PC's
// put repaints the page without polling.
// Read-only; every string is text, and a PR link is github.com only (the
// reader already dropped anything else).
// ============================================================================

import { h, icon, ICONS } from '../dom.js';
import { t, tf } from '../i18n.js';
import { godmodeRunsFrom } from '../snapmodel.js';
import { mountSnapshots, when } from './snapshotview.js';
import { liveToShow, liveCard, tabsCard, liveTodayCard, repaintWhileShown } from './godmodelive.js';

const RECENT_MS = 24 * 60 * 60 * 1000;
const PR_PREFIX = 'https://github.com/';

const stateTone = (state) => (state === 'pushed' ? 'tag is-good' : state === 'stalled' || state === 'failed' || state === 'killed' ? 'tag is-bad' : 'tag');
const integTone = (state) => (state === 'done' ? 'is-good' : state === 'failed' ? 'is-bad' : '');

/** "2 of 3 pushed · PR · done" */
function summaryLine(run) {
  const integ = [run.integrationMode, run.integrationState].filter(Boolean).join(' · ');
  return [tf('godmodePushed', { n: run.pushed, total: run.total }), integ].filter(Boolean).join(' · ');
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
  const meta = [p.branch, p.sha7, p.escalated ? t('godmodeEscalated') : ''].filter(Boolean).join(' · ');
  return h(
    'li',
    { class: 'row-col' },
    h('div', { class: 'row' }, h('span', { class: 'grow' }, p.title || p.id), h('span', { class: stateTone(p.state) }, p.state || '?')),
    meta ? h('span', { class: 'hint num' }, meta) : null,
    p.reason ? h('span', { class: 'hint is-bad' }, p.reason) : null,
    prLink(p.prUrl),
  );
}

function runCard(run, now) {
  const integ = h('span', { class: `hint ${integTone(run.integrationState)}`.trim() }, summaryLine(run));
  const head = h(
    'summary',
    { class: 'run-head' },
    h('div', { class: 'row' }, h('span', { class: 'grow' }, run.repoName || run.id), h('span', { class: 'hint num' }, when(run.finishedAt, now))),
    integ,
    h('span', { class: 'hint' }, [run.machine, run.baseBranch, run.workerModel].filter(Boolean).join(' · ')),
  );
  const extra = run.approvalSuggestions.length
    ? h('div', { class: 'stack-sm' }, h('span', { class: 'hint' }, t('godmodeApprovals')), h('ul', { class: 'rows' }, run.approvalSuggestions.map((r) => h('li', { class: 'hint num' }, r))))
    : null;
  return h(
    'details',
    { class: 'card run' },
    head,
    h('div', { class: 'stack-sm run-body' }, run.packages.length ? h('ul', { class: 'rows' }, run.packages.map(packageRow)) : h('p', { class: 'hint' }, t('godmodeNoPackages')), extra),
  );
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountGodmode(main, deps) {
  const view = mountSnapshots(main, deps, ['godmode'], (byKind, now) => {
    const rows = byKind.godmode;
    const runs = godmodeRunsFrom(rows, now);
    const live = liveToShow(rows, now);
    const tabs = tabsCard(rows, now);
    if (!runs.length && !live && !tabs) return h('p', { class: 'empty' }, t('godmodeEmpty'));
    return h('div', { class: 'stack' }, live ? liveCard(live, now) : null, tabs, runs.map((r) => runCard(r, now)));
  });
  repaintWhileShown(main, view);
  return view;
}

/** Today's card: the live run while one is going, else the newest finished run. */
export function godmodeTodayCard(rows, now) {
  return liveTodayCard(rows, now) || latestRunCard(rows, now);
}

/** Today's card: the newest run if it finished in the last 24 h, else nothing. */
export function latestRunCard(rows, now) {
  const [run] = godmodeRunsFrom(rows, now);
  if (!run || now - run.finishedAt > RECENT_MS) return h('div', { hidden: true });
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'today-godmode' },
    h('h2', { class: 'section-title', id: 'today-godmode' }, t('godmodeLatest')),
    h('a', { class: 'link-row', href: '#godmode' }, h('span', { class: 'grow' }, h('span', { class: 'link-title' }, run.repoName || run.id), h('span', { class: `hint ${integTone(run.integrationState)}`.trim() }, summaryLine(run))), h('span', { class: 'hint num' }, when(run.finishedAt, now))),
  );
}
