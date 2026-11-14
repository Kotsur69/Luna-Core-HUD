// ============================================================================
// God Mode self-healing workers (src/orchestraHeal.js): the pure error
// classifier and heal decision, the resume brief section, and the heal
// controller with the run, the install and the timers faked.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LOCK_RETRY_MS,
  PERMISSION_RETRY_MS,
  classifyEnvError,
  normalizeHeals,
  healDecision,
  healBriefSection,
  createHealer,
} = require('../src/orchestraHeal.js');

// ---- classifyEnvError ---------------------------------------------------------

test('classifyEnvError: a missing bare package is a dependency problem', () => {
  assert.deepEqual(classifyEnvError("Error: Cannot find module 'lodash'\nRequire stack:\n- /wt/a/src/x.js"), {
    kind: 'deps',
    match: "Cannot find module 'lodash'",
  });
  assert.equal(classifyEnvError("Cannot find package '@scope/tool' imported from /wt/a/x.mjs").kind, 'deps');
  assert.equal(classifyEnvError('Cannot find module "left-pad/lib/index.js"').kind, 'deps');
  assert.equal(classifyEnvError('npm test failed: node_modules is missing').kind, 'deps');
  assert.equal(classifyEnvError('the node_modules folder looks empty').kind, 'deps');
  assert.equal(classifyEnvError('blocked on a missing dependency').kind, 'deps');
});

test("classifyEnvError: the worker's own missing file is no environment error", () => {
  assert.equal(classifyEnvError("Cannot find module './util.js'"), null);
  assert.equal(classifyEnvError("Cannot find module '../src/orchestraHeal.js'"), null);
  assert.equal(classifyEnvError("Cannot find module 'C:\\wt\\a\\src\\gone.js'"), null);
  assert.equal(classifyEnvError("Cannot find module '/wt/a/gone.js'"), null);
});

test('classifyEnvError: locks and permission errors', () => {
  assert.deepEqual(classifyEnvError("EBUSY: resource busy or locked, rename 'C:\\wt\\a\\x'"), { kind: 'lock', match: 'EBUSY' });
  assert.equal(classifyEnvError('the file is in use: resource busy or locked').kind, 'lock');
  assert.deepEqual(classifyEnvError("EPERM: operation not permitted, unlink 'x'"), { kind: 'permission', match: 'EPERM' });
  assert.equal(classifyEnvError('EACCES: permission denied, open x').kind, 'permission');
  assert.equal(classifyEnvError('bash: ./run.sh: Permission denied').kind, 'permission');
});

test('classifyEnvError: dependencies win over a lock, a lock over a permission error', () => {
  assert.equal(classifyEnvError("EPERM: operation not permitted\nError: Cannot find module 'chalk'").kind, 'deps');
  assert.equal(classifyEnvError("EPERM: operation not permitted, rename\nEBUSY: resource busy or locked").kind, 'lock');
});

test('classifyEnvError: anything else, empty input and old text past the window are null', () => {
  for (const text of [null, undefined, '', '   ', 'AssertionError: expected 1 to equal 2', 'EPERMISSIONS are fine', 42]) {
    assert.equal(classifyEnvError(text), null, String(text));
  }
  const old = `EBUSY: resource busy or locked\n${'x'.repeat(7000)}`;
  assert.equal(classifyEnvError(old), null, 'only the end of a long text counts');
});

test('normalizeHeals keeps known kinds once, in a fixed order', () => {
  assert.deepEqual(normalizeHeals(undefined), []);
  assert.deepEqual(normalizeHeals('deps'), []);
  assert.deepEqual(normalizeHeals(['lock', 'junk', 'deps', 'deps']), ['deps', 'lock']);
});

// ---- healDecision ---------------------------------------------------------------

const stalledPkg = (extra = {}) => ({ id: 'a', root: '/wt/a', branch: 'luna/a', heals: [], lastWords: null, verifyTail: null, ...extra });

test('healDecision: a healable stall with a recognisable error, once per kind', () => {
  assert.deepEqual(healDecision(stalledPkg(), 'blocked', "Cannot find module 'lodash'"), {
    kind: 'deps',
    match: "Cannot find module 'lodash'",
    delayMs: 0,
  });
  assert.equal(healDecision(stalledPkg({ heals: ['deps'] }), 'blocked', "Cannot find module 'lodash'"), null, 'spent');
  assert.equal(healDecision(stalledPkg({ heals: ['deps'] }), 'blocked', 'EBUSY: resource busy or locked').kind, 'lock', 'another kind still heals');
});

test('healDecision: only blocked / noMarker / verifyFailed, only with a worktree', () => {
  for (const reason of ['timeout', 'needsApproval', 'closed', 'restarted', 'pushFailed', 'noCommitsFailed']) {
    assert.equal(healDecision(stalledPkg(), reason, "Cannot find module 'lodash'"), null, reason);
  }
  assert.equal(healDecision(stalledPkg({ root: null }), 'blocked', "Cannot find module 'lodash'"), null);
  assert.equal(healDecision(stalledPkg({ branch: null }), 'blocked', "Cannot find module 'lodash'"), null);
  assert.equal(healDecision(null, 'blocked', "Cannot find module 'lodash'"), null);
  assert.equal(healDecision(stalledPkg(), 'blocked', 'the API key is missing'), null);
});

test('healDecision: the evidence that fits the reason - verify tail or last words', () => {
  const verify = healDecision(stalledPkg({ verifyTail: 'Error: EBUSY: resource busy or locked, open x' }), 'verifyFailed', '1 failing');
  assert.deepEqual(verify, { kind: 'lock', match: 'EBUSY', delayMs: LOCK_RETRY_MS });
  const words = healDecision(stalledPkg({ lastWords: 'npm test: EACCES: permission denied' }), 'noMarker', null);
  assert.deepEqual(words, { kind: 'permission', match: 'EACCES', delayMs: PERMISSION_RETRY_MS });
  // A verify failure is judged by its output, not by what the worker said before.
  assert.equal(healDecision(stalledPkg({ lastWords: 'EBUSY earlier' }), 'verifyFailed', 'AssertionError'), null);
});

test('healBriefSection says what LunaCore did and forbids repairing the environment by hand', () => {
  const deps = healBriefSection({ kind: 'deps', match: "Cannot find module 'lodash'", delayMs: 0 });
  assert.match(deps, /^## Self-heal \(LunaCore\)\n/);
  assert.match(deps, /dependency install \(npm ci\)/);
  assert.match(deps, /Cannot find module 'lodash'/);
  assert.match(deps, /no chmod, no icacls, no linking node_modules/);
  assert.match(deps, /LUNA_BLOCKED/);
  assert.match(healBriefSection({ kind: 'lock', match: 'EBUSY', delayMs: LOCK_RETRY_MS }), /waited 30 s .*locked file \(EBUSY\)/);
  assert.match(healBriefSection({ kind: 'permission', match: 'EPERM', delayMs: PERMISSION_RETRY_MS }), /waited 30 s .*permission error \(EPERM\)/);
});

// ---- createHealer ---------------------------------------------------------------

const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

function harness({ enabled = true, live = true, install = null, resumeOk = true } = {}) {
  const pkgs = new Map();
  const calls = { patches: [], records: [], commits: 0, installs: [], resumes: [], giveUps: [], events: [], timers: [], cleared: [] };
  let clock = 5000;
  const healer = createHealer({
    enabled: () => enabled,
    live: () => live,
    getPkg: (id) => pkgs.get(id) || null,
    patch: (id, fields) => {
      calls.patches.push([id, fields]);
      pkgs.set(id, { ...pkgs.get(id), ...fields });
    },
    record: (id, entry) => calls.records.push([id, entry]),
    commit: () => {
      calls.commits += 1;
    },
    installDeps: (root) => {
      calls.installs.push(root);
      return install ? install(root) : Promise.resolve({ ok: true, output: 'added 12 packages' });
    },
    resume: (id, section) => {
      calls.resumes.push([id, section]);
      return resumeOk;
    },
    giveUp: (id, reason, detail) => calls.giveUps.push([id, reason, detail]),
    onEvent: (kind, data) => calls.events.push([kind, data]),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, done: false };
      calls.timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      calls.cleared.push(t);
      t.done = true;
    },
  });
  const stall = (id, extra = {}) => {
    const p = { id, state: 'stalled', root: `/wt/${id}`, branch: `luna/${id}`, heals: [], ...extra };
    pkgs.set(id, p);
    return p;
  };
  const fire = () => {
    clock += LOCK_RETRY_MS;
    for (const t of calls.timers) {
      if (!t.done) {
        t.done = true;
        t.fn();
      }
    }
  };
  return { healer, calls, pkgs, stall, fire };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a missing dependency: the heal is spent first, the install runs, the worker resumes once', async () => {
  const h = harness();
  const pkg = h.stall('a');
  assert.equal(h.healer.tryHeal(pkg, 'blocked', "Cannot find module 'lodash'"), true);
  assert.deepEqual(h.calls.patches, [['a', { heals: ['deps'] }]], 'spent before the fix runs');
  assert.deepEqual(h.calls.records[0], ['a', { at: 5000, kind: 'heal', reason: 'blocked', detail: "deps: Cannot find module 'lodash'" }]);
  assert.deepEqual(h.calls.events, [['healing', { id: 'a', kind: 'deps' }]]);
  assert.equal(h.healer.busy(), true);
  assert.equal(h.healer.isHealing('a'), true);
  assert.deepEqual(h.healer.view(h.pkgs.get('a')), { heals: ['deps'], healing: 'deps' });

  await flush();
  assert.deepEqual(h.calls.installs, ['/wt/a']);
  assert.equal(h.calls.resumes.length, 1);
  assert.equal(h.calls.resumes[0][0], 'a');
  assert.match(h.calls.resumes[0][1], /## Self-heal \(LunaCore\)/);
  assert.deepEqual(h.calls.records[1], ['a', { at: 5000, kind: 'heal', reason: 'blocked', detail: 'deps: resumed' }]);
  assert.deepEqual(h.calls.events.map(([k]) => k), ['healing', 'healed']);
  assert.equal(h.calls.commits, 1);
  assert.deepEqual(h.calls.giveUps, []);
  assert.equal(h.healer.busy(), false);
  assert.deepEqual(h.healer.view(h.pkgs.get('a')), { heals: ['deps'], healing: null });

  // The same error again: no second heal of this kind, ever.
  h.pkgs.set('a', { ...h.pkgs.get('a'), state: 'stalled' });
  assert.equal(h.healer.tryHeal(h.pkgs.get('a'), 'blocked', "Cannot find module 'lodash'"), false);
  assert.deepEqual(h.calls.installs, ['/wt/a']);
});

test('one heal at a time per package; off, or an unknown error, heals nothing', () => {
  const h = harness({ install: () => new Promise(() => {}) });
  const pkg = h.stall('a');
  assert.equal(h.healer.tryHeal(pkg, 'blocked', "Cannot find module 'lodash'"), true);
  assert.equal(h.healer.tryHeal(pkg, 'blocked', 'EBUSY: resource busy or locked'), false, 'one in flight');

  const off = harness({ enabled: false });
  assert.equal(off.healer.tryHeal(off.stall('a'), 'blocked', "Cannot find module 'lodash'"), false);
  assert.deepEqual([off.calls.patches, off.calls.records, off.calls.installs], [[], [], []]);

  const unknown = harness();
  assert.equal(unknown.healer.tryHeal(unknown.stall('a'), 'blocked', 'the API key is missing'), false);
  assert.equal(unknown.healer.view(unknown.pkgs.get('a')), null, 'nothing to show');
  assert.equal(unknown.healer.tryHeal(null, 'blocked', "Cannot find module 'x'"), false);
});

test('a failed install hands the stall to its usual handling, with the reason', async () => {
  const h = harness({ install: async () => ({ ok: false, output: 'npm ci\nnpm ERR! code E404\n' }) });
  assert.equal(h.healer.tryHeal(h.stall('a'), 'verifyFailed', "Error: Cannot find module 'chalk'"), true);
  await flush();
  assert.deepEqual(h.calls.resumes, []);
  assert.deepEqual(h.calls.giveUps, [['a', 'verifyFailed', "Error: Cannot find module 'chalk'"]]);
  assert.equal(h.calls.records[1][1].detail, 'deps: fix failed - npm ERR! code E404');
  assert.deepEqual(h.calls.events.map(([k]) => k), ['healing', 'healFailed']);
  assert.equal(h.healer.busy(), false);
});

test('an install that throws is a failed fix too', async () => {
  const h = harness({ install: async () => { throw new Error('spawn npm ENOENT'); } });
  h.healer.tryHeal(h.stall('a'), 'blocked', "Cannot find module 'chalk'");
  await flush();
  assert.equal(h.calls.records[1][1].detail, 'deps: fix failed - spawn npm ENOENT');
  assert.deepEqual(h.calls.giveUps, [['a', 'blocked', "Cannot find module 'chalk'"]]);
});

test('a lock waits LOCK_RETRY_MS, a permission error PERMISSION_RETRY_MS, then the worker resumes; nothing is installed', () => {
  const h = harness();
  assert.equal(h.healer.tryHeal(h.stall('a'), 'blocked', 'EBUSY: resource busy or locked'), true);
  assert.equal(h.healer.tryHeal(h.stall('b'), 'noMarker', 'EPERM: operation not permitted'), true);
  assert.deepEqual(h.calls.timers.map((t) => t.ms), [LOCK_RETRY_MS, PERMISSION_RETRY_MS]);
  assert.deepEqual(h.calls.resumes, [], 'not before the wait');
  h.fire();
  assert.deepEqual(h.calls.resumes.map(([id]) => id), ['a', 'b']);
  assert.match(h.calls.resumes[0][1], /waited 30 s .*locked file/);
  assert.match(h.calls.resumes[1][1], /waited 30 s .*permission error/);
  assert.deepEqual(h.calls.installs, []);
  assert.deepEqual(h.pkgs.get('b').heals, ['permission']);
});

test('a heal cancelled meanwhile (kill, Retry by hand) does nothing when its fix lands', async () => {
  const d = deferred();
  const h = harness({ install: () => d.promise });
  h.healer.tryHeal(h.stall('a'), 'blocked', "Cannot find module 'lodash'");
  h.healer.cancel('a');
  assert.equal(h.healer.busy(), false);
  d.resolve({ ok: true });
  await flush();
  assert.deepEqual([h.calls.resumes, h.calls.giveUps], [[], []]);

  const t = harness();
  t.healer.tryHeal(t.stall('a'), 'blocked', 'EBUSY: resource busy or locked');
  t.healer.tryHeal(t.stall('b'), 'blocked', 'EPERM: operation not permitted');
  t.healer.cancelAll();
  assert.equal(t.calls.cleared.length, 2, 'both timers cleared');
  t.fire();
  assert.deepEqual([t.calls.resumes, t.calls.giveUps], [[], []]);
});

test('a package that left stalled meanwhile is not resumed; a run that is not live gives up', async () => {
  const d = deferred();
  const h = harness({ install: () => d.promise });
  h.healer.tryHeal(h.stall('a'), 'blocked', "Cannot find module 'lodash'");
  // The worker finished in its still-open tab while the install ran.
  h.pkgs.set('a', { ...h.pkgs.get('a'), state: 'finishing' });
  d.resolve({ ok: true });
  await flush();
  assert.deepEqual([h.calls.resumes, h.calls.giveUps], [[], []]);

  const paused = harness({ live: false });
  paused.healer.tryHeal(paused.stall('a'), 'blocked', 'EBUSY: resource busy or locked');
  paused.fire();
  assert.deepEqual(paused.calls.resumes, [], 'no worker starts in a paused run');
  assert.deepEqual(paused.calls.giveUps, [['a', 'blocked', 'EBUSY: resource busy or locked']]);
  assert.equal(paused.calls.records[1][1].detail, 'lock: not resumed');

  const noTab = harness({ resumeOk: false });
  noTab.healer.tryHeal(noTab.stall('a'), 'blocked', 'EBUSY: resource busy or locked');
  noTab.fire();
  assert.equal(noTab.calls.resumes.length, 1);
  assert.deepEqual(noTab.calls.giveUps, [['a', 'blocked', 'EBUSY: resource busy or locked']]);
  assert.deepEqual(noTab.calls.events.map(([k]) => k), ['healing', 'healFailed']);
});
