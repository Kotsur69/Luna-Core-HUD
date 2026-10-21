// ============================================================================
// LunaCore - live Claude Code chat driven from the phone (src/hostchat.js)
// ----------------------------------------------------------------------------
// A fake `claude` child speaks the probed stream-json protocol: start (cwd
// from the host's repo list, flags), text, tool calls, approvals (allow /
// deny / always / timeout), interrupt, end, crash, resume, the 2-session cap
// and the allow-lists. Cleanup leaves no live session, timer or listener.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const chat = require('../src/hostchat');

const SID = '11111111-2222-4333-8444-555555555555';
const REPO_DIR = process.platform === 'win32' ? 'C:\\repos\\luna' : '/repos/luna';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = [];
  child.stdin = {
    destroyed: false,
    write: (line) => child.written.push(JSON.parse(line)),
    end: () => {
      child.stdin.destroyed = true;
    },
  };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  child.say = (obj) => child.stdout.write(`${JSON.stringify(obj)}\n`);
  return child;
}

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimer: (fn, ms) => {
      pending.set(++n, { fn, ms });
      return n;
    },
    clearTimer: (id) => pending.delete(id),
    fireAll() {
      for (const [id, t] of [...pending]) {
        pending.delete(id);
        t.fn();
      }
    },
    pending,
  };
}

function setup(over = {}) {
  const children = [];
  const spawns = [];
  const events = [];
  const notes = [];
  const timers = fakeTimers();
  let uuid = 0;
  const host = chat.createHostChat({
    spawn: (cmd, args, opts) => {
      const c = fakeChild();
      children.push(c);
      spawns.push({ cmd, args, opts });
      return c;
    },
    repoDir: (id) => (id === 'luna' ? REPO_DIR : null),
    env: () => ({ PATH: '/bin' }),
    events: {
      text: (sid, text) => events.push([sid, 'text', { text }]),
      emit: (sid, kind, data) => events.push([sid, kind, data]),
      forget: () => {},
    },
    randomUUID: () => (uuid++ === 0 ? SID : `0000000${uuid}-0000-4000-8000-000000000000`),
    notify: (kind, info) => notes.push([kind, info.sessionId]),
    log: () => {},
    ...timers,
    ...over,
  });
  return { host, children, spawns, events, notes, timers };
}

const tick = () => new Promise((r) => setImmediate(r));
const kinds = (events) => events.map((e) => e[1]);

test('chat.start spawns claude in the repo from the host list with the probed flags', async () => {
  const { host, spawns, children, events } = setup();
  const res = await host.handlers['chat.start']({ repoId: 'luna', prompt: 'Fix the tests', model: 'opus', mode: 'plan' });
  assert.deepEqual(res, { status: 'started', sessionId: SID });
  assert.equal(spawns[0].cmd, 'claude');
  assert.equal(spawns[0].opts.cwd, REPO_DIR);
  const a = spawns[0].args;
  for (const flag of ['--input-format', '--output-format', '--include-partial-messages', '--permission-prompt-tool']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(a[a.indexOf('--session-id') + 1], SID);
  assert.deepEqual(children[0].written[0], { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the tests' }] } });
  assert.deepEqual(kinds(events), ['status', 'prompt']);
  assert.deepEqual(host.sessions(), [{ id: SID, repoId: 'luna', status: 'working' }]);
});

test('"default" mode adds no --permission-mode (the CLI has no such choice)', () => {
  const args = chat.chatArgs({ model: 'sonnet', mode: 'default', sessionId: SID });
  assert.ok(!args.includes('--permission-mode'));
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
});

test('payloads are validated on the host: repo id, model, mode, timeout, prompt', async () => {
  const { host, spawns } = setup();
  const start = host.handlers['chat.start'];
  assert.equal((await start({ repoId: '../etc', prompt: 'x' })).status, 'refused: repoId');
  assert.equal((await start({ repoId: 'other', prompt: 'x' })).status, 'refused: unknown repo');
  assert.equal((await start({ repoId: 'luna', prompt: 'x', model: 'haiku' })).status, 'refused: model');
  assert.equal((await start({ repoId: 'luna', prompt: 'x', mode: 'bypassPermissions' })).status, 'refused: mode');
  assert.equal((await start({ repoId: 'luna', prompt: 'x', approvalTimeout: -1 })).status, 'refused: approvalTimeout');
  assert.equal((await start({ repoId: 'luna', prompt: '   ' })).status, 'refused: prompt');
  assert.equal((await start({ repoId: 'luna', prompt: 'x', path: '/etc' })).status, 'started');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].opts.cwd, REPO_DIR, 'a path in the payload is ignored');
});

test('max 2 live sessions per host', async () => {
  const { host } = setup();
  const start = host.handlers['chat.start'];
  assert.equal((await start({ repoId: 'luna', prompt: 'a' })).status, 'started');
  assert.equal((await start({ repoId: 'luna', prompt: 'b' })).status, 'started');
  assert.equal((await start({ repoId: 'luna', prompt: 'c' })).status, 'refused: too many sessions');
});

test('stream: text deltas, tool call, clipped tool result, cost and done', async () => {
  const { host, children, events, notes } = setup();
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  const c = children[0];
  c.say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } });
  c.say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: `${REPO_DIR}${process.platform === 'win32' ? '\\' : '/'}src${process.platform === 'win32' ? '\\' : '/'}a.js` } }] } });
  c.say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'y'.repeat(9000) }] } });
  c.say({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, num_turns: 2 });
  await tick();
  const byKind = Object.fromEntries(events.map((e) => [e[1], e[2]]));
  assert.deepEqual(byKind.text, { text: 'Hi' });
  assert.deepEqual(byKind.tool, { id: 'toolu_1', name: 'Read', summary: 'src/a.js' });
  assert.equal(byKind.tool_result.clipped, true);
  assert.ok(byKind.tool_result.text.endsWith('(full output on the host)'));
  assert.deepEqual(byKind.cost, { usd: 0.0123, turns: 2 });
  assert.deepEqual(events.at(-1)[2], { status: 'done' });
  assert.deepEqual(notes, [['done', SID]]);
});

test('approval: card with diff preview, allow writes the probed response', async () => {
  const { host, children, events, notes } = setup();
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  const c = children[0];
  const input = { file_path: `${REPO_DIR}/a.js`, old_string: 'a', new_string: 'b' };
  c.say({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input, permission_suggestions: [] } });
  await tick();
  const card = events.find((e) => e[1] === 'permission')[2];
  assert.equal(card.requestId, 'req-1');
  assert.equal(card.tool, 'Edit');
  assert.equal(card.preview, '- a\n+ b');
  assert.deepEqual(host.sessions()[0].status, 'waiting');
  assert.deepEqual(notes, [['approval', SID]]);
  assert.deepEqual(await host.handlers['chat.approve']({ requestId: 'req-1', decision: 'allow' }), { status: 'answered' });
  assert.deepEqual(c.written.at(-1), { type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: input } } });
  assert.deepEqual(events.at(-2)[2], { requestId: 'req-1', decision: 'allow' });
  assert.equal(host.sessions()[0].status, 'working');
  assert.equal((await host.handlers['chat.approve']({ requestId: 'req-1', decision: 'allow' })).status, 'refused: no such request');
});

test('approval: deny and always (the CLI suggestions go back as updatedPermissions)', async () => {
  const { host, children } = setup();
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  const c = children[0];
  const sugg = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  c.say({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { content: 'x' }, permission_suggestions: sugg } });
  c.say({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  await tick();
  await host.handlers['chat.approve']({ requestId: 'r1', decision: 'always' });
  assert.deepEqual(c.written.at(-1).response.response.updatedPermissions, sugg);
  await host.handlers['chat.approve']({ requestId: 'r2', decision: 'deny' });
  assert.deepEqual(c.written.at(-1).response.response, { behavior: 'deny', message: 'Denied from the phone' });
  assert.equal((await host.handlers['chat.approve']({ requestId: 'r3', decision: 'maybe' })).status, 'refused: decision');
});

test('approval waits forever by default; "deny after N min" denies on time', async () => {
  const a = setup();
  await a.host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  a.children[0].say({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  await tick();
  assert.equal(a.timers.pending.size, 0, 'no timer: waits forever');

  const b = setup();
  await b.host.handlers['chat.start']({ repoId: 'luna', prompt: 'go', approvalTimeout: 5 });
  b.children[0].say({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  await tick();
  assert.equal([...b.timers.pending.values()][0].ms, 5 * 60 * 1000);
  b.timers.fireAll();
  assert.equal(b.children[0].written.at(-1).response.response.behavior, 'deny');
  assert.deepEqual(b.events.find((e) => e[1] === 'decision')[2], { requestId: 'r1', decision: 'timeout' });
});

test('chat.interrupt sends the interrupt control request; the interrupted result is not a failure', async () => {
  const { host, children, events, notes } = setup();
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  assert.equal((await host.handlers['chat.interrupt']({ sessionId: SID })).status, 'interrupting');
  assert.deepEqual(children[0].written.at(-1).request, { subtype: 'interrupt' });
  children[0].say({ type: 'result', subtype: 'error_during_execution', is_error: true });
  await tick();
  assert.deepEqual(events.at(-1)[2], { status: 'done', reason: 'interrupted' });
  assert.deepEqual(notes, [['done', SID]]);
});

test('chat.send writes a user turn to the live child only', async () => {
  const { host, children } = setup();
  assert.equal((await host.handlers['chat.send']({ sessionId: SID, text: 'hi' })).status, 'refused: no session');
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  assert.equal((await host.handlers['chat.send']({ sessionId: SID, text: 'and now?' })).status, 'sent');
  assert.equal(children[0].written.at(-1).message.content[0].text, 'and now?');
});

test('chat.end closes stdin, kills after a grace period, and cleans up', async () => {
  const { host, children, timers } = setup();
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  const c = children[0];
  c.say({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  await tick();
  assert.equal((await host.handlers['chat.end']({ sessionId: SID })).status, 'ending');
  assert.equal(c.stdin.destroyed, true);
  c.emit('exit', 0);
  assert.deepEqual(host.sessions(), []);
  assert.equal(timers.pending.size, 0, 'kill timer cleared');
  assert.equal(c.listenerCount('exit'), 0);
  assert.equal(c.listenerCount('error'), 0);
});

test('a crashed child: status error, failed notification, session gone', async () => {
  const { host, children, events, notes } = setup();
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  children[0].emit('exit', 1);
  assert.deepEqual(events.at(-1)[2], { status: 'error', reason: 'exit 1' });
  assert.deepEqual(notes, [['failed', SID]]);
  assert.deepEqual(host.sessions(), []);
  // A crash frees the slot.
  assert.equal((await host.handlers['chat.start']({ repoId: 'luna', prompt: 'a' })).status, 'started');
});

test('claude missing (ENOENT) ends the session cleanly', async () => {
  const { host, children, events } = setup();
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  children[0].emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  assert.deepEqual(events.at(-1)[2], { status: 'error', reason: 'no claude' });
  assert.deepEqual(host.sessions(), []);
});

test('chat.resume reopens a known session with --resume in the same repo', async () => {
  const { host, spawns, children } = setup();
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go', model: 'opus' });
  await host.handlers['chat.end']({ sessionId: SID });
  children[0].emit('exit', 0);
  assert.equal((await host.handlers['chat.resume']({ sessionId: 'bad' })).status, 'refused: sessionId');
  const res = await host.handlers['chat.resume']({ sessionId: SID, prompt: 'continue' });
  assert.deepEqual(res, { status: 'resumed', sessionId: SID });
  const a = spawns[1].args;
  assert.equal(a[a.indexOf('--resume') + 1], SID);
  assert.ok(!a.includes('--session-id'));
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(spawns[1].opts.cwd, REPO_DIR);
  assert.equal((await host.handlers['chat.resume']({ sessionId: SID })).status, 'refused: already running');
});

test('an unknown session resumes only with a repo id from the host list', async () => {
  const { host } = setup();
  const other = '99999999-2222-4333-8444-555555555555';
  assert.equal((await host.handlers['chat.resume']({ sessionId: other })).status, 'refused: unknown session');
  assert.equal((await host.handlers['chat.resume']({ sessionId: other, repoId: 'nope' })).status, 'refused: unknown repo');
  assert.equal((await host.handlers['chat.resume']({ sessionId: other, repoId: 'luna' })).status, 'resumed');
});

test('stopAll ends every child and drops listeners', async () => {
  const { host, children } = setup();
  const seen = [];
  host.onEvent((sid, kind) => seen.push(kind));
  await host.handlers['chat.start']({ repoId: 'luna', prompt: 'go' });
  assert.ok(seen.length > 0);
  host.stopAll();
  assert.equal(children[0].killed, true);
  assert.deepEqual(host.sessions(), []);
  const before = seen.length;
  children[0].say({ type: 'result', subtype: 'success' });
  await tick();
  assert.equal(seen.length, before);
});

test('translate ignores subagent lines and unknown messages', () => {
  assert.deepEqual(chat.translate({ type: 'stream_event', parent_tool_use_id: 'x', event: { delta: { type: 'text_delta', text: 'inner' } } }), []);
  assert.deepEqual(chat.translate({ type: 'system', subtype: 'init' }), []);
  assert.deepEqual(chat.translate(null), []);
  assert.deepEqual(chat.translate({ type: 'control_request', request_id: 'bad id!', request: { subtype: 'can_use_tool' } }), []);
});

test('shownPath never shows a path outside the repo', () => {
  const sep = process.platform === 'win32' ? '\\' : '/';
  assert.equal(chat.shownPath(`${REPO_DIR}${sep}src${sep}x.js`, REPO_DIR), 'src/x.js');
  assert.equal(chat.shownPath(process.platform === 'win32' ? 'C:\\Users\\me\\secret.txt' : '/home/me/secret.txt', REPO_DIR), 'secret.txt');
});
