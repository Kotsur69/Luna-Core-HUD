// ============================================================================
// Luna's Work second opinion (LW 2.20): runs only at milestone gates, picks
// the first installed + logged-in CLI of the order, validates the reply with
// the Critic's rules, merges/de-dupes findings with the source marked, blocks
// the gate on a disagreement, and skips with a note when no CLI is usable.
// Every CLI here is a fake detector / runner; the default detector runs on a
// fake file system.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const S = require('../src/lunasworkSecondOpinion.js');
const { REPRO_ACCEPTANCE } = require('../src/lunasworkCritic.js');

const LOG_ENTRY = { played: 'p', good: [], bad: [], broken: [], missing: [], scores: '', verdict: '' };
const critique = (cards, verdict = 'CONTINUE') => ({
  cards, logEntry: LOG_ENTRY, architecture: '', decisions: [], newJourneys: [], verdict,
});
const card = (text, kind = 'feel', severity = 'low') => ({ kind, severity, text, details: '', acceptance: [], files: [] });

const INPUTS = { playtestReport: { scores: [{ criterion: 'starts', score: 8 }] }, designPack: 'DESIGN_MARKER', gateDiff: 'diff --git a/g.js b/g.js' };

/** Fake detector over a table {cli: {installed, loggedIn}}. */
const detector = (table) => {
  const asked = [];
  const detect = (cli) => { asked.push(cli); return table[cli] || { installed: false, loggedIn: false }; };
  return { detect, asked };
};

/** Fake runner that records calls and answers with `stdout`. */
const runner = (stdout) => {
  const calls = [];
  const runCli = async (call) => { calls.push(call); return typeof stdout === 'function' ? stdout(call) : { stdout }; };
  return { runCli, calls };
};

// ---- runSecondOpinion -------------------------------------------------------------

test('runSecondOpinion: never runs outside a milestone gate', async () => {
  const d = detector({ codex: { installed: true, loggedIn: true } });
  const r = runner(JSON.stringify(critique([])));
  const out = await S.runSecondOpinion({ isGate: false, inputs: INPUTS, detect: d.detect, runCli: r.runCli });
  assert.equal(out.skipped, true);
  assert.match(out.note, /not a milestone gate/);
  assert.equal(d.asked.length, 0);
  assert.equal(r.calls.length, 0);
});

test('runSecondOpinion: picks the first installed and logged-in CLI of the order', async () => {
  const d = detector({ codex: { installed: true, loggedIn: false }, gemini: { installed: true, loggedIn: true } });
  const r = runner(JSON.stringify({ response: JSON.stringify(critique([card('Jump feels floaty')])) }));
  const out = await S.runSecondOpinion({ isGate: true, inputs: INPUTS, detect: d.detect, runCli: r.runCli });
  assert.deepEqual(d.asked, ['codex', 'gemini']);
  assert.equal(out.skipped, false);
  assert.equal(out.ok, true);
  assert.equal(out.cli, 'gemini');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].command, 'gemini');
  assert.deepEqual(r.calls[0].args, S.SECOND_OPINION_CLIS.gemini.args);
  assert.equal(out.verdict, 'continue');
  assert.deepEqual(out.cards.map((c) => c.text), ['Jump feels floaty']);
});

test('runSecondOpinion: a configured order wins over the default', async () => {
  const d = detector({ codex: { installed: true, loggedIn: true }, gemini: { installed: true, loggedIn: true } });
  const r = runner(JSON.stringify(critique([])));
  const out = await S.runSecondOpinion({ isGate: true, inputs: INPUTS, order: ['gemini', 'codex'], detect: d.detect, runCli: r.runCli });
  assert.equal(out.cli, 'gemini');
  assert.deepEqual(d.asked, ['gemini']);
});

test('runSecondOpinion: codex runs read-only over the Critic inputs and its JSON shape', async () => {
  const d = detector({ codex: { installed: true, loggedIn: true } });
  const r = runner(`Here is my review:\n\`\`\`json\n${JSON.stringify(critique([card('Crash on save', 'bug', 'high')]))}\n\`\`\`\n`);
  const out = await S.runSecondOpinion({ isGate: true, inputs: INPUTS, detect: d.detect, runCli: r.runCli, cwd: __dirname });
  const call = r.calls[0];
  assert.equal(call.command, 'codex');
  assert.deepEqual(call.args.slice(0, 3), ['exec', '--sandbox', 'read-only']);
  assert.equal(call.cwd, __dirname);
  assert.match(call.prompt, /READ-ONLY/);
  assert.match(call.prompt, /DESIGN_MARKER/);
  assert.match(call.prompt, /diff --git a\/g\.js/);
  assert.match(call.prompt, /"criterion": "starts"/);
  assert.match(call.prompt, /"logEntry"/);
  // The Critic's validation: a bug card gets its repro test.
  assert.equal(out.cards[0].acceptance[0], REPRO_ACCEPTANCE);
});

test('runSecondOpinion: SHIP before every gate passes is downgraded like the Critic', async () => {
  const d = detector({ codex: { installed: true, loggedIn: true } });
  const r = runner(JSON.stringify(critique([], 'SHIP')));
  const early = await S.runSecondOpinion({ isGate: true, inputs: INPUTS, detect: d.detect, runCli: r.runCli });
  assert.equal(early.verdict, 'continue');
  assert.ok(early.warnings.some((w) => w.code === 'shipBeforeGates'));
  const late = await S.runSecondOpinion({ isGate: true, inputs: INPUTS, detect: d.detect, runCli: r.runCli, allPassed: true });
  assert.equal(late.verdict, 'ship');
});

test('runSecondOpinion: missing or logged-out CLIs are skipped with a note', async () => {
  const none = await S.runSecondOpinion({ isGate: true, inputs: INPUTS, detect: detector({}).detect, runCli: runner('').runCli });
  assert.deepEqual(none, { skipped: true, note: 'second opinion skipped: codex not installed, gemini not installed' });
  const loggedOut = await S.runSecondOpinion({
    isGate: true,
    inputs: INPUTS,
    detect: detector({ codex: { installed: true, loggedIn: false } }).detect,
    runCli: runner('').runCli,
  });
  assert.equal(loggedOut.skipped, true);
  assert.match(loggedOut.note, /codex not logged in/);
  const throwing = await S.runSecondOpinion({ isGate: true, inputs: INPUTS, detect: () => { throw new Error('boom'); } });
  assert.equal(throwing.skipped, true);
});

test('runSecondOpinion: a failing or garbled CLI never throws', async () => {
  const d = detector({ codex: { installed: true, loggedIn: true } });
  const crash = await S.runSecondOpinion({ isGate: true, detect: d.detect, runCli: async () => { throw new Error('kaput'); } });
  assert.equal(crash.ok, false);
  assert.deepEqual(crash.cards, []);
  assert.match(crash.notes[0], /^codex second opinion failed: crashed \(kaput\)/);
  const timeout = await S.runSecondOpinion({ isGate: true, detect: d.detect, runCli: async () => ({ error: 'timeout' }) });
  assert.deepEqual(timeout.notes, ['codex second opinion failed: timeout']);
  const garbled = await S.runSecondOpinion({ isGate: true, detect: d.detect, runCli: runner('no json here').runCli });
  assert.deepEqual(garbled.notes, ['codex second opinion failed: badJson']);
  const wrongShape = await S.runSecondOpinion({ isGate: true, detect: d.detect, runCli: runner('{"cards": []}').runCli });
  assert.deepEqual(wrongShape.notes, ['codex second opinion failed: badCritique']);
});

// ---- mergeFindings ------------------------------------------------------------------

test('mergeFindings: near-duplicates go, kept second-opinion cards are marked', () => {
  const critic = [card('Player falls through the floor at level 2', 'bug', 'high')];
  const second = [
    card('player falls through floor in level 2', 'bug', 'high'),
    card('Score counter overlaps the pause button'),
    card('Score counter overlaps pause button!'),
  ];
  const merged = S.mergeFindings(critic, second);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], critic[0]);
  assert.equal(merged[0].source, undefined);
  assert.equal(merged[1].text, 'Score counter overlaps the pause button');
  assert.equal(merged[1].source, S.SECOND_OPINION_SOURCE);
  assert.equal(merged[1].source, 'second opinion');
  assert.deepEqual(merged[1].extraTags, ['second-opinion']);
  // Inputs are not mutated.
  assert.equal(second[1].source, undefined);
});

test('mergeFindings: distinct findings are all kept; junk is ignored', () => {
  const merged = S.mergeFindings([card('Save button does nothing')], [card('Music never loops'), null, { text: '' }]);
  assert.deepEqual(merged.map((c) => c.text), ['Save button does nothing', 'Music never loops']);
  assert.deepEqual(S.mergeFindings(undefined, undefined), []);
});

test('textSimilarity: same words score 1, unrelated 0', () => {
  assert.equal(S.textSimilarity('The jump is floaty', 'jump is floaty'), 1);
  assert.equal(S.textSimilarity('Save fails', 'Music loops'), 0);
  assert.equal(S.textSimilarity('', 'x'), 0);
});

// ---- gateVerdict --------------------------------------------------------------------

test('gateVerdict: agreement keeps the Critic call', () => {
  const second = { skipped: false, ok: true, cli: 'codex', verdict: 'continue', cards: [card('minor polish')] };
  assert.deepEqual(S.gateVerdict({ passed: true, verdict: 'continue' }, second), { passed: true, disagreement: null });
  assert.deepEqual(S.gateVerdict({ passed: false, verdict: 'continue' }, second), { passed: false, disagreement: null });
});

test('gateVerdict: differing verdicts block the gate', () => {
  const out = S.gateVerdict(
    { milestone: { name: 'M1', passed: true }, verdict: 'ship' },
    { skipped: false, ok: true, cli: 'gemini', verdict: 'continue', cards: [] },
  );
  assert.equal(out.passed, false);
  assert.equal(out.disagreement.reason, 'verdict');
  assert.deepEqual(out.disagreement.critic, { verdict: 'ship', passed: true });
  assert.equal(out.disagreement.second.cli, 'gemini');
  assert.deepEqual(out.disagreement.resolveBy, ['nextCritic', 'decisionQueue']);
});

test('gateVerdict: a gate the Critic passes is blocked by second-opinion bugs or blockers', () => {
  const out = S.gateVerdict(
    { passed: true, verdict: 'continue' },
    { skipped: false, ok: true, cli: 'codex', verdict: 'continue', cards: [card('Crash on save', 'bug', 'high'), card('nit')] },
  );
  assert.equal(out.passed, false);
  assert.equal(out.disagreement.reason, 'blockingFindings');
  assert.deepEqual(out.disagreement.second.blocking, ['Crash on save']);
});

test('gateVerdict: a skipped or failed second opinion leaves the gate to the Critic', () => {
  assert.deepEqual(S.gateVerdict({ passed: true, verdict: 'continue' }, { skipped: true, note: 'x' }), { passed: true, disagreement: null });
  assert.deepEqual(S.gateVerdict({ passed: true, verdict: 'ship' }, { skipped: false, ok: false, verdict: null }), { passed: true, disagreement: null });
  assert.deepEqual(S.gateVerdict(null, null), { passed: false, disagreement: null });
});

// ---- detection and runner -----------------------------------------------------------

/** Fake file system: a set of existing paths and a map of file contents. */
function fakeFs({ files = {}, onPath = [] } = {}) {
  return {
    homedir: () => '/home/luna',
    platform: 'linux',
    exists: (p) => onPath.includes(p),
    readFile: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
  };
}

test('detectCli: installed means on PATH, logged in means a cached login or key', () => {
  const env = { PATH: '/usr/bin:/opt/bin' };
  const codexAuth = path.join('/home/luna', '.codex', 'auth.json');
  const geminiCreds = path.join('/home/luna', '.gemini', 'oauth_creds.json');
  const both = fakeFs({
    onPath: ['/usr/bin/codex', '/opt/bin/gemini'],
    files: { [codexAuth]: JSON.stringify({ tokens: { access_token: 't' } }), [geminiCreds]: JSON.stringify({ refresh_token: 'r' }) },
  });
  assert.deepEqual(S.detectCli('codex', { ...both, env }), { installed: true, loggedIn: true });
  assert.deepEqual(S.detectCli('gemini', { ...both, env }), { installed: true, loggedIn: true });

  const noLogin = fakeFs({ onPath: ['/usr/bin/codex', '/usr/bin/gemini'] });
  assert.deepEqual(S.detectCli('codex', { ...noLogin, env }), { installed: true, loggedIn: false });
  assert.deepEqual(S.detectCli('gemini', { ...noLogin, env }), { installed: true, loggedIn: false });
  assert.deepEqual(S.detectCli('gemini', { ...noLogin, env: { ...env, GEMINI_API_KEY: 'k' } }), { installed: true, loggedIn: true });

  assert.deepEqual(S.detectCli('codex', { ...fakeFs(), env }), { installed: false, loggedIn: false });
  assert.deepEqual(S.detectCli('claude', { ...both, env }), { installed: false, loggedIn: false });
});

test('detectCli: Windows PATHEXT finds an npm .cmd shim', () => {
  const deps = {
    ...fakeFs({ onPath: [path.win32.join('C:\\npm', 'codex.cmd')] }),
    platform: 'win32',
    env: { Path: 'C:\\Windows;C:\\npm', PATHEXT: '.EXE;.CMD' },
  };
  assert.equal(S.detectCli('codex', deps).installed, true);
});

test('execCli: prompt on stdin, shell only on Windows, unsafe args refused', async () => {
  const seen = [];
  const fakeExec = (command, args, options, cb) => {
    seen.push({ command, args, options });
    const stdin = { on: () => {}, end: (text) => { seen[seen.length - 1].stdin = text; cb(null, '{"ok":1}'); } };
    return { stdin };
  };
  const out = await S.execCli({ command: 'codex', args: ['exec', '-'], prompt: 'hello', execImpl: fakeExec, platform: 'win32' });
  assert.deepEqual(out, { stdout: '{"ok":1}' });
  assert.equal(seen[0].stdin, 'hello');
  assert.equal(seen[0].options.shell, true);
  assert.equal(seen[0].command, 'codex exec -');
  assert.deepEqual(seen[0].args, []);
  await S.execCli({ command: 'codex', args: ['exec'], prompt: '', execImpl: fakeExec, platform: 'linux' });
  assert.equal(seen[1].options.shell, false);
  assert.equal(seen[1].command, 'codex');
  assert.deepEqual(seen[1].args, ['exec']);
  const unsafe = await S.execCli({ command: 'codex', args: ['exec', 'a & del x'], prompt: '', execImpl: fakeExec });
  assert.deepEqual(unsafe, { error: 'unsafeArgs' });
  assert.equal(seen.length, 2);
  const missing = await S.execCli({ command: 'codex', args: [], prompt: '', execImpl: (c, a, o, cb) => { cb(Object.assign(new Error('x'), { code: 'ENOENT' }), ''); return null; } });
  assert.deepEqual(missing, { error: 'notInstalled' });
});

test('parseCliOutput: plain, gemini envelope, fenced; junk is badJson', () => {
  assert.deepEqual(S.parseCliOutput('{"a":1}'), { ok: true, raw: { a: 1 } });
  assert.deepEqual(S.parseCliOutput(JSON.stringify({ response: '```json\n{"b":2}\n```' })), { ok: true, raw: { b: 2 } });
  assert.deepEqual(S.parseCliOutput('text {"c":3} more'), { ok: true, raw: { c: 3 } });
  assert.deepEqual(S.parseCliOutput('nope'), { ok: false, error: 'badJson' });
  assert.deepEqual(S.parseCliOutput(''), { ok: false, error: 'badJson' });
});
