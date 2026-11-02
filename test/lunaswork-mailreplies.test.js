// ============================================================================
// LunaCore - replies to Luna's Work emails become feedback (B17, opt-in)
// (src/lunasworkMailReplies.js, src/gmailread.js, the reporter's thread record
// and the mail:replies / mail:reply-clients IPC). Gmail, timers, the browser
// and safeStorage are fakes; state files live in a temp dir.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseMailbox,
  authResults,
  authenticated,
  senderOf,
  messageText,
  replyText,
  readReply,
  normalizeState,
  clientsFor,
  createMailReplies,
  syncMailReplies,
  POLL_MS,
  STATE_FILE,
} = require('../src/lunasworkMailReplies.js');
const { createItem, triageText, scopeDecision, emailLines, publicFeedback, MAX_TEXT } = require('../src/lunasworkFeedback.js');
const { createLunasWorkReporter } = require('../src/lunasworkReport.js');
const { createGmailReader, SCOPE: READ_SCOPE } = require('../src/gmailread.js');
const { createMailPrefs } = require('../src/mailprefs.js');
const { registerMailIpc } = require('../src/mailipc.js');

const NOW = 1793000000000;
const MATI = 'mati@gmail.com';
const CLIENT = 'anna@acme.com';
const RUN = 'lwabc123';
const PROJECT = 'shop';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lw-mailreplies-'));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

/** Gmail's own Authentication-Results line for a message from `domain`. */
const gmailAuth = (domain, o = {}) =>
  `mx.google.com; dkim=${o.dkim || 'pass'} header.i=@${o.dkimDomain || domain} header.s=s1 header.b=abc; ` +
  `spf=${o.spf || 'pass'} (google.com: domain of x@${o.spfDomain || domain} designates 1.2.3.4 as permitted sender) smtp.mailfrom=x@${o.spfDomain || domain}; ` +
  `dmarc=${o.dmarc || 'pass'} (p=NONE sp=NONE dis=NONE) header.from=${domain}`;

/** A Gmail API message (format=full). */
function message(o = {}) {
  const headers = [
    ...(o.from === null ? [] : [{ name: 'From', value: o.from || `Anna <${CLIENT}>` }]),
    ...(o.auth === null ? [] : [{ name: 'Authentication-Results', value: o.auth || gmailAuth('acme.com') }]),
    ...(o.reply === false ? [] : [{ name: 'In-Reply-To', value: '<abc@mail.gmail.com>' }]),
    { name: 'Subject', value: "Re: Luna's Work: shop - milestone M1 reached" },
    ...(o.headers || []),
  ];
  return {
    id: o.id || 'm1',
    threadId: o.threadId || 't1',
    labelIds: o.labels || ['INBOX'],
    internalDate: String(o.at || NOW + 60000),
    payload: o.payload || {
      mimeType: 'multipart/alternative',
      headers,
      parts: [{ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { data: b64(o.body || 'The header is too big') } }],
    },
  };
}

const ctxFor = (o = {}) => ({ self: MATI, clients: [CLIENT], ownIds: new Set(['own1']), notBefore: NOW, ...o });

/** A fake run controller that stores items the way src/lunaswork.js feedback() does. */
function fakeController(runId = RUN) {
  const items = [];
  return {
    items,
    feedback(p) {
      if (p.runId !== runId) return { ok: false, reason: 'otherRun' };
      const res = createItem({ text: p.text, author: p.author, id: p.id }, { now: NOW, list: items });
      if (!res.ok) return { ok: false, reason: res.error };
      items.push(res.item);
      return { ok: true, id: res.item.id };
    },
  };
}

function setup(o = {}) {
  const dir = tmp();
  const prefs = { replyRead: o.replyRead !== false, replyClients: o.clients || { [PROJECT]: [CLIENT] } };
  const readCalls = [];
  const timers = [];
  const cleared = [];
  const logs = [];
  const threads = o.threads || {};
  const reader = {
    status: () => ({ connected: o.readerConnected !== false, email: o.readerEmail || MATI }),
    thread: async (id) => {
      readCalls.push(id);
      if (o.threadError) throw Object.assign(new Error('boom'), { reason: o.threadError });
      return threads[id] || null;
    },
  };
  const sender = { status: () => ({ connected: true, email: MATI }) };
  const replies = createMailReplies({
    reader,
    sender,
    prefs: { loadPrefs: () => prefs },
    runsRoot: () => dir,
    now: () => NOW,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: (h) => cleared.push(h),
    log: (line) => logs.push(line),
  });
  const controller = fakeController();
  replies.attach(controller);
  return { dir, prefs, reader, replies, controller, readCalls, timers, cleared, logs };
}

const activeRun = { id: RUN, projectId: PROJECT, phase: 'directing' };
const stateOf = (dir, runId = RUN) => JSON.parse(fs.readFileSync(path.join(dir, `lunaswork-${runId}`, STATE_FILE), 'utf8'));

// ---- sender + SPF / DKIM ---------------------------------------------------------

test('parseMailbox: one address only, the display name never counts', () => {
  assert.equal(parseMailbox('Anna <Anna@Acme.com>'), 'anna@acme.com');
  assert.equal(parseMailbox('anna@acme.com'), 'anna@acme.com');
  assert.equal(parseMailbox('"Smith, Anna" <anna@acme.com>'), 'anna@acme.com');
  // A trusted address in the display name, the real one elsewhere.
  assert.equal(parseMailbox('"mati@gmail.com" <evil@bad.com>'), 'evil@bad.com');
  assert.equal(parseMailbox('mati@gmail.com <evil@bad.com>'), null);
  assert.equal(parseMailbox('a@acme.com, b@acme.com'), null);
  assert.equal(parseMailbox('<a@acme.com> <b@acme.com>'), null);
  assert.equal(parseMailbox('not an address'), null);
  assert.equal(parseMailbox(null), null);
});

test('authResults reads only the topmost header, and only when Gmail wrote it', () => {
  const ar = authResults([{ name: 'authentication-results', value: gmailAuth('acme.com') }]);
  assert.deepEqual(ar, { spf: 'pass', spfDomain: 'acme.com', dkim: [{ result: 'pass', domain: 'acme.com' }], dmarc: 'pass' });
  assert.equal(authResults([{ name: 'authentication-results', value: 'evil.example; dkim=pass header.i=@acme.com' }]), null);
  // The sender's own forged header sits below Gmail's: never read.
  const two = authResults([
    { name: 'authentication-results', value: gmailAuth('acme.com', { dkim: 'fail', spf: 'fail' }) },
    { name: 'authentication-results', value: gmailAuth('acme.com') },
  ]);
  assert.equal(two.spf, 'fail');
  assert.equal(two.dkim[0].result, 'fail');
  // A pass inside a comment is prose, not a result.
  const commented = authResults([{ name: 'authentication-results', value: 'mx.google.com; spf=fail (dkim=pass header.i=@acme.com) smtp.mailfrom=x@acme.com' }]);
  assert.deepEqual(commented.dkim, []);
});

test('senderOf: an allow-listed client needs an aligned SPF or DKIM pass', () => {
  const ok = (o) => senderOf(message(o), ctxFor());
  assert.deepEqual(ok({}), { ok: true, author: 'client' });
  assert.deepEqual(ok({ auth: gmailAuth('acme.com', { spf: 'fail' }) }), { ok: true, author: 'client' });
  assert.deepEqual(ok({ auth: gmailAuth('acme.com', { dkim: 'fail' }) }), { ok: true, author: 'client' });
  // A subdomain signature aligns (relaxed alignment).
  assert.deepEqual(ok({ auth: gmailAuth('acme.com', { dkimDomain: 'mail.acme.com', spf: 'fail' }) }), { ok: true, author: 'client' });
  // Both failed, or passed for another domain than the From address.
  assert.deepEqual(ok({ auth: gmailAuth('acme.com', { dkim: 'fail', spf: 'fail' }) }), { ok: false, reason: 'auth' });
  assert.deepEqual(ok({ auth: gmailAuth('acme.com', { dkimDomain: 'evil.com', spfDomain: 'evil.com' }) }), { ok: false, reason: 'auth' });
  assert.deepEqual(ok({ auth: gmailAuth('acme.com', { dmarc: 'fail' }) }), { ok: false, reason: 'auth' });
  assert.deepEqual(ok({ auth: null }), { ok: false, reason: 'auth' });
  assert.deepEqual(ok({ auth: 'evil.example; dkim=pass header.i=@acme.com; spf=pass smtp.mailfrom=x@acme.com' }), { ok: false, reason: 'auth' });
});

test("senderOf: Mati's own address - written in this mailbox (SENT) or authenticated", () => {
  const mati = (o) => senderOf(message({ from: `Mati <${MATI}>`, ...o }), ctxFor());
  assert.deepEqual(mati({ auth: null, labels: ['SENT', 'INBOX'] }), { ok: true, author: 'mati' });
  assert.deepEqual(mati({ auth: gmailAuth('gmail.com') }), { ok: true, author: 'mati' });
  // Spoofed From: Mati from outside, nothing passes for gmail.com.
  assert.deepEqual(mati({ auth: gmailAuth('gmail.com', { dkimDomain: 'evil.com', spfDomain: 'evil.com', dmarc: 'fail' }) }), { ok: false, reason: 'auth' });
  assert.deepEqual(mati({ auth: null }), { ok: false, reason: 'auth' });
});

test('senderOf: anyone else, two From headers or no From is refused', () => {
  assert.deepEqual(senderOf(message({ from: 'x@other.com', auth: gmailAuth('other.com') }), ctxFor()), { ok: false, reason: 'sender' });
  assert.deepEqual(senderOf(message({ headers: [{ name: 'From', value: MATI }] }), ctxFor()), { ok: false, reason: 'from' });
  assert.deepEqual(senderOf(message({ from: null }), ctxFor()), { ok: false, reason: 'from' });
  // An address allow-listed for another project is not a client here.
  assert.deepEqual(senderOf(message({}), ctxFor({ clients: [] })), { ok: false, reason: 'sender' });
});

test('clientsFor: only the run project, valid addresses, lower case', () => {
  const prefs = { replyClients: { shop: ['Anna@Acme.com', 'bad'], other: ['x@y.com'] } };
  assert.deepEqual(clientsFor(prefs, 'shop'), ['anna@acme.com']);
  assert.deepEqual(clientsFor(prefs, 'nope'), []);
  assert.deepEqual(clientsFor(prefs, '__proto__'), []);
  assert.deepEqual(clientsFor(null, 'shop'), []);
});

// ---- body, quote stripping + cap ----------------------------------------------------

test('messageText: the plain part; attachments are never read; HTML as text otherwise', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('attachment text'), attachmentId: 'a1' } },
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('plain body') } },
          { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } },
        ],
      },
    ],
  };
  assert.equal(messageText(payload), 'plain body');
  const html = { mimeType: 'text/html', body: { data: b64('<div>Header <b>too</b> big<br>next&amp;line</div><blockquote>old</blockquote><script>x()</script>') } };
  assert.equal(messageText(html).trim(), 'Header too big\nnext&line');
  const latin2 = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-2' }], body: { data: Buffer.from([0xb3, 0x61, 0x64, 0x6e, 0x69, 0x65]).toString('base64url') } };
  assert.equal(messageText(latin2), 'ładnie');
  assert.equal(messageText({ mimeType: 'image/png', body: { attachmentId: 'x' } }), '');
});

test('replyText strips quoted history, > lines and signatures', () => {
  const cases = [
    ['Header is too big\n\nOn Mon, 3 Nov 2026 at 10:00, Mati <mati@gmail.com> wrote:\n> Milestone reached\n> more', 'Header is too big'],
    ['Header is too big\nOn Mon, 3 Nov 2026 at 10:00, Mati\n<mati@gmail.com> wrote:\n> old', 'Header is too big'],
    ['Naglowek za duzy\n\nW dniu 3.11.2026 o 10:00 Mati <mati@gmail.com> napisał(a):\n> stare', 'Naglowek za duzy'],
    ['Fix the login\n> quoted line\nand the footer', 'Fix the login\nand the footer'],
    ['Looks great\n-- \nAnna Smith\nACME Inc.', 'Looks great'],
    ['Looks great\n\nSent from my iPhone', 'Looks great'],
    ['Export is missing\n\nFrom: Mati <mati@gmail.com>\nSent: Monday\nSubject: x\n\nold text', 'Export is missing'],
    ['Export is missing\n________________________________\nold text', 'Export is missing'],
    // LunaCore's own email quoted without '>' markers.
    ['Export is missing\n\nMilestone "M1" reached after iteration 3. The run goes on.\nWAITS FOR YOU', 'Export is missing'],
  ];
  for (const [input, want] of cases) assert.equal(replyText(input), want, input);
  assert.equal(replyText('> all quoted\n> nothing new'), '');
});

test('replyText caps the text at the feedback limit', () => {
  const long = `${'word '.repeat(600)}\nOn Mon, Mati wrote:\n> x`;
  assert.equal(replyText(long).length, MAX_TEXT);
});

// ---- thread matching ----------------------------------------------------------------

test('readReply takes only real replies in the thread: not our own, no draft, not older', () => {
  const ctx = ctxFor();
  assert.deepEqual(readReply(message({}), ctx), { ok: true, id: 'm1', at: NOW + 60000, author: 'client', text: 'The header is too big' });
  assert.equal(readReply(message({ id: 'own1' }), ctx).reason, 'own');
  assert.equal(readReply(message({ labels: ['DRAFT'] }), ctx).reason, 'draft');
  assert.equal(readReply(message({ labels: ['SPAM'] }), ctx).reason, 'spam');
  assert.equal(readReply(message({ reply: false }), ctx).reason, 'not-reply');
  assert.equal(readReply(message({ at: NOW - 60 * 60 * 1000 }), ctx).reason, 'older');
  assert.equal(readReply(message({ body: '> only quoted' }), ctx).reason, 'empty');
  assert.equal(readReply({ id: '../../x' }, ctx).reason, 'malformed');
  assert.equal(readReply(message({ id: 'm9', at: 'soon' }), ctx).reason, 'malformed');
});

test('record keeps the thread of each sent email with the run, once', () => {
  const s = setup();
  assert.equal(s.replies.record(RUN, { threadId: 't1', messageId: 'own1', kind: 'milestone' }), true);
  assert.equal(s.replies.record(RUN, { threadId: 't1', messageId: 'own1', kind: 'milestone' }), true);
  assert.equal(s.replies.record(RUN, { threadId: 't2', messageId: 'own2', kind: 'runEnd' }), true);
  assert.equal(s.replies.record('../evil', { threadId: 't3' }), false);
  assert.equal(s.replies.record(RUN, { threadId: 'bad/id' }), false);
  assert.deepEqual(stateOf(s.dir).threads, [
    { threadId: 't1', messageId: 'own1', kind: 'milestone', sentAt: NOW },
    { threadId: 't2', messageId: 'own2', kind: 'runEnd', sentAt: NOW },
  ]);
});

test("a poll reads only the active run's own threads", async () => {
  const s = setup({ threads: { t1: [message({ id: 'own1', from: MATI, labels: ['SENT'] }), message({})] } });
  s.replies.record(RUN, { threadId: 't1', messageId: 'own1' });
  s.replies.record('lwother', { threadId: 't9', messageId: 'x9' });
  s.replies.sync(activeRun);
  assert.equal(await s.replies.tick(), 1);
  assert.deepEqual(s.readCalls, ['t1']);
  assert.deepEqual(s.controller.items.map((i) => [i.author, i.text, i.id]), [['client', 'The header is too big', NOW + 60000]]);
});

// ---- setting off = no polling ------------------------------------------------------

test('setting off: no timer, no Gmail request, nothing imported', async () => {
  const s = setup({ replyRead: false, threads: { t1: [message({})] } });
  s.replies.record(RUN, { threadId: 't1', messageId: 'own1' });
  s.replies.sync(activeRun);
  assert.equal(s.timers.length, 0);
  assert.equal(await s.replies.tick(), 0);
  assert.equal(await s.replies.refresh(), 0);
  assert.deepEqual(s.readCalls, []);
  assert.equal(s.controller.items.length, 0);
});

test('the read grant must be the mailbox the emails went from', async () => {
  const s = setup({ readerEmail: 'someone.else@gmail.com', threads: { t1: [message({})] } });
  s.replies.record(RUN, { threadId: 't1' });
  s.replies.sync(activeRun);
  assert.equal(s.replies.enabled(), false);
  assert.equal(s.timers.length, 0);
  assert.equal(await s.replies.tick(), 0);
  assert.deepEqual(s.readCalls, []);
});

test('polling follows the run: every 10 min while active, stopped at its end; turning the setting on starts it', async () => {
  const s = setup({ replyRead: false });
  s.replies.sync(activeRun);
  assert.equal(s.timers.length, 0);
  s.prefs.replyRead = true;
  await s.replies.refresh();
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, POLL_MS);
  assert.equal(POLL_MS, 10 * 60 * 1000);
  // More events of the same run arm nothing new.
  s.replies.sync({ ...activeRun, phase: 'building' });
  assert.equal(s.timers.length, 1);
  syncMailReplies(s.replies, { ...activeRun, phase: 'done' });
  assert.deepEqual(s.cleared, [1]);
  assert.equal(await s.replies.tick(), 0);
  // Turned off mid-run: the next tick disarms.
  s.replies.sync(activeRun);
  s.prefs.replyRead = false;
  assert.equal(await s.replies.tick(), 0);
  assert.equal(s.cleared.length, 2);
});

test('syncMailReplies never throws and is a no-op without the module', () => {
  assert.doesNotThrow(() => syncMailReplies(undefined, activeRun));
  const broken = {
    sync: () => {
      throw new Error('x');
    },
  };
  assert.doesNotThrow(() => syncMailReplies(broken, activeRun, () => {}));
});

// ---- dedupe --------------------------------------------------------------------------

test('dedupe: a message is imported once, across polls and restarts', async () => {
  const threads = { t1: [message({ id: 'm1' }), message({ id: 'm2', from: 'stranger@x.com', auth: gmailAuth('x.com') })] };
  const s = setup({ threads });
  s.replies.record(RUN, { threadId: 't1', messageId: 'own1' });
  s.replies.sync(activeRun);
  assert.equal(await s.replies.tick(), 1);
  assert.equal(await s.replies.tick(), 0);
  assert.equal(s.controller.items.length, 1);
  // The stranger stays unseen (Mati may allow-list them later), logged once.
  assert.deepEqual(stateOf(s.dir).seen, ['m1']);
  assert.equal(s.logs.filter((l) => l.includes('m2 skipped (sender)')).length, 1);

  // A new LunaCore session reads the same state: nothing comes in twice.
  const again = createMailReplies({
    reader: s.reader,
    sender: { status: () => ({ connected: true, email: MATI }) },
    prefs: { loadPrefs: () => s.prefs },
    runsRoot: () => s.dir,
    now: () => NOW,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  again.attach(s.controller);
  again.sync(activeRun);
  assert.equal(await again.tick(), 0);
  assert.equal(s.controller.items.length, 1);
});

test('dedupe: a crash after the import is caught as a duplicate item id', async () => {
  const s = setup({ threads: { t1: [message({ id: 'm1' })] } });
  s.replies.record(RUN, { threadId: 't1' });
  s.replies.sync(activeRun);
  await s.replies.tick();
  // The seen list was lost; the controller already holds the item.
  const file = path.join(s.dir, `lunaswork-${RUN}`, STATE_FILE);
  fs.writeFileSync(file, JSON.stringify({ ...stateOf(s.dir), seen: [] }));
  assert.equal(await s.replies.tick(), 0);
  assert.equal(s.controller.items.length, 1);
  assert.deepEqual(stateOf(s.dir).seen, ['m1']);
});

test('an unauthenticated message is never imported, logged once, and looked at again', async () => {
  const s = setup({ threads: { t1: [message({ auth: gmailAuth('acme.com', { dkim: 'fail', spf: 'fail' }) })] } });
  s.replies.record(RUN, { threadId: 't1' });
  s.replies.sync(activeRun);
  assert.equal(await s.replies.tick(), 0);
  assert.equal(await s.replies.tick(), 0);
  assert.deepEqual(stateOf(s.dir).seen, []);
  assert.equal(s.logs.filter((l) => l.includes('m1 skipped (auth)')).length, 1);
});

test('a folded Authentication-Results header is still read', () => {
  const headers = [{
    name: 'authentication-results',
    value: 'mx.google.com;\r\n       dkim=pass header.i=@acme.com\r\n       header.s=s1;\r\n       spf=pass (google.com: domain of a@acme.com designates 1.2.3.4 as permitted sender)\r\n       smtp.mailfrom=a@acme.com;\r\n       dmarc=pass',
  }];
  const ar = authResults(headers);
  assert.equal(ar.spfDomain, 'acme.com');
  assert.deepEqual(ar.dkim, [{ result: 'pass', domain: 'acme.com' }]);
  assert.equal(authenticated(headers, 'alice@acme.com'), true);
});

test('quote detection stays fast on a huge hostile line', () => {
  const started = Date.now();
  const text = replyText(`Looks good.\nOn x ${'napisa'.repeat(25000)}\nmore`);
  assert.ok(Date.now() - started < 500);
  assert.ok(text.startsWith('Looks good.'));
});

test('mailprefs: a prototype key is never a project id', () => {
  const dir = tmp();
  const prefs = createMailPrefs({ prefsPath: path.join(dir, 'mail.json'), statePath: path.join(dir, 'state.json') });
  assert.throws(() => prefs.setReplyClients('__proto__', ['a@acme.com']), /bad value/);
});

test('a Gmail error stops the poll quietly; nothing is marked', async () => {
  const s = setup({ threadError: 'gmail-auth' });
  s.replies.record(RUN, { threadId: 't1' });
  s.replies.sync(activeRun);
  assert.equal(await s.replies.tick(), 0);
  assert.ok(s.logs.some((l) => l.includes('gmail-auth')));
  assert.deepEqual(stateOf(s.dir).seen, []);
});

test('normalizeState drops broken threads and ids', () => {
  assert.deepEqual(normalizeState({ threads: [{ threadId: 't1' }, { threadId: 't1' }, { threadId: '../x' }, 'junk'], seen: ['m1', 'm1', '../y', 3] }), {
    threads: [{ threadId: 't1', messageId: null, kind: 'milestone', sentAt: null }],
    seen: ['m1'],
  });
  assert.deepEqual(normalizeState('garbage'), { threads: [], seen: [] });
});

// ---- imported items go through normal triage ----------------------------------------

test('imported replies go through normal triage and the trust rules, with a status on phone + email', async () => {
  const threads = {
    t1: [
      message({ id: 'm1', body: 'The header is too big and the PDF export is missing\n\nOn Mon, Mati wrote:\n> Milestone' }),
      message({ id: 'm2', at: NOW + 120000, from: `Mati <${MATI}>`, auth: null, labels: ['SENT'], body: 'Please add a dark mode' }),
    ],
  };
  const s = setup({ threads });
  s.replies.record(RUN, { threadId: 't1', messageId: 'own1' });
  s.replies.sync(activeRun);
  assert.equal(await s.replies.tick(), 2);
  const [client, mati] = s.controller.items;
  assert.equal(client.author, 'client');
  assert.equal(client.status, 'new');
  // Not triaged yet: the next iteration does it, like any other feedback.
  assert.equal(client.parts, null);

  // The same rule-based triage every channel gets.
  const parts = triageText(client.text);
  assert.deepEqual(parts.map((p) => p.type), ['look', 'scope']);
  // A client's scope change waits for Mati, with no default.
  const clientScope = scopeDecision(parts[1], client, 101);
  assert.equal(clientScope.kind, 'clientScope');
  assert.equal(clientScope.defaultAnswer, undefined);
  // Mati's own reply may change anything (approve by default).
  const matiScope = scopeDecision(triageText(mati.text)[0], mati, 102);
  assert.equal(matiScope.kind, 'feedbackScope');
  assert.equal(matiScope.defaultAnswer, 'approve');

  // Status like any other feedback: the phone snapshot and the next milestone email.
  const phone = publicFeedback({ runId: RUN, repoName: 'shop', items: s.controller.items });
  assert.deepEqual(phone.items.map((i) => [i.author, i.status]), [['client', 'new'], ['mati', 'new']]);
  const lines = emailLines(s.controller.items);
  assert.ok(lines.some((l) => l.startsWith('- [received, planned next iteration] (client) The header is too big')));
  assert.ok(lines.some((l) => l.includes('Please add a dark mode')));
});

test('a reply for a run that is no longer the current one waits', async () => {
  const s = setup({ threads: { t1: [message({})] } });
  s.replies.record(RUN, { threadId: 't1' });
  s.replies.attach(fakeController('lwnewer'));
  s.replies.sync(activeRun);
  assert.equal(await s.replies.tick(), 0);
  assert.deepEqual(stateOf(s.dir).seen, []);
});

// ---- the reporter stores each sent email's thread --------------------------------------

test("the milestone and run-end emails' Gmail ids are stored with the run", async () => {
  const recorded = [];
  const reporter = createLunasWorkReporter({
    runsDir: () => tmp(),
    mail: {
      sender: { status: () => ({ connected: true, email: MATI }), send: async () => ({ id: 'own1', threadId: 'thr1' }) },
      prefs: { loadPrefs: () => ({ godmodeEmail: true }), loadState: () => ({ godmode: {} }), updateState: () => {} },
      enabled: () => true,
    },
    threads: { record: (runId, info) => recorded.push([runId, info]) },
    readFile: () => null,
    writeFile: () => {},
  });
  const run = { id: RUN, repoPath: '/x/shop', iteration: 3, milestone: 'M2', feedback: [], decisions: [], history: [], laps: [] };
  assert.equal((await reporter.onMilestone(run, { milestone: 'M1' })).sent, true);
  assert.equal((await reporter.onRunEnd({ ...run, verdict: 'ship' })).mail.sent, true);
  assert.deepEqual(recorded, [
    [RUN, { threadId: 'thr1', messageId: 'own1', kind: 'milestone' }],
    [RUN, { threadId: 'thr1', messageId: 'own1', kind: 'runEnd' }],
  ]);
});

// ---- the read grant ----------------------------------------------------------------------

const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (buf) => buf.toString().replace(/^enc:/, ''),
};
const CLIENT_ID = 'c.apps.googleusercontent.com';
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function readerFiles() {
  const dir = tmp();
  const clientPath = path.join(dir, 'client.json');
  fs.writeFileSync(clientPath, JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: 'sec' } }));
  const tokenPath = path.join(dir, 'gmail-read-token.local.json');
  fs.writeFileSync(tokenPath, JSON.stringify({ v: 1, enc: Buffer.from(`enc:${JSON.stringify({ refreshToken: 'rt', email: MATI })}`).toString('base64') }));
  return { clientPath, tokenPath };
}

test('gmail reader: gmail.readonly only, one thread by id, attachments never fetched', async () => {
  assert.equal(READ_SCOPE, 'openid email https://www.googleapis.com/auth/gmail.readonly');
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('oauth2')) return json({ access_token: 'at', expires_in: 3600 });
    if (url.includes('/threads/gone')) return json({}, 404);
    return json({ messages: [message({})] });
  };
  const reader = createGmailReader({ fetchImpl, safeStorage: fakeStorage, ...readerFiles() });
  const messages = await reader.thread('18c2f0a1b2c3');
  assert.equal(messages.length, 1);
  assert.equal(await reader.thread('gone'), null);
  await assert.rejects(reader.thread('../../messages/send'), (err) => err.reason === 'gmail-failed');
  const api = urls.filter((u) => !u.includes('oauth2'));
  assert.deepEqual(api, [
    'https://gmail.googleapis.com/gmail/v1/users/me/threads/18c2f0a1b2c3?format=full',
    'https://gmail.googleapis.com/gmail/v1/users/me/threads/gone?format=full',
  ]);
});

test('gmail reader: turning off revokes the grant at Google and deletes the token', async () => {
  const f = readerFiles();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts && opts.body });
    return json({});
  };
  const reader = createGmailReader({ fetchImpl, safeStorage: fakeStorage, ...f });
  assert.equal(reader.status().connected, true);
  await reader.disconnect();
  assert.equal(reader.status().connected, false);
  assert.equal(fs.existsSync(f.tokenPath), false);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(new URLSearchParams(calls[0].body).get('token'), 'rt');
});

test('gmail reader: a fresh consent for gmail.readonly; a grant without it is refused', async () => {
  const f = readerFiles();
  fs.rmSync(f.tokenPath);
  const b64j = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const idToken = `${b64j({})}.${b64j({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email: MATI, email_verified: true })}.sig`;
  let authUrl = null;
  const reader = createGmailReader({
    fetchImpl: async () => json({ refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken }),
    safeStorage: fakeStorage,
    openExternal: async (u) => {
      authUrl = u;
    },
    redirectServer: async () => ({ redirectUri: 'http://127.0.0.1:1', code: Promise.resolve('code'), close: () => {} }),
    ...f,
  });
  await assert.rejects(reader.connect(), (err) => err.reason === 'gmail-scope');
  assert.equal(new URL(authUrl).searchParams.get('scope'), READ_SCOPE);
  assert.equal(new URL(authUrl).searchParams.get('prompt'), 'consent');
  assert.equal(reader.status().connected, false);
});

// ---- mail settings + IPC -----------------------------------------------------------------

test('mailprefs: reply reading is off by default and never set by the generic patch', () => {
  const dir = tmp();
  const prefs = createMailPrefs({ prefsPath: path.join(dir, 'mail.json'), statePath: path.join(dir, 'state.json') });
  assert.equal(prefs.loadPrefs().replyRead, false);
  assert.deepEqual(prefs.loadPrefs().replyClients, {});
  prefs.savePrefs({ replyRead: true, replyClients: { shop: ['x@y.com'] } });
  assert.equal(prefs.loadPrefs().replyRead, false);
  assert.deepEqual(prefs.loadPrefs().replyClients, {});
  prefs.setReplyClients('shop', [' Anna@Acme.com ', 'anna@acme.com']);
  assert.deepEqual(prefs.loadPrefs().replyClients, { shop: ['anna@acme.com'] });
  assert.throws(() => prefs.setReplyClients('shop', ['not-an-email']));
  assert.throws(() => prefs.setReplyClients('shop', Array.from({ length: 11 }, (_, i) => `a${i}@x.com`)));
  assert.throws(() => prefs.setReplyClients('../x', ['a@x.com']));
  prefs.setReplyClients('shop', []);
  assert.deepEqual(prefs.loadPrefs().replyClients, {});
});

function ipcSetup(o = {}) {
  const handlers = new Map();
  const dir = tmp();
  const prefs = createMailPrefs({ prefsPath: path.join(dir, 'mail.json'), statePath: path.join(dir, 'state.json') });
  const reader = {
    connected: false,
    connects: 0,
    revoked: 0,
    status() {
      return { configured: true, connected: this.connected, email: this.connected ? o.readerEmail || MATI : null };
    },
    async connect() {
      this.connects += 1;
      this.connected = true;
      return { email: o.readerEmail || MATI };
    },
    async disconnect() {
      this.revoked += 1;
      this.connected = false;
    },
  };
  registerMailIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    sender: { status: () => ({ configured: true, connected: true, email: MATI }), disconnect: () => {} },
    prefs,
    nightly: { sendNow: async () => ({ ok: true }) },
    reader,
    replies: { refresh: async () => 0 },
    projects: () => [{ id: PROJECT, label: 'Shop' }],
  });
  const call = (ch, payload) => handlers.get(ch)({}, payload);
  return { call, prefs, reader };
}

test('mail:replies on asks a fresh read consent; off revokes it', async () => {
  const s = ipcSetup();
  assert.equal((await s.call('mail:status')).replies.on, false);
  assert.deepEqual(await s.call('mail:replies', { on: 'yes' }), { ok: false, reason: 'bad-value' });
  assert.deepEqual(await s.call('mail:replies', null), { ok: false, reason: 'bad-value' });
  const on = await s.call('mail:replies', { on: true });
  assert.equal(on.ok, true);
  assert.equal(on.replies.on, true);
  assert.equal(s.reader.connects, 1);
  assert.equal(s.prefs.loadPrefs().replyRead, true);
  const off = await s.call('mail:replies', { on: false });
  assert.equal(off.replies.on, false);
  assert.equal(s.reader.revoked, 1);
  assert.equal(s.prefs.loadPrefs().replyRead, false);
});

test('mail:replies refuses a read grant for another Google account', async () => {
  const s = ipcSetup({ readerEmail: 'other@gmail.com' });
  assert.deepEqual(await s.call('mail:replies', { on: true }), { ok: false, reason: 'gmail-other-account' });
  assert.equal(s.reader.connected, false);
  assert.equal(s.prefs.loadPrefs().replyRead, false);
});

test('mail:disconnect drops the reply grant too', async () => {
  const s = ipcSetup();
  await s.call('mail:replies', { on: true });
  await s.call('mail:disconnect');
  assert.equal(s.reader.connected, false);
  assert.equal(s.prefs.loadPrefs().replyRead, false);
});

test('mail:reply-clients: known projects and valid addresses only', async () => {
  const s = ipcSetup();
  const ok = await s.call('mail:reply-clients', { projectId: PROJECT, emails: ['anna@acme.com'] });
  assert.deepEqual(ok.replies.clients, { shop: ['anna@acme.com'] });
  assert.deepEqual(ok.replies.projects, [{ id: PROJECT, label: 'Shop' }]);
  assert.deepEqual(await s.call('mail:reply-clients', { projectId: 'nope', emails: ['a@b.com'] }), { ok: false, reason: 'unknown-project' });
  assert.deepEqual(await s.call('mail:reply-clients', { projectId: PROJECT, emails: ['a@b.com\r\nBcc: x@y.z'] }), { ok: false, reason: 'bad-value' });
  assert.deepEqual(await s.call('mail:reply-clients', { projectId: PROJECT, emails: [{}] }), { ok: false, reason: 'bad-value' });
  assert.deepEqual(await s.call('mail:reply-clients', { projectId: PROJECT, emails: 'a@b.com' }), { ok: false, reason: 'bad-value' });
  assert.deepEqual(await s.call('mail:reply-clients', 'junk'), { ok: false, reason: 'bad-value' });
});
