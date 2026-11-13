// ============================================================================
// LunaCore - the phone's signed memory inbox commands (src/hostmemory.js)
// ----------------------------------------------------------------------------
// memory.inbox lists the waiting entries; memory.approve / memory.reject run
// the HUD inbox's own functions with the same log line. Every payload is
// checked: shape, id and project format, a project this PC knows, and an
// entry that is waiting right now. A headless host refuses them all.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHostMemory, needsHudMemoryHandlers, decisionTarget, KINDS, MAX_PHONE_ITEMS, MAX_PHONE_BODY } = require('../src/hostmemory.js');
const { writeRecord, scan } = require('../src/memorystore.js');
const { createLog, captureStats } = require('../src/memorylog.js');
const { typeStats } = require('../src/memoryautoaccept.js');
const { hostSnapshot, parseHostPeer } = require('../src/hostsnapshot.js');
const { createHostSwitch } = require('../src/hostswitch.js');
const { scrubDeep } = require('../src/hostscrub.js');

const PROJECT = 'github.com/acme/hud';
const OTHER = 'github.com/acme/quote';
const NOW = Date.parse('2026-11-13T10:00:00Z');

const rec = (id, title, over = {}) => ({
  id,
  type: 'gotcha',
  project: PROJECT,
  title,
  created: '2026-11-10',
  confidence: 'observed',
  supersedes: [],
  links: [],
  body: `Body of ${id}.`,
  ...over,
});

function setup(t, records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-hostmem-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(root, 'memory');
  fs.mkdirSync(dir);
  for (const r of records) writeRecord(dir, r);
  const log = createLog(path.join(root, 'memory-log.jsonl'));
  const changed = [];
  const lines = [];
  const { handlers } = createHostMemory({ dir: () => dir, log, onChanged: () => changed.push(1), now: () => NOW, logLine: (l) => lines.push(l) });
  return { dir, log, handlers, changed, lines };
}

const stored = (dir) => Object.fromEntries(scan(dir).records);

// ---- memory.inbox -----------------------------------------------------------

test('memory.inbox lists only waiting entries with the notes the phone shows', async (t) => {
  const { handlers } = setup(t, [
    rec('retry-busy', 'Retry says busy after sleep', { usefulness: 80, source: 'captured from session abc on PC1, read 2 outside source(s), suggested global' }),
    rec('battery', 'Packaging times out on battery', { area: 'build' }),
    rec('done', 'Name the installer with dashes', { confidence: 'confirmed' }),
  ]);

  const res = await handlers['memory.inbox']({});

  assert.equal(res.status, 'listed');
  assert.equal(res.total, 2);
  assert.deepEqual(res.items.map((i) => i.id), ['retry-busy', 'battery']);
  const [first, second] = res.items;
  assert.equal(first.key, `${PROJECT}/retry-busy`);
  assert.equal(first.project, PROJECT);
  assert.equal(first.type, 'gotcha');
  assert.equal(first.title, 'Retry says busy after sleep');
  assert.equal(first.body, 'Body of retry-busy.');
  assert.equal(first.usefulness, 80);
  assert.equal(first.suggestedGlobal, true);
  assert.equal(first.outside, 2);
  assert.equal(first.clipped, false);
  assert.match(first.source, /captured from session abc/);
  assert.equal(second.usefulness, null);
  assert.equal(second.area, 'build');
  assert.equal(second.suggestedGlobal, false);
  assert.equal(second.outside, 0);
});

test('memory.inbox caps the item count and the body length so the result fits the column', async (t) => {
  // Distinct words per entry: near-duplicates would be folded into one.
  const bodyOf = (i) => Array.from({ length: 400 }, (_, j) => `w${i}q${j}`).join(' ').slice(0, MAX_PHONE_BODY + 500);
  const titleOf = (i) => Array.from({ length: 5 }, (_, j) => `t${i}z${j}`).join(' ');
  const records = Array.from({ length: MAX_PHONE_ITEMS + 5 }, (_, i) => rec(`entry-${i}`, titleOf(i), { body: bodyOf(i) }));
  const { handlers } = setup(t, records);

  const res = await handlers['memory.inbox']({});

  assert.equal(res.total, MAX_PHONE_ITEMS + 5);
  assert.ok(res.items.length <= MAX_PHONE_ITEMS);
  assert.ok(res.items.every((i) => i.body.length <= MAX_PHONE_BODY && i.clipped === true));
  assert.ok(Buffer.byteLength(JSON.stringify(res), 'utf8') < 128 * 1024);
});

test('memory.inbox measures entries after the secret scrub, which can make them longer', async (t) => {
  // NAME=value lines get masked on the way out ('=1' -> '=[redacted]'): the
  // budget must count the masked size or the row outgrows the 128 KB column.
  const line = (i) => ['K', String(i), '_', 'KEY', '=1'].join('');
  const bodyOf = (i) => Array.from({ length: 400 }, () => line(i)).join('\n').slice(0, MAX_PHONE_BODY);
  const titleOf = (i) => Array.from({ length: 5 }, (_, j) => `s${i}v${j}`).join(' ');
  const records = Array.from({ length: MAX_PHONE_ITEMS }, (_, i) => rec(`masked-${i}`, titleOf(i), { body: bodyOf(i) }));
  const { handlers } = setup(t, records);

  const res = await handlers['memory.inbox']({});

  assert.ok(res.items.length > 0);
  assert.ok(res.items[0].body.includes('[redacted]'));
  assert.ok(Buffer.byteLength(JSON.stringify(scrubDeep(res)), 'utf8') < 128 * 1024);
});

test('a decision that throws after its write still syncs, and answers failed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-hostmem-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  writeRecord(root, rec('a', 'Something to keep in mind'));
  const changed = [];
  const { handlers } = createHostMemory({
    dir: () => root,
    log: {
      add: () => {
        throw new Error('log disk full');
      },
    },
    onChanged: () => changed.push(1),
    now: () => NOW,
    logLine: () => {},
  });

  assert.deepEqual(await handlers['memory.approve']({ project: PROJECT, id: 'a' }), { status: 'refused', error: 'failed' });
  assert.equal(stored(root)[`${PROJECT}/a`].confidence, 'confirmed');
  assert.equal(changed.length, 1);
});

test('memory.inbox refuses a payload with fields or of the wrong shape', async (t) => {
  const { handlers } = setup(t, [rec('a', 'Something')]);
  for (const payload of [null, [], 'x', { project: PROJECT }]) {
    assert.deepEqual(await handlers['memory.inbox'](payload), { status: 'refused', error: 'badPayload' });
  }
});

// ---- memory.approve / memory.reject ---------------------------------------

test('memory.approve confirms the entry, logs it like the PC inbox and syncs', async (t) => {
  const { dir, log, handlers, changed } = setup(t, [rec('retry-busy', 'Retry says busy after sleep', { usefulness: 70 })]);

  const res = await handlers['memory.approve']({ project: PROJECT, id: 'retry-busy' });

  assert.deepEqual(res, { status: 'decided', key: `${PROJECT}/retry-busy`, removed: 0 });
  const after = stored(dir)[`${PROJECT}/retry-busy`];
  assert.equal(after.confidence, 'confirmed');
  assert.equal(after.last_verified, '2026-11-13');
  assert.equal(changed.length, 1);
  const events = log.read();
  assert.equal(events.length, 1);
  assert.equal(events[0].ev, 'approved');
  assert.equal(events[0].key, `${PROJECT}/retry-busy`);
  // The approval rate and the auto-accept numbers count it.
  assert.equal(captureStats(events).approved, 1);
  assert.equal(typeStats(events, Date.now()).gotcha.approved, 1);
});

test('memory.reject deletes the entry and its folded duplicates, logged with the title', async (t) => {
  const { dir, log, handlers, changed } = setup(t, [
    rec('retry-busy', 'Retry says busy after sleep', { created: '2026-11-09' }),
    rec('retry-busy-2', 'Retry says busy after sleep', { created: '2026-11-10' }),
    rec('keep', 'Name the installer with dashes'),
  ]);

  const res = await handlers['memory.reject']({ project: PROJECT, id: 'retry-busy' });

  assert.deepEqual(res, { status: 'decided', key: `${PROJECT}/retry-busy`, removed: 1 });
  assert.deepEqual(Object.keys(stored(dir)), [`${PROJECT}/keep`]);
  assert.equal(changed.length, 1);
  const [event] = log.read();
  assert.equal(event.ev, 'rejected');
  assert.equal(event.title, 'Retry says busy after sleep');
  assert.equal(captureStats(log.read()).rejected, 1);
});

test('a confirmed memory is refused and left as it was', async (t) => {
  const { dir, log, handlers, changed } = setup(t, [rec('done', 'Name the installer with dashes', { confidence: 'confirmed' })]);
  const before = stored(dir);

  for (const kind of ['memory.approve', 'memory.reject']) {
    assert.deepEqual(await handlers[kind]({ project: PROJECT, id: 'done' }), { status: 'refused', error: 'notWaiting' }, kind);
  }

  assert.deepEqual(stored(dir), before);
  assert.equal(changed.length, 0);
  assert.equal(log.read().length, 0);
});

test('an entry decided meanwhile (already gone) is refused as notFound', async (t) => {
  const { handlers } = setup(t, [rec('a', 'Something to keep in mind'), rec('b', 'Name the installer with dashes')]);
  assert.equal((await handlers['memory.reject']({ project: PROJECT, id: 'a' })).status, 'decided');
  assert.deepEqual(await handlers['memory.approve']({ project: PROJECT, id: 'a' }), { status: 'refused', error: 'notFound' });
});

test('a known project with an unknown id is refused as notFound', async (t) => {
  const { handlers } = setup(t, [rec('a', 'Something to keep in mind')]);
  assert.deepEqual(await handlers['memory.approve']({ project: PROJECT, id: 'nope' }), { status: 'refused', error: 'notFound' });
});

test('a project this PC holds no memory for is refused', async (t) => {
  const { dir, handlers } = setup(t, [rec('a', 'Something to keep in mind')]);
  for (const kind of ['memory.approve', 'memory.reject']) {
    assert.deepEqual(await handlers[kind]({ project: OTHER, id: 'a' }), { status: 'refused', error: 'unknownProject' }, kind);
  }
  assert.equal(scan(dir).records.length, 1);
});

test('bad ids, bad projects and malformed payloads are refused before the mirror is read', async (t) => {
  const { dir, handlers, changed } = setup(t, [rec('a', 'Something to keep in mind')]);
  const cases = [
    [null, 'badPayload'],
    [[], 'badPayload'],
    ['github.com/acme/hud/a', 'badPayload'],
    [{ project: PROJECT, id: 'a', extra: 1 }, 'badPayload'],
    [{ key: `${PROJECT}/a` }, 'badPayload'],
    [{ project: PROJECT }, 'badId'],
    [{ project: PROJECT, id: 'A' }, 'badId'],
    [{ project: PROJECT, id: '../a' }, 'badId'],
    [{ project: PROJECT, id: 'a/b' }, 'badId'],
    [{ project: PROJECT, id: 'x'.repeat(81) }, 'badId'],
    [{ project: PROJECT, id: 42 }, 'badId'],
    [{ id: 'a' }, 'badProject'],
    [{ project: '../../etc', id: 'a' }, 'badProject'],
    [{ project: 'C:\\Users\\x', id: 'a' }, 'badProject'],
    [{ project: 'github.com/acme/..', id: 'a' }, 'badProject'],
    [{ project: ['github.com/acme/hud'], id: 'a' }, 'badProject'],
  ];
  for (const [payload, error] of cases) {
    for (const kind of ['memory.approve', 'memory.reject']) {
      assert.deepEqual(await handlers[kind](payload), { status: 'refused', error }, `${kind} ${JSON.stringify(payload)}`);
    }
  }
  assert.equal(scan(dir).records.length, 1);
  assert.equal(changed.length, 0);
});

test('decisionTarget accepts a global entry', () => {
  assert.deepEqual(decisionTarget({ project: 'global', id: 'keep-commits-small' }), { key: 'global/keep-commits-small', project: 'global' });
});

test('a throw inside a handler is logged and answered without its message', async () => {
  const lines = [];
  const { handlers } = createHostMemory({
    dir: () => {
      throw new Error('EACCES C:\\Users\\secret\\memory');
    },
    logLine: (l) => lines.push(l),
  });
  for (const [kind, payload] of [['memory.inbox', {}], ['memory.approve', { project: PROJECT, id: 'a' }], ['memory.reject', { project: PROJECT, id: 'a' }]]) {
    const res = await handlers[kind](payload);
    assert.deepEqual(res, { status: 'refused', error: 'failed' }, kind);
  }
  assert.equal(lines.length, 3);
});

// ---- headless host, snapshot flag, host switch ------------------------------

test('a headless host refuses every memory.* kind with needsHud', async () => {
  const handlers = needsHudMemoryHandlers();
  assert.deepEqual(Object.keys(handlers).sort(), [...KINDS].sort());
  for (const kind of KINDS) {
    assert.deepEqual(await handlers[kind]({ project: PROJECT, id: 'a' }), { status: 'refused', error: 'needsHud' }, kind);
  }
});

test('host snapshot: memory is true only when HUD host mode passes it', () => {
  assert.equal(hostSnapshot({}, NOW).memory, false, 'headless default');
  assert.equal(hostSnapshot({ memory: 'yes' }, NOW).memory, false);
  const hud = hostSnapshot({ memory: true }, NOW);
  assert.equal(hud.memory, true);
  assert.equal(parseHostPeer({ machine: 'KT-PC', data: hud }, NOW).memory, true);
  assert.equal(parseHostPeer({ machine: 'KT-PC', data: { ...hud, memory: 1 } }, NOW).memory, false);
});

test("host switch: HUD host mode hands startHost the HUD's memory inbox", () => {
  const calls = [];
  const memory = { handlers: {} };
  const control = createHostSwitch({
    machine: 'KT-PC',
    startHost: (opts) => {
      calls.push(opts);
      return { stop: () => {}, setDefault: () => {} };
    },
    hud: () => ({ cloud: { id: 'cloud' }, chatTabs: null, godmode: null, memory }),
    windows: () => [],
    isDefault: () => false,
  });
  control.start();
  assert.equal(calls[0].memory, memory);
});
