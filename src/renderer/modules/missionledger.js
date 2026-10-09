// ============================================================================
// LunaCore - Mission Control: "Where Claude went" block (renderer)
// ----------------------------------------------------------------------------
// Lives inside the Telemetry widget. mission:ledger (src/missionledgerservice.js)
// scans the local transcripts and merges the other PCs' files from the shared
// folder - free, no model call. This file only renders: the stacked bar by
// class, the top projects, one-click work / fun / other for unassigned ones,
// and the PCs feeding the numbers. Math lives in missionledgerview.js.
//
// The renderer never names a path: the shared folder is picked in a native
// dialog in main, and project classes are set by key, validated in main.
// ============================================================================

'use strict';

import { t } from './util.js';
import { errorText, ipcFailed } from './missionshared.js';
import { ledgerView, CLASS_ORDER } from './missionledgerview.js';

const STALE_MS = 2 * 60 * 1000;
const PICK = ['work', 'fun', 'other'];

// Module state survives unmount, like the other Mission Control widgets.
let report = null;
let fetchedAt = 0;
let loading = false;
let lastError = null;

const lang = () => (window.i18n && window.i18n.lang) || 'pl';
const pct = (n) => (n >= 10 ? `${Math.round(n)}%` : `${n.toFixed(1)}%`);
const usd = (n) => `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "2 h ago" / "2 godz. temu" in the UI language. */
function ago(ms) {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' });
  if (mins < 60) return rtf.format(-mins, 'minute');
  if (mins < 48 * 60) return rtf.format(-Math.round(mins / 60), 'hour');
  return rtf.format(-Math.round(mins / 1440), 'day');
}

function renderBar(view) {
  const bar = el('div', 'mc-ledger__bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute(
    'aria-label',
    view.segments.map((s) => `${t(`mc.ledger.cls.${s.cls}`)} ${pct(s.pct)}`).join(', ') || t('mc.ledger.empty')
  );
  const used = view.segments.reduce((s, x) => s + x.pct, 0);
  for (const s of view.segments) {
    const seg = el('span', `mc-ledger__seg mc-ledger__seg--${s.cls}`);
    seg.style.flexGrow = String(s.pct);
    bar.append(seg);
  }
  // On the limit basis the bar is the whole weekly limit: leave the unused part empty.
  if (view.basis === 'limit' && used < 100) {
    const rest = el('span', 'mc-ledger__seg mc-ledger__seg--free');
    rest.style.flexGrow = String(100 - used);
    bar.append(rest);
  }
  const legend = el('ul', 'mc-ledger__legend');
  for (const cls of CLASS_ORDER) {
    const seg = view.segments.find((s) => s.cls === cls);
    if (!seg) continue;
    const item = el('li', 'mc-ledger__legenditem');
    item.append(el('span', `mc-ledger__swatch mc-ledger__seg--${cls}`), el('span', null, `${t(`mc.ledger.cls.${cls}`)} ${pct(seg.pct)}`));
    legend.append(item);
  }
  return [bar, legend];
}

function renderRows(view) {
  const list = el('ul', 'mc-ledger__rows');
  const unit = view.basis === 'limit' ? 'mc.ledger.ofLimit' : 'mc.ledger.ofSpend';
  for (const r of view.top) {
    const row = el('li', 'mc-ledger__row');
    const name = el('span', 'mc-ledger__name', r.pinned ? `★ ${r.name}` : r.name);
    name.title = r.pinned ? `${t('mc.ledger.pinned')} · ${r.key}` : r.key;
    const chip = el('span', `mc-ledger__chip mc-ledger__seg--${r.cls}`, t(`mc.ledger.cls.${r.cls}`));
    const idle = r.usd === 0 && !r.unpricedTokens;
    const nums = el('span', 'mc-ledger__nums', idle ? t('mc.ledger.idle') : `≈ ${t(unit, { pct: pct(r.pct) })} · ~${usd(r.usd)}`);
    row.append(name, chip, nums);
    list.append(row);
  }
  const out = [list];
  if (view.restCount) out.push(el('p', 'mc-tele__stat', t('mc.ledger.rest', { n: view.restCount, pct: pct(view.restPct) })));
  if (view.unpricedTokens) out.push(el('p', 'hint', t('mc.ledger.unpriced', { n: view.unpricedTokens.toLocaleString(lang()) })));
  return out;
}

function renderUnassigned(view, rerender) {
  if (!view.unassigned.length) return [];
  const box = el('div', 'mc-ledger__assign');
  box.append(el('h4', 'mc-bucket__title', t('mc.ledger.assignTitle', { n: view.unassigned.length })));
  for (const p of view.unassigned) {
    const row = el('div', 'mc-ledger__assignrow');
    const group = el('div', 'mc-ledger__toggle');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('mc.ledger.assignLabel', { name: p.name }));
    for (const cls of PICK) {
      const btn = el('button', 'mc-ledger__pick', t(`mc.ledger.cls.${cls}`));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', async () => {
        group.querySelectorAll('button').forEach((b) => (b.disabled = true));
        const res = await window.lunacore.missionProjectClass(p.key, cls).catch(ipcFailed);
        if (res.ok && report) {
          report = { ...report, projects: report.projects.map((x) => (x.key === p.key ? { ...x, cls } : x)) };
        } else {
          lastError = res.reason;
        }
        rerender();
      });
      group.append(btn);
    }
    const name = el('span', 'mc-ledger__name', p.name);
    name.title = p.key;
    row.append(name, group);
    box.append(row);
  }
  return [box];
}

function renderFooter(onPick, onClear) {
  const foot = el('div', 'mc-ledger__foot');
  const pcs = report.machines
    .map((m) => (m.self ? t('mc.ledger.thisPc', { name: m.machine }) : `${m.machine} (${ago(m.updatedAt)})`))
    .join(' · ');
  foot.append(el('p', 'hint', t('mc.ledger.pcs', { list: pcs })));
  if (report.sharedDir) {
    const dir = el('p', 'hint mc-ledger__dir', t('mc.ledger.sharedIn', { dir: report.sharedDir }));
    dir.title = report.sharedDir;
    foot.append(dir);
  }
  if (report.syncError) foot.append(el('p', 'hint is-fail', t('mc.ledger.syncError', { code: report.syncError })));
  const actions = el('div', 'mc-ledger__actions');
  const pick = el('button', 'pad-send mc-connect', t(report.sharedDir ? 'mc.ledger.changeDir' : 'mc.ledger.pickDir'));
  pick.type = 'button';
  pick.addEventListener('click', onPick);
  actions.append(pick);
  if (report.sharedDir) {
    const clear = el('button', 'port-btn mc-ledger__clear', t('mc.ledger.clearDir'));
    clear.type = 'button';
    clear.addEventListener('click', onClear);
    actions.append(clear);
  }
  foot.append(actions);
  return foot;
}

/**
 * Mounts the block into `root`. getWeekly() returns the weekly usage limit
 * ({percentUsed, resetsAt}) from the usage poll, or null.
 * @returns {{render:()=>void, load:(force?:boolean)=>Promise<void>, usageChanged:()=>void, unmount:()=>void}}
 */
export function mountLedger(root, getWeekly) {
  let mounted = true;

  async function load(force = false) {
    if (loading || (!force && report && Date.now() - fetchedAt < STALE_MS)) return render();
    loading = true;
    render();
    const weekly = getWeekly();
    const resetsAt = weekly ? Date.parse(weekly.resetsAt) : NaN;
    const res = await window.lunacore
      .missionLedger({ resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined })
      .catch(ipcFailed);
    loading = false;
    if (res.ok) {
      report = res;
      fetchedAt = Date.now();
      lastError = null;
    } else {
      lastError = res.reason;
    }
    render();
  }

  async function pickDir() {
    const res = await window.lunacore.missionLedgerPickDir().catch(ipcFailed);
    if (res.ok) return load(true);
    if (res.reason !== 'cancelled') lastError = res.reason;
    render();
  }

  async function clearDir() {
    const res = await window.lunacore.missionLedgerClearDir().catch(ipcFailed);
    if (res.ok) return load(true);
    lastError = res.reason;
    render();
  }

  function render() {
    if (!mounted) return;
    const weekly = getWeekly();
    const view = ledgerView(report, weekly && typeof weekly.percentUsed === 'number' ? weekly.percentUsed : null);
    const parts = [];
    if (loading && !report) parts.push(el('p', 'hint', t('mc.ledger.loading')));
    if (lastError) parts.push(el('p', 'hint is-fail', errorText(lastError)));
    if (view && view.top.length) {
      parts.push(...renderBar(view), ...renderRows(view), ...renderUnassigned(view, render));
      parts.push(el('p', 'hint', t(view.basis === 'limit' ? 'mc.ledger.noteLimit' : 'mc.ledger.noteSpend')));
    } else if (view) {
      parts.push(el('p', 'hint', t('mc.ledger.empty')));
    }
    if (report) parts.push(renderFooter(pickDir, clearDir));
    root.replaceChildren(...parts);
  }

  /** Usage poll update: if the last report had to guess the window (Monday) and
   *  the provider's reset is known now, fetch once more with the real window. */
  function usageChanged() {
    const weekly = getWeekly();
    const knowsReset = weekly && Number.isFinite(Date.parse(weekly.resetsAt));
    if (knowsReset && report && report.windowSource === 'monday' && !loading) load(true);
    else render();
  }

  load();
  return {
    render,
    load,
    usageChanged,
    unmount: () => {
      mounted = false;
    },
  };
}
