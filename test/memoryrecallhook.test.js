// ============================================================================
// LunaCore - the auto-recall switch and a tab's UserPromptSubmit hook
// (src/memoryrecallhook.js, its IPC in src/memoryipc.js, preload, renderer)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = require('../src/memoryrecallhook.js');
const { memoryPaths } = require('../src/memorysync.js');
const { setEnabled } = require('../src/memoryprojects.js');
const { registerMemoryIpc } = require('../src/memoryipc.js');

const PROJECT = 'github.com/acme/hud';
const TOKEN = 'ab12'.repeat(16);
const URL = 'http://127.0.0.1:41234/recall';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-recallhook-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the switch is off by default, on only for a literal true, and an unreadable file is off', (t) => {
  const file = memoryPaths(tmp(t)).recall;
  assert.equal(path.basename(file), 'memory-recall.local.json');
  assert.equal(hook.readAutoRecall(file), false);

  assert.equal(hook.setAutoRecall(file, true), true);
  assert.equal(hook.readAutoRecall(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { memoryAutoRecall: true });
  hook.setAutoRecall(file, false);
  assert.equal(hook.readAutoRecall(file), false);

  fs.writeFileSync(file, JSON.stringify({ memoryAutoRecall: 'yes' }));
  assert.equal(hook.readAutoRecall(file), false);
  const quiet = t.mock.method(console, 'error', () => {});
  fs.writeFileSync(file, '{broken');
  assert.equal(hook.readAutoRecall(file), false);
  assert.equal(quiet.mock.callCount(), 1);
  assert.throws(() => hook.setAutoRecall(file, 'on'), /bad-switch/);
});

test('the switch syncs as one config unit, like the auto-accept switches', (t) => {
  const file = memoryPaths(tmp(t)).recall;
  const provider = hook.createAutoRecallProvider(file);

  assert.equal(provider.owns(hook.UNIT_KEY), true);
  assert.equal(provider.owns('memory-auto:gotcha'), false);
  assert.deepEqual(provider.valid(hook.UNIT_KEY, { on: true, extra: 1 }), { on: true });
  assert.equal(provider.valid(hook.UNIT_KEY, { on: 'true' }), null);
  assert.equal(provider.valid('memory-recall:other', { on: true }), null);

  const fresh = provider.read(Date.now());
  assert.deepEqual([fresh.units, fresh.fresh], [[], true]);
  provider.write([[hook.UNIT_KEY, { on: true }]]);
  assert.deepEqual(provider.read(Date.now()).units, [[hook.UNIT_KEY, { on: true }]]);
  provider.write([]);
  assert.deepEqual(provider.read(Date.now()).units, []);
  assert.equal(hook.readAutoRecall(file), false);
});

test('configsync registers the provider next to the auto-accept one', () => {
  const src = read('src/configsync.js');
  assert.ok(src.indexOf('createAutoRecallProvider(memoryPaths(paths.userDir()).recall)') > src.indexOf('createAutoAcceptProvider(memoryPaths(paths.userDir()).autoAccept)'));
});

test('a tab recalls only with the switch on and memory on for its project', (t) => {
  const p = memoryPaths(tmp(t));
  const ctx = { recallFile: p.recall, projectsFile: p.projects, project: PROJECT };
  assert.equal(hook.recallProject(ctx), null);
  hook.setAutoRecall(p.recall, true);
  assert.equal(hook.recallProject(ctx), null, 'memory off for the project');
  setEnabled(p.projects, PROJECT, true);
  assert.equal(hook.recallProject(ctx), PROJECT);
  assert.equal(hook.recallProject({ ...ctx, project: null }), null);
  assert.equal(hook.recallProject({ ...ctx, project: 'github.com/acme/other' }), null);
});

test('the hook settings: one HTTP UserPromptSubmit hook to /recall with the tab token and a short timeout', (t) => {
  const dir = tmp(t);
  const file = hook.prepareRecallHook({ dir, sessionId: 's3', url: URL, token: TOKEN, on: true });

  assert.equal(file, path.join(dir, 'recall-hook-s3.local.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` }, timeout: hook.HOOK_TIMEOUT_S }] }] },
  });
  assert.ok(hook.HOOK_TIMEOUT_S <= 2);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // Off again: the next start of the tab removes it.
  assert.equal(hook.prepareRecallHook({ dir, sessionId: 's3', url: URL, token: TOKEN, on: false }), null);
  assert.equal(fs.existsSync(file), false);
});

test('a hook is never written for a foreign URL, an odd token or session id; removing a missing one is fine', (t) => {
  const dir = tmp(t);
  const ok = { dir, sessionId: 's1', url: URL, token: TOKEN, on: true };
  for (const bad of [{ url: 'http://evil.example/recall' }, { url: 'http://127.0.0.1:1/mcp' }, { token: 'short' }, { token: `${TOKEN}"` }, { sessionId: '../x' }]) {
    assert.equal(hook.prepareRecallHook({ ...ok, ...bad }), null, JSON.stringify(bad));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  hook.removeRecallHook(dir, 's9');
  hook.removeRecallHook(dir, '../../etc');
});

test('withRecallHook adds --settings to a plain claude launch only', () => {
  const file = 'C:\\cfg\\recall-hook-s3.local.json';
  assert.equal(hook.withRecallHook('claude --mcp-config x', file), `claude --mcp-config x --settings '${file}'`);
  assert.equal(hook.withRecallHook('claude', null), 'claude');
  for (const cmd of ['agy --mode plan', 'bash', 'claude --bare', 'claude --settings other.json', 'claude --strict-mcp-config --mcp-config x']) {
    assert.equal(hook.withRecallHook(cmd, file), cmd, cmd);
  }
  assert.equal(hook.withRecallHook('claude', "C:\\it's\\file.json"), 'claude');
});

test('memory:recall-set takes a boolean only, writes the switch and syncs; memory:inbox reports it', async (t) => {
  const p = memoryPaths(tmp(t));
  const handlers = {};
  let synced = 0;
  registerMemoryIpc({
    ipcMain: { handle: (channel, fn) => (handlers[channel] = fn) },
    dir: () => p.dir,
    autoFile: () => p.autoAccept,
    recallFile: () => p.recall,
    onSettingsChanged: () => {
      synced += 1;
    },
  });

  for (const bad of [null, {}, { on: 'true' }, 'on', { on: 1 }]) assert.deepEqual(await handlers['memory:recall-set']({}, bad), { ok: false, reason: 'bad-request' });
  assert.equal(synced, 0);
  assert.deepEqual(await handlers['memory:recall-set']({}, { on: true, extra: 'ignored' }), { ok: true, on: true });
  assert.equal(hook.readAutoRecall(p.recall), true);
  assert.equal(synced, 1);

  const inbox = await handlers['memory:inbox']();
  assert.deepEqual(inbox.auto.recall, { id: 'recall', on: true });
});

test('preload exposes the switch with a boolean guard, and the window routes it there', () => {
  const preload = read('src/preload.js');
  assert.match(preload, /memoryAutoRecallSet: \(on\) => ipcRenderer\.invoke\('memory:recall-set', \{ on: on === true \}\)/);
  const inbox = read('src/renderer/modules/memoryinbox.js');
  assert.match(inbox, /type === RECALL_SWITCH \? await call\('memoryAutoRecallSet', on\)/);
  const panel = read('src/renderer/modules/memoryautopanel.js');
  assert.match(panel, /export const RECALL_SWITCH = 'recall';/);
  const i18n = read('src/renderer/i18n.js');
  for (const k of ['mem.auto.recallTitle', 'mem.auto.recall', 'mem.auto.recallHint', 'mem.inbox.review.failing']) {
    assert.equal(i18n.split(`'${k}':`).length - 1, 2, `${k} in pl and en`);
  }
});

test('main wires the hook, the store recall and the cleanup', () => {
  const main = read('src/main.js');
  assert.match(main, /prepareRecallHook\(\{ dir: userDir\(\), sessionId: session\.id, url: intakeServer\.recallUrl\(\), token,/);
  assert.match(main, /recallHookLaunch\(carded, \{ claude, file: session\.recallHook, dir: userDir\(\), sessionId: session\.id \}\)/);
  assert.match(main, /recall: recallFor\(session\)/);
  assert.equal(main.split('removeRecallHook(userDir(),').length - 1, 2);
  assert.match(main, /recallFile: \(\) => memoryPaths\(userDir\(\)\)\.recall/);
});

test('a hook file left from an earlier start is replaced, never written into', (t) => {
  const dir = tmp(t);
  const old = hook.hookSettingsPath(dir, 's4');
  fs.writeFileSync(old, 'stale token');
  if (process.platform !== 'win32') fs.chmodSync(old, 0o644);

  const file = hook.prepareRecallHook({ dir, sessionId: 's4', url: URL, token: TOKEN, on: true });

  assert.equal(file, old);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].headers.Authorization, `Bearer ${TOKEN}`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('recallHookLaunch keeps the file only when the command carries it, and deletes it otherwise', (t) => {
  const dir = tmp(t);
  const make = () => hook.prepareRecallHook({ dir, sessionId: 's5', url: URL, token: TOKEN, on: true });

  const used = hook.recallHookLaunch('claude', { claude: true, file: make(), dir, sessionId: 's5' });
  assert.match(used.command, /^claude --settings '.+recall-hook-s5\.local\.json'$/);
  assert.ok(fs.existsSync(used.file));

  for (const [command, claude] of [
    ['agy --mode plan', false],
    ['claude --settings mine.json', true],
    ['my-override', false],
  ]) {
    const res = hook.recallHookLaunch(command, { claude, file: make(), dir, sessionId: 's5' });
    assert.deepEqual(res, { command, file: null }, command);
    assert.equal(fs.existsSync(hook.hookSettingsPath(dir, 's5')), false, command);
  }
  assert.deepEqual(hook.recallHookLaunch(' claude ', { claude: true, file: null, dir, sessionId: 's5' }), { command: ' claude ', file: null });
});

test('the review window says why a memory is flagged failing', () => {
  const lines = read('src/renderer/modules/memoryinboxlines.js');
  assert.match(lines, /flag\.kind === 'failing'\) return t\('mem\.inbox\.review\.failing', \{ count: /);
  assert.ok(lines.indexOf("flag.kind === 'failing'") < lines.indexOf("t('mem.inbox.review.stale'"));
});
