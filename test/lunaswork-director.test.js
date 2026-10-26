// ============================================================================
// Luna's Work Director: the model only proposes. Unknown, closed and stuck ids
// are dropped, the cap holds, Mati's steer cards always come first and are
// never cut, a `stop` steer card stops the run, a bad answer falls back to
// orderCards, designAppend only appends to DESIGN.md, and every scheduled card
// carries the builder brief. `claude` is a fake runner; the store is in memory.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../src/lunasworkDirector.js');
const Pack = require('../src/lunasworkPack.js');
const { MAX_CARDS_PER_ITERATION, orderCards } = require('../src/lunasworkRules.js');

const RUN_ID = 'amsteel-1';
const RUN_TAG = 'run:amsteel-1';
const DESIGN_BODY = '# Design\n\n## Screens\n\nQuote screen.\n';

function fakeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-director-'));
  assert.equal(Pack.scaffoldPack(dir).ok, true);
  fs.writeFileSync(path.join(dir, 'design', 'DESIGN.md'), DESIGN_BODY);
  return dir;
}

function memStore(list) {
  return { list, read: () => list, write: () => assert.fail('the Director must not write the to-do store') };
}

const runCard = (at, over = {}) => ({ text: `Card ${at}`, done: false, at, tags: [RUN_TAG, 'kind:feel', 'sev:medium'], ...over });
const steerCard = (at, text = `Steer ${at}`, over = {}) => ({ text, done: false, at, tags: ['steer'], ...over });

/** A fake `claude` answering with `answer` as structured output; records every call. */
function fakeClaude(answer) {
  const calls = [];
  const run = async (call) => {
    calls.push(call);
    return { stdout: JSON.stringify({ structured_output: answer, total_cost_usd: 0.1 }) };
  };
  return { run, calls };
}

async function direct({ list, answer, runClaude, ...over }) {
  const claude = fakeClaude(answer);
  const res = await D.runDirector({
    repoDir: fakeRepo(),
    runId: RUN_ID,
    iteration: 2,
    todoStore: memStore(list),
    runClaude: runClaude || claude.run,
    log: () => {},
    ...over,
  });
  return { res, calls: claude.calls };
}

// ---- validation: ids --------------------------------------------------------------

test('unknown, closed, foreign and duplicate ids are dropped', async () => {
  const list = [
    runCard(1),
    runCard(2),
    runCard(3, { done: true }),
    { text: 'Mati personal to-do', done: false, at: 4 },
    { text: 'Other run', done: false, at: 5, tags: ['run:other'] },
  ];
  const { res } = await direct({ list, answer: { cardIds: [2, 99, 3, 4, 5, 2, 1], notes: 'n' } });
  assert.equal(res.ok, true);
  assert.equal(res.fallback, false);
  assert.deepEqual(res.cardIds, [2, 1]);
  const codes = res.warnings.map((w) => `${w.code}:${w.at}`);
  for (const code of ['unknownCard:99', 'unknownCard:3', 'unknownCard:4', 'unknownCard:5', 'duplicateCard:2']) {
    assert.ok(codes.includes(code), code);
  }
});

test('the cap holds for the run cards', async () => {
  const list = Array.from({ length: 10 }, (_, i) => runCard(i + 1));
  const { res } = await direct({ list, answer: { cardIds: list.map((c) => c.at), notes: '' } });
  assert.equal(res.cardIds.length, MAX_CARDS_PER_ITERATION);
  assert.deepEqual(res.cardIds, [1, 2, 3, 4, 5, 6]);
  assert.ok(res.warnings.some((w) => w.code === 'tooManyCards' && w.dropped === 4));
});

test('stuck cards are left out', async () => {
  const list = [runCard(1), runCard(2)];
  const { res } = await direct({ list, failCounts: { 1: 2 }, answer: { cardIds: [1, 2], notes: '' } });
  assert.deepEqual(res.cardIds, [2]);
  assert.ok(res.warnings.some((w) => w.code === 'stuckCard' && w.at === 1));
});

test('a second card with the same id is never the one scheduled', async () => {
  const list = [
    // "Quote" keeps the card inside the fake DESIGN.md (the scope guard, B5).
    runCard(1, { text: 'The real quote card' }),
    runCard(1, { text: 'Same id, other run', tags: ['run:other'] }),
    runCard(1, { text: 'Same id, later duplicate' }),
  ];
  const { res } = await direct({ list, answer: { cardIds: [1], notes: '' } });
  assert.deepEqual(res.cardIds, [1]);
  assert.equal(res.cards[0].text, 'The real quote card');
});

test('a stuck steer card is left out with a warning', async () => {
  const list = [runCard(1), steerCard(10)];
  const { res } = await direct({ list, failCounts: { 10: 3 }, answer: { cardIds: [10, 1], notes: '' } });
  assert.deepEqual(res.cardIds, [1]);
  assert.ok(res.warnings.some((w) => w.code === 'stuckSteer' && w.at === 10));
});

test('idea cards wait for the milestone gate unless Mati steered them', async () => {
  const list = [runCard(1, { tags: [RUN_TAG, 'kind:idea', 'sev:low'] }), runCard(2)];
  const before = await direct({ list, answer: { cardIds: [1, 2], notes: '' } });
  assert.deepEqual(before.res.cardIds, [2]);
  const after = await direct({
    list,
    lastCritic: { verdict: 'continue', milestone: { name: 'Skeleton', passed: true } },
    answer: { cardIds: [1, 2], notes: '' },
  });
  assert.deepEqual(after.res.cardIds, [1, 2]);
});

// ---- validation: steer --------------------------------------------------------------

test('steer cards come first even when the model puts them last', async () => {
  const list = [runCard(1), runCard(2), steerCard(10), steerCard(11)];
  const { res } = await direct({ list, answer: { cardIds: [1, 11, 2, 10], notes: '' } });
  assert.deepEqual(res.cardIds, [11, 10, 1, 2]);
});

test('steer cards the model left out are forced in', async () => {
  const list = [runCard(1), steerCard(10), steerCard(11)];
  const { res } = await direct({ list, answer: { cardIds: [1, 11], notes: '' } });
  assert.deepEqual(res.cardIds, [11, 10, 1]);
});

test('steer cards are never cut by the limit; the run cards give way', async () => {
  const steer = Array.from({ length: 8 }, (_, i) => steerCard(100 + i));
  const list = [runCard(1), runCard(2), ...steer];
  const { res } = await direct({ list, answer: { cardIds: [1, 2], notes: '' } });
  assert.equal(res.cardIds.length, 8);
  assert.deepEqual(res.cardIds, steer.map((c) => c.at));
  assert.ok(res.warnings.some((w) => w.code === 'tooManyCards' && w.dropped === 2));
});

test('steer cards fill the cap first, run cards take what is left', async () => {
  const list = [...Array.from({ length: 6 }, (_, i) => runCard(i + 1)), steerCard(10), steerCard(11)];
  const { res } = await direct({ list, answer: { cardIds: [1, 2, 3, 4, 5, 6], notes: '' } });
  assert.deepEqual(res.cardIds, [10, 11, 1, 2, 3, 4]);
});

// ---- stop ----------------------------------------------------------------------------

test('a `stop` steer card yields stop and is never scheduled', async () => {
  for (const text of ['stop', '  STOP ', 'Stop']) {
    const list = [runCard(1), steerCard(10, text)];
    const { res } = await direct({ list, answer: { cardIds: [10, 1], notes: '' } });
    assert.equal(res.stop, true, text);
    assert.deepEqual(res.cardIds, [1], text);
  }
});

test('a steer card that only mentions stop, or a closed stop card, does not stop the run', async () => {
  const list = [runCard(1), steerCard(10, 'stop the flicker on save'), steerCard(11, 'stop', { done: true })];
  const { res } = await direct({ list, answer: { cardIds: [1], notes: '' } });
  assert.equal(res.stop, false);
  assert.deepEqual(res.cardIds, [10, 1]);
});

test('`stop` without the steer tag is a plain card', () => {
  assert.equal(D.isStopCard({ text: 'stop', tags: [RUN_TAG] }), false);
  assert.equal(D.isStopCard({ text: 'stop', tags: ['steer'] }), true);
});

// ---- fallback -------------------------------------------------------------------------

const FALLBACK_LIST = [
  runCard(1, { tags: [RUN_TAG, 'kind:feel', 'sev:low'] }),
  runCard(2, { tags: [RUN_TAG, 'kind:bug', 'sev:high'] }),
  steerCard(10),
  runCard(3, { tags: [RUN_TAG, 'kind:missing', 'sev:medium'] }),
];
// orderCards over the same cards, with meta from their tags.
const EXPECTED_FALLBACK = orderCards([
  { ...FALLBACK_LIST[0], kind: 'feel', severity: 'low' },
  { ...FALLBACK_LIST[1], kind: 'bug', severity: 'high' },
  { ...FALLBACK_LIST[2], steer: true },
  { ...FALLBACK_LIST[3], kind: 'missing', severity: 'medium' },
]).map((c) => c.at);

test('invalid model output falls back to orderCards', async () => {
  assert.deepEqual(EXPECTED_FALLBACK, [10, 2, 3, 1]);
  for (const answer of [null, 'nope', { notes: 'no ids' }, { cardIds: 'all' }, { cardIds: [], notes: '' }, { cardIds: [99, 'x'], notes: '' }]) {
    const { res } = await direct({ list: FALLBACK_LIST, answer });
    assert.equal(res.ok, true, JSON.stringify(answer));
    assert.equal(res.fallback, true, JSON.stringify(answer));
    assert.deepEqual(res.cardIds, EXPECTED_FALLBACK, JSON.stringify(answer));
  }
});

test('a failed call falls back to orderCards and says why', async () => {
  const runClaude = async () => ({ error: 'limit', detail: 'usage limit reached' });
  const { res } = await direct({ list: FALLBACK_LIST, runClaude });
  assert.equal(res.ok, true);
  assert.equal(res.fallback, true);
  assert.equal(res.error, 'limit');
  assert.deepEqual(res.cardIds, EXPECTED_FALLBACK);
});

test('a CLI error envelope falls back too', async () => {
  const runClaude = async () => ({ stdout: JSON.stringify({ is_error: true, result: 'boom' }) });
  const { res } = await direct({ list: FALLBACK_LIST, runClaude });
  assert.equal(res.fallback, true);
  assert.equal(res.error, 'failed');
  assert.deepEqual(res.cardIds, EXPECTED_FALLBACK);
});

test('a runner that throws still resolves with the fallback', async () => {
  const runClaude = async () => {
    throw new Error('spawn exploded');
  };
  const { res } = await direct({ list: FALLBACK_LIST, runClaude });
  assert.equal(res.ok, true);
  assert.equal(res.fallback, true);
  assert.equal(res.error, 'failed');
  assert.deepEqual(res.cardIds, EXPECTED_FALLBACK);
});

test('no open cards: no model call', async () => {
  const { res, calls } = await direct({ list: [runCard(1, { done: true })], answer: { cardIds: [1], notes: '' } });
  assert.equal(calls.length, 0);
  assert.equal(res.ok, true);
  assert.deepEqual(res.cardIds, []);
});

test('a stop card alone still reports stop without a model call', async () => {
  const { res, calls } = await direct({ list: [steerCard(10, 'stop')], answer: { cardIds: [10], notes: '' } });
  assert.equal(calls.length, 0);
  assert.equal(res.stop, true);
  assert.deepEqual(res.cardIds, []);
});

// ---- builder brief --------------------------------------------------------------------

test('every scheduled card carries the ARCHITECTURE / DECISIONS brief', async () => {
  const list = [runCard(1, { details: 'Fix the total.' }), steerCard(10)];
  const { res } = await direct({ list, answer: { cardIds: [1], notes: '' } });
  assert.equal(res.cards.length, 2);
  for (const card of res.cards) {
    assert.ok(card.details.startsWith(D.BUILDER_BRIEF), card.text);
    assert.match(card.details, /Read design\/ARCHITECTURE\.md and design\/DECISIONS\.md first/);
  }
  assert.ok(res.cards.find((c) => c.at === 1).details.endsWith('Fix the total.'));
  // The store's cards are not changed.
  assert.equal(list[0].details, 'Fix the total.');
  assert.equal(list[1].details, undefined);
});

test('the brief is added once and keeps the card within its details cap', () => {
  const once = D.withBuilderBrief({ text: 't', details: 'x'.repeat(5000) });
  assert.ok(once.details.length <= 4000);
  assert.deepEqual(D.withBuilderBrief(once), once);
});

// ---- designAppend -----------------------------------------------------------------------

test('designAppend is appended to DESIGN.md, never a rewrite', async () => {
  const repoDir = fakeRepo();
  const { res } = await direct({
    repoDir,
    list: [runCard(1)],
    answer: { cardIds: [1], designAppend: '## Export\n\nQuotes export to PDF.', notes: '' },
  });
  assert.equal(res.designAppended, true);
  const design = fs.readFileSync(path.join(repoDir, 'design', 'DESIGN.md'), 'utf8');
  assert.ok(design.startsWith(DESIGN_BODY.trim()));
  assert.match(design, /## Director - iteration 2\n\n### Export\n\nQuotes export to PDF\./);
});

test('no designAppend, or a fallback, leaves DESIGN.md alone', async () => {
  for (const answer of [{ cardIds: [1], notes: '' }, { cardIds: [99], designAppend: 'x', notes: '' }]) {
    const repoDir = fakeRepo();
    const { res } = await direct({ repoDir, list: [runCard(1)], answer });
    assert.equal(res.designAppended, false);
    assert.equal(fs.readFileSync(path.join(repoDir, 'design', 'DESIGN.md'), 'utf8'), DESIGN_BODY);
  }
});

// ---- call shape ---------------------------------------------------------------------------

test('read-only tools, the schema and the cards reach the call', async () => {
  const list = [runCard(1), steerCard(10, 'Make the logo bigger')];
  const { res, calls } = await direct({ list, answer: { cardIds: [1], notes: 'because' } });
  assert.equal(calls.length, 1);
  const { args, prompt } = calls[0];
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), D.DIRECTOR_SCHEMA);
  assert.match(prompt, /Make the logo bigger/);
  assert.match(prompt, /Card 1/);
  assert.equal(res.notes, 'because');
  assert.equal(res.model, 'opus');
  assert.equal(res.costUsd, 0.1);
});

test('bad input fails without a call', async () => {
  for (const over of [{ runId: '../x' }, { iteration: 0 }, { repoDir: 'relative' }, { todoStore: null }]) {
    const { res, calls } = await direct({ list: [runCard(1)], answer: { cardIds: [1], notes: '' }, ...over });
    assert.equal(res.ok, false, JSON.stringify(over));
    assert.equal(calls.length, 0);
  }
});

// ---- B5: the scope guard; B1: built cards are not scheduled ------------------------

test('a card outside DESIGN.md / ROADMAP.md is not scheduled and comes back in outOfScope (B5)', async () => {
  const list = [runCard(1, { text: 'Quote totals' }), runCard(2, { text: 'Multiplayer leaderboard chat' })];
  const { res, calls } = await direct({ list, answer: { cardIds: [1, 2], notes: '' } });
  assert.deepEqual(res.cardIds, [1]);
  assert.deepEqual(res.outOfScope.map((c) => c.at), [2]);
  assert.ok(res.outOfScope[0].missing.includes('leaderboard'));
  // The model never even sees the out-of-scope card.
  assert.doesNotMatch(calls[0].prompt, /Multiplayer leaderboard/);
});

test('a decision-queue entry lets an out-of-scope card through (B5)', async () => {
  const list = [runCard(1, { text: 'Quote totals' }), runCard(2, { text: 'Multiplayer leaderboard chat' })];
  const { res } = await direct({ list, decidedCards: [2], answer: { cardIds: [1, 2], notes: '' } });
  assert.deepEqual(res.cardIds, [1, 2]);
  assert.deepEqual(res.outOfScope, []);
});

test('ROADMAP.md counts as scope too, and steer and bug cards are never out of scope (B5)', async () => {
  const repoDir = fakeRepo();
  fs.writeFileSync(path.join(repoDir, 'design', 'ROADMAP.md'), '# Roadmap\n\n- Milestone 3: multiplayer leaderboard\n');
  const list = [
    runCard(1, { text: 'Multiplayer leaderboard chat' }),
    runCard(2, { text: 'Weather widget forecast', tags: [RUN_TAG, 'kind:bug', 'sev:high'] }),
    steerCard(3, 'Weather widget forecast'),
  ];
  const { res } = await direct({ list, repoDir, answer: { cardIds: [1, 2, 3], notes: '' } });
  assert.deepEqual([...res.cardIds].sort(), [1, 2, 3]);
  assert.deepEqual(res.outOfScope, []);
});

test('validateDirection drops a picked out-of-scope id with a warning (B5)', () => {
  const cards = [runCard(1, { text: 'Quote totals', kind: 'feel' }), runCard(2, { text: 'Multiplayer leaderboard chat', kind: 'feel' })];
  const out = D.validateDirection({ cardIds: [2, 1], notes: '' }, { cards, scopeText: DESIGN_BODY, decided: new Set() });
  assert.deepEqual(out.cards.map((c) => c.at), [1]);
  assert.deepEqual(out.outOfScope.map((c) => c.at), [2]);
  assert.ok(out.warnings.some((w) => w.code === 'outOfScope' && w.at === 2));
});

test('splitByScope: no scope text means no guard (B5)', () => {
  const cards = [runCard(1, { text: 'Multiplayer leaderboard chat' })];
  assert.deepEqual(D.splitByScope(cards, '', new Set()).outOfScope, []);
  const guarded = D.splitByScope(cards, DESIGN_BODY, new Set());
  assert.deepEqual(guarded.inScope, []);
  assert.equal(guarded.outOfScope[0].text, 'Multiplayer leaderboard chat');
});

test('a built card is never scheduled: it waits for the Playtester (B1)', async () => {
  const list = [runCard(1), runCard(2, { state: 'built' })];
  const { res } = await direct({ list, answer: { cardIds: [1, 2], notes: '' } });
  assert.deepEqual(res.cardIds, [1]);
  assert.ok(res.warnings.some((w) => w.code === 'unknownCard' && w.at === 2));
});

// ---- LW 2.12: contracts and file ownership ---------------------------------------------

const CONTRACT = { name: 'quoteTotal', kind: 'function', spec: 'quoteTotal(items) -> number' };
const PARALLEL = {
  cardIds: [1, 2],
  notes: '',
  contracts: [CONTRACT],
  ownership: [{ path: 'src/quote/**', cardId: 1 }, { path: 'src/pdf.js', cardId: 2 }],
};
const validate = (answer, cards = [runCard(1), runCard(2)], over = {}) =>
  D.validateDirection(answer, { cards: cards.map((c) => ({ ...c, kind: 'feel', steer: (c.tags || []).includes('steer') })), ...over });

test('a valid contracts + ownership answer comes back whole', () => {
  const out = validate(PARALLEL);
  assert.equal(out.fallback, false);
  assert.deepEqual(out.cards.map((c) => c.at), [1, 2]);
  assert.deepEqual(out.contracts, [CONTRACT]);
  assert.deepEqual(out.ownership, [{ path: 'src/quote/**', cardId: 1 }, { path: 'src/pdf.js', cardId: 2 }]);
});

test('ownership paths are normalized; leaving both out is still a valid answer', () => {
  const out = validate({ ...PARALLEL, ownership: [{ path: './src\\quote/', cardId: 1 }, { path: 'src//pdf.js', cardId: 2 }] });
  assert.deepEqual(out.ownership.map((e) => e.path), ['src/quote/**', 'src/pdf.js']);
  const plain = validate({ cardIds: [1, 2], notes: '' });
  assert.equal(plain.fallback, false);
  assert.deepEqual(plain.contracts, []);
  assert.equal(plain.ownership, null);
});

test('a broken ownership map rejects the answer like any malformed one', () => {
  const owned = (ownership) => ({ ...PARALLEL, ownership });
  const cases = [
    ['absolute path', owned([{ path: '/etc/x', cardId: 1 }, { path: 'src/pdf.js', cardId: 2 }])],
    ['drive path', owned([{ path: 'C:\\repo\\x.js', cardId: 1 }, { path: 'src/pdf.js', cardId: 2 }])],
    ['.. escape', owned([{ path: 'src/../../x.js', cardId: 1 }, { path: 'src/pdf.js', cardId: 2 }])],
    ['owned twice', owned([{ path: 'src/a.js', cardId: 1 }, { path: './src/a.js', cardId: 2 }])],
    ['card owns nothing', owned([{ path: 'src/a.js', cardId: 1 }])],
    ['unknown card', owned([{ path: 'src/a.js', cardId: 1 }, { path: 'src/b.js', cardId: 2 }, { path: 'src/c.js', cardId: 99 }])],
    ['not a list', owned({ 'src/a.js': 1 })],
  ];
  for (const [label, answer] of cases) {
    const out = validate(answer);
    assert.equal(out.fallback, true, label);
    assert.ok(out.warnings.some((w) => w.code === 'badOwnership'), label);
    assert.equal(out.ownership, null, label);
  }
});

test('a steer card forced in must own a path too', () => {
  const cards = [runCard(1), runCard(2), steerCard(10)];
  const out = validate(PARALLEL, cards);
  assert.equal(out.fallback, true);
  assert.match(out.warnings.find((w) => w.code === 'badOwnership').detail, /10/);
  const fixed = validate({ ...PARALLEL, ownership: [...PARALLEL.ownership, { path: 'src/logo.svg', cardId: 10 }] }, cards);
  assert.equal(fixed.fallback, false);
  assert.deepEqual(fixed.cards.map((c) => c.at), [10, 1, 2]);
});

test('a card the limit cut gives its paths up with a warning', () => {
  const out = validate(PARALLEL, undefined, { limit: 1 });
  assert.equal(out.fallback, false);
  assert.deepEqual(out.cards.map((c) => c.at), [1]);
  assert.deepEqual(out.ownership, [{ path: 'src/quote/**', cardId: 1 }]);
  assert.ok(out.warnings.some((w) => w.code === 'ownershipDropped' && w.at === 2));
});

test('malformed contracts reject the answer too', () => {
  for (const contracts of [[{ ...CONTRACT, kind: 'vibe' }], [{ ...CONTRACT, spec: '' }], [{ kind: 'data', spec: 'x' }], 'nope', ['x']]) {
    const out = validate({ ...PARALLEL, contracts });
    assert.equal(out.fallback, true, JSON.stringify(contracts));
    assert.ok(out.warnings.some((w) => w.code === 'badContracts'), JSON.stringify(contracts));
  }
});

test('the schema offers contracts and ownership, and the prompt explains them', async () => {
  assert.deepEqual(D.DIRECTOR_SCHEMA.properties.contracts.items.properties.kind.enum, [...D.CONTRACT_KINDS]);
  assert.deepEqual(D.DIRECTOR_SCHEMA.properties.ownership.items.required, ['path', 'cardId']);
  assert.deepEqual(D.DIRECTOR_SCHEMA.required, ['cardIds', 'notes'], 'both stay optional');
  const { calls } = await direct({ list: [runCard(1)], answer: { cardIds: [1], notes: '' } });
  assert.match(calls[0].prompt, /ownership: \[\{path, cardId\}\]/);
});

test('runDirector writes CONTRACTS.md, returns the map for God Mode and names each card\'s files', async () => {
  const repoDir = fakeRepo();
  const { res } = await direct({ repoDir, list: [runCard(1), runCard(2)], answer: PARALLEL });
  assert.equal(res.fallback, false);
  assert.equal(res.contractsWritten, true);
  assert.deepEqual(res.ownership, { 'src/quote/**': 1, 'src/pdf.js': 2 });
  assert.deepEqual(res.contracts, [CONTRACT]);
  const md = fs.readFileSync(path.join(repoDir, 'design', 'CONTRACTS.md'), 'utf8');
  assert.match(md, /## quoteTotal \(function\)/);
  assert.match(md, /\| `src\/quote\/\*\*` \| 1 \|/);
  for (const card of res.cards) assert.match(card.details, /respect design\/CONTRACTS\.md; only edit files you own/);
  assert.match(res.cards[0].details, /Files you own: `src\/quote\/\*\*`/);
  assert.match(res.cards[1].details, /Files you own: `src\/pdf\.js`/);
});

test('every builder brief references CONTRACTS.md, map or not', () => {
  assert.match(D.BUILDER_BRIEF, /respect design\/CONTRACTS\.md; only edit files you own/);
  assert.equal(D.withBuilderBrief({ text: 't' }).details, D.BUILDER_BRIEF);
});

test('every builder brief tells the worker to query the code graph before reading files (LW 2.23)', async () => {
  const line = 'Query the code graph (codebase-memory search_graph / trace_path) before reading files.';
  assert.ok(D.BUILDER_BRIEF.split('\n').includes(line));
  assert.ok(D.withBuilderBrief({ text: 't', details: 'do it' }).details.includes(line));
  const { res } = await direct({ list: [runCard(1), runCard(2)], answer: { cardIds: [1, 2], notes: '' } });
  for (const card of res.cards) assert.ok(card.details.includes(line), card.text);
});

test('a later iteration without a map empties a stale CONTRACTS.md; none is created otherwise', async () => {
  const repoDir = fakeRepo();
  await direct({ repoDir, list: [runCard(1), runCard(2)], answer: PARALLEL });
  const { res } = await direct({ repoDir, list: [runCard(1)], answer: { cardIds: [1], notes: '' } });
  assert.equal(res.contractsWritten, false);
  assert.equal(res.ownership, null);
  const md = fs.readFileSync(path.join(repoDir, 'design', 'CONTRACTS.md'), 'utf8');
  assert.doesNotMatch(md, /quoteTotal|src\/pdf\.js/);

  const fresh = fakeRepo();
  await direct({ repoDir: fresh, list: [runCard(1)], answer: { cardIds: [1], notes: '' } });
  assert.equal(fs.existsSync(path.join(fresh, 'design', 'CONTRACTS.md')), false);
});

test('a rejected ownership map still schedules the fallback order, without a map', async () => {
  const repoDir = fakeRepo();
  const answer = { ...PARALLEL, ownership: [{ path: '../x', cardId: 1 }] };
  const { res } = await direct({ repoDir, list: [runCard(1), runCard(2)], answer });
  assert.equal(res.ok, true);
  assert.equal(res.fallback, true);
  assert.equal(res.ownership, null);
  assert.deepEqual([...res.cardIds].sort(), [1, 2]);
  assert.equal(fs.existsSync(path.join(repoDir, 'design', 'CONTRACTS.md')), false);
});

// ---- LW 2.13: roadmap epics ---------------------------------------------------------------

const ROADMAP_MD = [
  '# Roadmap',
  '',
  '## Goal',
  '',
  'Quote steel fast.',
  '',
  '## Milestones',
  '',
  '### Milestone 1: Skeleton',
  '',
  '- [ ] epic:quote-form - Quote form',
  '- [ ] epic:pdf - PDF export',
  '',
].join('\n');

const epicCard = (at, slug, over = {}) => runCard(at, { tags: [RUN_TAG, 'kind:feel', 'sev:medium', `epic:${slug}`], ...over });

function roadmapRepo(md = ROADMAP_MD) {
  const repoDir = fakeRepo();
  fs.writeFileSync(path.join(repoDir, 'design', 'ROADMAP.md'), md);
  return repoDir;
}

test('with an active epic only its cards are on offer; steer cards still come first', async () => {
  const repoDir = roadmapRepo();
  const list = [epicCard(1, 'quote-form'), epicCard(2, 'pdf'), runCard(3), steerCard(10)];
  const { res, calls } = await direct({ repoDir, list, answer: { cardIds: [2, 3, 1], notes: '' } });
  assert.deepEqual(res.cardIds, [10, 1]);
  assert.deepEqual(res.epic, { slug: 'quote-form', title: 'Quote form', milestone: 'Milestone 1: Skeleton' });
  assert.deepEqual(res.epicsTicked, []);
  for (const at of [2, 3]) assert.ok(res.warnings.some((w) => w.code === 'unknownCard' && w.at === at), String(at));
  assert.match(calls[0].prompt, /Active epic \(design\/ROADMAP\.md\): "Quote form" \(epic:quote-form/);
  assert.doesNotMatch(calls[0].prompt, /Card 2|Card 3/);
});

test('steer cards are never cut by the epic, even over the limit', async () => {
  const repoDir = roadmapRepo();
  const steer = Array.from({ length: 7 }, (_, i) => steerCard(100 + i));
  const list = [epicCard(1, 'quote-form'), runCard(2), ...steer];
  const { res } = await direct({ repoDir, list, answer: { cardIds: [1], notes: '' } });
  assert.deepEqual(res.cardIds, steer.map((c) => c.at));
});

test('an epic whose cards are all done is ticked and the next one starts', async () => {
  const repoDir = roadmapRepo();
  const list = [epicCard(1, 'quote-form', { done: true }), epicCard(2, 'quote-form', { done: true }), epicCard(3, 'pdf'), runCard(4)];
  const { res } = await direct({ repoDir, list, answer: { cardIds: [3, 4], notes: '' } });
  assert.deepEqual(res.epicsTicked, ['quote-form']);
  assert.equal(res.epic.slug, 'pdf');
  assert.deepEqual(res.cardIds, [3]);
  // Only the checkbox changed: the Director never rewrites ROADMAP.md.
  const roadmap = fs.readFileSync(path.join(repoDir, 'design', 'ROADMAP.md'), 'utf8');
  assert.equal(roadmap, ROADMAP_MD.replace('- [ ] epic:quote-form', '- [x] epic:quote-form'));
});

test('an epic with open, built or no cards is not ticked', async () => {
  for (const list of [
    [epicCard(1, 'quote-form', { done: true }), epicCard(2, 'quote-form')],
    [epicCard(1, 'quote-form', { state: 'built' })],
    [runCard(4)],
  ]) {
    const repoDir = roadmapRepo();
    const { res } = await direct({ repoDir, list, answer: { cardIds: [2], notes: '' } });
    assert.deepEqual(res.epicsTicked, [], JSON.stringify(list));
    assert.equal(res.epic.slug, 'quote-form');
    assert.equal(fs.readFileSync(path.join(repoDir, 'design', 'ROADMAP.md'), 'utf8'), ROADMAP_MD);
  }
});

test('the last epic done: every epic ticked, no epic filter any more', async () => {
  const repoDir = roadmapRepo();
  const list = [epicCard(1, 'quote-form', { done: true }), epicCard(2, 'pdf', { done: true }), runCard(3)];
  const { res } = await direct({ repoDir, list, answer: { cardIds: [3], notes: '' } });
  assert.deepEqual(res.epicsTicked, ['quote-form', 'pdf']);
  assert.equal(res.epic, null);
  assert.deepEqual(res.cardIds, [3]);
});

test('no ROADMAP epics, or an unparsable ROADMAP.md: every card is on offer as before', async () => {
  for (const md of [Pack.TEMPLATES['ROADMAP.md'], 'random prose, not a roadmap', null]) {
    const repoDir = md === null ? fakeRepo() : roadmapRepo(md);
    if (md === null) fs.rmSync(path.join(repoDir, 'design', 'ROADMAP.md'));
    const list = [epicCard(1, 'quote-form'), runCard(2)];
    const { res } = await direct({ repoDir, list, answer: { cardIds: [2, 1], notes: '' } });
    assert.deepEqual(res.cardIds, [2, 1], String(md));
    assert.equal(res.epic, null);
  }
});
