// ============================================================================
// LunaCore - Life dashboard: Habits tab (renderer)
// ----------------------------------------------------------------------------
// Pre-filled suggestions (gym, steps goal, water, no late snacks), all
// editable and deletable, plus your own: daily or N days a week. Each row
// ticks today and yesterday and shows the streak (days, or Mon-Sun weeks
// that met N). The steps habit ticks itself when YAZIO's steps reach the
// goal. A tick or a delete shows an Undo toast (lifeui.js). Stored by
// src/lifehabits.js through lifedaily.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { el, bucket, button, iconButton, field, input, select, toast } from './lifeui.js';
import { getDaily, habitsDo } from './lifedaily.js';
import { habitLabelKey } from './lifedailyview.js';

const MAX_NAME = 40;
let editingId = null;

const habitName = (h) => {
  const key = habitLabelKey(h);
  return key ? t(key) : h.name;
};

/** Name + schedule inputs; `habit` null = a new one. */
function habitForm(habit, onDone) {
  const form = el('form', 'life-form__row life-habit__form');
  const name = input({ maxlength: String(MAX_NAME) });
  name.value = habit ? habitName(habit) : '';
  const every = select([['day', t('life.habits.daily')], ['week', t('life.habits.weekly')]], habit ? habit.every : 'day');
  const perWeek = select(Array.from({ length: 7 }, (_, i) => [String(i + 1), t('life.habits.perWeekN', { n: i + 1 })]), String(habit && habit.every === 'week' ? habit.perWeek : 3));
  const perField = field('life.habits.perWeek', perWeek);
  const sync = () => {
    perField.hidden = every.value !== 'week';
  };
  every.addEventListener('change', sync);
  sync();
  const go = el('button', 'pad-send life-btn', t(habit ? 'life.save' : 'life.habits.add'));
  go.type = 'submit';
  form.append(field('life.habits.name', name, 'life-field--grow'), field('life.habits.every', every), perField, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = { name: name.value, every: every.value, perWeek: Number(perWeek.value) };
    // A built-in suggestion keeps its localized name unless it was changed.
    if (habit && !habit.name && name.value.trim() === habitName(habit)) delete data.name;
    go.disabled = true;
    const res = await habitsDo(habit ? 'edit' : 'add', habit ? { id: habit.id, ...data } : data);
    go.disabled = false;
    if (res.ok) onDone();
  });
  return form;
}

function tickButton(h, date, isDone, isAuto, labelKey) {
  const b = el('button', `life-habit__tick${isDone ? ' is-on' : ''}`, `${isDone ? '✓ ' : ''}${t(labelKey)}`);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(isDone));
  b.setAttribute('aria-label', t('life.habits.tickAria', { name: habitName(h), day: t(labelKey) }));
  if (isAuto) {
    // Done by YAZIO's steps: nothing to tick by hand.
    b.disabled = true;
    b.title = t('life.habits.auto');
    return b;
  }
  b.addEventListener('click', async () => {
    const on = !isDone;
    const res = await habitsDo('tick', { id: h.id, date, on });
    if (!res.ok) return;
    toast(t(on ? 'life.habits.ticked' : 'life.habits.unticked', { name: habitName(h) }), () => habitsDo('tick', { id: h.id, date, on: !on }));
  });
  return b;
}

function streakText(h) {
  const s = h.status.streak;
  return t(h.every === 'week' ? 'life.habits.streakWeeks' : 'life.habits.streakDays', { n: s });
}

function habitRow(h, index, data, redraw) {
  const li = el('li', 'life-habit');
  if (editingId === h.id) {
    li.append(habitForm(h, () => {
      editingId = null;
      redraw();
    }), button('life.cancel', () => {
      editingId = null;
      redraw();
    }));
    return li;
  }
  const head = el('div', 'life-habit__head');
  const name = el('span', 'life-habit__name', habitName(h));
  if (h.auto === 'steps') name.append(el('span', 'life-habit__badge', t('life.habits.yazio')));
  head.append(name, el('span', 'life-habit__streak life-num', streakText(h)));
  const meta = el(
    'p',
    'life-habit__meta',
    h.every === 'week' ? t('life.habits.weekProgress', { done: h.status.weekCount, n: h.perWeek }) : t('life.habits.daily')
  );
  const actions = el('div', 'life-habit__actions');
  actions.append(
    tickButton(h, data.today, h.status.doneToday, h.status.autoToday, 'life.habits.today'),
    tickButton(h, data.yesterday, h.status.doneYesterday, h.status.autoYesterday, 'life.habits.yesterday'),
    iconButton('✎', 'life.habits.edit', () => {
      editingId = h.id;
      redraw();
    }),
    iconButton('🗑', 'life.habits.delete', async () => {
      const { status, ...row } = h;
      const res = await habitsDo('remove', { id: h.id });
      if (res.ok) toast(t('life.habits.deleted', { name: habitName(h) }), () => habitsDo('restore', { habit: row, index }));
    }, 'mc-danger')
  );
  li.append(head, meta, actions);
  return li;
}

/** Rebuilds the Habits tab into `root`. */
export function renderHabits(root) {
  const redraw = () => renderHabits(root);
  const data = getDaily().habits;
  const card = bucket('life.habits.title', 'life-habits');
  if (!data) {
    card.body.append(el('p', 'hint', t('life.loading')));
    root.replaceChildren(card.sec);
    return;
  }
  if (editingId && !data.habits.some((h) => h.id === editingId)) editingId = null;
  if (data.habits.length) {
    const list = el('ul', 'life-list');
    data.habits.forEach((h, i) => list.append(habitRow(h, i, data, redraw)));
    card.body.append(list);
  } else {
    card.body.append(el('p', 'hint', t('life.habits.none')));
  }
  if (data.habits.some((h) => h.auto === 'steps') && !data.steps) card.body.append(el('p', 'hint', t('life.habits.noYazio')));
  const add = bucket('life.habits.new');
  add.body.append(habitForm(null, redraw));
  const grid = el('div', 'life-grid life-grid--2');
  grid.append(card.sec, add.sec);
  root.replaceChildren(grid);
}
