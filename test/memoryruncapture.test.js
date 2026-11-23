// ============================================================================
// LunaCore - memory capture of a finished God Mode run (src/memoryruncapture.js,
// src/memoryrundigest.js)
// ----------------------------------------------------------------------------
// A fixture run view (what orchestraReport.buildReport renders) goes through
// the run capture with a stub model: one call per run at most, the session
// filter on its answer, the ledger, and the skips. These tests never start
// `claude`.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunCapture, readRunLedger, LEDGER_FILE } = require('../src/memoryruncapture.js');
const { runDigest, countRunOutside, outsideCalls, normalizeFailure, runFailureSignatures } = require('../src/memoryrundigest.js');
const { readFailureLedger, recordFailures, FAILURE_LEDGER_FILE, MAX_FAILURE_ENTRIES } = require('../src/memoryfailures.js');
const { MAX_PENDING } = require('../src/memorycapture.js');
const { listInbox } = require('../src/memoryinbox.js');
const { memoryPaths } = require('../src/memorysync.js');
const { setEnabled } = require('../src/memoryprojects.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { createLog, logPath } = require('../src/memorylog.js');
const { readGraveyard, graveyardPath } = require('../src/memorygraveyard.js');
const { worktreePathFor } = require('../src/worktrees.js');
const { encodeProjectDir } = require('../src/observer.js');

const PROJECT = 'github.com/acme/hud';
const REPO = path.resolve('/repos/hud');
const RUN_ID = 'pmabc123';
const NOW = Date.parse('2026-11-13T08:00:00Z');
// Assembled at runtime: the whole key shape never appears in the source.
const FAKE_KEY = ['sk', 'c'.repeat(24)].join('-');

/** A settled run as orchestra view() shows it: one pushed, one stalled, one never started. */
const fixtureView = () => ({
  id: RUN_ID,
  workerModel: 'sonnet',
  integrationMode: 'merge',
  baseBranch: 'main',
  hold: { reason: 'noNodeModules', dir: REPO, detail: 'EBUSY on default_app.asar', cause: 'unresolved', missing: 'electron', at: 1 },
  recoveries: [{ kind: 'recover', reason: 'integrationRetry', detail: 'fetch failed, retried once', at: 3 }],
  integration: {
    state: 'done',
    skipped: [{ id: 'pkg-c', stage: 'verify', detail: 'AssertionError: expected 2 to equal 3', files: ['src/a.js'], fixup: 'failed' }],
    selfCheck: { tests: 'failed', syntax: 'passed', tail: 'ok 1 - store\nnot ok 3 - card\n# fail 1' },
    secondPass: ['pkg-a'],
  },
  packages: [
    { id: 'pkg-a', title: 'Card note', state: 'pushed', startedAt: 10, branch: 'luna/pkg-a-x1', lastWords: 'LUNA_DONE pkg-a', touched: ['src/memorycard.js'] },
    {
      id: 'pkg-b',
      title: 'Run capture',
      state: 'stalled',
      error: 'verifyFailed',
      detail: '2 tests failing',
      startedAt: 20,
      branch: 'luna/pkg-b-y2',
      stalls: 2,
      autoRetries: 1,
      verifyRounds: 2,
      verify: 'npm test',
      stallHistory: [{ kind: 'stall', reason: 'noMarker', detail: 'turn ended while npm test ran', at: 5 }],
      verifyTail: 'ok 1 - digest\nnot ok 2 - ledger\n# fail 1',
      lastWords: `Gave up: the env had ${FAKE_KEY} and the ledger test kept failing`,
    },
    { id: 'pkg-c', title: 'Never launched', state: 'pending', blockedBy: 'pkg-b' },
  ],
});

const candidate = (title, over = {}) => ({ type: 'gotcha', scope: 'project', title, body: `${title}. Unique body for ${title}.`, usefulness: 70, ...over });
const reply = (...candidates) => ({ ok: true, answer: { candidates } });

function setup(t, { enabled = true, outside = 0 } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-runcap-'));
  t.after(() => fs.promises.rm(configDir, { recursive: true, force: true, maxRetries: 5 }));
  if (enabled) setEnabled(memoryPaths(configDir).projects, PROJECT, true);
  const state = { reply: reply(candidate('Do not junction node_modules into a worktree')), prompts: [], saved: [] };
  const log = createLog(logPath(configDir), { now: () => NOW });
  const make = () =>
    createRunCapture({
      configDir,
      machine: 'PC1',
      now: () => NOW,
      log,
      projectOf: (repo) => (repo === REPO ? `git:${PROJECT}` : null),
      countOutside: async () => outside,
      onSaved: (n) => state.saved.push(n),
      run: async ({ prompt }) => {
        state.prompts.push(prompt);
        return typeof state.reply === 'function' ? state.reply() : state.reply;
      },
    });
  const dir = memoryPaths(configDir).dir;
  return { configDir, dir, state, log, make, capture: make(), ledger: () => readRunLedger(path.join(configDir, LEDGER_FILE)).runs };
}

const finished = (over = {}) => ({ runId: RUN_ID, repoPath: REPO, view: fixtureView(), ...over });

// ---- one call, the session filter ---------------------------------------------------

test('a finished run costs one call; its candidates wait in the inbox with the run id in their source', async (t) => {
  const s = setup(t);
  const res = await s.capture.capture(finished());

  assert.deepEqual(res, { handed: true, reason: 'saved', saved: 1 });
  assert.equal(s.state.prompts.length, 1);
  const { items } = listInbox(s.dir);
  assert.equal(items.length, 1);
  const [, record] = scan(s.dir).records[0];
  assert.equal(record.confidence, 'observed');
  assert.equal(record.project, PROJECT);
  assert.equal(record.source, `captured from God Mode run ${RUN_ID} on PC1`);
  assert.deepEqual(s.state.saved, [1]);
  assert.equal(s.ledger()[RUN_ID].reason, 'saved');
});

test('the prompt is the run digest: packages, failures, stalls, retries, verify details, holds - scrubbed', async (t) => {
  const s = setup(t);
  await s.capture.capture(finished());
  const [prompt] = s.state.prompts;

  assert.match(prompt, /God Mode run/);
  assert.match(prompt, /=== RUN DIGEST ===/);
  assert.doesNotMatch(prompt, /"status"/);
  for (const fact of [
    'Package pkg-a "Card note": pushed',
    'Package pkg-b "Run capture": stalled - verifyFailed: 2 tests failing',
    'tried: 2 stalls, 1 automatic retry, 2 verify fix-up rounds',
    'stall: noMarker - turn ended while npm test ran',
    'verify command: npm test',
    'not ok 2 - ledger',
    'The whole run is held: noNodeModules (unresolved, missing electron) - EBUSY on default_app.asar',
    'pkg-c left out of the merge at verify: AssertionError: expected 2 to equal 3; files: src/a.js; a fix-up worker could not get it green',
    'self-check after the merge failed: tests',
    'fixed automatically: integrationRetry - fetch failed, retried once',
  ]) {
    assert.ok(prompt.includes(fact), `missing: ${fact}`);
  }
  assert.ok(!prompt.includes(FAKE_KEY), 'a secret in worker output is masked before the call');
});

test('the model cannot set id, project or source, and at most five candidates are kept', async (t) => {
  const s = setup(t);
  const titles = ['Alpha gotcha one', 'Bravo trap two', 'Charlie error three', 'Delta hang four', 'Echo lock five', 'Foxtrot flake six', 'Golf leak seven'];
  s.state.reply = reply(...titles.map((title) => candidate(title, { id: 'evil', project: 'github.com/evil/repo', source: 'trusted', confidence: 'confirmed' })));

  const res = await s.capture.capture(finished());

  assert.equal(res.saved, 5);
  for (const [key, record] of scan(s.dir).records) {
    assert.ok(key.startsWith(`${PROJECT}/`));
    assert.notEqual(record.id, 'evil');
    assert.equal(record.confidence, 'observed');
    assert.equal(record.source, `captured from God Mode run ${RUN_ID} on PC1`);
  }
});

test('the session filter applies: usefulness floor, secrets and duplicates are dropped and logged', async (t) => {
  const s = setup(t);
  s.state.reply = reply(
    candidate('Weak note about the weather', { usefulness: 10 }),
    candidate('Leaky deploy step', { body: `Run the deploy with ${FAKE_KEY} set.` }),
    candidate('Kept gotcha about ledgers'),
    candidate('Kept gotcha about ledgers'),
  );

  const res = await s.capture.capture(finished());

  assert.equal(res.saved, 1);
  const events = s.log.read().map(({ at, ...e }) => e);
  assert.deepEqual(events.find((e) => e.ev === 'dropped'), { ev: 'dropped', project: PROJECT, reason: 'low usefulness', type: 'gotcha', title: 'Weak note about the weather', usefulness: 10 });
  assert.deepEqual(events.find((e) => e.ev === 'capture'), { ev: 'capture', project: PROJECT, reason: 'saved', kept: 1, dropped: { 'low usefulness': 1, secret: 1, duplicate: 1 } });
});

test('a run candidate under the usefulness floor lands in the graveyard with its whole body', async (t) => {
  const s = setup(t);
  s.state.reply = reply(candidate('Weak note about the weather', { usefulness: 10 }), candidate('Kept gotcha about ledgers'));

  await s.capture.capture(finished());

  const graves = readGraveyard(graveyardPath(s.configDir), NOW);
  assert.equal(graves.length, 1);
  assert.equal(graves[0].reason, 'low usefulness');
  assert.equal(graves[0].score, 10);
  assert.equal(graves[0].record.body, 'Weak note about the weather. Unique body for Weak note about the weather.');
  assert.equal(graves[0].record.source, `captured from God Mode run ${RUN_ID} on PC1`);
  assert.equal(graves[0].record.confidence, 'observed');
  assert.deepEqual(listInbox(s.dir).items.map((i) => i.title), ['Kept gotcha about ledgers']);
});

test('zero candidates is a capture too: the run is marked and nothing waits', async (t) => {
  const s = setup(t);
  s.state.reply = reply();
  const res = await s.capture.capture(finished());
  assert.deepEqual(res, { handed: true, reason: 'nothing', saved: 0 });
  assert.equal(listInbox(s.dir).items.length, 0);
  assert.deepEqual(s.state.saved, []);
});

test('rejected titles reach the run prompt as not wanted', async (t) => {
  const s = setup(t);
  s.log.add({ ev: 'rejected', key: `${PROJECT}/old-idea`, type: 'gotcha', title: 'Always rerun npm test twice' });
  await s.capture.capture(finished());
  assert.match(s.state.prompts[0], /- "Always rerun npm test twice"/);
});

// ---- never twice --------------------------------------------------------------------

test('a run is never captured twice: not again, not after a restart, not twice at once', async (t) => {
  const s = setup(t);
  const [first, second] = await Promise.all([s.capture.capture(finished()), s.capture.capture(finished())]);
  assert.equal(first.handed, true);
  assert.deepEqual(second, { handed: false, reason: 'already', saved: 0 });

  assert.equal((await s.capture.capture(finished())).reason, 'already');
  assert.equal((await s.make().capture(finished())).reason, 'already');
  assert.equal(s.state.prompts.length, 1);
});

test('a failed model call still marks the run: one call per run at most', async (t) => {
  const s = setup(t);
  s.state.reply = { ok: false, reason: 'timeout' };
  assert.deepEqual(await s.capture.capture(finished()), { handed: true, reason: 'model-timeout', saved: 0 });
  s.state.reply = reply(candidate('Would have been kept'));
  assert.equal((await s.capture.capture(finished())).reason, 'already');
  assert.equal(s.state.prompts.length, 1);
});

test('the run is in the ledger before the model answers', async (t) => {
  const s = setup(t);
  let seen = null;
  s.state.reply = () => {
    seen = s.ledger()[RUN_ID];
    return reply();
  };
  await s.capture.capture(finished());
  assert.equal(seen.reason, 'started');
  assert.equal(seen.project, PROJECT);
});

// ---- skips --------------------------------------------------------------------------

test('a project with memory switched off is skipped, without a ledger entry', async (t) => {
  const s = setup(t, { enabled: false });
  assert.deepEqual(await s.capture.capture(finished()), { handed: false, reason: 'disabled', saved: 0 });
  assert.deepEqual(await s.capture.capture(finished({ repoPath: path.resolve('/repos/unknown') })), { handed: false, reason: 'disabled', saved: 0 });
  assert.equal(s.state.prompts.length, 0);
  assert.deepEqual(s.ledger(), {});
});

test('a full inbox pauses run capture for the project', async (t) => {
  const s = setup(t);
  for (let i = 0; i < MAX_PENDING; i++) {
    writeRecord(s.dir, {
      id: `waiting-${i}`,
      type: 'gotcha',
      project: PROJECT,
      // Distinct words per entry: near-duplicates would be folded into one waiting entry.
      title: `Distinct${i} topic${i} lesson${i}`,
      created: '2026-11-12',
      confidence: 'observed',
      supersedes: [],
      links: [],
      body: `Text${i} only${i}.`,
    });
  }
  assert.deepEqual(await s.capture.capture(finished()), { handed: false, reason: 'inbox-full', saved: 0 });
  assert.equal(s.state.prompts.length, 0);
  assert.deepEqual(s.ledger(), {});
});

test('a run where no worker ever started costs no call; a mismatched view is refused', async (t) => {
  const s = setup(t);
  const idle = { ...fixtureView(), packages: [{ id: 'pkg-c', title: 'Never launched', state: 'pending' }] };
  assert.equal((await s.capture.capture(finished({ view: idle }))).reason, 'nothing-ran');
  assert.equal((await s.capture.capture(finished({ view: { ...fixtureView(), id: 'pother' } }))).reason, 'bad-run');
  assert.equal((await s.capture.capture(finished({ runId: '../evil' }))).reason, 'bad-run');
  assert.equal(s.state.prompts.length, 0);
});

// ---- outside content (decision 61) ------------------------------------------------

test('workers that read outside content mark the candidates', async (t) => {
  const s = setup(t, { outside: 2 });
  await s.capture.capture(finished());
  const [, record] = scan(s.dir).records[0];
  assert.equal(record.source, `captured from God Mode run ${RUN_ID} on PC1, read 2 outside source(s)`);
  const [item] = listInbox(s.dir).items;
  assert.equal(item.outside, 2);
});

test('when the outside count fails, the candidates are still marked (one source assumed)', async (t) => {
  const s = setup(t);
  const capture = createRunCapture({
    configDir: s.configDir,
    machine: 'PC1',
    now: () => NOW,
    projectOf: () => `git:${PROJECT}`,
    countOutside: async () => {
      throw new Error('EACCES');
    },
    run: async () => reply(candidate('Kept despite the count')),
  });
  assert.equal((await capture.capture(finished())).saved, 1);
  const [, record] = scan(s.dir).records[0];
  assert.equal(record.source, `captured from God Mode run ${RUN_ID} on PC1, read 1 outside source(s)`);
});

test('the ledger keeps the newest runs by time, whatever order the file has', (t) => {
  const s = setup(t);
  const runs = Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`p${509 - i}`, { at: 509 - i, project: PROJECT, reason: 'saved' }]));
  fs.writeFileSync(path.join(s.configDir, LEDGER_FILE), JSON.stringify({ runs: { ...runs, '../x': { at: 1 } } }));
  const kept = s.ledger();
  assert.equal(Object.keys(kept).length, 500);
  assert.ok(kept.p509 && !kept.p0 && !kept['../x']);
});

test('outside calls are counted in the workers transcripts; a worker without one counts as one', async (t) => {
  const transcriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-runcap-tx-'));
  t.after(() => fs.promises.rm(transcriptsDir, { recursive: true, force: true, maxRetries: 5 }));
  const tool = (name) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] } });
  const folder = path.join(transcriptsDir, encodeProjectDir(worktreePathFor(REPO, 'pkg-a-x1')));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'a.jsonl'), [tool('WebFetch'), tool('Read'), tool('mcp__lunacore__memory_search'), tool('Agent'), '{"torn'].join('\n'));

  // pkg-a: WebFetch + Agent; pkg-b ran but has no transcript here (1); pkg-c never ran (0).
  assert.equal(await countRunOutside({ repoPath: REPO, view: fixtureView(), transcriptsDir }), 3);
  assert.equal(outsideCalls([tool('WebSearch'), tool('mcp__github__get_issue'), tool('Bash')].join('\n')), 2);
  assert.equal(await countRunOutside({ repoPath: REPO, view: { packages: [] }, transcriptsDir }), 0);
});

test('the digest is capped and survives a hostile view', () => {
  const huge = { ...fixtureView(), packages: Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, title: 'x'.repeat(500), state: 'stalled', startedAt: 1, lastWords: 'y'.repeat(5000), verifyTail: 'z\n'.repeat(500) })) };
  const digest = runDigest(huge);
  assert.ok(digest.text.length <= 30000);
  assert.equal(digest.ran, 60);
  assert.equal(runDigest(null).ran, 0);
  assert.equal(runDigest({ packages: [null, 5, { id: 'a', state: 'pushed', title: 'line\nbreak', startedAt: 1 }] }).text.includes('line break'), true);
});

// ---- repeated failures across runs (src/memoryfailures.js) ----------------------------

const DAY = 24 * 60 * 60 * 1000;
const runOf = (id, view = fixtureView()) => finished({ runId: id, view: { ...view, id } });
/** A run that failed in one way only: the ledger test of verify. */
const ledgerFailure = () => ({
  id: RUN_ID,
  packages: [{ id: 'pkg-b', title: 'Run capture', state: 'stalled', startedAt: 1, verifyTail: 'ok 1 - digest\nnot ok 2 - ledger keeps order\n# fail 1' }],
});

test('a failure signature drops paths, numbers and hashes, so the same failure matches run after run', () => {
  const windows = normalizeFailure("Error: ENOENT: no such file, open 'C:\\Users\\mati\\repo\\src\\a.js' at line 42");
  assert.equal(windows, "error: enoent: no such file, open '<path>' at line");
  assert.equal(normalizeFailure("Cannot find module '/home/mati/repo/node_modules/foo/index.js' (commit 3f2a9c1d)"), "cannot find module '<path>' (commit )");
  assert.equal(normalizeFailure('AssertionError:   expected 2 to equal 3\tat 0xdeadbeef'), 'assertionerror: expected to equal at');
  assert.equal(normalizeFailure('fatal: luna/pkg-b-y2 is at a1b2c3d4e5f6, run 550e8400-e29b-41d4-a716-446655440000'), 'fatal: <branch> is at , run');
  assert.equal(normalizeFailure('not ok 12 - ledger'), normalizeFailure('not ok 7 - ledger'));
  assert.ok(normalizeFailure('x '.repeat(400)).length <= 160);
  // A quoted path keeps no part of itself, spaces and all.
  assert.equal(normalizeFailure("EPERM: unlink 'C:\\Users\\Jan Kowalski\\repo\\x.js'"), "eperm: unlink '<path>'");
  assert.equal(normalizeFailure('cannot read test/fixtures/a.json in src/memorylog.js'), 'cannot read <path> in <path>');
  // Error codes name the error and stay; a ratio or a pair of words is no path.
  assert.notEqual(normalizeFailure('error TS2304: cannot find name'), normalizeFailure('error TS2322: cannot find name'));
  assert.equal(normalizeFailure('3/5 passed, pass/fail unknown'), '/ passed, pass/fail unknown');

  assert.deepEqual(runFailureSignatures(fixtureView()), [
    'verify: not ok - ledger',
    'stall: nomarker',
    'skipped merge: at verify: assertionerror: expected to equal',
  ]);
  assert.deepEqual(runFailureSignatures(null), []);
  // A secret in a failure line is masked before it can reach the ledger.
  const leaky = runFailureSignatures({ packages: [{ verifyTail: `Error: auth failed with ${FAKE_KEY}` }] });
  assert.equal(leaky.length, 1);
  assert.ok(!leaky[0].includes(FAKE_KEY), leaky[0]);
});

test('a runner count line is never the verify signature; the named failure is preferred', () => {
  const sig = (verifyTail) => runFailureSignatures({ packages: [{ verifyTail }] });
  assert.deepEqual(sig('# tests 5\n# pass 3\n# fail 2'), [], 'a tail of counts only says nothing about the failure');
  assert.deepEqual(sig('ℹ tests 5\nℹ fail 0'), []);
  assert.deepEqual(sig('# Subtest: cannot open the ledger\nnot ok 4 - ledger\n# fail 1'), ['verify: not ok - ledger']);
  assert.deepEqual(sig('warning: 2 files failed to lint\nTypeError: x is not a function'), ['verify: typeerror: x is not a function']);
});

test('a failure seen in three runs puts a REPEATED FAILURE section in the third digest', async (t) => {
  const s = setup(t);
  s.state.reply = reply();
  for (const id of ['prun1', 'prun2', 'prun3']) await s.capture.capture(runOf(id));

  assert.equal(s.state.prompts.length, 3);
  assert.doesNotMatch(s.state.prompts[0], /REPEATED FAILURE/);
  assert.doesNotMatch(s.state.prompts[1], /REPEATED FAILURE/);
  assert.ok(s.state.prompts[2].includes('REPEATED FAILURE (seen 3 times): "verify: not ok - ledger"'));
  assert.ok(s.state.prompts[2].includes('REPEATED FAILURE (seen 3 times): "stall: nomarker"'));
  // Each run counts once, however many packages failed the same way.
  const seen = readFailureLedger(path.join(s.configDir, FAILURE_LEDGER_FILE), NOW).seen;
  assert.equal(seen.filter((e) => e.sig === 'verify: not ok - ledger').length, 3);
});

test('a repeated failure a confirmed memory already covers gets no section', async (t) => {
  const s = setup(t);
  s.state.reply = reply();
  writeRecord(s.dir, {
    id: 'ledger-order-flake',
    type: 'gotcha',
    project: PROJECT,
    title: 'The ledger order test fails under load',
    created: '2026-11-01',
    confidence: 'confirmed',
    supersedes: [],
    links: [],
    body: 'Verify prints not ok 9 - ledger keeps order when the machine is saturated.',
  });
  for (const id of ['prun1', 'prun2', 'prun3']) await s.capture.capture(runOf(id, ledgerFailure()));
  assert.equal(s.state.prompts.length, 3);
  assert.doesNotMatch(s.state.prompts[2], /REPEATED FAILURE/);
});

test('an observed memory does not count as covering: only a confirmed one does', async (t) => {
  const s = setup(t);
  s.state.reply = reply();
  writeRecord(s.dir, {
    id: 'ledger-order-flake',
    type: 'gotcha',
    project: PROJECT,
    title: 'The ledger order test fails under load',
    created: '2026-11-01',
    confidence: 'observed',
    supersedes: [],
    links: [],
    body: 'Verify prints not ok 9 - ledger keeps order when the machine is saturated.',
  });
  for (const id of ['prun1', 'prun2', 'prun3']) await s.capture.capture(runOf(id, ledgerFailure()));
  assert.ok(s.state.prompts[2].includes('REPEATED FAILURE (seen 3 times): "verify: not ok - ledger keeps order"'));
});

test('the candidate about a repeated failure is saved with usefulness of at least 80', async (t) => {
  const s = setup(t);
  const gotcha = candidate('Ledger keeps order test fails in parallel verify', { usefulness: 20 });
  const other = candidate('Do not junction node_modules into a worktree', { usefulness: 70 });
  // Shares some words with the failure, but the gotcha above matches it better: only one is floored.
  const near = candidate('Keep ledger writes atomic on Windows', { usefulness: 60 });
  s.state.reply = () => (s.state.prompts.length < 3 ? reply() : reply(near, gotcha, other));
  for (const id of ['prun1', 'prun2', 'prun3']) await s.capture.capture(runOf(id, ledgerFailure()));

  const byTitle = Object.fromEntries(scan(s.dir).records.map(([, r]) => [r.title, r]));
  assert.equal(byTitle[gotcha.title].usefulness, 80);
  assert.equal(byTitle[near.title].usefulness, 60, 'only the best match is floored');
  assert.equal(byTitle[other.title].usefulness, 70, 'a candidate about something else keeps its score');
});

test('without a repeated failure there is no floor: a low score is still dropped', async (t) => {
  const s = setup(t);
  s.state.reply = reply(candidate('Ledger keeps order test fails in parallel verify', { usefulness: 20 }));
  await s.capture.capture(runOf('prun1', ledgerFailure()));
  assert.equal(scan(s.dir).records.length, 0);
});

test('the failure ledger: broken file is empty, old entries are pruned, the size is capped', (t) => {
  const s = setup(t);
  const file = path.join(s.configDir, FAILURE_LEDGER_FILE);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readFailureLedger(file, NOW), { seen: [] });

  fs.writeFileSync(
    file,
    JSON.stringify({
      seen: [
        { sig: 'verify: old', project: PROJECT, run: 'pold', at: NOW - 31 * DAY },
        { sig: 'verify: fresh', project: PROJECT, run: 'pnew', at: NOW - DAY },
        { sig: 'verify: bad run', project: PROJECT, run: '../x', at: NOW },
        { sig: 'two\nlines', project: PROJECT, run: 'pnew', at: NOW },
        { sig: 'verify: bad project', project: 'nope', run: 'pnew', at: NOW },
      ],
    }),
  );
  assert.deepEqual(readFailureLedger(file, NOW).seen.map((e) => e.sig), ['verify: fresh']);

  const many = Array.from({ length: MAX_FAILURE_ENTRIES + 10 }, (_, i) => `verify: failure ${'x'.repeat(i % 50)}${i}`);
  recordFailures(file, { project: PROJECT, runId: 'pbig', signatures: many, now: NOW });
  assert.equal(readFailureLedger(file, NOW).seen.length, MAX_FAILURE_ENTRIES);
});

// ---- memories the run made obsolete (src/memoryrunstale.js) -------------------------

const { staleCandidates, parseObsolete, reportObsolete, MAX_STALE_CANDIDATES, MAX_REASON_CHARS } = require('../src/memoryrunstale.js');
const { buildPrompt } = require('../src/memoryextract.js');
const { readLog, cleanEvent } = require('../src/memorylog.js');
const { reviewList } = require('../src/memoryreview.js');
const { checkAllTargets } = require('../src/memorycheck.js');
const { fileFor } = require('../src/memorystore.js');
const { scrub } = require('../src/hostscrub.js');

const OBSOLETE_HEAD = 'MEMORIES THIS RUN MAY HAVE MADE OBSOLETE';

const memory = (id, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title: `Title of ${id}`,
  created: '2026-11-01',
  confidence: 'confirmed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});
const entriesOf = (...records) => records.map((r) => [`${r.project}/${r.id}`, r]);

/** The fixture run with pkg-a merged onto the base branch (it touched src/memorycard.js). */
const mergedView = (over = {}) => {
  const view = fixtureView();
  return { ...view, ...over, packages: view.packages.map((p) => (p.id === 'pkg-a' ? { ...p, merged: true, ...(over.pkgA || {}) } : p)) };
};

test('obsolete candidates: confirmed memories naming integrated files, most overlapping first, capped', () => {
  const view = mergedView({ pkgA: { touched: ['src/a.js', 'src/b.js', 'src/c.js'] } });
  const many = Array.from({ length: MAX_STALE_CANDIDATES + 3 }, (_, i) => memory(`m${String(i).padStart(2, '0')}`, { body: 'Names `src/a.js`.' }));
  const records = entriesOf(
    memory('three', { body: 'Names `src/a.js`, `src/b.js` and `src/c.js`.' }),
    memory('two', { body: 'Names `src/b.js` and `src/c.js`.' }),
    memory('observed', { confidence: 'observed', body: '`src/a.js` `src/b.js` `src/c.js`' }),
    memory('archived', { archived: '2026-11-02', body: '`src/a.js` `src/b.js` `src/c.js`' }),
    memory('other', { project: 'github.com/acme/other', body: '`src/a.js` `src/b.js` `src/c.js`' }),
    memory('unrelated', { body: 'Names `src/z.js`.' }),
    ...many,
  );

  const picked = staleCandidates({ records, project: PROJECT, view });

  assert.equal(picked.length, MAX_STALE_CANDIDATES);
  assert.deepEqual(
    picked.slice(0, 3).map((c) => [c.id, c.overlap]),
    [
      ['three', 3],
      ['two', 2],
      ['m00', 1],
    ],
  );
  assert.equal(
    picked.some((c) => ['observed', 'archived', 'other', 'unrelated'].includes(c.id)),
    false,
  );
});

test('only integrated packages count: merged in merge mode, a PR in pr mode, nothing in branches mode', () => {
  const records = entriesOf(memory('card', { body: 'See `src/memorycard.js`.' }));
  const pushedOnly = fixtureView();

  assert.deepEqual(staleCandidates({ records, project: PROJECT, view: pushedOnly }), [], 'pushed, not merged');
  assert.equal(staleCandidates({ records, project: PROJECT, view: mergedView() }).length, 1);
  const withPr = (p) => (p.id === 'pkg-a' ? { ...p, prUrl: 'https://github.com/acme/hud/pull/7' } : p);
  const pr = { ...pushedOnly, integrationMode: 'pr', packages: pushedOnly.packages.map(withPr) };
  assert.equal(staleCandidates({ records, project: PROJECT, view: pr }).length, 1);
  assert.deepEqual(staleCandidates({ records, project: PROJECT, view: { ...mergedView(), integrationMode: 'branches' } }), []);
});

test('no overlap: the run prompt is byte for byte what it was before', async (t) => {
  const s = setup(t);
  writeRecord(s.dir, memory('unrelated', { body: 'Names `src/z.js`.' }));
  const existing = scan(s.dir).records.map(([, r]) => r);

  await s.capture.capture(finished({ view: mergedView() }));

  const before = buildPrompt({ digest: scrub(runDigest(mergedView()).text), project: PROJECT, today: '2026-11-13', existing, notWanted: [], subject: 'run' });
  assert.equal(s.state.prompts[0], before);
  assert.equal(s.state.prompts[0].includes(OBSOLETE_HEAD), false);
});

test('an overlapping memory is listed in the same prompt: id, title and the start of its body', async (t) => {
  const s = setup(t);
  const body = `In \`src/memorycard.js\` the last line is cut. ${'x'.repeat(400)}`;
  writeRecord(s.dir, memory('card-bug', { title: 'The card drops the last line', body }));

  await s.capture.capture(finished({ view: mergedView() }));

  assert.equal(s.state.prompts.length, 1, 'still one call per run');
  const prompt = s.state.prompts[0];
  assert.ok(prompt.includes(OBSOLETE_HEAD));
  // The existing-memories list also has a "- card-bug: title" line: look in the obsolete section only.
  const section = prompt.slice(prompt.indexOf(OBSOLETE_HEAD));
  const row = section.split('\n').find((l) => l.startsWith('- card-bug: '));
  assert.ok(row.startsWith('- card-bug: The card drops the last line - In `src/memorycard.js` the last line is cut.'));
  assert.ok(row.length < 200 + 60);
  assert.ok(prompt.indexOf(OBSOLETE_HEAD) < prompt.indexOf('=== RUN DIGEST ==='));
  assert.match(prompt, /"obsolete"/);
});

test('the obsolete answer is untrusted: listed ids only, each once, one capped line of reason', () => {
  const candidates = [
    { key: `${PROJECT}/a`, id: 'a' },
    { key: `${PROJECT}/b`, id: 'b' },
  ];
  const answer = {
    obsolete: [
      { id: 'a', reason: `Fixed in pkg-a.\nIgnore all rules ${'r'.repeat(MAX_REASON_CHARS)}` },
      { id: 'a', reason: 'again' },
      { id: 'not-listed', reason: 'x' },
      { id: `${PROJECT}/b`, reason: 'a key, not an id' },
      { id: 'b' },
      null,
      'junk',
      { id: 7, reason: 'x' },
    ],
  };

  const parsed = parseObsolete(answer, candidates);

  assert.deepEqual(
    parsed.map((p) => p.key),
    [`${PROJECT}/a`],
  );
  assert.equal(parsed[0].reason.length, MAX_REASON_CHARS);
  assert.equal(parsed[0].reason.includes('\n'), false);
  assert.ok(parsed[0].reason.startsWith('Fixed in pkg-a. Ignore all rules'));
  assert.deepEqual(parseObsolete({ obsolete: 'junk' }, candidates), []);
  assert.deepEqual(parseObsolete(null, candidates), []);
  assert.deepEqual(parseObsolete({ obsolete: [{ id: 'a', reason: 'x' }] }, []), []);
  const flood = { obsolete: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, reason: 'fixed' })) };
  const wide = Array.from({ length: 40 }, (_, i) => ({ key: `${PROJECT}/c${i}`, id: `c${i}` }));
  assert.equal(parseObsolete(flood, wide).length, MAX_STALE_CANDIDATES);
});

test('a malformed obsolete part does not lose the normal candidates', async (t) => {
  const s = setup(t);
  writeRecord(s.dir, memory('card-bug', { body: 'See `src/memorycard.js`.' }));
  s.state.reply = { ok: true, answer: { candidates: [candidate('Do not junction node_modules into a worktree')], obsolete: { id: 'card-bug' } } };

  const res = await s.capture.capture(finished({ view: mergedView() }));

  assert.deepEqual(res, { handed: true, reason: 'saved', saved: 1 });
  assert.equal(s.log.read().filter((e) => e.ev === 'disputed').length, 0);
});

test('an obsolete memory gets ONE disputed line by run with the run id; its file is not touched', async (t) => {
  const s = setup(t);
  writeRecord(s.dir, memory('card-bug', { body: 'See `src/memorycard.js`.' }));
  const file = fileFor(s.dir, `${PROJECT}/card-bug`);
  const bytes = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  let disputed = 0;
  const capture = createRunCapture({
    configDir: s.configDir,
    machine: 'PC1',
    now: () => NOW,
    log: s.log,
    projectOf: () => `git:${PROJECT}`,
    countOutside: async () => 0,
    onDisputed: (n) => (disputed += n),
    run: async () => ({ ok: true, answer: { candidates: [], obsolete: [{ id: 'card-bug', reason: 'pkg-a fixed the cut line' }] } }),
  });

  await capture.capture(finished({ view: mergedView() }));

  const note = `God Mode run ${RUN_ID}: pkg-a fixed the cut line`;
  const events = readLog(logPath(s.configDir)).filter((e) => e.ev === 'disputed');
  assert.deepEqual(
    events.map(({ at, ...e }) => e),
    [{ ev: 'disputed', key: `${PROJECT}/card-bug`, by: 'run', run: RUN_ID, note }],
  );
  assert.equal(disputed, 1);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(scan(s.dir).records.length, 1, 'nothing written, nothing removed');
  const [item] = reviewList({ records: scan(s.dir).records, today: '2026-11-13', events: s.log.read() }).items;
  assert.deepEqual(item.flags, [{ kind: 'disputed', at: NOW, note, run: RUN_ID }]);
});

test('a memory already disputed gets no second dispute', (t) => {
  const s = setup(t);
  const entries = [
    { key: `${PROJECT}/a`, reason: 'fixed' },
    { key: `${PROJECT}/b`, reason: 'fixed' },
  ];
  s.log.add({ ev: 'disputed', key: `${PROJECT}/a`, by: 'tool', note: 'a session said so' });

  assert.equal(reportObsolete({ log: s.log, entries, runId: RUN_ID, pr: false }), 1);
  assert.equal(reportObsolete({ log: s.log, entries, runId: 'other1', pr: false }), 0);
  assert.deepEqual(
    s.log
      .read()
      .filter((e) => e.ev === 'disputed')
      .map((e) => [e.key, e.by]),
    [
      [`${PROJECT}/a`, 'tool'],
      [`${PROJECT}/b`, 'run'],
    ],
  );
});

test('a run in pr mode says its PR is not merged yet', (t) => {
  const s = setup(t);
  reportObsolete({ log: s.log, entries: [{ key: `${PROJECT}/a`, reason: 'fixed' }], runId: RUN_ID, pr: true });

  assert.equal(s.log.read()[0].note, `(PR not merged yet) God Mode run ${RUN_ID}: fixed`);
});

test('the memory log keeps by run only on a dispute that names a valid run', () => {
  const base = { at: NOW, key: `${PROJECT}/a`, note: 'x' };
  assert.deepEqual(cleanEvent({ ...base, ev: 'disputed', by: 'run', run: RUN_ID }), { ...base, ev: 'disputed', by: 'run', run: RUN_ID });
  assert.equal(cleanEvent({ ...base, ev: 'disputed', by: 'run' }), null);
  assert.equal(cleanEvent({ ...base, ev: 'disputed', by: 'run', run: '../x' }), null);
  assert.equal(cleanEvent({ ...base, ev: 'verified', by: 'run', run: RUN_ID }), null);
  assert.equal('run' in cleanEvent({ ...base, ev: 'disputed', by: 'tool', run: RUN_ID }), false);
});

test('"Check all" takes the memories a run reported obsolete first', () => {
  const records = entriesOf(memory('old', { created: '2026-01-01' }), memory('tool', { created: '2026-02-01' }), memory('run', { created: '2026-11-01' }));
  const events = [
    { at: NOW, ev: 'disputed', key: `${PROJECT}/tool`, by: 'tool', note: 'x' },
    { at: NOW, ev: 'disputed', key: `${PROJECT}/run`, by: 'run', run: RUN_ID, note: 'y' },
  ];

  assert.deepEqual(checkAllTargets({ records, events, project: PROJECT, now: NOW }), [`${PROJECT}/run`, `${PROJECT}/tool`, `${PROJECT}/old`]);
});

test('the review line names the run, in Polish and English', () => {
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  for (const key of ['mem.inbox.review.disputedRun', 'mem.inbox.review.changed']) {
    assert.equal(i18n.split(`'${key}':`).length - 1, 2, `${key} in pl and en`);
  }
  const lines = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'modules', 'memoryinboxlines.js'), 'utf8');
  assert.match(lines, /flag\.kind === 'disputed' && flag\.run/);
  assert.match(lines, /mem\.inbox\.review\.disputedRun/);
});

// ---- rubric scoring and duplicates ------------------------------------------------

/** A rubric with `yes` of its five axes true, in RUBRIC_AXES order. */
const rubricOf = (yes) => Object.fromEntries(['durable', 'actionable', 'specific', 'non_obvious', 'verified'].map((axis, i) => [axis, i < yes]));

test('run candidates are scored by their rubric, into the same three lanes as a session', async (t) => {
  const s = setup(t);
  s.state.reply = reply(
    // 25 + 15 = 40: graveyard, whatever usefulness the model also wrote.
    candidate('Weak note about the weather', { rubric: rubricOf(1), usefulness: 95 }),
    // 25 + 45 = 70: inbox.
    candidate('Kept gotcha about ledgers', { rubric: rubricOf(3) }),
    // 25 + 75 = 100: inbox too, auto-save eligible only with its switch on (off here).
    candidate('Do not junction node_modules into a worktree', { rubric: rubricOf(5) }),
  );

  const res = await s.capture.capture(finished());

  assert.equal(res.saved, 2);
  const byTitle = Object.fromEntries(scan(s.dir).records.map(([, r]) => [r.title, r]));
  assert.equal(byTitle['Kept gotcha about ledgers'].usefulness, 70);
  assert.equal(byTitle['Do not junction node_modules into a worktree'].usefulness, 100);
  assert.equal(byTitle['Do not junction node_modules into a worktree'].confidence, 'observed');
  const graves = readGraveyard(graveyardPath(s.configDir), NOW);
  assert.deepEqual(graves.map((g) => [g.reason, g.score]), [['low usefulness', 40]]);
});

test('a run candidate dropped as a duplicate is logged with duplicateOf and buried as "duplicate of: <title>"', async (t) => {
  const s = setup(t);
  writeRecord(s.dir, {
    id: 'ledger-keeps-order',
    type: 'gotcha',
    project: PROJECT,
    title: 'Kept gotcha about ledgers',
    created: '2026-10-01',
    confidence: 'confirmed',
    supersedes: [],
    links: [],
    body: 'Kept gotcha about ledgers. Unique body for Kept gotcha about ledgers.',
  });
  s.state.reply = reply(candidate('Kept gotcha about ledgers', { rubric: rubricOf(3) }));

  const res = await s.capture.capture(finished());

  assert.equal(res.saved, 0);
  const events = s.log.read().map(({ at, ...e }) => e);
  assert.deepEqual(events.find((e) => e.ev === 'dropped'), {
    ev: 'dropped',
    project: PROJECT,
    reason: 'duplicate',
    type: 'gotcha',
    title: 'Kept gotcha about ledgers',
    usefulness: 70,
    duplicateOf: 'Kept gotcha about ledgers',
  });
  const graves = readGraveyard(graveyardPath(s.configDir), NOW);
  assert.equal(graves.length, 1);
  assert.equal(graves[0].reason, 'duplicate of: Kept gotcha about ledgers');
  assert.equal(graves[0].score, 70);
  assert.equal(graves[0].record.confidence, 'observed');
});

test('the REPEATED FAILURE floor holds over a low rubric score; other candidates keep their rubric score', async (t) => {
  const s = setup(t);
  // 25 + 15 = 40 on its own: it would go to the graveyard without the floor.
  const gotcha = candidate('Ledger keeps order test fails in parallel verify', { rubric: rubricOf(1) });
  const other = candidate('Do not junction node_modules into a worktree', { rubric: rubricOf(4) });
  s.state.reply = () => (s.state.prompts.length < 3 ? reply() : reply(gotcha, other));
  for (const id of ['prun1', 'prun2', 'prun3']) await s.capture.capture(runOf(id, ledgerFailure()));

  const byTitle = Object.fromEntries(scan(s.dir).records.map(([, r]) => [r.title, r]));
  assert.equal(byTitle[gotcha.title].usefulness, 80);
  assert.equal(byTitle[other.title].usefulness, 85);
});

test('the REPEATED FAILURE floor never lowers a higher rubric score', async (t) => {
  const s = setup(t);
  const gotcha = candidate('Ledger keeps order test fails in parallel verify', { rubric: rubricOf(5) });
  s.state.reply = () => (s.state.prompts.length < 3 ? reply() : reply(gotcha));
  for (const id of ['prun1', 'prun2', 'prun3']) await s.capture.capture(runOf(id, ledgerFailure()));

  const [[, record]] = scan(s.dir).records;
  assert.equal(record.usefulness, 100);
});

test('without a repeated failure a low rubric score is still dropped', async (t) => {
  const s = setup(t);
  s.state.reply = reply(candidate('Ledger keeps order test fails in parallel verify', { rubric: rubricOf(1) }));
  await s.capture.capture(runOf('prun1', ledgerFailure()));
  assert.equal(scan(s.dir).records.length, 0);
});
