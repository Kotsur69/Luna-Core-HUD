// ============================================================================
// LunaCore - Life dashboard overlay (Ctrl+Shift+N)
// ----------------------------------------------------------------------------
// A full-screen overlay like Mission Control's, holding the Money columns
// (lifemoney / lifebills / lifeplan). The columns are built on first open
// and kept (their state lives in lifeui.js), so reopening is instant and a
// half-typed expense survives a close.
//
// Ctrl+Shift+N is matched on e.code ('KeyN'), not e.key - the physical key,
// same rule as Ctrl+Shift+M. Nothing else in the renderer claims it, and
// main.js's before-input-event handler bails out on Shift (only Ctrl+Shift+K
// during a God Mode run is taken there), so it reaches this listener.
//
// Bill reminders: a native toast for unpaid bills due within 3 days or
// overdue, checked a few seconds after launch and every 6 hours. Each bill
// due date is announced at most once a day (localStorage; if storage is
// unavailable the worst case is a repeated toast, never a missed one).
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { closeWithExit, cancelExit } from './motion.js';
import { loadBudget, bindStatus, setStatus, money, shortDate, getState } from './lifeui.js';
import { mountMoney, relabelMoney, focusMoney } from './lifemoney.js';
import { mountBills, relabelBills, billsNeedingAttention } from './lifebills.js';
import { mountPlan, relabelPlan } from './lifeplan.js';

const REMIND_FIRST_MS = 8000;
const REMIND_EVERY_MS = 6 * 60 * 60 * 1000;
const REMIND_KEY = 'lunacore.life.reminded';

const overlayEl = document.getElementById('life');
let isOpen = false;
let isBuilt = false;
let returnFocus = null;

function build() {
  bindStatus(document.getElementById('life-status'));
  mountMoney(document.getElementById('life-col-money'));
  mountBills(document.getElementById('life-col-bills'));
  mountPlan(document.getElementById('life-col-plan'));
  isBuilt = true;
}

async function open() {
  if (isOpen) return;
  cancelExit(overlayEl);
  isOpen = true;
  returnFocus = document.activeElement;
  if (!isBuilt) build();
  overlayEl.hidden = false;
  setStatus('');
  focusMoney();
  await loadBudget();
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  closeWithExit(overlayEl);
  if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  returnFocus = null;
}

/** Called once by the `terminal` widget's mount() - see modules/terminal.js. */
export function mountLifeChip(root) {
  const btn = root.querySelector('#life-open');
  if (btn) btn.addEventListener('click', () => open());
}

// --- reminders ------------------------------------------------------------------

function readReminded() {
  try {
    return JSON.parse(localStorage.getItem(REMIND_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeReminded(map) {
  try {
    localStorage.setItem(REMIND_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable: the next pass may repeat the toast - harmless.
  }
}

async function remind() {
  const res = await loadBudget();
  if (!res.ok || typeof Notification === 'undefined') return;
  const day = new Date().toDateString();
  const seen = readReminded();
  const due = billsNeedingAttention(getState().summary).filter((b) => seen[`${b.id}:${b.dueDate}`] !== day);
  if (!due.length) return;
  const lines = due.map((b) => t(`life.remind.${b.status}`, { name: b.name, amount: money(b.expected), date: shortDate(b.dueDate) }));
  const note = new Notification(t('life.remind.title', { n: due.length }), { body: lines.join('\n') });
  note.onclick = () => open();
  // Only today's entries are kept, so the map never grows.
  const next = {};
  for (const [k, v] of Object.entries(seen)) if (v === day) next[k] = v;
  for (const b of due) next[`${b.id}:${b.dueDate}`] = day;
  writeReminded(next);
}

setTimeout(() => {
  remind();
  setInterval(remind, REMIND_EVERY_MS);
}, REMIND_FIRST_MS);

// --- wiring ---------------------------------------------------------------------

onLangChange(() => {
  if (!isBuilt) return;
  relabelMoney();
  relabelBills();
  relabelPlan();
});

overlayEl.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-life-close')) close();
});

// Capture phase, to get ahead of xterm.js - same as Ctrl+Shift+M. Escape is
// handled here too: focus is not guaranteed to be inside the panel.
window.addEventListener(
  'keydown',
  (e) => {
    if (isOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) close();
      else open();
    }
  },
  true
);
