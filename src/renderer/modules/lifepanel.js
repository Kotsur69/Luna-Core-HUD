// ============================================================================
// LunaCore - Life dashboard overlay (Ctrl+Shift+N)
// ----------------------------------------------------------------------------
// A full-screen overlay like Mission Control's: the quick add bar on top
// (always there - a Red Bull is two keystrokes and a click), a month switch
// (◀ period ▶ / Today) and eight tabs - Overview, Habits (lifehabitsview.js), Spending, Transactions,
// Bills & Savings, Year (lifeyear.js), Body (YAZIO, lifebody.js), Settings. Every tab renders from the one budget answer in
// lifeui.js, so a change anywhere redraws the open tab at once. The shell is
// built on first open and kept, so reopening is instant.
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
import {
  el, iconButton, loadBudget, peekBudget, setMonth, bindStatus, setStatus, hideToast, money, shortDate, monthLabel, getState, onState,
} from './lifeui.js';
import { mountQuick, relabelQuick, focusQuick } from './lifequick.js';
import { renderOverview } from './lifeoverview.js';
import { renderSpending } from './lifespending.js';
import { renderTx } from './lifetx.js';
import { renderBills, billsNeedingAttention } from './lifebills.js';
import { renderSettings } from './lifesettings.js';
import { renderBody } from './lifebody.js';
import { renderYear } from './lifeyear.js';
import { renderHabits } from './lifehabitsview.js';
import { getDaily, onDaily, loadDaily, startLive, stopLive } from './lifedaily.js';
import { needsCheckin, needsGoals } from './lifedailyview.js';
import { checkinPrompt } from './lifecheckin.js';
import { goalsPrompt } from './lifegoalsview.js';
import { scoreCard, nowStrip } from './lifescoreview.js';

const REMIND_FIRST_MS = 8000;
const REMIND_EVERY_MS = 6 * 60 * 60 * 1000;
const REMIND_KEY = 'lunacore.life.reminded';
const TAB_KEY = 'lunacore.life.tab';

const TABS = [
  ['overview', (root, s) => renderOverview(root, s, goTab)],
  ['habits', renderHabits],
  ['spending', renderSpending],
  ['tx', renderTx],
  ['bills', (root, s) => renderBills(root, s, goTab)],
  ['year', renderYear],
  ['body', renderBody],
  ['settings', renderSettings],
];

const overlayEl = document.getElementById('life');
let isOpen = false;
let isBuilt = false;
let returnFocus = null;
let els = null;
let tab = readTab();

function readTab() {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.some(([id]) => id === saved) ? saved : 'overview';
  } catch {
    return 'overview';
  }
}

// --- tabs ---------------------------------------------------------------------

function buildTabs() {
  els.tabs.replaceChildren();
  for (const [id] of TABS) {
    const b = el('button', 'life-tab', t(`life.tab.${id}`));
    b.type = 'button';
    b.id = `life-tab-${id}`;
    b.dataset.tab = id;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'life-view');
    b.addEventListener('click', () => goTab(id));
    els.tabs.append(b);
  }
  paintTabs();
}

function paintTabs() {
  for (const b of els.tabs.querySelectorAll('.life-tab')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  els.view.setAttribute('aria-labelledby', `life-tab-${tab}`);
  // The budget period means nothing on the Body and Habits tabs (always
  // today); the Year tab has its own year switch.
  els.month.hidden = tab === 'body' || tab === 'year' || tab === 'habits';
}

function goTab(id) {
  tab = id;
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    // Storage unavailable: the tab just is not remembered.
  }
  paintTabs();
  renderView();
  els.view.scrollTop = 0;
}

function renderView() {
  const state = getState();
  if (!els || !state) return;
  const render = TABS.find(([id]) => id === tab)[1];
  render(els.view, state);
}

// --- month switch -------------------------------------------------------------

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function renderMonth() {
  const state = getState();
  if (!els || !state) return;
  const s = state.summary;
  const label = el('span', 'life-month__label');
  label.append(el('span', 'life-month__name', monthLabel(s.month, 'long')), el('span', 'life-month__range', `${shortDate(s.period.start)} – ${shortDate(s.period.end)}`));
  const go = (n) => () => setMonth(shiftMonth(s.month, n));
  const parts = [iconButton('◀', 'life.month.prev', go(-1)), label, iconButton('▶', 'life.month.next', go(1))];
  if (!s.period.isCurrent) {
    const back = el('button', 'life-btn', t('life.month.today'));
    back.type = 'button';
    back.addEventListener('click', () => setMonth(null));
    parts.push(back);
  }
  els.month.replaceChildren(...parts);
  els.month.classList.toggle('is-other', !s.period.isCurrent);
}

// --- daily prompts + live score ---------------------------------------------------

let promptKind = '';

/**
 * The check-in prompt on the first open of a day, else the goals prompt on
 * the first open of an ISO week. Rebuilt only when WHICH prompt shows
 * changes, so a background refresh never wipes what is being typed.
 */
function renderPrompt() {
  if (!els) return;
  const d = getDaily();
  const kind = needsCheckin(d.checkin) ? 'checkin' : needsGoals(d.goals) ? 'goals' : '';
  if (kind === promptKind) return;
  promptKind = kind;
  els.prompt.hidden = !kind;
  els.prompt.replaceChildren(...(kind === 'checkin' ? [checkinPrompt()] : kind === 'goals' ? [goalsPrompt()] : []));
}

/** A daily answer arrived: the score swaps its two nodes in place; the rest redraws its tab. */
function onDailyPart(part) {
  if (part === 'checkin' || part === 'goals') {
    renderPrompt();
    if (tab === 'overview') renderView();
    return;
  }
  if (part === 'habits') {
    if (tab === 'habits') renderView();
    return;
  }
  const card = document.getElementById('life-score-card');
  if (card) card.replaceWith(scoreCard());
  const strip = document.getElementById('life-now-strip');
  if (strip) strip.replaceWith(nowStrip());
}

// --- shell ----------------------------------------------------------------------

function onTabKey(e) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const i = TABS.findIndex(([id]) => id === tab);
  let next;
  if (e.key === 'ArrowLeft') next = (i + TABS.length - 1) % TABS.length;
  else if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
  else next = e.key === 'Home' ? 0 : TABS.length - 1;
  goTab(TABS[next][0]);
  els.tabs.querySelector(`[data-tab="${TABS[next][0]}"]`).focus();
  e.preventDefault();
}

function build() {
  els = {
    tabs: document.getElementById('life-tabs'),
    month: document.getElementById('life-month'),
    quick: document.getElementById('life-quick'),
    view: document.getElementById('life-view'),
    prompt: document.createElement('div'),
  };
  els.prompt.className = 'life-prompt';
  els.prompt.hidden = true;
  els.view.before(els.prompt);
  onDaily(onDailyPart);
  bindStatus(document.getElementById('life-status'), document.getElementById('life-toast'));
  buildTabs();
  mountQuick(els.quick);
  onState(() => {
    renderMonth();
    renderView();
  });
  // Arrow keys move between tabs (roving tabindex, like a native tab strip).
  els.tabs.addEventListener('keydown', onTabKey);
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
  focusQuick();
  startLive();
  await Promise.all([loadBudget(), loadDaily()]);
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  stopLive();
  hideToast();
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
  // Reminders are about today, so they always read the current period - and
  // without redrawing the panel, which may hold a half-typed form.
  if (typeof Notification === 'undefined') return;
  const res = await peekBudget();
  if (!res.ok) return;
  const day = new Date().toDateString();
  const seen = readReminded();
  const due = billsNeedingAttention(res.summary).filter((b) => seen[`${b.id}:${b.dueDate}`] !== day);
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
  buildTabs();
  relabelQuick();
  renderMonth();
  renderView();
  promptKind = '';
  renderPrompt();
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
