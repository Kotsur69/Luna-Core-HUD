// ============================================================================
// LunaCore - `luna memory notes` (scripts/luna.js cmdNotes, parseSince)
// ----------------------------------------------------------------------------
// The CLI runs as a child process against a throwaway config folder and, for
// the tag default, a throwaway git repository. It must write nothing.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { parseSince, UsageError } = require('../scripts/luna.js');
const { writeRecord } = require('../src/memorystore.js');
const { memoryPaths } = require('../src/memorysync.js');
const { logPath } = require('../src/memorylog.js');

const CLI = path.join(__dirname, '..', 'scripts', 'luna.js');
const PROJECT = 'github.com/acme/hud';

test('--since takes a tag name or an ISO date; anything else is refused', () => {
  assert.deepEqual(parseSince(undefined), { latest: true });
  assert.deepEqual(parseSince('v0.28.0'), { tag: 'v0.28.0' });
  assert.deepEqual(parseSince('2026-11-01'), { date: Date.parse('2026-11-01T00:00:00Z'), label: '2026-11-01' });
  assert.equal(parseSince('2026-11-01T10:00:00+01:00').date, Date.parse('2026-11-01T09:00:00Z'));
  for (const bad of ['2026-02-31', '2026-13-01', '--upload-pack=x', 'refs/tags/v1', 'v1..v2', 'v*', '', '-v1', 'a b']) {
    assert.throws(() => parseSince(bad), UsageError, bad);
  }
});

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-notes-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const configDir = path.join(root, 'config');
  const { dir } = memoryPaths(configDir);
  writeRecord(dir, {
    id: 'ledger-flake',
    type: 'gotcha',
    project: PROJECT,
    title: 'The ledger test flakes under load',
    created: '2026-11-02',
    confidence: 'confirmed',
    supersedes: [],
    links: [],
    body: 'BODY TEXT that the notes never print.',
  });
  const event = { at: Date.parse('2026-11-02T10:00:00Z'), ev: 'approved', key: `${PROJECT}/ledger-flake`, type: 'gotcha' };
  fs.writeFileSync(logPath(configDir), `${JSON.stringify(event)}\n`);
  return { root, configDir };
}

/** Every file under a folder with its size and change time, to prove nothing was written. */
const snapshot = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .sort()
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return `${f}:${stat.size}:${stat.mtimeMs}`;
    });

const run = (args, cwd) => spawnSync(process.execPath, [CLI, 'memory', 'notes', ...args], { cwd, encoding: 'utf8', env: { ...process.env, LUNA_CONFIG_DIR: '' } });

test('notes since a date print the titles grouped by type, and write nothing', (t) => {
  const { configDir } = setup(t);
  const before = snapshot(configDir);
  const res = run(['--dir', configDir, '--project', PROJECT, '--since', '2026-11-01']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^# Memory notes since 2026-11-01 \(2026-11-01\), github\.com\/acme\/hud\n/);
  assert.match(res.stdout, /## Confirmed \(1\)\n\n### gotcha\n- The ledger test flakes under load\n/);
  assert.doesNotMatch(res.stdout, /BODY TEXT/);
  assert.deepEqual(snapshot(configDir), before);

  const later = run(['--dir', configDir, '--project', PROJECT, '--since', '2026-11-03']);
  assert.match(later.stdout, /## Confirmed \(0\)/);
});

test('bad --since and --project values are refused before anything is read', (t) => {
  const { configDir } = setup(t);
  const badDate = run(['--dir', configDir, '--project', PROJECT, '--since', '2026-02-31']);
  assert.equal(badDate.status, 1);
  assert.match(badDate.stderr, /not a valid date/);
  const badTag = run(['--dir', configDir, '--project', PROJECT, '--since=--upload-pack=evil']);
  assert.equal(badTag.status, 1);
  assert.match(badTag.stderr, /--since takes a tag name/);
  const badProject = run(['--dir', configDir, '--project', '../../etc', '--since', '2026-11-01']);
  assert.equal(badProject.status, 1);
  assert.match(badProject.stderr, /not a project key/);
});

test('without --since the notes start at the latest v* tag of the current repository', (t) => {
  const { root, configDir } = setup(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('tag', '-a', 'v1.0.0', '-m', 'one');
  git('tag', 'other-tag');

  const res = run(['--dir', configDir, '--project', PROJECT], repo);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^# Memory notes since v1\.0\.0 \(\d{4}-\d{2}-\d{2}\), github\.com\/acme\/hud\n/);

  const named = run(['--dir', configDir, '--project', PROJECT, '--since', 'v9.9.9'], repo);
  assert.equal(named.status, 1);
  assert.match(named.stderr, /no tag named v9\.9\.9/);
});
