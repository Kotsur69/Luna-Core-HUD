// ============================================================================
// src/agyexec.js: a Luna's Work `claude -p` argv run as `agy --print`. A fake
// execFile stands in for the agy binary: it records the argv, the options and
// the prompt written to stdin, and answers with scripted stdout / errors.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AGY_MODEL, argsUseAgy, schemaOf, wantsEdits, agyEnvelope, execAgy } = require('../src/agyexec');
const { AGY_BIN } = require('../src/orchestraAgy');
const { execClaude } = require('../src/lunasworkCritic');

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
const AGY_ENV = { PATH: 'x', AGY_PROFILE: 'agy-test' };

/** A fake execFile: `answer` is {stdout} or {error, stderr}. */
function fakeExec(answer = { stdout: '{"verdict":"ship"}' }) {
  const calls = [];
  const execImpl = (bin, args, opts, cb) => {
    const call = { bin, args, opts, stdin: '' };
    calls.push(call);
    setImmediate(() => cb(answer.error || null, answer.stdout || '', answer.stderr || ''));
    return { stdin: { on: () => {}, end: (text) => (call.stdin = String(text)) } };
  };
  return { calls, execImpl };
}

const claudeArgs = (extra = []) => ['-p', '--output-format', 'json', '--model', AGY_MODEL, ...extra];

test('argsUseAgy: only `--model agy` or a well-formed `--model agy:<id>` routes to agy', () => {
  assert.equal(argsUseAgy(claudeArgs()), true);
  assert.equal(argsUseAgy(['-p', '--model', 'agy:gemini-4-argon-medium']), true);
  for (const args of [
    ['-p', '--model', 'opus'],
    ['-p', '--model', 'AGY'],
    ['-p', 'agy'],
    ['-p', '--model'],
    ['-p', '--model', 'agy:'],
    ['-p', '--model', 'agy:--print'],
    ['-p', '--model', 'agy:a b'],
    null,
    'agy',
    [],
  ]) {
    assert.equal(argsUseAgy(args), false, JSON.stringify(args));
  }
});

/** A fake agy model cache holding `ids`; counts ensure() calls. */
function fakeModels(ids) {
  const seen = { ensured: 0 };
  return {
    seen,
    ensure: async () => {
      seen.ensured += 1;
      return ids.map((id) => ({ id, name: id }));
    },
    isKnownId: (id) => ids.includes(id),
  };
}

test('execAgy: --model agy:<id> runs agy with its own --model <id> once the live list holds the id', async () => {
  const { calls, execImpl } = fakeExec({ stdout: 'done' });
  const agyModels = fakeModels(['gemini-4-argon-medium']);
  const res = await execAgy({ args: ['-p', '--model', 'agy:gemini-4-argon-medium'], prompt: 'hi', cwd: '.', env: AGY_ENV, timeoutMs: 1000, execImpl, agyModels });
  assert.ok(res.stdout);
  assert.equal(agyModels.seen.ensured, 1);
  assert.deepEqual(calls[0].args, ['--model', 'gemini-4-argon-medium']);
  // The internal marker never reaches agy.
  assert.ok(!calls[0].args.includes('agy:gemini-4-argon-medium'));
});

test('execAgy: an id the live list does not hold is refused and never reaches an argv', async () => {
  const { calls, execImpl } = fakeExec();
  const res = await execAgy({ args: ['-p', '--model', 'agy:gemini-9-made-up'], prompt: 'hi', cwd: '.', env: AGY_ENV, timeoutMs: 1000, execImpl, agyModels: fakeModels(['gemini-4-argon-medium']) });
  assert.equal(res.error, 'badAgyModel');
  assert.equal(calls.length, 0);
});

test('execAgy: plain --model agy passes no --model and never reads the list', async () => {
  const { calls, execImpl } = fakeExec({ stdout: 'done' });
  const agyModels = fakeModels([]);
  await execAgy({ args: claudeArgs(), prompt: 'hi', cwd: '.', env: AGY_ENV, timeoutMs: 1000, execImpl, agyModels });
  assert.equal(agyModels.seen.ensured, 0);
  assert.ok(!calls[0].args.includes('--model'));
});

test('schemaOf reads --json-schema, null when missing or not a JSON object', () => {
  assert.deepEqual(schemaOf(claudeArgs(['--json-schema', JSON.stringify(SCHEMA)])), SCHEMA);
  assert.equal(schemaOf(claudeArgs()), null);
  assert.equal(schemaOf(claudeArgs(['--json-schema', '{bad'])), null);
  assert.equal(schemaOf(claudeArgs(['--json-schema', '[1,2]'])), null);
});

test('wantsEdits: edit tools or an accept-edits mode let agy edit; read-only argvs do not', () => {
  assert.equal(wantsEdits(claudeArgs(['--tools', 'Read,Grep,Glob'])), false);
  assert.equal(wantsEdits(claudeArgs(['--tools', 'Read, Edit'])), true);
  assert.equal(wantsEdits(claudeArgs(['--tools', 'Write'])), true);
  assert.equal(wantsEdits(claudeArgs(['--permission-mode', 'acceptEdits'])), true);
  assert.equal(wantsEdits(claudeArgs(['--permission-mode', 'plan'])), false);
  assert.equal(wantsEdits(claudeArgs(['--dangerously-skip-permissions'])), true);
  assert.equal(wantsEdits(claudeArgs(['--disallowedTools', 'Edit,Write'])), false, 'a deny list never grants edits');
});

test("agyEnvelope wraps agy's text as Claude's JSON result envelope", () => {
  const env = JSON.parse(agyEnvelope('Here you go:\n```json\n{"verdict":"ship"}\n```'));
  assert.equal(env.type, 'result');
  assert.equal(env.is_error, false);
  assert.deepEqual(env.structured_output, { verdict: 'ship' });
  assert.equal(env.total_cost_usd, null);
  const plain = JSON.parse(agyEnvelope('no json here'));
  assert.equal(plain.result, 'no json here');
  assert.equal('structured_output' in plain, false);
  assert.equal(JSON.parse(agyEnvelope(null)).result, '');
  // No schema asked: a stray object in prose is not a structured answer.
  const prose = JSON.parse(agyEnvelope('Use {"a":1} like this.', { structured: false }));
  assert.equal('structured_output' in prose, false);
});

test('execAgy without --json-schema hands back the text only, never a structured_output', async () => {
  const { execImpl } = fakeExec({ stdout: 'Note: {"verdict":"ship"} was the old answer.' });
  const res = await execAgy({ args: claudeArgs(), prompt: 'x', cwd: '/repo', env: AGY_ENV, timeoutMs: 1, execImpl });
  const env = JSON.parse(res.stdout);
  assert.equal('structured_output' in env, false);
  assert.match(env.result, /old answer/);
});

test('execAgy runs agy (prompt on stdin, no --print) with the schema in the prompt, in the agy env and cwd', async () => {
  const { calls, execImpl } = fakeExec();
  const res = await execAgy({ args: claudeArgs(['--json-schema', JSON.stringify(SCHEMA)]), prompt: 'Judge the build.', cwd: '/repo', env: AGY_ENV, timeoutMs: 1234, execImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, AGY_BIN);
  assert.equal(calls[0].args.includes('--print'), false);
  assert.equal(calls[0].args.includes('accept-edits'), false, 'read-only call: no accept-edits');
  assert.equal(calls[0].opts.cwd, '/repo');
  assert.deepEqual(calls[0].opts.env, AGY_ENV);
  assert.equal(calls[0].opts.timeout, 1234);
  assert.match(calls[0].stdin, /^Judge the build\./);
  assert.ok(calls[0].stdin.includes(JSON.stringify(SCHEMA)), 'the JSON contract is in the prompt');
  assert.deepEqual(JSON.parse(res.stdout).structured_output, { verdict: 'ship' });
});

test('execAgy passes edits through as accept-edits, and no schema leaves the prompt as is', async () => {
  const { calls, execImpl } = fakeExec({ stdout: 'done' });
  const res = await execAgy({ args: claudeArgs(['--tools', 'Read,Edit']), prompt: 'Fix it.', cwd: '/repo', env: AGY_ENV, timeoutMs: 1, execImpl });
  assert.ok(calls[0].args.includes('accept-edits'));
  assert.equal(calls[0].stdin, 'Fix it.');
  assert.equal(JSON.parse(res.stdout).result, 'done');
});

test('execAgy without an agy profile refuses and never runs anything', async () => {
  const { calls, execImpl } = fakeExec();
  for (const env of [null, undefined, 'env']) {
    const res = await execAgy({ args: claudeArgs(), prompt: 'x', cwd: '/repo', env, timeoutMs: 1, execImpl });
    assert.equal(res.error, 'noAgyProfile');
    assert.match(res.detail, /agy/);
  }
  assert.equal(calls.length, 0);
});

test("execAgy reports agy's failures in execClaude's shape (noAgy, timeout, limit, failed)", async () => {
  const cases = [
    [{ error: Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }) }, 'noAgy'],
    [{ error: Object.assign(new Error('killed'), { killed: true }) }, 'timeout'],
    // agy's own limit wording (orchestraAgy LIMIT_RE), not Claude's.
    [{ error: new Error('exit 1'), stderr: '429 RESOURCE_EXHAUSTED: quota exceeded' }, 'limit'],
    [{ error: new Error('exit 1'), stderr: 'boom' }, 'failed'],
  ];
  for (const [answer, error] of cases) {
    const { execImpl } = fakeExec(answer);
    const res = await execAgy({ args: claudeArgs(), prompt: 'x', cwd: '/repo', env: AGY_ENV, timeoutMs: 1, execImpl });
    assert.equal(res.error, error, error);
    assert.equal('stdout' in res, false);
  }
});

test('execClaude routes a `--model agy` argv to agy with the agy env, never to claude', async () => {
  const { calls, execImpl } = fakeExec();
  const res = await execClaude({ args: claudeArgs(['--json-schema', JSON.stringify(SCHEMA)]), prompt: 'p', cwd: '/repo', env: { CLAUDE: '1' }, agyEnv: AGY_ENV, timeoutMs: 1, execImpl });
  assert.equal(calls[0].bin, AGY_BIN);
  assert.deepEqual(calls[0].opts.env, AGY_ENV, 'the Claude env never reaches agy');
  assert.deepEqual(JSON.parse(res.stdout).structured_output, { verdict: 'ship' });

  // No agy env: refused, not run on claude instead.
  const none = fakeExec();
  assert.equal((await execClaude({ args: claudeArgs(), prompt: 'p', cwd: '/repo', env: { CLAUDE: '1' }, timeoutMs: 1, execImpl: none.execImpl })).error, 'noAgyProfile');
  assert.equal(none.calls.length, 0);
});

test('execClaude keeps running a Claude model on claude', async () => {
  const { calls, execImpl } = fakeExec({ stdout: '{"type":"result"}' });
  await execClaude({ args: ['-p', '--model', 'opus'], prompt: 'p', cwd: '/repo', env: { CLAUDE: '1' }, agyEnv: AGY_ENV, timeoutMs: 1, execImpl });
  assert.notEqual(calls[0].bin, AGY_BIN);
  assert.deepEqual(calls[0].opts.env, { CLAUDE: '1' });
});
