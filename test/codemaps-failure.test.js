// ============================================================================
// Codemaps refresh failures name their real cause (src/lunasworkGraph.js and
// lunasworkCritic.execClaude): exit code, timeout and signal, the CLI's stderr
// or its error JSON - never node's "Command failed: claude -p ..." argv echo.
// The updater no longer asks for the plugin agent ecc:doc-updater (with user
// settings off it was "not found" and claude exited 1 on every repo), and a
// Unity project's generated folders are denied to Read.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { removeDir, LOADED_GIT_TIMEOUT_MS } = require('../test-support/under-load');

const G = require('../src/lunasworkGraph');
const { execClaude } = require('../src/lunasworkCritic');

const ARGV_ECHO = 'Command failed: claude -p --output-format json --json-schema {"type":"object"}';
const AGENT_NOT_FOUND = "--agent 'ecc:doc-updater' not found. Available agents: claude, Explore";

// ---- execClaude: what a failed call carries ---------------------------------------------

/** A fake execFile that answers once with (err, stdout, stderr). */
const execWith = (err, stdout = '', stderr = '') => (file, args, opts, cb) => {
  cb(err, stdout, stderr);
  return undefined;
};
const callWith = (execImpl) => execClaude({ args: ['-p'], prompt: 'p', cwd: os.tmpdir(), env: {}, timeoutMs: 600000, execImpl });

test('execClaude: a non-zero exit carries the exit code and the stderr', async () => {
  const err = Object.assign(new Error(`${ARGV_ECHO}\n${AGENT_NOT_FOUND}`), { code: 1, killed: false, signal: null });
  const res = await callWith(execWith(err, '', `${AGENT_NOT_FOUND}\n`));
  assert.equal(res.error, 'failed');
  assert.equal(res.exitCode, 1);
  assert.equal(res.stderr, AGENT_NOT_FOUND);
  assert.equal(res.signal, undefined);
});

test('execClaude: a timeout says so, with the limit and the signal', async () => {
  const err = Object.assign(new Error(ARGV_ECHO), { code: null, killed: true, signal: 'SIGTERM' });
  const res = await callWith(execWith(err));
  assert.deepEqual(res, { error: 'timeout', timeoutMs: 600000, signal: 'SIGTERM' });
});

test('execClaude: a full output buffer is not reported as a timeout', async () => {
  const err = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' });
  const res = await callWith(execWith(err));
  assert.equal(res.error, 'failed');
  assert.match(res.detail, /output over the 20 MB buffer/);
});

test('execClaude: an error envelope on stdout still comes back, with the exit code', async () => {
  const stdout = JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'tool crashed' });
  const err = Object.assign(new Error(ARGV_ECHO), { code: 1, killed: false, signal: null });
  const res = await callWith(execWith(err, stdout, ''));
  assert.equal(res.stdout, stdout);
  assert.equal(res.exitCode, 1);
});

test('execClaude: stderr is masked and capped', async () => {
  // Assembled at runtime so no key-shaped literal sits in the source.
  const fakeKey = ['sk', 'ant', 'x'.repeat(40)].join('-');
  const err = Object.assign(new Error(ARGV_ECHO), { code: 2, killed: false, signal: null });
  const res = await callWith(execWith(err, '', `auth failed for ${fakeKey}\n${'y'.repeat(5000)}`));
  assert.ok(!res.stderr.includes(fakeKey), 'the key is masked');
  assert.match(res.stderr, /redacted/);
  assert.ok(res.stderr.length <= 600, `capped, got ${res.stderr.length}`);
  assert.ok(!res.stderr.includes('Command failed'), 'no argv echo');
});

test('execClaude: claude missing from PATH is noClaude; a signal without a timeout is kept', async () => {
  assert.deepEqual(await callWith(execWith(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))), { error: 'noClaude' });
  const oom = Object.assign(new Error(ARGV_ECHO), { code: null, killed: false, signal: 'SIGKILL' });
  const res = await callWith(execWith(oom));
  assert.equal(res.error, 'failed');
  assert.equal(res.signal, 'SIGKILL');
  assert.equal(G.describeClaudeFailure(res).detail, 'claude failed (SIGKILL)');
});

test('execClaude: a successful call keeps its old shape', async () => {
  assert.deepEqual(await callWith(execWith(null, '{"result":"{}"}', 'warning')), { stdout: '{"result":"{}"}' });
});

// ---- describeClaudeFailure: the note text ------------------------------------------------

test('describeClaudeFailure: exit code + stderr, never the argv echo', () => {
  assert.deepEqual(G.describeClaudeFailure({ error: 'failed', detail: ARGV_ECHO, exitCode: 1, stderr: AGENT_NOT_FOUND }), {
    skip: false,
    detail: `claude exited 1: ${AGENT_NOT_FOUND}`,
  });
  assert.deepEqual(G.describeClaudeFailure({ error: 'failed', detail: ARGV_ECHO, exitCode: 3 }), { skip: false, detail: 'claude exited 3' });
  assert.deepEqual(G.describeClaudeFailure({ error: 'timeout', timeoutMs: 600000, signal: 'SIGTERM' }), {
    skip: false,
    detail: 'claude timed out after 600s (SIGTERM)',
  });
  assert.deepEqual(G.describeClaudeFailure(null), { skip: false, detail: 'claude gave no answer' });
});

test('describeClaudeFailure: no claude on PATH or an account at its limit is a skip with that reason', () => {
  assert.deepEqual(G.describeClaudeFailure({ error: 'noClaude' }), { skip: true, detail: 'claude CLI not found on PATH' });
  assert.deepEqual(G.describeClaudeFailure({ error: 'limit', detail: 'reserve held until 14:00' }), {
    skip: true,
    detail: 'Claude usage limit: reserve held until 14:00',
  });
});

// ---- refreshGraph: the notes a run report shows ------------------------------------------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const indexOk = { stdout: JSON.stringify({ structured_output: { indexed: true, detail: 'ok' } }) };
const isCodemapsCall = (o) => o.prompt.includes('docs/CODEMAPS');

function repo(t, { unity = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-cm-fail-'));
  t.after(() => removeDir(dir));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'app.js'), 'v1\n');
  if (unity) {
    fs.mkdirSync(path.join(dir, 'ProjectSettings'));
    fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

/** refreshGraph with a stubbed claude whose codemaps call answers `maps` (after writing a half map, unless write is false). */
async function refreshWith(t, maps, opts = {}) {
  const dir = repo(t, opts);
  if (typeof opts.before === 'function') opts.before(dir);
  const calls = [];
  const runClaude = async (o) => {
    calls.push(o);
    if (!isCodemapsCall(o)) return indexOk;
    if (opts.write === false) return maps;
    fs.mkdirSync(path.join(o.cwd, 'docs', 'CODEMAPS'), { recursive: true });
    fs.writeFileSync(path.join(o.cwd, 'docs', 'CODEMAPS', 'half.md'), '# half\n');
    return maps;
  };
  const { refreshGraph } = G.createGraphRefresher({ runClaude, resolveCli: () => null, gitTimeoutMs: LOADED_GIT_TIMEOUT_MS });
  const res = await refreshGraph({ repoPath: dir, iteration: 2 });
  return { res, calls, dir };
}

test('refresh: a non-zero exit names the exit code and stderr, and the half maps are discarded', async (t) => {
  const { res, dir } = await refreshWith(t, { error: 'failed', detail: ARGV_ECHO, exitCode: 1, stderr: AGENT_NOT_FOUND });
  assert.equal(res.codemaps, 'failed');
  assert.deepEqual(res.notes, [`codemaps update failed: claude exited 1: ${AGENT_NOT_FOUND} - maps discarded`]);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('refresh: a timeout says timed out, with the limit and the signal', async (t) => {
  const { res } = await refreshWith(t, { error: 'timeout', timeoutMs: 600000, signal: 'SIGTERM' });
  assert.deepEqual(res.notes, ['codemaps update failed: claude timed out after 600s (SIGTERM) - maps discarded']);
});

test("refresh: the CLI's error JSON is quoted, with the exit code", async (t) => {
  const stdout = JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'Agent crashed reading Assets' });
  const { res } = await refreshWith(t, { stdout, exitCode: 1 });
  assert.deepEqual(res.notes, ['codemaps update failed: claude exited 1, claude error JSON (failed): Agent crashed reading Assets - maps discarded']);
});

test('refresh: a key in the error JSON or the runner detail is masked in the note', async (t) => {
  const fakeKey = ['sk', 'ant', 'z'.repeat(40)].join('-');
  const stdout = JSON.stringify({ is_error: true, result: `bad key ${fakeKey}` });
  const { res } = await refreshWith(t, { stdout, exitCode: 1 });
  assert.ok(!res.notes[0].includes(fakeKey), res.notes[0]);
  assert.match(res.notes[0], /redacted/);
  const { detail } = G.describeClaudeFailure({ error: 'failed', detail: `token ${fakeKey}` });
  assert.ok(!detail.includes(fakeKey) && /redacted/.test(detail), detail);
});

/** A hand-written map nobody committed yet. */
const handEdit = (dir) => {
  fs.mkdirSync(path.join(dir, 'docs', 'CODEMAPS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'CODEMAPS', 'mine.md'), '# mine\n');
};
const handEditKept = (dir) => fs.existsSync(path.join(dir, 'docs', 'CODEMAPS', 'mine.md'));

test('refresh: no claude on PATH is a skip with that reason, and hand edits in docs/CODEMAPS stay', async (t) => {
  const { res, dir } = await refreshWith(t, { error: 'noClaude' }, { write: false, before: handEdit });
  assert.equal(res.codemaps, 'skipped');
  assert.deepEqual(res.notes, ['codemaps skipped: claude CLI not found on PATH']);
  assert.ok(handEditKept(dir), 'nothing ran, so nothing is discarded');
});

test('refresh: an account held by its reserve (no spawn) is a skip that discards nothing', async (t) => {
  const held = { error: 'limit', detail: 'account reserve held until 14:00', resumeAt: Date.now() + 60000 };
  const { res, dir } = await refreshWith(t, held, { write: false, before: handEdit });
  assert.equal(res.codemaps, 'skipped');
  assert.deepEqual(res.notes, ['codemaps skipped: Claude usage limit: account reserve held until 14:00']);
  assert.ok(handEditKept(dir));
});

test('refresh: a call that ran and failed still discards what it wrote', async (t) => {
  const { dir } = await refreshWith(t, { error: 'failed', exitCode: 1, stderr: 'boom' }, { before: handEdit });
  assert.equal(git(dir, 'status', '--porcelain'), '', 'the half map and the untracked folder are gone');
});

test('refresh: stdout that is not JSON names that, with the exit code and stderr', async (t) => {
  const { res } = await refreshWith(t, { stdout: 'plain text', exitCode: 2, stderr: 'warning: odd' });
  assert.deepEqual(res.notes, ['codemaps update failed: claude exited 2, claude answer was not JSON: warning: odd - maps discarded']);
});

test('refresh: a usage limit in the envelope is a skip too', async (t) => {
  const stdout = JSON.stringify({ is_error: true, result: "You've hit your usage limit. Resets 5pm" });
  const { res } = await refreshWith(t, { stdout, exitCode: 1 });
  assert.equal(res.codemaps, 'skipped');
  assert.match(res.notes[0], /^codemaps skipped: Claude usage limit: /);
});

// ---- the fix: no plugin agent, Unity folders out of reach ---------------------------------

test('codemaps argv: no --agent (no plugin loads with user settings off), workflow in the prompt', () => {
  const args = G.buildCodemapsArgs();
  assert.ok(!args.includes('--agent'));
  assert.ok(!args.some((a) => a.includes('ecc:')), 'no plugin name anywhere');
  const prompt = G.buildCodemapsPrompt({ iteration: 5 });
  assert.match(prompt, /INDEX\.md/);
  assert.match(prompt, /Key Modules/);
  assert.match(prompt, /Write ONLY files under docs\/CODEMAPS\//);
});

test('codemaps argv: a Unity project denies Read on its generated folders', () => {
  const denied = (args) => args[args.indexOf('--disallowedTools') + 1].split(',');
  const unity = denied(G.buildCodemapsArgs({ unity: true }));
  for (const dir of ['Library', 'Temp', 'obj', 'Obj', 'Logs', 'UserSettings']) {
    assert.ok(unity.includes(`Read(./${dir}/**)`), `${dir} denied`);
  }
  assert.ok(unity.includes('Bash') && unity.includes('NotebookEdit'), 'the base denies stay');
  assert.deepEqual(denied(G.buildCodemapsArgs()), ['Bash', 'NotebookEdit']);
  assert.match(G.buildCodemapsPrompt({ iteration: 1, unity: true }), /Unity project[\s\S]*Library\/, Temp\//);
});

test('refresh: a Unity project gets the Unity argv and prompt, a plain repo does not', async (t) => {
  const ok = { stdout: JSON.stringify({ structured_output: { updated: false, summary: 'none' } }) };
  const unity = await refreshWith(t, ok, { unity: true });
  const unityCall = unity.calls.find(isCodemapsCall);
  assert.ok(unityCall.args.includes('Bash,NotebookEdit,' + G.UNITY_GENERATED_DIRS.map((d) => `Read(./${d}/**)`).join(',')));
  assert.match(unityCall.prompt, /Unity project/);
  assert.equal(G.isUnityProject(unity.dir), true);

  const plain = await refreshWith(t, ok);
  const plainCall = plain.calls.find(isCodemapsCall);
  assert.ok(!plainCall.args.some((a) => a.includes('Library')));
  assert.doesNotMatch(plainCall.prompt, /Unity project/);
  assert.equal(G.isUnityProject(plain.dir), false);
  assert.equal(G.isUnityProject(path.join(plain.dir, 'missing')), false);
});
