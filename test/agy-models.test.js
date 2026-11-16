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
