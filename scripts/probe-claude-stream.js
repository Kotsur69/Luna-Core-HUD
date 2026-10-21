#!/usr/bin/env node
// ============================================================================
// LunaCore - probe of the claude CLI's stream-json control protocol
// ----------------------------------------------------------------------------
// docs/REMOTE_HOST_PLAN.md H2, "Probe first". A throwaway run that records
// what src/hostchat.js has to speak:
//
//   claude -p --input-format stream-json --output-format stream-json
//          --include-partial-messages --verbose --permission-prompts host
//
// in a scratch git repo, with Haiku and trivial prompts. Scenarios:
//
//   allow      a Write call is asked for -> answered allow
//   deny       -> answered deny
//   always     -> allow + the CLI's own permission suggestions (don't ask
//                again); the same command again must not prompt
//   interrupt  a prompt is pending -> an interrupt control request instead
//   resume     a new child with --resume <session id> remembers the first turn
//
// Every stdout line is reduced to its shape (keys and value types, strings
// redacted) and printed; --out <file> also writes the redacted lines.
//
//   node scripts/probe-claude-stream.js --dry-run   prints the planned
//                                                   invocation, exits 0
//   node scripts/probe-claude-stream.js [--model haiku] [--out probe.jsonl]
// ============================================================================

'use strict';

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const TURN_TIMEOUT_MS = 120 * 1000;
const MAX_STRING = 40;

/** The CLI flags of a probe child; `extra` adds --session-id / --resume. */
function claudeArgs({ model, extra = [] }) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompts', 'host',
    '--permission-prompt-tool', 'stdio',
    '--model', model,
    ...extra,
  ];
}

const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

/** A value -> its shape: keys kept, strings cut and redacted, arrays shown by their first item. */
function shapeOf(value, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  if (typeof value === 'string') {
    if (/^[0-9a-f-]{36}$/i.test(value)) return '<uuid>';
    if (/[\\/]/.test(value) && value.length > 3) return '<path-or-text>';
    return value.length > MAX_STRING ? `<string ${value.length}>` : value;
  }
  return value;
}

/** The redacted line kept in --out: ids and the scratch path never leave the probe. */
function redact(line, scratch) {
  return line.split(scratch).join('<scratch>').split(scratch.replace(/\\/g, '\\\\')).join('<scratch>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(new RegExp(os.homedir().replace(/\\/g, '\\\\\\\\').replace(/[.*+?^${}()|[\]]/g, '\\$&'), 'g'), '<home>');
}

function parseArgs(argv) {
  const get = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  return { dryRun: argv.includes('--dry-run'), model: get('--model', 'haiku'), out: get('--out', null) };
}

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-probe-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# probe\n');
  return dir;
}

/**
 * One child; `onLine(msg, child)` sees every parsed stdout line.
 * @returns {{child, send: (obj: object) => void, done: Promise<number>}}
 */
function startChild({ cwd, args, onLine, record }) {
  const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    record(line);
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    onLine(msg);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${String(d).slice(0, 300)}\n`));
  const send = (obj) => {
    const line = JSON.stringify(obj);
    record(`>> ${line}`);
    child.stdin.write(`${line}\n`);
  };
  const done = new Promise((resolve) => child.on('close', resolve));
  return { child, send, done };
}

/** Sends one user turn and answers its permission prompts with `answer(req)`; resolves on `result`. */
function turn(c, text, answer, onMsg = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn timed out: ${text}`)), TURN_TIMEOUT_MS);
    c.handlers.push((msg) => {
      if (onMsg) onMsg(msg);
      if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'can_use_tool') {
        const reply = answer(msg);
        if (reply) c.send(reply);
      }
      if (msg.type === 'result') {
        clearTimeout(timer);
        c.handlers.length = 0;
        resolve(msg);
      }
    });
    c.send(JSON.parse(userLine(text)));
  });
}

const allow = (msg, extra = {}) => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'allow', updatedInput: msg.request.input, ...extra } },
});
const deny = (msg) => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'deny', message: 'Denied from the phone' } },
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sessionId = crypto.randomUUID();
  const first = claudeArgs({ model: opts.model, extra: ['--session-id', sessionId] });
  if (opts.dryRun) {
    console.log('probe-claude-stream (dry run)');
    console.log(`  cwd:    <scratch git repo in ${os.tmpdir()}>`);
    console.log(`  run 1:  claude ${first.join(' ')}`);
    console.log(`  run 2:  claude ${claudeArgs({ model: opts.model, extra: ['--resume', '<session id>'] }).join(' ')}`);
    console.log('  stdin:  ' + userLine('<prompt>'));
    console.log('  scenarios: allow, deny, always, interrupt, resume');
    return 0;
  }

  const cwd = scratchRepo();
  const lines = [];
  const shapes = new Map();
  const record = (line) => {
    lines.push(redact(line, cwd));
    if (line.startsWith('>> ')) return;
    try {
      const msg = JSON.parse(line);
      const key = [msg.type, msg.subtype, msg.request && msg.request.subtype, msg.event && msg.event.type].filter(Boolean).join('/');
      if (!shapes.has(key)) shapes.set(key, shapeOf(msg));
    } catch {
      // Non-JSON output is kept in the raw log only.
    }
  };

  const open = (args) => {
    const c = { handlers: [] };
    Object.assign(c, startChild({ cwd, args, record, onLine: (msg) => c.handlers.slice().forEach((fn) => fn(msg)) }));
    return c;
  };

  const run1 = open(first);
  const results = {};
  results.allow = await turn(run1, 'Use the Write tool to create the file probe-allow.txt containing the word allow. Then reply "ok".', (m) => allow(m));
  results.deny = await turn(run1, 'Use the Write tool to create the file probe-deny.txt containing the word deny. Then reply "ok".', (m) => deny(m));
  results.always = await turn(run1, 'Use the Write tool to write the word always into the file probe-always.txt. Then reply "ok".', (m) =>
    allow(m, { updatedPermissions: Array.isArray(m.request.permission_suggestions) ? m.request.permission_suggestions : [] }));
  let askedAgain = false;
  results.alwaysAgain = await turn(run1, 'Use the Write tool to write the word always into the file probe-always.txt. Then reply "ok".', (m) => {
    askedAgain = true;
    return allow(m);
  });
  // Interrupt mid-stream: on the first text delta of a long answer.
  let interrupted = false;
  results.interrupt = await turn(run1, 'Write the numbers from 1 to 300, one per line, nothing else.', (m) => deny(m), (msg) => {
    const d = msg.type === 'stream_event' && msg.event && msg.event.delta;
    if (interrupted || !d || d.type !== 'text_delta') return;
    interrupted = true;
    run1.send({ type: 'control_request', request_id: `probe-${crypto.randomUUID()}`, request: { subtype: 'interrupt' } });
  });
  run1.child.stdin.end();
  await run1.done;

  const run2 = open(claudeArgs({ model: opts.model, extra: ['--resume', sessionId] }));
  results.resume = await turn(run2, 'Which file did I first ask you to create? Reply with its name only.', (m) => deny(m));
  run2.child.stdin.end();
  await run2.done;

  console.log(JSON.stringify({ askedAgainAfterAlways: askedAgain, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { subtype: v.subtype, is_error: v.is_error }])) }, null, 2));
  for (const [key, shape] of shapes) console.log(`\n## ${key}\n${JSON.stringify(shape)}`);
  if (opts.out) fs.writeFileSync(opts.out, `${lines.join('\n')}\n`);
  try {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (err) {
    console.error(`scratch repo left behind (${err.code}): remove it by hand`);
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`probe failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { claudeArgs, shapeOf, redact, parseArgs };
