// ============================================================================
// LunaCore - report email settings tests (src/mailprefs.js) + gcal's
// recurrence / tag / by-key additions used by the bill events
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMailPrefs, normalizePrefs, normalizeState, DEFAULT_PREFS } = require('../src/mailprefs.js');
const gcal = require('../src/gcal.js');

function prefsIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailprefs-'));
  return createMailPrefs({ prefsPath: path.join(dir, 'mail.local.json'), statePath: path.join(dir, 'mail-state.local.json') });
}

test('defaults: nightly off at 22:30, empty days skipped, run email untouched (null)', () => {
  assert.deepEqual(prefsIn().loadPrefs(), { ...DEFAULT_PREFS });
  assert.deepEqual(normalizePrefs({ nightlyTime: '25:00', nightlyEnabled: 'yes', godmodeEmail: 1 }), { ...DEFAULT_PREFS });
});

test('savePrefs takes only known keys, each validated', () => {
  const p = prefsIn();
  assert.equal(p.savePrefs({ nightlyEnabled: true, nightlyTime: '07:05', recipient: 'evil@x.com' }).nightlyTime, '07:05');
  assert.equal('recipient' in p.loadPrefs(), false);
  assert.throws(() => p.savePrefs({ nightlyTime: '7:5' }), /bad time/);
  assert.throws(() => p.savePrefs({ godmodeEmail: 'on' }), /bad value/);
  assert.throws(() => p.savePrefs(null), /bad payload/);
  assert.equal(p.loadPrefs().nightlyEnabled, true);
});

test('state keeps only well-formed rows', () => {
  const s = normalizeState({ lastNightly: '2026-10-20', godmode: { abc: '2|done', 'BAD ID': '1|done', x: 'nope' }, todoBaseline: { date: 'x', done: [] } });
  assert.deepEqual(s, { lastNightly: '2026-10-20', godmode: { abc: '2|done' }, todoBaseline: null });
});

const fakeStorage = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function gcalWith(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-rec-'));
  const clientPath = path.join(dir, 'c.json');
  const tokenPath = path.join(dir, 't.json');
  fs.writeFileSync(clientPath, JSON.stringify({ installed: { client_id: 'c.apps.googleusercontent.com', client_secret: 's' } }));
  fs.writeFileSync(tokenPath, JSON.stringify({ v: 1, enc: Buffer.from('rt').toString('base64') }));
  const calls = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('oauth2')) return json({ access_token: 'at', expires_in: 3600 });
    calls.push({ url, opts });
    if (url.includes('calendarList')) return json({ items: [{ id: 'me@x.com', primary: true, accessRole: 'owner' }] });
    return handler(url, opts);
  };
  return { client: gcal.createGcal({ fetchImpl, safeStorage: fakeStorage, clientPath, tokenPath }), calls };
}

test('createEvent sends recurrence and the private tag; updateEvent by calendar key; DELETE answers 204', async () => {
  const { client, calls } = gcalWith((url, opts) => {
    if (opts.method === 'DELETE') return { ok: true, status: 204, json: async () => { throw new Error('empty'); } };
    return json({ id: 'ev1', start: { date: '2026-10-31' }, end: { date: '2026-11-01' }, summary: 'Prad' });
  });
  const [{ key }] = await client.listCalendars();
  const draft = { title: 'Prad', start: '2026-10-31', end: '2026-11-01', allDay: true, location: '', category: null };
  await client.createEvent(key, draft, [], { recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=31'], tag: { lunacoreBill: 'b1' } });
  const created = JSON.parse(calls.find((c) => c.opts.method === 'POST').opts.body);
  assert.deepEqual(created.recurrence, ['RRULE:FREQ=MONTHLY;BYMONTHDAY=31']);
  assert.deepEqual(created.extendedProperties, { private: { lunacoreBill: 'b1' } });

  await client.updateEvent('other-ev', { ...draft, start: '2026-11-10', end: '2026-11-11' }, [], { calendar: key, recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=10'] });
  const patch = calls.find((c) => c.opts.method === 'PATCH');
  assert.match(patch.url, /\/events\/other-ev\?/);
  assert.deepEqual(JSON.parse(patch.opts.body).recurrence, ['RRULE:FREQ=MONTHLY;BYMONTHDAY=10']);

  assert.deepEqual(await client.eventByKey('DELETE', key, 'ev1'), {});
  await assert.rejects(client.eventByKey('GET', 'ffffffffffffffff', 'ev1'), (e) => e.reason === 'gcal-not-editable');
  await assert.rejects(client.eventByKey('PUT', key, 'ev1'), (e) => e.reason === 'gcal-failed');
  // Without a known key, an unlisted id is still refused.
  await assert.rejects(client.updateEvent('other-ev', draft, []), (e) => e.reason === 'gcal-not-editable');
});
