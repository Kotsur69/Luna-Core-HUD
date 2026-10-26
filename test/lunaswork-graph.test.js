// ============================================================================
// Luna's Work fresh code graph (src/lunasworkGraph.js, LW 2.23): re-index via
// the codebase-memory CLI or a headless claude limited to index_repository,
// then the codemaps updater - only docs/CODEMAPS is committed and pushed, a
// stray edit elsewhere is restored, an unpushable commit is taken back, and
// nothing ever throws. Real git in temp folders (an origin and a checkout);
// `claude` and the CLI are fakes.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const G = require('../src/lunasworkGraph');

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setupRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-graph-'));
  const origin = path.join(dir, 'origin.git');
  const checkout = path.join(dir, 'checkout');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, checkout);
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'Test');
  git(checkout, 'config', 'core.autocrlf', 'false');
  git(checkout, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(checkout, 'app.js'), 'v1\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'first');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  return { dir, origin, checkout, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const envelope = (raw) => ({ stdout: JSON.stringify({ structured_output: raw, total_cost_usd: 0.01 }) });

/** A fake `claude`: the index call answers `index`, the codemaps call runs `write` in the repo first. */
function fakeClaude({ index = { indexed: true, detail: 'ok' }, write = () => {}, maps = { updated: true, summary: 'maps' } } = {}) {
  const calls = [];
  const runClaude = async (o) => {
    calls.push(o);
    if (o.args.includes('ecc:doc-updater')) {
      write(o.cwd);
      return maps && maps.error ? maps : envelope(maps);
    }
    return index && index.error ? index : envelope(index);
  };
  return { calls, runClaude };
}

const writeMap = (text) => (cwd) => {
  fs.mkdirSync(path.join(cwd, 'docs', 'CODEMAPS'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'docs', 'CODEMAPS', 'overview.md'), text);
};

test('argv: the index call allows only index_repository; the updater gets no shell and no MCP', () => {
  const idx = G.buildIndexClaudeArgs();
  assert.equal(idx[idx.indexOf('--tools') + 1], '');
  assert.equal(idx[idx.indexOf('--allowedTools') + 1], G.INDEX_TOOL);
  const maps = G.buildCodemapsArgs();
  assert.equal(maps[maps.indexOf('--agent') + 1], 'ecc:doc-updater');
  assert.equal(maps[maps.indexOf('--tools') + 1], 'Read,Grep,Glob,Write,Edit');
  assert.match(maps[maps.indexOf('--disallowedTools') + 1], /Bash/);
  assert.ok(maps.includes('--strict-mcp-config'));
  assert.equal(idx[idx.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(maps[maps.indexOf('--permission-mode') + 1], 'dontAsk', 'what is not allowed is denied');
  assert.equal(maps[maps.indexOf('--setting-sources') + 1], '');
  assert.equal(maps[maps.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,Write(docs/CODEMAPS/**),Edit(docs/CODEMAPS/**)');
  assert.match(G.buildCodemapsPrompt({ iteration: 4 }), /iteration 4[\s\S]*Write ONLY files under docs\/CODEMAPS\//);
  assert.deepEqual(G.buildIndexCliArgs('C:\\repo'), ['cli', 'index_repository', '{"repo_path":"C:\\\\repo"}']);
});

test('re-index via claude without the CLI; the codemaps are committed and pushed with the iteration', async () => {
  const r = setupRepo();
  try {
    const claude = fakeClaude({ write: writeMap('# Overview v1\n') });
    const { refreshGraph } = G.createGraphRefresher({ runClaude: claude.runClaude, resolveCli: () => null });
    const res = await refreshGraph({ repoPath: r.checkout, runId: 'lwtest1', iteration: 3 });

    assert.equal(res.ok, true, JSON.stringify(res.notes));
    assert.equal(res.indexed, true);
    assert.equal(res.via, 'claude');
    assert.equal(res.codemaps, 'committed');
    assert.equal(res.pushed, true);
    assert.equal(git(r.origin, 'rev-parse', 'main'), res.sha, 'pushed to the checkout branch on origin');
    assert.equal(git(r.checkout, 'log', '-1', '--format=%s'), "docs(codemaps): refresh after Luna's Work iteration 3");
    assert.deepEqual(git(r.checkout, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['docs/CODEMAPS/overview.md']);
    assert.ok(claude.calls[0].prompt.includes(`repo_path: ${r.checkout}`));

    // Same maps again: nothing to commit.
    const again = await refreshGraph({ repoPath: r.checkout, runId: 'lwtest1', iteration: 4 });
    assert.equal(again.codemaps, 'unchanged');
    assert.equal(again.ok, true);
  } finally {
    r.done();
  }
});

test('the codebase-memory CLI is used when it is on PATH; its error is a note', async () => {
  const r = setupRepo();
  try {
    const cli = path.join(r.dir, 'codebase-memory-mcp.exe');
    const cliCalls = [];
    const execImpl = (file, args, opts, cb) => {
      if (file !== cli) return execFile(file, args, opts, cb);
      cliCalls.push(args);
      const ok = cliCalls.length === 1;
      cb(null, ok ? '{"status":"indexed","nodes":12}' : '{"error":"repo not found"}', '');
      return { stdin: null };
    };
    const claude = fakeClaude({ write: writeMap('# Overview\n') });
    const { refreshGraph } = G.createGraphRefresher({ runClaude: claude.runClaude, resolveCli: () => cli, execImpl });
    const first = await refreshGraph({ repoPath: r.checkout, iteration: 1 });
    assert.equal(first.via, 'cli');
    assert.equal(first.indexed, true);
    assert.deepEqual(cliCalls[0], G.buildIndexCliArgs(r.checkout));
    assert.equal(claude.calls.filter((c) => c.args.includes(G.INDEX_TOOL)).length, 0, 'no claude index call');

    const second = await refreshGraph({ repoPath: r.checkout, iteration: 2 });
    assert.equal(second.indexed, false);
    assert.equal(second.ok, false);
    assert.deepEqual(second.notes, ['code graph not re-indexed (cli): repo not found']);
  } finally {
    r.done();
  }
});

test('a stray edit outside docs/CODEMAPS is restored, a new stray file reported, neither committed', async () => {
  const r = setupRepo();
  try {
    const claude = fakeClaude({
      write: (cwd) => {
        writeMap('# Overview\n')(cwd);
        fs.writeFileSync(path.join(cwd, 'app.js'), 'changed by the updater\n');
        fs.writeFileSync(path.join(cwd, 'stray.txt'), 'x\n');
      },
    });
    const { refreshGraph } = G.createGraphRefresher({ runClaude: claude.runClaude, resolveCli: () => null });
    const res = await refreshGraph({ repoPath: r.checkout, iteration: 2 });

    assert.equal(res.codemaps, 'committed');
    assert.equal(fs.readFileSync(path.join(r.checkout, 'app.js'), 'utf8'), 'v1\n', 'restored');
    assert.deepEqual(git(r.checkout, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['docs/CODEMAPS/overview.md']);
    assert.equal(res.ok, false, 'the stray files are notes');
    assert.match(res.notes.join('\n'), /touched 1 file\(s\) outside docs\/CODEMAPS - restored/);
    assert.match(res.notes.join('\n'), /left 1 new file\(s\) outside docs\/CODEMAPS: stray\.txt/);
  } finally {
    r.done();
  }
});

test('a codemaps commit that cannot be pushed moves nothing locally, so the checkout still fast-forwards', async () => {
  const r = setupRepo();
  try {
    const before = git(r.checkout, 'rev-parse', 'HEAD');
    git(r.checkout, 'remote', 'set-url', 'origin', path.join(r.dir, 'missing.git'));
    const claude = fakeClaude({ write: writeMap('# Overview\n') });
    const { refreshGraph } = G.createGraphRefresher({ runClaude: claude.runClaude, resolveCli: () => null });
    const res = await refreshGraph({ repoPath: r.checkout, iteration: 2 });

    assert.equal(res.ok, false);
    assert.equal(res.codemaps, 'failed');
    assert.equal(res.committed, false);
    assert.equal(git(r.checkout, 'rev-parse', 'HEAD'), before, 'the branch never moved');
    assert.equal(git(r.checkout, 'status', '--porcelain'), '', 'the maps are discarded: nothing blocks the next fast-forward');
    assert.match(res.notes.join('\n'), /codemaps not pushed \(fetch failed: .*\) - maps discarded/);
  } finally {
    r.done();
  }
});

test('a checkout with a commit origin lacks is never published with the maps', async () => {
  const r = setupRepo();
  try {
    fs.writeFileSync(path.join(r.checkout, 'app.js'), 'local only\n');
    git(r.checkout, 'commit', '-q', '-am', 'local work');
    const originBefore = git(r.origin, 'rev-parse', 'main');
    const claude = fakeClaude({ write: writeMap('# Overview\n') });
    const { refreshGraph } = G.createGraphRefresher({ runClaude: claude.runClaude, resolveCli: () => null });
    const res = await refreshGraph({ repoPath: r.checkout, iteration: 2 });
    assert.equal(res.codemaps, 'failed');
    assert.equal(git(r.origin, 'rev-parse', 'main'), originBefore, 'origin untouched');
    assert.match(res.notes.join('\n'), /the checkout has commits origin does not have\) - maps discarded/);
  } finally {
    r.done();
  }
});

test('the codemaps commit leaves what Mati staged alone', async () => {
  const r = setupRepo();
  try {
    fs.writeFileSync(path.join(r.checkout, 'notes.md'), 'mine\n');
    git(r.checkout, 'add', 'notes.md');
    const claude = fakeClaude({ write: writeMap('# Overview\n') });
    const { refreshGraph } = G.createGraphRefresher({ runClaude: claude.runClaude, resolveCli: () => null });
    const res = await refreshGraph({ repoPath: r.checkout, iteration: 2 });
    assert.equal(res.codemaps, 'committed');
    assert.deepEqual(git(r.checkout, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['docs/CODEMAPS/overview.md']);
    assert.equal(git(r.checkout, 'diff', '--cached', '--name-only'), 'notes.md', 'still staged, not committed');
    assert.equal(git(r.checkout, 'status', '--porcelain', '--', 'docs/CODEMAPS'), '', 'the checkout is on the new commit');
  } finally {
    r.done();
  }
});

test('failures never throw: a failed index and a failed updater are notes, nothing is committed', async () => {
  const r = setupRepo();
  try {
    const before = git(r.checkout, 'rev-parse', 'HEAD');
    const claude = fakeClaude({ index: { error: 'timeout' }, write: writeMap('# half\n'), maps: { error: 'budget', detail: 'over budget' } });
    const { refreshGraph } = G.createGraphRefresher({ runClaude: claude.runClaude, resolveCli: () => null });
    const res = await refreshGraph({ repoPath: r.checkout, iteration: 2 });
    assert.equal(res.ok, false);
    assert.equal(res.indexed, false);
    assert.equal(res.codemaps, 'failed');
    assert.deepEqual(res.notes, ['code graph not re-indexed (claude): timeout', 'codemaps update failed: over budget - maps discarded']);
    assert.equal(git(r.checkout, 'rev-parse', 'HEAD'), before);
    assert.equal(git(r.checkout, 'status', '--porcelain'), '', 'the half-written maps are gone');

    const crashing = G.createGraphRefresher({
      runClaude: async () => {
        throw new Error('boom');
      },
      resolveCli: () => null,
    });
    const crashed = await crashing.refreshGraph({ repoPath: r.checkout, iteration: 3 });
    assert.equal(crashed.ok, false);
    assert.match(crashed.notes.join('\n'), /graph refresh crashed: boom/);

    const noRepo = await crashing.refreshGraph({ repoPath: 'relative/path', iteration: 1 });
    assert.deepEqual(noRepo.notes, ['graph refresh skipped: no repo folder']);
  } finally {
    r.done();
  }
});

test('parseStatus reads porcelain lines, renames by their new name', () => {
  assert.deepEqual(G.parseStatus(' M app.js\n?? docs/CODEMAPS/a.md\nR  old.js -> new.js\n'), [
    { code: ' M', file: 'app.js' },
    { code: '??', file: 'docs/CODEMAPS/a.md' },
    { code: 'R ', file: 'new.js' },
  ]);
});
