// ============================================================================
// LunaCore phone - Today: calendar and mail cards (phase 5)
// ----------------------------------------------------------------------------
// Both come from the `google` server function through cloud.google(). When
// the call fails, the last good answer on this phone is shown with its time;
// "not configured yet" is a calm hint, not an error toast. Adding an event
// goes to the primary calendar, then the week is read again.
// ============================================================================

import { h, icon, ICONS } from '../dom.js';
import { t, tf, locale } from '../i18n.js';
import { weekWindow, readEvents, readMail, groupByDay, draftFrom, dayKey } from '../agenda.js';

const QUIET = new Set(['not-configured', 'offline', 'logged-out']);
const REASON_TEXT = { 'not-configured': 'googleNotConfigured', 'google-auth': 'googleAuth', 'google-scope': 'googleAuth', offline: 'googleOffline' };

const clock = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
// The reason comes from a reply body: own keys only, never an inherited `constructor`.
const reasonText = (reason, fallback) => t(Object.hasOwn(REASON_TEXT, reason) ? REASON_TEXT[reason] : fallback);

function dayTitle(day, now) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (day === dayKey(now)) return t('navToday');
  if (day === dayKey(tomorrow)) return t('tomorrow');
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
}

function eventRow(ev) {
  const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  // CSSOM, not a style attribute: the CSP has no 'unsafe-inline' for styles.
  if (ev.color) dot.style.backgroundColor = ev.color;
  const when = ev.allDay ? t('allDay') : clock(Date.parse(ev.start));
  const meta = [ev.location, ev.calendar].filter(Boolean).join(' · ');
  return h('li', { class: 'row' }, dot, h('span', { class: 'num hint' }, when), h('span', { class: 'grow' }, ev.title, meta ? h('div', { class: 'hint' }, meta) : null));
}

function weekView(events, now) {
  const days = groupByDay(events, now);
  if (!days.length) return h('p', { class: 'empty' }, t('agendaEmpty'));
  return h(
    'div',
    { class: 'stack-sm' },
    days.map((g) => h('div', { class: 'stack-sm' }, h('h3', { class: 'label' }, dayTitle(g.day, now)), h('ul', { class: 'rows' }, g.events.map(eventRow)))),
  );
}

function mailView(mail) {
  return h(
    'div',
    { class: 'stack-sm' },
    h('div', { class: 'big-sm num' }, tf('mailUnread', { n: mail.unread })),
    mail.latest.length
      ? h(
          'ul',
          { class: 'rows' },
          mail.latest.map((m) => h('li', { class: 'row-col' }, h('span', {}, m.subject), h('span', { class: 'hint' }, [m.from, m.at ? clock(m.at) : ''].filter(Boolean).join(' · ')))),
        )
      : h('p', { class: 'hint' }, t('mailNone')),
  );
}

/** The add-event form; `onSubmit(draft)` is awaited while the button is disabled. */
function eventForm(onSubmit, onCancel) {
  const field = (id, attrs) => h('input', { class: 'field', id, ...attrs });
  const title = field('ev-title', { type: 'text', maxlength: '200', required: true });
  const date = field('ev-date', { type: 'date', required: true });
  date.value = dayKey(new Date());
  const start = field('ev-start', { type: 'time' });
  const end = field('ev-end', { type: 'time' });
  const where = field('ev-where', { type: 'text', maxlength: '500' });
  const allDay = h('input', { type: 'checkbox', id: 'ev-allday' });
  const times = h(
    'div',
    { class: 'grid-2' },
    h('div', {}, h('label', { class: 'label', for: 'ev-start' }, t('eventStart')), start),
    h('div', {}, h('label', { class: 'label', for: 'ev-end' }, t('eventEnd')), end),
  );
  allDay.addEventListener('change', () => (times.hidden = allDay.checked));
  const error = h('p', { class: 'hint is-bad', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, t('addEvent'));
  const form = h(
    'form',
    { class: 'stack-sm' },
    h('label', { class: 'label', for: 'ev-title' }, t('eventTitle')),
    title,
    h('label', { class: 'label', for: 'ev-date' }, t('eventDate')),
    date,
    h('label', { class: 'row' }, allDay, t('allDay')),
    times,
    h('label', { class: 'label', for: 'ev-where' }, t('eventWhere')),
    where,
    error,
    save,
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: onCancel }, t('cancel')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const draft = draftFrom({ title: title.value, date: date.value, allDay: allDay.checked, start: start.value, end: end.value, location: where.value });
    if (!draft) {
      error.textContent = t('eventBad');
      error.hidden = false;
      return;
    }
    error.hidden = true;
    save.disabled = true;
    try {
      await onSubmit(draft);
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

/**
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{nodes: HTMLElement[], refresh: () => Promise<void>}}
 */
export function mountAgenda({ cloud, toast }) {
  let seq = 0;
  let adding = false;
  const calBody = h('div');
  const mailBody = h('div');
  const addBtn = h('button', { class: 'icon-btn', 'aria-label': t('addEvent'), onclick: () => openForm() }, icon(ICONS.plus));
  const nodes = [
    h(
      'section',
      { class: 'card stack-sm', 'aria-labelledby': 'today-agenda' },
      h('div', { class: 'row' }, h('h2', { class: 'section-title grow', id: 'today-agenda' }, t('agenda')), addBtn),
      calBody,
    ),
    h('section', { class: 'card stack-sm', 'aria-labelledby': 'today-mail' }, h('h2', { class: 'section-title', id: 'today-mail' }, t('mail')), mailBody),
  ];

  function closeForm() {
    adding = false;
    addBtn.hidden = false;
    calBody.replaceChildren(h('p', { class: 'hint' }, t('loading')));
    refresh().catch(() => {});
  }

  async function create(draft) {
    try {
      await cloud.google({ action: 'create', draft });
      toast(t('eventSaved'));
      closeForm();
    } catch (err) {
      // The form stays filled in, so a retry is one tap.
      toast(reasonText(err.message, 'eventFailed'), true);
    }
  }

  function openForm() {
    adding = true;
    addBtn.hidden = true;
    calBody.replaceChildren(eventForm(create, closeForm));
  }

  /**
   * One card: a fresh answer, else the cached one with its time, else the
   * reason. The calendar card is never written while the form is open - a
   * reply that left before the "+" tap must not wipe what is being typed.
   */
  async function load(body, render, target, mine) {
    const current = () => mine === seq && !(adding && target === calBody);
    let data;
    let reason = null;
    try {
      data = await cloud.google(body);
    } catch (err) {
      reason = err.message;
    }
    if (!current()) return;
    if (reason === null) {
      target.replaceChildren(render(data));
      return;
    }
    const cached = reason === 'not-configured' ? null : await cloud.cachedGoogle(body.action).catch(() => null);
    if (!current()) return;
    const note = h('p', { class: reason === 'not-configured' ? 'hint' : 'hint is-bad' }, reasonText(reason, 'googleFailed'));
    target.replaceChildren(cached ? h('div', { class: 'stack-sm' }, render(cached.data), h('p', { class: 'hint' }, tf('cachedAt', { time: clock(cached.at) })), note) : note);
    // One toast per refresh at most, and none for the expected states.
    if (!QUIET.has(reason) && body.action === 'events') toast(reasonText(reason, 'googleFailed'), true);
  }

  async function refresh() {
    const mine = ++seq;
    const now = new Date();
    const loading = () => h('p', { class: 'hint' }, t('loading'));
    if (!adding && !calBody.firstChild) calBody.replaceChildren(loading());
    if (!mailBody.firstChild) mailBody.replaceChildren(loading());
    // A sync or realtime refresh must not wipe an event being typed.
    const week = adding ? null : load({ action: 'events', ...weekWindow(now) }, (d) => weekView(readEvents(d), now), calBody, mine);
    await Promise.all([week, load({ action: 'mail' }, (d) => mailView(readMail(d)), mailBody, mine)]);
  }

  return { nodes, refresh };
}
