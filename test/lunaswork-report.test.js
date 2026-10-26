// ============================================================================
// Luna's Work run report + end-of-run email (src/lunasworkReport.js). Covers
// the report shape for each verdict (Needs you first, then verdict and why,
// iterations, scores, rollbacks, model choices, decisions, evidence), a
// report file for every end verdict, exactly one email per run end - driven
// through a real controller over several iterations, so never per iteration -
// the PLAYTEST_LOG tail in PLATEAU / RED mails only, the mail switch, and
// HTML escaping of model text.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildRunReport,
  renderRunReportHtml,
  buildRunEmail,
  playtestLogTail,
  reportFileFor,
  createLunasWorkReporter,
  FINAL_VERDICTS,
} = require('../src/lunasworkReport');
const { createLunasWork } = require('../src/lunaswork');
const { normalizeState, godmodeEmailOn } = require('../src/mailprefs');

const REPO = path.resolve(os.tmpdir(), 'lw-report-repo', 'amsteel');
const EVIDENCE = path.resolve(os.tmpdir(), 'lw-report-runs', 'lwrep1-iter-2');
const START = 1_700_000_000_000;
const LOG_TAIL = '## Iteration 3\n\n- Broken: the export button\n- Verdict: continue';

/** A finished run as the controller hands it to onRunEnd. */
function makeRun(verdict, extra = {}) {
  return {
    id: 'lwrep1',
    projectId: 'amsteel',
    repoPath: REPO,
    phase: 'done',
    verdict,
    iteration: 2,
    milestone: 'core flows',
    startedAt: START,
    endedAt: START + 3 * 60 * 60 * 1000,
    history: [
      { n: 1, milestone: 'core flows', score: 60, cardsClosed: 2, selfCheck: 'green', coreJourneysOk: true, rolledBack: false },
      { n: 2, milestone: 'core flows', score: 35, cardsClosed: 1, selfCheck: 'green', coreJourneysOk: true, rolledBack: true },
    ],
    log: [
      { at: START, n: 1, kind: 'model', role: 'director', model: 'opus', reason: 'setting' },
      { at: START, n: 1, kind: 'model', role: 'builder', model: 'sonnet', reason: 'small or medium card', card: 11 },
      { at: START, n: 1, kind: 'event', text: 'build green' },
    ],
    laps: [
      {
        n: 1, milestone: 'core flows', score: 60, cardsPlanned: 2, cardsClosed: [11, 12], cardsOpened: 3, cardsUpdated: 0,
        selfCheck: 'green', skipped: false, criticVerdict: 'continue', checkpoint: { tag: 'luna-work/lwrep1/iter-1', tagError: null, rollback: null, note: null },
        rolledBack: false, journeysPassed: ['quote'], journeysFailed: [], decisions: [{ choice: 'PDF export via the browser', because: 'no new dependency' }],
        evidenceDir: path.resolve(os.tmpdir(), 'lw-report-runs', 'lwrep1-iter-1'),
      },
      {
        n: 2, milestone: 'core flows', score: 35, cardsPlanned: 1, cardsClosed: [13], cardsOpened: 1, cardsUpdated: 1,
        selfCheck: 'green', skipped: false, criticVerdict: 'continue',
        checkpoint: {
          tag: null, tagError: null, note: null,
          rollback: {
            ok: true, toIteration: 1, reason: 'scoreDrop', why: 'the milestone "core flows" score fell from 60 to 35, more than the rollback margin',
            fromTag: 'luna-work/lwrep1/iter-2-rolled-back', toTag: 'luna-work/lwrep1/iter-1',
            reverted: [{ sha: 'abcdef1234567890abcdef1234567890abcdef12', subject: 'Merge package quote-pdf' }], cards: [99], reopened: [13], decision: true,
          },
        },
        rolledBack: true, journeysPassed: [], journeysFailed: ['quote'], decisions: [], evidenceDir: EVIDENCE,
      },
    ],
    ...extra,
  };
}

const sectionOrder = (md) => ['## Needs you', '## Verdict', '## Iterations', '## Scores per milestone', '## Rollbacks', '## Model choices', '## Decisions', '## Evidence', '## Timeline'].map((s) => md.indexOf(s));

// ---- report shape -------------------------------------------------------------------

test('report shape: Needs you first, then verdict and why, iterations, scores, rollbacks, models, decisions, evidence', () => {
  const md = buildRunReport(makeRun('plateau'));
  const order = sectionOrder(md);
  assert.ok(order.every((i) => i > 0), `every section present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  assert.match(md, /- Repo: amsteel/);
  assert.match(md, /PLATEAU - No score gain and no card closed in the last 3 iterations of milestone "core flows"/);
  assert.match(md, /\| 1 \| core flows \| 60 \| 2 \/ 2 \| 3 \| green \| luna-work\/lwrep1\/iter-1 \|/);
  assert.match(md, /\| 2 \| core flows \| 35 \| 1 \/ 1 \| 1 new, 1 updated \| green \| rolled back to luna-work\/lwrep1\/iter-1 \|/);
  assert.match(md, /core flows: 60 -> 35 \(rolled back\)/);
  assert.match(md, /Iteration 2: `luna-work\/lwrep1\/iter-2-rolled-back` -> `luna-work\/lwrep1\/iter-1` - the milestone "core flows" score fell/);
  assert.match(md, /reverted `abcdef1` Merge package quote-pdf/);
  assert.match(md, /Iteration 1, director: opus \(setting\)/);
  assert.match(md, /Iteration 1, builder: sonnet \(small or medium card\), card 11/);
  assert.match(md, /Iteration 1: chose PDF export via the browser because no new dependency/);
  assert.ok(md.includes(`Iteration 2: ${EVIDENCE}`), 'the evidence folder of each iteration');
  assert.match(md, /- Took: 3 h 0 min/);
});

test('report shape per verdict: the Needs-you block and the reason fit the verdict', () => {
  const needsOf = (md) => md.slice(md.indexOf('## Needs you'), md.indexOf('## Verdict'));
  const quiet = { laps: [], history: [] };

  const ship = buildRunReport(makeRun('ship', quiet));
  assert.match(needsOf(ship), /Nothing - all done/);
  assert.match(ship, /SHIP - The Critic said every gate in SHIP_CRITERIA.md passes, and a fresh SHIP-confirmation Playtester agreed/);

  const red = buildRunReport(makeRun('red', { laps: [{ n: 1, selfCheck: 'red', cardsPlanned: 1, cardsClosed: [], cardsOpened: 0, cardsUpdated: 0, integrationBranch: 'luna/amsteel-integration', fixups: 1 }], history: [] }));
  assert.match(needsOf(red), /not pushable/);
  assert.match(needsOf(red), /luna\/amsteel-integration/);
  assert.match(red, /RED - The merged result stayed red after fix-up in 2 iterations in a row/);
  assert.match(red, /red, 1 fix-up, kept on luna\/amsteel-integration/);

  const plateau = buildRunReport(makeRun('plateau', quiet));
  assert.match(needsOf(plateau), /PLAYTEST_LOG tail/);

  const failed = buildRunReport(makeRun('stop', { ...quiet, stopReason: 'stepFailed' }));
  assert.match(needsOf(failed), /A step kept failing/);
  assert.match(failed, /STOP - Stopped: one step failed 3 times in a row/);

  const killed = buildRunReport(makeRun('stop', { ...quiet, stopReason: 'killSwitch' }));
  assert.match(needsOf(killed), /Nothing - all done/, 'Mati stopped it himself');

  const rolled = buildRunReport(makeRun('ship'));
  assert.match(needsOf(rolled), /Iteration 2 was rolled back/);

  const badRollback = makeRun('stop', { stopReason: 'killSwitch' });
  badRollback.laps[1].checkpoint.rollback = { ok: false, reason: 'scoreDrop', error: 'pushFailed', toTag: 'luna-work/lwrep1/iter-1', reverted: [], cards: [] };
  const md = buildRunReport(badRollback);
  assert.match(needsOf(md), /Iteration 2: the rollback failed \(pushFailed\)/);
  assert.match(md, /rollback to `luna-work\/lwrep1\/iter-1` failed \(pushFailed\)/);
});

test('a run with no finished iteration still reports', () => {
  const md = buildRunReport(makeRun('stop', { laps: [], history: [], log: [], stopReason: 'packIncomplete', iteration: 0 }));
  assert.match(md, /No iteration finished/);
  assert.match(md, /Finish the design pack/);
  assert.match(renderRunReportHtml(makeRun('stop', { laps: [], history: [], log: [] })), /No iteration finished/);
});

test('HTML escapes model text', () => {
  const run = makeRun('plateau');
  run.laps[0].decisions = [{ choice: '<script>alert(1)</script>', because: '"><img src=x onerror=alert(2)>' }];
  run.laps[1].checkpoint.rollback.reverted = [{ sha: 'abcdef1234567890abcdef1234567890abcdef12', subject: '<b onmouseover=alert(3)>merge</b>' }];
  run.log = [{ at: START, n: 1, kind: 'model', role: 'critic', model: 'opus', reason: '<iframe src=javascript:alert(4)>' }];
  run.milestone = '<svg onload=alert(5)>';
  const html = renderRunReportHtml(run);
  for (const raw of ['<script>alert(1)', '<img src=x', '<b onmouseover', '<iframe', '<svg onload']) {
    assert.ok(!html.includes(raw), `raw ${raw} must not reach the page`);
  }
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;iframe src=javascript:alert(4)&gt;'));
  assert.match(html, /^<!doctype html>/);
});

test('model text cannot break the markdown: one line each, no new headings', () => {
  const run = makeRun('plateau');
  run.laps[0].decisions = [{ choice: 'x\n## Needs you\n- fake', because: 'y\r\n# Title' }];
  const md = buildRunReport(run);
  assert.equal(md.split('\n').filter((l) => l === '## Needs you').length, 1);
  assert.match(md, /chose x ## Needs you - fake because y # Title/);
});

// ---- email --------------------------------------------------------------------------

test('PLATEAU and RED emails carry the PLAYTEST_LOG tail; SHIP and STOP do not', () => {
  for (const verdict of ['plateau', 'red']) {
    const mail = buildRunEmail(makeRun(verdict), { logTail: LOG_TAIL });
    assert.match(mail.text, /PLAYTEST LOG \(latest entries\)/, verdict);
    assert.ok(mail.text.includes('- Broken: the export button'), verdict);
    assert.ok(mail.text.indexOf('NEEDS YOU') < mail.text.indexOf('PLAYTEST LOG'));
  }
  for (const verdict of ['ship', 'stop']) {
    const mail = buildRunEmail(makeRun(verdict), { logTail: LOG_TAIL });
    assert.ok(!mail.text.includes('PLAYTEST LOG'), verdict);
  }
});

test('the email names the repo, never its path; evidence folders by name only', () => {
  const mail = buildRunEmail(makeRun('plateau'));
  assert.equal(mail.subject, "Luna's Work: amsteel - PLATEAU - needs you");
  assert.ok(!mail.text.includes(path.dirname(REPO)), 'no repo path');
  assert.ok(!mail.text.includes(EVIDENCE), 'no evidence path');
  assert.ok(mail.text.includes('Iteration 2: lwrep1-iter-2'));
  assert.equal(buildRunEmail(makeRun('ship', { laps: [], history: [] })).subject, "Luna's Work: amsteel - SHIP");
});

test('playtestLogTail keeps the last lines only', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const tail = playtestLogTail(text);
  assert.ok(tail.startsWith('line 60'));
  assert.ok(tail.endsWith('line 99'));
  assert.equal(playtestLogTail(null), '');
});

// ---- reporter: files + one mail ---------------------------------------------------------

function fakeMail({ connected = true, godmodeEmail = null } = {}) {
  const m = { sends: [], state: normalizeState({}) };
  m.deps = {
    sender: {
      status: () => ({ connected }),
      send: async (msg) => {
        m.sends.push(msg);
      },
    },
    prefs: {
      loadPrefs: () => ({ godmodeEmail }),
      loadState: () => m.state,
      updateState: (fn) => {
        m.state = normalizeState(fn(m.state));
        return m.state;
      },
    },
    enabled: godmodeEmailOn,
  };
  return m;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a report file (.md + .html) for every end verdict', async (t) => {
  const runsDir = tempDir(t);
  const reporter = createLunasWorkReporter({ runsDir: () => runsDir, readFile: () => null });
  for (const verdict of FINAL_VERDICTS) {
    const id = `lwv${verdict}`;
    const res = await reporter.onRunEnd(makeRun(verdict, { id }));
    assert.equal(res.ok, true, verdict);
    assert.equal(res.file, reportFileFor(runsDir, id));
    const md = fs.readFileSync(path.join(runsDir, `lunaswork-${id}.md`), 'utf8');
    assert.match(md, new RegExp(`- Verdict: ${verdict.toUpperCase()}`));
    assert.match(fs.readFileSync(path.join(runsDir, `lunaswork-${id}.html`), 'utf8'), /^<!doctype html>/);
  }
  assert.equal((await reporter.onRunEnd({ ...makeRun('ship'), verdict: null })).skipped, 'not-ended');
  assert.equal((await reporter.onRunEnd(makeRun('ship', { id: '../evil' }))).skipped, 'bad-run');
  assert.equal(reportFileFor(runsDir, '../evil'), null);
});

test('the mail switch: off sends nothing, not connected is told apart', async (t) => {
  const runsDir = tempDir(t);
  const off = fakeMail({ godmodeEmail: false });
  const res = await createLunasWorkReporter({ runsDir: () => runsDir, mail: off.deps, readFile: () => null }).onRunEnd(makeRun('ship'));
  assert.equal(res.mail.skipped, 'off');
  assert.equal(off.sends.length, 0);
  const offline = fakeMail({ connected: false });
  const res2 = await createLunasWorkReporter({ runsDir: () => runsDir, mail: offline.deps, readFile: () => null }).onRunEnd(makeRun('ship'));
  assert.equal(res2.mail.skipped, 'not-connected');
});

/** A real controller with small fakes, run until PLATEAU (4 iterations). */
async function runToPlateau(onRunEnd) {
  let stored = null;
  const scores = [50, 50, 48, 50];
  const deps = {
    store: {
      load: () => stored,
      save: (d) => {
        stored = d ? JSON.parse(JSON.stringify(d)) : null;
        return true;
      },
    },
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => (id === 'amsteel' ? { id, repoPath: REPO } : null),
    profileFor: () => ({ adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' }),
    godModeActive: () => false,
    todoStore: () => ({ read: () => [], write: () => true }),
    director: async () => ({ ok: true, cards: [], model: 'opus', modelReason: 'setting' }),
    build: async () => {
      throw new Error('nothing to build in this run');
    },
    createAdapter: () => ({ evidenceDir: EVIDENCE, start: async () => ({ url: 'http://localhost:3000' }), stop: async () => {}, tools: () => ({}) }),
    playtest: async (o) => ({ ok: true, model: 'sonnet', modelReason: 'exploratory pass', report: { mode: o.mode, findings: [], scores: [], journeys: [], screens: [] } }),
    shipGate: () => ({ allPassed: false }),
    critic: async () => ({
      ok: true, verdict: 'continue', model: 'sonnet', modelReason: 'regular iteration',
      milestone: { name: 'skeleton', passed: false, score: scores.length ? scores.shift() : 50 }, next: 'skeleton', allPassed: false,
    }),
    onRunEnd: [onRunEnd],
    newRunId: () => 'lwmail1',
    now: () => START,
    setTimer: () => ({}),
    clearTimer: () => {},
    log: () => {},
  };
  const ctl = createLunasWork(deps);
  const events = [];
  ctl.subscribe((e) => events.push(e));
  await ctl.start({ projectId: 'amsteel' });
  for (let i = 0; i < 5; i += 1) await ctl.idle();
  return { ctl, deps, events, stored: () => stored };
}

const tick = () => new Promise((r) => setImmediate(r));

test('one email per run end, never per iteration (real controller, 4 iterations to PLATEAU)', async (t) => {
  const runsDir = tempDir(t);
  const mail = fakeMail();
  const reporter = createLunasWorkReporter({ runsDir: () => runsDir, mail: mail.deps, readFile: (repo, name) => (name === 'PLAYTEST_LOG.md' ? LOG_TAIL : null) });
  const results = [];
  const { ctl, deps, events, stored } = await runToPlateau(async (run) => results.push(await reporter.onRunEnd(run)));
  for (let i = 0; i < 50 && !results.length; i += 1) await tick();

  assert.equal(ctl.status().verdict, 'plateau');
  assert.equal(ctl.status().iteration, 4);
  assert.ok(events.filter((e) => e.type === 'phase' && e.status.phase === 'critiquing').length >= 4, 'four iterations ran');
  assert.equal(results.length, 1);
  assert.equal(mail.sends.length, 1, 'exactly one email');
  const [sent] = mail.sends;
  assert.equal(sent.subject, "Luna's Work: amsteel - PLATEAU - needs you");
  assert.ok(sent.text.includes('- Broken: the export button'), 'the PLAYTEST_LOG tail');
  assert.equal(sent.attachments[0].filename, 'lunaswork-run-lwmail1.html');

  const md = fs.readFileSync(path.join(runsDir, 'lunaswork-lwmail1.md'), 'utf8');
  assert.match(md, /Iteration 1, director: opus \(setting\)/, 'model choices from the real run log');
  assert.match(md, /Iteration 4, critic: sonnet \(regular iteration\)/);
  assert.equal((md.match(/^\| [1-4] \| skeleton \|/gm) || []).length, 4, 'one row per iteration');

  // The same run end again (a replay after a restart): no second email.
  const again = await reporter.onRunEnd(stored());
  assert.equal(again.mail.skipped, 'duplicate');
  // A fresh controller resuming the finished run does not call onRunEnd again.
  const resumed = createLunasWork({ ...deps, onRunEnd: [async (run) => results.push(await reporter.onRunEnd(run))] });
  assert.equal(resumed.resume(), false);
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(results.length, 1);
  assert.equal(mail.sends.length, 1);
});
