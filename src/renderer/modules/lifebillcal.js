// ============================================================================
// LunaCore - Life: a bill's "Add to calendar" control (renderer)
// ----------------------------------------------------------------------------
// One recurring all-day Google Calendar event on the bill's due day, made by
// main (src/gcalbills.js). The calendar is picked like Mission Control's quick
// add: opaque keys from mission:cal-calendars, never a calendar id. Once added
// the bill shows "in calendar"; due-day edits and deletes are followed up by
// main on its own.
// ============================================================================

'use strict';

import { t } from './util.js';
import { el, button, getState, addBillToCalendar, setStatus } from './lifeui.js';

let pickingFor = null; // bill id with the calendar picker open
let calendars = null; // [{key, name, primary}] once loaded

/** A failure reason as text; unknown ones read as a generic failure. */
function calErr(reason) {
  const key = `life.bills.calErr.${reason}`;
  return t(key) === key ? t('life.bills.calErr.failed') : t(key);
}

async function loadCalendars(rerender) {
  const res = await window.lunacore.missionCalCalendars().catch(() => ({ ok: false, reason: 'ipc' }));
  if (!res.ok) {
    pickingFor = null;
    setStatus(calErr(res.reason), true);
  } else {
    calendars = res.calendars;
  }
  rerender();
}

function picker(billId, rerender) {
  const box = el('form', 'life-pay');
  const select = el('select', 'profile-select');
  if (!calendars) {
    select.append(new Option(t('mc.cal.calLoading'), ''));
    select.disabled = true;
  } else {
    select.append(...calendars.map((c) => new Option(c.name || t('mc.cal.mainCalendar'), c.key)));
  }
  select.setAttribute('aria-label', t('life.bills.pickCal'));
  const add = el('button', 'pad-send life-btn', t('life.bills.addCalGo'));
  add.type = 'submit';
  add.disabled = !calendars || !calendars.length;
  box.append(
    select,
    add,
    button('life.cancel', () => {
      pickingFor = null;
      rerender();
    })
  );
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!select.value) return;
    add.disabled = true;
    const res = await addBillToCalendar(billId, select.value);
    if (!res.ok) {
      add.disabled = false;
      setStatus(calErr(res.reason), true);
      return;
    }
    pickingFor = null;
    setStatus(t('life.bills.calAdded'));
  });
  return box;
}

/**
 * The control for one bill: "in calendar", the picker, or the button.
 * @returns {{action: HTMLElement|null, editor: HTMLElement|null}}
 */
export function billCalendarControl(billId, rerender) {
  const state = getState();
  const bill = state && state.budget ? state.budget.bills.find((b) => b.id === billId) : null;
  if (!bill) return { action: null, editor: null };
  if (bill.calEvent) return { action: el('span', 'life-chip life-chip--paid', t('life.bills.inCal')), editor: null };
  const action = button('life.bills.addCal', () => {
    pickingFor = billId;
    rerender();
    if (!calendars) loadCalendars(rerender);
  });
  return { action, editor: pickingFor === billId ? picker(billId, rerender) : null };
}
