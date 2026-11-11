// ============================================================================
// LunaCore - one memory: validation, the markdown file, the sync key
// (src/memoryrecord.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkRecord,
  normalizeRecord,
  keyOf,
  splitKey,
  validProject,
  projectFromRepoKey,
  parseFrontmatter,
  serializeRecord,
  recordFromFile,
  fromAutoMemory,
  MAX_BODY,
} = require('../src/memoryrecord.js');

const PROJECT = 'github.com/acme/demo';
const base = (over = {}) => ({
  id: 'worktree-junction',
  type: 'gotcha',
  project: PROJECT,
  title: 'Do not junction node_modules into a worktree',
  created: '2026-10-21',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: 'Run npm ci inside the worktree instead.',
  ...over,
});

test('accepts a valid record and keeps only known fields', () => {
  const record = normalizeRecord(base({ extra: 'dropped', area: 'worktrees', last_verified: '2026-11-02' }));

  assert.equal(record.extra, undefined);
  assert.equal(record.area, 'worktrees');
  assert.equal(record.last_verified, '2026-11-02');
  assert.equal(keyOf(record), `${PROJECT}/worktree-junction`);
});

test('names the first field that is wrong', () => {
  assert.equal(checkRecord(base({ id: 'Bad Id' })).error, 'bad-id');
  assert.equal(checkRecord(base({ type: 'rumour' })).error, 'bad-type');
  assert.equal(checkRecord(base({ project: 'demo' })).error, 'bad-project');
  assert.equal(checkRecord(base({ created: '2026-13-01' })).error, 'bad-created');
  assert.equal(checkRecord(base({ confidence: 'sure' })).error, 'bad-confidence');
  assert.equal(checkRecord(base({ body: '  ' })).error, 'empty-body');
  assert.equal(checkRecord(base({ body: 'x'.repeat(MAX_BODY + 1) })).error, 'body-too-long');
  assert.equal(checkRecord(null).error, 'not-an-object');
});

test('rejects a record too big for one sync unit', () => {
  // Under the character limit, over the byte limit once encoded.
  assert.equal(checkRecord(base({ body: 'ż'.repeat(MAX_BODY - 10) })).error, 'record-too-big');
});

test('a project is a normalised remote or global, never a path trick', () => {
  assert.equal(validProject('global'), true);
  assert.equal(validProject('gitlab.com/group/sub/repo'), true);
  assert.equal(validProject('github.com/../repo'), false);
  assert.equal(validProject('github.com/Acme/demo'), false);
  assert.equal(validProject('github.com/acme'), false);
  assert.equal(validProject('c:/users/x/y'), false);
  assert.equal(projectFromRepoKey('git:github.com/acme/demo'), PROJECT);
  assert.equal(projectFromRepoKey('local:demo'), null);
  assert.equal(projectFromRepoKey('other'), null);
});

test('a project segment cannot look like a memory file or end in a dot', () => {
  assert.equal(validProject('github.com/acme/x.md'), false);
  assert.equal(validProject('github.com/acme.tmp/demo'), false);
  assert.equal(validProject('github.com/acme/demo.'), false);
  assert.equal(validProject('github.com/acme/demo.js'), true);
});

test('strips what a reader cannot see and what the cloud cannot store', () => {
  const record = normalizeRecord(
    base({
      title: 'Red\u001b[31m alert​ \ud83d',
      source: 'session\u0000 7f3a‮',
      body: 'Line one\u0000\r\n\tindented \u{E0041}tag‍\nlone \ud83d end',
    }),
  );

  assert.equal(record.title, 'Red [31m alert �');
  assert.equal(record.source, 'session 7f3a');
  assert.equal(record.body, 'Line one\n\tindented tag\nlone � end');
  assert.doesNotThrow(() => encodeURIComponent(JSON.stringify(record)));
});

test('splits a unit key on its last slash', () => {
  assert.deepEqual(splitKey(`${PROJECT}/worktree-junction`), { project: PROJECT, id: 'worktree-junction' });
  assert.deepEqual(splitKey('global/english-comments'), { project: 'global', id: 'english-comments' });
  assert.equal(splitKey('_health/work-pc'), null);
  assert.equal(splitKey(`${PROJECT}/../x`), null);
  assert.equal(splitKey('nokey'), null);
});

test('drops invalid, duplicate and self references', () => {
  const record = normalizeRecord(base({ links: ['a-b', 'a-b', 'Not Valid', 'worktree-junction'], supersedes: ['old-one', 7] }));

  assert.deepEqual(record.links, ['a-b']);
  assert.deepEqual(record.supersedes, ['old-one']);
});

test('a record survives the trip through its markdown file', () => {
  const tricky = normalizeRecord(
    base({
      title: 'Release: upload as "LunaCore-Setup-X.exe" # with dashes',
      source: 'session 7f3a / commit 2ef0680',
      area: 'release',
      last_verified: '2026-11-02',
      links: ['gm-deps-asar-lock'],
      supersedes: ['old-release-note'],
      body: 'Zażółć gęślą jaźń.\n\n**Why:** latest.yml names the asset.\n---\nA rule inside the body.',
    }),
  );

  const back = recordFromFile(serializeRecord(tricky), { project: tricky.project, id: tricky.id });

  assert.deepEqual(back.record, tricky);
});

test('the file path decides id and project, not the frontmatter', () => {
  const text = serializeRecord(normalizeRecord(base()));

  const { record } = recordFromFile(text, { project: 'global', id: 'renamed' });

  assert.equal(record.id, 'renamed');
  assert.equal(record.project, 'global');
});

test('reads a hand-written file: comments, no title, no confidence', () => {
  const text = [
    '---',
    'type: gotcha            # one of the eight types',
    'created: 2026-10-21',
    'links: [gm-deps-asar-lock]',
    '---',
    '## Do not create **new** junctions',
    '',
    'More detail.',
  ].join('\r\n');

  const { record } = recordFromFile(text, { project: PROJECT, id: 'hand-written' });

  assert.equal(record.type, 'gotcha');
  assert.equal(record.title, 'Do not create new junctions');
  assert.equal(record.confidence, 'observed');
  assert.deepEqual(record.links, ['gm-deps-asar-lock']);
});

test('a file without frontmatter is not a memory', () => {
  assert.equal(recordFromFile('just text', { project: PROJECT, id: 'x' }).error, 'no-frontmatter');
  assert.equal(recordFromFile('---\ntype: gotcha\nno end', { project: PROJECT, id: 'x' }).error, 'no-frontmatter');
});

test('frontmatter cannot set prototype keys', () => {
  const { front } = parseFrontmatter('---\n__proto__: x\nconstructor: y\ntype: gotcha\n---\nbody');

  assert.deepEqual(Object.keys(front), ['type']);
});

test('imports a Claude Code auto-memory file as confirmed', () => {
  const text = [
    '---',
    'name: release-asset-names',
    'description: "Installer must be uploaded as LunaCore-Setup-X.exe (dashes); gh \\"#label\\" does not rename"',
    'metadata:',
    '  node_type: memory',
    '  type: project',
    '  originSessionId: 795f46cc-3701-4108-bcbe-c2089fc8afee',
    '  modified: 2026-11-05T08:15:10.487Z',
    '---',
    '',
    'Copy the installer to a dashed name first. See [[gm-deps-asar-lock]].',
  ].join('\n');

  const { record } = fromAutoMemory(text, { fileId: 'release-asset-names', project: PROJECT, fallbackDate: '2026-01-01' });

  assert.equal(record.id, 'release-asset-names');
  assert.equal(record.type, 'project-fact');
  assert.equal(record.project, PROJECT);
  assert.equal(record.title, 'Installer must be uploaded as LunaCore-Setup-X.exe (dashes); gh "#label" does not rename');
  assert.equal(record.created, '2026-11-05');
  assert.equal(record.confidence, 'confirmed');
  assert.equal(record.source, 'claude auto-memory, session 795f46cc-3701-4108-bcbe-c2089fc8afee');
  assert.deepEqual(record.links, ['gm-deps-asar-lock']);
});

test('an auto-memory about the user becomes a global preference', () => {
  const text = '---\nname: Mati Prefers Short Answers\nmetadata:\n  type: user\n---\nKeep it short.';

  const { record } = fromAutoMemory(text, { fileId: 'file-name', project: PROJECT, fallbackDate: '2026-01-01' });

  assert.equal(record.id, 'mati-prefers-short-answers');
  assert.equal(record.project, 'global');
  assert.equal(record.type, 'preference');
  assert.equal(record.created, '2026-01-01');
});
