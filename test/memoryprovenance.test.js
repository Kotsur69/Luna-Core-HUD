'use strict';

// originSnippet(): the origin-session drawer's excerpt (src/memoryprovenance.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { originSnippet, bestWindow, realInside, ORIGIN_MAX_LINES, ORIGIN_MAX_CHARS } = require('../src/memoryprovenance');

// A secret-shaped string assembled at runtime: the full shape never appears in the source.
const FAKE_KEY = ['s', 'k-'].join('') + 'q'.repeat(28);

async function tmpRoot(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'luna-origin-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

const userLine = (text) => JSON.stringify({ type: 'user', message: { content: text } });
const assistantLine = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

/** A Claude Code transcript: filler turns, and one exchange about the junction gotcha in the middle. */
function transcript({ filler = 60, middle = [] } = {}) {
  const lines = [];
  for (let i = 0; i < filler; i++) lines.push(i % 2 ? assistantLine(`Routine reply number ${i} about styling tweaks.`) : userLine(`Please adjust padding ${i}.`));
  lines.push(...middle);
  for (let i = 0; i < filler; i++) lines.push(assistantLine(`Another unrelated answer ${i} on colours.`));
  return lines.join('\n');
}

const record = (source, extra = {}) => ({
  title: 'git worktree remove empties node_modules junction target',
  body: 'Removing a worktree whose node_modules is a junction deletes the main checkout dependencies.',
  source,
  ...extra,
});

async function writeClaude(root, name, text) {
  const dir = path.join(root, 'C--Users-dev-repo');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, name), text);
}

test('a Claude session: the window with the memory words is returned, capped', async (t) => {
  const root = await tmpRoot(t);
  await writeClaude(
    root,
    'abcdef12-1111-2222-3333-444455556666.jsonl',
    transcript({
      middle: [
        userLine('Why did node_modules vanish after git worktree remove?'),
        assistantLine('The worktree node_modules was a junction, so removing the worktree deleted the junction target dependencies.'),
      ],
    }),
  );
  const res = await originSnippet({ record: record('captured from session abcdef12 on WORK-PC'), transcriptsDir: root });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'session');
  assert.equal(res.format, 'claude');
  assert.equal(res.ref, 'abcdef12');
  assert.equal(res.file, 'abcdef12-1111-2222-3333-444455556666.jsonl');
  assert.match(res.excerpt, /junction target dependencies/);
  assert.ok(res.lines <= ORIGIN_MAX_LINES);
  assert.ok(res.excerpt.length <= ORIGIN_MAX_CHARS + 4);
  assert.ok(res.matched.includes('junction'));
  // Only the file name goes back, never a path.
  assert.ok(!res.file.includes(path.sep));
});

test('a secret in the matching window is scrubbed', async (t) => {
  const root = await tmpRoot(t);
  await writeClaude(
    root,
    'abcdef12-aaaa.jsonl',
    transcript({ middle: [assistantLine(`The junction worktree node_modules gotcha; the key was ${FAKE_KEY} by the way.`)] }),
  );
  const res = await originSnippet({ record: record('captured from session abcdef12 on PC'), transcriptsDir: root });
  assert.equal(res.ok, true);
  assert.match(res.excerpt, /junction/);
  assert.ok(!res.excerpt.includes(FAKE_KEY));
  assert.match(res.excerpt, /\[redacted\]/);
});

test('long lines and long windows are cut to the char and line caps', async (t) => {
  const root = await tmpRoot(t);
  const long = Array.from({ length: 40 }, (_, i) => assistantLine(`junction worktree node_modules ${i} ${'word '.repeat(200)}`));
  await writeClaude(root, 'abcdef12-long.jsonl', long.join('\n'));
  const res = await originSnippet({ record: record('captured from session abcdef12 on PC'), transcriptsDir: root });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  assert.ok(res.excerpt.length <= ORIGIN_MAX_CHARS + 4, `excerpt is ${res.excerpt.length} chars`);
  assert.ok(res.lines <= ORIGIN_MAX_LINES);
});

test('a God Mode run report is read from the runs folder', async (t) => {
  const runs = await tmpRoot(t);
  const report = ['# Run abc123', ...Array.from({ length: 50 }, (_, i) => `step ${i} done`), 'Gotcha: git worktree remove deleted the junction node_modules.', 'end'];
  await fs.promises.writeFile(path.join(runs, 'abc123.md'), report.join('\n'));
  const res = await originSnippet({ record: record('captured from God Mode run abc123 on PC, auto-accepted'), runsDir: runs });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'godmode');
  assert.equal(res.format, 'report');
  assert.match(res.excerpt, /deleted the junction node_modules/);
});

test('an agy conversation is found by its folder name', async (t) => {
  const brain = await tmpRoot(t);
  const logs = path.join(brain, 'ABCDEF12-0000-0000-0000-000000000000', '.system_generated', 'logs');
  await fs.promises.mkdir(logs, { recursive: true });
  const steps = [
    JSON.stringify({ type: 'USER_INPUT', content: 'tidy the css' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'The junction under node_modules made git worktree remove empty the target.' }),
  ];
  await fs.promises.writeFile(path.join(logs, 'transcript.jsonl'), steps.join('\n'));
  const res = await originSnippet({ record: record('captured from session abcdef12 on PC'), transcriptsDir: null, agyDir: brain });
  assert.equal(res.ok, true);
  assert.equal(res.format, 'agy');
  assert.match(res.excerpt, /PLANNER_RESPONSE: The junction/);
});

test('no usable source: hand-written, merged, or a malformed id', async () => {
  for (const source of [undefined, '', 'merged by hand from a-b and c-d', 'captured from God Mode run ../etc on PC', 'written by hand']) {
    const res = await originSnippet({ record: record(source), transcriptsDir: os.tmpdir(), runsDir: os.tmpdir() });
    assert.deepEqual(res, { ok: false, reason: 'no-source' }, `source ${source}`);
  }
  assert.deepEqual(await originSnippet({}), { ok: false, reason: 'no-source' });
});

test('a session that is not on this PC is not-found', async (t) => {
  const root = await tmpRoot(t);
  const res = await originSnippet({ record: record('captured from session ffffffff on PC'), transcriptsDir: root });
  assert.deepEqual(res, { ok: false, reason: 'not-found' });
});

test('realInside refuses a file outside the root and a symlink escaping it', async (t) => {
  const root = await tmpRoot(t);
  const outside = await tmpRoot(t);
  const secret = path.join(outside, 'abc123.md');
  await fs.promises.writeFile(secret, 'junction worktree node_modules outside');
  assert.equal(await realInside(root, secret), null);
  assert.equal(await realInside(root, path.join(root, '..', path.basename(outside), 'abc123.md')), null);
  assert.equal(await realInside(root, path.join(root, 'missing.md')), null);
  const inside = path.join(root, 'ok.md');
  await fs.promises.writeFile(inside, 'x');
  assert.equal(await realInside(root, inside), await fs.promises.realpath(inside));

  // A link inside the runs folder pointing out of it is never read.
  const link = path.join(root, 'abc123.md');
  try {
    await fs.promises.symlink(secret, link, 'file');
  } catch (err) {
    t.diagnostic(`symlink not created (${err.code}): the escape case is skipped on this machine`);
    return;
  }
  assert.equal(await realInside(root, link), null);
  const res = await originSnippet({ record: record('captured from God Mode run abc123 on PC'), runsDir: root });
  assert.deepEqual(res, { ok: false, reason: 'not-found' });
});

test('a directory junction inside the root that points out of it is refused', async (t) => {
  const root = await tmpRoot(t);
  const outside = await tmpRoot(t);
  await fs.promises.writeFile(path.join(outside, 'abcdef12-x.jsonl'), assistantLine('junction worktree node_modules'));
  const hop = path.join(root, 'C--escape');
  // Remove the junction itself before the temp folders go: never through it.
  t.after(() => fs.promises.unlink(hop).catch(() => {}));
  try {
    await fs.promises.symlink(outside, hop, 'junction');
  } catch (err) {
    t.diagnostic(`junction not created (${err.code}): skipped`);
    return;
  }
  assert.equal(await realInside(root, path.join(hop, 'abcdef12-x.jsonl')), null);
  const res = await originSnippet({ record: record('captured from session abcdef12 on PC'), transcriptsDir: root });
  assert.equal(res.ok, false);
});

test('bestWindow picks the window with the most distinct keywords, else the end', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  lines[30] = 'junction worktree';
  lines[33] = 'node_modules junction';
  const win = bestWindow(lines, new Set(['junction', 'worktree', 'node_modules']));
  assert.ok(win.start <= 30 && win.end > 33);
  assert.equal(win.end - win.start, ORIGIN_MAX_LINES);
  assert.deepEqual(new Set(win.matched), new Set(['junction', 'worktree', 'node_modules']));
  const none = bestWindow(lines, new Set(['absent']));
  assert.equal(none.end, 60);
  assert.equal(none.score, 0);
});
