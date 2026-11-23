// ============================================================================
// Work map satellites (src/renderer/modules/workmapSatellites.js): which
// items sprout from a station and how many, how they fade, where their slots
// sit on the map, how a process snapshot is validated and folded, and that a
// paint under reduced motion starts no animation.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SAT = require('../src/renderer/modules/workmapSatellites.js');
const W = require('../src/renderer/modules/workmap.js');
const { STATIONS, createState, applyEvent } = require('../src/renderer/modules/workmapmodel.js');

// --- a minimal DOM for createSatelliteLayer() (set after the requires: modules read it at call time) ---

const animations = [];
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = new Map();
    this.children = [];
    this.style = {};
    this.listeners = {};
    this.textContent = '';
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  animate(keyframes, opts) {
    const anim = { node: this, keyframes, opts, cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(anim);
    return anim;
  }
}
globalThis.document = { createElementNS: (_ns, tag) => new FakeNode(tag), documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => (name.startsWith('--dur') ? '350ms' : '') });
globalThis.window = { i18n: { t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key) } };

const NOW = 10_000_000;
const item = (key, lastAt, extra = {}) => ({ key, kind: 'file', label: key, calls: 1, added: 0, removed: 0, failed: 0, firstAt: lastAt, lastAt, ...extra });

// --- fading and selection ------------------------------------------------------------

test('a satellite is solid while fresh, fades after a minute, and is gone when stale', () => {
  assert.equal(SAT.satelliteOpacity(0), 1);
  assert.equal(SAT.satelliteOpacity(SAT.SATELLITE_FADE_AFTER_MS), 1);
  const mid = SAT.satelliteOpacity((SAT.SATELLITE_FADE_AFTER_MS + SAT.SATELLITE_STALE_MS) / 2);
  assert.ok(mid < 1 && mid > SAT.MIN_SATELLITE_OPACITY, String(mid));
  assert.equal(SAT.satelliteOpacity(SAT.SATELLITE_STALE_MS), null);
  assert.equal(SAT.satelliteOpacity(NaN), 1, 'no timestamp: cannot be aged, counts as fresh');
  assert.equal(SAT.satelliteOpacity(-5000), 1, 'a time slightly in the future is fresh');
});

test('selectSatellites keeps the most recent, caps per station and drops stale ones', () => {
  const items = [];
  for (let i = 0; i < 10; i += 1) items.push(item(`f${i}`, NOW - i * 1000));
  items.push(item('stale', NOW - SAT.SATELLITE_STALE_MS - 1));
  const shown = SAT.selectSatellites(items, NOW);
  assert.equal(shown.length, SAT.MAX_SATELLITES_PER_STATION);
  assert.deepEqual(shown.map((s) => s.key), ['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
  assert.ok(shown.every((s) => s.opacity === 1));
  assert.equal(SAT.selectSatellites(items, NOW, 2).length, 2);
});

test('a live process outranks everything; among live ones the one with ports comes first', () => {
  const items = [
    item('recent-file', NOW),
    { key: 'pid:1', kind: 'process', lastAt: NOW - 600000, firstAt: 1, alive: true, weight: 0 },
    { key: 'pid:2', kind: 'process', lastAt: NOW - 600000, firstAt: 2, alive: true, weight: 1 },
  ];
  assert.deepEqual(SAT.selectSatellites(items, NOW).map((s) => s.key), ['pid:2', 'pid:1', 'recent-file']);
});

test('selectSatellites skips junk', () => {
  assert.deepEqual(SAT.selectSatellites(null, NOW), []);
  assert.deepEqual(SAT.selectSatellites([null, 5, { key: '' }, { nokey: 1 }], NOW), []);
});

test('satellites sprout from the model for files, subagents and MCP servers, capped per station', () => {
  const events = [];
  for (let i = 0; i < 9; i += 1) events.push({ phase: 'start', id: `r${i}`, tile: 'Read', at: NOW - 9000 + i, file: `C:/repo/src/f${i}.js` });
  events.push({ phase: 'start', id: 'k1', tile: 'Task', at: NOW, file: '', detail: 'Explore' });
  let s = applyEvent(createState(), { channel: 'metrics:tools', payload: { sessionId: 't', events } });
  s = applyEvent(s, { channel: 'metrics:mcp', payload: { sessionId: 't', events: [{ phase: 'start', id: 'm1', server: 'supabase', tool: 'list_tables', at: NOW }] } });
  const tab = s.tabs.get('t');
  const files = SAT.selectSatellites(SAT.satelliteItemsFor('files', tab.items, null), NOW);
  assert.equal(files.length, SAT.MAX_SATELLITES_PER_STATION);
  assert.equal(files[0].key, 'C:/repo/src/f8.js');
  assert.deepEqual(SAT.selectSatellites(SAT.satelliteItemsFor('agents', tab.items, null), NOW).map((x) => x.label), ['Explore']);
  assert.deepEqual(SAT.selectSatellites(SAT.satelliteItemsFor('mcp', tab.items, null), NOW).map((x) => x.label), ['supabase']);
  assert.deepEqual(SAT.satelliteItemsFor('memory', tab.items, null), []);
});

// --- slots ------------------------------------------------------------------------------

test('assignSlots keeps a shown satellite in its slot and puts a new one in the first free slot', () => {
  assert.deepEqual(SAT.assignSlots([], ['a', 'b'], 4), ['a', 'b', null, null]);
  assert.deepEqual(SAT.assignSlots(['a', 'b', null, null], ['c', 'b', 'a'], 4), ['a', 'b', 'c', null]);
  assert.deepEqual(SAT.assignSlots(['a', 'b', 'c', null], ['c', 'd'], 4), ['d', null, 'c', null]);
  assert.deepEqual(SAT.assignSlots(null, ['a', 'a', 'b', 'c'], 2), ['a', 'b']);
  assert.deepEqual(SAT.assignSlots(['x'], ['y'], 0), []);
});

const angleOf = (from, to) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
const angleDist = (a, b) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};

test('every station gets its slots on the map, clear of discs, the context ring, labels and each other', () => {
  const stations = W.stationLayout(STATIONS);
  // The map hands the slots its station centres and label rule, as workmap.js buildMap() does.
  const geometry = { center: W.CENTER, view: W.VIEW, stationR: W.STATION_R, stations, labelY: W.stationLabelY };
  const all = [];
  for (const pos of stations) {
    const slots = SAT.satelliteSlots(pos, geometry);
    assert.equal(slots.length, SAT.MAX_SATELLITES_PER_STATION, pos.id);
    const labelDeg = pos.y < W.CENTER.y - 1 ? -90 : 90;
    for (const s of slots) {
      const where = `${pos.id} slot at ${s.angleDeg}`;
      assert.ok(s.x - SAT.SATELLITE_R >= 0 && s.x + SAT.SATELLITE_R <= W.VIEW.w && s.y - SAT.SATELLITE_R >= 0 && s.y + SAT.SATELLITE_R <= W.VIEW.h, `${where}: inside the view`);
      assert.ok(Math.hypot(s.x - W.CENTER.x, s.y - W.CENTER.y) >= W.RING_R + SAT.SATELLITE_R + 4, `${where}: clear of the context ring`);
      for (const other of stations) {
        assert.ok(Math.hypot(s.x - other.x, s.y - other.y) >= W.STATION_R + SAT.SATELLITE_R + 2, `${where}: clear of ${other.id}'s disc`);
        // A station's two label lines, about 90 units wide, at their baselines.
        const ys = W.stationLabelY(other);
        for (const baseline of [ys.name, ys.status]) {
          const overlapsX = Math.abs(s.x - other.x) < 45 + SAT.SATELLITE_R;
          const overlapsY = s.y + SAT.SATELLITE_R > baseline - 11 && s.y - SAT.SATELLITE_R < baseline + 3;
          assert.ok(!(overlapsX && overlapsY), `${where}: clear of ${other.id}'s labels`);
        }
      }
      assert.ok(angleDist(angleOf(pos, s), labelDeg) >= 50, `${where}: not on its own label side`);
      assert.ok(angleDist(angleOf(pos, s), angleOf(pos, W.CENTER)) >= 40, `${where}: not on its spoke`);
      all.push({ ...s, id: pos.id });
    }
  }
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const d = Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y);
      assert.ok(d >= 2 * SAT.SATELLITE_R + 2, `${all[i].id}@${all[i].angleDeg} overlaps ${all[j].id}@${all[j].angleDeg}`);
    }
  }
});

// --- process snapshots ------------------------------------------------------------------

test('procListOf validates a snapshot that crossed IPC', () => {
  const snap = {
    at: NOW,
    sessions: {
      s1: [
        { pid: 10, ppid: 1, name: 'node.exe', label: 'node server.js', ports: [3000, 3000, 70000, -1, 'x'] },
        { pid: 'eleven', name: 'bad' },
        null,
        { pid: 12, name: 'evil\u202ename', label: '' },
      ],
    },
  };
  const list = SAT.procListOf(snap, 's1');
  assert.deepEqual(list, [
    { pid: 10, name: 'node.exe', label: 'node server.js', ports: [3000] },
    { pid: 12, name: 'evil name', label: 'evil name', ports: [] },
  ]);
  assert.deepEqual(SAT.procListOf(snap, 's2'), []);
  assert.deepEqual(SAT.procListOf(snap, '__proto__'), []);
  assert.deepEqual(SAT.procListOf(null, 's1'), []);
  assert.deepEqual(SAT.procListOf({ sessions: { s1: 'nope' } }, 's1'), []);
});

test('snapshotSessionIds keeps only plausible session ids', () => {
  const sessions = { ok_1: [], 'has space': [], '../x': [], 'a-b': [] };
  assert.deepEqual(SAT.snapshotSessionIds({ sessions }), ['ok_1', 'a-b']);
  assert.deepEqual(SAT.snapshotSessionIds({}), []);
  assert.deepEqual(SAT.snapshotSessionIds('junk'), []);
});

test('mergeProcs: listed processes and their ports are alive; one no longer listed fades from then', () => {
  const first = SAT.mergeProcs(null, [{ pid: 10, name: 'node.exe', label: 'node server.js', ports: [3000] }, { pid: 11, name: 'pwsh.exe', label: 'pwsh', ports: [] }], 1000);
  assert.equal(first.get('pid:10').alive, true);
  assert.equal(first.get('pid:10').weight, 1);
  assert.equal(first.get('port:3000').label, ':3000');
  assert.equal(first.get('port:3000').alive, true);
  const second = SAT.mergeProcs(first, [{ pid: 11, name: 'pwsh.exe', label: 'pwsh', ports: [] }], 5000);
  assert.equal(second.get('pid:11').firstAt, 1000, 'first seen is kept');
  assert.equal(second.get('pid:11').lastAt, 5000);
  assert.equal(second.get('pid:10').alive, false);
  assert.equal(second.get('pid:10').lastAt, 5000, 'gone since this snapshot');
  assert.equal(second.get('port:3000').alive, false);
  assert.equal(first.get('pid:10').alive, true, 'the previous map is not changed');
  const third = SAT.mergeProcs(second, [], 9000);
  assert.equal(third.get('pid:10').lastAt, 5000, 'already gone: keeps when it went');
});

test('mergeProcs forgets the longest-gone first beyond MAX_PROCS_REMEMBERED', () => {
  let seen = null;
  for (let i = 0; i < SAT.MAX_PROCS_REMEMBERED + 10; i += 1) seen = SAT.mergeProcs(seen, [{ pid: 100 + i, name: 'x', label: 'x', ports: [] }], 1000 + i);
  assert.equal(seen.size, SAT.MAX_PROCS_REMEMBERED);
  assert.ok(seen.has(`pid:${100 + SAT.MAX_PROCS_REMEMBERED + 9}`), 'the live one stays');
  assert.ok(!seen.has('pid:100'), 'the first to go is the first forgotten');
});

test('satelliteItemsFor puts processes on Shell and ports on Network, beside the model items', () => {
  const procs = SAT.mergeProcs(null, [{ pid: 10, name: 'node.exe', label: 'node server.js', ports: [5173] }], NOW);
  const tabItems = { network: [item('fetch', NOW, { kind: 'mcp' })], shell: [], files: [] };
  assert.deepEqual(SAT.satelliteItemsFor('shell', tabItems, procs).map((x) => x.key), ['pid:10']);
  assert.deepEqual(SAT.satelliteItemsFor('network', tabItems, procs).map((x) => x.key), ['fetch', 'port:5173']);
  assert.deepEqual(SAT.satelliteItemsFor('files', tabItems, procs), []);
  assert.deepEqual(SAT.satelliteItemsFor('files', null, null), []);
});

// --- text helpers --------------------------------------------------------------------------

test('baseName and formatLines', () => {
  assert.equal(SAT.baseName('C:\\repo\\src\\a.js'), 'a.js');
  assert.equal(SAT.baseName('/home/x/b.ts'), 'b.ts');
  assert.equal(SAT.baseName('plain'), 'plain');
  assert.equal(SAT.baseName(null), '');
  assert.equal(SAT.formatLines(12, 3), '+12 -3');
  assert.equal(SAT.formatLines(4, 0), '+4');
  assert.equal(SAT.formatLines(0, 2), '-2');
  assert.equal(SAT.formatLines(0, 0), '');
  assert.equal(SAT.formatLines(-1, 'x'), '');
});

// --- the layer on a fake DOM -----------------------------------------------------------------

function makeLayer(onPick) {
  const layer = new FakeNode('g');
  const positions = W.stationLayout(STATIONS);
  const sats = SAT.createSatelliteLayer(layer, positions, { center: W.CENTER, view: W.VIEW, stationR: W.STATION_R }, onPick);
  const groupsOf = (station) => layer.children.filter((g) => g.getAttribute('data-station') === station);
  return { layer, sats, groupsOf };
}

test('reduced motion: satellites are painted still, no sprout animation runs', () => {
  animations.length = 0;
  const { sats, groupsOf } = makeLayer(() => {});
  sats.paint('files', SAT.selectSatellites([item('C:/r/a.js', NOW), item('C:/r/b.js', NOW)], NOW), false);
  assert.equal(animations.length, 0);
  const shown = groupsOf('files').filter((g) => !g.getAttribute('class').includes('is-empty'));
  assert.equal(shown.length, 2);
  assert.equal(shown[0].children.find((c) => c.tag === 'text').textContent, 'a.js');
});

test('with motion, only a satellite new to its slot sprouts; the others stay put', () => {
  animations.length = 0;
  const { sats, groupsOf } = makeLayer(() => {});
  sats.paint('files', SAT.selectSatellites([item('a', NOW - 10), item('b', NOW - 20)], NOW), true);
  assert.equal(animations.length, 2);
  const slotOf = (key) => groupsOf('files').findIndex((g) => g.children.find((c) => c.tag === 'title').textContent.includes(`: ${key}`));
  const before = { a: slotOf('a'), b: slotOf('b') };
  sats.paint('files', SAT.selectSatellites([item('c', NOW), item('a', NOW - 10), item('b', NOW - 20)], NOW), true);
  assert.equal(animations.length, 3, 'one sprout, for c');
  assert.equal(slotOf('a'), before.a);
  assert.equal(slotOf('b'), before.b);
  sats.paint('files', SAT.selectSatellites([item('c', NOW), item('a', NOW - 10), item('b', NOW - 20)], NOW), true);
  assert.equal(animations.length, 3, 'a repaint sprouts nothing');
  sats.stop();
  assert.ok(animations.every((a) => a.cancelled));
});

test('clicking or pressing Enter on a satellite picks its item', () => {
  const picked = [];
  const { layer, sats, groupsOf } = makeLayer((station, it) => picked.push([station, it.key]));
  sats.paint('mcp', SAT.selectSatellites([item('supabase', NOW, { kind: 'mcp' })], NOW), false);
  const g = groupsOf('mcp').find((x) => !x.getAttribute('class').includes('is-empty'));
  const event = (extra) => ({ target: { closest: () => g }, preventDefault() {}, ...extra });
  layer.listeners.click[0](event({}));
  layer.listeners.keydown[0](event({ key: 'Enter' }));
  layer.listeners.keydown[0](event({ key: 'a' }));
  assert.deepEqual(picked, [['mcp', 'supabase'], ['mcp', 'supabase']]);
  // An empty slot picks nothing.
  const empty = groupsOf('mcp').find((x) => x.getAttribute('class').includes('is-empty'));
  layer.listeners.click[0]({ target: { closest: () => empty }, preventDefault() {} });
  assert.equal(picked.length, 2);
  assert.deepEqual(sats.shown('mcp').map((x) => x.key), ['supabase']);
});
