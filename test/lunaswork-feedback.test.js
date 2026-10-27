// ============================================================================
// Luna's Work mid-run feedback (src/lunasworkFeedback.js, B17) and its wiring
// in the run controller (src/lunaswork.js): feedback never pauses the run,
// free text is triaged into one card per part, look / bug cards go in
// straight away and are scheduled first, scope changes go through the
// decision queue (a client's with no default, while the run goes on), each
// item's status moves planned -> built -> verified, and it all reaches the
// phone snapshot and the milestone email.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const F = require('../src/lunasworkFeedback');
const { createLunasWork, restoreRun } = require('../src/lunaswork');
const { schedulable, validateDirection } = require('../src/lunasworkDirector');
const { orderCards } = require('../src/lunasworkRules');
const { normalizeTodos } = require('../src/todorows');
const { withLive, feedbackFrom, parseGodmodePeer } = require('../src/godmodesnapshot');
const { todoPeer, applyRows } = require('../src/cloudrows');
const { wireDecisionSync } = require('../src/lunasworkWiring');
const { buildRunEmail, buildMilestoneEmail, createLunasWorkReporter } = require('../src/lunasworkReport');

const REPO = path.resolve(os.tmpdir(), 'lw-feedback-repo');
const EVIDENCE = path.resolve(os.tmpdir(), 'lw-feedback-runs');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const START = 1_700_000_000_000;
const RUN_ID = 'lwfb1';
const RUN_TAG = `run:${RUN_ID}`;
const BRIEF_EXAMPLE = 'Looks good, but the header is too big and the PDF export is missing';

const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setImmediate(r));

async function until(cond, what = 'condition reached') {
  for (let i = 0; i < 300 && !cond(); i += 1) await tick();
  assert.ok(cond(), what);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---- triage ---------------------------------------------------------------------------

test('triage split: the brief example becomes a look card and a scope card; praise is dropped', () => {
  assert.deepEqual(F.triageText(BRIEF_EXAMPLE), [
    { type: 'look', text: 'the header is too big' },
    { type: 'scope', text: 'the PDF export is missing' },
  ]);
  assert.deepEqual(F.triageText('header too big, PDF export missing').map((p) => p.type), ['look', 'scope']);
  assert.deepEqual(F.triageText('Thanks! Love it.'), []);
  assert.deepEqual(F.triageText('the login button crashes the app; please add dark mode'), [
    { type: 'bug', text: 'the login button crashes the app' },
    { type: 'scope', text: 'please add dark mode' },
  ]);
  // Polish works too.
  assert.deepEqual(F.triageText('naglowek za duzy, brakuje eksportu PDF').map((p) => p.type), ['look', 'scope']);
});

test('triage split: short pieces stay together, and long text is capped at 8 parts', () => {
  assert.deepEqual(F.triageText('header and footer are too big'), [{ type: 'look', text: 'header and footer are too big' }]);
  assert.deepEqual(F.triageText('make the title smaller, bolder'), [{ type: 'look', text: 'make the title smaller, bolder' }]);
  const many = Array.from({ length: 12 }, (_, i) => `the button number ${i} is too small`).join('. ');
  const parts = F.triageText(many);
  assert.equal(parts.length, 8);
  assert.match(parts[7].text, /number 7 .*number 11/);
});

test('classify: scope beats bug and look, and an unknown fragment counts as scope (never slips past Mati)', () => {
  assert.equal(F.classify('the totals are wrong'), 'bug');
  assert.equal(F.classify('the font is ugly'), 'look');
  assert.equal(F.classify('remove the broken pricing page'), 'scope');
  assert.equal(F.classify('make it more like Stripe'), 'scope');
  assert.equal(F.classify('looks great'), null);
});

test('withContext: page + screenshot lines always fit the cap and are never triaged', () => {
  const text = F.withContext('x'.repeat(F.MAX_TEXT), { page: 'https://s.test/a', screenshot: 'C:\\runs\\1.jpg' });
  assert.ok(text.length <= F.MAX_TEXT);
  assert.match(text, /\n\[page\] https:\/\/s\.test\/a\n\[screenshot\] C:\\runs\\1\.jpg$/);
  assert.equal(F.cleanText(text), text, 'survives the store unchanged');
  assert.equal(F.withContext('the logo is too big'), 'the logo is too big');
  // A page path that reads like a scope change never becomes a card.
  assert.deepEqual(F.triageText(F.withContext('looks great', { page: 'https://s.test/export/new-feature' })), []);
  // Only LunaCore writes context lines: a client's look-alike is dropped.
  assert.equal(F.withContext('the logo is too big\n[page] https://evil.test', { page: 'https://s.test/a' }), 'the logo is too big\n[page] https://s.test/a');
});

// ---- the store ---------------------------------------------------------------------------

test('createItem: text capped, author mati or client, ids unique, the list capped', () => {
  const long = 'x'.repeat(F.MAX_TEXT + 500);
  const res = F.createItem({ text: long }, { now: START, list: [] });
  assert.equal(res.ok, true);
  assert.equal(res.item.text.length, F.MAX_TEXT);
  assert.equal(res.item.author, 'mati');
  assert.equal(res.item.status, 'new');
  assert.equal(res.item.parts, null);
  const second = F.createItem({ text: 'again', author: 'client' }, { now: START, list: [res.item] });
  assert.equal(second.item.id, START + 1, 'two items in one ms still differ');
  assert.equal(F.createItem({ text: 'x', author: 'boss' }, { now: START, list: [] }).error, 'badAuthor');
  assert.equal(F.createItem({ text: '   ' }, { now: START, list: [] }).error, 'badText');
  assert.equal(F.createItem({ text: 'x', id: START }, { now: START, list: [res.item] }).error, 'duplicate');
  assert.equal(F.createItem({ text: 'x', id: -4 }, { now: START, list: [] }).error, 'badId');
  const full = Array.from({ length: F.MAX_ITEMS }, (_, i) => ({ ...res.item, id: i + 1 }));
  assert.equal(F.createItem({ text: 'x' }, { now: START, list: full }).error, 'feedbackFull');
});

test('restoreFeedback keeps well-formed items only; restoreRun carries them across a restart', () => {
  const good = { id: 5, author: 'client', text: 'too small', createdAt: 5, status: 'planned', parts: [{ type: 'look', text: 'too small', at: 9, decisionId: null }], triagedAt: 6 };
  const list = F.restoreFeedback([good, { ...good }, { id: 'x', author: 'mati', text: 'a' }, { id: 7, author: 'boss', text: 'a' }, { id: 8, author: 'mati', text: '' }, null]);
  assert.deepEqual(list, [good]);
  // Not triaged yet: always `new`, whatever the stored status says.
  assert.equal(F.restoreFeedback([{ ...good, parts: undefined }])[0].status, 'new');
  const run = restoreRun({ id: RUN_ID, projectId: 'game', repoPath: REPO, phase: 'directing', iteration: 1, feedback: [good] });
  assert.deepEqual(run.feedback, [good]);
  assert.deepEqual(restoreRun({ id: RUN_ID, projectId: 'game', repoPath: REPO, phase: 'directing', iteration: 1 }).feedback, []);
});

// ---- status ------------------------------------------------------------------------------

const item = (parts) => ({ id: 1, author: 'mati', text: 't', createdAt: 1, status: 'new', parts, triagedAt: 1 });

test('status transitions: new -> planned -> built -> verified, the least advanced part decides', () => {
  const parts = [{ type: 'look', text: 'a', at: 10, decisionId: null }, { type: 'bug', text: 'b', at: 11, decisionId: null }];
  assert.equal(F.itemStatus(item(null), {}), 'new');
  assert.equal(F.itemStatus(item([]), {}), 'noted');
  assert.equal(F.itemStatus(item(parts), { cards: new Map([[10, 'open'], [11, 'open']]) }), 'planned');
  assert.equal(F.itemStatus(item(parts), { cards: new Map([[10, 'built'], [11, 'open']]) }), 'planned');
  assert.equal(F.itemStatus(item(parts), { cards: new Map([[10, 'built'], [11, 'built']]) }), 'built');
  assert.equal(F.itemStatus(item(parts), { cards: new Map([[10, 'done'], [11, 'built']]) }), 'built');
  assert.equal(F.itemStatus(item(parts), { cards: new Map([[10, 'done'], [11, 'done']]) }), 'verified');
  // A reopened card takes the item back: the status is honest, not monotonic.
  assert.equal(F.itemStatus(item(parts), { cards: new Map([[10, 'done'], [11, 'open']]) }), 'planned');
  const res = F.withStatuses([item(parts)], { cards: new Map([[10, 'done'], [11, 'done']]) });
  assert.deepEqual(res.changed.map((i) => i.status), ['verified']);
  assert.equal(F.withStatuses(res.list, { cards: new Map([[10, 'done'], [11, 'done']]) }).changed.length, 0);
});

test('status transitions: a scope part waits for its decision, then plans or is declined', () => {
  const scope = [{ type: 'scope', text: 'PDF export', at: 12, decisionId: 99 }];
  const cards = new Map([[12, 'open']]);
  const decision = (status, answer = null) => [{ id: 99, status, answer }];
  assert.equal(F.itemStatus(item(scope), { cards, decisions: decision('pending') }), 'waiting');
  assert.equal(F.itemStatus(item(scope), { cards, decisions: decision('answered', 'yes') }), 'planned');
  assert.equal(F.itemStatus(item(scope), { cards, decisions: decision('answered', 'approve') }), 'planned');
  assert.equal(F.itemStatus(item(scope), { cards, decisions: decision('answered', 'no') }), 'declined');
  assert.equal(F.itemStatus(item(scope), { cards, decisions: decision('answered', 'reject') }), 'declined');
  // Declined parts do not hold the rest of the item back.
  const mixed = [...scope, { type: 'look', text: 'a', at: 10, decisionId: null }];
  assert.equal(F.itemStatus(item(mixed), { cards: new Map([[10, 'done'], [12, 'open']]), decisions: decision('answered', 'no') }), 'verified');
  // Not asked yet (queue was full): waiting, and held.
  const unasked = [{ type: 'scope', text: 'x', at: 13, decisionId: null }];
  assert.equal(F.itemStatus(item(unasked), { cards: new Map([[13, 'open']]), decisions: [] }), 'waiting');
  assert.deepEqual(F.unaskedScopeCards([item(unasked)]), [13]);
});

// ---- trust ---------------------------------------------------------------------------------

test("trust: Mati's scope change defaults to approve; a client's waits for Mati with no default", () => {
  const part = { type: 'scope', text: 'PDF export' };
  const mati = F.scopeDecision(part, { id: 1, author: 'mati' }, 7);
  assert.equal(mati.kind, 'feedbackScope');
  assert.equal(mati.defaultAnswer, 'approve');
  assert.deepEqual(mati.cardIds, [7]);
  const client = F.scopeDecision(part, { id: 1, author: 'client' }, 7);
  assert.equal(client.kind, 'clientScope');
  assert.equal(client.defaultAnswer, undefined);
  // The cards carry who they came from: Mati's feedback cards never go through needsDecision.
  assert.ok(F.cardFor({ type: 'look', text: 'a' }, { id: 1, author: 'mati', text: 'a' }).extraTags.includes('from:mati'));
  assert.ok(F.cardFor({ type: 'bug', text: 'a' }, { id: 1, author: 'client', text: 'a' }).extraTags.includes('from:client'));
  assert.equal(F.cardFor({ type: 'bug', text: 'a' }, { id: 1, author: 'client', text: 'a' }).kind, 'bug');
});

// ---- scheduled first ------------------------------------------------------------------------

test('look / bug feedback is scheduled first: right after steer cards, before a blocker bug', () => {
  const cards = normalizeTodos([
    { at: 1, text: 'Blocker bug', done: false, tags: [RUN_TAG, 'kind:bug', 'sev:blocker'] },
    { at: 2, text: 'Header too big', done: false, tags: [RUN_TAG, 'kind:feel', 'sev:medium', 'feedback', 'from:client'] },
    { at: 3, text: 'Mati steer', done: false, tags: ['steer'] },
    { at: 4, text: 'Totals row', done: false, tags: [RUN_TAG, 'kind:missing', 'sev:low'] },
  ]);
  const { cards: offer } = schedulable(cards, RUN_TAG);
  assert.deepEqual(orderCards(offer).map((c) => c.at), [3, 2, 1, 4]);
  // The model leaves the feedback card out and puts a blocker first: it is put back, after steer.
  const res = validateDirection({ cardIds: [1, 4] }, { cards: offer, limit: 3 });
  assert.deepEqual(res.cards.map((c) => c.at), [3, 2, 1]);
  assert.deepEqual(res.warnings, [{ code: 'tooManyCards', dropped: 1 }]);
});

// ---- the controller ---------------------------------------------------------------------------

const existing = (at, text, tags = ['kind:bug', 'sev:blocker']) => ({ at, text, done: false, tags: [RUN_TAG, ...tags], size: 'S' });

/**
 * A controller with fakes for every dep. The Director orders the open cards
 * with the real rules and ignores holdCards (the controller must hold them
 * itself); `h.gates[n]` pauses the Director of iteration n, `h.buildGates[n]`
 * the build. The Playtester confirms every acceptance check it is given.
 */
function harness({ todos = [existing(1, 'Totals are wrong')], milestonePassAt = null, onMilestone, widget } = {}) {
  const h = { clock: START, stored: null, timers: [], todos: clone(todos), lines: [], builds: [], directorCalls: [], gates: {}, buildGates: {}, events: [], milestones: [] };
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
        h.todos = clone(list);
        return true;
      },
      now: () => h.clock,
    }),
    director: async (o) => {
      h.directorCalls.push({ iteration: o.iteration, holdCards: o.holdCards });
      if (h.gates[o.iteration]) await h.gates[o.iteration].promise;
      const { cards } = schedulable(normalizeTodos(h.todos), RUN_TAG, o.failCounts);
      return { ok: true, cards: orderCards(cards, { limit: 10 }), model: 'opus', modelReason: 'setting' };
    },
    build: async (o) => {
      h.builds.push(o.cards.map((c) => c.at));
      if (h.buildGates[o.iteration]) await h.buildGates[o.iteration].promise;
      const ats = new Set(o.cards.map((c) => c.at));
      h.todos = h.todos.map((t) => (ats.has(t.at) ? { ...t, done: true } : t));
      return {
        ok: true,
        integration: { state: 'done', skipped: [], selfCheck: { tests: 'passed', fixups: 0 } },
        plan: { packages: [{ id: 'pk', merged: true, todos: o.cards.map((c) => c.text), touched: ['test/app.test.js'] }] },
      };
    },
    createAdapter: (name, o) => ({
      evidenceDir: path.join(EVIDENCE, `lunaswork-${o.runId}`, `iter-${o.iteration}`),
      start: async () => ({ url: 'http://localhost:3000' }),
      stop: async () => true,
      tools: () => ({}),
    }),
    // Every acceptance check of every built card passes.
    playtest: async (o) => ({
      ok: true,
      model: 'sonnet',
      report: {
        mode: o.mode,
        findings: [],
        scores: [],
        journeys: [],
        screens: [],
        checks: (o.checks || []).flatMap((c) => c.checks.map((_, i) => ({ card: c.card, check: i, passed: true, evidence: { screenshot: 'a.png', steps: ['look'] } }))),
      },
    }),
    shipGate: () => ({ allPassed: false }),
    critic: async (o) => ({
      ok: true,
      verdict: 'continue',
      model: 'sonnet',
      milestone: { name: 'skeleton', passed: o.iteration === milestonePassAt, score: 10 + o.iteration },
      next: o.iteration === milestonePassAt ? 'polish' : 'skeleton',
    }),
    gitLog: async () => '',
    syncCheckout: async () => ({ ok: true }),
    recordDecision: (ctx) => {
      h.lines.push(ctx);
      return true;
    },
    onMilestone: (run, ctx) => {
      h.milestones.push({ run, ctx });
      if (onMilestone) onMilestone(run, ctx);
    },
    ...(widget ? { widget } : {}),
    newRunId: () => RUN_ID,
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
  h.fire = () => {
    const [t] = h.pending().sort((a, b) => a.at - b.at);
    assert.ok(t, 'a timer is pending');
    t.cleared = true;
    h.clock = Math.max(h.clock, t.at);
    t.fn();
  };
  /** Lets iteration n start: releases the gated Director of iteration n - 1 and gates iteration n. */
  h.next = async (n) => {
    h.gates[n] = deferred();
    h.gates[n - 1].resolve();
    await until(() => h.directorCalls.length === n, `iteration ${n} started`);
  };
  h.stopAt = async (n) => {
    h.ctl.stop();
    h.gates[n].resolve();
    await until(() => !h.ctl.status().active, 'run stopped');
  };
  h.card = (text) => h.todos.find((t) => t.text === text);
  h.items = () => h.ctl.status().feedback.items;
  return h;
}

test('feedback never pauses the run: it is stored mid-build and planned in at the next iteration, look first', async () => {
  const h = harness();
  h.gates[1] = deferred();
  h.buildGates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  h.gates[1].resolve();
  await until(() => h.builds.length === 1, 'iteration 1 building');

  // Mid-build: accepted at once, nothing waits, the phase does not change.
  const res = h.ctl.feedback({ text: BRIEF_EXAMPLE });
  assert.equal(res.ok, true);
  const s = h.ctl.status();
  assert.equal(s.phase, 'building');
  assert.equal(s.waitUntil, null);
  assert.equal(s.feedback.items[0].status, 'new');
  assert.equal(h.stored.feedback.length, 1, 'saved with the run');
  assert.ok(h.events.includes('feedback'));

  h.gates[2] = deferred();
  h.buildGates[1].resolve();
  await until(() => h.directorCalls.length === 2, 'iteration 2 started');
  assert.deepEqual(h.builds, [[1]], 'iteration 1 built only what it had');

  // Iteration 2: triaged into 2 cards; the look card is built first, the scope card waits.
  const look = h.card('The header is too big');
  const scope = h.card('The PDF export is missing');
  assert.ok(look && scope, 'one card per part');
  assert.ok(look.tags.includes('feedback') && look.tags.includes('from:mati') && look.tags.includes('kind:feel'));
  assert.ok(scope.tags.includes('kind:missing'));
  const [d] = h.ctl.status().pendingDecisions;
  assert.equal(d.kind, 'feedbackScope');
  assert.equal(d.defaultAnswer, 'approve');
  assert.deepEqual(d.cardIds, [scope.at]);
  assert.deepEqual(h.items().map((i) => i.status), ['waiting']);
  assert.equal(h.items()[0].cards, 2);

  await h.next(3);
  assert.deepEqual(h.builds[1], [look.at], 'the look card went straight in; the scope card is held');
  assert.equal(h.ctl.status().active, true);
  await h.stopAt(3);
});

test('a feedback look card is built before an open blocker bug of the run', async () => {
  const h = harness({ todos: [existing(1, 'Totals are wrong'), existing(2, 'Another bug')] });
  h.gates[1] = deferred();
  h.buildGates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  h.gates[1].resolve();
  await until(() => h.builds.length === 1);
  h.ctl.feedback({ author: 'client', text: 'the logo is too dark' });
  h.gates[2] = deferred();
  h.buildGates[1].resolve();
  await until(() => h.directorCalls.length === 2);
  // Triage ran before the Director; a fresh blocker bug competes with the feedback card.
  h.todos = [...h.todos, existing(3, 'Checkout crashes')];
  await h.next(3);
  const look = h.card('The logo is too dark');
  assert.deepEqual(h.builds[1], [look.at, 3], 'feedback first, ahead of the kind:bug sev:blocker card');
  await h.stopAt(3);
});

test("Mati's scope change goes through the queue with approve as default; status walks to verified", async () => {
  const h = harness({ todos: [] });
  h.gates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 1);
  h.ctl.feedback({ text: 'please add a CSV export' });

  await h.next(2);
  const scope = h.card('Please add a CSV export');
  assert.deepEqual(h.builds, [], 'held while its decision is pending');
  assert.deepEqual(h.items().map((i) => i.status), ['waiting']);
  assert.equal(h.pending().length, 1, 'a deadline timer for the default');

  // No reply by the deadline: the default (approve) is taken and recorded.
  h.fire();
  assert.match(h.lines[0].line, /feedbackScope: .*CSV export.* -> approve - default after deadline/);
  assert.deepEqual(h.items().map((i) => i.status), ['planned']);

  await h.next(3);
  assert.deepEqual(h.builds, [[scope.at]]);
  // Built in iteration 2, confirmed by the Playtester in the same lap's pass.
  assert.equal(h.card('Please add a CSV export').done, true);
  assert.deepEqual(h.items().map((i) => i.status), ['verified']);
  await h.stopAt(3);
});

test('client: look / bug cards go in directly; a scope change waits with no default while the run continues', async () => {
  const h = harness({ todos: [existing(1, 'Totals are wrong')] });
  h.gates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 1);
  const res = h.ctl.feedback({ author: 'client', text: 'the save button is too small, please add a PDF export' });
  assert.equal(res.ok, true);

  await h.next(2);
  const look = h.card('The save button is too small');
  const scope = h.card('Please add a PDF export');
  assert.ok(look.tags.includes('from:client'));
  const [d] = h.ctl.status().pendingDecisions;
  assert.equal(d.kind, 'clientScope');
  assert.equal(d.defaultAnswer, null);
  assert.equal(d.deadline, null);
  assert.equal(h.pending().length, 0, 'no deadline timer: it never defaults');

  // A month later, two iterations on: still pending, never built; the rest of the run went on.
  h.clock += 30 * 24 * HOUR;
  await h.next(3);
  await h.next(4);
  assert.deepEqual(h.builds.flat().filter((at) => at === scope.at), []);
  assert.ok(h.builds[1].includes(look.at), 'the client look card was built without asking');
  assert.equal(h.ctl.status().pendingDecisions.length, 1);
  assert.equal(h.ctl.status().active, true);

  // Mati says yes: the card is released and built, the item moves on.
  assert.equal(h.ctl.answer({ id: d.id, answer: 'yes' }).ok, true);
  await h.next(5);
  assert.ok(h.builds[h.builds.length - 1].includes(scope.at));
  assert.deepEqual(h.items().map((i) => i.status), ['verified']);
  await h.stopAt(5);
});

test("a client's scope change Mati refuses is declined; the item shows it", async () => {
  const h = harness({ todos: [] });
  h.gates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 1);
  h.ctl.feedback({ author: 'client', text: 'remove the pricing page' });
  await h.next(2);
  const [d] = h.ctl.status().pendingDecisions;
  assert.equal(h.ctl.answer({ id: d.id, answer: 'no' }).ok, true);
  assert.deepEqual(h.items().map((i) => i.status), ['declined']);
  await h.next(3);
  assert.deepEqual(h.builds, [], 'a declined card is never built');
  await h.stopAt(3);
});

test('praise only is noted; feedback for another run or after the run is refused', async () => {
  const h = harness({ todos: [] });
  h.gates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 1);
  h.ctl.feedback({ text: 'Looks great, thanks!' });
  assert.equal(h.ctl.feedback({ text: 'x', runId: 'other' }).reason, 'otherRun');
  assert.equal(h.ctl.feedback({ text: 'x', author: 'boss' }).reason, 'badAuthor');
  await h.next(2);
  assert.deepEqual(h.items().map((i) => i.status), ['noted']);
  assert.equal(h.todos.length, 0, 'no card for praise');
  await h.stopAt(2);
  assert.equal(h.ctl.feedback({ text: 'late' }).reason, 'no-run');
  assert.equal(h.ctl.status().feedback, null);
});

// ---- the client widget on staging (LW 3.28b) -----------------------------------------------------

const W = require('../src/lunasworkWidget');
const S = require('../src/lunasworkSettings');

const STAGING_PROFILE = S.validateProfile({
  adapter: 'web',
  startCommand: 'npm start',
  url: 'http://localhost:3000',
  readyTimeoutSec: 60,
  checkCommand: '',
  stagingUrl: 'https://staging.example.test',
  stagingDeployCommand: 'vercel deploy --yes --scope staging',
}).profile;

/** The real widget over an in-memory Supabase side, with a token baked for the run. */
async function widgetFor(t) {
  const runsRoot = require('fs').mkdtempSync(path.join(os.tmpdir(), 'lw-fb-widget-'));
  t.after(() => require('fs').rmSync(runsRoot, { recursive: true, force: true }));
  const w = { rows: [], revoked: [], acked: [] };
  w.widget = W.createWidget({
    registry: () => ({
      register: async () => {},
      extend: async () => {},
      revoke: async (runId) => {
        w.revoked.push(runId);
        w.rows = w.rows.filter((r) => r.run_id !== runId);
      },
      pull: async (runId) => w.rows.filter((r) => r.run_id === runId),
      ack: async (ids) => {
        w.acked.push(...ids);
        w.rows = w.rows.filter((r) => !ids.includes(r.id));
      },
    }),
    endpoint: () => 'https://ref.supabase.co/functions/v1/lunaswork-feedback',
    runsRoot: () => runsRoot,
    now: () => START,
  });
  const baked = await w.widget.prepare({ id: RUN_ID, repoPath: REPO, profile: STAGING_PROFILE });
  assert.equal(baked.ok, true, baked.reason);
  w.send = (id, text) => w.rows.push({ id, run_id: RUN_ID, text, page_url: 'https://staging.example.test/cart', screenshot: null, created_at: new Date(START + id).toISOString() });
  return w;
}

test('client widget: items arrive as author client; look cards go in directly, the scope change waits for Mati with no default', async (t) => {
  const w = await widgetFor(t);
  const h = harness({ todos: [], widget: w.widget });
  h.gates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 1);
  w.send(7, 'the checkout button is too small, please add a PayPal integration');
  assert.equal(await w.widget.deliver(h.ctl), 1);
  assert.deepEqual(w.acked, [7]);
  assert.deepEqual(h.items().map((i) => i.author), ['client']);

  await h.next(2);
  const look = h.card('The checkout button is too small');
  assert.ok(look.tags.includes('from:client'));
  assert.match(look.details || '', /\[page\] https:\/\/staging\.example\.test\/cart/);
  assert.equal(h.todos.length, 2, 'the page line never became a card');
  const scope = h.card('Please add a PayPal integration');
  const [d] = h.ctl.status().pendingDecisions;
  assert.equal(d.kind, 'clientScope');
  assert.equal(d.defaultAnswer, null);
  assert.equal(d.deadline, null);
  await h.next(3);
  assert.ok(h.builds.flat().includes(look.at), 'the look card was built without asking');
  assert.ok(!h.builds.flat().includes(scope.at), 'the scope card waits for Mati');
  assert.deepEqual(h.items().map((i) => i.status), ['waiting']);
  await h.stopAt(3);
});

test('client widget: the token is revoked when the run ends, once, and the untaken rows go with it', async (t) => {
  const w = await widgetFor(t);
  const h = harness({ todos: [], widget: w.widget });
  h.gates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 1);
  w.send(8, 'the logo is too big');
  assert.deepEqual(w.revoked, []);
  await h.stopAt(1);
  await until(() => w.revoked.length === 1, 'revoked at the run end');
  assert.deepEqual(w.revoked, [RUN_ID]);
  assert.deepEqual(w.rows, []);
  // The finished run takes nothing in and is not revoked again.
  assert.equal(await w.widget.deliver(h.ctl), 0);
  assert.deepEqual(w.revoked, [RUN_ID]);
  assert.match((await w.widget.prepare({ id: RUN_ID, repoPath: REPO, profile: STAGING_PROFILE })).reason, /revoked/);
});

test('client widget: a run that ended before LunaCore could tell anyone revokes on resume', async () => {
  const revoked = [];
  const h = harness({ todos: [], widget: { revoke: async (id) => revoked.push(id) } });
  h.stored = { id: RUN_ID, projectId: 'game', repoPath: REPO, phase: 'done', iteration: 2, verdict: 'stop', endNotified: false };
  h.ctl.resume();
  await tick();
  assert.deepEqual(revoked, [RUN_ID]);
});

// ---- phone -------------------------------------------------------------------------------------

test('phone round trip: the form unit goes through the todos mirror to applyFeedback, author Mati', async () => {
  assert.equal(F.feedbackUnit('BAD!', 'x', START), null);
  assert.equal(F.feedbackUnit(RUN_ID, '   ', START), null);
  const unit = F.feedbackUnit(RUN_ID, 'the header is too big', START + 5);
  assert.deepEqual(unit, { k: `lunaswork-feedback:${START + 5}`, v: { runId: RUN_ID, text: 'the header is too big' }, u: START + 5, d: null });
  const other = F.feedbackUnit('lwother', 'not this run', START + 6);
  const state = applyRows({ cursor: 0, mirror: {}, pushed: {} }, [
    { key: unit.k, value: unit.v, u: unit.u, deleted_at: null, rev: 1, machine: 'iPhone' },
    { key: other.k, value: other.v, u: other.u, deleted_at: null, rev: 2, machine: 'iPhone' },
    { key: 'git:github.com/a/b:111', value: { text: 'todo', done: false }, u: START, deleted_at: null, rev: 3, machine: 'iPhone' },
  ], START + 10);
  const raw = F.feedbackFromTodoPeers([todoPeer(state.mirror)]);
  assert.deepEqual(raw.map((f) => [f.id, f.runId]), [[START + 5, RUN_ID], [START + 6, 'lwother']]);
  assert.deepEqual(F.feedbackFromTodoPeers([{ 'lunaswork-feedback': { items: [{ at: 'x', runId: RUN_ID, text: 'a' }, { at: 5, runId: RUN_ID, text: 7 }] } }]), []);

  const h = harness({ todos: [] });
  h.gates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 1);
  assert.equal(h.ctl.applyFeedback(raw), 1, 'only this run');
  assert.equal(h.ctl.applyFeedback(raw), 0, 'a pull later: nothing doubles');
  assert.equal(h.items()[0].author, 'mati');
  assert.equal(h.items()[0].id, START + 5);
  await h.stopAt(1);
});

test('phone snapshot: the feedback section rides in the godmode row and is cleaned on the reader side', () => {
  const section = {
    runId: RUN_ID,
    repoName: 'game',
    items: [
      { id: 3, author: 'client', text: 'too small', status: 'built', createdAt: 3, parts: [{ type: 'look', text: 'a', at: 9 }] },
      { id: 4, author: 'hacker', text: 'x', status: 'built' },
      { id: 5, author: 'mati', text: 'y', status: 'shipped!' },
    ],
  };
  const data = withLive(null, { feedback: F.publicFeedback(section) }, { machine: 'PC-1', now: START });
  assert.deepEqual(data.feedback.items, [{ id: 3, author: 'client', text: 'too small', status: 'built', createdAt: 3, cards: 1 }]);
  assert.equal(withLive(null, {}, { machine: 'PC-1', now: START }).feedback, undefined);
  const row = { machine: 'PC-1', data };
  assert.deepEqual(parseGodmodePeer(row, START).feedback, data.feedback);
  const seen = feedbackFrom([row], START + MINUTE);
  assert.equal(seen.runId, RUN_ID);
  assert.equal(seen.machine, 'PC-1');
  assert.equal(seen.stale, false);
  assert.equal(feedbackFrom([{ machine: 'PC-1', data: { ...data, feedback: { runId: 'BAD!' } } }], START), null);
});

test('wireDecisionSync publishes the feedback section on change and pulls phone feedback after a todos pull', () => {
  const puts = [];
  const applied = [];
  let listener = null;
  const pulled = [];
  const section = { runId: RUN_ID, repoName: 'game', items: [] };
  const unit = F.feedbackUnit(RUN_ID, 'bigger buttons', START);
  const mirror = applyRows({ cursor: 0, mirror: {}, pushed: {} }, [{ key: unit.k, value: unit.v, u: unit.u, deleted_at: null, rev: 1 }], START).mirror;
  const controller = {
    subscribe: (fn) => {
      listener = fn;
    },
    status: () => ({ pendingDecisions: [], feedback: section }),
    applyAnswers: () => 0,
    applyFeedback: (list) => {
      applied.push(list);
      return list.length;
    },
  };
  const cloud = { onPulled: (fn) => pulled.push(fn), hooks: () => ({ extraPeers: () => [todoPeer(mirror)] }) };
  wireDecisionSync({ controller, cloud, putDecisions: () => {}, putFeedback: (s) => puts.push(s) });
  listener({ type: 'feedback', status: { pendingDecisions: [], feedback: section } });
  listener({ type: 'phase', status: { pendingDecisions: [], feedback: section } });
  listener({ type: 'phase', status: { pendingDecisions: [], feedback: null } });
  assert.deepEqual(puts, [section, null], 'unchanged sections are not put again');
  pulled[0]('todos');
  assert.deepEqual(applied[0].map((f) => f.text), ['bigger buttons']);
});

// ---- email -------------------------------------------------------------------------------------

const triaged = (id, status, author = 'mati') => ({ id, author, text: `item ${id}`, createdAt: id, status, parts: [], triagedAt: id });

test('emails list every item with its status; the milestone email carries the feedback link', () => {
  const lines = F.emailLines([triaged(1, 'verified'), triaged(2, 'waiting', 'client')]);
  assert.deepEqual(lines.slice(0, 3), ['FEEDBACK', '- [verified in the app] item 1', '- [waiting for your decision] (client) item 2']);
  assert.equal(lines[lines.length - 1], `Send feedback while it runs: ${F.FEEDBACK_URL}`);
  assert.deepEqual(F.emailLines([], { link: null }), ['FEEDBACK', '- none yet']);

  const run = {
    id: RUN_ID,
    repoPath: REPO,
    iteration: 4,
    milestone: 'polish',
    history: [{ n: 3, milestone: 'skeleton', score: 82 }],
    decisions: [{ id: 9, status: 'pending', question: 'Client feedback asks for a scope change: PDF export', defaultAnswer: null }],
    feedback: [triaged(1, 'built'), { id: 2, author: 'mati', text: 'new one', createdAt: 2, status: 'new', parts: null }],
  };
  const mail = buildMilestoneEmail(run, { milestone: 'skeleton' });
  assert.equal(mail.subject, `Luna's Work: ${path.basename(REPO)} - milestone skeleton reached`);
  assert.match(mail.text, /PDF export \(no default - waits for you\)/);
  assert.match(mail.text, /- \[built, not verified yet\] item 1/);
  assert.match(mail.text, /- \[received, planned next iteration\] new one/);
  assert.ok(mail.text.includes(F.FEEDBACK_URL));

  // The run-end email lists the statuses, without a link to a run that is over.
  const end = buildRunEmail({ ...run, phase: 'done', verdict: 'stop', stopReason: 'killSwitch', laps: [], log: [] });
  assert.match(end.text, /FEEDBACK\n- \[built, not verified yet\] item 1/);
  assert.ok(!end.text.includes(F.FEEDBACK_URL));
});

test('a passed milestone gate sends one milestone email; the run goes on', async () => {
  const sent = [];
  const reporter = createLunasWorkReporter({
    runsDir: () => EVIDENCE,
    mail: {
      sender: { status: () => ({ connected: true }), send: async (msg) => sent.push(msg) },
      prefs: { loadPrefs: () => ({ godmodeEmail: true }), loadState: () => ({ godmode: {} }), updateState: () => {} },
      enabled: () => true,
    },
  });
  const h = harness({ todos: [], milestonePassAt: 1, onMilestone: reporter.onMilestone });
  h.gates[1] = deferred();
  await h.ctl.start({ projectId: 'game' });
  await until(() => h.directorCalls.length === 1);
  h.ctl.feedback({ text: 'the logo is too dark' });
  await h.next(2);
  await until(() => sent.length === 1, 'milestone email sent');
  assert.equal(h.milestones.length, 1);
  assert.equal(h.milestones[0].ctx.milestone, 'skeleton');
  assert.match(sent[0].subject, /milestone skeleton reached/);
  assert.match(sent[0].text, /the logo is too dark/);
  assert.equal(h.ctl.status().active, true);
  // The same milestone again (a replayed hook) sends nothing.
  assert.equal((await reporter.onMilestone(h.milestones[0].run, { milestone: 'skeleton' })).skipped, 'duplicate');
  await h.stopAt(2);
});
