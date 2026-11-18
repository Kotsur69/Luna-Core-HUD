// 'agy' (the Antigravity CLI) as a worker-model choice: a task card's model
// (src/todorows.js MODELS) and God Mode's worker model pref
// (src/uiprefs.js ORCHESTRA_WORKER_MODELS) accept it, bogus values are still
// rejected, and the to-do widget's rewrite prompt has an agy wording that
// leaves the Claude prompt unchanged.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeTodo, normalizeCardFields, MODELS } = require('../src/todorows.js');
const paths = require('../src/paths.js');
const uiprefs = require('../src/uiprefs.js');
const { refinePrompt } = require('../src/renderer/modules/todo.js');

const BOGUS = ['AGY', 'Agy', 'agy.exe', 'antigravity', 'gemini', ' agy', 'agy ', '', 42, null, ['agy'], { model: 'agy' }];

// ---- task cards ----------------------------------------------------------------

test('a task card keeps model agy', () => {
  assert.ok(MODELS.includes('agy'));
  assert.equal(normalizeCardFields({ model: 'agy' }).model, 'agy');
  assert.equal(normalizeTodo({ text: 'Build it', model: 'agy' }).model, 'agy');
});

test('a task card still drops a bogus model, and the Claude models stay valid', () => {
  for (const bad of BOGUS) {
    assert.equal('model' in normalizeTodo({ text: 'Build it', model: bad }), false, JSON.stringify(bad));
  }
  for (const ok of ['sonnet', 'opus', 'fable']) assert.equal(normalizeTodo({ text: 'x', model: ok }).model, ok);
});

// ---- God Mode worker model pref --------------------------------------------------

/** Points uiprefs at a temp ui.local.json for one test. */
function tempPrefs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-uiprefs-'));
  const origLocal = paths.local;
  const origEnsure = paths.ensureUserDir;
  paths.local = (name) => path.join(dir, name);
  paths.ensureUserDir = () => {};
  t.after(async () => {
    paths.local = origLocal;
    paths.ensureUserDir = origEnsure;
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return path.join(dir, 'ui.local.json');
}

test('orchestraWorkerModel agy round-trips through writeUiPrefs / readUiPrefs', (t) => {
  tempPrefs(t);
  assert.ok(uiprefs.ORCHESTRA_WORKER_MODELS.includes('agy'));
  assert.equal(uiprefs.writeUiPrefs({ orchestraWorkerModel: 'agy' }).orchestraWorkerModel, 'agy');
  assert.equal(uiprefs.readUiPrefs().orchestraWorkerModel, 'agy');
});

test('a bogus orchestraWorkerModel write changes nothing', (t) => {
  tempPrefs(t);
  uiprefs.writeUiPrefs({ orchestraWorkerModel: 'agy' });
  for (const bad of BOGUS) {
    assert.equal(uiprefs.writeUiPrefs({ orchestraWorkerModel: bad }).orchestraWorkerModel, 'agy', JSON.stringify(bad));
  }
  assert.equal(uiprefs.readUiPrefs().orchestraWorkerModel, 'agy');
});

test('a bogus orchestraWorkerModel in the file reads back as the default', (t) => {
  const file = tempPrefs(t);
  for (const bad of BOGUS) {
    fs.writeFileSync(file, JSON.stringify({ orchestraWorkerModel: bad }), 'utf8');
    assert.equal(uiprefs.readUiPrefs().orchestraWorkerModel, 'opus', JSON.stringify(bad));
  }
});

test('orchestraWorkerModel agy:<id> round-trips; a malformed variant is refused', (t) => {
  tempPrefs(t);
  assert.equal(uiprefs.writeUiPrefs({ orchestraWorkerModel: 'agy:gemini-4-argon-medium' }).orchestraWorkerModel, 'agy:gemini-4-argon-medium');
  assert.equal(uiprefs.readUiPrefs().orchestraWorkerModel, 'agy:gemini-4-argon-medium');
  for (const bad of ['agy:', 'agy:--print', "agy:a'b", 'agy:a b', `agy:${'a'.repeat(81)}`]) {
    assert.equal(uiprefs.writeUiPrefs({ orchestraWorkerModel: bad }).orchestraWorkerModel, 'agy:gemini-4-argon-medium', bad);
  }
});

// ---- `agy models`: parsing, the live cache, the one isAgyModel helper -------------

const agyModels = require('../src/agymodels.js');
const shared = require('../src/workerModels.js');

const MODELS_OUT = [
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-thinking\tClaude Opus 5.5 (Thinking)',
  '',
].join('\r\n');

test('parseAgyModels reads <id>\\t<name> lines in order', () => {
  assert.deepEqual(agyModels.parseAgyModels(MODELS_OUT), [
    { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
    { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { id: 'claude-opus-5-5-thinking', name: 'Claude Opus 5.5 (Thinking)' },
  ]);
});

test('parseAgyModels skips headers, junk ids and repeats; strips escape codes; a nameless id names itself', () => {
  const out = [
    'ID\tNAME',
    'Available models:',
    '\u001b[1mgemini-4-argon-medium\u001b[0m\tGemini\u0007 4 Argon',
    'gemini-4-argon-medium\tDuplicate',
    '--print\tA flag',
    "it's\tquote",
    'gemini-x  spaced name',
    'lonely-id',
    `${'a'.repeat(81)}\ttoo long`,
  ].join('\n');
  assert.deepEqual(agyModels.parseAgyModels(out), [
    { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon' },
    { id: 'gemini-x', name: 'spaced name' },
    { id: 'lonely-id', name: 'lonely-id' },
  ]);
  assert.deepEqual(agyModels.parseAgyModels(''), []);
  assert.deepEqual(agyModels.parseAgyModels(null), []);
  const many = Array.from({ length: 150 }, (_, i) => `m${i}\tM${i}`).join('\n');
  assert.equal(agyModels.parseAgyModels(many).length, agyModels.MAX_AGY_MODELS);
});

/** A fake execFile for `agy models`: records calls, answers {stdout} or {error}. */
function fakeAgy(answer) {
  const calls = [];
  const execImpl = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    setImmediate(() => cb(answer.error || null, answer.stdout || '', answer.stderr || ''));
  };
  return { calls, execImpl };
}

test('createAgyModels: runs `agy models` hidden with a kill timer in the given env, caches and offers variants', async () => {
  const { calls, execImpl } = fakeAgy({ stdout: MODELS_OUT });
  const env = { PATH: 'x' };
  const cache = agyModels.createAgyModels({ execImpl, envOf: () => env });
  assert.equal(cache.isLoaded(), false);
  assert.equal((await cache.ensure()).length, 4);
  await cache.ensure();
  assert.equal(calls.length, 1, 'ensure reads once');
  assert.equal(calls[0].bin, 'agy');
  assert.deepEqual(calls[0].args, ['models']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.timeout, agyModels.AGY_MODELS_TIMEOUT_MS);
  assert.equal(calls[0].opts.env, env);
  assert.deepEqual(cache.choices().slice(0, 2), [
    { id: 'agy', name: 'Antigravity' },
    { id: 'agy:gemini-4-argon-medium', name: 'Antigravity - Gemini 4 Argon (Medium)' },
  ]);
  assert.equal(cache.isKnownId('gemini-3.8-flash-low'), true);
  assert.equal(cache.isKnownId('gemini-9'), false);
  assert.equal(cache.resolveModelId('agy:gemini-4-hydrogen-high'), 'gemini-4-hydrogen-high');
  assert.equal(cache.resolveModelId('agy'), null);
  await cache.refresh();
  assert.equal(calls.length, 2, 'refresh reads again');
});

test('createAgyModels: two refreshes at once share one agy call', async () => {
  const { calls, execImpl } = fakeAgy({ stdout: MODELS_OUT });
  const cache = agyModels.createAgyModels({ execImpl });
  await Promise.all([cache.refresh(), cache.refresh(), cache.ensure()]);
  assert.equal(calls.length, 1);
});

test('createAgyModels: missing agy, a timeout, a failure or an empty list offer only plain agy and log why', async () => {
  const answers = [
    { error: Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }) },
    { error: Object.assign(new Error('killed'), { killed: true }) },
    { error: new Error('exit 1'), stderr: 'not signed in' },
    { stdout: 'No models available\n' },
  ];
  for (const answer of answers) {
    const lines = [];
    const { execImpl } = fakeAgy(answer);
    const cache = agyModels.createAgyModels({ execImpl, log: (l) => lines.push(l) });
    assert.deepEqual(await cache.refresh(), []);
    assert.deepEqual(cache.choices(), [{ id: 'agy', name: 'Antigravity' }]);
    assert.equal(lines.length, 1, JSON.stringify(answer));
    assert.match(lines[0], /\[agymodels\]/);
  }
});

test('createAgyModels: a failed call offers no variant but keeps the last good ids for checking', async () => {
  let ok = true;
  const execImpl = (bin, args, opts, cb) => setImmediate(() => (ok ? cb(null, MODELS_OUT, '') : cb(new Error('boom'), '', '')));
  const cache = agyModels.createAgyModels({ execImpl });
  await cache.refresh();
  assert.equal(cache.isKnownId('gemini-4-argon-medium'), true);
  ok = false;
  assert.deepEqual(await cache.refresh(), []);
  assert.deepEqual(cache.choices(), [{ id: 'agy', name: 'Antigravity' }], 'the pickers offer only plain agy');
  // An approved run's variant does not silently drop to agy's default on one hiccup.
  assert.equal(cache.isKnownId('gemini-4-argon-medium'), true);
  assert.equal(cache.resolveModelId('agy:gemini-4-argon-medium'), 'gemini-4-argon-medium');
  ok = true;
  await cache.refresh();
  assert.equal(cache.choices().length, 5);
});

test('createAgyModels: until one call works, ensure() keeps trying (not faster than FAILED_RETRY_MS); an execFile that throws resolves too', async () => {
  let ok = false;
  let calls = 0;
  let clock = 1000;
  const execImpl = (bin, args, opts, cb) => {
    calls += 1;
    setImmediate(() => (ok ? cb(null, MODELS_OUT, '') : cb(Object.assign(new Error('killed'), { killed: true }), '', '')));
  };
  const cache = agyModels.createAgyModels({ execImpl, now: () => clock });
  await cache.ensure();
  assert.equal(cache.isLoaded(), false);
  ok = true;
  // A hanging agy is not spawned again by every caller right after a failure.
  clock += agyModels.FAILED_RETRY_MS - 1;
  assert.deepEqual(await cache.ensure(), []);
  assert.equal(calls, 1, 'inside the retry window: no new call');
  clock += 1;
  await cache.ensure();
  assert.equal(calls, 2);
  assert.equal(cache.isLoaded(), true);
  await cache.ensure();
  assert.equal(calls, 2, 'loaded: no more calls');
  const throwing = agyModels.createAgyModels({ execImpl: () => { throw new Error('EPERM'); }, envOf: () => { throw new Error('no env'); } });
  assert.deepEqual(await throwing.refresh(), []);
});

test('createAgyModels: refresh({minIntervalMs}) answers from the cache inside the interval; agy never runs in a project folder', async () => {
  let clock = 1000;
  const { calls, execImpl } = fakeAgy({ stdout: MODELS_OUT });
  const cache = agyModels.createAgyModels({ execImpl, now: () => clock });
  await cache.refresh({ minIntervalMs: 10000 });
  clock += 5000;
  assert.equal((await cache.refresh({ minIntervalMs: 10000 })).length, 4);
  assert.equal(calls.length, 1);
  clock += 6000;
  await cache.refresh({ minIntervalMs: 10000 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.cwd, require('os').homedir());
});

test('cleanName drops control, bidi and zero-width characters', () => {
  assert.equal(agyModels.cleanName('Gemini‮ 4​ Argon x\u0007'), 'Gemini 4 Argon x');
});

test('resolveModelId: an id the list does not hold is logged and never handed on', async () => {
  const lines = [];
  const cache = agyModels.createAgyModels({ execImpl: fakeAgy({ stdout: MODELS_OUT }).execImpl, log: (l) => lines.push(l) });
  assert.equal(cache.resolveModelId('agy:gemini-4-argon-medium'), null, 'not read yet');
  await cache.ensure();
  assert.equal(cache.resolveModelId('agy:gemini-9-made-up'), null);
  assert.equal(cache.resolveModelId('agy:--print'), null);
  assert.equal(lines.length, 2);
});

test('sharedAgyModels: main can set the process-wide cache', () => {
  const mine = agyModels.createAgyModels();
  agyModels.setSharedAgyModels(mine);
  assert.equal(agyModels.sharedAgyModels(), mine);
  agyModels.setSharedAgyModels(null);
  assert.notEqual(agyModels.sharedAgyModels(), mine);
});

test('isAgyModel: true for agy and well-formed agy:<id>, false for everything else', () => {
  for (const ok of ['agy', 'agy:gemini-4-argon-medium', 'agy:gemini-3.8-flash-low', 'agy:claude-opus-5-5-thinking']) {
    assert.equal(shared.isAgyModel(ok), true, ok);
    assert.equal(shared.isWorkerModel(ok), true, ok);
    assert.equal(shared.isCardModel(ok), true, ok);
  }
  for (const bad of ['agy:', 'agy:-x', 'agy:--model', 'agy:a b', "agy:a'b", 'agy:a/b', 'agy::x', 'AGY:x', 'agy :x', `agy:${'a'.repeat(81)}`, 'opus', null, 42]) {
    assert.equal(shared.isAgyModel(bad), false, String(bad));
    assert.equal(shared.isWorkerModel(bad), bad === 'opus', String(bad));
  }
  assert.equal(shared.agyModelIdOf('agy:gemini-4-argon-medium'), 'gemini-4-argon-medium');
  assert.equal(shared.agyModelIdOf('agy'), null);
  assert.equal(shared.agyVariant('gemini-4-argon-medium'), 'agy:gemini-4-argon-medium');
  assert.equal(shared.agyVariant('--x'), null);
  assert.equal(shared.agyModelLabel('agy'), 'Antigravity');
  assert.equal(shared.agyModelLabel('agy:x1', { x1: 'X One' }), 'Antigravity - X One');
  assert.equal(shared.agyModelLabel('agy:x1', { constructor: 'no' }), 'Antigravity - x1');
  assert.equal(shared.agyModelLabel('opus'), null);
});

test('no exact agy equality is left in the God Mode worker paths: they all use isAgyModel', () => {
  const ROOT = path.join(__dirname, '..');
  const files = [
    'src/orchestraAgy.js',
    'src/agyexec.js',
    'src/launch.js',
    'src/orchestraPlan.js',
    'src/renderer/modules/orchestraWorkerModelRules.js',
    'mobile/src/godmodeplanmodel.js',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // A model value (model, workerModel, modelOverride, argValue(args, '--model')) compared with plain agy.
    assert.doesNotMatch(src, /(model|Model|Override)\b['"]?\)?\s*[!=]==\s*(AGY_MODEL\b|AGY\b|'agy')/, `${rel} compares a model with plain agy`);
  }
});

// ---- rewrite prompt in an agy tab --------------------------------------------------

const NOTE = { text: 'icons on collapsed panels', done: false, at: 1712 };

test('the Claude rewrite prompt is unchanged by the agy option', () => {
  const claude = refinePrompt(NOTE);
  assert.equal(refinePrompt(NOTE, undefined), claude);
  assert.equal(refinePrompt(NOTE, { cli: null, server: null }), claude);
  assert.equal(refinePrompt(NOTE, { cli: 'claude', server: 'lunacore-s1' }), claude);
  assert.match(claude, /AskUserQuestion/);
});

test('an agy tab gets a prompt without AskUserQuestion that names its own server', () => {
  const prompt = refinePrompt(NOTE, { cli: 'agy', server: 'lunacore-s7' });
  assert.doesNotMatch(prompt, /AskUserQuestion/);
  assert.match(prompt, /luna_todo_update tool of the `lunacore-s7` MCP server \(at=1712\)/);
  assert.match(prompt, /icons on collapsed panels/);
  assert.match(prompt, /set `original` to my note/);
  assert.match(prompt, /Do not implement anything/);
});

test('an agy prompt never names a server that is not a LunaCore entry name', () => {
  for (const server of ['other-server', 'lunacore-a b', 'lunacore-`x`', 'lunacore-', `lunacore-${'a'.repeat(65)}`, 42, null]) {
    const prompt = refinePrompt(NOTE, { cli: 'agy', server });
    assert.match(prompt, /Save it with the luna_todo_update tool \(at=1712\)/, String(server));
    assert.doesNotMatch(prompt, /MCP server/, String(server));
  }
});
