// ============================================================================
// Luna's Work decision queue (src/lunasworkDecisions.js + its controller
// wiring in src/lunaswork.js). Covers: needsDecision cases (manifest diffs,
// migrations, deleted features, DESIGN.md beyond an append, client scope,
// Mati's own cards), the run going on while a decision is pending (only its
// card waits), the default after the deadline with its DECISIONS.md entry, a
// client scope change that never defaults, invalid answers refused (unknown
// id, other run, unlisted option, free text where none is allowed, too long),
// persistence across a restart, and the phone round trip (snapshot out,
// answer unit back through the `todos` scope).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Q = require('../src/lunasworkDecisions');
const { createLunasWork, restoreRun } = require('../src/lunaswork');
const { runDirector } = require('../src/lunasworkDirector');
const pack = require('../src/lunasworkPack');
const { publicStatus } = require('../src/lunasworkStatus');
const { withLive, decisionsFrom, parseGodmodePeer } = require('../src/godmodesnapshot');
const { todoPeer, applyRows } = require('../src/cloudrows');
const { wireDecisionSync } = require('../src/lunasworkWiring');

const REPO = path.resolve(os.tmpdir(), 'lw-decisions-repo');
const EVIDENCE = path.resolve(os.tmpdir(), 'lw-decisions-runs');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const START = 1_700_000_000_000;

const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setImmediate(r));

async function until(cond, what = 'condition reached') {
  for (let i = 0; i < 200 && !cond(); i += 1) await tick();
  assert.ok(cond(), what);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---- needsDecision ------------------------------------------------------------------

const pkg = (deps, dev = {}) => JSON.stringify({ name: 'app', dependencies: deps, devDependencies: dev }, null, 2);

test('needsDecision: a new dependency in a manifest diff (package.json, requirements, go.mod, Cargo.toml)', () => {
  const npm = Q.needsDecision({
    files: [{ path: 'package.json', status: 'M', before: pkg({ react: '^18' }), after: pkg({ react: '^18', zod: '^3' }) }],
  });
  assert.equal(npm.kind, 'dependency');
  assert.match(npm.reason, /zod/);
  assert.deepEqual(npm.options, ['approve', 'reject']);
  assert.equal(npm.defaultAnswer, 'approve');

  const dev = Q.needsDecision({ files: [{ path: 'web/package.json', before: pkg({}), after: pkg({}, { vitest: '^2' }) }] });
  assert.equal(dev.kind, 'dependency');

  const py = Q.needsDecision({ files: [{ path: 'requirements.txt', before: 'flask==3.0\n', after: 'flask==3.0\nrequests>=2.31\n' }] });
  assert.match(py.reason, /requests/);

  const go = Q.needsDecision({
    files: [{ path: 'go.mod', before: 'module x\n\nrequire github.com/a/b v1.0.0\n', after: 'module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v0.2.0\n)\n' }],
  });
  assert.match(go.reason, /github\.com\/c\/d/);

  const cargo = Q.needsDecision({
    files: [{ path: 'Cargo.toml', before: '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n', after: '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\ntokio = "1"\n' }],
  });
  assert.match(cargo.reason, /tokio/);
});

test('needsDecision: a version bump or a script change in a manifest is not a new dependency', () => {
  assert.equal(Q.needsDecision({ files: [{ path: 'package.json', before: pkg({ react: '^18.2' }), after: pkg({ react: '^18.3' }) }] }), null);
  const scripts = (s) => JSON.stringify({ name: 'app', scripts: s, dependencies: { react: '^18' } });
  assert.equal(Q.needsDecision({ files: [{ path: 'package.json', before: scripts({ test: 'jest' }), after: scripts({ test: 'vitest' }) }] }), null);
  assert.equal(Q.needsDecision({ files: [{ path: 'requirements.txt', before: 'flask==3.0\n', after: 'flask==3.1\n' }] }), null);
  // A card that only names the manifest among its files: the text decides.
  assert.equal(Q.needsDecision({ text: 'Add a lint script', files: ['package.json'] }), null);
});

test('needsDecision: a new dependency from a card text', () => {
  assert.equal(Q.needsDecision({ text: 'npm install zod for the quote form' }).kind, 'dependency');
  assert.equal(Q.needsDecision({ text: 'Fix the export', details: 'Add a new dependency for PDF rendering' }).kind, 'dependency');
  assert.equal(Q.needsDecision({ text: 'pip install requests and call the API' }).kind, 'dependency');
  assert.equal(Q.needsDecision({ text: 'Install the library chart.js' }).kind, 'dependency');
});

test('needsDecision: schema / migration from paths or text', () => {
  assert.equal(Q.needsDecision({ files: [{ path: 'db/migrations/0003_quotes.sql', status: 'A' }] }).kind, 'migration');
  assert.equal(Q.needsDecision({ files: ['prisma/schema.prisma'] }).kind, 'migration');
  assert.equal(Q.needsDecision({ text: 'Add a column for the discount to quotes' }).kind, 'migration');
  assert.equal(Q.needsDecision({ text: 'Change the database schema of orders' }).kind, 'migration');
  const m = Q.needsDecision({ text: 'ALTER TABLE quotes ADD margin' });
  assert.equal(m.kind, 'migration');
  assert.equal(m.defaultAnswer, 'approve');
});

test('needsDecision: deleting a feature - a deleted source file or the card text; the safe default keeps it', () => {
  const del = Q.needsDecision({ files: [{ path: 'src/screens/Export.tsx', status: 'deleted' }] });
  assert.equal(del.kind, 'featureDelete');
  assert.equal(del.defaultAnswer, 'reject');
  assert.match(del.reason, /Export\.tsx/);
  assert.equal(Q.needsDecision({ text: 'Remove the dark mode' }).kind, 'featureDelete');
  assert.equal(Q.needsDecision({ text: 'Delete the export feature' }).kind, 'featureDelete');
  // Deleted tests or notes are not a feature; trimming a button is not deleting one.
  assert.equal(Q.needsDecision({ files: [{ path: 'test/export.test.js', status: 'D' }, { path: 'notes.md', status: 'D' }] }), null);
  assert.equal(Q.needsDecision({ text: 'Remove the border from the export button' }), null);
});

test('needsDecision: DESIGN.md beyond an append; an append is fine', () => {
  const before = '# Design\n\n## Features\n\n- quotes\n';
  assert.equal(Q.needsDecision({ files: [{ path: 'design/DESIGN.md', before, after: `${before}\n## Director - iteration 3\n\n- PDF export\n` }] }), null);
  const rewrite = Q.needsDecision({ files: [{ path: 'design/DESIGN.md', before, after: '# Design\n\n## Features\n\n- invoices\n' }] });
  assert.equal(rewrite.kind, 'designChange');
  assert.equal(rewrite.defaultAnswer, 'reject');
  assert.equal(Q.needsDecision({ files: [{ path: 'design/DESIGN.md', status: 'deleted' }] }).kind, 'designChange');
  // A card that names DESIGN.md without both versions cannot be shown to append.
  assert.equal(Q.needsDecision({ text: 'x', files: ['design/DESIGN.md'] }).kind, 'designChange');
  assert.equal(Q.needsDecision({ text: 'Rewrite the screens section of DESIGN.md' }).kind, 'designChange');
  assert.equal(Q.needsDecision({ text: 'Append the PDF screen to DESIGN.md' }), null);
});

test('needsDecision: client scope changes never default; Mati can change anything; ordinary cards pass', () => {
  const client = Q.needsDecision({ from: 'client', scope: true, text: 'Also add invoices' });
  assert.equal(client.kind, 'clientScope');
  assert.equal(client.defaultAnswer, null);
  assert.equal(client.freeText, true);
  assert.equal(Q.needsDecision({ from: 'mati', text: 'npm install zod', files: ['db/migrations/1.sql'] }), null);
  assert.equal(Q.needsDecision({ text: 'Bigger header font', files: ['src/styles.css'] }), null);
  // The builder brief every scheduled card carries must not trigger anything.
  assert.equal(
    Q.needsDecision({ text: 'Show totals', details: 'Read design/ARCHITECTURE.md and design/DECISIONS.md first; do not contradict a decision without adding a new DECISIONS entry.' }),
    null,
  );
  assert.equal(Q.needsDecision(null), null);
  assert.equal(Q.needsDecision('npm install zod'), null);
});

// ---- the queue (pure) ---------------------------------------------------------------

test('createDecision: 2 h default deadline, unique ids, a default is required except for client scope', () => {
  const a = Q.createDecision({ question: 'Add zod?', options: ['approve', 'reject'], defaultAnswer: 'approve' }, { now: START, list: [] });
  assert.equal(a.ok, true);
  assert.equal(a.decision.deadline, START + 2 * HOUR);
  assert.equal(a.decision.status, 'pending');
  const b = Q.createDecision({ question: 'Again?', options: ['yes', 'no'], defaultAnswer: 'no' }, { now: START, list: [a.decision] });
  assert.equal(b.decision.id, a.decision.id + 1);
  assert.equal(Q.createDecision({ question: 'x', options: ['a', 'b'] }, { now: START, list: [] }).error, 'badDefault');
  assert.equal(Q.createDecision({ question: 'x', options: ['a'], defaultAnswer: 'b' }, { now: START, list: [] }).error, 'badDefault');
  assert.equal(Q.createDecision({ question: ' ', options: ['a'], defaultAnswer: 'a' }, { now: START, list: [] }).error, 'badQuestion');
  assert.equal(Q.createDecision({ question: 'x', options: [], defaultAnswer: 'a' }, { now: START, list: [] }).error, 'badOptions');
  const client = Q.createDecision({ kind: 'clientScope', question: 'Invoices too?', defaultAnswer: 'yes' }, { now: START, list: [] });
  assert.equal(client.decision.defaultAnswer, null);
  assert.equal(client.decision.deadline, null);
  assert.deepEqual(client.decision.options, ['yes', 'no']);
  const short = Q.createDecision({ question: 'x', options: ['a'], defaultAnswer: 'a', deadlineMs: 5 }, { now: START, list: [] });
  assert.equal(short.decision.deadline, START + MINUTE);
});

test('answerDecision: only a known pending id and a listed option (or capped free text where allowed)', () => {
  const { decision } = Q.createDecision({ question: 'Add zod?', options: ['approve', 'reject'], defaultAnswer: 'approve' }, { now: START, list: [] });
  const list = [decision];
  const by = { by: 'mati', now: START + 1 };
  assert.equal(Q.answerDecision(list, { id: 42, answer: 'approve' }, by).error, 'unknownDecision');
  assert.equal(Q.answerDecision(list, { id: decision.id, answer: 'maybe' }, by).error, 'badAnswer');
  assert.equal(Q.answerDecision(list, { id: decision.id, answer: 'APPROVE' }, by).error, 'badAnswer');
  assert.equal(Q.answerDecision(list, { id: decision.id, answer: { x: 1 } }, by).error, 'badAnswer');
  assert.equal(Q.answerDecision(list, null, by).error, 'badAnswer');
  const ok = Q.answerDecision(list, { id: String(decision.id), answer: 'reject' }, by);
  assert.equal(ok.ok, true);
  assert.equal(ok.decision.answeredBy, 'mati');
  assert.equal(Q.answerDecision(ok.list, { id: decision.id, answer: 'approve' }, by).error, 'alreadyAnswered');

  const free = Q.createDecision({ kind: 'clientScope', question: 'Invoices?' }, { now: START, list: [] }).decision;
  const own = Q.answerDecision([free], { id: free.id, answer: '  only\nPDF  ' }, by);
  assert.equal(own.decision.answer, 'only PDF');
  assert.equal(Q.answerDecision([free], { id: free.id, answer: 'x'.repeat(Q.MAX_FREE_TEXT + 1) }, by).error, 'badAnswer');
  assert.equal(Q.answerDecision([free], { id: free.id, answer: '   ' }, by).error, 'badAnswer');
});

test('expireDue takes the default after the deadline; a client scope change stays pending forever', () => {
  const card = Q.createDecision({ question: 'Add zod?', options: ['approve', 'reject'], defaultAnswer: 'approve', cardIds: [7] }, { now: START, list: [] }).decision;
  const client = Q.createDecision({ kind: 'clientScope', question: 'Invoices?', cardIds: [8] }, { now: START, list: [card] }).decision;
  const list = [card, client];
  assert.equal(Q.expireDue(list, START + HOUR).answered.length, 0);
  assert.equal(Q.nextDeadline(list), START + 2 * HOUR);
  const later = Q.expireDue(list, START + 2 * HOUR);
  assert.deepEqual(later.answered.map((d) => [d.id, d.answer, d.answeredBy]), [[card.id, 'approve', 'default']]);
  const years = Q.expireDue(later.list, START + 365 * 24 * HOUR);
  assert.equal(years.answered.length, 0);
  assert.equal(years.list.find((d) => d.id === client.id).status, 'pending');
  assert.equal(Q.nextDeadline(years.list), null);
  assert.deepEqual([...Q.heldCards(years.list)], [8]);
});

test('heldCards: pending decisions hold their cards; reject / no hold them for good; approve releases', () => {
  const mk = (at, status, answer) => ({ id: at, cardIds: [at], status, answer });
  const held = Q.heldCards([mk(1, 'pending', null), mk(2, 'answered', 'approve'), mk(3, 'answered', 'reject'), mk(4, 'answered', 'no'), mk(5, 'answered', 'yes')]);
  assert.deepEqual([...held].sort(), [1, 3, 4]);
});

test('restoreQueue keeps well-formed decisions only, every pending one, and drops a non-client decision without a default', () => {
  const good = Q.createDecision({ question: 'Add zod?', options: ['approve', 'reject'], defaultAnswer: 'approve', cardIds: [3] }, { now: START, list: [] }).decision;
  const answered = { ...good, id: good.id + 1, status: 'answered', answer: 'reject', answeredBy: 'mati', answeredAt: START + 5 };
  const restored = Q.restoreQueue([
    good,
    answered,
    { ...good, id: good.id + 2, defaultAnswer: 'maybe' },
    { ...good, id: good.id + 3, status: 'answered', answer: 'hack', answeredBy: 'mati' },
    { ...good, id: -1 },
    { ...good, status: 'odd' },
    good,
    null,
  ]);
  assert.deepEqual(restored.map((d) => [d.id, d.status]), [[good.id, 'pending'], [answered.id, 'answered']]);
  assert.deepEqual(Q.restoreQueue('junk'), []);
});

test('decisionLine: "answered by Mati" or "default after deadline", one line', () => {
  const d = Q.createDecision({ kind: 'dependency', question: 'npm install "zod"\nnow', detail: 'new dependency: zod', options: ['approve', 'reject'], defaultAnswer: 'approve', cardIds: [9] }, { now: START, list: [] }).decision;
  const byDefault = Q.expireDue([d], START + 3 * HOUR).answered[0];
  const line = Q.decisionLine(byDefault);
  assert.match(line, /^- Decision queue, dependency: "npm install 'zod' now" \(new dependency: zod\) -> approve - default after deadline, \d{4}-\d\d-\d\d \d\d:\d\d UTC \[cards 9\]$/);
  const byMati = Q.answerDecision([d], { id: d.id, answer: 'reject' }, { by: 'mati', now: START + 1 }).decision;
  assert.match(Q.decisionLine(byMati), /-> reject - answered by Mati/);
  assert.equal(Q.decisionLine(d), null);
});

test('pack.appendDecisionEntry appends one line to design/DECISIONS.md and keeps what is there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-decisions-pack-'));
  assert.equal(pack.scaffoldPack(dir).ok, true);
  const before = fs.readFileSync(path.join(dir, 'design', 'DECISIONS.md'), 'utf8');
  assert.equal(pack.applyWrite(dir, pack.appendDecisionEntry('- Decision queue, migration: "x" -> approve - answered by Mati')).ok, true);
  assert.equal(pack.applyWrite(dir, pack.appendDecisionEntry('second\nline')).ok, true);
  const after = fs.readFileSync(path.join(dir, 'design', 'DECISIONS.md'), 'utf8');
  assert.ok(after.startsWith(before.trimEnd()));
  assert.match(after, /\n- Decision queue, migration: "x" -> approve - answered by Mati\n- second line\n$/);
  assert.equal(pack.appendDecisionEntry('   '), null);
});

// ---- the controller -----------------------------------------------------------------

const RUN_TAG = 'run:lwdec1';
const card = (at, text, extra = {}) => ({ at, text, done: false, tags: [RUN_TAG], size: 'S', ...extra });
const DEP_CARD = card(1, 'npm install zod for the quote form');
const UI_CARD = card(2, 'Bigger header font');

/**
 * A controller with fakes for every dep. The Director ignores holdCards on
 * purpose (the controller must hold the card itself too); `h.gates[n]`
 * pauses the Director of iteration n until released.
 */
function harness({ todos = [DEP_CARD, UI_CARD], stored = null } = {}) {
  const h = { clock: START, stored: stored ? clone(stored) : null, timers: [], todos: clone(todos), lines: [], builds: [], directorCalls: [], gates: {}, events: [] };
  const deps = {
    store: {
      load: () => (h.stored ? clone(h.stored) : null),
      save: (data) => {
        h.stored = data === null ? null : clone(data);
        return true;
      },
    },
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => (id === 'game' ? { id, repoPath: REPO } : null),
    profileFor: () => ({ adapter: 'web', startCommand: 'npm start', url: 'http://localhost:3000', readyTimeoutSec: 60, checkCommand: '' }),
    packStatus: () => ({ complete: true, missing: [] }),
    godModeActive: () => false,
    godModeCheckCommand: () => 'npm test',
    todoStore: () => ({
      read: () => h.todos,
      write: (list) => {
        h.todos = list;
        return true;
      },
    }),
    director: async (o) => {
      h.directorCalls.push({ iteration: o.iteration, holdCards: o.holdCards });
      if (h.gates[o.iteration]) await h.gates[o.iteration].promise;
      return { ok: true, cards: h.todos.filter((t) => !t.done), model: 'opus', modelReason: 'setting' };
    },
    build: async (o) => {
      h.builds.push(o.cards.map((c) => c.at));
      const ats = new Set(o.cards.map((c) => c.at));
      h.todos = h.todos.map((t) => (ats.has(t.at) ? { ...t, done: true } : t));
      return {
        ok: true,
        integration: { state: 'done', skipped: [], selfCheck: { tests: 'passed', fixups: 0 } },
        plan: { packages: [{ id: 'pk', merged: true, todos: o.cards.map((c) => c.text) }] },
      };
    },
    createAdapter: (name, o) => ({
      evidenceDir: path.join(EVIDENCE, `lunaswork-${o.runId}`, `iter-${o.iteration}`),
      start: async () => ({ url: 'http://localhost:3000' }),
      stop: async () => true,
      tools: () => ({}),
    }),
    playtest: async (o) => ({ ok: true, model: 'sonnet', report: { mode: o.mode, findings: [], scores: [], journeys: [], screens: [] } }),
    shipGate: () => ({ allPassed: false }),
    // A rising score: no PLATEAU while the test drives the run.
    critic: async (o) => ({ ok: true, verdict: 'continue', model: 'sonnet', milestone: { name: 'skeleton', passed: false, score: 10 + o.iteration }, next: 'skeleton' }),
    gitLog: async () => '',
    syncCheckout: async () => ({ ok: true }),
    recordDecision: (ctx) => {
      h.lines.push(ctx);
      return true;
    },
    newRunId: () => 'lwdec1',
    now: () => h.clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: h.clock + ms, cleared: false };
      h.timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    log: () => {},
  };
  h.ctl = createLunasWork(deps);
  h.ctl.subscribe((e) => h.events.push(e.type));
  h.pending = () => h.timers.filter((t) => !t.cleared);
  /** Fires the earliest pending timer at its time. */
  h.fire = () => {
    const [t] = h.pending().sort((a, b) => a.at - b.at);
    assert.ok(t, 'a timer is pending');
    t.cleared = true;
    h.clock = Math.max(h.clock, t.at);
    t.fn();
  };
  /** Ends the run: the gated Director of iteration n is released into a Stop. */
  h.stopAt = async (n) => {
    h.ctl.stop();
    h.gates[n].resolve();
    await until(() => !h.ctl.status().active, 'run stopped');
  };
  h.logText = () => h.ctl.runLog().map((e) => e.text || '').join('\n');
  return h;
}

test('run continues while a decision is pending: only its card is held, the other card is built', async () => {
  const h = harness();
  h.gates[2] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 2, 'iteration 2 started');

  // Iteration 1 built the UI card; the dependency card waits for Mati.
  assert.deepEqual(h.builds, [[2]]);
  const pending = h.ctl.status().pendingDecisions;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'dependency');
  assert.equal(pending[0].question, DEP_CARD.text);
  assert.deepEqual(pending[0].cardIds, [1]);
  assert.equal(pending[0].defaultAnswer, 'approve');
  assert.equal(pending[0].deadline, START + 2 * HOUR);
  assert.equal(pending[0].runId, 'lwdec1');
  assert.equal(pending[0].repoName, path.basename(REPO));
  // Persisted with the run, and the Director is told to leave the card out.
  assert.equal(h.stored.decisions.length, 1);
  assert.equal(h.stored.decisions[0].status, 'pending');
  assert.deepEqual(h.directorCalls[1].holdCards, [1]);
  assert.ok(h.events.includes('decision'));
  assert.equal(h.ctl.status().active, true);

  // Iteration 2 (Director ignores the hold): still not built.
  h.gates[3] = deferred();
  h.gates[2].resolve();
  await until(() => h.directorCalls.length === 3, 'iteration 3 started');
  assert.deepEqual(h.builds, [[2]]);
  assert.equal(h.ctl.status().pendingDecisions.length, 1);
  await h.stopAt(3);
  assert.deepEqual(h.ctl.status().pendingDecisions, []);
  assert.equal(h.pending().length, 0, 'decision timer cleared at the end of the run');
});

test('deadline passes with no reply: the safe default is taken, logged in DECISIONS.md, and the card is built', async () => {
  const h = harness();
  h.gates[2] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 2);
  const [timer] = h.pending();
  assert.equal(timer.at, START + 2 * HOUR);

  h.fire();
  assert.deepEqual(h.ctl.status().pendingDecisions, []);
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].repoPath, REPO);
  assert.match(h.lines[0].line, /^- Decision queue, dependency: "npm install zod for the quote form" .*-> approve - default after deadline/);
  assert.equal(h.stored.decisions[0].answeredBy, 'default');
  assert.match(h.logText(), /default after deadline/);

  h.gates[3] = deferred();
  h.gates[2].resolve();
  await until(() => h.directorCalls.length === 3);
  assert.deepEqual(h.builds, [[2], [1]]);
  // An answered card is never asked about again.
  assert.equal(h.stored.decisions.length, 1);
  await h.stopAt(3);
});

test("Mati's answer: 'answered by Mati' in DECISIONS.md; a rejected card stays held for good", async () => {
  const h = harness();
  h.gates[2] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 2);
  const [d] = h.ctl.status().pendingDecisions;
  const res = h.ctl.answer({ id: d.id, answer: 'reject', runId: 'lwdec1' });
  assert.equal(res.ok, true);
  assert.match(h.lines[0].line, /-> reject - answered by Mati/);
  assert.equal(h.pending().length, 0, 'no deadline left to wait for');

  h.gates[3] = deferred();
  h.gates[2].resolve();
  await until(() => h.directorCalls.length === 3);
  assert.deepEqual(h.builds, [[2]]);
  assert.deepEqual(h.directorCalls[2].holdCards, [1]);
  await h.stopAt(3);
});

test('a client scope change never auto-defaults: it waits for Mati while the rest of the run continues', async () => {
  const h = harness({ todos: [card(5, 'PDF export for the client'), UI_CARD, card(6, 'Totals row')] });
  h.gates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 1);
  const asked = h.ctl.ask({ kind: 'clientScope', question: 'The client asks for a PDF export', defaultAnswer: 'yes', cardIds: [5] });
  assert.equal(asked.ok, true);
  assert.equal(h.pending().length, 0, 'no deadline timer for a client scope change');
  const [d] = h.ctl.status().pendingDecisions;
  assert.equal(d.defaultAnswer, null);
  assert.equal(d.deadline, null);
  assert.equal(d.freeText, true);

  // A month later, two iterations on: still pending, card 5 never built, the others are.
  h.clock += 30 * 24 * HOUR;
  h.gates[2] = deferred();
  h.gates[1].resolve();
  await until(() => h.directorCalls.length === 2);
  assert.deepEqual(h.builds, [[2, 6]]);
  assert.equal(h.ctl.status().pendingDecisions.length, 1);
  assert.equal(h.lines.length, 0);

  // Mati answers with his own words; the card is released.
  assert.equal(h.ctl.answer({ id: d.id, answer: 'Yes, but only for quotes' }).ok, true);
  assert.match(h.lines[0].line, /-> Yes, but only for quotes - answered by Mati/);
  h.gates[3] = deferred();
  h.gates[2].resolve();
  await until(() => h.directorCalls.length === 3);
  assert.deepEqual(h.builds, [[2, 6], [5]]);
  await h.stopAt(3);
});

test('invalid answers are rejected: unknown id, another run, unlisted option, free text where none is allowed', async () => {
  const h = harness();
  h.gates[2] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 2);
  const [d] = h.ctl.status().pendingDecisions;

  assert.equal(h.ctl.answer({ id: 12345, answer: 'approve' }).reason, 'unknownDecision');
  assert.equal(h.ctl.answer({ id: d.id, answer: 'approve', runId: 'lwother' }).reason, 'unknownDecision');
  assert.equal(h.ctl.answer({ id: d.id, answer: 'sure, why not' }).reason, 'badAnswer');
  assert.equal(h.ctl.answer({ id: d.id, answer: 'x'.repeat(5000) }).reason, 'badAnswer');
  assert.equal(h.ctl.answer('approve').reason, 'unknownDecision');
  assert.equal(h.ctl.answer({ id: d.id }).reason, 'badAnswer');
  assert.equal(h.ctl.status().pendingDecisions.length, 1);
  assert.equal(h.lines.length, 0);

  // From the phone: other runs and unknown ids are skipped, a bad option refused and logged.
  const applied = h.ctl.applyAnswers([
    { id: d.id, runId: 'lwother', answer: 'reject' },
    { id: 999, runId: 'lwdec1', answer: 'reject' },
    { id: d.id, runId: 'lwdec1', answer: 'drop the table' },
    'junk',
  ]);
  assert.equal(applied, 0);
  assert.match(h.logText(), /answer from the phone refused \(badAnswer\)/);
  assert.equal(h.ctl.applyAnswers([{ id: d.id, runId: 'lwdec1', answer: 'reject' }]), 1);
  assert.equal(h.ctl.answer({ id: d.id, answer: 'approve' }).reason, 'alreadyAnswered');
  // A replayed phone answer is skipped quietly.
  assert.equal(h.ctl.applyAnswers([{ id: d.id, runId: 'lwdec1', answer: 'approve' }]), 0);
  assert.equal(h.lines.length, 1);
  await h.stopAt(2);
  assert.equal(h.ctl.answer({ id: d.id, answer: 'approve' }).reason, 'no-run');
  assert.equal(h.ctl.ask({ question: 'late?', options: ['a'], defaultAnswer: 'a' }).reason, 'no-run');
});

test("Mati's steer cards never go through the queue", async () => {
  const h = harness({ todos: [card(3, 'npm install stripe for payments', { tags: ['steer'] })] });
  h.gates[2] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 2);
  assert.deepEqual(h.builds, [[3]]);
  assert.deepEqual(h.ctl.status().pendingDecisions, []);
  await h.stopAt(2);
});

test('a pending decision survives a restart; a deadline that passed meanwhile takes its default at resume', async () => {
  const first = harness();
  first.gates[2] = deferred();
  await first.ctl.start({ projectId: 'game' });
  await until(() => first.directorCalls.length === 2);
  const saved = clone(first.stored);
  assert.equal(restoreRun(saved).decisions[0].status, 'pending');

  // The PC was off for three hours; the run resumes at 'directing'.
  const second = harness({ stored: { ...saved, phase: 'directing' } });
  second.clock = START + 3 * HOUR;
  second.gates[2] = deferred();
  second.todos = clone(first.todos);
  assert.equal(second.ctl.resume(), true);
  await until(() => second.directorCalls.length === 1);
  assert.match(second.lines[0].line, /default after deadline/);
  second.gates[3] = deferred();
  second.gates[2].resolve();
  await until(() => second.directorCalls.length === 2);
  assert.deepEqual(second.builds, [[1]]);
  await second.stopAt(3);
  first.ctl.dispose();
});

// ---- the Director ---------------------------------------------------------------------

test('runDirector leaves held cards out of what it schedules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-decisions-director-'));
  assert.equal(pack.scaffoldPack(dir).ok, true);
  const list = [card(1, 'Held card', { tags: ['run:amsteel-1'] })];
  const calls = [];
  const res = await runDirector({
    repoDir: dir,
    runId: 'amsteel-1',
    iteration: 2,
    todoStore: { read: () => list },
    holdCards: [1],
    runClaude: async (c) => {
      calls.push(c);
      return { stdout: '{}' };
    },
    log: () => {},
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.cardIds, []);
  assert.equal(calls.length, 0, 'nothing left to choose from: no model call');
});

// ---- HUD + phone ----------------------------------------------------------------------

const pendingFixture = () =>
  Q.publicDecisions([
    { ...Q.createDecision({ kind: 'migration', question: 'Add margin column', options: ['approve', 'reject'], defaultAnswer: 'approve', cardIds: [4] }, { now: START, list: [] }).decision, runId: 'lwdec1', repoName: 'quote' },
  ]);

test('HUD status: pendingDecisions count plus the cleaned list; the old integer form still works', () => {
  const list = [...pendingFixture(), { id: 'nope', question: 'x', options: ['a'] }, { id: START + 9, question: '', options: ['a'] }];
  const out = publicStatus({ runId: 'lwdec1', active: true, phase: 'building', pendingDecisions: list }, () => true);
  assert.equal(out.pendingDecisions, 1);
  assert.equal(out.decisions[0].question, 'Add margin column');
  assert.equal(out.decisions[0].defaultAnswer, 'approve');
  const legacy = publicStatus({ runId: 'lwdec1', pendingDecisions: 3 }, () => true);
  assert.equal(legacy.pendingDecisions, 3);
  assert.equal('decisions' in legacy, false);
});

test('phone snapshot: decisions ride in the godmode row and are cleaned again on the reader side', () => {
  const snap = withLive(null, { live: null, tabs: [], decisions: pendingFixture() }, { machine: 'PC-1', now: START });
  assert.equal(snap.decisions.length, 1);
  const hostile = { ...snap, decisions: [...snap.decisions, { id: START + 50, runId: '../x', question: 'q', options: ['a'] }, { id: 'x' }] };
  const parsed = parseGodmodePeer({ machine: 'PC-1', data: hostile }, START);
  assert.deepEqual(parsed.decisions.map((d) => d.id), [snap.decisions[0].id]);
  const rows = [
    { machine: 'PC-1', data: snap },
    { machine: 'PC-2', data: withLive(null, {}, { machine: 'PC-2', now: START + 1000 }) },
  ];
  const shown = decisionsFrom(rows, START + 2000);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].machine, 'PC-1');
  assert.equal(shown[0].stale, false);
  // No decisions key at all when nothing waits (older readers see the same row).
  assert.equal('decisions' in withLive(null, {}, { machine: 'PC-1', now: START }), false);
});

test('phone round trip: the answer unit goes through the todos mirror and back to the controller', async () => {
  const [d] = pendingFixture();
  assert.equal(Q.answerUnit(d, 'maybe'), null, 'the phone never sends an unlisted option');
  assert.equal(Q.answerUnit({ ...d, runId: null }, 'approve'), null);
  const unit = Q.answerUnit(d, 'reject', START + 5);
  assert.equal(unit.k, `lunaswork-answer:${d.id}`);
  assert.deepEqual(unit.v, { runId: 'lwdec1', answer: 'reject' });

  // The server row as the PC pulls it, plus a to-do of a real project next to it.
  const state = applyRows({ cursor: 0, mirror: {}, pushed: {} }, [
    { key: unit.k, value: unit.v, u: unit.u, deleted_at: null, rev: 1, machine: 'iPhone' },
    { key: 'git:github.com/a/b:111', value: { text: 'todo', done: false }, u: START, deleted_at: null, rev: 2, machine: 'iPhone' },
  ], START + 10);
  const answers = Q.answersFromTodoPeers([todoPeer(state.mirror)]);
  assert.deepEqual(answers.map((a) => [a.id, a.runId, a.answer]), [[d.id, 'lwdec1', 'reject']]);
  assert.deepEqual(Q.answersFromTodoPeers(null), []);
  assert.deepEqual(Q.answersFromTodoPeers([{ 'lunaswork-answer': { items: [{ at: 'x', runId: 'lwdec1', answer: 'a' }, { at: 5, runId: 'BAD!', answer: 'a' }] } }]), []);

  // wireDecisionSync: publish on change only, and apply the answers after a todos pull.
  const puts = [];
  const pulled = [];
  let listener = null;
  const applied = [];
  const controller = {
    subscribe: (fn) => {
      listener = fn;
    },
    status: () => ({ pendingDecisions: [d] }),
    applyAnswers: (list) => {
      applied.push(list);
      return list.length;
    },
  };
  const cloud = { onPulled: (fn) => pulled.push(fn), hooks: () => ({ extraPeers: () => [todoPeer(state.mirror)] }) };
  const wired = wireDecisionSync({ controller, cloud, putDecisions: (list) => puts.push(list) });
  listener({ type: 'decision', status: { pendingDecisions: [d] } });
  listener({ type: 'phase', status: { pendingDecisions: [d] } });
  listener({ type: 'phase', status: { pendingDecisions: [] } });
  assert.equal(puts.length, 2, 'unchanged lists are not put again');
  assert.deepEqual(puts[1], []);
  pulled[0]('life');
  assert.equal(applied.length, 0);
  pulled[0]('todos');
  assert.equal(applied.length, 1);
  assert.equal(wired.pullAnswers(), 1);
  assert.equal(wireDecisionSync({ controller, cloud: null, putDecisions: () => {} }).pullAnswers(), 0);
});

test('wireDecisionSync: the phone snapshot goes out throttled on phase changes (LW 2.17b)', () => {
  let listener = null;
  let t = 0;
  const timers = [];
  const puts = [];
  let phase = 'directing';
  const controller = {
    subscribe: (fn) => {
      listener = fn;
    },
    status: () => ({ pendingDecisions: [] }),
    applyAnswers: () => 0,
    phoneSnapshot: () => ({ v: 1, runId: 'lw1', phase }),
  };
  wireDecisionSync({
    controller,
    cloud: null,
    putDecisions: () => {},
    putLunasWork: (s) => puts.push(s),
    throttle: { minMs: 1000, now: () => t, setTimer: (fn, ms) => timers.push({ fn, at: t + ms }), clearTimer: () => {} },
  });
  listener({ type: 'phase', status: {} });
  assert.deepEqual(puts.map((s) => s.phase), ['directing']);
  t = 10;
  phase = 'building';
  listener({ type: 'phase', status: {} });
  listener({ type: 'resume', status: {} });
  assert.equal(puts.length, 1, 'a second phase change inside the window waits');
  assert.equal(timers.length, 1);
  t = 1000;
  timers[0].fn();
  assert.deepEqual(puts.map((s) => s.phase), ['directing', 'building']);
  // Without putLunasWork (or a controller without phoneSnapshot) nothing is built.
  const bare = { ...controller, phoneSnapshot: () => assert.fail('not built') };
  wireDecisionSync({ controller: bare, cloud: null, putDecisions: () => {} });
  listener({ type: 'phase', status: {} });
});
