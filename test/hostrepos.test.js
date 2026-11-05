// ============================================================================
// LunaCore - the host clones missing synced projects (src/hostrepos.js)
// ----------------------------------------------------------------------------
// A fake execFile and a fake file system. Covered: only allowed owners clone,
// an existing folder is never touched, git gets an argv array with "--"
// before the URL, failures are told apart (auth / other), names that could
// leave the repos root are refused, and `repo.clone` takes any owner.
// Plus the host:default unit (src/hostdefault.js).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHostRepos, parseRemote, readOwners, validName, removeClonedFolder } = require('../src/hostrepos.js');
const { createHostDefaultProvider, writeDefault, readDefault } = require('../src/hostdefault.js');

const ROOT = path.join(path.sep === '\\' ? 'C:\\' : '/', 'home', 'host', 'source', 'repos');

function setup({ existing = [], fail = null, owners, killed = false, appearsBeforeClaim = null } = {}) {
  const present = new Set(existing);
  const calls = [];
  const removed = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    setImmediate(() => {
      if (fail) {
        const err = Object.assign(new Error('Command failed'), killed ? { killed: true, signal: 'SIGTERM' } : {});
        cb(err, '', fail);
        return;
      }
      present.add(args[args.length - 1]);
      cb(null, '', '');
    });
  };
  const repos = createHostRepos({
    execFile,
    reposRoot: ROOT,
    owners: () => owners || ['Kotsur69'],
    exists: (p) => present.has(p),
    mkdir: () => {},
    claimTarget: (p) => {
      if (appearsBeforeClaim === p) present.add(p);
      if (present.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      present.add(p);
    },
    removeOwn: async (p) => {
      removed.push(p);
      present.delete(p);
    },
    log: () => {},
  });
  return { repos, calls, present, removed };
}

const project = (id, remote, p = `/elsewhere/${id}`) => ({ id, remote, path: p });

test('parseRemote / validName: only one safe folder segment', () => {
  assert.deepEqual(parseRemote('https://github.com/kotsur69/luna-core-hud'), {
    url: 'https://github.com/kotsur69/luna-core-hud',
    owner: 'kotsur69',
    name: 'luna-core-hud',
  });
  assert.equal(parseRemote('https://github.com/a/..'), null);
  assert.equal(parseRemote('https://evil.com/a/b'), null);
  assert.equal(parseRemote('git@github.com:a/b.git'), null, 'only the normalised https form');
  for (const bad of ['..', '.', 'a/b', 'a\\b', '', 'x'.repeat(101), null]) assert.equal(validName(bad), false, String(bad));
  assert.equal(validName('Luna-Core-HUD'), true);
});

test('readOwners: host.local.json owners, else the default', () => {
  assert.deepEqual(readOwners(null), ['Kotsur69']);
  assert.deepEqual(readOwners({ owners: [] }), ['Kotsur69']);
  assert.deepEqual(readOwners({ owners: ['someone', '../x', 5] }), ['someone']);
});

test('clones a missing project of an allowed owner into <root>/<name>, argv array with --', async () => {
  const { repos, calls } = setup();
  const out = await repos.sync([project('app', 'https://github.com/kotsur69/app')]);
  assert.equal(out.get('app'), 'cloned');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args, ['clone', '--', 'https://github.com/kotsur69/app', path.join(ROOT, 'app')]);
  assert.equal(calls[0].opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(repos.dirOf(project('app', 'https://github.com/kotsur69/app')), path.join(ROOT, 'app'));
  // The next pass still says cloned, it does not flip to "folder exists".
  const again = await repos.sync([project('app', 'https://github.com/kotsur69/app')]);
  assert.equal(again.get('app'), 'cloned');
  assert.equal(calls.length, 1, 'no second clone');
});

test('a stranger\'s repo from a synced row is never cloned', async () => {
  const { repos, calls } = setup();
  const out = await repos.sync([project('x', 'https://github.com/stranger/x')]);
  assert.equal(out.has('x'), false);
  assert.equal(calls.length, 0);
});

test('owner allow-list is case-insensitive', async () => {
  const { repos, calls } = setup({ owners: ['Kotsur69'] });
  await repos.sync([project('app', 'https://github.com/kotsur69/app')]);
  assert.equal(calls.length, 1);
});

test('an existing folder is never touched', async () => {
  const { repos, calls } = setup({ existing: [path.join(ROOT, 'app')] });
  const out = await repos.sync([project('app', 'https://github.com/kotsur69/app')]);
  assert.equal(out.get('app'), 'skipped: folder exists');
  assert.equal(calls.length, 0);
});

test('a project present at its own path is left alone', async () => {
  const { repos, calls } = setup({ existing: ['/mine/app'] });
  const out = await repos.sync([project('app', 'https://github.com/kotsur69/app', '/mine/app')]);
  assert.equal(out.has('app'), false);
  assert.equal(calls.length, 0);
});

test('projects without a valid remote are skipped', async () => {
  const { repos, calls } = setup();
  await repos.sync([{ id: 'a', path: '/x' }, project('b', 'https://github.com/kotsur69/..'), project('c', 'file:///etc')]);
  assert.equal(calls.length, 0);
});

test('failures are told apart: auth vs other', async () => {
  const auth = setup({ fail: 'fatal: could not read Username for https://github.com: terminal prompts disabled' });
  assert.equal((await auth.repos.sync([project('a', 'https://github.com/kotsur69/a')])).get('a'), 'failed: auth');
  const other = setup({ fail: 'fatal: unable to access: Could not resolve host' });
  assert.equal((await other.repos.sync([project('a', 'https://github.com/kotsur69/a')])).get('a'), 'failed: other');
});

test('repo.clone: any owner, same folder rules', async () => {
  const { repos, calls } = setup({ existing: [path.join(ROOT, 'taken')] });
  assert.deepEqual(await repos.clone('https://github.com/stranger/tool'), { status: 'cloned', dir: path.join(ROOT, 'tool') });
  assert.equal((await repos.clone('https://github.com/stranger/taken')).status, 'skipped: folder exists');
  assert.equal((await repos.clone('https://github.com/a/../../x')).status, 'failed: other');
  assert.equal(calls.length, 1);
});

test('J-M13: a timed-out clone removes the folder it created and does not count as present', async () => {
  const { repos, present, removed } = setup({ fail: 'fatal: early EOF', killed: true });
  const target = path.join(ROOT, 'app');
  const out = await repos.sync([project('app', 'https://github.com/kotsur69/app')]);
  assert.equal(out.get('app'), 'failed: other');
  assert.deepEqual(removed, [target]);
  assert.equal(present.has(target), false);
  assert.equal(repos.dirOf(project('app', 'https://github.com/kotsur69/app')), null);
});

test('J-M13: a folder that appears between the check and the clone is never cloned into or removed', async () => {
  const target = path.join(ROOT, 'app');
  const { repos, calls, removed, present } = setup({ appearsBeforeClaim: target });
  assert.equal((await repos.clone('https://github.com/kotsur69/app')).status, 'skipped: folder exists');
  assert.equal(calls.length, 0);
  assert.deepEqual(removed, []);
  assert.equal(present.has(target), true);
});

test('J-M13: real fs - a killed clone leaves no partial folder; a pre-existing folder is untouched', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hostrepos-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const keep = path.join(root, 'keep');
  fs.mkdirSync(keep);
  fs.writeFileSync(path.join(keep, 'mine.txt'), 'x');
  // A fake git that writes part of a checkout, then is killed by the timeout.
  const execFile = (_cmd, args, _opts, cb) => {
    const target = args[args.length - 1];
    fs.mkdirSync(path.join(target, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(target, '.git', 'objects', 'pack.tmp'), 'partial');
    setImmediate(() => cb(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }), '', ''));
  };
  const repos = createHostRepos({ execFile, reposRoot: root, log: () => {} });
  assert.equal((await repos.clone('https://github.com/kotsur69/app')).status, 'failed: other');
  assert.equal(fs.existsSync(path.join(root, 'app')), false, 'partial folder removed');
  assert.equal((await repos.clone('https://github.com/kotsur69/keep')).status, 'skipped: folder exists');
  assert.equal(fs.readFileSync(path.join(keep, 'mine.txt'), 'utf8'), 'x', 'pre-existing folder untouched');
});

test('J-M13: removeClonedFolder leaves a link in place of the folder alone and does not follow links inside', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hostrepos-link-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep');
  // 'junction' needs no admin rights on Windows; ignored elsewhere.
  const swapped = path.join(root, 'swapped');
  fs.symlinkSync(outside, swapped, 'junction');
  await assert.rejects(removeClonedFolder(swapped), /not a plain folder/);
  assert.equal(fs.existsSync(path.join(outside, 'precious.txt')), true);
  const partial = path.join(root, 'partial');
  fs.mkdirSync(partial);
  fs.symlinkSync(outside, path.join(partial, 'link'), 'junction');
  await removeClonedFolder(partial);
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep', 'link target untouched');
  await removeClonedFolder(path.join(root, 'gone')); // missing: no throw
});

test('host:default: --make-default writes the unit; the provider syncs it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hostdefault-'));
  const file = path.join(dir, 'host-default.local.json');
  const provider = createHostDefaultProvider(file);
  assert.deepEqual(provider.read(Date.now()), { units: [], base: 0 });
  writeDefault(file, 'MAC-1');
  assert.equal(readDefault(file), 'MAC-1');
  const local = provider.read(Date.now());
  assert.deepEqual(local.units, [['host:default', { machine: 'MAC-1' }]]);
  assert.ok(local.base > 0);
  assert.deepEqual(provider.valid('host:default', { machine: 'PC-2', extra: 1 }), { machine: 'PC-2' });
  assert.equal(provider.valid('host:default', { machine: '../x' }), null);
  assert.equal(provider.owns('host:default'), true);
  assert.equal(provider.owns('proj:entry:x'), false);
  provider.write([['host:default', { machine: 'PC-2' }]], local);
  assert.equal(readDefault(file), 'PC-2', 'a newer default from another host lands here');
  assert.throws(() => writeDefault(file, 'bad name'));
});
