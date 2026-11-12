// ============================================================================
// LunaCore - Claude setup switcher IPC (src/claudesetupipc.js)
// ----------------------------------------------------------------------------
// The renderer is untrusted. list/status take nothing; preview/apply take one
// profile name, and anything that is not a plain name string is refused here,
// before the switcher is touched. A well-formed name the CLI does not list is
// refused by src/claudesetup.js before any `use` runs.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { registerClaudeSetupIpc } = require('../src/claudesetupipc.js');
const { createClaudeSetup } = require('../src/claudesetup.js');

function harness(setupOverrides = {}) {
  const handlers = new Map();
  const calls = [];
  const setup = {
    list: async () => (calls.push(['list']), { ok: true, profiles: [{ name: 'coding', description: 'd', active: true }], stale: false }),
    status: async () => (calls.push(['status']), { ok: true, profile: 'coding', appliedAt: null, tokens: 18000 }),
    preview: async (name) => (calls.push(['preview', name]), { ok: true, profile: name, steps: [], warnings: [], running: 1 }),
    apply: async (name) => (calls.push(['apply', name]), { ok: true, profile: name, steps: [], warnings: [], running: 1 }),
    ...setupOverrides,
  };
  registerClaudeSetupIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, setup });
  return {
    call: (ch, arg) => handlers.get(ch)({}, arg),
    calls,
    channels: [...handlers.keys()].sort(),
  };
}

const BAD_PAYLOADS = [
  undefined,
  null,
  42,
  true,
  {},
  [],
  ['coding'],
  { name: 'coding' },
  '',
  ' coding',
  '..',
  'a.b',
  '../../.ssh',
  'a/b',
  'a\\b',
  '-x',
  '--dry-run',
  'coding --dry-run',
  'coding;calc',
  'x'.repeat(41),
];

test('exactly the four channels', () => {
  assert.deepEqual(harness().channels, ['claudeSetup:apply', 'claudeSetup:list', 'claudeSetup:preview', 'claudeSetup:status']);
});

test('list and status ignore whatever the renderer sends', async () => {
  const h = harness();
  assert.equal((await h.call('claudeSetup:list', { evil: true })).ok, true);
  assert.equal((await h.call('claudeSetup:status', '--target=C:/')).ok, true);
  assert.deepEqual(h.calls, [['list'], ['status']]);
});

test('preview and apply refuse every malformed payload before the switcher', async () => {
  const h = harness();
  for (const payload of BAD_PAYLOADS) {
    assert.deepEqual(await h.call('claudeSetup:preview', payload), { ok: false, error: 'bad-name' }, JSON.stringify(payload));
    assert.deepEqual(await h.call('claudeSetup:apply', payload), { ok: false, error: 'bad-name' }, JSON.stringify(payload));
  }
  assert.deepEqual(h.calls, []);
});

test('a plain name reaches the switcher unchanged', async () => {
  const h = harness();
  assert.equal((await h.call('claudeSetup:preview', 'minimal')).ok, true);
  assert.equal((await h.call('claudeSetup:apply', 'minimal')).ok, true);
  assert.deepEqual(h.calls, [['preview', 'minimal'], ['apply', 'minimal']]);
});

test('a switcher that throws or answers garbage becomes {ok:false}', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const h = harness({
      list: async () => {
        throw new Error('boom');
      },
      status: () => {
        throw new Error('sync boom');
      },
      preview: async () => undefined,
      apply: async () => 'yes',
    });
    assert.deepEqual(await h.call('claudeSetup:list'), { ok: false, error: 'failed' });
    assert.deepEqual(await h.call('claudeSetup:status'), { ok: false, error: 'failed' });
    assert.deepEqual(await h.call('claudeSetup:preview', 'minimal'), { ok: false, error: 'failed' });
    assert.deepEqual(await h.call('claudeSetup:apply', 'minimal'), { ok: false, error: 'failed' });
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2);
});

test('end to end: an unlisted name never spawns `use`', async () => {
  const REPO = path.resolve('/fake-home/.luna-setup-repo');
  const NODE = path.resolve('/fake/LunaCore.exe');
  const files = new Set([REPO, path.join(REPO, '.git'), path.join(REPO, 'tools', 'luna-setup.mjs')]);
  const spawned = [];
  const execFile = (cmd, args, _opts, cb) => {
    spawned.push([cmd, ...args]);
    const out = cmd === NODE && args[1] === 'list' ? JSON.stringify([{ name: 'coding', description: 'd', active: true }]) : '';
    setImmediate(() => cb(null, out, ''));
    return { pid: 1 };
  };
  const setup = createClaudeSetup({
    repoDir: REPO,
    nodePath: NODE,
    getEnv: () => ({}),
    execFile,
    kill: () => true,
    fs: { existsSync: (p) => files.has(p) },
    log: () => {},
  });
  const handlers = new Map();
  registerClaudeSetupIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, setup });

  assert.deepEqual(await handlers.get('claudeSetup:apply')({}, 'gamedev'), { ok: false, error: 'unknown-profile' });
  assert.deepEqual(await handlers.get('claudeSetup:preview')({}, 'gamedev'), { ok: false, error: 'unknown-profile' });
  assert.ok(spawned.every((s) => !s.includes('use')), JSON.stringify(spawned));
});
