// ============================================================================
// LunaCore - other PCs' news briefings (src/missionnewspeers.js)
// ----------------------------------------------------------------------------
// The `news` cloud snapshot of another machine becomes a read-only report in
// "Ready reports". The row is untrusted: every field is checked and capped,
// links are re-validated and stay in main behind keys, like a local scan's.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNewsPeer, createNewsPeers } = require('../src/missionnewspeers.js');

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

function snap(over = {}) {
  return {
    v: 1,
    at: NOW - 60 * 1000,
    lang: 'pl',
    briefing: ['one', 'two'],
    sections: [
      {
        label: 'r/LocalLLaMA',
        platform: 'reddit',
        kind: 'source',
        summary: 'sum',
        entries: [
          { title: 'A', published: '2026-10-15', url: 'https://reddit.com/r/a', pick: true },
          { title: 'B', published: null, url: 'https://reddit.com/r/b', pick: false },
        ],
      },
    ],
    ...over,
  };
}

const row = (data, machine = 'KT-PC-LLM') => ({ machine, data, updatedAt: NOW - 30 * 1000 });

test('parseNewsPeer: a valid snapshot becomes a report with keys, never URLs', () => {
  const { report, urls } = parseNewsPeer(row(snap()), NOW, 'k1');
  assert.equal(report.machine, 'KT-PC-LLM');
  assert.equal(report.at, NOW - 60 * 1000);
  assert.equal(report.peer, true);
  assert.equal(report.names, 'r/LocalLLaMA');
  assert.deepEqual(report.briefing, ['one', 'two']);
  const s = report.sections[0];
  assert.deepEqual([s.label, s.platform, s.ok, s.summary], ['r/LocalLLaMA', 'reddit', true, 'sum']);
  assert.equal(s.entries.length, 2);
  assert.deepEqual(s.picks, [s.entries[0].key]);
  assert.equal(JSON.stringify(report).includes('https://'), false);
  assert.equal(urls.get(s.entries[0].key), 'https://reddit.com/r/a');
  assert.equal(urls.get(s.entries[1].key), 'https://reddit.com/r/b');
});

test('parseNewsPeer: wrong version, language, time or shape -> null', () => {
  assert.equal(parseNewsPeer(row(snap({ v: 2 })), NOW, 'k'), null);
  assert.equal(parseNewsPeer(row(snap({ lang: 'de' })), NOW, 'k'), null);
  assert.equal(parseNewsPeer(row(snap({ at: 'soon' })), NOW, 'k'), null);
  assert.equal(parseNewsPeer(row(snap({ sections: 'x' })), NOW, 'k'), null);
  assert.equal(parseNewsPeer(row(null), NOW, 'k'), null);
  assert.equal(parseNewsPeer(null, NOW, 'k'), null);
  assert.equal(parseNewsPeer(row(snap(), '../evil'), NOW, 'k'), null);
});

test('parseNewsPeer: a far-future time is clamped to now', () => {
  const { report } = parseNewsPeer(row(snap({ at: NOW + 365 * 24 * 3600 * 1000 })), NOW, 'k');
  assert.equal(report.at, NOW);
});

test('parseNewsPeer: unsafe links are dropped; junk fields are capped or skipped', () => {
  const entries = [
    { title: 'js', url: 'javascript:alert(1)' },
    { title: 'creds', url: 'https://u:p@a.example/x' },
    { title: 'secret', url: 'https://a.example/x?token=abc' },
    { title: 'quote', url: 'https://a.example/"x' },
    { title: 'x'.repeat(5000), published: 'p'.repeat(500), url: 'https://ok.example/1', pick: 'yes' },
    'not an object',
  ];
  const data = snap({
    briefing: ['b'.repeat(5000), 42, ...Array.from({ length: 50 }, (_, i) => `b${i}`)],
    sections: [
      { label: 'L'.repeat(500), platform: 'reddit', kind: 'topic', summary: 's'.repeat(10000), entries },
      { label: 'bad platform', platform: '<img>', kind: 'source', summary: '', entries: [] },
      'junk',
    ],
  });
  const { report, urls } = parseNewsPeer(row(data), NOW, 'k');
  assert.ok(report.briefing.length <= 10);
  assert.ok(report.briefing.every((b) => typeof b === 'string' && b.length <= 600));
  assert.equal(report.sections.length, 1);
  const s = report.sections[0];
  assert.ok(s.label.length <= 120);
  assert.ok(s.summary.length <= 2000);
  assert.equal(s.entries.length, 1);
  assert.ok(s.entries[0].title.length <= 300);
  assert.ok(s.entries[0].published.length <= 40);
  assert.deepEqual(s.picks, []);
  assert.deepEqual([...urls.values()], ['https://ok.example/1']);
});

test('parseNewsPeer: entry and section counts are capped', () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ title: `t${i}`, url: `https://a.example/${i}` }));
  const sections = Array.from({ length: 300 }, () => ({ label: 'l', platform: 'rss', kind: 'source', summary: '', entries }));
  const { report, urls } = parseNewsPeer(row(snap({ sections })), NOW, 'k');
  assert.ok(report.sections.length <= 100);
  assert.ok(report.sections.every((s) => s.entries.length <= 25));
  assert.ok(urls.size <= 2500);
});

test('createNewsPeers: lists other PCs newest first and opens only keys it handed out', async () => {
  const rows = [row(snap({ at: NOW - 5000 }), 'OLD-PC'), row(snap({ at: NOW - 1000 }), 'KT-PC-LLM'), row({ v: 9 }, 'BAD-PC')];
  const peers = createNewsPeers({ cloud: () => ({ list: async (kind) => (kind === 'news' ? rows : []) }), now: () => NOW });
  const reports = await peers.list();
  assert.deepEqual(
    reports.map((r) => r.machine),
    ['KT-PC-LLM', 'OLD-PC']
  );
  const key = reports[0].sections[0].entries[0].key;
  assert.equal(peers.urlFor(key), 'https://reddit.com/r/a');
  assert.equal(peers.urlFor('https://evil.example'), null);
  assert.equal(peers.urlFor(42), null);
  // Keys of an earlier list keep working while its report is still on screen.
  await peers.list();
  assert.equal(peers.urlFor(key), 'https://reddit.com/r/a');
});

test('createNewsPeers: cloud off or failing -> no reports, no throw', async () => {
  assert.deepEqual(await createNewsPeers({ cloud: () => null }).list(), []);
  const broken = createNewsPeers({ cloud: () => ({ list: async () => { throw new Error('offline'); } }) });
  assert.deepEqual(await broken.list(), []);
});

// ---- IPC ---------------------------------------------------------------------

const { registerMissionIpc } = require('../src/missioncontrolipc.js');

test('mission:news-peers lists them and mission:news-open resolves their keys', async () => {
  const handlers = new Map();
  const listeners = new Map();
  const opened = [];
  registerMissionIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) },
    getModel: () => 'haiku',
    getEnv: () => ({}),
    gcal: { status: () => ({}) },
    github: { fetch: async () => ({}), urlFor: () => null },
    news: { urlFor: () => null },
    openExternal: (u) => opened.push(u),
    cloudSnapshots: () => ({ list: async () => [row(snap())], put: async () => true }),
  });
  const res = await handlers.get('mission:news-peers')({});
  assert.equal(res.ok, true);
  assert.equal(res.reports.length, 1);
  assert.equal(JSON.stringify(res).includes('https://'), false);
  listeners.get('mission:news-open')({}, res.reports[0].sections[0].entries[0].key);
  assert.deepEqual(opened, ['https://reddit.com/r/a']);
});

test('parseNewsPeer: links to this machine or the local network never come from a peer', () => {
  const hosts = [
    'http://localhost:3000/x',
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://172.16.0.1/x',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest',
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://[fe80::1]/x',
    'http://[fd00::1]/x',
    'http://router/x',
    'http://printer.local/x',
    'http://svc.internal/x',
  ];
  const entries = [...hosts.map((url) => ({ title: 't', url })), { title: 'ok', url: 'https://news.example.com/a' }];
  const data = snap({ sections: [{ label: 'l', platform: 'rss', kind: 'source', summary: '', entries }] });
  const { urls } = parseNewsPeer(row(data), NOW, 'k');
  assert.deepEqual([...urls.values()], ['https://news.example.com/a']);
});
