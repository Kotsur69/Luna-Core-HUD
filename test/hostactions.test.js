// ============================================================================
// LunaCore - the host's first signed actions (src/hostactions.js)
// ----------------------------------------------------------------------------
// Each handler with fakes: news.scan (full selection, the lean job, the `news`
// snapshot), git.fetchAll (counts, the `repos` refresh), repo.clone (URL
// rules with any owner, existing folder refused, the project entry with its
// remote). Plus one run through hostcommands: a refused row never reaches a
// handler.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostActions, fullSelection } = require('../src/hostactions');
const { createHostCommands } = require('../src/hostcommands');

const NOW = 1_800_000_000_000;

function fakes(over = {}) {
  const calls = { fetchSections: [], jobs: [], puts: [], fetched: [], refreshed: 0, cloned: [], added: [], changed: 0 };
  const deps = {
    news: {
      fetchSections: async (saved, selection) => {
        calls.fetchSections.push(selection);
        return [{ id: 's1', label: 'HN', platform: 'web', entries: [{ key: 'k-e0-0', title: 'A story', text: 'Body', published: null, url: 'https://example.com/a' }] }];
      },
    },
    loadNews: () => ({ sources: [{ id: 's1' }, { id: 's2' }], topics: [{ id: 't1' }] }),
    runJob: async (job) => {
      calls.jobs.push(job);
      return { ok: true, answer: { briefing: ['Something happened'], sections: [] }, costUsd: 0.002 };
    },
    model: () => 'haiku',
    env: () => ({ PATH: '/bin' }),
    lang: () => 'en',
    snapshots: () => ({ put: async (kind, data) => calls.puts.push([kind, data]) }),
    repoDirs: () => ['/r/a', '/r/b', '/r/c'],
    fetchDir: async (dir) => {
      calls.fetched.push(dir);
      if (dir === '/r/c') throw new Error('network');
      return { ok: dir === '/r/a' };
    },
    refreshRepos: async () => calls.refreshed++,
    cloneRepo: async (url) => {
      calls.cloned.push(url);
      return { status: 'cloned', dir: `/home/me/source/repos/${url.split('/').pop()}` };
    },
    folderExists: () => false,
    addProject: (entry) => calls.added.push(entry),
    onProjectsChanged: () => calls.changed++,
    now: () => NOW,
    ...over,
  };
  return { handlers: createHostActions(deps), calls };
}

test('fullSelection: every saved source and topic', () => {
  assert.deepEqual(fullSelection({ sources: [{ id: 'a' }], topics: [{ id: 'b' }, { id: 'c' }] }), { sourceIds: ['a'], topicIds: ['b', 'c'] });
  assert.deepEqual(fullSelection(null), { sourceIds: [], topicIds: [] });
});

test('news.scan: full briefing, one lean job, the news snapshot', async () => {
  const { handlers, calls } = fakes();
  const res = await handlers['news.scan']({});
  assert.deepEqual(calls.fetchSections, [{ sourceIds: ['s1', 's2'], topicIds: ['t1'] }]);
  assert.equal(calls.jobs.length, 1);
  assert.equal(calls.jobs[0].lean, true);
  assert.equal(calls.jobs[0].model, 'haiku');
  assert.equal(calls.puts.length, 1);
  assert.equal(calls.puts[0][0], 'news');
  assert.equal(calls.puts[0][1].at, NOW);
  assert.deepEqual(res, { status: 'done', items: 1, costUsd: 0.002 });
});

test('news.scan: nothing fetched -> no paid job, no snapshot', async () => {
  const { handlers, calls } = fakes({ news: { fetchSections: async () => [{ id: 's1', entries: [] }] } });
  assert.deepEqual(await handlers['news.scan']({}), { status: 'empty', items: 0 });
  assert.equal(calls.jobs.length, 0);
  assert.equal(calls.puts.length, 0);
});

test('news.scan: a failed job or no cloud throws (the row ends failed)', async () => {
  await assert.rejects(fakes({ runJob: async () => ({ ok: false, reason: 'timeout' }) }).handlers['news.scan']({}), /timeout/);
  await assert.rejects(fakes({ snapshots: () => null }).handlers['news.scan']({}), /cloud/);
});

test('git.fetchAll: fetches every repo, counts, refreshes repos', async () => {
  const { handlers, calls } = fakes();
  assert.deepEqual(await handlers['git.fetchAll']({}), { fetched: 1, failed: 2 });
  assert.deepEqual(calls.fetched, ['/r/a', '/r/b', '/r/c']);
  assert.equal(calls.refreshed, 1);
});

test('repo.clone: any owner, clone into the repos root, synced entry with remote', async () => {
  const { handlers, calls } = fakes();
  const res = await handlers['repo.clone']({ url: 'https://github.com/someone-else/cool-lib' });
  assert.deepEqual(res, { status: 'cloned', name: 'cool-lib' });
  assert.deepEqual(calls.cloned, ['https://github.com/someone-else/cool-lib']);
  assert.deepEqual(calls.added, [{ path: '/home/me/source/repos/cool-lib', remote: 'https://github.com/someone-else/cool-lib' }]);
  assert.equal(calls.changed, 1);
  assert.equal(JSON.stringify(res).includes('/home'), false, 'no paths in the result');
});

test('repo.clone: a pasted mixed-case URL with .git is normalised', async () => {
  const { handlers, calls } = fakes();
  assert.deepEqual(await handlers['repo.clone']({ url: 'https://GitHub.com/Kotsur69/Luna-Core-HUD.git' }), { status: 'cloned', name: 'luna-core-hud' });
  assert.deepEqual(calls.cloned, ['https://github.com/kotsur69/luna-core-hud']);
});

test('repo.clone: invalid URLs are refused without running git', async () => {
  const { handlers, calls } = fakes();
  for (const url of [undefined, '', 'git@github.com:a/b.git', 'https://gitlab.com/a/b', 'https://github.com/a/b/../c', 'https://github.com/a/..', 'file:///etc', 'https://github.com/-a/b', 42]) {
    assert.deepEqual(await handlers['repo.clone']({ url }), { status: 'refused: invalid url' }, String(url));
  }
  assert.deepEqual(calls.cloned, []);
  assert.deepEqual(calls.added, []);
});

test('repo.clone: an existing folder is refused, before and during the clone', async () => {
  const before = fakes({ folderExists: () => true });
  assert.deepEqual(await before.handlers['repo.clone']({ url: 'https://github.com/Kotsur69/xrepo' }), { status: 'refused: folder exists' });
  assert.deepEqual(before.calls.cloned, []);

  const during = fakes({ cloneRepo: async () => ({ status: 'skipped: folder exists', dir: '/r/x' }) });
  assert.deepEqual(await during.handlers['repo.clone']({ url: 'https://github.com/Kotsur69/xrepo' }), { status: 'refused: folder exists' });
  assert.deepEqual(during.calls.added, []);
});

test('repo.clone: a failed clone reports its status and adds nothing', async () => {
  const { handlers, calls } = fakes({ cloneRepo: async () => ({ status: 'failed: auth', dir: null }) });
  assert.deepEqual(await handlers['repo.clone']({ url: 'https://github.com/Kotsur69/private' }), { status: 'failed: auth' });
  assert.deepEqual(calls.added, []);
});

test('through hostcommands: verified rows run, refused rows never reach a handler', async () => {
  const { handlers, calls } = fakes();
  const table = [
    { id: 'ok', host: 'H', kind: 'git.fetchAll', payload: {}, nonce: 'n1', expires_at: new Date(Date.now() + 60000).toISOString(), sig: 's', status: 'new', created_at: '1' },
    { id: 'bad', host: 'H', kind: 'repo.clone', payload: { url: 'https://github.com/a/b' }, nonce: 'n2', expires_at: new Date(Date.now() + 60000).toISOString(), sig: 'x', status: 'new', created_at: '2' },
  ];
  const q = () => {
    const f = [];
    let patch = null;
    let ret = false;
    const api = {
      select: () => ((ret = patch !== null), api),
      update: (p) => ((patch = p), api),
      eq: (c, v) => (f.push([c, v]), api),
      lt: () => api,
      order: () => api,
      limit: () => api,
      then: (res) => {
        const hits = table.filter((r) => f.every(([c, v]) => r[c] === v));
        if (patch) hits.forEach((r) => Object.assign(r, patch));
        return Promise.resolve(res({ data: patch ? (ret ? hits.map((r) => ({ id: r.id })) : null) : hits.map((r) => ({ ...r })), error: null }));
      },
    };
    return api;
  };
  const client = { from: q, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
  const loop = createHostCommands({ client, host: 'H', verify: async (row) => ({ ok: row.sig === 's', reason: 'command_bad_signature' }), handlers, log: () => {} });
  loop.start();
  await loop.read();
  loop.stop();
  assert.equal(table[0].status, 'done');
  assert.deepEqual(table[0].result, { fetched: 1, failed: 2 });
  assert.equal(table[1].status, 'refused');
  assert.deepEqual(calls.cloned, []);
});
