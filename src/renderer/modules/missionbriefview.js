// ============================================================================
// LunaCore - Mission Control: weekly / daily brief card (renderer, W6)
// ----------------------------------------------------------------------------
// Its own tall overlay, opened by the 'Brief' button in Mission Control's top
// bar (src/missionbrief.js via mission:brief*): the weekly brief (made on its own, once per ISO week) and
// the daily brief, which only the 'Brief me' button makes. Each shows its
// headline, priorities, events with weather, to-dos, mail that needs a call,
// news, the call's cost and a history picker. A brief whose model answer was
// unusable shows its inputs instead. Regenerate asks first (main answers
// 'exists' until the overwrite is confirmed). The weekly card links to the
// Sunday review on the Life dashboard's Week tab. textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { openLifeTab } from './lifepanel.js';
import { createTallOverlay } from './talloverlay.js';

let overlay = null;
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

function eventLine(ev, note) {
  const w = ev.weather;
  const weather = w ? ` · ${w.tMin}-${w.tMax}°C${w.rain !== null && w.rain !== undefined ? ` · ${w.rain}%` : ''}` : '';
  const start = ev.allDay ? ev.start : new Date(ev.start).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return `${start} - ${ev.title}${weather}${note ? ` - ${note}` : ''}`;
}

function section(titleKey, lines) {
  if (!lines.length) return null;
  const box = el('div', 'mission-brief__part');
  box.append(el('h4', 'mission-brief__sub', t(titleKey)));
  const ul = el('ul', 'mission-brief__list');
  for (const line of lines) ul.append(el('li', '', line));
  box.append(ul);
  return box;
}

function body(entry) {
  const box = el('div', 'mission-brief__body');
  const inputs = entry.inputs || {};
  const events = Array.isArray(inputs.events) ? inputs.events : [];
  const b = entry.brief;
  if (b) {
    box.append(el('p', 'mission-brief__headline', b.headline));
    if (b.weekend) box.append(el('p', '', b.weekend));
    if (b.nudge) box.append(el('p', 'hint mission-brief__nudge', b.nudge));
    const byKey = new Map(events.map((e) => [e.key, e]));
    const parts = [
      section('mc.brief.priorities', b.priorities),
      section('mc.brief.events', b.events.map((x) => eventLine(byKey.get(x.key), x.note))),
      section('mc.brief.todos', b.todos.map((x) => `${x.project}: ${x.text}`)),
      section('mc.brief.mail', b.mail.map((m) => `${m.from} - ${m.subject}${m.why ? ` (${m.why})` : ''}`)),
      section('mc.brief.news', b.news),
    ];
    box.append(...parts.filter(Boolean));
  } else {
    box.append(el('p', 'hint is-fail', t('mc.brief.raw', { reason: entry.failure || 'bad-json' })));
    const todos = inputs.todos && Array.isArray(inputs.todos.projects) ? inputs.todos.projects.flatMap((p) => p.items.map((x) => `${p.project}: ${x}`)) : [];
    const parts = [section('mc.brief.events', events.map((e) => eventLine(e, ''))), section('mc.brief.todos', todos.slice(0, 8))];
    box.append(...parts.filter(Boolean));
  }
  const meta = [t('mc.brief.made', { at: when(entry.at), model: entry.model })];
  if (cost(entry.costUsd)) meta.push(t('mc.brief.cost', { cost: cost(entry.costUsd) }));
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
    bar.append(btn(t('mc.brief.review'), () => {
      // The Life dashboard would open under this overlay otherwise.
      if (overlay) overlay.close();
      openLifeTab('week');
    }));
  }
  if (view) {
    const model = el('select', 'mc-input');
    model.setAttribute('aria-label', t('mc.brief.model'));
    for (const m of view.models) {
      const o = el('option', '', m);
      o.value = m;
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

/** Mission Control's 'Brief' button: the brief in its own tall overlay. */
export function openBriefOverlay() {
  if (!overlay) {
    overlay = createTallOverlay({ id: 'mission-brief-overlay', glyph: '◎', titleKey: 'mc.brief.overlayTitle' });
    const root = document.createElement('div');
    root.className = 'mission-brief mission-brief--overlay';
    root.setAttribute('aria-live', 'polite');
    overlay.body.append(root);
    rootEl = root;
  }
  overlay.open();
  showBrief(rootEl);
}
