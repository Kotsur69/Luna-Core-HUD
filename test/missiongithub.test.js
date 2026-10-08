// ============================================================================
// LunaCore - Mission Control GitHub telemetry tests (src/missiongithub.js)
// ----------------------------------------------------------------------------
// `gh` is injected: no CLI, no network. The clock is fixed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gh = require('../src/missiongithub.js');

const sample = () => ({
  data: {
    viewer: {
      login: 'Kotsur69',
      contributionsCollection: {
        contributionCalendar: {
          weeks: [
            {
              contributionDays: [
                { date: '2026-10-05', contributionCount: 10 },
                { date: 'nope', contributionCount: 3 },
                { date: '2026-10-06', contributionCount: -1 },
              ],
            },
          ],
        },
      },
    },
    prs: {
      issueCount: 2,
      nodes: [
        {
          title: 'feat: x',
          url: 'https://github.com/Kotsur69/Luna-Core-HUD/pull/12',
          isDraft: true,
          repository: { nameWithOwner: 'Kotsur69/Luna-Core-HUD' },
        },
        { title: 'phish', url: 'https://evil.example.com/pull/1' },
        { title: 'dots', url: 'https://github.com/a/../pull/1' },
      ],
    },
    reviews: { issueCount: 0, nodes: [] },
  },
});

test('normalizeGithub keeps valid days and github.com items only', () => {
  const res = gh.normalizeGithub(sample());
  assert.equal(res.login, 'Kotsur69');
  assert.deepEqual(res.days, [{ date: '2026-10-05', count: 10 }]);
  assert.equal(res.lists.prs.count, 2);
  assert.deepEqual(
    res.lists.prs.items.map((i) => [i.id, i.draft, i.repo]),
    [['prs:0', true, 'Kotsur69/Luna-Core-HUD']]
  );
  // A missing list is an empty one, not a crash.
  assert.deepEqual(res.lists.issues, { count: 0, items: [] });
});

test('normalizeGithub rejects a response with no viewer', () => {
  assert.throws(() => gh.normalizeGithub({ errors: [{ message: 'bad' }] }), { reason: 'gh-failed' });
});

test('historyStart is a Monday at local midnight, WEEKS-1 weeks back', () => {
  const start = gh.historyStart(new Date(2026, 9, 8, 15, 0)); // Thursday
  assert.deepEqual([start.getFullYear(), start.getMonth(), start.getDate(), start.getDay()], [2026, 6, 20, 1]);
  assert.equal(start.getHours(), 0);
});

test('classifyFailure maps missing CLI, timeout and auth errors', () => {
  assert.equal(gh.classifyFailure({ code: 'ENOENT' }, ''), 'gh-missing');
  assert.equal(gh.classifyFailure({ killed: true }, ''), 'gh-timeout');
  assert.equal(gh.classifyFailure({ code: 4 }, 'To get started with GitHub CLI, please run:  gh auth login'), 'gh-auth');
  assert.equal(gh.classifyFailure({ code: 1 }, 'GraphQL: something'), 'gh-failed');
});

test('fetch passes only fixed args, strips URLs, and urlFor resolves ids from the last fetch', async () => {
  let seen = null;
  const client = gh.createGithub({
    runGh: async (args) => {
      seen = args;
      return JSON.stringify(sample());
    },
    now: () => new Date('2026-10-08T12:00:00Z'),
  });
  assert.equal(client.urlFor('prs:0'), null);
  const res = await client.fetch();
  assert.deepEqual(seen.slice(0, 3), ['api', 'graphql', '-f']);
  assert.match(seen[3], /^query=query\(/);
  assert.equal(seen[7], 'to=2026-10-08T12:00:00.000Z');
  assert.equal('url' in res.lists.prs.items[0], false);
  assert.equal(client.urlFor('prs:0'), 'https://github.com/Kotsur69/Luna-Core-HUD/pull/12');
  assert.equal(client.urlFor('prs:1'), null);
  assert.equal(client.urlFor({}), null);
});

test('fetch turns non-JSON output into gh-failed', async () => {
  const client = gh.createGithub({ runGh: async () => 'not json' });
  await assert.rejects(client.fetch(), { reason: 'gh-failed' });
});
