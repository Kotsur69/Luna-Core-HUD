// ============================================================================
// LunaCore - Life dashboard: Week tab (renderer, W3+ phase 5)
// ----------------------------------------------------------------------------
// The weekly review (src/weeklyreview.js via life:week*): a history picker
// (last 12 ISO weeks), the review itself - headline, fun, work with open
// to-dos, Claude cost table, goal verdicts, 3 suggestions, do more / do less
// - the top correlations (src/lifecorrelate.js), the cost of the call, and
// the email state. A week whose model answer was unusable shows the raw
// numbers instead. The review text is the model's English; labels are
// localized. Everything is set with textContent.
//
// 'Generate now' spends one model call; over an existing week it asks first
// (main answers 'exists', the button turns into a confirm). 'Email it' sends
// that week's review now. weeklyMailCard() is the Life Settings toggle.
// ============================================================================

'use strict';

import { t } from './util.js';
import { el, bucket, button, select, setStatus, errText } from './lifeui.js';
import { classRows, mailLine, generateTargets, costText } from './lifeweekmodel.js';

let view = null;
let picked = null;
let pending = null; // week waiting for an overwrite confirm
let isBusy = false;

const call = (fn, ...args) => Promise.resolve().then(() => window.lunacore[fn](...args)).catch(() => ({ ok: false, reason: 'ipc' }));
const when = (ms) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function list(items, cls = 'life-list') {
  const ul = el('ul', cls);
  for (const text of items) ul.append(el('li', '', text));
  return ul;
}

// --- review parts ---------------------------------------------------------------------

function headCard(entry) {
  const card = bucket('life.week.title', 'life-week-head');
  if (!entry) {
    card.body.append(el('p', 'hint', t('life.week.none')));
    return card.sec;
  }
  card.body.append(el('p', 'life-week__range', t('life.week.range', { week: entry.week, from: entry.data ? entry.data.from : '', to: entry.data ? entry.data.to : '' })));
  if (entry.review) card.body.append(el('p', 'life-week__headline', entry.review.headline));
  else card.body.append(el('p', 'hint is-fail', t('life.week.raw', { reason: entry.failure || 'bad-json' })));
  const meta = [t('life.week.made', { at: when(entry.at), model: entry.model })];
  if (costText(entry.costUsd)) meta.push(t('life.week.cost', { cost: costText(entry.costUsd) }));
  card.body.append(el('p', 'hint', meta.join(' · ')));
  return card.sec;
}

function hoursCard(data) {
  const card = bucket('life.week.hours');
  const rows = classRows(data && data.hours);
  if (!rows.length) {
    card.body.append(el('p', 'hint', data && data.hours && data.hours.error ? t('life.week.unavailable') : t('life.week.noHours')));
    return card.sec;
  }
  card.body.append(el('p', 'life-total', t('life.week.totalH', { h: data.hours.totalH })));
  const bar = el('div', 'life-week__split');
  for (const r of rows) {
    const part = el('span', `life-week__seg is-${r.cls}`);
    part.style.flexGrow = String(r.share);
    part.title = `${t(`life.week.cls.${r.cls}`)}: ${r.hours} h`;
    bar.append(part);
  }
  card.body.append(bar, list(rows.map((r) => `${t(`life.week.cls.${r.cls}`)}: ${r.hours} h`), 'life-list life-week__legend'));
  return card.sec;
}

function reviewCards(r) {
  const out = [];
  if (r.fun.summary || r.fun.projects.length) {
    const c = bucket('life.week.fun');
    c.body.append(el('p', '', r.fun.summary));
    if (r.fun.projects.length) c.body.append(el('p', 'hint', r.fun.projects.join(' · ')));
    out.push(c.sec);
  }
  if (r.work.length) {
    const c = bucket('life.week.work');
    const ul = el('ul', 'life-list');
    for (const w of r.work) {
      const li = el('li', 'life-week__work');
      li.append(el('strong', '', w.project), el('span', '', ` - ${w.status}`));
      if (w.openTodos.length) li.append(list(w.openTodos.map((x) => `☐ ${x}`), 'life-list life-week__todos'));
      ul.append(li);
    }
    c.body.append(ul);
    out.push(c.sec);
  }
  if (r.goals.length) {
    const c = bucket('life.week.goals');
    const ul = el('ul', 'life-list');
    for (const g of r.goals) {
      const li = el('li', `life-goal is-${g.verdict === 'not yet' ? 'notyet' : g.verdict}`);
      li.append(el('span', 'life-goal__text', g.goal), el('span', 'life-week__verdict', t(`life.week.verdict.${g.verdict === 'not yet' ? 'notyet' : g.verdict}`)));
      if (g.evidence.length) li.append(el('p', 'hint', g.evidence.join(' · ')));
      ul.append(li);
    }
    c.body.append(ul);
    out.push(c.sec);
  }
  if (r.suggestions.length || r.doMore.length || r.doLess.length) {
    const c = bucket('life.week.next');
    if (r.suggestions.length) {
      const ol = el('ol', 'life-list');
      for (const s of r.suggestions) ol.append(el('li', '', s));
      c.body.append(ol);
    }
    if (r.doMore.length) c.body.append(el('h4', 'life-week__sub', t('life.week.doMore')), list(r.doMore));
    if (r.doLess.length) c.body.append(el('h4', 'life-week__sub', t('life.week.doLess')), list(r.doLess));
    out.push(c.sec);
  }
  return out;
}

function claudeCard(entry) {
  const c = bucket('life.week.claude');
  const data = entry.data && entry.data.claude;
  if (!data || data.error) {
    c.body.append(el('p', 'hint', t('life.week.unavailable')));
    return c.sec;
  }
  const rows = entry.review && entry.review.claudeTable.length ? entry.review.claudeTable.map((x) => ({ name: x.project, usd: x.usd, pct: x.pct })) : data.projects.slice(0, 8);
  c.body.append(el('p', 'life-total', t('life.week.claudeTotal', { usd: data.totalUsd.toFixed(2) })));
  const table = el('table', 'life-week__table');
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', '', r.name), el('td', 'life-num', `$${r.usd.toFixed(2)}`), el('td', 'life-num', `${r.pct}%`));
    table.append(tr);
  }
  c.body.append(table);
  return c.sec;
}

/** The raw numbers when the model answer was unusable. */
function rawCard(data) {
  const c = bucket('life.week.numbers');
  const lines = [];
  if (data && data.repos && !data.repos.error) for (const r of data.repos.repos) lines.push(`${r.repo}: ${r.commits} commits (+${r.added}/-${r.removed}, ${r.feat.length} feat, ${r.fix} fix)`);
  if (data && Array.isArray(data.goals)) for (const g of data.goals) lines.push(`${g.text} [${t(`life.goals.${g.status}`)}]`);
  if (data && data.todos && !data.todos.error) lines.push(t('life.week.openTodos', { n: data.todos.totalOpen }));
  if (data && data.budget && !data.budget.error) lines.push(t('life.week.spent', { now: data.budget.total, prev: data.budget.prevTotal }));
  if (data && data.checkin && !data.checkin.error) lines.push(t('life.week.checkin', { sleep: data.checkin.avgSleep ?? '?', energy: data.checkin.avgEnergy ?? '?' }));
  c.body.append(lines.length ? list(lines) : el('p', 'hint', t('life.week.unavailable')));
  return c.sec;
}

function correlationsCard(data) {
  const c = bucket('life.week.correlations');
  const items = data && Array.isArray(data.correlations) ? data.correlations : [];
  c.body.append(items.length ? list(items.map((x) => x.text)) : el('p', 'hint', t('life.week.noCorrelations')));
  return c.sec;
}

// --- actions ---------------------------------------------------------------------------

async function load(root, week) {
  const res = await call('lifeWeek', week);
  if (!res.ok) {
    setStatus(errText(res.reason), true);
    return;
  }
  view = res;
  picked = res.entry ? res.entry.week : null;
  draw(root);
}

async function generate(root, week, overwrite) {
  if (isBusy) return;
  isBusy = true;
  pending = null;
  setStatus(t('life.week.generating'));
  draw(root);
  const res = await call('lifeWeekGenerate', week, overwrite);
  isBusy = false;
  if (!res.ok && res.reason === 'exists') {
    pending = week;
    setStatus('');
  } else if (!res.ok) {
    setStatus(errText(res.reason), true);
  } else {
    setStatus('');
    view = res;
    picked = res.entry ? res.entry.week : week;
  }
  draw(root);
}

async function email(root, week) {
  if (isBusy) return;
  isBusy = true;
  setStatus(t('life.week.sending'));
  const res = await call('lifeWeekEmail', week);
  isBusy = false;
  if (res.ok) {
    view = res;
    setStatus(t('life.week.sentNow'));
  } else {
    setStatus(errText(res.reason), true);
    await load(root, week);
    return;
  }
  draw(root);
}

function toolbar(root) {
  const bar = el('div', 'life-form__row life-week__bar');
  if (view.weeks.length) {
    const pick = select(view.weeks.map((w) => [w.week, `${w.week}${w.ok ? '' : ' (raw)'}`]), picked || undefined);
    pick.setAttribute('aria-label', t('life.week.pick'));
    pick.addEventListener('change', () => load(root, pick.value));
    bar.append(pick);
  }
  for (const { week, exists } of generateTargets(view)) {
    if (pending === week) {
      bar.append(button('life.week.overwrite', () => generate(root, week, true), 'life-btn mc-danger'), button('life.cancel', () => {
        pending = null;
        draw(root);
      }));
      continue;
    }
    const label = week === view.current ? 'life.week.generateThis' : 'life.week.generateLast';
    const b = button(label, () => generate(root, week, false), exists ? 'life-btn' : 'pad-send life-btn');
    b.disabled = isBusy || view.busy;
    bar.append(b);
  }
  if (picked) {
    const m = button('life.week.email', () => email(root, picked));
    m.disabled = isBusy || !view.gmail.connected;
    bar.append(m);
  }
  const model = select(view.models.map((x) => [x, x]), view.model);
  model.setAttribute('aria-label', t('life.week.model'));
  model.addEventListener('change', async () => {
    const res = await call('lifeWeekModel', model.value, picked);
    if (res.ok) view = res;
    else setStatus(errText(res.reason), true);
  });
  bar.append(model);
  return bar;
}

function draw(root) {
  // The tab may have changed while an answer was on its way: never paint over another tab.
  if (!view || !root.isConnected) return;
  const entry = view.entry && (!picked || view.entry.week === picked) ? view.entry : null;
  const main = el('div', 'life-stack');
  main.append(headCard(entry));
  if (entry && entry.review) main.append(...reviewCards(entry.review));
  else if (entry) main.append(rawCard(entry.data));
  const side = el('div', 'life-stack');
  if (entry) {
    const line = mailLine(entry, view);
    side.append(hoursCard(entry.data), claudeCard(entry), correlationsCard(entry.data));
    const mail = bucket('life.week.mail.title');
    const vars = line.vars.at ? { at: when(line.vars.at) } : line.vars;
    mail.body.append(el('p', line.key === 'life.week.mail.failed' ? 'hint is-fail' : 'hint', t(line.key, vars)));
    side.append(mail.sec);
  }
  const grid = el('div', 'life-grid life-grid--2');
  grid.append(main, side);
  root.replaceChildren(toolbar(root), grid);
}

/** Renders the Week tab into `root` (the budget state is not used). */
export function renderWeek(root) {
  const box = el('div', 'life-week');
  root.replaceChildren(box);
  if (view) draw(box);
  else box.append(el('p', 'hint', t('life.loading')));
  load(box, picked);
}

/** Life Settings: the weekly email toggle (default on once Gmail is connected). */
export function weeklyMailCard() {
  const card = bucket('life.week.mail.setting');
  const refresh = async () => {
    const s = await call('mailStatus');
    if (!s || !s.ok) {
      card.body.replaceChildren(el('p', 'hint is-fail', errText('failed')));
      return;
    }
    if (!s.gmail.connected) {
      card.body.replaceChildren(el('p', 'hint', t('life.week.mail.noGmail')));
      return;
    }
    const box = el('input');
    box.type = 'checkbox';
    box.checked = s.weeklyOn;
    box.addEventListener('change', async () => {
      const res = await call('mailSet', { weeklyEmail: box.checked });
      if (!res.ok) setStatus(errText(res.reason), true);
      refresh();
    });
    const label = el('label', 'life-field life-week__toggle');
    label.append(box, el('span', '', t('life.week.mail.toggle', { email: s.gmail.email || '' })));
    card.body.replaceChildren(label);
  };
  card.body.append(el('p', 'hint', t('life.loading')));
  refresh();
  return card.sec;
}
