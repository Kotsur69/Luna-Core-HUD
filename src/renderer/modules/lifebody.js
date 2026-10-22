// ============================================================================
// LunaCore - Life dashboard: Body tab (renderer)
// ----------------------------------------------------------------------------
// YAZIO at a glance: calories left today, macros against their goals, steps,
// water, weight on its way from start to goal, and the last 7 days. The
// numbers come from life:body (src/lifeyazio.js - an UNOFFICIAL API, so a
// failure shows a reason and the last good numbers stay put).
//
// The body answer lives here, apart from the budget state in lifeui.js: the
// tab re-renders on every budget change, and that must never refetch YAZIO.
// The login goes one way - email + password to main, never back. The
// password field is cleared the moment the form is sent, whatever the
// outcome.
// ============================================================================

'use strict';

import { t, machineLabel } from './util.js';
import { el, bucket, button, armedButton, field, input, bar, lang } from './lifeui.js';
import { stackedBars } from './lifecharts.js';
import { kcalState, goalShare, weightProgress, weekStats } from './lifebodyview.js';

const KCAL_COLOR = 'var(--life-planned)';
const MACROS = [
  ['protein', 'var(--life-savings)'],
  ['fat', 'var(--life-free)'],
  ['carb', 'var(--life-fixed)'],
];

// An answer older than this is asked for again when the tab is on screen
// (main's own YAZIO cache is 5 minutes too, so a quick re-ask costs nothing).
const STALE_MS = 5 * 60 * 1000;

// {phase: idle|loading|ready, connected, data, reason, from}
// from = {machine} when data is another PC's copy (this PC is not logged in).
let body = { phase: 'idle', connected: false, data: null, reason: '', from: null };
let root = null;
// When the last answer arrived (not data.fetchedAt: another PC's copy can be old by nature).
let loadedAt = 0;
let watching = false;

const n0 = (n) => new Intl.NumberFormat(lang(), { maximumFractionDigits: 0 }).format(n);
const kg = (n) => `${new Intl.NumberFormat(lang(), { maximumFractionDigits: 1 }).format(n)} kg`;
const time = (ms) => new Intl.DateTimeFormat(lang(), { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const weekday = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat(lang(), { weekday: 'short' }).format(new Date(y, m - 1, d));
};

function errText(reason) {
  const key = `life.body.err.${reason}`;
  const text = t(key);
  return text === key ? t('life.body.err.failed') : text;
}

/** Redraws only while the Body tab is the one on screen. */
function redraw() {
  if (root && root.querySelector('.life-body')) draw();
}

async function load(force) {
  body = { ...body, phase: 'loading' };
  redraw();
  const res = await window.lunacore.lifeBody(force).catch(() => ({ ok: false, connected: body.connected, reason: 'ipc' }));
  body = res.ok
    ? { phase: 'ready', connected: res.connected, data: res.body || null, reason: '', from: res.from || null }
    : { ...body, phase: 'ready', connected: res.connected !== false, reason: res.reason };
  loadedAt = Date.now();
  redraw();
}

/** Re-asks main when the Body tab is visible and the answer is stale. */
function refreshIfStale() {
  // offsetParent is null while the Life panel (or the window) is hidden.
  const onScreen = root && root.offsetParent !== null && root.querySelector('.life-body') && document.visibilityState === 'visible';
  if (onScreen && body.phase === 'ready' && Date.now() - loadedAt >= STALE_MS) load(false);
}

/** Once per app run: a timer and a back-in-view check keep an open Body tab current. */
function watch() {
  if (watching) return;
  watching = true;
  setInterval(refreshIfStale, STALE_MS);
  document.addEventListener('visibilitychange', refreshIfStale);
  window.addEventListener('focus', refreshIfStale);
}

// --- not connected ----------------------------------------------------------------

function connectCard() {
  const card = bucket('life.body.connect', 'life-body__connect');
  const form = el('form', 'life-form');
  const email = input({ type: 'email', maxlength: '254', autocomplete: 'off' });
  const password = input({ type: 'password', maxlength: '200', autocomplete: 'off' });
  const go = el('button', 'pad-send life-form__go', t('life.body.connectGo'));
  go.type = 'submit';
  const row = el('div', 'life-form__row');
  row.append(field('life.body.email', email, 'life-field--grow'), field('life.body.password', password, 'life-field--grow'));
  const note = el('p', 'life-body__note');
  note.setAttribute('aria-live', 'polite');
  form.append(row, go, note);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    note.textContent = t('life.body.connecting');
    note.classList.remove('is-bad');
    const secret = password.value;
    password.value = '';
    const res = await window.lunacore.lifeBodyConnect(email.value, secret).catch(() => ({ ok: false, reason: 'ipc' }));
    go.disabled = false;
    if (!res.ok) {
      note.textContent = errText(res.reason);
      note.classList.add('is-bad');
      password.focus();
      return;
    }
    body = { phase: 'loading', connected: true, data: null, reason: res.persisted ? '' : 'memory-only' };
    const memoryOnly = body.reason;
    await load(false);
    if (memoryOnly && !body.reason) {
      body = { ...body, reason: memoryOnly };
      redraw();
    }
  });
  card.body.append(el('p', 'hint', t('life.body.connectHint')), form, el('p', 'hint', t('life.body.privacy')));
  return card.sec;
}

// --- connected --------------------------------------------------------------------

function headRow() {
  const row = el('div', 'life-body__head');
  const meta = el('p', 'life-body__meta');
  if (body.phase === 'loading') meta.textContent = t('life.body.loading');
  else if (body.data) meta.textContent = t('life.body.updated', { time: time(body.data.fetchedAt) });
  const refresh = button('life.body.refresh', () => load(true));
  refresh.disabled = body.phase === 'loading';
  const off = armedButton('life.body.disconnect', async () => {
    await window.lunacore.lifeBodyDisconnect().catch(() => null);
    body = { phase: 'ready', connected: false, data: null, reason: '' };
    redraw();
  });
  const acts = el('div', 'life-body__acts');
  acts.append(refresh, off);
  row.append(meta, acts);
  return row;
}

function hero(d) {
  const k = kcalState(d.kcal, d.kcalGoal);
  const box = el('section', 'life-hero life-body__hero');
  box.setAttribute('aria-label', t('life.body.kcalLeft'));
  const over = k.status === 'over';
  box.append(el('p', 'life-hero__label', t(over ? 'life.body.kcalOver' : 'life.body.kcalLeft')));
  box.append(el('p', `life-hero__big${over ? ' is-bad' : ''}`, `${n0(Math.abs(k.left))} kcal`));
  box.append(el('p', 'life-hero__sub', t('life.body.kcalEaten', { kcal: n0(d.kcal), goal: n0(d.kcalGoal) })));
  box.append(bar(k.share, { over: 'is-bad', near: 'is-good' }[k.status] || '', k.status === 'under' ? KCAL_COLOR : ''));
  if (d.activityKcal) box.append(el('p', 'life-hero__math', t('life.body.activity', { kcal: n0(d.activityKcal) })));
  return box;
}

function macros(d) {
  const card = bucket('life.body.macros');
  const list = el('ul', 'life-list');
  for (const [key, color] of MACROS) {
    const g = goalShare(d[key], d[`${key}Goal`]);
    const li = el('li', 'life-cat');
    const head = el('div', 'life-cat__head');
    const name = el('span', 'life-cat__name');
    const dot = el('span', 'life-dot');
    dot.style.background = color;
    name.append(dot, document.createTextNode(t(`life.body.${key}`)));
    head.append(name, el('span', 'life-num', `${n0(d[key])} / ${n0(d[`${key}Goal`])} g`));
    li.append(head, bar(g.share, '', color));
    list.append(li);
  }
  card.body.append(list);
  return card.sec;
}

function kpi(labelKey, value, sub, hit) {
  const card = el('div', 'life-kpi');
  card.append(el('span', 'life-kpi__label', t(labelKey)), el('span', `life-kpi__value life-num${hit ? ' is-good' : ''}`, value));
  if (sub) card.append(el('span', 'life-kpi__sub', sub));
  return card;
}

function kpis(d, week) {
  const steps = goalShare(d.steps, d.stepsGoal);
  const water = goalShare(d.water, d.waterGoal);
  const row = el('div', 'life-kpis life-kpis--4');
  row.append(
    kpi('life.body.steps', n0(d.steps), t('life.body.ofGoal', { goal: n0(d.stepsGoal) }) + (steps.hit ? ` · ${t('life.body.hit')}` : ''), steps.hit),
    kpi('life.body.water', `${n0(d.water)} ml`, t('life.body.ofGoal', { goal: `${n0(d.waterGoal)} ml` }), water.hit),
    kpi('life.body.weight', d.weight === null ? '–' : kg(d.weight), d.weightGoal === null ? '' : t('life.body.goalWeight', { kg: kg(d.weightGoal) })),
    kpi('life.body.avgKcal', week.logged ? `${n0(week.avgKcal)} kcal` : '–', t('life.body.daysLogged', { n: week.logged }))
  );
  return row;
}

function history(data) {
  const card = bucket('life.body.week');
  const rows = data.history.map((h) => ({ label: weekday(h.date), values: { kcal: h.kcal } }));
  const goal = data.today.kcalGoal;
  card.body.append(
    stackedBars(rows, [{ key: 'kcal', color: KCAL_COLOR, label: 'kcal' }], {
      line: goal,
      fmt: n0,
      highlight: rows.length - 1,
      label: data.history.map((h) => `${weekday(h.date)}: ${n0(h.kcal)} kcal`).join(', '),
    }),
    el('p', 'life-total', t('life.body.goalLine', { goal: n0(goal) }))
  );
  // The same numbers as text, so the chart is never the only way to read them.
  const list = el('ul', 'life-list life-body__days');
  for (const h of [...data.history].reverse()) {
    const li = el('li', 'life-row life-row--plain');
    li.append(
      el('span', 'life-row__title', weekday(h.date)),
      el('span', 'life-num', t('life.body.dayLine', { kcal: n0(h.kcal), protein: n0(h.protein), steps: n0(h.steps) }))
    );
    list.append(li);
  }
  card.body.append(list);
  return card.sec;
}

function weightCard(data) {
  const d = data.today;
  const card = bucket('life.body.weightTitle');
  const p = weightProgress(d.startWeight, d.weight, d.weightGoal);
  if (!p) {
    card.body.append(el('p', 'hint', t('life.body.noWeight')));
    return card.sec;
  }
  const done = p.toGo === 0;
  card.body.append(
    el('p', 'life-body__big life-num', kg(d.weight)),
    bar(p.share, done ? 'is-good' : '', done ? '' : 'var(--life-savings)'),
    el('p', 'life-total', t('life.body.weightLine', { start: kg(d.startWeight), goal: kg(d.weightGoal), changed: `${p.changed > 0 ? '+' : ''}${kg(p.changed)}` })),
    el('p', 'life-cat__note', done ? t('life.body.weightDone') : t('life.body.toGo', { kg: kg(p.toGo) }))
  );
  if (data.lastWeighIn) card.body.append(el('p', 'hint', t('life.body.lastWeighIn', { date: data.lastWeighIn.date })));
  return card.sec;
}

function weekCard(data, week) {
  const card = bucket('life.body.thisWeek');
  const list = el('ul', 'life-list');
  const line = (key, vars) => {
    const li = el('li', 'life-row life-row--plain');
    li.append(el('span', 'life-row__title', t(key, vars)));
    list.append(li);
  };
  line('life.body.wkOnTarget', { n: week.onTarget, of: week.logged });
  line('life.body.wkProtein', { n: week.proteinHit, of: data.history.length });
  line('life.body.wkSteps', { steps: n0(week.avgSteps) });
  card.body.append(list);
  return card.sec;
}

/** Not logged in here: another PC's copy (read-only), then the login form. */
function peerView(wrap) {
  const row = el('div', 'life-body__head');
  const when = `${body.data.date} ${time(body.data.fetchedAt)}`;
  row.append(el('p', 'life-body__meta', t('life.body.fromPc', { machine: machineLabel(body.from.machine), time: when })));
  const refresh = button('life.body.refresh', () => load(false));
  refresh.disabled = body.phase === 'loading';
  const acts = el('div', 'life-body__acts');
  acts.append(refresh);
  row.append(acts);
  wrap.append(row);
  bodyCards(wrap);
  wrap.append(connectCard());
}

// --- shell ------------------------------------------------------------------------

function connectedView(wrap) {
  wrap.append(headRow());
  if (body.reason) {
    const memoryOnly = body.reason === 'memory-only';
    wrap.append(el('p', `life-body__alert${memoryOnly ? '' : ' is-bad'}`, memoryOnly ? t('life.body.memoryOnly') : errText(body.reason)));
  }
  if (!body.data) {
    if (body.phase === 'loading') wrap.append(el('p', 'hint', t('life.body.loading')));
    return;
  }
  bodyCards(wrap);
}

/** Every card for body.data - this PC's YAZIO or another PC's copy. */
function bodyCards(wrap) {
  const d = body.data.today;
  const week = weekStats(body.data.history, d.proteinGoal);
  const top = el('div', 'life-ov__top');
  top.append(hero(d), macros(d));
  const grid = el('div', 'life-grid');
  grid.append(history(body.data), weightCard(body.data), weekCard(body.data, week));
  wrap.append(top, kpis(d, week), grid);
}

function draw() {
  const wrap = el('div', 'life-body');
  if (body.phase === 'idle') wrap.append(el('p', 'hint', t('life.body.loading')));
  else if (!body.connected && body.data && body.from) peerView(wrap);
  else if (!body.connected) wrap.append(connectCard());
  else connectedView(wrap);
  root.replaceChildren(wrap);
}

/** Draws the Body tab into `target`; the first visit loads from YAZIO, later ones when stale. */
export function renderBody(target) {
  root = target;
  draw();
  watch();
  if (body.phase === 'idle') load(false);
  else refreshIfStale();
}
