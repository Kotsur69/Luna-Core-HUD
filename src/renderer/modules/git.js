// ============================================================================
// LunaCore - git station panel
// ----------------------------------------------------------------------------
// One row per watched repo: branch, working-tree counts, ahead/behind, and the
// last commit. Repos that need attention sort to the top (src/gitstation.js
// decides the order; this file only draws it).
//
// The number worth having on screen is BEHIND. A dirty tree you already know
// about - you made the mess. Divergence between two clones of the same repo is
// the one that is invisible until it costs you an evening.
//
// Refresh is manual plus a slow tick. `git status` spawns a process per repo,
// so a 4-second timer like the port scanner would mean a constant drip of git
// processes to watch a number that moves when you commit, which is not often.
// ============================================================================

'use strict';

import { t, pulse } from './util.js';
import { onLangChange } from './bus.js';
import { defineWidget } from './registry.js';

// Slow enough to be free, often enough that a glance is worth trusting.
const REFRESH_MS = 120000;

// null = nothing loaded yet.
let rows = null;
let loading = false;
let timer = null;

// Paths currently mid-fetch, so the button can say so and refuse a second one.
const fetching = new Set();

// Elements of the current mount, or null when this widget is not on screen.
let els = null;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact "how long ago" - the row has no space for a date. */
function ago(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < HOUR) return t('git.ago.min', { n: Math.max(1, Math.floor(d / MIN)) });
  if (d < DAY) return t('git.ago.hour', { n: Math.floor(d / HOUR) });
  return t('git.ago.day', { n: Math.floor(d / DAY) });
}

/** Builds the ahead/behind + dirty badges. Only non-zero ones are drawn. */
function badges(status) {
  const out = [];
  const add = (cls, text, title) => {
    const b = document.createElement('span');
    b.className = `git-badge git-badge--${cls}`;
    b.textContent = text;
    b.title = title;
    out.push(b);
  };
  if (!status) return out;
  if (status.behind) add('behind', `↓${status.behind}`, t('git.behind', { n: status.behind }));
  if (status.ahead) add('ahead', `↑${status.ahead}`, t('git.ahead', { n: status.ahead }));
  if (status.conflicts) {
    add('conflict', `!${status.conflicts}`, t('git.conflicts', { n: status.conflicts }));
  }
  const dirty = status.staged + status.changed + status.untracked;
  if (dirty) add('dirty', `●${dirty}`, t('git.dirty', { n: dirty }));
  return out;
}

function makeRow(r) {
  const li = document.createElement('li');
  li.className = `git-item git-item--${r.state}`;

  const head = document.createElement('span');
  head.className = 'git-item__head';

  const name = document.createElement('span');
  name.className = 'git-item__name';
  name.textContent = r.name;
  name.title = r.path;

  const branch = document.createElement('span');
  branch.className = 'git-item__branch';
  branch.textContent = r.status ? r.status.branch : '';

  head.append(name, branch);
  for (const b of badges(r.status)) head.appendChild(b);

  if (!r.error) {
    const fetch = document.createElement('button');
    fetch.className = 'git-fetch';
    fetch.textContent = fetching.has(r.path) ? '…' : '⟱';
    fetch.title = t('git.fetch.title');
    fetch.dataset.fetch = r.path;
    fetch.disabled = fetching.has(r.path);
    head.appendChild(fetch);
  }

  const meta = document.createElement('span');
  meta.className = 'git-item__meta';
  if (r.error) {
    meta.textContent = t(`git.error.${r.error}`);
  } else if (r.status && !r.status.upstream && !r.status.detached) {
    // No upstream means ahead/behind are structurally unavailable, not zero -
    // a row that quietly showed "clean" here would be lying.
    meta.textContent = t('git.noUpstream');
  } else if (r.lastCommit) {
    meta.textContent = `${r.lastCommit.hash} · ${ago(r.lastCommit.at)} · ${r.lastCommit.subject}`;
    meta.title = r.lastCommit.subject;
  }

  li.append(head, meta);
  return li;
}

function render() {
  if (!els) return;

  if (!rows) {
    els.empty.textContent = loading ? t('git.loading') : t('git.idle');
    els.empty.style.display = '';
    els.list.innerHTML = '';
    return;
  }

  els.list.innerHTML = '';
  for (const r of rows) els.list.appendChild(makeRow(r));

  const note = rows.length ? '' : t('git.empty');
  els.empty.textContent = note;
  els.empty.style.display = note ? '' : 'none';
  // The scan button is an onboarding step, not a permanent control: once the
  // list exists, hunting the disk for more repos is a rare thing to want.
  els.scan.style.display = rows.length ? 'none' : '';
}

async function load() {
  if (loading) return;
  loading = true;
  render();
  try {
    rows = await window.lunacore.getRepos();
    if (!Array.isArray(rows)) rows = [];
  } catch {
    rows = [];
  } finally {
    loading = false;
    render();
  }
}

/** Replaces one row in place, so a fetch does not reorder the list under the cursor. */
function replaceRow(repo) {
  if (!repo || !rows) return;
  const i = rows.findIndex((r) => r.path === repo.path);
  if (i >= 0) rows[i] = repo;
}

defineWidget({
  id: 'git',
  titleKey: 'git.title',
  template: 'w-git',
  mount(root) {
    els = {
      list: root.querySelector('#git-list'),
      empty: root.querySelector('#git-empty'),
      refresh: root.querySelector('#git-refresh'),
      scan: root.querySelector('#git-scan'),
    };

    const offLang = onLangChange(render);

    els.refresh.addEventListener('click', () => {
      pulse(els.refresh);
      load();
    });

    els.scan.addEventListener('click', async () => {
      pulse(els.scan);
      await window.lunacore.scanRepos();
      rows = null;
      load();
    });

    els.list.addEventListener('click', async (e) => {
      const btn = e.target.closest('.git-fetch');
      if (!btn) return;
      const dir = btn.dataset.fetch;
      if (!dir || fetching.has(dir)) return;

      fetching.add(dir);
      render();
      try {
        const res = await window.lunacore.fetchRepo(dir);
        if (res && res.repo) replaceRow(res.repo);
      } finally {
        fetching.delete(dir);
        render();
      }
    });

    render();
    if (!rows) load();

    // The timer belongs to the mount: an unmounted panel has no reason to keep
    // spawning git processes.
    timer = setInterval(load, REFRESH_MS);

    return () => {
      clearInterval(timer);
      timer = null;
      offLang();
      els = null;
    };
  },
});
