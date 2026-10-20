// ============================================================================
// LunaCore - Life bills as recurring Google Calendar events (main process)
// ----------------------------------------------------------------------------
// "Add to calendar" on a bill makes one all-day event that repeats on the due
// day (monthly, or yearly for a yearly bill) in the calendar picked like quick
// add - an opaque key from gcal.listCalendars(). The event id and that key are
// stored on the bill (lifebudgetrows setBillEvent, a main-only op), so a bill
// is never added twice, also from another PC.
//
// A bill row is synced through the cloud: untrusted. So the stored event id
// alone never decides what gets edited or deleted. Every event made here
// carries a private extended property lunacoreBill=<bill id>; before an update
// or a delete the event is read back and must carry that exact tag. An event
// id pointing at someone's meeting is refused.
//
// The recurrence comes from gcalrecur.js (validated integers only). Creates
// are throttled like quick add's (1 s apart, 30 per 10 min).
// ============================================================================

'use strict';

const { billRule, firstOccurrence } = require('./gcalrecur');

const TAG_KEY = 'lunacoreBill';
const CAL_KEY_RE = /^[0-9a-f]{16}$/;
const CREATE_GAP_MS = 1000;
const MAX_CREATES_PER_WINDOW = 30;
const CREATE_WINDOW_MS = 10 * 60 * 1000;

class BillCalError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const todayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The all-day draft gcal takes (already the shape missioncal.normalizeDraft makes). */
function billDraft(bill, nowMs) {
  const { start, end } = firstOccurrence(bill, todayOf(nowMs));
  return { title: bill.name, start, end, allDay: true, location: '', category: null };
}

/** True when the shape of a dueDay / every / month / name change needs the event patched. */
const eventChanged = (a, b) => a.dueDay !== b.dueDay || a.every !== b.every || a.month !== b.month || a.name !== b.name;

/**
 * @param {{gcal:object, store:{loadBudget:Function, apply:Function}, file?:string,
 *   now?:()=>number, onSaved?:()=>void, confirmDelete?:(name:string)=>Promise<boolean>}} deps
 */
function createBillCalendar({ gcal, store, file, now = Date.now, onSaved = () => {}, confirmDelete = async () => false }) {
  let lastCreateAt = -Infinity;
  let createTimes = [];

  const findBill = (id) => store.loadBudget(file).bills.find((b) => b.id === id) || null;

  function throttle() {
    const at = now();
    if (at - lastCreateAt < CREATE_GAP_MS) throw new BillCalError('rate-limited');
    createTimes = createTimes.filter((t) => at - t < CREATE_WINDOW_MS);
    if (createTimes.length >= MAX_CREATES_PER_WINDOW) throw new BillCalError('rate-limited');
    createTimes.push(at);
    lastCreateAt = at;
  }

  function setEvent(billId, calEvent) {
    store.apply('setBillEvent', { id: billId, calEvent }, file, now());
    onSaved();
  }

  /**
   * The bill's event, read back from Google and checked to be ours. Null when
   * it is gone (deleted in Google Calendar). Throws when it is not ours.
   */
  async function ownedEvent(bill) {
    const ev = bill.calEvent;
    await gcal.listCalendars(); // fills gcal's key -> calendar map
    let raw;
    try {
      raw = await gcal.eventByKey('GET', ev.cal, ev.id);
    } catch (err) {
      if (err && /HTTP (404|410)/.test(err.message || '')) return null;
      throw err;
    }
    if (!raw || raw.status === 'cancelled') return null;
    const tag = raw.extendedProperties && raw.extendedProperties.private ? raw.extendedProperties.private[TAG_KEY] : null;
    if (tag !== bill.id) throw new BillCalError('not-ours');
    return raw;
  }

  /** "Add to calendar". @returns {Promise<{calEvent:{id,cal}}>} */
  async function add(billId, calKey) {
    if (typeof calKey !== 'string' || !CAL_KEY_RE.test(calKey)) throw new BillCalError('bad-input');
    const bill = findBill(billId);
    if (!bill) throw new BillCalError('not-found');
    if (bill.calEvent) throw new BillCalError('already-added');
    throttle();
    const opts = { recurrence: [billRule(bill)], tag: { [TAG_KEY]: bill.id } };
    let event;
    try {
      ({ event } = await gcal.createEvent(calKey, billDraft(bill, now()), [], opts));
    } catch (err) {
      if (err && err.reason === 'gcal-network') throw new BillCalError('maybe-created');
      throw err;
    }
    if (!event || !event.id) throw new BillCalError('maybe-created');
    const calEvent = { id: event.id, cal: calKey };
    setEvent(bill.id, calEvent);
    return { calEvent };
  }

  /** Patches the event to the bill as it is now (due day, name, rule). */
  async function update(bill) {
    const raw = await ownedEvent(bill);
    if (!raw) {
      setEvent(bill.id, null); // deleted in Google: the bill may be added again
      return { gone: true };
    }
    const draft = billDraft(bill, now());
    await gcal.updateEvent(bill.calEvent.id, draft, [], { calendar: bill.calEvent.cal, recurrence: [billRule(bill)] });
    return { gone: false };
  }

  async function remove(bill) {
    const raw = await ownedEvent(bill);
    if (raw) await gcal.eventByKey('DELETE', bill.calEvent.cal, bill.calEvent.id);
  }

  /**
   * After a successful budget write (lifeipc): keeps the events in step with
   * the bills. Never throws - the budget write already happened.
   */
  async function onApplied(op, before, after) {
    try {
      if (op === 'saveBill') {
        for (const b of after.bills) {
          const old = before.bills.find((x) => x.id === b.id);
          if (b.calEvent && old && eventChanged(old, b)) await update(b);
        }
      } else if (op === 'deleteBill') {
        const gone = before.bills.filter((b) => b.calEvent && !after.bills.some((x) => x.id === b.id));
        for (const b of gone) if (await confirmDelete(b.name)) await remove(b);
      }
    } catch (err) {
      console.error('[gcalbills] calendar follow-up failed:', (err && err.reason) || 'error', err && err.message);
    }
  }

  return { add, update, remove, onApplied };
}

module.exports = { createBillCalendar, billDraft, eventChanged, BillCalError, TAG_KEY };
