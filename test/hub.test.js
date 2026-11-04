// ============================================================================
// LunaCore - notification hub core + IPC (src/hub.js, src/hubipc.js)
// ----------------------------------------------------------------------------
// The list is sorted (needs first, then newest), deduped by id, done-filtered
// and cleaned; hub:done rejects ids that miss the regex; hub:changed fires
// only on a real change.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hub = require('../src/hub.js');
const { registerHubIpc, readRunReports } = require('../src/hubipc.js');

const NOW = 1_800_000_000_000;
const item = (over) => ({ id: 'life:x', kind: 'info', source: 'life', title: 'T', at: NOW - 1000, ...over });

function fakeIpc() {
  const handlers = new Map();
  return {
    handle: (ch, fn) => handlers.set(ch, fn),
    invoke: (ch, ...args) => handlers.get(ch)({}, ...args),
    handlers,
  };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hub-')), 'hub-done.local.json');

test('mergeItems sorts needs first, then briefs, then info, newest first inside', () => {
  const { items } = hub.mergeItems([
    [item({ id: 'a:info-old', at: NOW - 5000 }), item({ id: 'a:needs-old', kind: 'needs', at: NOW - 9000 })],
    [item({ id: 'b:info-new', at: NOW - 10 }), item({ id: 'b:needs-new', kind: 'needs', at: NOW - 100 }), item({ id: 'b:brief', kind: 'brief' })],
  ], { now: NOW });
  assert.deepEqual(items.map((i) => i.id), ['b:needs-new', 'a:needs-old', 'b:brief', 'b:info-new', 'a:info-old']);
});

test('mergeItems dedupes by id, the newest copy wins', () => {
  const { items } = hub.mergeItems([[item({ id: 'a:1', title: 'old', at: NOW - 50 })], [item({ id: 'a:1', title: 'new', at: NOW - 5 })]], { now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'new');
});

test('mergeItems moves done items to `done` (recent ones only) and drops expired ones', () => {
  const done = new Map([['a:done', NOW - 1000], ['a:ancient', NOW - hub.RECENT_MS - 1]]);
  const view = hub.mergeItems([[
    item({ id: 'a:done', kind: 'needs' }),
    item({ id: 'a:ancient' }),
    item({ id: 'a:open', kind: 'needs' }),
    item({ id: 'a:expired', kind: 'needs', expiresAt: NOW - 1 }),
  ]], { done, now: NOW });
  assert.deepEqual(view.items.map((i) => i.id), ['a:open']);
  assert.deepEqual(view.done.map((i) => [i.id, i.doneAt]), [['a:done', NOW - 1000]]);
  assert.equal(hub.needsCount(view.items), 1);
});

test('cleanItem drops bad ids, kinds, times and empty titles', () => {
  assert.equal(hub.cleanItem(null), null);
  assert.equal(hub.cleanItem(item({ id: 'Bad:id' })), null);
  assert.equal(hub.cleanItem(item({ kind: 'urgent' })), null);
  assert.equal(hub.cleanItem(item({ at: 'now' })), null);
  assert.equal(hub.cleanItem(item({ title: '\u0000\n ' })), null);
});

test('cleanItem strips control characters, caps text and keeps only whitelisted actions', () => {
  const long = 'x'.repeat(500);
  const out = hub.cleanItem(item({ title: `a\u0007b\nc ${long}`, detail: long, vars: { repo: 'r\nx', 'bad key': 1, n: 3, o: {} } }));
  assert.ok(out.title.startsWith('a b c '));
  assert.ok(out.title.length <= 200);
  assert.ok(out.detail.length <= 300);
  assert.deepEqual(out.vars, { repo: 'r x', n: 3 });
  assert.equal(hub.cleanItem(item({ primary: { action: 'openUrl', arg: 'https://evil' } })).primary, undefined);
  assert.equal(hub.cleanItem(item({ primary: { action: 'openReport', arg: 'rm -rf /' } })).primary, undefined);
  assert.deepEqual(hub.cleanItem(item({ primary: { action: 'openReport', arg: 'p1abc' } })).primary, { action: 'openReport', arg: 'p1abc' });
  assert.equal(hub.cleanItem(item({ key: '<img>' })).key, undefined);
  assert.equal(hub.cleanItem(item({ machine: 'KT-PC-LLM' })).machine, 'KT-PC-LLM');
  assert.equal(hub.cleanItem(item({ machine: '../x' })).machine, undefined);
});

test('cleanItem redacts absolute paths and tokens and strips bidi / zero-width characters', () => {
  const out = hub.cleanItem(item({
    title: 'see C:\\Users\\mati\\repo\\x.log and /home/mati/x key xq_demo_abcdefghijklmnop1234567890XYZ',
    detail: 'a\u202eb\u200bc supabase/migrations/001.sql',
  }));
  assert.equal(out.title, 'see \u2026 and \u2026 key \u2026');
  assert.equal(out.detail, 'a b c supabase/migrations/001.sql', 'relative paths stay');
  const more = hub.cleanItem(item({ title: 'see \\\\nas\\users\\mati\\keys.txt, ~/notes.md and /mnt/c/x' }));
  assert.equal(more.title, 'see … … and …', 'UNC, ~/ and /mnt paths are redacted');
  const huge = hub.cleanItem(item({ title: `${'a1'.repeat(200000)} end` }));
  assert.ok(huge.title.length <= 200, 'a huge line is capped before the regexes');
});

test('id regex accepts hub ids and rejects everything else', () => {
  for (const ok of ['godmode:p1abc', 'godmode:p1abc:needs:0', 'life:goals:2026-W45', 'bills:gas:2026-11', 'update:0.21.0']) {
    assert.ok(hub.isHubId(ok), ok);
  }
  for (const bad of ['', 'nocolon', 'Godmode:x', 'a:', 'a: space', 'a:../../etc', 'a:x/y', `a:${'x'.repeat(121)}`, 'a:<script>', 42, null, {}, ['a:b']]) {
    assert.ok(!hub.isHubId(bad), String(bad));
  }
});

test('done store: survives a broken file, writes, prunes and ignores bad ids', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  let at = NOW;
  const store = hub.createDoneStore({ file: () => file, now: () => at });
  assert.equal(store.load().size, 0);
  assert.equal(store.mark('bad id'), false);
  assert.equal(store.mark('a:one'), true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { v: 1, done: { 'a:one': NOW } });
  // A fresh store reading after 31 days prunes it.
  at = NOW + hub.DONE_KEEP_MS + 1;
  assert.equal(hub.createDoneStore({ file: () => file, now: () => at }).load().size, 0);
  assert.equal(hub.normalizeDone({ done: { 'a:x': NOW, 'Bad': NOW, 'a:y': 'x' } }, NOW).size, 1);
});

test('createHub collects, marks done and emits hub:changed only on a change', () => {
  let power = { sleep: { phase: 'countdown', at: NOW + 30000 } };
  let broken = false;
  const sources = {
    power: { collect: require('../src/hubcollect.js').collectPower, read: () => ({ power }) },
    life: { collect: () => [item({ id: 'life:checkin:2026-11-02', kind: 'needs' })], read: () => ({}), slow: true },
    bad: { collect: () => [], read: () => { if (broken) throw new Error('boom'); return {}; } },
  };
  const h = hub.createHub({ sources, doneStore: hub.createDoneStore({ file: () => null, now: () => NOW }), now: () => NOW });
  const seen = [];
  h.on('hub:changed', (v) => seen.push(v));
  let view = h.refresh(true);
  assert.equal(view.needs, 2);
  assert.equal(seen.length, 1);
  h.refresh(false);
  assert.equal(seen.length, 1, 'no change, no event');
  broken = true;
  power = null;
  view = h.refresh(false);
  assert.equal(view.needs, 1, 'a throwing reader is just empty');
  assert.equal(seen.length, 2);
  assert.deepEqual(h.markDone('nope'), { ok: false, reason: 'bad-id' });
  assert.deepEqual(h.markDone('life:checkin:2026-11-02'), { ok: true });
  view = h.list();
  assert.equal(view.needs, 0);
  assert.deepEqual(view.done.map((i) => i.id), ['life:checkin:2026-11-02']);
  assert.equal(seen.length, 3);
});

test('hub:list over IPC returns sorted, deduped, done-filtered items', async () => {
  const ipcMain = fakeIpc();
  const pushes = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hub-runs-'));
  fs.writeFileSync(path.join(dir, 'p1abc.md'), '# God Mode run p1abc\n\n- Repo: `/r/demo`\n- Result: 1 of 2 packages pushed\n\n## Needs you\n\n- fix it\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const doneFile = tmpFile();
  fs.writeFileSync(doneFile, JSON.stringify({ v: 1, done: { 'update:0.21.0': Date.now() } }));
  registerHubIpc({
    ipcMain,
    send: (ch, v) => pushes.push([ch, v]),
    runsDir: () => dir,
    orchestra: { view: () => ({ power: { sleep: null, shutdown: { phase: 'countdown', at: Date.now() + 60000 } } }), planWait: () => null },
    update: () => ({ state: 'available', info: { version: '0.21.0' } }),
    doneFile: () => doneFile,
    readers: {
      checkin: () => ({ checkin: { today: '2026-11-02', entry: null } }),
      goals: () => { throw new Error('broken goals file'); },
      bills: () => ({ summary: null }),
    },
    autoStart: false,
  });
  const res = await ipcMain.invoke('hub:list');
  assert.equal(res.ok, true);
  const ids = res.items.map((i) => i.id);
  assert.deepEqual(res.items.map((i) => i.kind), ['needs', 'needs', 'needs', 'info']);
  assert.ok(ids.some((id) => /^godmode:p1abc:needs:[0-9a-f]{10}$/.test(id)));
  assert.ok(ids.includes('life:checkin:2026-11-02'));
  assert.ok(ids.some((id) => id.startsWith('power:shutdown:')));
  assert.equal(ids[3], 'godmode:p1abc');
  assert.ok(!ids.includes('update:0.21.0'), 'done items are filtered out');
  assert.deepEqual(res.done.map((i) => i.id), ['update:0.21.0']);
  assert.equal(res.needs, 3);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(pushes[0][0], 'hub:changed');
});

test('hub:done rejects bad ids and marks good ones', async () => {
  const ipcMain = fakeIpc();
  let clock = NOW;
  const doneFile = tmpFile();
  registerHubIpc({
    ipcMain,
    send: () => {},
    doneFile: () => doneFile,
    now: () => clock,
    readers: { checkin: () => ({ checkin: { today: '2026-11-02', entry: null } }), goals: () => ({}), bills: () => ({}) },
    autoStart: false,
  });
  for (const bad of [undefined, null, 42, '', 'x', 'a:../b', { id: 'a:b' }, `a:${'x'.repeat(200)}`]) {
    assert.deepEqual(await ipcMain.invoke('hub:done', bad), { ok: false, reason: 'bad-id' });
  }
  assert.ok(!fs.existsSync(doneFile), 'nothing written for bad ids');
  await ipcMain.invoke('hub:list');
  assert.deepEqual(await ipcMain.invoke('hub:done', 'life:checkin:2026-11-02'), { ok: true });
  assert.deepEqual(await ipcMain.invoke('hub:done', 'life:other'), { ok: false, reason: 'rate-limited' });
  clock += 1000;
  assert.deepEqual(await ipcMain.invoke('hub:done', 'life:other'), { ok: false, reason: 'unknown' }, 'only shown items can be marked');
  clock += 1000;
  assert.deepEqual(await ipcMain.invoke('hub:done', 'life:checkin:2026-11-02'), { ok: true }, 'marking twice is fine');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(doneFile, 'utf8')).done), ['life:checkin:2026-11-02']);
  assert.ok(!fs.existsSync(`${doneFile}.tmp`), 'the temp file is renamed away');
  const res = await ipcMain.invoke('hub:list');
  assert.equal(res.items.find((i) => i.id === 'life:checkin:2026-11-02'), undefined);
});

test('readRunReports: missing dir, filters names and the 14-day window', () => {
  assert.deepEqual(readRunReports(path.join(os.tmpdir(), 'lc-hub-nope-xyz'), Date.now()), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hub-rr-'));
  fs.writeFileSync(path.join(dir, 'p1.md'), 'a');
  fs.writeFileSync(path.join(dir, 'P2.md'), 'b');
  fs.writeFileSync(path.join(dir, 'p3.md'), 'c');
  const old = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(dir, 'p3.md'), old, old);
  assert.deepEqual(readRunReports(dir, Date.now()).map((r) => r.id), ['p1']);
});
