// ============================================================================
// LunaCore - Claude setup switcher, main side (src/claudesetup.js)
// ----------------------------------------------------------------------------
// Nothing real runs here: execFile, fs and the tree-kill are fakes, so no git,
// no node child and no ~/.luna-setup-repo is touched. What is pinned:
//   * every spawn is shell-less, with constant args (+ one checked name);
//   * the CLI runs as LunaCore's own binary with ELECTRON_RUN_AS_NODE=1;
//   * clone on first use, fetch before list, fall back to the clone offline;
//   * non-JSON output (a switcher from before --json) is 'switcher-too-old',
//     and `use` is never spawned unless a JSON `list` named the profile;
//   * timeouts kill the tree and resolve {ok:false}; nothing throws.
// The widget's markup/i18n wiring is pinned at the bottom.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createClaudeSetup, parseJsonOutput, validName, tokensOf, REPO_URL } = require('../src/claudesetup');

const ROOT = path.join(__dirname, '..');
const REPO = path.resolve('/fake-home/.luna-setup-repo');
const GIT_DIR = path.join(REPO, '.git');
const SCRIPT = path.join(REPO, 'tools', 'luna-setup.mjs');
const NODE = path.resolve('/fake/LunaCore.exe');

const PROFILES = [
  { name: 'coding', description: 'Everyday coding', active: true },
  { name: 'minimal', description: 'Bare minimum', active: false },
  { name: 'current', description: 'Snapshot of the live setup', active: false },
];

const json = (v) => ({ stdout: JSON.stringify(v) });

const DEFAULT_HANDLERS = {
  clone: (_call, files) => {
    files.add(REPO);
    files.add(GIT_DIR);
    files.add(SCRIPT);
    return {};
  },
  fetch: {},
  merge: {},
  list: json(PROFILES),
  status: json({ profile: 'coding', appliedAt: '2026-11-10T12:00:00Z', measure: { approxAlwaysOnTokens: 18234 } }),
  preview: json({
    report: { dryRun: true, profile: 'minimal', from: 'coding', steps: ['replace settings.json', 'remove 12 skills'], warnings: ['plugin x is not installed'] },
    running: 3,
  }),
  apply: json({ report: { profile: 'minimal', from: 'coding', steps: ['replaced settings.json'], warnings: [] }, measure: { approxAlwaysOnTokens: 4200 }, running: 2 }),
  tasklist: { stdout: '"claude.exe","101","Console","1","120,000 K"\r\n"claude.exe","202","Console","1","99,000 K"\r\n' },
  pgrep: { stdout: '' },
};

/** Which call this is: git clone/fetch/merge, a switcher command, or an OS tool. */
function kindOf(cmd, args) {
  if (cmd === 'git') return args[0] === 'clone' ? 'clone' : args[2];
  if (cmd === NODE) {
    if (args[1] !== 'use') return args[1];
    return args.includes('--dry-run') ? 'preview' : 'apply';
  }
  if (/tasklist\.exe$/i.test(cmd)) return 'tasklist';
  return cmd;
}

function harness({
  exists = [REPO, GIT_DIR, SCRIPT],
  handlers = {},
  platform = 'win32',
  timeouts,
  env = { PATH: '/bin', HOME: '/fake-home' },
  killEndsChild = false,
} = {}) {
  const files = new Set(exists);
  const calls = [];
  const kills = [];
  const removed = [];
  const hung = [];
  const all = { ...DEFAULT_HANDLERS, ...handlers };
  const execFile = (cmd, args, opts, cb) => {
    const call = { cmd, args, opts, kind: kindOf(cmd, args) };
    calls.push(call);
    const h = all[call.kind];
    const r = (typeof h === 'function' ? h(call, files) : h) || {};
    if (r.throws) throw new Error(r.throws);
    if (r.hang) {
      hung.push(cb);
    } else {
      setImmediate(() => {
        const err = r.error ? Object.assign(new Error(r.error), { code: r.code === undefined ? 1 : r.code }) : null;
        cb(err, r.stdout || '', r.stderr || '');
      });
    }
    return { pid: 4242 };
  };
  const kill = (pid) => {
    kills.push(pid);
    // A real kill makes the child exit, so its callback fires (with an error).
    const cb = hung.pop();
    if (killEndsChild && cb) cb(Object.assign(new Error('killed'), { code: null, killed: true }), '', '');
    return true;
  };
  const logs = [];
  const setup = createClaudeSetup({
    repoDir: REPO,
    nodePath: NODE,
    getEnv: () => env,
    execFile,
    kill,
    removeDir: async (dir) => {
      removed.push(dir);
      for (const f of [...files]) if (f === dir || f.startsWith(dir + path.sep)) files.delete(f);
    },
    fs: { existsSync: (p) => files.has(p) },
    platform,
    timeouts,
    log: (line) => logs.push(line),
  });
  return { setup, calls, kills, removed, files, logs, kinds: () => calls.map((c) => c.kind) };
}

// ---- pure helpers ----------------------------------------------------------------

test('validName: plain profile names only', () => {
  for (const ok of ['coding', 'minimal', 'lunawork', 'my-profile_2', 'A1']) assert.equal(validName(ok), true, ok);
  for (const no of ['', ' coding', 'coding ', '..', '.', 'a.b', 'a/b', 'a\\b', '-x', '--dry-run', 'x'.repeat(41), 42, null, undefined, {}, ['coding']]) {
    assert.equal(validName(no), false, JSON.stringify(no));
  }
});

test('parseJsonOutput: whole output, JSON after noise, and non-JSON', () => {
  assert.deepEqual(parseJsonOutput('[{"name":"a"}]'), [{ name: 'a' }]);
  assert.deepEqual(parseJsonOutput('  - plugin x: ready\n{"running":2}\n'), { running: 2 });
  assert.deepEqual(parseJsonOutput('noise line\n{\n  "profile": "coding"\n}\n'), { profile: 'coding' });
  assert.equal(parseJsonOutput('* coding         Everyday coding\n  minimal        Bare'), undefined);
  assert.equal(parseJsonOutput('config dir : C:\\x\nprofile    : coding'), undefined);
  assert.equal(parseJsonOutput(''), undefined);
  assert.equal(parseJsonOutput(undefined), undefined);
});

test('tokensOf: approxAlwaysOnTokens or null', () => {
  assert.equal(tokensOf({ approxAlwaysOnTokens: 18234.4 }), 18234);
  assert.equal(tokensOf({ approxAlwaysOnTokens: -1 }), null);
  assert.equal(tokensOf({ approxAlwaysOnTokens: '18000' }), null);
  assert.equal(tokensOf(null), null);
});

// ---- spawning ----------------------------------------------------------------------

test('list: fetch first, then the CLI under LunaCore with ELECTRON_RUN_AS_NODE, no shell', async () => {
  const h = harness();
  const res = await h.setup.list();
  assert.deepEqual(res, { ok: true, profiles: PROFILES, stale: false });
  assert.deepEqual(h.kinds(), ['fetch', 'merge', 'list']);

  const [fetch, merge, list] = h.calls;
  assert.deepEqual(fetch.args, ['-C', REPO, 'fetch', '--quiet', 'origin']);
  assert.deepEqual(merge.args, ['-C', REPO, 'merge', '--ff-only', '--quiet', '@{u}']);
  assert.equal(fetch.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(list.cmd, NODE);
  assert.deepEqual(list.args, [SCRIPT, 'list', '--json', '--offline']);
  assert.equal(list.opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(list.opts.env.PATH, '/bin');
  assert.equal(list.opts.cwd, REPO);
  for (const c of h.calls) {
    assert.notEqual(c.opts.shell, true, `${c.kind} must not run through a shell`);
    assert.equal(c.opts.windowsHide, true);
    assert.equal(c.opts.detached, false, 'on Windows taskkill /T reaches the tree, no own group needed');
  }
});

test('inherited GIT_* variables never reach git or the CLI', async () => {
  const h = harness({ env: { PATH: '/bin', GIT_DIR: '/elsewhere/.git', GIT_CONFIG_GLOBAL: '/evil', git_work_tree: '/x' } });
  assert.equal((await h.setup.list()).ok, true);
  for (const c of h.calls) {
    assert.equal(c.opts.env.GIT_DIR, undefined, c.kind);
    assert.equal(c.opts.env.GIT_CONFIG_GLOBAL, undefined, c.kind);
    assert.equal(c.opts.env.git_work_tree, undefined, c.kind);
    assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, '0', c.kind);
    assert.equal(c.opts.env.PATH, '/bin', c.kind);
  }
});

test('off Windows each child gets its own process group, so a timeout kills the tree', async () => {
  const h = harness({ platform: 'linux' });
  await h.setup.list();
  assert.ok(h.calls.length > 0);
  for (const c of h.calls) assert.equal(c.opts.detached, true, c.kind);
});

test('list: a failed fetch falls back to the existing clone and says stale', async () => {
  const h = harness({ handlers: { fetch: { error: 'Could not resolve host: github.com', stderr: 'fatal: unable to access' } } });
  const res = await h.setup.list();
  assert.equal(res.ok, true);
  assert.equal(res.stale, true);
  assert.equal(res.profiles.length, 3);
  assert.deepEqual(h.kinds(), ['fetch', 'list']);
});

test('list: a fast-forward that fails is not fatal', async () => {
  const h = harness({ handlers: { merge: { error: 'Not possible to fast-forward' } } });
  const res = await h.setup.list();
  assert.equal(res.ok, true);
  assert.equal(res.stale, false);
});

test('clone on first use: git clone into the repo dir, then list without a fetch', async () => {
  const h = harness({ exists: [] });
  const res = await h.setup.list();
  assert.equal(res.ok, true);
  assert.equal(res.stale, false);
  assert.deepEqual(h.kinds(), ['clone', 'list']);
  assert.deepEqual(h.calls[0].args, ['clone', '--quiet', REPO_URL, REPO]);
  assert.notEqual(h.calls[0].opts.shell, true);
});

test('a failed clone is {ok:false} and nothing else spawns', async () => {
  const h = harness({ exists: [], handlers: { clone: { error: 'Repository not found' } } });
  assert.deepEqual(await h.setup.list(), { ok: false, error: 'clone-failed' });
  assert.deepEqual(h.kinds(), ['clone']);
  assert.deepEqual(h.removed, [], 'nothing was created, nothing to remove');
});

test('a half-made clone is removed, so the next list clones afresh', async () => {
  let attempts = 0;
  const h = harness({
    exists: [],
    handlers: {
      clone: (_c, files) => {
        attempts += 1;
        files.add(REPO);
        files.add(GIT_DIR);
        if (attempts === 1) return { error: 'the remote end hung up unexpectedly' };
        files.add(SCRIPT);
        return {};
      },
    },
  });
  assert.deepEqual(await h.setup.list(), { ok: false, error: 'clone-failed' });
  assert.deepEqual(h.removed, [REPO]);
  assert.equal(h.files.has(GIT_DIR), false);
  assert.equal((await h.setup.list()).ok, true);
  assert.deepEqual(h.kinds(), ['clone', 'clone', 'list']);
});

test('a folder that is not a clone is never touched', async () => {
  const h = harness({ exists: [REPO] });
  assert.deepEqual(await h.setup.list(), { ok: false, error: 'repo-broken' });
  assert.deepEqual(h.kinds(), []);
});

test('no CLI in the clone: no-switcher; a fetch that brings it in fixes that', async () => {
  const missing = harness({ exists: [REPO, GIT_DIR] });
  assert.deepEqual(await missing.setup.list(), { ok: false, error: 'no-switcher' });
  assert.deepEqual(missing.kinds(), ['fetch', 'merge']);

  const arrives = harness({
    exists: [REPO, GIT_DIR],
    handlers: { merge: (_c, files) => (files.add(SCRIPT), {}) },
  });
  assert.equal((await arrives.setup.list()).ok, true);
});

test('list drops malformed entries and bounds descriptions', async () => {
  const h = harness({
    handlers: {
      list: json([
        { name: 'coding', description: 'x'.repeat(500), active: true },
        { name: '../escape', description: 'bad' },
        { name: '--dry-run', description: 'bad' },
        { name: 'coding', description: 'duplicate' },
        'minimal',
        null,
        { name: 'minimal', description: 'line\none', active: 'yes' },
      ]),
    },
  });
  const res = await h.setup.list();
  assert.equal(res.ok, true);
  assert.deepEqual(res.profiles.map((p) => p.name), ['coding', 'minimal']);
  assert.equal(res.profiles[0].description.length, 200);
  assert.equal(res.profiles[1].description, 'line one');
  assert.equal(res.profiles[1].active, false);
});

// ---- old switcher (no --json) ------------------------------------------------------

test('non-JSON output means switcher-too-old', async () => {
  const h = harness({
    handlers: {
      list: { stdout: '* coding         Everyday coding\n  minimal        Bare minimum\n' },
      status: { stdout: 'config dir : C:\\Users\\x\\.claude\nprofile    : coding\n' },
    },
  });
  assert.deepEqual(await h.setup.list(), { ok: false, error: 'switcher-too-old' });
  assert.deepEqual(await h.setup.status(), { ok: false, error: 'switcher-too-old' });
});

test('an old switcher never gets a `use`: list fails first', async () => {
  const h = harness({ handlers: { list: { stdout: '* coding   Everyday coding\n' } } });
  assert.deepEqual(await h.setup.preview('minimal'), { ok: false, error: 'switcher-too-old' });
  assert.deepEqual(await h.setup.apply('minimal'), { ok: false, error: 'switcher-too-old' });
  assert.ok(!h.kinds().includes('preview') && !h.kinds().includes('apply'), h.kinds().join(','));
});

// ---- status / preview / apply ------------------------------------------------------

test('status: only whitelisted fields; unmanaged is profile null', async () => {
  const h = harness();
  assert.deepEqual(await h.setup.status(), { ok: true, profile: 'coding', appliedAt: '2026-11-10T12:00:00Z', tokens: 18234 });
  assert.deepEqual(h.calls[0].args, [SCRIPT, 'status', '--json', '--offline']);

  const u = harness({ handlers: { status: json({ profile: null, appliedAt: null, measure: { approxAlwaysOnTokens: 30000 }, claudeDir: 'C:/x' }) } });
  assert.deepEqual(await u.setup.status(), { ok: true, profile: null, appliedAt: null, tokens: 30000 });
});

test('preview and apply refuse a bad name without spawning anything', async () => {
  const h = harness();
  for (const name of ['', '..', '-x', '--dry-run', 'a/b', 42, null, { name: 'coding' }]) {
    assert.deepEqual(await h.setup.preview(name), { ok: false, error: 'bad-name' });
    assert.deepEqual(await h.setup.apply(name), { ok: false, error: 'bad-name' });
  }
  assert.equal(h.calls.length, 0);
});

test('a well-formed name the CLI does not list is refused before `use`', async () => {
  const h = harness();
  assert.deepEqual(await h.setup.preview('gamedev'), { ok: false, error: 'unknown-profile' });
  assert.deepEqual(await h.setup.apply('gamedev'), { ok: false, error: 'unknown-profile' });
  assert.deepEqual(h.kinds(), ['list', 'list']);
});

test('preview: use <name> --dry-run, steps, warnings and the running count', async () => {
  const h = harness();
  const res = await h.setup.preview('minimal');
  assert.deepEqual(res, {
    ok: true,
    profile: 'minimal',
    from: 'coding',
    steps: ['replace settings.json', 'remove 12 skills'],
    warnings: ['plugin x is not installed'],
    running: 3,
    tokens: null,
  });
  const use = h.calls.find((c) => c.kind === 'preview');
  assert.deepEqual(use.args, [SCRIPT, 'use', 'minimal', '--dry-run', '--json', '--offline']);
  assert.ok(!h.kinds().includes('fetch'), 'preview does not fetch');
});

test('preview without a running field counts claude.exe through System32 tasklist', async () => {
  const h = harness({
    env: { PATH: '/planted/bin', SystemRoot: 'D:\\Win' },
    handlers: { preview: json({ dryRun: true, profile: 'minimal', steps: ['a'], warnings: [] }) },
  });
  const res = await h.setup.preview('minimal');
  assert.equal(res.ok, true);
  assert.deepEqual(res.steps, ['a']);
  assert.equal(res.running, 2);
  const count = h.calls.find((c) => c.kind === 'tasklist');
  assert.equal(count.cmd, 'D:\\Win\\System32\\tasklist.exe');
  assert.deepEqual(count.args, ['/FI', 'IMAGENAME eq claude.exe', '/NH', '/FO', 'CSV']);
  assert.notEqual(count.opts.shell, true);
});

test('running count off Windows: pgrep exit 1 is zero, any other failure is unknown', async () => {
  const preview = json({ steps: [] });
  const none = harness({ platform: 'linux', handlers: { preview, pgrep: { error: 'no match', code: 1 } } });
  assert.equal((await none.setup.preview('minimal')).running, 0);
  assert.deepEqual(none.calls.find((c) => c.kind === 'pgrep').args, ['-x', 'claude']);

  const two = harness({ platform: 'linux', handlers: { preview, pgrep: { stdout: '101\n202\n' } } });
  assert.equal((await two.setup.preview('minimal')).running, 2);

  const missing = harness({ platform: 'linux', handlers: { preview, pgrep: { error: 'spawn pgrep ENOENT', code: 'ENOENT' } } });
  assert.equal((await missing.setup.preview('minimal')).running, null);

  const crashed = harness({ platform: 'linux', handlers: { preview, pgrep: { error: 'bad syntax', code: 2 } } });
  assert.equal((await crashed.setup.preview('minimal')).running, null);
});

test('apply: use <name> without --dry-run; running and the new cost come back', async () => {
  const h = harness();
  const res = await h.setup.apply('minimal');
  assert.equal(res.ok, true);
  assert.equal(res.running, 2);
  assert.equal(res.tokens, 4200);
  const use = h.calls.find((c) => c.kind === 'apply');
  assert.deepEqual(use.args, [SCRIPT, 'use', 'minimal', '--json', '--offline']);
  assert.equal(use.opts.env.ELECTRON_RUN_AS_NODE, '1');
});

test('apply: a second apply while one runs is busy', async () => {
  const h = harness();
  const first = h.setup.apply('minimal');
  assert.deepEqual(await h.setup.apply('current'), { ok: false, error: 'busy' });
  assert.equal((await first).ok, true);
  assert.equal((await h.setup.apply('current')).ok, true);
});

test('a CLI error is {ok:false, error:failed} with its last stderr line', async () => {
  const h = harness({ handlers: { apply: { error: 'exit 1', stderr: 'some trace\nluna-setup: Unknown profile "minimal".\n' } } });
  assert.deepEqual(await h.setup.apply('minimal'), { ok: false, error: 'failed', detail: 'luna-setup: Unknown profile "minimal".' });
});

// ---- timeouts, crashes, ordering ---------------------------------------------------

test('a hung CLI times out, kills the tree and resolves {ok:false}', async () => {
  const h = harness({ handlers: { list: { hang: true } }, timeouts: { list: 20 } });
  assert.deepEqual(await h.setup.list(), { ok: false, error: 'timeout' });
  assert.deepEqual(h.kills, [4242]);
});

test('a hung clone times out too, and its half-made folder goes', async () => {
  const h = harness({
    exists: [],
    handlers: { clone: (_c, files) => (files.add(REPO), files.add(GIT_DIR), { hang: true }) },
    timeouts: { clone: 20 },
  });
  assert.deepEqual(await h.setup.list(), { ok: false, error: 'timeout' });
  assert.deepEqual(h.kills, [4242]);
  assert.deepEqual(h.removed, [REPO]);
});

test('a child that exits because of the kill still reads as a timeout', async () => {
  const h = harness({ handlers: { apply: { hang: true } }, timeouts: { apply: 20 }, killEndsChild: true });
  assert.deepEqual(await h.setup.apply('minimal'), { ok: false, error: 'timeout' });
  assert.deepEqual(h.kills, [4242]);
});

test('a hung fetch falls back to the clone', async () => {
  const h = harness({ handlers: { fetch: { hang: true } }, timeouts: { fetch: 20 } });
  const res = await h.setup.list();
  assert.equal(res.ok, true);
  assert.equal(res.stale, true);
});

test('execFile throwing (e.g. no git) never escapes', async () => {
  const h = harness({ exists: [], handlers: { clone: { throws: 'spawn git ENOENT' } } });
  assert.deepEqual(await h.setup.list(), { ok: false, error: 'clone-failed' });
});

test('calls run one at a time: status waits for the list', async () => {
  const h = harness();
  const [list, status] = await Promise.all([h.setup.list(), h.setup.status()]);
  assert.equal(list.ok, true);
  assert.equal(status.ok, true);
  assert.deepEqual(h.kinds(), ['fetch', 'merge', 'list', 'status']);
});

// ---- the widget's wiring (renderer side) -------------------------------------------

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('every claudesetup.* key the widget uses exists in pl and en', () => {
  const i18n = read('src/renderer/i18n.js');
  const enAt = i18n.indexOf('\n  en: {');
  assert.ok(enAt > 0, 'i18n.js should have a `pl` block followed by an `en` block');
  const pl = i18n.slice(0, enAt);
  const en = i18n.slice(enAt);
  const mod = read('src/renderer/modules/claudesetup.js');
  const html = read('src/renderer/index.html');
  const keys = new Set([
    ...[...mod.matchAll(/'(claudesetup\.[a-zA-Z.]+)'/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-ph|-title|-aria)?="(claudesetup\.[a-zA-Z.]+)"/g)].map((m) => m[1]),
  ]);
  assert.ok(keys.size >= 25, `found only ${keys.size} keys - did the scan drift?`);
  for (const key of keys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl translation: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en translation: ${key}`);
  }
});

test('pl strings for the widget carry no diacritics', () => {
  const i18n = read('src/renderer/i18n.js');
  const pl = i18n.slice(0, i18n.indexOf('\n  en: {'));
  for (const line of pl.split('\n').filter((l) => l.includes("'claudesetup."))) {
    assert.doesNotMatch(line, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, line.trim());
  }
});

test('the w-setup template holds every element the widget looks up', () => {
  const html = read('src/renderer/index.html');
  const start = html.indexOf('<template id="w-setup">');
  assert.ok(start > 0, 'index.html has no w-setup template');
  const tpl = html.slice(start, html.indexOf('</template>', start));
  const mod = read('src/renderer/modules/claudesetup.js');
  const ids = [...mod.matchAll(/querySelector\('#([a-z-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10);
  for (const id of ids) assert.ok(tpl.includes(`id="${id}"`), `w-setup has no #${id}`);
});

test('the widget writes text only through textContent', () => {
  const mod = read('src/renderer/modules/claudesetup.js');
  assert.doesNotMatch(mod, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
  assert.doesNotMatch(mod, /\bconfirm\(/, 'the confirm is inline, not a renderer-freezing native dialog');
});

test('every preset that shows the profile switcher shows the setup widget right after it', () => {
  const { layouts } = JSON.parse(read('config/layouts.json'));
  for (const l of layouts) {
    for (const ids of Object.values(l.slots)) {
      const at = ids.indexOf('profile');
      if (at >= 0) assert.equal(ids[at + 1], 'setup', `${l.id}: setup should follow profile`);
    }
  }
});
