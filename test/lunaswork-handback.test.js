// ============================================================================
// Luna's Work "Hand me the wheel" (C11): the commit reader of the Critic's
// hand-back pass (src/lunasworkHandback.js) against a real throwaway git repo,
// the DECISIONS.md / ARCHITECTURE.md text it makes, the phone's wheel unit
// (src/lunasworkWheel.js) through the PC's reader, and the wiring that hands
// the phone's actions to the controller.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseCommitLog,
  realCommits,
  handbackDecisionLine,
  architectureBlock,
  handbackHead,
  readCommits,
} = require('../src/lunasworkHandback');
const W = require('../src/lunasworkWheel');
const pack = require('../src/lunasworkPack');
const { applyRows, todoPeer } = require('../src/cloudrows');
const { wireDecisionSync } = require('../src/lunasworkWiring');
const { publicFeedback } = require('../src/lunasworkFeedback');

const NOW = 1_760_000_000_000;
const RUN = 'lwwheel1';

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-handback-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'mati@example.com');
  git('config', 'user.name', 'Mati');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  const commit = (file, text, subject) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', subject);
  };
  return { dir, git, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---- reading the commits ----------------------------------------------------------

test('readCommits: every commit since the pause, oldest first, with its diff stat', async () => {
  const r = gitRepo();
  try {
    r.commit('src/app.js', 'one\n', 'Iteration 1 by Luna');
    const base = await handbackHead(r.dir);
    assert.match(base, /^[0-9a-f]{40}$/);

    r.commit('src/Header.tsx', 'a\nb\nc\n', 'Fix the header size');
    r.commit('src/export/pdf.ts', 'x\n', 'Add PDF export');
    const res = await readCommits(r.dir, base);
    assert.equal(res.ok, true);
    assert.equal(res.more, 0);
    assert.deepEqual(res.commits.map((c) => c.subject), ['Fix the header size', 'Add PDF export']);
    assert.deepEqual(res.commits[0].files, [{ path: 'src/Header.tsx', added: 3, deleted: 0 }]);
    assert.equal(res.commits[1].sha, r.git('rev-parse', 'HEAD'));

    assert.deepEqual((await readCommits(r.dir, await handbackHead(r.dir))).commits, [], 'nothing since the pause');
    assert.deepEqual(await readCommits(r.dir, 'HEAD~1'), { ok: false, error: 'no base commit' }, 'only a sha is ever passed to git');
    assert.equal((await readCommits(r.dir, 'f'.repeat(40))).ok, false, 'an unknown base is a plain failure');
  } finally {
    r.done();
  }
});

test('handbackHead is null outside a repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-handback-none-'));
  try {
    assert.equal(await handbackHead(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCommitLog drops malformed records and caps nothing it cannot read', () => {
  const log = [
    'garbage before the first record',
    `\x1e${'a'.repeat(40)}\x1fFirst\twith\u0007control`,
    '',
    '2\t0\tREADME.md',
    'not a numstat line',
    `\x1enot-a-sha\x1fSecond`,
    `\x1e${'b'.repeat(40)}\x1f`,
  ].join('\n');
  const commits = parseCommitLog(log);
  assert.deepEqual(commits.map((c) => c.subject), ['First with control', '(no subject)']);
  assert.deepEqual(commits[0].files, [{ path: 'README.md', added: 2, deleted: 0 }]);
  assert.deepEqual(parseCommitLog(''), []);
  assert.deepEqual(parseCommitLog(null), []);
});

// ---- what goes into design/ -------------------------------------------------------

test('one DECISIONS.md line per commit; long file lists are cut', () => {
  const files = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.js`, added: 1, deleted: 1 }));
  const commit = { sha: 'c'.repeat(40), subject: 'Big refactor', files, added: 7, deleted: 7 };
  assert.equal(
    handbackDecisionLine(commit, { date: '2026-10-26' }),
    '- Mati changed "Big refactor" by hand (ccccccc; 7 files: f0.js, f1.js, f2.js, f3.js, f4.js and 2 more; +7 -7), hand-back 2026-10-26',
  );
  // The line goes through the same writer as every decision-queue answer.
  const op = pack.appendDecisionEntry(handbackDecisionLine(commit));
  assert.match(op.update('# Decisions\n'), /^# Decisions\n- Mati changed "Big refactor"/);
});

test('ARCHITECTURE.md gets one appended section; existing text is kept', () => {
  const commits = [{ sha: 'd'.repeat(40), subject: 'Move the store', files: [{ path: 'src/store.ts', added: 4, deleted: 2 }], added: 4, deleted: 2 }];
  const block = architectureBlock(commits, { date: '2026-10-26', iteration: 3, more: 2 });
  assert.match(block, /^## Manual changes \(hand-back 2026-10-26, before iteration 3\)/);
  assert.match(block, /- ddddddd Move the store \(1 file: src\/store\.ts; \+4 -2\)/);
  assert.match(block, /- and 2 more commit\(s\)/);
  assert.equal(architectureBlock([], { date: '2026-10-26', iteration: 3 }), null);
  const next = pack.appendArchitecture(block).update('# Architecture\n\nModules.\n');
  assert.ok(next.startsWith('# Architecture\n\nModules.\n\n## Manual changes'));
  assert.equal(pack.appendArchitecture(''), null);
});

// ---- the phone's wheel unit --------------------------------------------------------

const mirrorOf = (units) =>
  applyRows({ cursor: 0, mirror: {}, pushed: {} }, units.map((x, i) => ({ key: x.k, value: x.v, u: x.u, deleted_at: x.d, rev: i + 1 })), NOW).mirror;

test('the phone wheel unit survives the PC reader unchanged; anything else is dropped', () => {
  const hand = W.wheelUnit(RUN, 'hand', NOW);
  const back = W.wheelUnit(RUN, 'back', NOW + 5);
  assert.deepEqual(hand.v, { runId: RUN, action: 'hand' });
  assert.equal(hand.k, `lunaswork-wheel:${NOW}`);
  const forged = { k: `lunaswork-wheel:${NOW + 9}`, v: { runId: RUN, action: 'delete-repo' }, u: NOW + 9, d: null };
  assert.deepEqual(W.wheelFromTodoPeers([todoPeer(mirrorOf([back, hand, forged]))]), [
    { id: NOW, runId: RUN, action: 'hand' },
    { id: NOW + 5, runId: RUN, action: 'back' },
  ]);
  assert.equal(W.wheelUnit('BAD RUN', 'hand', NOW), null);
  assert.equal(W.wheelUnit(RUN, 'drive', NOW), null);
  assert.deepEqual(W.wheelFromTodoPeers('nope'), []);
});

test('wheelState / newestWheelAction', () => {
  assert.equal(W.wheelState({ phase: 'handed', handRequested: false }), 'handed');
  assert.equal(W.wheelState({ phase: 'building', handRequested: true }), 'requested');
  assert.equal(W.wheelState({ phase: 'building' }), 'running');
  assert.equal(W.wheelState(null), 'running');
  const list = [{ id: 2, runId: RUN, action: 'hand' }, { id: 4, runId: RUN, action: 'back' }, { id: 8, runId: 'lwother', action: 'hand' }];
  assert.equal(W.wheelState({ phase: 'done', handRequested: true }), 'running', 'an ended run has no wheel to give');
  assert.deepEqual(W.newestWheelAction(list, { runId: RUN, seq: 0, now: 10 }), { id: 4, runId: RUN, action: 'back' });
  assert.equal(W.newestWheelAction(list, { runId: RUN, seq: 4, now: 10 }), null);
  // A unit from far in the future (a forged key, a phone clock ahead) would hold back every later tap.
  const future = [{ id: Number.MAX_SAFE_INTEGER, runId: RUN, action: 'hand' }, { id: 2, runId: RUN, action: 'hand' }];
  assert.deepEqual(W.newestWheelAction(future, { runId: RUN, seq: 0, now: 10 }), { id: 2, runId: RUN, action: 'hand' });
  assert.deepEqual(W.newestWheelAction([{ id: NOW + 60_000, runId: RUN, action: 'hand' }], { runId: RUN, seq: 0, now: NOW }).id, NOW + 60_000, 'a little skew is fine');
});

test('realCommits keeps real commits of the range only, each once (a subject cannot forge a record)', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const forged = 'e'.repeat(40);
  const log = [`\x1e${a}\x1fReal one`, '', '1\t0\tx.js', `\x1e${forged}\x1fforged`, '', '9\t9\tsecret.js', `\x1e${b}\x1fReal two`, `\x1e${a}\x1fdup`].join('\n');
  assert.deepEqual(realCommits(parseCommitLog(log), [a, b]).map((c) => c.subject), ['Real one', 'Real two']);
});

test('commit text loses bidi overrides and control characters', () => {
  const [c] = parseCommitLog(`\x1e${'a'.repeat(40)}\x1fFix ‮evil⁦ header\u0085`);
  assert.equal(c.subject, 'Fix evil header');
});

test('the wheel rides in the feedback section of the phone snapshot, cleaned', () => {
  assert.equal(publicFeedback({ runId: RUN, items: [], wheel: 'handed' }).wheel, 'handed');
  assert.equal(publicFeedback({ runId: RUN, items: [], wheel: 'mine!' }).wheel, 'running');
  assert.equal(publicFeedback({ runId: RUN, items: [] }).wheel, 'running');
});

test('wireDecisionSync hands the phone wheel actions to the controller after a todos pull', async () => {
  const applied = [];
  const pulled = [];
  const mirror = mirrorOf([W.wheelUnit(RUN, 'hand', NOW)]);
  const controller = {
    subscribe: () => {},
    status: () => ({ pendingDecisions: [], feedback: null }),
    applyAnswers: () => 0,
    applyWheel: async (list) => {
      applied.push(list);
      return true;
    },
  };
  const cloud = { onPulled: (fn) => pulled.push(fn), hooks: () => ({ extraPeers: () => [todoPeer(mirror)] }) };
  wireDecisionSync({ controller, cloud, putDecisions: () => {} });
  pulled[0]('todos');
  assert.deepEqual(applied, [[{ id: NOW, runId: RUN, action: 'hand' }]]);

  // A failing controller never throws into the cloud pull.
  const logs = [];
  const broken = { ...controller, applyWheel: async () => { throw new Error('boom'); } };
  const pulls = [];
  wireDecisionSync({ controller: broken, cloud: { ...cloud, onPulled: (fn) => pulls.push(fn) }, putDecisions: () => {}, log: (l) => logs.push(l) });
  pulls[0]('todos');
  await new Promise((r) => setImmediate(r));
  assert.match(logs.join('\n'), /wheel action failed: boom/);
});
