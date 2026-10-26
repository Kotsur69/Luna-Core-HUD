// ============================================================================
// Luna's Work iteration 0 (src/lunasworkScaffold.js + its controller wiring
// in src/lunaswork.js). Covers empty-repo detection, the stack choice
// (BRIEF.md / DESIGN.md / profile / default), the card list per stack with
// tests, lint, CI and .env.example, the profile defaults, card seeding
// without duplicates, and the controller: an empty repo builds iteration 0
// before the Director, a non-empty repo skips it, a red scaffold is retried.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  STACKS,
  isEmptyProject,
  detectEmptyRepo,
  chooseStack,
  stackFromText,
  templateCards,
  profileDefaults,
  planScaffold,
  seedScaffoldCards,
  createScaffolder,
  SCAFFOLD_TAG,
} = require('../src/lunasworkScaffold');
const { validateProfile, PROFILE_STACKS } = require('../src/lunasworkSettings');
const { createLunasWork } = require('../src/lunaswork');

const REPO = path.resolve(os.tmpdir(), 'lw-scaffold-repo');
const clone = (v) => JSON.parse(JSON.stringify(v));
const dirent = (name, dir = false) => ({ name, isDirectory: () => dir });
const EMPTY_TOP = [dirent('.git', true), dirent('design', true), dirent('README.md'), dirent('.gitignore')];
const FULL_TOP = [...EMPTY_TOP, dirent('package.json'), dirent('src', true)];

function tmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-scaffold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'design'));
  fs.writeFileSync(path.join(dir, 'design', 'BRIEF.md'), '# Brief\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  return dir;
}

function memoryStore(list = []) {
  const s = { list: clone(list), writes: 0 };
  s.read = () => s.list;
  s.write = (next) => {
    s.list = clone(next);
    s.writes += 1;
    return true;
  };
  return s;
}

// ---- detection ----

test('isEmptyProject: only design/, dot entries and plain files is empty', () => {
  assert.equal(isEmptyProject([]), true);
  assert.equal(isEmptyProject([{ name: 'design', dir: true }, { name: '.git', dir: true }, { name: '.github', dir: true }]), true);
  assert.equal(isEmptyProject([{ name: 'README.md', dir: false }, { name: 'LICENSE', dir: false }, { name: '.gitignore', dir: false }]), true);
});

test('isEmptyProject: a manifest, a source folder or a source file means the project exists', () => {
  const base = [{ name: 'design', dir: true }];
  for (const manifest of ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'App.csproj']) {
    assert.equal(isEmptyProject([...base, { name: manifest, dir: false }]), false, manifest);
  }
  assert.equal(isEmptyProject([...base, { name: 'src', dir: true }]), false);
  assert.equal(isEmptyProject([...base, { name: 'docs', dir: true }]), false, 'any folder besides design/');
  assert.equal(isEmptyProject([...base, { name: 'main.py', dir: false }]), false);
  assert.equal(isEmptyProject([...base, { name: 'index.html', dir: false }]), false);
  assert.equal(isEmptyProject(null), false);
});

test('detectEmptyRepo: a real folder with only the design pack is empty; a package.json is not', (t) => {
  const dir = tmpRepo(t);
  assert.equal(detectEmptyRepo(dir), true);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  assert.equal(detectEmptyRepo(dir), false);
});

test('detectEmptyRepo: a missing folder or a relative path is never treated as empty', () => {
  assert.equal(detectEmptyRepo(path.join(os.tmpdir(), 'lw-scaffold-does-not-exist-123')), false);
  assert.equal(detectEmptyRepo('relative/repo'), false);
  assert.equal(detectEmptyRepo(null), false);
});

// ---- stack choice ----

test('stackFromText reads an explicit Stack line in its common markdown shapes', () => {
  assert.equal(stackFromText('# Brief\n\nStack: python\n'), 'python');
  assert.equal(stackFromText('- **Stack:** Next.js\n'), 'nextjs');
  assert.equal(stackFromText('**Stack**: uv'), 'python');
  assert.equal(stackFromText('We might use Python later.'), null, 'a mention is not a choice');
  assert.equal(stackFromText('Stack: cobol'), null, 'unknown stacks are ignored');
});

test('chooseStack: BRIEF.md, then DESIGN.md, then the profile, else Next.js', () => {
  assert.deepEqual(chooseStack({ brief: 'Stack: python', design: 'Stack: nextjs', profile: { stack: 'nextjs' } }), { stack: 'python', source: 'brief' });
  assert.deepEqual(chooseStack({ brief: '# no stack', design: 'Stack: python' }), { stack: 'python', source: 'design' });
  assert.deepEqual(chooseStack({ brief: null, design: null, profile: { stack: 'python' } }), { stack: 'python', source: 'profile' });
  assert.deepEqual(chooseStack({}), { stack: 'nextjs', source: 'default' });
});

// ---- card lists ----

for (const stack of STACKS) {
  test(`templateCards(${stack}): generator, tests, lint, CI and .env.example cards, chained in order`, () => {
    const cards = templateCards(stack, 'lwrun1');
    assert.equal(cards.length, 5);
    const all = (c) => `${c.text} ${c.details} ${c.files.join(' ')} ${c.acceptance.join(' ')}`;
    assert.match(all(cards[0]), stack === 'nextjs' ? /create-next-app/ : /uv init/, 'official generator first');
    assert.match(all(cards[1]), /test/i);
    assert.match(all(cards[1]), /one passing example test/);
    assert.match(all(cards[2]), /lint|ruff/i);
    assert.ok(cards[3].files.includes('.github/workflows/ci.yml'), 'CI workflow');
    assert.ok(cards[4].files.includes('.env.example'), '.env.example');
    assert.match(cards[4].details, /Never create or commit a real `\.env`/);
    for (const [i, c] of cards.entries()) {
      assert.deepEqual(c.tags, [SCAFFOLD_TAG, 'run:lwrun1']);
      assert.ok(['S', 'M'].includes(c.size));
      if (i === 0) assert.equal(c.dependsOn, undefined);
      else assert.deepEqual(c.dependsOn, [i - 1], 'each step waits for the one before');
    }
  });

  test(`profileDefaults(${stack}) is a valid LunaCore profile that keeps the stack`, () => {
    const defaults = profileDefaults(stack);
    const { profile, reason } = validateProfile(defaults);
    assert.equal(reason, null);
    assert.deepEqual(profile, defaults);
    assert.equal(profile.stack, stack);
  });
}

test('the profile defaults per stack: Next.js on 3000 with npm, Python on 8000 with uv', () => {
  assert.equal(profileDefaults('nextjs').startCommand, 'npm run dev');
  assert.equal(profileDefaults('nextjs').url, 'http://localhost:3000');
  assert.equal(profileDefaults('python').url, 'http://localhost:8000');
  assert.match(profileDefaults('python').checkCommand, /pytest/);
  assert.equal(profileDefaults('cobol'), null);
  assert.deepEqual(templateCards('cobol', 'lwrun1'), []);
});

test('settings know exactly the template stacks; an unknown profile stack is refused', () => {
  assert.deepEqual([...PROFILE_STACKS].sort(), [...STACKS].sort());
  assert.match(validateProfile({ startCommand: 'npm start', stack: 'cobol' }).reason, /unknown stack/);
  assert.equal(validateProfile({ startCommand: 'npm start' }).profile.stack, undefined, 'no stack key unless set');
});

test('planScaffold: null for a non-empty repo, the stack + defaults for an empty one', () => {
  const read = (files) => (_repo, name) => files[name] || null;
  const empty = { readdirSync: () => EMPTY_TOP };
  const full = { readdirSync: () => FULL_TOP };
  assert.equal(planScaffold(REPO, { fsImpl: full, readFile: read({}) }), null);
  const plan = planScaffold(REPO, { fsImpl: empty, readFile: read({ 'DESIGN.md': 'Stack: python' }) });
  assert.equal(plan.stack, 'python');
  assert.equal(plan.source, 'design');
  assert.equal(plan.label, 'Python (uv + pytest)');
  assert.equal(plan.profile.url, 'http://localhost:8000');
});

test('seedScaffoldCards adds the template cards with real ats and dependsOn; a second call reuses them', () => {
  const store = memoryStore([{ text: 'older card', done: false, at: 5 }]);
  const first = seedScaffoldCards(store, { stack: 'nextjs', runId: 'lwrun1', now: 1_700_000_000_000 });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(first.cards.length, 5);
  assert.equal(store.list.length, 6);
  const ats = first.cards.map((c) => c.at);
  assert.equal(new Set(ats).size, 5);
  assert.deepEqual(first.cards[1].dependsOn, [ats[0]]);
  assert.deepEqual(first.cards[4].dependsOn, [ats[3]]);

  const again = seedScaffoldCards(store, { stack: 'nextjs', runId: 'lwrun1', now: 1_700_000_100_000 });
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  assert.equal(store.list.length, 6, 'nothing added twice after a restart');
  assert.equal(store.writes, 1);
});

test('seedScaffoldCards reports a failed write and a full list instead of throwing', () => {
  const failing = { read: () => [], write: () => false };
  assert.deepEqual(seedScaffoldCards(failing, { stack: 'python', runId: 'lwrun1', now: 1 }), { ok: false, error: 'could not save the to-do list' });
  const full = memoryStore(Array.from({ length: 100 }, (_, i) => ({ text: `c${i}`, done: false, at: i + 1 })));
  assert.equal(seedScaffoldCards(full, { stack: 'python', runId: 'lwrun1', now: 1000 }).ok, false);
  assert.equal(seedScaffoldCards(memoryStore(), { stack: 'cobol', runId: 'lwrun1', now: 1 }).error, 'unknownStack');
});

// ---- controller: iteration 0 ----

const PROFILE = { adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' };
const tick = () => new Promise((r) => setImmediate(r));

/** A controller with fakes; the Director stops the run at its first call. */
function harness({ empty = true, profile = PROFILE, brief = 'Stack: python', buildRed = [] } = {}) {
  const h = { todos: [], builds: [], directors: [], confirms: [], saved: [], ended: [], timers: [], clock: 1_700_000_000_000 };
  const red = [...buildRed];
  const scaffold = createScaffolder({
    fsImpl: { readdirSync: () => (empty ? EMPTY_TOP : FULL_TOP) },
    readFile: (_repo, name) => (name === 'BRIEF.md' ? brief : null),
  });
  const deps = {
    store: { load: () => null, save: () => true },
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => (id === 'app' ? { id, repoPath: REPO } : null),
    profileFor: () => profile,
    packStatus: () => ({ complete: true }),
    godModeActive: () => false,
    godModeCheckCommand: () => 'npm test',
    confirmStart: async (ctx) => {
      h.confirms.push(ctx);
      return true;
    },
    saveProfile: (projectId, p) => {
      h.saved.push({ projectId, profile: p });
      return true;
    },
    scaffold,
    todoStore: () => ({
      read: () => h.todos,
      write: (list) => {
        h.todos = clone(list);
        return true;
      },
    }),
    director: async (o) => {
      h.directors.push({ iteration: o.iteration });
      return { ok: true, stop: true, cards: [], model: 'opus', modelReason: 'setting' };
    },
    build: async (o) => {
      h.builds.push({ iteration: o.iteration, cards: clone(o.cards) });
      const isRed = red.length ? red.shift() : false;
      const ats = new Set(o.cards.map((c) => c.at));
      if (!isRed) h.todos = h.todos.map((t) => (ats.has(t.at) ? { ...t, done: true } : t));
      return {
        ok: true,
        integration: { state: isRed ? 'failed' : 'done', selfCheck: { pushedIntegrationBranch: isRed ? 'luna/x-integration' : null } },
        plan: { packages: [{ id: 'pk', merged: !isRed, todos: o.cards.map((c) => c.text) }] },
      };
    },
    createAdapter: () => ({ evidenceDir: null, start: async () => ({ url: 'x' }), stop: async () => true, tools: () => ({}) }),
    playtest: async () => ({ ok: true, report: {} }),
    shipGate: () => ({ allPassed: false }),
    critic: async () => ({ ok: true, verdict: 'continue' }),
    onRunEnd: [(run) => h.ended.push(run)],
    newRunId: () => 'lwscaf1',
    now: () => h.clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: h.clock + ms, cleared: false };
      h.timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
  };
  h.ctl = createLunasWork(deps);
  h.settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await h.ctl.idle();
      await tick();
    }
  };
  h.fire = async () => {
    const t = h.timers.filter((x) => !x.cleared).sort((a, b) => a.at - b.at)[0];
    assert.ok(t, 'a timer is pending');
    t.cleared = true;
    h.clock = t.at;
    t.fn();
    await h.settle();
  };
  return h;
}

test('controller: an empty repo builds the scaffold cards as iteration 0, before any Director call', async () => {
  const h = harness();
  const res = await h.ctl.start({ projectId: 'app' });
  assert.equal(res.ok, true);
  await h.settle();

  assert.equal(h.builds.length, 1);
  assert.equal(h.builds[0].iteration, 0);
  assert.deepEqual(
    h.builds[0].cards.map((c) => c.text),
    templateCards('python', 'lwscaf1').map((c) => c.text),
    'the python template (Stack line in BRIEF.md)',
  );
  assert.ok(h.builds[0].cards.every((c) => Number.isFinite(c.at) && c.model), 'real cards with a builder model');
  assert.deepEqual(h.directors, [{ iteration: 1 }], 'the Director only comes after iteration 0, at iteration 1');
  assert.ok(h.todos.filter((t) => t.tags && t.tags.includes(SCAFFOLD_TAG)).every((t) => t.done), 'scaffold cards closed');
  assert.ok(h.ctl.runLog().some((e) => /iteration 0: empty repo, scaffolding Python/.test(e.text || '')));
  assert.ok(h.ctl.runLog().some((e) => /iteration 0: scaffold on main/.test(e.text || '')));
});

test('controller: a non-empty repo skips iteration 0 - no scaffold cards, the Director starts at iteration 1', async () => {
  const h = harness({ empty: false });
  await h.ctl.start({ projectId: 'app' });
  await h.settle();
  assert.deepEqual(h.directors, [{ iteration: 1 }]);
  assert.equal(h.builds.length, 0);
  assert.equal(h.todos.length, 0, 'no cards created');
  assert.equal(h.confirms[0].scaffold, undefined, 'no scaffold note in the confirmation');
});

test('controller: a red scaffold never reaches main and is built again', async () => {
  const h = harness({ buildRed: [true] });
  await h.ctl.start({ projectId: 'app' });
  await h.settle();
  assert.equal(h.builds.length, 1);
  assert.equal(h.directors.length, 0, 'no feature work on a red skeleton');
  assert.equal(h.ctl.status().phase, 'building');
  await h.fire();
  assert.equal(h.builds.length, 2);
  assert.equal(h.builds[1].iteration, 0);
  assert.deepEqual(h.directors, [{ iteration: 1 }]);
});

test('controller: an empty repo with no profile is offered the template defaults; confirmed, they are saved', async () => {
  const h = harness({ profile: null, brief: '# no stack line' });
  const res = await h.ctl.start({ projectId: 'app' });
  assert.equal(res.ok, true);
  await h.settle();
  const ctx = h.confirms[0];
  assert.deepEqual(ctx.profile, profileDefaults('nextjs'), 'Next.js is the default frontend');
  assert.deepEqual(ctx.scaffold, { stack: 'nextjs', label: 'Next.js + TypeScript', profileSuggested: true });
  assert.equal(ctx.checkCommand, 'npm test');
  assert.deepEqual(h.saved, [{ projectId: 'app', profile: profileDefaults('nextjs') }]);
  assert.equal(h.builds[0].cards.length, 5);
});

test('controller: a non-empty repo with no profile is still refused', async () => {
  const h = harness({ empty: false, profile: null });
  const res = await h.ctl.start({ projectId: 'app' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-profile');
  assert.equal(h.saved.length, 0);
});
