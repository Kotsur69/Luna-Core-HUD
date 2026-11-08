// ============================================================================
// LunaCore - notification hub: the right drawer (renderer, N3)
// ----------------------------------------------------------------------------
// Docked to the right edge, full window height, ~420 px wide and resizable
// from its left edge (width saved as hubWidth in ui.local.json). Not a modal:
// no backdrop, no focus trap, the terminal stays usable next to it. Built in
// JS and appended to <body> on first open. Esc closes it only while focus is
// inside it (the terminal owns Esc otherwise).
//
// Sections: Needs you (kind 'needs'), Briefs (kind 'brief' plus the weekly /
// daily brief from missionbriefview.js, moved out of Mission Control) and
// Recent (info items plus what was marked done in the last 7 days; collapsed
// by default). One card per item: its single primary button, "Mark done",
// a relative time and a "from <machine>" chip.
//
// Item text comes from main (src/hub.js) already cleaned; it is rendered with
// textContent only. A primary action is a whitelisted NAME resolved here to
// IPC that already exists - an unknown name renders no button.
// ============================================================================

'use strict';

import { t, machineLabel } from './util.js';
import { onLangChange } from './bus.js';
import { closeWithExit, cancelExit } from './motion.js';
import { onHubView, markHubDone, markHubSeen } from './hubstate.js';
import { showBrief } from './missionbriefview.js';
import { openLifeTab } from './lifepanel.js';
import { openSettingsAt } from './termcustom.js';
import { openRunSummary } from './godmodesummary.js';

const WIDTH_DEFAULT = 420;
const WIDTH_MIN = 320;
const WIDTH_MAX = 900;
const WIDTH_STEP = 16;
/** The rest of the window the drawer must always leave for the terminal. */
const KEEP_FREE_PX = 160;
const TICK_MS = 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(() => ({ ok: false, reason: 'ipc' }));
/** openRunSummary's arg: '<machine>:<runId>' (main checks the same shape in src/hub.js). */
const RUN_SUMMARY_ARG_RE = /^([A-Za-z0-9-]{1,63}):([a-z0-9]{1,40})$/;

/**
 * N8: a God Mode run's summary window (godmodesummary.js), for a run of this
 * PC or another one. Main looks the run up again by machine + id (inbox:run)
 * and opens PR links itself - nothing from the item is executed.
 */
function runSummary(arg) {
  const m = RUN_SUMMARY_ARG_RE.exec(typeof arg === 'string' ? arg : '');
  if (!m) return null;
  return openRunSummary(m[1], m[2]);
}

/**
 * Whitelisted action name -> what the primary button does: (arg, item).
 * item.project scopes an orchestra call to that project's run (one God Mode
 * run per project); without it main uses the active tab's run.
 */
const ACTIONS = {
  openReport: (arg, item) => call('openOrchestraReport', arg, item.project),
  cancelPower: (arg, item) => call('cancelOrchestraPower', arg, item.project),
  cancelPlanWait: (_arg, item) => call('cancelOrchestraPlanWait', item.project),
  openTab: (arg) => call('activateSession', arg),
  openLife: (arg) => openLifeTab(arg),
  // Loaded on use: missionpanel.js pulls in the widget host, which imports this chain.
  openMission: () => import('./missionpanel.js').then((m) => m.openMission()),
  openSettings: (arg) => openSettingsAt(arg),
  installUpdate: () => call('installUpdate'),
  openRunSummary: (arg) => runSummary(arg),
};

let drawer = null;
let els = null;
let briefRoot = null;
let isOpen = false;
let returnFocus = null;
let width = WIDTH_DEFAULT;
let tick = null;
let lastView = { items: [], done: [], needs: 0 };
let lastFailed = false;
const failedMarks = new Set();
const openListeners = new Set();

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** "5 min ago" / "in 2 h" in the UI language. */
function relTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(window.i18n.lang || 'en', { numeric: 'auto', style: 'short' });
  if (abs >= DAY) return rtf.format(Math.round(diff / DAY), 'day');
  if (abs >= HOUR) return rtf.format(Math.round(diff / HOUR), 'hour');
  return rtf.format(Math.round(diff / MINUTE), 'minute');
}

const timeText = (at, done) => (done ? t('hub.doneAt', { when: relTime(at) }) : relTime(at));

/** The minute tick: only the <time> texts change, so focus and scroll stay put. */
function refreshTimes() {
  if (!drawer) return;
  for (const time of drawer.querySelectorAll('.hub-card__time')) {
    time.textContent = timeText(Number(time.dataset.at), time.dataset.done === '1');
  }
}

/** True while a palette or Settings-style overlay (z 100) sits above the drawer. */
const modalOnTop = () => Boolean(document.querySelector('.palette:not([hidden]), .termcustom:not([hidden])'));

/** A localized line for an item key, or the English fallback main sent. */
function localized(key, vars, fallback) {
  if (!key) return fallback || '';
  const values = vars && typeof vars === 'object' ? vars : {};
  // An empty var would leave a dangling " - " in the template: use the fallback.
  if (Object.values(values).some((v) => v === '')) return fallback || '';
  const text = t(key, values);
  return text === key ? fallback || '' : text;
}

/** An item's title in the UI language (the drawer card, the OS toast). */
export const itemTitle = (item) => localized(item.key, item.vars, item.title);

async function runPrimary(item, btn) {
  const fn = Object.prototype.hasOwnProperty.call(ACTIONS, item.primary.action) ? ACTIONS[item.primary.action] : null;
  if (!fn) return;
  btn.disabled = true;
  try {
    await fn(item.primary.arg, item);
  } finally {
    btn.disabled = false;
  }
}

async function markDone(item, btn) {
  btn.disabled = true;
  const res = await markHubDone(item.id);
  if (res.ok) failedMarks.delete(item.id);
  else failedMarks.add(item.id);
  btn.disabled = false;
  if (!res.ok) render();
}

function chip(text, cls = '') {
  return el('span', `hub-card__chip${cls ? ` ${cls}` : ''}`, text);
}

function card(item, { done = false } = {}) {
  const box = el('article', `hub-card hub-card--${item.kind}${done ? ' is-done' : ''}`);
  box.append(el('p', 'hub-card__title', localized(item.key, item.vars, item.title)));
  const detail = localized(item.detailKey, item.vars, item.detail);
  if (detail) box.append(el('p', 'hub-card__detail', detail));
  const meta = el('div', 'hub-card__meta');
  const at = done ? item.doneAt : item.at;
  const time = el('time', 'hub-card__time', timeText(at, done));
  if (Number.isFinite(at)) time.dateTime = new Date(at).toISOString();
  time.dataset.at = String(at);
  if (done) time.dataset.done = '1';
  meta.append(time);
  if (item.machine) meta.append(chip(t('hub.from', { machine: machineLabel(item.machine) })));
  if (item.local) meta.append(chip(t('hub.thisPc'), 'is-local'));
  box.append(meta);
  if (done) return box;
  const actions = el('div', 'hub-card__actions');
  const primary = item.primary;
  if (primary && Object.prototype.hasOwnProperty.call(ACTIONS, primary.action)) {
    const go = button(t(`hub.action.${primary.action}`), 'hub-btn hub-btn--primary', () => runPrimary(item, go));
    actions.append(go);
  }
  const doneBtn = button(t('hub.markDone'), 'hub-btn', () => markDone(item, doneBtn));
  actions.append(doneBtn);
  box.append(actions);
  if (failedMarks.has(item.id)) box.append(el('p', 'hub-card__error', t('hub.markFailed')));
  return box;
}

function section(titleKey, count) {
  const sec = el('section', 'hub-sec');
  const head = el('h3', 'hub-sec__head');
  head.append(el('span', '', t(titleKey)));
  if (count) head.append(el('span', 'hub-sec__count', String(count)));
  sec.append(head);
  return sec;
}

function render() {
  if (!els) return;
  // A push can replace the card that held focus (Mark done removes it): keep
  // focus inside the drawer so the keyboard and Esc keep working.
  const hadFocus = drawer.contains(document.activeElement);
  paint();
  if (hadFocus && !drawer.contains(document.activeElement)) drawer.focus();
}

function paint() {
  const { items, done } = lastView;
  const needs = items.filter((i) => i.kind === 'needs');
  const briefs = items.filter((i) => i.kind === 'brief');
  const info = items.filter((i) => i.kind === 'info');

  els.status.hidden = !lastFailed;
  els.status.textContent = lastFailed ? t('hub.failed') : '';

  const needsSec = section('hub.sec.needs', needs.length);
  needsSec.append(...(needs.length ? needs.map((i) => card(i)) : [el('p', 'hint hub-sec__empty', t('hub.sec.needsEmpty'))]));
  els.needs.replaceChildren(...needsSec.childNodes);

  // The brief root stays mounted across renders: only the item cards change.
  els.briefCards.replaceChildren(...briefs.map((i) => card(i)));
  els.briefHead.replaceChildren(el('span', '', t('hub.sec.briefs')));

  els.recentLabel.textContent = t('hub.sec.recent');
  els.recentCount.textContent = String(info.length + done.length);
  const recent = [...info.map((i) => card(i)), ...done.map((i) => card(i, { done: true }))];
  els.recentList.replaceChildren(...(recent.length ? recent : [el('p', 'hint hub-sec__empty', t('hub.sec.recentEmpty'))]));
}

function clampWidth(w) {
  const max = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, window.innerWidth - KEEP_FREE_PX));
  return Math.round(Math.min(Math.max(Number(w) || WIDTH_DEFAULT, WIDTH_MIN), max));
}

/** Sets the wanted width; the shown one is clamped to the current window. */
function applyWidth(w) {
  width = Math.round(Math.min(Math.max(Number(w) || WIDTH_DEFAULT, WIDTH_MIN), WIDTH_MAX));
  const shown = clampWidth(width);
  drawer.style.setProperty('--hub-w', `${shown}px`);
  els.handle.setAttribute('aria-valuenow', String(shown));
}

/** Re-clamps for a resized window without forgetting the wanted width. */
function fitWidth() {
  drawer.style.setProperty('--hub-w', `${clampWidth(width)}px`);
}

const saveWidth = () => call('setUiPrefs', { hubWidth: width });

/** Settings -> Notification hub -> reset width: back to the default, saved, applied if built. */
export function resetHubWidth() {
  width = WIDTH_DEFAULT;
  if (drawer) applyWidth(WIDTH_DEFAULT);
  return saveWidth();
}

function wireResize(handle) {
  let startX = 0;
  let startW = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = clampWidth(width);
    handle.setPointerCapture(e.pointerId);
    drawer.classList.add('is-resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    applyWidth(startW + (startX - e.clientX));
  });
  // lostpointercapture fires for pointerup, pointercancel AND a capture dropped
  // because the drawer was hidden mid-drag - so a drag always ends and saves.
  handle.addEventListener('lostpointercapture', () => {
    if (!drawer.classList.contains('is-resizing')) return;
    drawer.classList.remove('is-resizing');
    saveWidth();
  });
  handle.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? WIDTH_STEP : e.key === 'ArrowRight' ? -WIDTH_STEP : 0;
    if (!step) return;
    e.preventDefault();
    applyWidth(width + step);
    saveWidth();
  });
}

function label() {
  els.title.textContent = t('hub.title');
  drawer.setAttribute('aria-label', t('hub.title'));
  els.close.title = t('libraries.close');
  els.close.setAttribute('aria-label', t('libraries.close'));
  els.handle.setAttribute('aria-label', t('hub.resize'));
  els.handle.title = t('hub.resize');
}

function build() {
  drawer = el('aside', 'hub-drawer');
  drawer.id = 'hub-drawer';
  drawer.tabIndex = -1;
  drawer.hidden = true;

  const handle = el('div', 'hub-drawer__handle');
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-valuemin', String(WIDTH_MIN));
  handle.setAttribute('aria-valuemax', String(WIDTH_MAX));

  const bar = el('div', 'hub-drawer__bar');
  const title = el('h2', 'hub-drawer__title');
  const close = button('×', 'libraries__closebtn', () => closeHub());
  bar.append(title, close);

  const body = el('div', 'hub-drawer__body');
  const status = el('p', 'hint hub-drawer__status');
  status.setAttribute('role', 'status');
  const needs = el('section', 'hub-sec hub-sec--needs');
  const briefs = el('section', 'hub-sec hub-sec--briefs');
  const briefHead = el('h3', 'hub-sec__head');
  const briefCards = el('div', 'hub-sec__cards');
  briefRoot = el('div', 'mission-brief mission-brief--hub');
  briefRoot.setAttribute('aria-live', 'polite');
  briefs.append(briefHead, briefCards, briefRoot);
  const recent = el('details', 'hub-sec hub-sec--recent');
  const summary = el('summary', 'hub-sec__head');
  const recentLabel = el('span');
  const recentCount = el('span', 'hub-sec__count');
  summary.append(recentLabel, recentCount);
  const recentList = el('div', 'hub-sec__cards');
  recent.append(summary, recentList);
  body.append(status, needs, briefs, recent);

  drawer.append(handle, bar, body);
  els = { handle, title, close, status, needs, briefHead, briefCards, recentLabel, recentCount, recentList };
  wireResize(handle);
  drawer.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeHub();
  });
  document.body.append(drawer);
  applyWidth(width);
  label();
  call('getUiPrefs').then((prefs) => {
    if (prefs && Number.isInteger(prefs.hubWidth)) applyWidth(prefs.hubWidth);
  });
  window.addEventListener('resize', () => {
    if (isOpen) fitWidth();
  });
  onLangChange(() => {
    label();
    render();
  });
  onHubView((view, failed) => {
    lastView = view;
    lastFailed = failed;
    if (!isOpen) return;
    render();
    // What the open drawer shows counts as seen (the launch auto-open rule).
    markHubSeen();
  });
}

function emitOpen() {
  for (const fn of openListeners) fn(isOpen);
}

export function openHub() {
  if (isOpen) return;
  if (!drawer) build();
  cancelExit(drawer);
  isOpen = true;
  returnFocus = document.activeElement;
  fitWidth();
  render();
  markHubSeen();
  showBrief(briefRoot);
  drawer.hidden = false;
  // Not a modal: under a palette or Settings overlay it opens without taking
  // focus from that overlay's input.
  if (!modalOnTop()) drawer.focus();
  // Relative times go stale while the drawer stays open.
  tick = setInterval(refreshTimes, TICK_MS);
  emitOpen();
}

export function closeHub() {
  if (!isOpen) return;
  isOpen = false;
  clearInterval(tick);
  tick = null;
  drawer.classList.remove('is-resizing');
  closeWithExit(drawer);
  if (returnFocus && typeof returnFocus.focus === 'function' && drawer.contains(document.activeElement)) returnFocus.focus();
  returnFocus = null;
  emitOpen();
}

export function toggleHub() {
  if (isOpen) closeHub();
  else openHub();
}

/** fn(open) whenever the drawer opens or closes (the chip's aria-expanded). */
export function onHubOpenChange(fn) {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
}
