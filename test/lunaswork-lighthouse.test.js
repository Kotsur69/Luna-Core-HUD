'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lh = require('../src/lunasworkLighthouse');
const { validateCritique } = require('../src/lunasworkCritic');

const scores = (performance, accessibility, bestPractices, seo) => ({ performance, accessibility, bestPractices, seo });
const result = (route, device, s, reportPath = `reports/${route.replace(/\W/g, '') || 'home'}-${device}.json`) => ({
  route, device, scores: s, reportPath,
});
const GOOD = scores(95, 95, 95, 95);

const envelope = (structured) => JSON.stringify({ is_error: false, total_cost_usd: 0.2, structured_output: structured });

test('tool list contains only chrome-devtools MCP tools', () => {
  const tools = lh.lighthouseTools();
  assert.ok(tools.length > 0);
  assert.ok(tools.includes('mcp__chrome-devtools__lighthouse_audit'));
  for (const t of tools) assert.match(t, /^mcp__chrome-devtools__\w+$/);
  // A bad server name falls back instead of widening the list.
  assert.deepEqual(lh.lighthouseTools('x,Bash'), tools);
});

test('buildLighthouseArgs: built-in tools off, strict MCP config, only chrome-devtools allowed', () => {
  const args = lh.buildLighthouseArgs({ model: 'sonnet' });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], '-p');
  assert.equal(value('--tools'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(value('--allowedTools').split(','), lh.lighthouseTools());
  assert.deepEqual(Object.keys(JSON.parse(value('--mcp-config')).mcpServers), ['chrome-devtools']);
  assert.deepEqual(JSON.parse(value('--json-schema')), lh.LIGHTHOUSE_SCHEMA);
  assert.equal(value('--model'), 'sonnet');
});

test('buildLighthousePrompt lists the given routes and both devices', () => {
  const prompt = lh.buildLighthousePrompt({ routes: ['/', '/login', '/login', 'bad route'], reportDir: '.lw/lighthouse' });
  assert.match(prompt, /- \/\n- \/login$/);
  assert.match(prompt, /desktop, mobile/);
  assert.match(prompt, /\.lw\/lighthouse/);
});

test('validateLighthouse accepts the schema shape and drops bad results', () => {
  const ok = result('/', 'desktop', scores(81.6, 90, 90, 90));
  const out = lh.validateLighthouse({
    results: [
      ok,
      result('/', 'desktop', GOOD), // duplicate
      result('/x', 'tablet', GOOD), // bad device
      result('/y', 'mobile', scores(101, 90, 90, 90)), // out of range
      { route: '/z', device: 'mobile', scores: GOOD }, // no report path
      result('/other', 'mobile', GOOD), // not a requested route
    ],
  }, { routes: ['/', '/x', '/y', '/z'] });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].scores.performance, 82);
  assert.deepEqual(out.errors.map((e) => e.code), ['duplicateResult', 'badResult', 'badResult', 'badResult', 'unknownRoute']);
  assert.deepEqual(lh.validateLighthouse(null), { results: [], errors: [{ code: 'badLighthouse' }] });
  assert.deepEqual(lh.validateLighthouse({ results: 'no' }).errors, [{ code: 'badLighthouse' }]);
});

test('budgetsFrom merges lighthouseBudgets tolerantly', () => {
  assert.deepEqual({ ...lh.budgetsFrom(undefined) }, { ...lh.DEFAULT_BUDGETS });
  assert.deepEqual(lh.DEFAULT_BUDGETS, { performance: 80, accessibility: 90, bestPractices: 90, seo: 90 });
  assert.deepEqual(
    { ...lh.budgetsFrom({ lighthouseBudgets: { performance: 70, accessibility: 'high', seo: 120, bestPractices: -1, extra: 5 } }) },
    { performance: 70, accessibility: 90, bestPractices: 90, seo: 90 },
  );
  assert.deepEqual({ ...lh.budgetsFrom({ lighthouseBudgets: [1, 2] }) }, { ...lh.DEFAULT_BUDGETS });
});

test('budgetCards: below budget creates cards with the right kinds and report evidence', () => {
  const out = lh.budgetCards({
    runId: 'r1',
    results: [
      result('/', 'desktop', scores(60, 80, 95, 85)),
      result('/', 'mobile', scores(85, 85, 95, 95)),
    ],
  });
  const byText = Object.fromEntries(out.cards.map((c) => [c.text.split(' ')[0], c]));
  assert.equal(out.cards.length, 3);
  assert.equal(byText.Accessibility.kind, 'bug');
  assert.equal(byText.Performance.kind, 'feel');
  assert.equal(byText.Performance.severity, 'high'); // 20 under budget
  assert.equal(byText.SEO.kind, 'missing');
  // Accessibility breached on both devices -> one card listing both reports.
  assert.deepEqual(byText.Accessibility.files, ['reports/home-desktop.json', 'reports/home-mobile.json']);
  assert.match(byText.Accessibility.details, /Evidence: reports\/home-desktop\.json/);
  // Bugs come first (Critic ordering) and carry a repro test.
  assert.equal(out.cards[0].kind, 'bug');
  assert.ok(out.cards[0].acceptance.some((a) => /reproduces the bug/.test(a)));
  for (const c of out.cards) {
    assert.ok(c.tags.includes('run:r1') && c.tags.includes(lh.LIGHTHOUSE_TAG));
  }
  // The card shapes pass validateCritique unchanged.
  const again = validateCritique({ cards: out.cards, logEntry: {}, architecture: '', decisions: [], newJourneys: [], verdict: 'CONTINUE' });
  assert.equal(again.cards.length, 3);
});

test('budgetCards: a drop of more than N points vs the last green iteration creates a card', () => {
  const lastGreen = [result('/', 'desktop', scores(99, 99, 99, 99))];
  const exactlyN = lh.budgetCards({ runId: 'r1', lastGreen, dropPoints: 5, results: [result('/', 'desktop', scores(94, 99, 99, 99))] });
  assert.equal(exactlyN.cards.length, 0);
  const moreThanN = lh.budgetCards({ runId: 'r1', lastGreen: { iteration: 2, results: lastGreen }, dropPoints: 5,
    results: [result('/', 'desktop', scores(93, 99, 99, 99))] });
  assert.equal(moreThanN.cards.length, 1);
  assert.equal(moreThanN.cards[0].kind, 'feel');
  assert.match(moreThanN.cards[0].text, /dropped to 93/);
  assert.match(moreThanN.cards[0].details, /was 99 at the last green iteration/);
  // Default drop is DEFAULT_DROP_POINTS; within budget and no drop -> no card.
  assert.equal(lh.budgetCards({ runId: 'r1', lastGreen, results: [result('/', 'desktop', scores(97, 99, 99, 99))] }).cards.length, 0);
});

test('budgetCards honours custom budgets and a missing runId', () => {
  const results = [result('/', 'desktop', scores(75, 95, 95, 95))];
  assert.equal(lh.budgetCards({ runId: 'r1', results, budgets: { performance: 70 } }).cards.length, 0);
  assert.equal(lh.budgetCards({ runId: 'r1', results }).cards.length, 1);
  assert.deepEqual(lh.budgetCards({ results }).errors, [{ code: 'badRunId' }]);
});

test('appendResult stores per-iteration results immutably; trend gives the worst score', () => {
  const h0 = [];
  const h1 = lh.appendResult(h0, 1, [result('/', 'desktop', scores(90, 92, 93, 94)), result('/', 'mobile', scores(70, 95, 93, 94))]);
  const h2 = lh.appendResult(h1, 2, [result('/', 'desktop', GOOD)]);
  const h2b = lh.appendResult(h2, 2, [result('/', 'desktop', scores(85, 95, 95, 95))]);
  assert.equal(h0.length, 0);
  assert.equal(h1.length, 1);
  assert.equal(h2.length, 2);
  assert.equal(h2b.length, 2);
  assert.ok(Object.isFrozen(h2b) && Object.isFrozen(h2b[1]));
  assert.throws(() => { 'use strict'; h2b.push({}); });
  assert.deepEqual(lh.trend(h2b), [
    { iteration: 1, scores: scores(70, 92, 93, 94) },
    { iteration: 2, scores: scores(85, 95, 95, 95) },
  ]);
  // A JSON round trip (persistence) keeps the trend.
  assert.deepEqual(lh.trend(JSON.parse(JSON.stringify(h2b))), lh.trend(h2b));
  assert.deepEqual(lh.trend(lh.appendResult(h2b, 3, [])), [...lh.trend(h2b), { iteration: 3, scores: scores(null, null, null, null) }]);
  assert.deepEqual(lh.trend(null), []);
  assert.equal(lh.appendResult(h1, 'x', []).length, 1);
});

test('runLighthouse resolves results via the injected runner', async () => {
  let call;
  const out = await lh.runLighthouse({
    routes: ['/', '/login'],
    repoPath: '/repo',
    reportDir: '.lw/lh',
    runClaude: async (c) => {
      call = c;
      return { stdout: envelope({ results: [result('/', 'desktop', GOOD), result('/login', 'mobile', GOOD), result('/x', 'mobile', GOOD)] }) };
    },
  });
  assert.equal(out.results.length, 2);
  assert.equal(out.costUsd, 0.2);
  assert.match(out.notes[0], /1 result\(s\) dropped/);
  assert.equal(call.cwd, '/repo');
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.match(call.prompt, /- \/login/);
});

test('a failing run resolves to a note and never throws', async () => {
  const cases = [
    { runClaude: async () => ({ error: 'noClaude' }), note: /noClaude/ },
    { runClaude: async () => ({ stdout: 'not json' }), note: /badJson/ },
    { runClaude: async () => ({ stdout: envelope({ nope: true }) }), note: /badLighthouse/ },
    { runClaude: async () => ({ stdout: envelope({ results: [] }) }), note: /noResults/ },
    { runClaude: async () => { throw new Error('boom'); }, note: /crashed \(boom\)/ },
    { runClaude: async () => ({ stdout: JSON.stringify({ is_error: true, result: 'MCP server failed' }) }), note: /failed/ },
  ];
  for (const c of cases) {
    const out = await lh.runLighthouse({ routes: ['/'], repoPath: '/repo', runClaude: c.runClaude });
    assert.deepEqual(out.results, []);
    assert.match(out.notes[0], /^lighthouse failed: /);
    assert.match(out.notes[0], c.note);
  }
  const noRoutes = await lh.runLighthouse({ routes: [], runClaude: async () => assert.fail('must not run') });
  assert.match(noRoutes.notes[0], /noRoutes/);
  const bad = await lh.runLighthouse(null);
  assert.match(bad.notes[0], /noRoutes/);
});
