'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handbackFrom, MAX_HANDBACK_CHARS } = require('../src/orchestraDiagnose');
const sup = require('../src/orchestraSupervisor');
const { createFollowupLedger, MAX_FOLLOWUPS_PER_PACKAGE, LIST_HEADROOM } = require('../src/orchestraFollowups');
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
