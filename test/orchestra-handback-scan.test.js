'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handbackFrom, MAX_HANDBACK_CHARS } = require('../src/orchestraDiagnose');
const sup = require('../src/orchestraSupervisor');
const { createFollowupLedger, normalizeFollowupEntries, MAX_FOLLOWUPS_PER_PACKAGE, LIST_HEADROOM } = require('../src/orchestraFollowups');
const { buildReport, renderRunReportHtml } = require('../src/orchestraReport');
const { createFinalizer } = require('../src/orchestraFinalize');
const { createOrchestra } = require('../src/orchestra');
const { MAX_ITEMS } = require('../src/todo');
const {
  SCAN_LEDGER_FILE,
  SCAN_FALLBACK_PACKAGE,
  readScanLedger,
  buildHandbackDigest,
  buildScanPrompt,
  parseScanAnswer,
  createHandbackScanner,
} = require('../src/orchestraHandbackScan');

function tmpConfigDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-hb-scan-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup error */
    }
  });
  return dir;
}

function makeTurnFragment(text) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  });
}

test('handbackFrom extracts the full final assistant message and caps at MAX_HANDBACK_CHARS', () => {
  const body = [
    'Finished capping the two pollers.',
    '- Medium, not fixed: four hung slow calls can fill every slot.',
    '- Not handled: worktrees.runGit is not capped yet.',
    'LUNA_DONE git-pool',
  ].join('\n');
  assert.equal(handbackFrom(makeTurnFragment(body)), body);

  const huge = 'x'.repeat(MAX_HANDBACK_CHARS + 500);
  const capped = handbackFrom(makeTurnFragment(huge));
  assert.equal(capped.length, MAX_HANDBACK_CHARS + 3);
  assert.ok(capped.startsWith('...'));
});

test('orchestraSupervisor accepts scanHandbacks as a live opt-in option and preserves package handback', () => {
  assert.equal(sup.isOptionsPatch({ scanHandbacks: true }), true);
  assert.equal(sup.isOptionsPatch({ scanHandbacks: false }), true);
  assert.equal(sup.isOptionsPatch({ scanHandbacks: 'yes' }), false);

  const off = sup.normalizeOptions({});
  assert.equal('scanHandbacks' in off, false);
  const on = sup.normalizeOptions({ scanHandbacks: true });
  assert.equal(on.scanHandbacks, true);

  const stored = sup.normalizeStoredPlan({
    id: 'run123',
    projectId: 'proj-1',
    repoPath: path.resolve('.'),
    options: { scanHandbacks: true },
    packages: [{ id: 'git-pool', prompt: 'cap git', handback: 'Not handled: worktrees.runGit' }],
  });
  assert.equal(stored.options.scanHandbacks, true);
  assert.equal(stored.packages[0].handback, 'Not handled: worktrees.runGit');
});

test('buildHandbackDigest prefers handback, falls back to lastWords, scrubs secrets, and lists open/filed titles', () => {
  const view = {
    id: 'run1',
    followupsFiled: [{ runId: 'run1', packageId: 'pkg-a', kind: 'bug', title: 'Already filed card', at: 100 }],
    packages: [
      { id: 'pkg-a', state: 'pushed', handback: 'Not handled: worktrees.runGit with key sk-ant-api03-1234567890abcdefghij1234567890' },
      { id: 'pkg-b', state: 'stalled', error: 'blocked', lastWords: 'Waiting on missing migration' },
      { id: 'pkg-c', state: 'pending' },
    ],
  };
  const openTodos = [
    { text: 'Open card one', done: false, at: 1 },
    { text: 'Done card', done: true, at: 2 },
  ];
  const digest = buildHandbackDigest(view, openTodos);
  assert.deepEqual(digest.packageIds, ['pkg-a', 'pkg-b']);
  assert.ok(digest.text.includes('### Package: pkg-a (state=pushed)'));
  assert.ok(digest.text.includes('Not handled: worktrees.runGit'));
  assert.ok(!digest.text.includes('sk-ant-api03-1234567890abcdefghij1234567890'));
  assert.ok(digest.text.includes('Waiting on missing migration'));
  assert.ok(digest.text.includes('- Already filed card'));
  assert.ok(digest.text.includes('- Open card one'));
  assert.ok(!digest.text.includes('Done card'));

  const prompt = buildScanPrompt(digest.text);
  assert.ok(prompt.includes('STRICT JSON'));
  assert.ok(prompt.includes('pkg-a'));
});

test('parseScanAnswer parses object or fenced JSON, strips unsafe fields, and falls back unknown packageId', () => {
  const fenced = [
    'Here is the JSON:',
    '```json',
    JSON.stringify({
      tasks: [
        {
          packageId: 'pkg-a',
          kind: 'gap',
          text: 'Cap worktrees.runGit',
          details: 'worktrees.runGit bypasses gitpool.js',
          acceptance: ['rev-parse is capped'],
          size: 'm',
          verify: 'rm -rf /',
          files: ['src/main.js'],
          model: 'opus',
          effort: 'max',
          manual: true,
          tags: ['evil'],
        },
        {
          packageId: 'unknown-pkg',
          kind: 'bug',
          text: 'Isolate slow git calls',
        },
        {
          packageId: 'pkg-a',
          kind: 'invalid-kind',
          text: 'Should be dropped',
        },
      ],
    }),
    '```',
  ].join('\n');

  const tasks = parseScanAnswer(fenced, ['pkg-a']);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0], {
    packageId: 'pkg-a',
    kind: 'gap',
    text: 'Cap worktrees.runGit',
    details: 'worktrees.runGit bypasses gitpool.js',
    acceptance: ['rev-parse is capped'],
    size: 'M',
  });
  assert.equal(tasks[1].packageId, SCAN_FALLBACK_PACKAGE);
  assert.equal(tasks[1].kind, 'bug');
  assert.equal(parseScanAnswer('not json at all', ['pkg-a']).length, 0);
});

test('createHandbackScanner skips when disabled and never calls the model', async (t) => {
  const dir = tmpConfigDir(t);
  let called = 0;
  const scanner = createHandbackScanner({
    configDir: dir,
    run: async () => {
      called += 1;
      return { ok: true, answer: { tasks: [] } };
    },
    readTodos: () => [],
    writeTodos: () => true,
    ledger: createFollowupLedger(),
  });
  const res = await scanner.scan({
    runId: 'run-off',
    projectId: 'proj-1',
    view: { id: 'run-off', projectId: 'proj-1', options: {}, packages: [{ id: 'pkg-a', handback: 'Not handled: X' }] },
  });
  assert.deepEqual(res, { scanned: false, reason: 'disabled', filed: 0 });
  assert.equal(called, 0);
});

test('createHandbackScanner files valid tasks, skips duplicates, updates ledger, and never scans a run twice', async (t) => {
  const dir = tmpConfigDir(t);
  let storedTodos = [{ text: 'Already open task', done: false, at: 1000 }];
  const ledger = createFollowupLedger();
  const changed = [];
  const reportLines = [];
  let modelCalls = 0;
  let clock = 5000;

  const makeScanner = () =>
    createHandbackScanner({
      configDir: dir,
      run: async () => {
        modelCalls += 1;
        return {
          ok: true,
          answer: {
            tasks: [
              { packageId: 'git-pool', kind: 'bug', text: 'Already open task', details: 'dup should be skipped' },
              {
                packageId: 'git-pool',
                kind: 'gap',
                text: 'Cap worktrees.runGit in gitpool.js',
                details: 'rev-parse --show-toplevel comes from worktrees.runGit',
                acceptance: ['worktrees.runGit is capped'],
                size: 'M',
              },
              {
                packageId: 'git-pool',
                kind: 'gap',
                text: '  cap   worktrees.runGit in gitpool.js  ',
                details: 'within-batch dup',
              },
              {
                packageId: 'git-pool',
                kind: 'bug',
                text: 'Prevent 4 slow git calls from starving status polls',
                details: 'fetch / log --all fill all 4 slots',
              },
            ],
          },
        };
      },
      readTodos: () => storedTodos,
      writeTodos: (_pid, next) => {
        storedTodos = next;
        return true;
      },
      ledger,
      onTodosChanged: (pid, n) => changed.push([pid, n]),
      appendReport: (rid, line) => reportLines.push([rid, line]),
      now: () => (clock += 10),
    });

  const view = {
    id: 'run-42',
    projectId: 'proj-1',
    options: { scanHandbacks: true },
    packages: [{ id: 'git-pool', state: 'pushed', handback: 'Not handled: worktrees.runGit. Medium, not fixed: 4 slow calls.' }],
  };

  const first = await makeScanner().scan({ runId: 'run-42', projectId: 'proj-1', view });
  assert.deepEqual(first, { scanned: true, reason: 'filed', filed: 2 });
  assert.equal(modelCalls, 1);
  assert.equal(storedTodos.length, 3);
  assert.deepEqual(storedTodos[1].tags, ['gm-followup', 'gm-gap', 'run:run-42']);
  assert.notEqual(storedTodos[1].manual, true);
  assert.ok(storedTodos[1].details.endsWith('Filed by God Mode package git-pool'));
  assert.deepEqual(storedTodos[2].tags, ['gm-followup', 'gm-bug', 'run:run-42']);
  assert.equal(ledger.list('run-42').length, 2);
  assert.deepEqual(changed, [['proj-1', 2]]);
  assert.equal(reportLines.length, 1);

  // Restarted scanner sees the per-run ledger and refuses to scan again.
  const second = await makeScanner().scan({ runId: 'run-42', projectId: 'proj-1', view });
  assert.deepEqual(second, { scanned: false, reason: 'already-scanned', filed: 0 });
  assert.equal(modelCalls, 1);
  const disk = readScanLedger(path.join(dir, SCAN_LEDGER_FILE));
  assert.equal(disk.runs['run-42'].reason, 'filed');
  assert.equal(disk.runs['run-42'].filed, 2);
});

test('createHandbackScanner respects per-package cap and survives model failures without throwing', async (t) => {
  const dir = tmpConfigDir(t);
  let storedTodos = [];
  const ledger = createFollowupLedger();
  const manyTasks = Array.from({ length: MAX_FOLLOWUPS_PER_PACKAGE + 4 }, (_, i) => ({
    packageId: 'pkg-a',
    kind: 'idea',
    text: `Follow-up item ${i + 1}`,
  }));

  const scanner = createHandbackScanner({
    configDir: dir,
    run: async () => ({ ok: true, answer: { tasks: manyTasks } }),
    readTodos: () => storedTodos,
    writeTodos: (_pid, next) => {
      storedTodos = next;
      return true;
    },
    ledger,
  });

  const res = await scanner.scan({
    runId: 'run-cap',
    projectId: 'proj-1',
    view: { id: 'run-cap', projectId: 'proj-1', options: { scanHandbacks: true }, packages: [{ id: 'pkg-a', handback: 'lots of ideas' }] },
  });
  assert.equal(res.scanned, true);
  assert.equal(res.filed, MAX_FOLLOWUPS_PER_PACKAGE);
  assert.equal(storedTodos.length, MAX_FOLLOWUPS_PER_PACKAGE);

  const failScanner = createHandbackScanner({
    configDir: dir,
    run: async () => ({ ok: false, reason: 'timeout' }),
    readTodos: () => [],
    writeTodos: () => true,
    ledger,
  });
  const failRes = await failScanner.scan({
    runId: 'run-fail',
    projectId: 'proj-1',
    view: { id: 'run-fail', projectId: 'proj-1', options: { scanHandbacks: true }, packages: [{ id: 'pkg-a', handback: 'some text' }] },
  });
  assert.deepEqual(failRes, { scanned: true, reason: 'model-timeout', filed: 0 });
});

test('edge cases: LIST_HEADROOM partial fit, non-string LLM fields, prototype runId, and dedup preservation', async (t) => {
  const dir = tmpConfigDir(t);
  // 1. Non-string fields are dropped instead of coerced to "[object Object]".
  const badParsed = parseScanAnswer({
    tasks: [
      { packageId: 'pkg-a', kind: 'bug', text: { nested: 1 } },
      { packageId: 'pkg-a', kind: 'bug', text: 'Valid title', details: { bad: true }, acceptance: [{ bad: true }, 'Real check'] },
    ],
  }, ['pkg-a']);
  assert.equal(badParsed.length, 1);
  assert.equal(badParsed[0].details, undefined);
  assert.deepEqual(badParsed[0].acceptance, ['Real check']);

  // 2. Verbose handbacks never truncate the Already open / Already filed sections.
  const verbosePkgs = Array.from({ length: 8 }, (_, i) => ({ id: `pkg-${i}`, handback: 'a'.repeat(4000) }));
  const digest = buildHandbackDigest(
    { id: 'run-big', packages: verbosePkgs },
    [{ text: 'Must remain visible open todo', done: false, at: 1 }],
  );
  assert.ok(digest.text.includes('Must remain visible open todo'));
  assert.ok(digest.packageIds.length < 8);

  // 3. Prototype-chain runIds are rejected.
  const protoScanner = createHandbackScanner({
    configDir: dir,
    run: async () => ({ ok: true, answer: { tasks: [] } }),
    readTodos: () => [],
    writeTodos: () => true,
    ledger: createFollowupLedger(),
  });
  const protoRes = await protoScanner.scan({
    runId: 'toString',
    projectId: 'proj-1',
    view: { id: 'toString', projectId: 'proj-1', options: { scanHandbacks: true }, packages: [{ id: 'pkg-a', handback: 'x' }] },
  });
  assert.deepEqual(protoRes, { scanned: false, reason: 'bad-run-id', filed: 0 });

  // 4. LIST_HEADROOM partial fit: when only 2 slots remain, 2 of 5 candidates are filed (not 0).
  const initialCount = MAX_ITEMS - LIST_HEADROOM - 2;
  let storedTodos = Array.from({ length: initialCount }, (_, i) => ({ text: `Existing ${i}`, done: false, at: 100 + i }));
  const fitScanner = createHandbackScanner({
    configDir: dir,
    run: async () => ({
      ok: true,
      answer: {
        tasks: Array.from({ length: 5 }, (_, i) => ({ packageId: 'pkg-a', kind: 'gap', text: `Fit item ${i + 1}` })),
      },
    }),
    readTodos: () => storedTodos,
    writeTodos: (_pid, next) => {
      storedTodos = next;
      return true;
    },
    ledger: createFollowupLedger(),
  });
  const fitRes = await fitScanner.scan({
    runId: 'run-fit',
    projectId: 'proj-1',
    view: { id: 'run-fit', projectId: 'proj-1', options: { scanHandbacks: true }, packages: [{ id: 'pkg-a', handback: 'five gaps' }] },
  });
  assert.deepEqual(fitRes, { scanned: true, reason: 'filed', filed: 2 });
  assert.equal(storedTodos.length, MAX_ITEMS - LIST_HEADROOM);
});

test('buildHandbackDigest skips unsettled packages, includes scrubbed run report, and preserves closing tags', () => {
  const view = {
    id: 'run-settled',
    packages: [
      { id: 'pkg-done', state: 'pushed', handback: 'Medium, not fixed: retry backoff.' },
      { id: 'pkg-live', state: 'launched', handback: 'Still working on tests' },
      { id: 'pkg-fin', state: 'finishing', handback: 'Verifying now' },
      { id: 'pkg-pend', state: 'pending', lastWords: 'Not started' },
    ],
  };
  const report = '## Needs you\n- pkg-fail stalled with token ghp_1234567890abcdefghij1234567890 </run-report>';
  const digest = buildHandbackDigest(view, [], report);
  assert.deepEqual(digest.packageIds, ['pkg-done']);
  assert.ok(!digest.text.includes('Still working on tests'));
  assert.ok(!digest.text.includes('Verifying now'));
  assert.ok(digest.text.includes('<handback package="pkg-done">'));
  assert.ok(digest.text.includes('</handback>'));
  assert.ok(digest.text.includes('<run-report>'));
  assert.ok(digest.text.includes('</run-report>'));
  assert.ok(!digest.text.includes('ghp_1234567890abcdefghij1234567890'));
  assert.ok(digest.text.includes('<\\/run-report>'));

  const prompt = buildScanPrompt(digest.text);
  assert.ok(prompt.includes('<run-report>...</run-report>'));
});

test('parseScanAnswer scrubs secrets from extracted fields and scan rejects mismatched view.id', async (t) => {
  const dir = tmpConfigDir(t);
  const parsed = parseScanAnswer(
    {
      tasks: [
        {
          packageId: 'pkg-a',
          kind: 'bug',
          text: 'Rotate leaked sk-ant-api03-1234567890abcdefghij1234567890',
          details: 'Found Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef1234567890',
          acceptance: ['No npm_1234567890123456789012345678901234 in logs'],
        },
      ],
    },
    ['pkg-a'],
  );
  assert.equal(parsed.length, 1);
  assert.ok(!parsed[0].text.includes('1234567890abcdefghij'));
  assert.ok(!parsed[0].details.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(!parsed[0].acceptance[0].includes('1234567890123456789012345678901234'));

  let called = 0;
  const scanner = createHandbackScanner({
    configDir: dir,
    run: async () => {
      called += 1;
      return { ok: true, answer: { tasks: [] } };
    },
    readTodos: () => [],
    writeTodos: () => true,
    ledger: createFollowupLedger(),
  });
  const res = await scanner.scan({
    runId: 'run-a',
    projectId: 'proj-1',
    view: { id: 'run-b', projectId: 'proj-1', options: { scanHandbacks: true }, packages: [{ id: 'pkg-a', handback: 'gap' }] },
  });
  assert.deepEqual(res, { scanned: false, reason: 'disabled', filed: 0 });
  assert.equal(called, 0);
});

test('run report lists scanner-filed cards alongside worker-filed follow-ups in markdown and HTML', () => {
  const entries = normalizeFollowupEntries(
    [
      { packageId: 'git-pool', kind: 'bug', title: 'Worker-filed race condition', at: 101 },
      { packageId: 'git-pool', kind: 'bug', title: 'Scanner-filed slow call starvation', at: 102, source: 'scan' },
      { packageId: 'handback-scan', kind: 'gap', title: 'Cap worktrees.runGit', at: 103, source: 'scan' },
    ],
    'run-rep',
  );
  assert.equal(entries[0].source, undefined);
  assert.equal(entries[1].source, 'scan');

  const view = {
    id: 'run-rep',
    repoPath: '/repo',
    workerModel: 'sonnet',
    permissionMode: 'bypassPermissions',
    packages: [],
    integration: {},
    followupsFiled: entries,
  };
  const md = buildReport(view, { now: 1_800_000_000_000, suggestions: [] });
  assert.ok(md.includes('  - Worker-filed race condition (to-do at 101)'));
  assert.ok(md.includes('  - Scanner-filed slow call starvation (to-do at 102, handback scan)'));
  assert.ok(md.includes('  - Cap worktrees.runGit (to-do at 103, handback scan)'));

  const html = renderRunReportHtml(view, { now: 1_800_000_000_000 });
  assert.ok(html.includes('Worker-filed race condition (to-do at 101)'));
  assert.ok(html.includes('Scanner-filed slow call starvation (to-do at 102, handback scan)'));
});

test('createFinalizer runs handback scan before writing report so report and toast include scanner cards once', async (t) => {
  const dir = tmpConfigDir(t);
  let todos = [];
  let modelCalls = 0;
  let capturedPrompt = '';
  const reports = [];
  const notices = [];
  const plan = {
    id: 'runfin1',
    projectId: 'proj-1',
    repoPath: '/repo',
    baseBranch: 'main',
    integrationMode: 'branches',
    integration: { state: 'idle' },
    options: { scanHandbacks: true },
    approvalLog: [],
    followupsFiled: [{ runId: 'runfin1', packageId: 'pkg-a', kind: 'idea', title: 'Worker idea', at: 50 }],
    packages: [{ id: 'pkg-a', title: 'Pkg A', state: 'pushed', branch: 'luna/pkg-a', dependsOn: [], handback: 'Not handled: edge case X' }],
  };
  const ledger = createFollowupLedger({
    load: () => plan.followupsFiled,
    persist: (_id, entries) => {
      plan.followupsFiled = entries;
      return true;
    },
  });
  const scanner = createHandbackScanner({
    configDir: dir,
    run: async ({ prompt }) => {
      modelCalls += 1;
      capturedPrompt = prompt;
      return {
        ok: true,
        answer: { tasks: [{ packageId: 'pkg-a', kind: 'gap', text: 'Handle edge case X', details: 'Left unhandled in pkg-a' }] },
      };
    },
    readTodos: () => todos,
    writeTodos: (_pid, next) => {
      todos = next;
      return true;
    },
    ledger,
    now: () => 2000,
  });
  const viewOf = () => ({
    id: plan.id,
    projectId: plan.projectId,
    repoPath: plan.repoPath,
    options: plan.options,
    packages: plan.packages,
    integration: plan.integration,
    followupsFiled: plan.followupsFiled,
    overlaps: [],
  });
  const fin = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => {
      plan.packages = plan.packages.map((p) => (p.id === id ? { ...p, ...fields } : p));
    },
    commit: () => {},
    view: viewOf,
    onRunEvent: () => {},
    now: () => 2000,
    sleep: async () => {},
    writeReport: (id, text) => {
      reports.push({ id, text });
      return `/runs/${id}.md`;
    },
    notify: (summary) => notices.push(summary),
    onHandbackScan: (runId, reportText) => scanner.scan({ runId, projectId: plan.projectId, view: viewOf(), reportText }),
  });

  await fin.finalize();
  assert.equal(modelCalls, 1);
  assert.ok(capturedPrompt.includes('<run-report>'));
  assert.ok(capturedPrompt.includes('Not handled: edge case X'));
  assert.equal(reports.length, 1);
  assert.ok(reports[0].text.includes('Worker idea (to-do at 50)'));
  assert.ok(reports[0].text.includes('Handle edge case X (to-do at 2000, handback scan)'));
  assert.deepEqual(notices[0].followups, { gap: 1, idea: 1 });

  // A second finalize pass never re-scans or double-files.
  await fin.finalize();
  assert.equal(modelCalls, 1);
  assert.equal(todos.length, 1);
});

test('late scanHandbacks toggle after settlement scans once and refreshes the run report', async (t) => {
  const dir = tmpConfigDir(t);
  let todos = [];
  const writtenReports = [];
  const ledger = createFollowupLedger({
    load: (runId) => orch.followupsFiled(runId),
    persist: (runId, entries) => orch.noteFollowups(runId, entries),
  });
  const scanner = createHandbackScanner({
    configDir: dir,
    run: async () => ({
      ok: true,
      answer: { tasks: [{ packageId: 'pkg-a', kind: 'bug', text: 'Fix late-discovered leak' }] },
    }),
    readTodos: () => todos,
    writeTodos: (_pid, next) => {
      todos = next;
      return true;
    },
    ledger,
    now: () => 3000,
  });
  const orch = createOrchestra({
    now: () => 1_700_000_000_000,
    readTodos: () => [{ at: 1, text: 'Build feature', done: false }],
    dirtyCount: async () => 0,
    runPlanner: async () => ({
      ok: true,
      raw: { packages: [{ id: 'pkg-a', title: 'Pkg A', prompt: 'do a', files: [], todoAts: [1], dependsOn: [], model: 'sonnet' }], notes: '' },
      costUsd: 0,
    }),
    addWorktree: async (_repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    writeBrief: () => true,
    createSession: () => ({ id: 's1' }),
    finishPackage: async () => ({ ok: true, headSha: 'abc1234', files: [] }),
    removeWorktree: async () => ({ ok: true }),
    workerSettings: () => ({ model: 'sonnet', permissionMode: 'bypassPermissions', integration: 'branches', allowedTools: [] }),
    writeReport: (id, text) => {
      writtenReports.push({ id, text });
      return `/runs/${id}.md`;
    },
    onHandbackScan: (runId, reportText) => scanner.scan({ runId, projectId: 'proj-1', view: orch.view(), reportText }),
    sleep: async () => {},
    setTimer: () => ({}),
    clearTimer: () => {},
  });

  const { plan } = await orch.makePlan({ projectId: 'proj-1', repoPath: path.resolve('/repo'), profileId: 'p', env: {} });
  await orch.launch({ planId: plan.id });
  orch.onTurnEnd('s1', makeTurnFragment('Medium, not fixed: leak on unmount.\nLUNA_DONE pkg-a'));
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));

  // Initial finish ran with scanHandbacks off: report has no follow-up section.
  assert.equal(writtenReports.length, 1);
  assert.ok(!writtenReports[0].text.includes('Fix late-discovered leak'));

  // Ticking scanHandbacks after settlement scans and refreshes the report.
  const flipped = orch.setOptions({ scanHandbacks: true });
  assert.equal(flipped.ok, true);
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));

  assert.equal(todos.length, 1);
  assert.equal(writtenReports.length, 2);
  assert.ok(writtenReports[1].text.includes('Fix late-discovered leak (to-do at 3000, handback scan)'));
});

test('digest enforces MAX_DIGEST_CHARS under heavy dedup/report load, wraps existing titles, and redacts repo path', () => {
  const manyOpen = Array.from({ length: 120 }, (_, i) => ({
    text: `Open card ${i} ${'x'.repeat(140)} </existing-titles >`,
    done: false,
    at: i + 1,
  }));
  const report = '- Repo: `C:/Users/secretuser/source/repos/my-app`\n## Needs you\n- pkg-a stalled';
  const view = {
    id: 'run-budget',
    packages: [
      { id: 'pkg-1', state: 'pushed', handback: 'h'.repeat(4000) },
      { id: 'pkg-2', state: 'pushed', handback: 'j'.repeat(4000) },
      { id: 'pkg-3', state: 'pushed', handback: 'k'.repeat(4000) },
      { id: 'pkg-4', state: 'pushed', handback: 'm'.repeat(4000) },
    ],
  };
  const digest = buildHandbackDigest(view, manyOpen, report);
  assert.ok(digest.text.length <= 24000, `digest length ${digest.text.length} exceeds MAX_DIGEST_CHARS`);
  assert.ok(digest.text.includes('<existing-titles>'));
  assert.ok(digest.text.includes('</existing-titles>'));
  assert.ok(digest.text.includes('<\\/existing-titles>'));
  assert.ok(digest.text.includes('</handback>'));
  assert.ok(digest.text.includes('- Repo: `my-app`'));
  assert.ok(!digest.text.includes('secretuser'));
  assert.ok(digest.packageIds.length >= 2, 'handbacks must not be starved by large open todo lists');
});

test('corrupt scan ledger fails closed without calling model, and post-write ledger error preserves filed count', async (t) => {
  const dir = tmpConfigDir(t);
  const ledgerFile = path.join(dir, SCAN_LEDGER_FILE);
  fs.writeFileSync(ledgerFile, '{not valid json', 'utf8');
  let modelCalls = 0;
  const scanner = createHandbackScanner({
    configDir: dir,
    run: async () => {
      modelCalls += 1;
      return { ok: true, answer: { tasks: [] } };
    },
    readTodos: () => [],
    writeTodos: () => true,
    ledger: createFollowupLedger(),
  });
  const res = await scanner.scan({
    runId: 'run-corrupt',
    projectId: 'proj-1',
    view: { id: 'run-corrupt', projectId: 'proj-1', options: { scanHandbacks: true }, packages: [{ id: 'pkg-a', state: 'pushed', handback: 'gap' }] },
  });
  assert.deepEqual(res, { scanned: false, reason: 'ledger-unreadable', filed: 0 });
  assert.equal(modelCalls, 0);
  // Corrupt file was not silently wiped.
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), '{not valid json');

  // Post-write ledger corruption after initial 'started' write still notifies onTodosChanged and returns filed count.
  const dir2 = tmpConfigDir(t);
  const ledgerFile2 = path.join(dir2, SCAN_LEDGER_FILE);
  let todos = [];
  const changed = [];
  const scanner2 = createHandbackScanner({
    configDir: dir2,
    run: async () => {
      // Simulate ledger becoming unreadable while model call is in flight.
      fs.writeFileSync(ledgerFile2, '{broken', 'utf8');
      return { ok: true, answer: { tasks: [{ packageId: 'pkg-a', kind: 'bug', text: 'Real bug found' }] } };
    },
    readTodos: () => todos,
    writeTodos: (_pid, next) => {
      todos = next;
      return true;
    },
    ledger: createFollowupLedger(),
    onTodosChanged: (pid, n) => changed.push([pid, n]),
    now: () => 4000,
  });
  const res2 = await scanner2.scan({
    runId: 'run-post-err',
    projectId: 'proj-1',
    view: { id: 'run-post-err', projectId: 'proj-1', options: { scanHandbacks: true }, packages: [{ id: 'pkg-a', state: 'pushed', handback: 'bug' }] },
  });
  assert.deepEqual(res2, { scanned: true, reason: 'filed', filed: 1 });
  assert.deepEqual(changed, [['proj-1', 1]]);
  assert.equal(todos.length, 1);
});

test('createFinalizer handles scanHandbacks throw and plan discard during scan cleanly', async () => {
  // 1. Throwing onHandbackScan logs an error event and still writes the report.
  const events = [];
  const reports = [];
  let currentPlan = {
    id: 'runthrow',
    projectId: 'proj-1',
    repoPath: '/repo',
    baseBranch: 'main',
    integrationMode: 'branches',
    integration: { state: 'idle' },
    options: { scanHandbacks: true },
    approvalLog: [],
    packages: [{ id: 'pkg-a', title: 'A', state: 'pushed', branch: 'luna/a', dependsOn: [], handback: 'gap' }],
  };
  const fin1 = createFinalizer({
    getPlan: () => currentPlan,
    patch: () => {},
    commit: () => {},
    view: () => ({ id: currentPlan.id, packages: currentPlan.packages, integration: currentPlan.integration, overlaps: [] }),
    onRunEvent: (k, d) => events.push([k, d]),
    now: () => 5000,
    sleep: async () => {},
    writeReport: (id, text) => {
      reports.push({ id, text });
      return `/runs/${id}.md`;
    },
    onHandbackScan: async () => {
      throw new Error('scan exploded');
    },
  });
  await fin1.finalize();
  assert.ok(events.some(([k, d]) => k === 'error' && d.where === 'handbackScan'));
  assert.equal(reports.length, 1);

  // 2. Plan discarded while onHandbackScan is awaited: report() and notify() are skipped.
  const reports2 = [];
  const notices2 = [];
  let plan2 = { ...currentPlan, id: 'rundisc', integration: { state: 'idle' } };
  const fin2 = createFinalizer({
    getPlan: () => plan2,
    patch: () => {},
    commit: () => {},
    view: () => ({ id: plan2.id, packages: plan2.packages, integration: plan2.integration, overlaps: [] }),
    onRunEvent: () => {},
    now: () => 5000,
    sleep: async () => {},
    writeReport: (id, text) => reports2.push({ id, text }),
    notify: (s) => notices2.push(s),
    onHandbackScan: async () => {
      plan2 = null;
      return { scanned: true, reason: 'nothing', filed: 0 };
    },
  });
  assert.equal(await fin2.finalize(), false);
  assert.equal(reports2.length, 0);
  assert.equal(notices2.length, 0);
});

test('late scanHandbacks toggle does not fire while a retried package is active and skips refresh when filed === 0', async () => {
  let scanCalls = 0;
  let seq = 0;
  const reports = [];
  const orch = createOrchestra({
    now: () => 1_700_000_000_000,
    readTodos: () => [{ at: 1, text: 'Task A', done: false }, { at: 2, text: 'Task B', done: false }],
    dirtyCount: async () => 0,
    runPlanner: async () => ({
      ok: true,
      raw: {
        packages: [
          { id: 'pkg-a', title: 'A', prompt: 'do a', files: [], todoAts: [1], dependsOn: [], model: 'sonnet' },
          { id: 'pkg-b', title: 'B', prompt: 'do b', files: [], todoAts: [2], dependsOn: [], model: 'sonnet' },
        ],
        notes: '',
      },
      costUsd: 0,
    }),
    addWorktree: async (_repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    writeBrief: () => true,
    createSession: () => ({ id: `s${++seq}` }),
    finishPackage: async () => ({ ok: true, headSha: 'abc1234', files: [] }),
    removeWorktree: async () => ({ ok: true }),
    workerSettings: () => ({ model: 'sonnet', permissionMode: 'bypassPermissions', integration: 'branches', allowedTools: [] }),
    writeReport: (id, text) => {
      reports.push({ id, text });
      return `/runs/${id}.md`;
    },
    onHandbackScan: async () => {
      scanCalls += 1;
      return { scanned: true, reason: 'nothing', filed: 0 };
    },
    sleep: async () => {},
    setTimer: () => ({}),
    clearTimer: () => {},
  });

  const { plan } = await orch.makePlan({ projectId: 'proj-1', repoPath: path.resolve('/repo'), profileId: 'p', env: {} });
  await orch.launch({ planId: plan.id });
  orch.onTurnEnd('s1', makeTurnFragment('Done A\nLUNA_DONE pkg-a'));
  orch.onSessionClosed('s2');
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(reports.length, 1);

  // Retry pkg-b: it is now active (launched) while integration.state is still 'done'.
  const retried = await orch.retry({ planId: plan.id, id: 'pkg-b' });
  assert.equal(retried.ok, true);
  assert.equal(orch.setOptions({ scanHandbacks: true }).ok, true);
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(scanCalls, 0, 'must not trigger late scan while a retried package is still active');

  // Once pkg-b finishes, finalize runs the scan once; filed === 0 does not cause extra refreshes.
  orch.onTurnEnd('s3', makeTurnFragment('Done B\nLUNA_DONE pkg-b'));
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(scanCalls, 1);
  assert.equal(reports.length, 2);
});
