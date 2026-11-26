// ============================================================================
// Unity editors left open on Luna worktrees (src/unityWorktreeEditors.js), the
// long-path-safe worktree removal fallback (src/worktrees.js removeWorktree)
// and the run report's listing (src/lunasworkRunCleanup.js). Fakes only: no
// real Unity, PowerShell or taskkill ever runs.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ed = require('../src/unityWorktreeEditors');
const { removeWorktree } = require('../src/worktrees');
const { createRunCleanup, cleanupSection } = require('../src/lunasworkRunCleanup');

const W = 'win32';
const MAIN = 'C:\\Users\\mati\\source\\repos\\blade&bullet';
const WT_DIR = 'C:\\Users\\mati\\source\\repos\\.luna-worktrees\\blade&bullet';
const unityExe = '"C:\\Program Files\\Unity\\Hub\\Editor\\6000.6.4f1\\Editor\\Unity.exe"';

/** The process list of the incident: the main checkout's editor, another project's, two on worktrees, and a worker child. */
function incidentProcesses() {
  return [
    { pid: 100, parentPid: 1, commandLine: `${unityExe} -projectpath "${MAIN}" -useHub -hubIPC` },
    { pid: 200, parentPid: 1, commandLine: `${unityExe} -projectPath "C:\\Users\\mati\\source\\repos\\other-game" -useHub` },
    { pid: 300, parentPid: 1, commandLine: `${unityExe} -projectPath "C:/Users/mati/source/repos/.luna-worktrees/blade&bullet/scene-a1b2c" -useHub` },
    { pid: 400, parentPid: 1, commandLine: `${unityExe} -PROJECTPATH=C:\\Users\\Mati\\Source\\Repos\\.luna-worktrees\\Blade&Bullet\\hud-x9y8z\\` },
    // The AssetImportWorker child of 300: the tree kill of 300 takes it along.
    { pid: 301, parentPid: 300, commandLine: `${unityExe} -adb2 -batchMode -noUpm -name AssetImportWorker0 -projectPath C:/Users/mati/source/repos/.luna-worktrees/blade&bullet/scene-a1b2c -logFile x.log` },
  ];
}

/** A fake machine: processes that exit when quit (if listed in `quits`) or killed. */
function fakeMachine(rows, { quits = [], killFails = [] } = {}) {
  const alive = new Set(rows.map((r) => r.pid));
  const calls = { quit: [], kill: [], lists: 0 };
  let clock = 0;
  return {
    calls,
    alive,
    opts: {
      platform: W,
      repoPath: MAIN,
      listProcesses: async () => {
        calls.lists += 1;
        return rows.filter((r) => alive.has(r.pid));
      },
      quitViaPipeline: async (projectPath, pid) => {
        calls.quit.push(pid);
        if (quits.includes(pid)) {
          alive.delete(pid);
          return { sent: true };
        }
        return { sent: false, detail: 'no Unity Pipeline port file' };
      },
      killTree: async (pid) => {
        calls.kill.push(pid);
        if (killFails.includes(pid)) return { ok: false, reason: 'Access is denied.' };
        for (const r of rows) if (r.pid === pid || r.parentPid === pid) alive.delete(r.pid);
        return { ok: true };
      },
      isRunning: (pid) => alive.has(pid),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
  };
}

// ---- findEditors -------------------------------------------------------------

test('projectPathOf reads quoted, unquoted and = forms in any case', () => {
  assert.equal(ed.projectPathOf('Unity.exe -projectPath "C:\\a b\\c" -x'), 'C:\\a b\\c');
  assert.equal(ed.projectPathOf('Unity.exe -projectpath C:/a/c -x'), 'C:/a/c');
  assert.equal(ed.projectPathOf('Unity.exe -PROJECTPATH=C:\\a\\c'), 'C:\\a\\c');
  assert.equal(ed.projectPathOf('Unity.exe -batchmode'), null);
  assert.equal(ed.projectPathOf('Unity.exe -myprojectPath C:\\a'), null, 'only the real flag');
});

test('findEditors: only the two worktree editors, never the main checkout or another project, no worker child', async () => {
  const m = fakeMachine(incidentProcesses());
  const found = await ed.findEditors(WT_DIR, m.opts);
  assert.deepEqual(found.map((e) => e.pid).sort(), [300, 400]);
});

test('findEditors: Windows paths compare with mixed slashes, case and a trailing separator', async () => {
  const m = fakeMachine(incidentProcesses());
  const found = await ed.findEditors('c:/users/MATI/source/repos/.luna-worktrees/blade&bullet/', m.opts);
  assert.deepEqual(found.map((e) => e.pid).sort(), [300, 400]);
  const one = await ed.findEditors(`${WT_DIR}\\scene-a1b2c`, m.opts);
  assert.deepEqual(one, [{ pid: 300, projectPath: 'C:/Users/mati/source/repos/.luna-worktrees/blade&bullet/scene-a1b2c' }]);
  assert.deepEqual(await ed.findEditors(`${WT_DIR}\\scene`, m.opts), [], 'a name prefix is not a parent folder');
});

test('findEditors: the main checkout is excluded even when the given root is its parent', async () => {
  const m = fakeMachine(incidentProcesses());
  const found = await ed.findEditors('C:\\Users\\mati\\source\\repos', m.opts);
  assert.ok(!found.some((e) => e.pid === 100), 'never the main checkout');
  assert.deepEqual(found.map((e) => e.pid).sort(), [200, 300, 400]);
  // A Unity project in a sub-folder of the main checkout, and an editor on a folder above it.
  const rows = [
    { pid: 10, commandLine: `Unity.exe -projectPath "${MAIN}\\UnityGame"` },
    { pid: 11, commandLine: 'Unity.exe -projectPath "C:\\Users\\mati\\source"' },
  ];
  assert.deepEqual(await ed.findEditors('C:\\Users', { platform: W, repoPath: MAIN, listProcesses: async () => rows }), []);
});

test('findEditors: relative or missing project paths and bad pids are ignored; other platforms list nothing', async () => {
  const rows = [
    { pid: 1, commandLine: 'Unity.exe -projectPath scene-a1b2c' },
    { pid: 0, commandLine: `Unity.exe -projectPath "${WT_DIR}\\a"` },
    { pid: 2, commandLine: 'Unity.exe' },
    null,
  ];
  assert.deepEqual(await ed.findEditors(WT_DIR, { platform: W, repoPath: MAIN, listProcesses: async () => rows }), []);
  assert.deepEqual(await ed.listUnityProcesses({ platform: 'linux' }), []);
  assert.deepEqual(await ed.findEditors('relative/root', { platform: W, listProcesses: async () => incidentProcesses() }), []);
});

test('listUnityProcesses parses PowerShell JSON (one object or an array) via execFile, no shell', async () => {
  const seen = [];
  const execImpl = (cmd, args, opts, cb) => {
    seen.push({ cmd, args, shell: opts.shell });
    cb(null, JSON.stringify({ ProcessId: 7, ParentProcessId: 1, CommandLine: 'Unity.exe -projectPath C:\\x' }), '');
  };
  assert.deepEqual(await ed.listUnityProcesses({ platform: W, execImpl }), [{ pid: 7, parentPid: 1, commandLine: 'Unity.exe -projectPath C:\\x' }]);
  assert.equal(seen[0].cmd, 'powershell.exe');
  assert.equal(seen[0].shell, undefined);
  assert.match(seen[0].args.join(' '), /Win32_Process -Filter "Name='Unity.exe'"/);
  const empty = (cmd, args, opts, cb) => cb(null, '', '');
  assert.deepEqual(await ed.listUnityProcesses({ platform: W, execImpl: empty }), []);
  const broken = (cmd, args, opts, cb) => cb(new Error('boom'), '', 'access denied');
  await assert.rejects(ed.listUnityProcesses({ platform: W, execImpl: broken }), /listing Unity processes failed: access denied/);
});

// ---- closeEditors ------------------------------------------------------------

test('closeEditors: closes only the two worktree editors; the main checkout and other project keep running', async () => {
  const m = fakeMachine(incidentProcesses(), { quits: [300] });
  const res = await ed.closeEditors(WT_DIR, m.opts);
  assert.deepEqual(res.closed.map((c) => [c.pid, c.how]).sort(), [[300, 'quit'], [400, 'killed']]);
  assert.deepEqual(res.failed, []);
  assert.ok(m.alive.has(100), 'the main checkout editor is never touched');
  assert.ok(m.alive.has(200), 'another project is never touched');
  assert.ok(!m.calls.quit.includes(100) && !m.calls.kill.includes(100));
  assert.deepEqual(m.calls.kill, [400], 'a gracefully quit editor is not killed');
});

test('closeEditors: graceful quit path waits for the exit, kill fallback after QUIT_WAIT_MS', async () => {
  const rows = [{ pid: 500, commandLine: `Unity.exe -projectPath "${WT_DIR}\\a"` }];
  // Quit is sent but the editor hangs on it: killed after the wait.
  const m = fakeMachine(rows);
  m.opts.quitViaPipeline = async (projectPath, pid) => (m.calls.quit.push(pid), { sent: true });
  const res = await ed.closeEditors(WT_DIR, m.opts);
  assert.deepEqual(res.closed, [{ pid: 500, projectPath: `${WT_DIR}\\a`, how: 'killed' }]);
  assert.ok(m.opts.now() >= ed.QUIT_WAIT_MS, 'waited the full quit window first');
  assert.equal(m.calls.lists, 2, 'the pid is confirmed again before the kill');

  // Quit works: no kill at all.
  const q = fakeMachine(rows, { quits: [500] });
  assert.deepEqual((await ed.closeEditors(WT_DIR, q.opts)).closed, [{ pid: 500, projectPath: `${WT_DIR}\\a`, how: 'quit' }]);
  assert.deepEqual(q.calls.kill, []);
});

test('closeEditors: a failed kill and a failed list are reported, never thrown', async () => {
  const rows = [{ pid: 600, commandLine: `Unity.exe -projectPath "${WT_DIR}\\a"` }];
  const m = fakeMachine(rows, { killFails: [600] });
  const res = await ed.closeEditors(WT_DIR, m.opts);
  assert.deepEqual(res.closed, []);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].detail, /taskkill failed: Access is denied/);

  const listFails = await ed.closeEditors(WT_DIR, {
    ...m.opts,
    listProcesses: async () => {
      throw new Error('CIM down');
    },
  });
  assert.deepEqual(listFails, { closed: [], failed: [{ pid: null, projectPath: null, detail: 'CIM down' }] });
});

test('closeEditors: a pid that stopped being the editor before the kill is not killed', async () => {
  const rows = [{ pid: 700, commandLine: `Unity.exe -projectPath "${WT_DIR}\\a"` }];
  const m = fakeMachine(rows);
  let lists = 0;
  // Second list: pid 700 is now some other process (reused).
  m.opts.listProcesses = async () => (++lists === 1 ? rows : []);
  const res = await ed.closeEditors(WT_DIR, m.opts);
  assert.deepEqual(m.calls.kill, []);
  assert.match(res.failed[0].detail, /no longer belongs to this editor/);
});

test('closeEditors: skip leaves an editor open', async () => {
  const m = fakeMachine(incidentProcesses());
  const res = await ed.closeEditors(WT_DIR, { ...m.opts, skip: (p) => /hud-/i.test(p) });
  assert.deepEqual(res.closed.map((c) => c.pid), [300]);
  assert.ok(m.alive.has(400));
});

test('quitViaPipeline: asks the editor that owns the port file to exit; skips a port file of another pid', async () => {
  const sent = [];
  const descriptor = { pid: 800, port: 5000, evalToken: 'abc', lastHeartbeat: new Date().toISOString() };
  const readFile = async () => JSON.stringify(descriptor);
  const createClient = (opts) => ({
    exec: async (command, parameters) => {
      sent.push({ dir: opts.projectDir, command, parameters });
      return 'exiting';
    },
  });
  const res = await ed.quitViaPipeline(`${WT_DIR}\\a`, 800, { readFile, createClient });
  assert.deepEqual(res, { sent: true, detail: 'script eval' });
  assert.match(sent[0].parameters.code, /EditorApplication\.Exit\(0\)/);
  assert.equal((await ed.quitViaPipeline(`${WT_DIR}\\a`, 801, { readFile, createClient })).sent, false);
  const missing = async () => {
    throw Object.assign(new Error('nope'), { code: 'ENOENT' });
  };
  assert.deepEqual(await ed.quitViaPipeline(`${WT_DIR}\\a`, 800, { readFile: missing, createClient }), { sent: false, detail: 'no Unity Pipeline port file' });
});

test('quitViaPipeline: script eval refused falls back to File/Exit; a lost reply counts as sent', async () => {
  const descriptor = { pid: 900, port: 5000, evalToken: 'abc', lastHeartbeat: new Date().toISOString() };
  const readFile = async () => JSON.stringify(descriptor);
  const tried = [];
  const refusing = () => ({
    exec: async (command) => {
      tried.push(command);
      if (command === 'script eval') throw Object.assign(new Error('Command Not Found'), { code: 'UNITY_PIPELINE_FAILED' });
      return null;
    },
  });
  assert.deepEqual(await ed.quitViaPipeline('C:\\p', 900, { readFile, createClient: refusing }), { sent: true, detail: 'editor invoke_menu' });
  assert.deepEqual(tried, ['script eval', 'editor invoke_menu']);
  const dropping = () => ({
    exec: async () => {
      throw Object.assign(new Error('timeout'), { code: 'UNITY_PIPELINE_TIMEOUT' });
    },
  });
  assert.equal((await ed.quitViaPipeline('C:\\p', 900, { readFile, createClient: dropping })).sent, true);
});

test('hasUnityProject / closeEditorsIfUnity: no process list for a folder without a Unity project', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-uwe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(ed.hasUnityProject(dir), false);
  let listed = 0;
  const listProcesses = async () => {
    listed += 1;
    return [];
  };
  assert.deepEqual(await ed.closeEditorsIfUnity(dir, { platform: W, listProcesses }), { closed: [], failed: [] });
  assert.equal(listed, 0);
  fs.mkdirSync(path.join(dir, 'Game', 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.6.4f1\n');
  assert.equal(ed.hasUnityProject(dir), true);
  await ed.closeEditorsIfUnity(dir, { platform: W, listProcesses });
  assert.equal(listed, 1);
  await ed.closeEditorsIfUnity(dir, { platform: 'linux', listProcesses });
  assert.equal(listed, 1, 'never off Windows');
});

// ---- removeWorktree: editors first, long-path fallback ------------------------

/** Fake git: clean status, a failing `worktree remove`, a list naming main + `root` (or `listRoots`). */
function fallbackGit(repo, root, { listRoots } = {}) {
  const calls = [];
  const execImpl = (cmd, args, opts, cb) => {
    const a = args.slice(2);
    calls.push(a.join(' '));
    if (a[0] === 'status') return cb(null, '', '');
    if (a[0] === 'worktree' && a[1] === 'remove') {
      return cb(Object.assign(new Error('x'), { code: 255 }), '', 'error: cannot remove Library/Bee/artifacts/x.dll: Filename too long\n');
    }
    if (a[0] === 'worktree' && a[1] === 'list') {
      const roots = listRoots || [repo, root];
      const blocks = roots.map((r, i) => `worktree ${r.replace(/\\/g, '/')}\nHEAD abc\nbranch refs/heads/${i ? 'luna/x' : 'main'}\n`);
      return cb(null, blocks.join('\n'), '');
    }
    return cb(null, '', '');
  };
  return { execImpl, calls };
}

test('removeWorktree: a deep Library/ folder (> 260 chars) is removed by the long-path fallback', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-uwe-'));
  t.after(() => fs.rmSync(path.toNamespacedPath(base), { recursive: true, force: true }));
  const repo = path.join(base, 'game');
  const root = path.join(base, '.luna-worktrees', 'game', 'scene-a1b2c');
  fs.mkdirSync(repo, { recursive: true });
  let deep = path.join(root, 'Library', 'Bee', 'artifacts');
  while (deep.length < 300) deep = path.join(deep, 'a-rather-long-folder-name-0123456789');
  fs.mkdirSync(path.toNamespacedPath(deep), { recursive: true });
  const deepFile = path.join(deep, 'Assembly-CSharp.dll');
  fs.writeFileSync(path.toNamespacedPath(deepFile), 'x');
  assert.ok(deepFile.length > 260);

  const git = fallbackGit(repo, root);
  const closeCalls = [];
  const closeEditors = async (r, opts) => {
    closeCalls.push([r, opts.repoPath]);
    return { closed: [{ pid: 300, projectPath: r, how: 'killed' }], failed: [] };
  };
  const res = await removeWorktree(repo, root, { execImpl: git.execImpl, closeEditors });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.fallback, /Filename too long/);
  assert.deepEqual(res.editors, { closed: [{ pid: 300, projectPath: root, how: 'killed' }], failed: [] });
  assert.deepEqual(closeCalls, [[root, repo]], 'editors closed for that root, main checkout protected');
  assert.equal(fs.existsSync(path.toNamespacedPath(root)), false, 'the deep folder is gone');
  assert.ok(fs.existsSync(repo), 'the main checkout stays');
  const order = git.calls.map((c) => c.split(' ').slice(0, 2).join(' '));
  assert.deepEqual(order, ['status --porcelain', 'worktree remove', 'worktree list', 'worktree prune']);
});

test('removeWorktree fallback never deletes the main checkout, an unlisted folder or a parent of the checkout', async () => {
  const repo = path.resolve('/r/game');
  const deleted = [];
  const rmDir = async (dir) => {
    deleted.push(dir);
  };
  const noEditors = async () => ({ closed: [], failed: [] });
  const cases = [
    ['the main worktree itself', repo, undefined],
    ['an unlisted folder', path.resolve('/r/.luna-worktrees/game/x'), [repo, path.resolve('/r/.luna-worktrees/game/y')]],
    ['a parent of the checkout listed as a worktree', path.resolve('/r'), [repo, path.resolve('/r')]],
  ];
  for (const [what, root, listRoots] of cases) {
    const git = fallbackGit(repo, root, { listRoots });
    const res = await removeWorktree(repo, root, { execImpl: git.execImpl, closeEditors: noEditors, rmDir, existsSync: () => false });
    assert.equal(res.ok, false, what);
    assert.equal(res.error, 'gitFailed', what);
    assert.ok(!git.calls.some((c) => c.startsWith('worktree prune')), what);
  }
  assert.deepEqual(deleted, []);
});

test('removeWorktree: dirty refusal unchanged - no editor is closed and nothing deleted', async () => {
  let closed = 0;
  const execImpl = (cmd, args, opts, cb) => cb(null, args[2] === 'status' ? ' M Assets/Scene.unity\n' : '', '');
  const closeEditors = async () => {
    closed += 1;
    return { closed: [], failed: [] };
  };
  const res = await removeWorktree('/r', '/wt/a', { execImpl, closeEditors });
  assert.equal(res.error, 'dirty');
  assert.equal(closed, 0);
});

test("removeWorktree: a failed delete in the fallback is reported with git's reason", async () => {
  const repo = path.resolve('/r/game');
  const root = path.resolve('/r/.luna-worktrees/game/x');
  const git = fallbackGit(repo, root);
  const rmDir = async () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  };
  const closeEditors = async () => ({ closed: [], failed: [{ pid: 1, projectPath: root, detail: 'x' }] });
  const res = await removeWorktree(repo, root, { execImpl: git.execImpl, closeEditors, rmDir });
  assert.equal(res.error, 'gitFailed');
  assert.match(res.detail, /Filename too long.*deleting the folder failed too: EBUSY/);
  assert.equal(res.editors.failed.length, 1);
});

// ---- run cleanup + report ----------------------------------------------------

test('atRunEnd collects closed editors, sweeps the worktree folder (never main, never an open tab) and the report lists them', async () => {
  const repo = path.resolve('/src/blade&bullet');
  const wtDir = path.resolve('/src/.luna-worktrees/blade&bullet');
  const gone = path.join(wtDir, 'scene-a1b2c');
  const stuck = path.join(wtDir, 'hud-x9y8z');
  const tab = path.join(wtDir, 'tab-q1w2e');
  const listed = [
    { root: repo, branch: 'main' },
    { root: gone, branch: 'luna/scene-a1b2c' },
    { root: stuck, branch: 'luna/hud-x9y8z' },
    { root: tab, branch: 'luna/tab-q1w2e' },
  ];
  const git = {
    run: async (cwd, args) => (args[0] === 'symbolic-ref' ? { ok: true, stdout: 'main\n' } : { ok: true, stdout: '' }),
    listWorktrees: async () => listed,
    removeWorktree: async (_repo, root) =>
      root === gone
        ? { ok: true, editors: { closed: [{ pid: 300, projectPath: gone, how: 'quit' }], failed: [] } }
        : { ok: false, error: 'gitFailed', detail: 'Permission denied', editors: { closed: [], failed: [{ pid: 400, projectPath: stuck, detail: 'taskkill failed' }] } },
    pruneWorktrees: async () => ({ ok: true }),
    deleteMergedBranch: async () => ({ ok: false, error: 'missing' }),
    deleteMergedRemoteBranch: async () => ({ ok: false, error: 'missing' }),
    pruneOrigin: async () => ({ ok: true }),
  };
  const sweeps = [];
  const closeEditors = async (root, opts) => {
    sweeps.push({ root, opts });
    const leftover = path.join(wtDir, 'old-folder');
    return { closed: [leftover].filter((p) => !opts.skip(p)).map((p) => ({ pid: 500, projectPath: p, how: 'killed' })), failed: [] };
  };
  const cleanup = createRunCleanup({ git, closeEditors, inUse: (root) => root === tab });
  const res = await cleanup.atRunEnd({ id: 'r1', repoPath: repo, branches: ['luna/scene-a1b2c', 'luna/hud-x9y8z', 'luna/tab-q1w2e'] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.editors.closed.map((e) => [e.pid, e.how]), [[300, 'quit'], [500, 'killed']]);
  assert.deepEqual(res.editors.failed.map((e) => e.pid), [400]);
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].root, wtDir, 'the sweep covers .luna-worktrees/<project>');
  assert.ok(sweeps[0].opts.repoPath.includes(repo), 'the main checkout is protected');
  assert.equal(sweeps[0].opts.skip(path.join(tab, 'Game')), true, 'an editor on a worktree with an open tab stays');
  assert.equal(sweeps[0].opts.skip(stuck), false);
  assert.deepEqual(res.worktrees.kept.map((w) => [path.basename(w.root), w.reason]).sort(), [['hud-x9y8z', 'editorOpen'], ['tab-q1w2e', 'openTab']]);

  const local = cleanupSection(res);
  assert.match(local.intro, /Closed 2 Unity editor\(s\) left open on worktrees\./);
  assert.ok(local.items.includes(`Closed Unity editor on ${gone} (pid 300, quit)`), local.items.join('\n'));
  assert.ok(local.items.includes(`Unity editor not closed: ${stuck} (pid 400)`));
  assert.ok(local.items.includes(`Worktree kept: ${stuck} (luna/hud-x9y8z): a Unity editor on it would not close`));
  const email = cleanupSection(res, { forEmail: true });
  assert.ok(email.items.includes('Closed Unity editor on scene-a1b2c (pid 300, quit)'), email.items.join('\n'));
  assert.ok(email.items.includes('Closed Unity editor on old-folder (pid 500, killed)'));
  assert.ok(email.items.includes('Worktree kept: hud-x9y8z (luna/hud-x9y8z): a Unity editor on it would not close'));
  assert.ok(email.items.includes('Worktree kept: tab-q1w2e (luna/tab-q1w2e): a tab is open in it'));
  assert.ok(!email.items.join('\n').includes(wtDir), 'no local path in the email');
});

test('cleanupSection: a run whose only cleanup was closing an editor still gets a section; old results without editors still render', () => {
  const empty = { ok: true, files: [], worktrees: { removed: [], kept: [] }, branches: { deleted: [], kept: [] }, remote: { deleted: [], kept: [] } };
  const only = { ...empty, editors: { closed: [{ pid: 1, projectPath: path.resolve('/x/wt/a'), how: 'quit' }], failed: [] } };
  assert.deepEqual(cleanupSection(only, { forEmail: true }).items, ['Closed Unity editor on a (pid 1, quit)']);
  const old = { ...empty, worktrees: { removed: ['/x'], kept: [] } };
  assert.deepEqual(cleanupSection(old).items, []);
  assert.equal(cleanupSection(empty), null);
});
