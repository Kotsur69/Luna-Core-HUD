// ============================================================================
// Luna's Work run report + end-of-run email (src/lunasworkReport.js). Covers
// the report shape for each verdict (Needs you first, then verdict and why,
// iterations, scores, rollbacks, model choices, decisions, evidence), a
// report file for every end verdict, exactly one email per run end - driven
// through a real controller over several iterations, so never per iteration -
// the PLAYTEST_LOG tail in PLATEAU / RED mails only, the mail switch, and
// HTML escaping of model text.
//
// LW 2.18: exactly one milestone email per gate and none per iteration (real
// controller, a re-confirmed gate), its content (decisions since the last
// gate, the optional time to SHIP, inline screenshots), the risk ranking of
// the return pack, the pack's sections and lunaswork-<id>-return.md.
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
  buildMilestoneEmail,
} = require('../src/lunasworkReport');
const { rankRiskyDecisions, riskyDecisionsOf, buildReturnPack } = require('../src/lunasworkReturn');
const { MAX_IMAGE_BYTES } = require('../src/lunasworkMail');
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

test('loop-hook notes get their own section per iteration, after the decisions (md and HTML)', () => {
  const run = makeRun('stop');
  const laps = [{ ...run.laps[0], notes: ['graph refresh failed: index timeout', '<b>security review failed</b>'] }, run.laps[1]];
  const md = buildRunReport({ ...run, laps });
  assert.ok(md.indexOf('## Notes') > md.indexOf('## Decisions') && md.indexOf('## Notes') < md.indexOf('## Evidence'));
  assert.match(md, /- Iteration 1: graph refresh failed: index timeout/);
  const html = renderRunReportHtml({ ...run, laps });
  assert.match(html, /Iteration 1: graph refresh failed: index timeout/);
  assert.ok(!html.includes('<b>security'), 'notes are escaped');
  assert.match(buildRunReport(run), /## Notes\n\n- none/);
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

/**
 * A real controller with small fakes, run until PLATEAU (4 iterations).
 * opts.critic replaces the Critic, opts.onMilestone is the milestone hook.
 */
async function runToPlateau(onRunEnd, opts = {}) {
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
    critic: opts.critic || (async () => ({
      ok: true, verdict: 'continue', model: 'sonnet', modelReason: 'regular iteration',
      milestone: { name: 'skeleton', passed: false, score: scores.length ? scores.shift() : 50 }, next: 'skeleton', allPassed: false,
    })),
    onRunEnd: [onRunEnd],
    ...(opts.onMilestone ? { onMilestone: [opts.onMilestone] } : {}),
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
  for (let i = 0; i < (opts.idles || 5); i += 1) await ctl.idle();
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

// ---- LW 2.18: one milestone email per gate ------------------------------------------------

test('one milestone email per gate, none per iteration (real controller: a re-confirmed gate, then PLATEAU)', async (t) => {
  const runsDir = tempDir(t);
  const mail = fakeMail();
  const reporter = createLunasWorkReporter({ runsDir: () => runsDir, mail: mail.deps, readFile: () => null });
  // Iterations 1-2: the Critic passes "skeleton" (the second time a re-confirmed gate); 3-6: "core" stalls.
  const plan = [
    { name: 'skeleton', passed: true, score: 80 },
    { name: 'skeleton', passed: true, score: 82 },
    ...[50, 50, 48, 50].map((score) => ({ name: 'core', passed: false, score })),
  ];
  const critic = async () => {
    const step = plan.length > 1 ? plan.shift() : plan[0];
    return {
      ok: true, verdict: 'continue', model: 'sonnet', modelReason: 'regular iteration',
      milestone: { name: step.name, passed: step.passed, score: step.score }, next: 'core', allPassed: false,
    };
  };
  const hookCalls = [];
  const runEnds = [];
  const { ctl, stored } = await runToPlateau(async (run) => runEnds.push(await reporter.onRunEnd(run)), {
    critic,
    idles: 8,
    onMilestone: async (run, ctx) => hookCalls.push({ ctx, res: await reporter.onMilestone(run, ctx) }),
  });
  for (let i = 0; i < 50 && !runEnds.length; i += 1) await tick();

  assert.equal(ctl.status().verdict, 'plateau');
  assert.equal(ctl.status().iteration, 6, 'six iterations ran');
  assert.deepEqual(hookCalls.map((c) => c.ctx.milestone), ['skeleton'], 'the re-confirmed gate does not call the hook again');
  assert.equal(hookCalls[0].res.sent, true);
  assert.deepEqual(stored().gatesMailed, ['skeleton'], 'the mark survives a restart');
  assert.equal(mail.sends.length, 2, 'one milestone email and one run email over six iterations');
  assert.match(mail.sends[0].subject, /milestone skeleton reached/);
  assert.match(mail.sends[1].subject, /PLATEAU/);
  // A replayed hook sends nothing either.
  assert.equal((await reporter.onMilestone(stored(), { milestone: 'skeleton' })).skipped, 'duplicate');
  assert.equal(mail.sends.length, 2);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A run right after the "payments" gate (iteration 3), the gate before it in iteration 1. */
function gateRun() {
  const shot = (name) => path.join(EVIDENCE, `${name}.png`);
  return makeRun('ship', {
    phase: 'directing',
    verdict: null,
    iteration: 4,
    milestone: 'launch',
    evidenceDir: EVIDENCE,
    laps: [
      { n: 1, milestone: 'core flows', score: 70, gate: true, decisions: [{ choice: 'an old choice', because: 'before the last gate' }], screens: [] },
      { n: 2, milestone: 'payments', score: 40, decisions: [{ choice: 'Stripe checkout', because: 'the brief names it' }], screens: [{ name: 'home-desktop', screenshot: shot('home-2') }] },
      {
        n: 3, milestone: 'payments', score: 75, gate: true, decisions: [],
        screens: [
          { name: 'home-desktop', screenshot: shot('home-3') },
          { name: 'checkout-mobile', screenshot: shot('checkout') },
          { name: 'outside', screenshot: path.resolve(os.tmpdir(), 'lw-elsewhere', 'outside.png') },
          { name: 'big', screenshot: shot('big') },
          { name: 'notes', screenshot: shot('notes') },
        ],
      },
    ],
    decisions: [
      { id: 1, kind: 'dependency', status: 'answered', question: 'Add the stripe package?', answer: 'approve', answeredBy: 'default', answeredAt: START, iteration: 3, cardIds: [] },
      { id: 2, kind: 'migration', status: 'answered', question: 'An old migration?', answer: 'approve', answeredBy: 'mati', answeredAt: START, iteration: 1, cardIds: [] },
      { id: 3, kind: 'designChange', status: 'pending', question: 'Darker header?', defaultAnswer: 'reject', cardIds: [] },
    ],
  });
}

test('the milestone email: decisions since the last gate, time to SHIP only when given, scores, feedback link', () => {
  const run = gateRun();
  const { subject, text } = buildMilestoneEmail(run, { milestone: 'payments' });
  assert.equal(subject, "Luna's Work: amsteel - milestone payments reached");
  assert.match(text, /Milestone "payments" reached after iteration 3\. The run goes on with "launch"\./);
  const since = text.slice(text.indexOf('DECISIONS SINCE THE LAST GATE'));
  assert.ok(since.includes('- Chose Stripe checkout because the brief names it (Critic, iteration 2)'));
  assert.ok(since.includes('"Add the stripe package?"') && since.includes('default after deadline'), 'a queue answer after the last gate');
  assert.ok(!text.includes('an old choice') && !text.includes('An old migration?'), 'nothing from before the last gate');
  assert.match(text, /WAITS FOR YOU\n- Darker header\?/);
  assert.match(text, /SCORES PER MILESTONE/);
  assert.match(text, /Send feedback while it runs: /, 'the feedback link');
  assert.ok(!text.includes('TIME TO SHIP'), 'no estimate, no line');
  assert.ok(!text.includes('SCREENSHOTS'), 'no images, no section');
  assert.match(buildMilestoneEmail(run, { milestone: 'payments', timeToShip: 'about two iterations' }).text, /^TIME TO SHIP: about two iterations$/m);
  // The first gate of a run: everything so far counts.
  assert.ok(buildMilestoneEmail({ ...run, laps: run.laps.slice(0, 1) }, { milestone: 'core flows' }).text.includes('Chose an old choice'));
});

test('the milestone email carries the key screenshots inline, size-capped, from the evidence folder only', async (t) => {
  const runsDir = tempDir(t);
  const mail = fakeMail();
  const reads = [];
  const readImage = (file) => {
    reads.push(path.basename(file));
    if (file.endsWith('big.png')) return Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    if (file.endsWith('notes.png')) return Buffer.from('not an image');
    return PNG;
  };
  const reporter = createLunasWorkReporter({ runsDir: () => runsDir, mail: mail.deps, readFile: () => null, readImage });
  const res = await reporter.onMilestone(gateRun(), { milestone: 'payments' });
  assert.deepEqual(res, { sent: true, images: 2 });
  assert.ok(!reads.includes('outside.png'), 'a file outside the evidence folder is never read');
  assert.ok(!reads.includes('home-2.png'), 'the newest shot of a screen only');
  const [sent] = mail.sends;
  assert.deepEqual(sent.attachments.map((a) => [a.filename, a.mimeType]), [['home.png', 'image/png'], ['checkout.png', 'image/png']]);
  assert.ok(sent.attachments.every((a) => Buffer.isBuffer(a.content) && a.content.length <= MAX_IMAGE_BYTES));
  assert.match(sent.text, /SCREENSHOTS \(inline below\)\n- home \(iteration 3\): home\.png\n- checkout \(iteration 3\): checkout\.png/);
  assert.equal((await reporter.onMilestone(gateRun(), { milestone: 'payments' })).skipped, 'duplicate');
  assert.equal(mail.sends.length, 1, 'one email per gate');
});

// ---- LW 2.18: the return pack -----------------------------------------------------------

test('rankRiskyDecisions: default after the deadline > new dependency > migration > deleted feature > DESIGN change', () => {
  const d = (kind, at, extra = {}) => ({ kind, at, text: `${kind} ${at}`, ...extra });
  const input = Object.freeze([
    d('designChange', 5),
    d('other', 9),
    d('migration', 3),
    d('dependency', 1),
    d('featureDelete', 4),
    d('dependency', 7),
    d('stuckCard', 8, { defaulted: true }),
    d('migration', 2, { defaulted: true }),
    d('outOfScope', 6),
  ]);
  const ranked = rankRiskyDecisions(input);
  assert.deepEqual(ranked.map((r) => r.text), [
    'migration 2', // defaults first, by kind among themselves
    'stuckCard 8',
    'dependency 7', // newest first within a rank
    'dependency 1',
    'migration 3',
    'featureDelete 4',
    'designChange 5',
  ]);
  assert.deepEqual(ranked.map((r) => r.rank), [0, 0, 1, 1, 2, 3, 4]);
  assert.deepEqual(ranked.map((r) => r.defaulted), [true, true, false, false, false, false, false]);
  assert.equal(input.length, 9, 'pure: the input is untouched');
  assert.deepEqual(rankRiskyDecisions(input), ranked, 'pure: same input, same output');
  assert.ok(!ranked.some((r) => ['other', 'outOfScope'].includes(r.kind)), 'a choice outside the risky kinds is not listed');
});

test('rankRiskyDecisions: the ten riskiest only, malformed entries skipped', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ kind: i % 2 ? 'dependency' : 'designChange', at: i, text: `d${i}` }));
  const top = rankRiskyDecisions(many);
  assert.equal(top.length, 10);
  assert.ok(top.every((r) => r.kind === 'dependency'), 'the higher rank fills the list first');
  assert.equal(top[0].at, 23);
  assert.equal(rankRiskyDecisions(many, { limit: 3 }).length, 3);
  assert.deepEqual(rankRiskyDecisions(null), []);
  assert.deepEqual(rankRiskyDecisions([null, 'text', [], { kind: 'migration', text: 'no time' }]).map((r) => [r.text, r.at]), [['no time', null]]);
});

/** A SHIP run with gates, changes, Critic decisions, queue answers, a rollback, screens and a release. */
function returnRun() {
  const [lap1, lap2] = makeRun('ship').laps;
  return makeRun('ship', {
    laps: [
      {
        ...lap1, gate: true,
        changes: [{ text: 'Quote form', kind: 'missing' }, { text: 'Fix the total', kind: 'bug' }],
        decisions: [
          { choice: 'install a new library for charts', because: 'the brief wants graphs' },
          { choice: 'PDF export via the browser', because: 'no new dependency' },
        ],
        screens: [{ name: 'quote-desktop', screenshot: path.join(lap1.evidenceDir, 'quote-desktop.png') }],
      },
      { ...lap2, milestone: 'export', changes: [{ text: 'PDF export' }], screens: [{ name: 'export-desktop', screenshot: path.join(EVIDENCE, 'export-desktop.png') }] },
    ],
    decisions: [
      { id: 1, kind: 'featureDelete', status: 'answered', question: 'Drop the old wizard?', answer: 'reject', answeredBy: 'default', answeredAt: START + 1000, iteration: 2, cardIds: [] },
      { id: 2, kind: 'designChange', status: 'answered', question: 'Darker header?', answer: 'approve', answeredBy: 'mati', answeredAt: START + 2000, iteration: 2, cardIds: [] },
      { id: 3, kind: 'stuckCard', status: 'answered', question: 'Split card 7?', answer: 'approve', answeredBy: 'mati', answeredAt: START, iteration: 1, cardIds: [] },
      { id: 4, kind: 'migration', status: 'pending', question: 'Not answered yet', cardIds: [] },
    ],
    shipDocs: { n: 3, cards: [21, 22, 23], landed: [21, 22, 23], release: { ok: true, tag: 'v1.2.0', url: 'https://github.com/example/amsteel/releases/tag/v1.2.0' } },
  });
}

test('riskyDecisionsOf: answered queue entries and the Critic choices, classified like the queue', () => {
  const all = riskyDecisionsOf(returnRun());
  assert.deepEqual(all.map((d) => [d.kind, d.defaulted]), [
    ['featureDelete', true],
    ['designChange', false],
    ['stuckCard', false],
    ['dependency', false],
    [null, false], // "no new dependency" is a reason, not a new dependency
  ]);
  assert.ok(!all.some((d) => d.text.includes('Not answered yet')), 'a pending decision is not a decision yet');
});

test('the return pack: changes per milestone, the ten riskiest decisions, rollbacks, docs, screen tour', () => {
  const md = buildReturnPack(returnRun());
  const order = ['# While you were away - amsteel (SHIP)', '## What changed per milestone', '## Ten decisions to double-check', '## Rollbacks', '## Docs and release', '## Screen tour']
    .map((h) => md.indexOf(h));
  assert.equal(order[0], 0);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'every section, in this order');
  assert.ok(md.includes('### core flows - gate passed in iteration 1\n\n- Iteration 1, score 60: Quote form; Fix the total'));
  assert.ok(md.includes('### export - gate not passed\n\n- Iteration 2, score 35: PDF export - rolled back'));
  const decisions = md.slice(md.indexOf('## Ten decisions'), md.indexOf('## Rollbacks'));
  assert.deepEqual(decisions.split('\n').filter((l) => /^\d+\. /.test(l)), [
    '1. [default after the deadline, deleted feature] "Drop the old wizard?" -> reject (default after the deadline)',
    '2. [new dependency] Chose install a new library for charts because the brief wants graphs (Critic, iteration 1)',
    '3. [DESIGN change] "Darker header?" -> approve (answered by Mati)',
  ]);
  assert.ok(md.includes('- Iteration 2 rolled back to luna-work/lwrep1/iter-1: the milestone "core flows" score fell from 60 to 35'));
  assert.ok(md.includes('  - reverted abcdef1 Merge package quote-pdf'));
  assert.ok(md.includes('- Docs iteration 3: 3/3 cards landed'));
  assert.ok(md.includes('- Released v1.2.0: https://github.com/example/amsteel/releases/tag/v1.2.0'));
  const quoteShot = path.join(makeRun('ship').laps[0].evidenceDir, 'quote-desktop.png').replace(/\\/g, '/');
  assert.ok(md.includes(`### quote\n\n![quote](<${quoteShot}>)\n\n*quote, as the Playtester saw it in iteration 1.*`));
  assert.ok(md.includes('*export, as the Playtester saw it in iteration 2.*'));

  const mailed = buildReturnPack(returnRun(), { forEmail: true });
  assert.ok(mailed.includes('![quote](quote-desktop.png)'), 'file names only in the email');
  assert.ok(!mailed.includes(os.tmpdir()) && !mailed.includes(os.tmpdir().replace(/\\/g, '/')), 'no local path in the email');
});

test('the return pack of a run that ended early still has every section', () => {
  const md = buildReturnPack(makeRun('stop', { laps: [], history: [], decisions: [] }));
  assert.ok(md.startsWith('# While you were away - amsteel (STOP)'));
  assert.ok(md.includes('- no iteration finished'));
  assert.ok(md.includes('- none - no default answers'));
  assert.ok(md.includes('## Rollbacks\n\n- none'));
  assert.ok(!md.includes('## Docs and release'), 'no docs iteration ran');
  assert.ok(md.includes('- no screenshots in the evidence'));
  const failed = buildReturnPack(makeRun('ship', { shipDocs: { n: 3, cards: [1, 2, 3], landed: [1, 2, 3], release: { ok: false, error: 'noGh', detail: 'gh is not installed' } } }));
  assert.ok(failed.includes('- The release did not go out (noGh: gh is not installed) - tag and publish it by hand'));
});

test('onRunEnd saves lunaswork-<id>-return.md and attaches it with the screen tour', async (t) => {
  const runsDir = tempDir(t);
  const mail = fakeMail();
  const reporter = createLunasWorkReporter({ runsDir: () => runsDir, mail: mail.deps, readFile: () => null, readImage: () => PNG });
  const res = await reporter.onRunEnd(returnRun());
  assert.equal(res.returnFile, path.join(runsDir, 'lunaswork-lwrep1-return.md'));
  assert.equal(fs.readFileSync(res.returnFile, 'utf8'), buildReturnPack(returnRun()));
  const [sent] = mail.sends;
  assert.deepEqual(sent.attachments.map((a) => [a.filename, a.mimeType]), [
    ['lunaswork-run-lwrep1.html', 'text/html'],
    ['lunaswork-lwrep1-return.md', 'text/markdown'],
    // Each shot from its own lap's evidence folder (the folder is per iteration).
    ['quote.png', 'image/png'],
    ['export.png', 'image/png'],
  ]);
  assert.equal(sent.attachments[1].content, buildReturnPack(returnRun(), { forEmail: true }));
});
