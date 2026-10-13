// ============================================================================
// LunaCore - Mission Control commit moments tests (src/missioncommits.js)
// ----------------------------------------------------------------------------
// git is an injected fake keyed by the args it is called with; clock fixed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createCommits, parseLog } = require('../src/missioncommits.js');

const NOW = Date.parse('2026-10-13T12:00:00Z');
const REPO = path.resolve('/r/alpha');
const sec = (iso) => Date.parse(iso) / 1000;
const keys = (dir) => ({ key: `local:${path.basename(dir)}`, name: path.basename(dir) });

function fakeGit({ email = 'me@x.io', log = '', emailOk = true } = {}) {
  const calls = [];
  const runGit = async (dir, args) => {
    calls.push({ dir, args });
    if (args.includes('config')) return { ok: emailOk, stdout: emailOk ? `${email}\n` : '', stderr: '' };
    return { ok: true, stdout: log, stderr: '' };
  };
  return { runGit, calls };
}

test('parseLog keeps only this author (case-insensitive) and sane times', () => {
  const out = parseLog(
    [
      `${sec('2026-10-13T09:00:00Z')}\tMe@X.io`,
      `${sec('2026-10-13T09:30:00Z')}\tsomeone@else.io`,
      'junk',
      `-5\tme@x.io`,
      `${sec('2026-10-13T10:00:00Z')}\tme@x.io`,
    ].join('\n'),
    'me@x.io'
  );
  assert.deepEqual(out, [Date.parse('2026-10-13T09:00:00Z'), Date.parse('2026-10-13T10:00:00Z')]);
});

test('events: each of my commits becomes a moment keyed like the ledger', async () => {
  const { runGit, calls } = fakeGit({ log: `${sec('2026-10-13T09:00:00Z')}\tme@x.io\n` });
  const commits = createCommits({ listRepos: () => [REPO], resolveKey: keys, runGit, now: () => NOW });
  assert.deepEqual(await commits.events(), [{ ms: Date.parse('2026-10-13T09:00:00Z'), key: 'local:alpha', name: 'alpha' }]);
  const log = calls.find((c) => c.args.includes('log'));
  assert.equal(log.dir, REPO);
  assert.ok(log.args.includes('--no-merges'));
  assert.ok(log.args.some((a) => a === `--since=${new Date(NOW - 14 * 86400000).toISOString()}`));
});

test('events: a repo without user.email is skipped (no way to tell my commits apart)', async () => {
  const { runGit, calls } = fakeGit({ emailOk: false });
  const commits = createCommits({ listRepos: () => [REPO], resolveKey: keys, runGit, now: () => NOW });
  assert.deepEqual(await commits.events(), []);
  assert.ok(!calls.some((c) => c.args.includes('log')));
});

test('events: relative, UNC or non-string repo paths are never handed to git', async () => {
  const { runGit, calls } = fakeGit();
  const commits = createCommits({ listRepos: () => ['rel/path', '\\\\host\\share\\x', 42, null], resolveKey: keys, runGit, now: () => NOW });
  assert.deepEqual(await commits.events(), []);
  assert.equal(calls.length, 0);
});

test('events are cached for the TTL, then re-read', async () => {
  let t = NOW;
  const { runGit, calls } = fakeGit({ log: `${sec('2026-10-13T09:00:00Z')}\tme@x.io\n` });
  const commits = createCommits({ listRepos: () => [REPO], resolveKey: keys, runGit, now: () => t, ttlMs: 1000 });
  await commits.events();
  await commits.events();
  assert.equal(calls.length, 2);
  t += 1001;
  await commits.events();
  assert.equal(calls.length, 4);
});

test('a git that throws yields no moments for that repo, not a crash', async () => {
  const runGit = async () => {
    throw new Error('boom');
  };
  const commits = createCommits({ listRepos: () => [REPO], resolveKey: keys, runGit, now: () => NOW });
  assert.deepEqual(await commits.events(), []);
});

test('a slow cold scan is cut off at the deadline (empty), and its result lands in the cache', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const runGit = async (dir, args) => {
    await gate;
    return args.includes('config') ? { ok: true, stdout: 'me@x.io\n' } : { ok: true, stdout: `${sec('2026-10-13T09:00:00Z')}\tme@x.io\n` };
  };
  const commits = createCommits({ listRepos: () => [REPO], resolveKey: keys, runGit, now: () => NOW, deadlineMs: 20 });
  assert.deepEqual(await commits.events(), []);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await commits.events()).length, 1);
});

test('a stale cache is served at once while a refresh runs in the background', async () => {
  let t = NOW;
  let calls = 0;
  const runGit = async (dir, args) => {
    calls += 1;
    return args.includes('config') ? { ok: true, stdout: 'me@x.io\n' } : { ok: true, stdout: `${sec('2026-10-13T09:00:00Z')}\tme@x.io\n` };
  };
  const commits = createCommits({ listRepos: () => [REPO], resolveKey: keys, runGit, now: () => t, ttlMs: 1000 });
  const first = await commits.events();
  t += 5000;
  assert.equal(await commits.events(), first, 'stale cache returned without waiting');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 4, 'refresh ran');
});

test('git runs with fsmonitor disabled (no hook programs from a repo config)', async () => {
  const { runGit, calls } = fakeGit({ log: '' });
  await createCommits({ listRepos: () => [REPO], resolveKey: keys, runGit, now: () => NOW }).events();
  assert.ok(calls.every((c) => c.args[0] === '-c' && c.args[1] === 'core.fsmonitor=false'));
});
