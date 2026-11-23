// ============================================================================
// LunaCore - brief memories of God Mode packages and their outcome lines
// (src/orchestraBriefMemory.js, orchestraFinalize.js, orchestraSupervisor.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const brief = require('../src/orchestraBriefMemory.js');
const sup = require('../src/orchestraSupervisor.js');
const { createFinalizer } = require('../src/orchestraFinalize.js');
const { createLog, logPath } = require('../src/memorylog.js');

const PROJECT = 'github.com/acme/hud';
const key = (id) => `${PROJECT}/${id}`;
const MEMORY = { project: PROJECT, keys: [key('a'), key('b')] };

const pkg = (id, over = {}) => ({ id, title: id, state: 'pushed', branch: `luna/${id}`, dependsOn: [], stalls: 0, autoRetries: 0, verifyRounds: 0, stallHistory: [], ...over });

test('readInjection splits the injector answer; a plain string carries no keys', () => {
  assert.deepEqual(brief.readInjection('## Project memory'), { text: '## Project memory', briefMemory: null });
  assert.deepEqual(brief.readInjection({ text: 'x', keys: [key('a'), 'junk', key('a')], project: PROJECT }), { text: 'x', briefMemory: { project: PROJECT, keys: [key('a')] } });
  assert.deepEqual(brief.readInjection({ text: '', keys: [key('a')], project: PROJECT }), { text: null, briefMemory: null });
  assert.deepEqual(brief.readInjection({ text: 'x', keys: [key('a')], project: 'global' }), { text: 'x', briefMemory: null });
  assert.deepEqual(brief.readInjection(null), { text: null, briefMemory: null });
});

test('a resume adds its keys to the package; another project replaces them; the list is capped', () => {
  assert.deepEqual(brief.withInjected(MEMORY, { project: PROJECT, keys: [key('b'), key('c')] }), { project: PROJECT, keys: [key('a'), key('b'), key('c')] });
  const other = { project: 'github.com/acme/quote', keys: ['github.com/acme/quote/x'] };
  assert.deepEqual(brief.withInjected(MEMORY, other), other);
  assert.deepEqual(brief.withInjected(undefined, MEMORY), MEMORY);
  const many = { project: PROJECT, keys: Array.from({ length: 15 }, (_, i) => key(`k-${i}`)) };
  assert.equal(brief.withInjected(MEMORY, many).keys.length, brief.MAX_BRIEF_KEYS);
});

test('a package ends clean, retried, stalled or failed; closed, killed and running say nothing', () => {
  assert.equal(brief.briefOutcomeOf(pkg('a')), 'clean');
  assert.equal(brief.briefOutcomeOf(pkg('a', { verifyRounds: 1 })), 'retried');
  assert.equal(brief.briefOutcomeOf(pkg('a', { stalls: 1 })), 'retried');
  assert.equal(brief.briefOutcomeOf(pkg('a', { autoRetries: 2 })), 'retried');
  assert.equal(brief.briefOutcomeOf(pkg('a', { stallHistory: [{ at: 1, kind: 'fixup', reason: 'pushBlocked' }] })), 'retried');
  assert.equal(brief.briefOutcomeOf(pkg('a', { state: 'stalled' })), 'stalled');
  assert.equal(brief.briefOutcomeOf(pkg('a', { state: 'failed' })), 'failed');
  for (const state of ['closed', 'killed', 'launched', 'pending']) assert.equal(brief.briefOutcomeOf(pkg('a', { state })), null, state);
});

test('the lines a run owes: packages with brief memories whose outcome is new or changed', () => {
  const plan = {
    id: 'run1',
    packages: [
      pkg('a', { briefMemory: MEMORY }),
      pkg('b', { state: 'failed', briefMemory: MEMORY, briefOutcome: 'failed' }),
      pkg('c', { state: 'stalled', briefMemory: MEMORY, briefOutcome: 'failed' }),
      pkg('d'),
      pkg('e', { state: 'killed', briefMemory: MEMORY }),
    ],
  };

  const updates = brief.briefOutcomeUpdates(plan);

  assert.deepEqual(
    updates.map((u) => [u.pkgId, u.outcome]),
    [
      ['a', 'clean'],
      ['c', 'stalled'],
    ],
  );
  assert.deepEqual(updates[0].event, { ev: 'brief-outcome', project: PROJECT, runId: 'run1', pkgId: 'a', keys: MEMORY.keys, outcome: 'clean' });
});

test('a stored package keeps its brief memory across a restart; junk is dropped', () => {
  const stored = (packages) => sup.normalizeStoredPlan({ id: 'run1', repoPath: path.resolve('/repo'), packages, todoText: [] }).packages;
  const [kept, junk, badOutcome] = stored([
    { ...pkg('a'), briefMemory: { project: PROJECT, keys: [key('a'), '../x'] }, briefOutcome: 'stalled' },
    { ...pkg('b'), briefMemory: { project: 'nope', keys: [key('a')] }, briefOutcome: 'stalled' },
    { ...pkg('c'), briefMemory: MEMORY, briefOutcome: 'great' },
  ]);

  assert.deepEqual(kept.briefMemory, { project: PROJECT, keys: [key('a')] });
  assert.equal(kept.briefOutcome, 'stalled');
  assert.equal('briefMemory' in junk, false);
  assert.equal('briefOutcome' in junk, false);
  assert.deepEqual(badOutcome.briefMemory, MEMORY);
  assert.equal('briefOutcome' in badOutcome, false);
});

/** A settled run and its finalizer, logging into a real memory log. */
function finalizerWith(t, packages, { logBriefOutcome } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-briefout-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const log = createLog(logPath(dir), { now: () => 1700000000000 });
  const plan = { id: 'run1', repoPath: '/r', baseBranch: 'main', integrationMode: 'branches', integration: { state: 'idle' }, approvalLog: [], packages };
  const events = [];
  const fin = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => {
      plan.packages = plan.packages.map((p) => (p.id === id ? { ...p, ...fields } : p));
    },
    commit: () => {},
    view: () => ({ id: plan.id, packages: plan.packages, integration: plan.integration, overlaps: [] }),
    onRunEvent: (kind, data) => events.push([kind, data]),
    now: () => 1,
    sleep: async () => {},
    logBriefOutcome: logBriefOutcome || ((event) => log.add(event)),
  });
  return { plan, fin, log, events };
}

test('a settled run logs one brief-outcome line per package, and only what changed on a second pass', async (t) => {
  const f = finalizerWith(t, [
    pkg('a', { briefMemory: MEMORY }),
    pkg('b', { state: 'stalled', briefMemory: { project: PROJECT, keys: [key('c')] } }),
    pkg('c'),
  ]);

  assert.equal(await f.fin.finalize(), true);
  assert.deepEqual(
    f.log.read().map((e) => [e.ev, e.pkgId, e.outcome, e.keys]),
    [
      ['brief-outcome', 'a', 'clean', MEMORY.keys],
      ['brief-outcome', 'b', 'stalled', [key('c')]],
    ],
  );
  assert.equal(f.plan.packages.find((p) => p.id === 'b').briefOutcome, 'stalled');

  // Retry after the run settled: b is pushed after its stall.
  f.plan.packages = f.plan.packages.map((p) => (p.id === 'b' ? { ...p, state: 'pushed', stalls: 1 } : p));
  await f.fin.finalize();
  assert.deepEqual(
    f.log.read().map((e) => [e.pkgId, e.outcome]),
    [
      ['a', 'clean'],
      ['b', 'stalled'],
      ['b', 'retried'],
    ],
  );
});

test('a refused or throwing log never breaks the finalize; a refused line is tried again', async (t) => {
  const refused = finalizerWith(t, [pkg('a', { briefMemory: MEMORY })], { logBriefOutcome: () => false });
  assert.equal(await refused.fin.finalize(), true);
  assert.equal('briefOutcome' in refused.plan.packages[0], false);

  const throwing = finalizerWith(t, [pkg('a', { briefMemory: MEMORY })], {
    logBriefOutcome: () => {
      throw new Error('disk full');
    },
  });
  assert.equal(await throwing.fin.finalize(), true);
  assert.equal(throwing.plan.integration.state, 'done');
  assert.ok(throwing.events.some(([kind, data]) => kind === 'error' && data.where === 'briefOutcome'));
});
