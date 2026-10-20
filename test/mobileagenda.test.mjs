// Phone calendar + mail model (mobile/src/agenda.js): local windows and
// drafts the server accepts, replies re-checked, events grouped per day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localIso, weekWindow, readEvents, readMail, groupByDay, draftFrom, dayKey } from '../mobile/src/agenda.js';
import { parseRequest } from '../supabase/functions/google/core.mjs';

test('localIso carries the local offset and round-trips to the same instant', () => {
  const d = new Date(2026, 9, 19, 9, 5, 7);
  const iso = localIso(d);
  assert.match(iso, /^2026-10-19T09:05:07[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(iso), d.getTime());
});

test('weekWindow is seven local days from midnight and the server accepts it', () => {
  const w = weekWindow(new Date(2026, 9, 19, 15, 30));
  assert.equal(Date.parse(w.from), new Date(2026, 9, 19).getTime());
  assert.equal(Date.parse(w.to), new Date(2026, 9, 26).getTime());
  assert.equal(parseRequest({ action: 'events', ...w }).ok, true);
});

test('draftFrom builds timed and all-day drafts and refuses bad input', () => {
  const timed = draftFrom({ title: 'Dentist', date: '2026-10-20', start: '09:00', end: '', location: '' });
  assert.equal(Date.parse(timed.start), new Date(2026, 9, 20, 9).getTime());
  assert.equal(Date.parse(timed.end) - Date.parse(timed.start), 3600000, 'no end = 1 hour');
  assert.equal(parseRequest({ action: 'create', draft: timed }).ok, true);

  const day = draftFrom({ title: 'Trip', date: '2026-10-31', allDay: true });
  assert.deepEqual([day.start, day.end, day.allDay], ['2026-10-31', '2026-11-01', true]);

  assert.equal(draftFrom({ title: 'x', date: '2026-10-20', start: '10:00', end: '09:00' }), null, 'end before start');
  assert.equal(draftFrom({ title: 'x', date: '2026-10-20', start: '25:00' }), null);
  assert.equal(draftFrom({ title: '  ', date: '2026-10-20', start: '10:00' }), null);
  assert.equal(draftFrom({ title: 'x', date: '20.10.2026', allDay: true }), null);
});

test('readEvents drops junk, caps text, checks colours and sorts', () => {
  const out = readEvents({
    events: [
      { title: 'B', start: '2026-10-20T10:00:00+02:00', end: '2026-10-20T11:00:00+02:00', color: 'url(x)' },
      { title: 'A', start: '2026-10-20', allDay: true, color: '#AABBCC', calendar: 'Praca' },
      { title: 'bad', start: 'tomorrow' },
      null,
    ],
  });
  assert.deepEqual(out.map((e) => e.title), ['A', 'B']);
  assert.equal(out[0].color, '#AABBCC');
  assert.equal(out[1].color, null);
  assert.deepEqual(readEvents(null), []);
});

test('readMail keeps a sane count and at most five items', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ from: `F${i}`, subject: `S${i}`, at: i + 1 }));
  const mail = readMail({ unread: 12, latest: many });
  assert.equal(mail.unread, 12);
  assert.equal(mail.latest.length, 5);
  assert.deepEqual(readMail({ unread: -3, latest: 'x' }), { unread: 0, latest: [] });
});

test('groupByDay puts a running event under today and skips empty days', () => {
  const now = new Date(2026, 9, 19, 12);
  const events = readEvents({
    events: [
      { title: 'Trip', start: '2026-10-17', end: '2026-10-21', allDay: true },
      { title: 'Late', start: localIso(new Date(2026, 9, 21, 20)) },
    ],
  });
  const groups = groupByDay(events, now);
  assert.deepEqual(groups.map((g) => g.day), [dayKey(now), '2026-10-21']);
  assert.equal(groups[0].events[0].title, 'Trip');
});

test('groupByDay leaves out events already over (an old cached week)', () => {
  const now = new Date(2026, 9, 19, 12);
  const events = readEvents({
    events: [
      { title: 'Past day', start: '2026-10-16', end: '2026-10-17', allDay: true },
      { title: 'Ended Sunday', start: '2026-10-18', end: '2026-10-19', allDay: true },
      { title: 'Past meeting', start: localIso(new Date(2026, 9, 17, 9)), end: localIso(new Date(2026, 9, 17, 10)) },
      { title: 'Now', start: localIso(new Date(2026, 9, 19, 11)), end: localIso(new Date(2026, 9, 19, 13)) },
    ],
  });
  assert.deepEqual(groupByDay(events, now).flatMap((g) => g.events.map((e) => e.title)), ['Now']);
});
