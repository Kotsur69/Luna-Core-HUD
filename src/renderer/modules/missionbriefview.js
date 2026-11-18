// ============================================================================
// LunaCore - weekly / daily brief card (renderer, W6)
// ----------------------------------------------------------------------------
// Mounted in the notification hub drawer's Briefs section (hubpanel.js; it
// left Mission Control in hub slice N3, so MC's columns get the full height).
// Data from src/missionbrief.js via mission:brief*: the weekly brief (made on its own, once per ISO week) and
// the daily brief, which only the 'Brief me' button makes. Each shows its
// headline, priorities, events with weather, to-dos, mail that needs a call,
// news, the call's cost and a history picker. A brief whose model answer was
// unusable shows its inputs instead. Regenerate asks first (main answers
// 'exists' until the overwrite is confirmed). The weekly card links to the
// Sunday review on the Life dashboard's Week tab. textContent only.
//
// Layout (reportvisuals.js): headline, a row of stat tiles (commits, events,
// open to-dos, mail, goals, Claude hours), commits-per-repo bars, the
// weekend's Claude work/fun split and goal chips; then each list as a
// <details> section with a count (priorities, calendar and mail open, the
// rest folded). The meta line with the call's cost stays last, via cost().
// ============================================================================

'use strict';

import { t } from './util.js';
import { openLifeTab } from './lifepanel.js';
import {
  barList,
  briefClaudeSplit,
  briefGoals,
  briefRepoBars,
  briefStats,
  caption,
  chip,
  details,
  goalTone,
  stackBar,
  statTiles,
} from './reportvisuals.js';
import { reportModelText, reportCost, reportFailure, choiceOptions } from './reportmodelview.js';
import { errorText } from './missionshared.js';

let view = null;
let pending = null; // kind waiting for an overwrite confirm
let running = null;
let rootEl = null;
let shown = 'daily';

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(() => ({ ok: false, reason: 'ipc' }));

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(label, onClick, cls = 'mc-btn') {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const cost = (usd) => (typeof usd === 'number' ? `$${usd < 0.1 ? usd.toFixed(4) : usd.toFixed(2)}` : '');

function errText(reason) {
  const key = `mc.brief.err.${reason}`;
  const text = t(key);
  return text === key ? t('mc.brief.err.failed') : text;
}

const list = (v) => (Array.isArray(v) ? v : []);
// Sections open on first sight: what needs a decision today. The rest folds.
const OPEN_SECTIONS = new Set(['mc.brief.priorities', 'mc.brief.events', 'mc.brief.mail']);
const MAX_RAW_TODOS = 8;
const RAIN_WARN_PCT = 50;
const GOAL_WORD = { ok: 'done', warn: 'partly', muted: 'notyet' };

/** Weather as one short chip text ('4-9°C · 60%'), or '' without data. */
function weatherText(w) {
  if (!w || !Number.isFinite(w.tMin) || !Number.isFinite(w.tMax)) return '';
  return `${w.tMin}-${w.tMax}°C${Number.isFinite(w.rain) ? ` · ${w.rain}%` : ''}`;
}

function startText(ev) {
  if (ev.allDay) return String(ev.start || '');
  const d = new Date(ev.start);
  return Number.isNaN(d.getTime()) ? String(ev.start || '') : d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** One calendar row: time, title, a weather chip (heavy rain warns) and the brief's note. */
function eventRow(ev, note) {
  const li = el('li', 'mission-brief__event');
  if (!ev) {
    li.append(el('span', 'mission-brief__what', note || ''));
    return li;
  }
  li.append(el('span', 'mission-brief__when', startText(ev)), el('span', 'mission-brief__what', ev.title || ''));
  const weather = weatherText(ev.weather);
  if (weather) li.append(chip(weather, Number.isFinite(ev.weather.rain) && ev.weather.rain >= RAIN_WARN_PCT ? 'warn' : 'info'));
  if (note) li.append(el('span', 'mission-brief__note', note));
  return li;
}

/** "project: text" rows with the project as a chip. */
function todoRow(project, text) {
  const li = el('li', 'mission-brief__todo');
  li.append(chip(project, 'muted'), el('span', '', text));
  return li;
}

function mailRow(m) {
  const li = el('li', 'mission-brief__mail');
  li.append(el('span', 'mission-brief__from', m.from || ''), el('span', 'mission-brief__subject', m.subject || ''));
  if (m.why) li.append(el('span', 'mission-brief__note', m.why));
  return li;
}

/** A folding section of rows (strings or <li> nodes); none -> null. */
function section(titleKey, rows, listTag = 'ul') {
  const items = list(rows).filter((r) => r !== null && r !== undefined && r !== '');
  if (!items.length) return null;
  const ul = el(listTag, 'mission-brief__list');
  for (const row of items) ul.append(typeof row === 'string' ? el('li', '', row) : row);
  return details(t(titleKey), items.length, [ul], { open: OPEN_SECTIONS.has(titleKey), cls: 'mission-brief__part' });
}

function goalChips(goals) {
  const ul = el('ul', 'rv-chips');
  ul.setAttribute('aria-label', t('rv.brief.goals'));
  for (const g of goals) {
    const tone = goalTone(g.status);
    const li = el('li');
    li.append(chip(`${g.text} - ${t(`rv.goal.${GOAL_WORD[tone]}`)}`, tone));
    ul.append(li);
  }
  return ul;
}

/** Tiles, commits-per-repo bars, the weekend's Claude split and goal chips. */
function visuals(entry) {
  const parts = [statTiles(briefStats(entry), t('rv.brief.stats'))];
  const bars = barList(briefRepoBars(entry), t('rv.brief.byRepo'));
  if (bars) parts.push(caption(t('rv.brief.byRepo')), bars);
  const split = stackBar(briefClaudeSplit(entry), t('rv.brief.claudeSplit'));
  if (split) parts.push(caption(t('rv.brief.claudeSplit')), split);
  const goals = briefGoals(entry);
  if (goals.length) parts.push(caption(t('rv.brief.goals')), goalChips(goals));
  return parts.filter(Boolean);
}

function body(entry) {
  const box = el('div', 'mission-brief__body');
  const inputs = entry.inputs || {};
  const events = list(inputs.events);
  const b = entry.brief;
  if (b) {
    box.append(el('p', 'mission-brief__headline', b.headline));
    box.append(...visuals(entry));
    if (b.weekend) box.append(el('p', 'mission-brief__lead', b.weekend));
    if (b.nudge) {
      const nudge = el('p', 'mission-brief__nudge');
      nudge.append(chip(t('rv.brief.nudge'), 'warn'), el('span', '', b.nudge));
      box.append(nudge);
    }
    const byKey = new Map(events.map((e) => [e.key, e]));
    const parts = [
      section('mc.brief.priorities', b.priorities, 'ol'),
      section('mc.brief.events', list(b.events).map((x) => eventRow(byKey.get(x.key), x.note))),
      section('mc.brief.mail', list(b.mail).map(mailRow)),
      section('mc.brief.todos', list(b.todos).map((x) => todoRow(x.project, x.text))),
      section('mc.brief.news', b.news),
    ];
    box.append(...parts.filter(Boolean));
  } else {
    const fail = el('p', 'mission-brief__fail');
    fail.append(chip(t('rv.brief.rawChip'), 'bad'), el('span', 'hint', t('mc.brief.raw', { reason: entry.failure || 'bad-json' })));
    box.append(fail, ...visuals(entry));
    const todos = inputs.todos && Array.isArray(inputs.todos.projects) ? inputs.todos.projects.flatMap((p) => list(p.items).map((x) => todoRow(p.project, x))) : [];
    const parts = [section('mc.brief.events', events.map((e) => eventRow(e, ''))), section('mc.brief.todos', todos.slice(0, MAX_RAW_TODOS))];
    box.append(...parts.filter(Boolean));
  }
  // A call that failed says which provider failed (agy is never retried on Claude).
  const failed = reportFailure(entry);
  if (failed) box.append(el('p', 'hint is-fail', `${failed.provider}: ${errorText(failed.reason)}`));
  const meta = [t('mc.brief.made', { at: when(entry.at), model: reportModelText(entry.model) })];
  const costLine = reportCost(entry, cost);
  if (costLine) meta.push(t('mc.brief.cost', { cost: costLine }));
  box.append(el('p', 'hint', meta.join(' · ')));
  return box;
}

async function load(req = {}) {
  const res = await call('missionBrief', req.weekly, req.daily);
  if (res.ok) {
    // First look: the weekly brief (made on its own) until a daily one exists.
    if (!view && !res.daily.entry) shown = 'weekly';
    view = res;
  }
  draw(res.ok ? '' : errText(res.reason));
}

async function run(kind, overwrite) {
  if (running) return;
  running = kind;
  pending = null;
  shown = kind;
  draw(t('mc.brief.working'));
  const res = await call('missionBriefRun', kind, overwrite);
  running = null;
  if (res.ok) {
    view = res;
    draw('');
  } else if (res.reason === 'exists') {
    pending = kind;
    draw('');
  } else {
    draw(errText(res.reason));
  }
}

function controls() {
  const bar = el('div', 'mission-brief__bar');
  for (const kind of ['daily', 'weekly']) {
    const tabBtn = btn(t(`mc.brief.${kind}`), () => {
      shown = kind;
      pending = null;
      draw('');
    }, `mc-btn mission-brief__tab${shown === kind ? ' is-on' : ''}`);
    tabBtn.setAttribute('aria-pressed', String(shown === kind));
    bar.append(tabBtn);
  }
  const part = view && view[shown];
  if (part && part.keys.length > 1) {
    const pick = el('select', 'mc-input');
    pick.setAttribute('aria-label', t('mc.brief.history'));
    for (const k of part.keys) {
      const o = el('option', '', k);
      o.value = k;
      pick.append(o);
    }
    if (part.entry) pick.value = part.entry.key;
    pick.addEventListener('change', () => load({ [shown]: pick.value }));
    bar.append(pick);
  }
  if (pending === shown) {
    bar.append(btn(t('mc.brief.overwrite'), () => run(shown, true), 'mc-btn mc-danger'), btn(t('mc.brief.cancel'), () => {
      pending = null;
      draw('');
    }));
  } else {
    const label = shown === 'daily' ? (part && part.entry ? t('mc.brief.regenerate') : t('mc.brief.briefMe')) : t('mc.brief.regenerate');
    const go = btn(label, () => run(shown, false), 'mc-btn pad-send');
    go.disabled = Boolean(running);
    bar.append(go);
  }
  if (shown === 'weekly') {
    // The Life dashboard is a modal above the (non-modal) hub drawer.
    bar.append(btn(t('mc.brief.review'), () => openLifeTab('week')));
  }
  if (view) {
    const model = el('select', 'mc-input');
    model.setAttribute('aria-label', t('mc.brief.model'));
    // Same store as Settings -> AI and models -> Report models; main sends the live choices.
    for (const [value, label] of choiceOptions(view.models)) {
      const o = el('option', '', label);
      o.value = value;
      model.append(o);
    }
    model.value = view.model;
    model.addEventListener('change', async () => {
      const res = await call('missionBriefModel', model.value);
      if (res.ok) view = res;
    });
    bar.append(model);
  }
  return bar;
}

function draw(status) {
  if (!rootEl) return;
  const parts = [controls()];
  if (status) parts.push(el('p', 'hint mc-status', status));
  const entry = view && view[shown] ? view[shown].entry : null;
  if (entry) parts.push(body(entry));
  else if (view && !running) parts.push(el('p', 'hint', t(shown === 'daily' ? 'mc.brief.noneDaily' : 'mc.brief.noneWeekly')));
  rootEl.replaceChildren(...parts);
}

/** Renders the brief into `root` and reads the newest briefs (no model call). */
export function showBrief(root) {
  rootEl = root;
  root.hidden = false;
  draw('');
  load();
}
