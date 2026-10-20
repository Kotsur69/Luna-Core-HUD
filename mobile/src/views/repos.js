// ============================================================================
// LunaCore phone - Repos: every PC's git station (REMOTE_HOST_PLAN U2)
// ----------------------------------------------------------------------------
// One card per repo (keyed by its remote, so clones on several PCs meet),
// one row per PC: branch, dirty, ahead/behind, last commit, last fetch.
// Badges say what needs doing: push, pull, uncommitted work, or PCs that
// disagree on the branch or HEAD. Read-only; every string is text, never HTML.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { reposFrom } from '../snapmodel.js';
import { mountSnapshots, when } from './snapshotview.js';

/** The badges of one repo, most urgent first. */
function badges(repo) {
  const list = [
    repo.diverged ? ['reposDiverged', 'tag is-bad'] : null,
    repo.needsPush ? ['reposNeedsPush', 'tag is-warn'] : null,
    repo.behind ? ['reposBehind', 'tag is-warn'] : null,
    repo.dirty ? ['reposDirty', 'tag'] : null,
  ].filter(Boolean);
  if (!list.length) return h('div', { class: 'tags' }, h('span', { class: 'tag is-good' }, t('reposClean')));
  return h('div', { class: 'tags' }, list.map(([key, cls]) => h('span', { class: cls }, t(key))));
}

function machineRow(m, now) {
  const counts = [m.ahead ? `↑${m.ahead}` : '', m.behind ? `↓${m.behind}` : '', m.dirty ? t('reposDirtyShort') : ''].filter(Boolean).join(' ');
  const commit = m.lastCommit ? [m.lastCommit.subject, m.lastCommit.at ? when(m.lastCommit.at, now) : ''].filter(Boolean).join(' · ') : t('reposNoCommit');
  const fetched = m.fetchedAt ? tf('reposFetched', { time: when(m.fetchedAt, now) }) : t('reposNeverFetched');
  return h(
    'li',
    { class: 'row-col' },
    h('div', { class: 'row' }, h('span', { class: 'grow' }, m.machine), h('span', { class: 'num' }, m.branch || '–'), counts ? h('span', { class: 'num hint' }, counts) : null),
    h('span', { class: 'hint' }, commit),
    h('span', { class: 'hint' }, `${fetched} · ${tf('reposReported', { time: when(m.at, now) })}`),
  );
}

function repoCard(repo, now, i) {
  const id = `repo-${i}`;
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': id },
    h('h2', { class: 'section-title', id }, repo.name),
    badges(repo),
    h('ul', { class: 'rows' }, repo.machines.map((m) => machineRow(m, now))),
  );
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountRepos(main, deps) {
  return mountSnapshots(main, deps, ['repos'], (byKind, now) => {
    const repos = reposFrom(byKind.repos, now);
    if (!repos.length) return h('p', { class: 'empty' }, t('reposEmpty'));
    return h('div', { class: 'stack' }, repos.map((r, i) => repoCard(r, now, i)));
  });
}
