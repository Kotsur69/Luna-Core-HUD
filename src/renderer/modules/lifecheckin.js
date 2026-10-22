// ============================================================================
// LunaCore - Life dashboard: daily check-in (renderer)
// ----------------------------------------------------------------------------
// Sleep hours (0-16, half hours) and energy 1-5. The Health tab holds it:
// the form while today is open (it can be skipped - the skip is saved), else
// today's answer and the last week; its tab button carries a '1' badge while
// today is open, and the attention inbox lists it. The Overview card shows
// the same and edits today at any time. Stored by src/lifecheckin.js through
// lifedaily.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { el, bucket, button, field, select } from './lifeui.js';
import { getDaily, setCheckin } from './lifedaily.js';
import { sleepOptions, ENERGY_LEVELS } from './lifedailyview.js';

const WEEK_DAYS = 7;
let isEditing = false;

const hours = (v) => new Intl.NumberFormat((window.i18n && window.i18n.lang) || 'pl', { maximumFractionDigits: 1 }).format(v);

/** Energy 1-5 as a row of pressable buttons (one group, arrow keys not needed: 5 tab stops is fine). */
function energyPicker(initial) {
  let value = initial;
  const row = el('div', 'life-energy');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', t('life.checkin.energy'));
  const paint = () => {
    for (const b of row.children) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === value));
  };
  for (const n of ENERGY_LEVELS) {
    const b = el('button', 'life-energy__btn', String(n));
    b.type = 'button';
    b.dataset.v = String(n);
    b.title = t(`life.checkin.energy${n}`);
    b.addEventListener('click', () => {
      value = n;
      paint();
    });
    row.append(b);
  }
  paint();
  return { row, value: () => value };
}

/**
 * The sleep + energy form. `onSkip` adds a "Not today" button (the prompt);
 * `onDone` runs after a successful save.
 */
function checkinForm(entry, { onSkip, onDone } = {}) {
  const c = getDaily().checkin;
  const form = el('form', 'life-form life-checkin__form');
  const opts = [['', t('life.checkin.sleepPick')], ...sleepOptions().map((v) => [String(v), t('life.checkin.hours', { h: hours(v) })])];
  const sleep = select(opts, entry && typeof entry.sleep === 'number' ? String(entry.sleep) : '');
  const energy = energyPicker(entry ? entry.energy : null);
  const energyField = el('div', 'life-field');
  energyField.append(el('span', 'life-field__label', t('life.checkin.energy')), energy.row);
  const row = el('div', 'life-form__row');
  row.append(field('life.checkin.sleep', sleep), energyField);
  const actions = el('div', 'life-form__actions');
  const go = el('button', 'pad-send life-btn', t('life.save'));
  go.type = 'submit';
  actions.append(go);
  if (onSkip) actions.append(button('life.checkin.skip', onSkip));
  form.append(row, actions);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    const res = await setCheckin(c.today, sleep.value === '' ? null : Number(sleep.value), energy.value());
    go.disabled = false;
    if (res.ok && onDone) onDone();
  });
  return form;
}

function lastWeek(c) {
  const list = el('ol', 'life-checkin__week');
  list.setAttribute('aria-label', t('life.checkin.week'));
  for (const d of c.days.slice(0, WEEK_DAYS).reverse()) {
    const li = el('li', 'life-checkin__day');
    const [y, m, dd] = d.date.split('-').map(Number);
    const name = new Intl.DateTimeFormat((window.i18n && window.i18n.lang) || 'pl', { weekday: 'short' }).format(new Date(y, m - 1, dd));
    li.append(el('span', 'life-checkin__dname', name));
    li.append(el('span', 'life-num', typeof d.sleep === 'number' ? t('life.checkin.hoursShort', { h: hours(d.sleep) }) : '–'));
    li.append(el('span', 'life-num life-checkin__energy', typeof d.energy === 'number' ? `⚡${d.energy}` : '–'));
    list.append(li);
  }
  return list;
}

/**
 * The Health tab: only the check-in. While today is open (not answered, not
 * skipped) it shows the form with "Not today", plus the last 7 days;
 * otherwise the same card as the Overview.
 */
export function renderHealth(root) {
  const redraw = () => renderHealth(root);
  const c = getDaily().checkin;
  const wrap = el('div', 'life-health');
  if (c && c.ok && c.entry === null && !isEditing) {
    const card = bucket('life.checkin.title', 'life-checkin');
    card.body.append(el('p', 'life-prompt__title', t('life.checkin.prompt')));
    card.body.append(checkinForm(null, { onSkip: () => setCheckin(c.today, null, null) }), lastWeek(c));
    wrap.append(card.sec);
  } else {
    wrap.append(checkinCard(redraw));
  }
  root.replaceChildren(wrap);
}

/** Overview card: today's sleep + energy, editable, and the last 7 days. */
export function checkinCard(redraw) {
  const card = bucket('life.checkin.title', 'life-checkin');
  const c = getDaily().checkin;
  if (!c) {
    card.body.append(el('p', 'hint', t('life.loading')));
    return card.sec;
  }
  const e = c.entry;
  if (isEditing) {
    card.body.append(
      checkinForm(e, {
        onDone: () => {
          isEditing = false;
          redraw();
        },
      }),
      button('life.cancel', () => {
        isEditing = false;
        redraw();
      })
    );
    return card.sec;
  }
  const today = el('p', 'life-checkin__today');
  if (e && (e.sleep !== null || e.energy !== null)) {
    today.append(
      el('span', 'life-checkin__big life-num', typeof e.sleep === 'number' ? t('life.checkin.hoursShort', { h: hours(e.sleep) }) : '–'),
      el('span', 'life-checkin__sub', typeof e.energy === 'number' ? t('life.checkin.energyIs', { n: e.energy, label: t(`life.checkin.energy${e.energy}`) }) : t('life.checkin.noEnergy'))
    );
  } else {
    today.append(el('span', 'hint', t(e ? 'life.checkin.skipped' : 'life.checkin.none')));
  }
  card.body.append(today, lastWeek(c), button(e ? 'life.checkin.edit' : 'life.checkin.add', () => {
    isEditing = true;
    redraw();
  }));
  return card.sec;
}
