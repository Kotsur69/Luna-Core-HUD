// ============================================================================
// LunaCore - God Mode run summary window (renderer)
// ----------------------------------------------------------------------------
// One finalized run, from this PC or any other (src/inboxipc.js inbox:run):
// repo name, PC, finished time, merged / pushed count, integration state,
// the Needs-you lines, manual actions, PR links and every package's state.
// Opening it marks the run seen on all PCs (main does that on inbox:run).
// PR links open through main (inbox:open-pr), which re-checks the row's URL
// is github.com - the renderer never hands over a URL. textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { createTallOverlay } from './talloverlay.js';

let overlay = null;
let afterClose = null;

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(() => ({ ok: false, reason: 'ipc' }));

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function section(titleKey, children) {
  const sec = el('section', 'gm-sum__sec');
  sec.append(el('h3', 'termcustom__section', t(titleKey)), ...children);
  return sec;
}

function lineList(lines, emptyKey) {
  if (!lines.length) return el('p', 'hint', t(emptyKey));
  const ul = el('ul', 'gm-sum__list');
  for (const line of lines) {
    const li = el('li', /^\s/.test(line) ? 'gm-sum__tail' : '', line.trim());
    ul.append(li);
  }
  return ul;
}

function facts(run) {
  const merge = run.integrationMode === 'merge';
  const rows = [
    ['gm.sum.repo', run.repoName || '-'],
    ['gm.sum.pc', run.machine],
    ['gm.sum.finished', when(run.finishedAt)],
    [merge ? 'gm.sum.merged' : 'gm.sum.pushed', `${merge ? run.merged : run.pushed} / ${run.total}`],
    ['gm.sum.integration', run.integrationState || '-'],
    ['gm.sum.selfCheck', run.selfCheck],
  ];
  const dl = el('dl', 'gm-sum__facts');
  for (const [key, value] of rows) dl.append(el('dt', '', t(key)), el('dd', '', String(value)));
  return dl;
}

function prLinks(run) {
  const withPr = run.packages.filter((p) => p.prUrl);
  if (!withPr.length) return el('p', 'hint', t('gm.sum.noPrs'));
  const ul = el('ul', 'gm-sum__list');
  for (const p of withPr) {
    const li = el('li');
    const link = el('button', 'gm-sum__link', `${p.id}: ${p.prUrl}`);
    link.type = 'button';
    link.addEventListener('click', () => call('inboxOpenPr', run.machine, run.id, p.id));
    li.append(link);
    ul.append(li);
  }
  return ul;
}

function packages(run) {
  if (!run.packages.length) return el('p', 'hint', t('gm.sum.noPackages'));
  const wrap = el('div', 'gm-sum__table-wrap');
  const table = el('table', 'gm-sum__table');
  const head = el('tr');
  for (const key of ['gm.sum.col.pkg', 'gm.sum.col.state', 'gm.sum.col.branch', 'gm.sum.col.notes']) head.append(el('th', '', t(key)));
  table.append(head);
  for (const p of run.packages) {
    const tr = el('tr');
    const name = el('td');
    name.append(el('strong', '', p.id), el('span', 'gm-sum__dim', p.title ? ` ${p.title}` : ''));
    const notes = [p.reason, p.escalated ? t('gm.sum.escalated') : ''].filter(Boolean).join(' · ');
    tr.append(name, el('td', `gm-sum__state is-${p.state || 'none'}`, p.state || '-'), el('td', 'gm-sum__mono', [p.branch, p.sha7].filter(Boolean).join(' @ ') || '-'), el('td', '', notes || ''));
    table.append(tr);
  }
  wrap.append(table);
  return wrap;
}

function render(run) {
  overlay.setTitle(t('gm.sum.title', { repo: run.repoName || '-' }));
  overlay.body.replaceChildren(
    facts(run),
    section('gm.sum.needs', [lineList(run.needs || [], 'gm.sum.needsNone')]),
    section('gm.sum.manual', [lineList(run.manual || [], 'gm.sum.manualNone')]),
    section('gm.sum.prs', [prLinks(run)]),
    section('gm.sum.packages', [packages(run)]),
  );
}

/**
 * Opens the summary for one run (machine + id); `onClose` runs when it closes.
 * @param {string} machine
 * @param {string} id
 * @param {{onClose?:() => void}} [opts]
 */
export async function openRunSummary(machine, id, { onClose } = {}) {
  if (!overlay) overlay = createTallOverlay({ id: 'gm-summary', glyph: '⚡', titleKey: 'gm.sum.titleBare', onClose: () => afterClose && afterClose() });
  afterClose = onClose || null;
  overlay.setTitle('');
  overlay.body.replaceChildren(el('p', 'hint', t('gm.sum.loading')));
  overlay.open();
  const res = await call('inboxRun', machine, id);
  if (!overlay.isOpen()) return;
  if (res && res.ok && res.run) render(res.run);
  else overlay.body.replaceChildren(el('p', 'hint is-fail', t(res && res.reason === 'not-found' ? 'gm.sum.notFound' : 'gm.sum.failed')));
}
