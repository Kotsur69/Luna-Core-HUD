// ============================================================================
// LunaCore - memory search (src/memoryindex.js)
// ----------------------------------------------------------------------------
// The records are synthetic versions of the examples in
// docs/untouched_docs/rag-stylememory.md, section 9: the first questions of
// the golden set.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIndex, toMatch } = require('../src/memoryindex.js');
const { keyOf } = require('../src/memoryrecord.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/quote';

const rec = (id, title, body, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title,
  created: '2026-10-21',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body,
  ...over,
});

const RECORDS = [
  rec(
    'package-timeout-battery-sleep',
    'A package run that says restarted: timeout is usually the laptop sleeping on battery',
    'Check the Kernel-Power 42 event with reason Battery before debugging the package itself.',
  ),
  rec(
    'worktree-node-modules-junction',
    'Do not junction node_modules into a worktree',
    'git worktree remove follows the junction and empties the main node_modules. Run npm ci --ignore-scripts in the worktree.',
  ),
  rec(
    'release-asset-names',
    'Name the installer asset LunaCore-Setup-X.exe for a release',
    'With spaces in the name the auto-update download breaks, because latest.yml points at the dashed name.',
    { type: 'how-to' },
  ),
  rec(
    'gm-retry-busy-stuck-finalizer',
    'God Mode Retry answers busy after the laptop slept',
    'integration.state stays running after a sleep. Restart the app.',
  ),
  rec('prisma-pool', 'Prisma connection pool exhausts under next dev', 'Reuse one PrismaClient on globalThis in development.', { project: OTHER }),
  rec('english-comments', 'Code comments are always English', 'Polish UI strings in config are written without diacritics: wysłania becomes wyslania.', {
    project: 'global',
    type: 'preference',
  }),
];

const index = (records = RECORDS) => createIndex(records.map((r) => [keyOf(r), r]));
const top = (query, opts) => index().search(query, opts)[0]?.id;

test('answers the golden questions from the plan', () => {
  assert.equal(top('A package run says restarted: timeout. Where do I look first?'), 'package-timeout-battery-sleep');
  assert.equal(top('Can I junction node_modules into a worktree?'), 'worktree-node-modules-junction');
  assert.equal(top('How do I name the installer asset for a release?'), 'release-asset-names');
  assert.equal(top('God Mode Retry says busy after the laptop slept.'), 'gm-retry-busy-stuck-finalizer');
});

test('finds exact tokens: an event id, a flag, a word only in the id', () => {
  assert.equal(top('Kernel-Power 42'), 'package-timeout-battery-sleep');
  assert.equal(top('--ignore-scripts'), 'worktree-node-modules-junction');
  assert.equal(top('finalizer'), 'gm-retry-busy-stuck-finalizer');
});

test('matches Polish with or without diacritics', () => {
  assert.equal(top('wyslania'), 'english-comments');
  assert.equal(top('WYSŁANIA'), 'english-comments');
});

test('a result carries what is needed to judge it', () => {
  const [hit] = index().search('prisma pool');

  assert.equal(hit.key, `${OTHER}/prisma-pool`);
  assert.equal(hit.project, OTHER);
  assert.equal(hit.confidence, 'confirmed');
  assert.equal(hit.created, '2026-10-21');
  assert.equal(hit.last_verified, null);
  assert.match(hit.snippet, /PrismaClient/);
  assert.ok(hit.score > 0);
});

test('ranks the current project above another project with the same words', () => {
  const twins = [
    rec('timeout-a', 'Build timeout on the CI runner', 'Raise the limit.', { project: OTHER }),
    rec('timeout-b', 'Build timeout on the CI runner', 'Raise the limit.'),
  ];

  const ids = (project) =>
    index(twins)
      .search('build timeout', { project })
      .map((h) => h.id);

  assert.deepEqual(ids(PROJECT), ['timeout-b', 'timeout-a']);
  assert.deepEqual(ids(OTHER), ['timeout-a', 'timeout-b']);
});

test('ranks a confirmed memory above an unverified one', () => {
  const twins = [
    rec('seen-once', 'Flaky cleanup after git tests', 'Retry the removal.', { confidence: 'observed' }),
    rec('proven', 'Flaky cleanup after git tests', 'Retry the removal.'),
  ];

  assert.deepEqual(
    index(twins)
      .search('flaky cleanup')
      .map((h) => h.id),
    ['proven', 'seen-once'],
  );
});

test('leaves out a memory that a newer one supersedes', () => {
  const pair = [
    rec('old-rule', 'Separate run for God Mode cards', 'Cards that change God Mode need their own run.'),
    rec('new-rule', 'God Mode cards may build God Mode cards', 'No separate run rule.', { supersedes: ['old-rule'] }),
  ];

  assert.deepEqual(
    index(pair)
      .search('God Mode cards run')
      .map((h) => h.id),
    ['new-rule'],
  );
});

test('`only` keeps the search inside one project plus global', () => {
  const ids = index()
    .search('prisma comments english pool', { only: PROJECT })
    .map((h) => h.id);

  assert.deepEqual(ids, ['english-comments']);
});

test('respects the limit', () => {
  assert.equal(index().search('the a after node release god', { limit: 2 }).length, 2);
});

test('search syntax in a question is plain text', () => {
  const idx = index();

  assert.doesNotThrow(() => idx.search('"unbalanced AND NEAR( title: * ) OR'));
  assert.equal(idx.search('title:worktree" OR "x')[0].id, 'worktree-node-modules-junction');
  assert.deepEqual(idx.search('   '), []);
  assert.deepEqual(idx.search('?!'), []);
  assert.deepEqual(idx.search(null), []);
});

test('builds the match expression from quoted prefix terms', () => {
  assert.equal(toMatch('Worktree junction, a worktree!'), '"worktree"* OR "junction"*');
  assert.equal(toMatch(''), null);
});
