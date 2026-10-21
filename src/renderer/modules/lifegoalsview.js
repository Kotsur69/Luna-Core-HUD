// ============================================================================
// LunaCore - Life dashboard: weekly goals (renderer, W4)
// ----------------------------------------------------------------------------
// Up to 3 goals per ISO week. The prompt shows above the tabs on the first
// open of a new ISO week (Monday or later) and can be skipped; the Overview
// card lists the week's goals with a status each (done / partly / not yet,
// set by hand) and edits them. Stored by src/lifegoals.js via lifedaily.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { el, bucket, button, input, select } from './lifeui.js';
import { getDaily, goalsDo } from './lifedaily.js';

const MAX_GOALS = 3;
const MAX_TEXT = 140;
const STATUSES = ['notyet', 'partly', 'done'];
let isEditing = false;

/** Three text inputs; empty ones are dropped on save. */
function goalsForm(goals, { onSkip, onDone } = {}) {
  const g = getDaily().goals;
  const form = el('form', 'life-form life-goals__form');
  const inputs = Array.from({ length: MAX_GOALS }, (_, i) => {
    const inp = input({ maxlength: String(MAX_TEXT), 'aria-label': t('life.goals.n', { n: i + 1 }), placeholder: t('life.goals.n', { n: i + 1 }) });
    inp.value = goals && goals[i] ? goals[i].text : '';
    return inp;
  });
  form.append(...inputs);
  const actions = el('div', 'life-form__actions');
  const go = el('button', 'pad-send life-btn', t('life.save'));
  go.type = 'submit';
  actions.append(go);
  if (onSkip) actions.append(button('life.goals.skip', onSkip));
  form.append(actions);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const texts = inputs.map((x) => x.value.trim()).filter(Boolean);
    go.disabled = true;
    const res = await goalsDo('set', { week: g.week, goals: texts });
    go.disabled = false;
    if (res.ok && onDone) onDone();
  });
  return form;
}

/** The once-a-week prompt above the tabs. */
export function goalsPrompt() {
  const g = getDaily().goals;
  const box = el('section', 'life-prompt__card');
  box.setAttribute('aria-label', t('life.goals.title'));
  box.append(el('h3', 'life-prompt__title', t('life.goals.prompt', { week: g.week.slice(-3) })));
  if (g.last && g.last.length) {
    const done = g.last.filter((x) => x.status === 'done').length;
    box.append(el('p', 'hint', t('life.goals.lastWeek', { done, n: g.last.length })));
  }
  box.append(goalsForm(null, { onSkip: () => goalsDo('set', { week: g.week, goals: [] }) }));
  return box;
}

function goalRow(g, goal, i) {
  const li = el('li', `life-goal is-${goal.status}`);
  li.append(el('span', 'life-goal__text', goal.text));
  const status = select(STATUSES.map((s) => [s, t(`life.goals.${s}`)]), goal.status);
  status.setAttribute('aria-label', t('life.goals.statusOf', { text: goal.text }));
  status.addEventListener('change', () => goalsDo('status', { week: g.week, index: i, status: status.value }));
  li.append(status);
  return li;
}

/** Overview card: this week's goals with their status. */
export function goalsCard(redraw) {
  const card = bucket('life.goals.title', 'life-goals');
  const g = getDaily().goals;
  if (!g) {
    card.body.append(el('p', 'hint', t('life.loading')));
    return card.sec;
  }
  const stop = () => {
    isEditing = false;
    redraw();
  };
  if (isEditing) {
    card.body.append(goalsForm(g.goals, { onDone: stop }), button('life.cancel', stop));
    return card.sec;
  }
  card.body.append(el('p', 'life-goals__week', t('life.goals.week', { week: g.week })));
  if (g.goals && g.goals.length) {
    const list = el('ul', 'life-list');
    g.goals.forEach((goal, i) => list.append(goalRow(g, goal, i)));
    const done = g.goals.filter((x) => x.status === 'done').length;
    card.body.append(list, el('p', 'life-total', t('life.goals.doneOf', { done, n: g.goals.length })));
  } else {
    card.body.append(el('p', 'hint', t('life.goals.none')));
  }
  card.body.append(button(g.goals && g.goals.length ? 'life.goals.edit' : 'life.goals.set', () => {
    isEditing = true;
    redraw();
  }));
  return card.sec;
}
