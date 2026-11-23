// ============================================================================
// God Mode Live Web: the model (src/renderer/modules/liveWebModel.js)
// ----------------------------------------------------------------------------
// One run as a web: Run -> Workers -> shared Files -> Processes / Ports /
// Verify / Subagents / MCP / Memory, with overlap warnings, the node cap and
// its "+N" summaries, layer filters, and the tool events that become
// particle bursts. Inputs are frozen: the model must never write to them.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../src/renderer/modules/liveWebModel.js');
const { createTabState } = require('../src/renderer/modules/workmapmodel.js');

const NOW = 1_800_000_000_000;
const WT = 'C:\\dev\\.luna-worktrees\\Luna-Core-HUD';

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    if (v instanceof Map) {
      for (const x of v.values()) deepFreeze(x);
    } else {
      for (const x of Object.values(v)) deepFreeze(x);
    }
  }
  return v;
}

const pkg = (id, extra = {}) => ({ id, title: `Title ${id}`, state: 'launched', dependsOn: [], touched: [], ...extra });

/** A tab state with some file / agent / MCP items, memory calls and recent calls. */
function tab(extra = {}) {
  const t = createTabState();
  return {
    ...t,
    contextTokens: 50_000,
    contextLimit: 200_000,
    modelLabel: 'Opus 5.5',
    items: { ...t.items, ...(extra.items || {}) },
    memoryCalls: { ...t.memoryCalls, ...(extra.memoryCalls || {}) },
    recent: extra.recent || [],
  };
}
const fileItem = (key, extra = {}) => ({ kind: 'file', key, label: key, calls: 1, added: 0, removed: 0, failed: 0, firstAt: NOW, lastAt: NOW, ...extra });
const procMap = (entries) => new Map(entries.map((e) => [e.key, e]));
const proc = (pid, name, ports = [], alive = true) => ({ key: `pid:${pid}`, kind: 'process', pid, name, label: `${name} --serve`, ports, alive, firstAt: NOW, lastAt: NOW, weight: 0 });

/** Four workers: a and b both change src/shared.js from their own worktrees, c depends on a, d has no tab. */
function sample() {
  const view = {
    id: 'plan',
    packages: [
      pkg('a', { sessionId: 's-a', touched: ['src/shared.js'] }),
      pkg('b', { sessionId: 's-b', state: 'finishing', verifyPhase: 'queued' }),
      pkg('c', { sessionId: 's-c', dependsOn: ['a'], touched: ['src/c-only.js', 'src/shared-ac.js'] }),
      pkg('d', { state: 'pending' }),
    ],
  };
  const tabs = new Map([
    ['s-a', tab({
      items: {
        files: [fileItem(`${WT}\\a-slug\\src\\read.js`), fileItem(`${WT}\\a-slug\\src\\shared-ac.js`, { added: 2 })],
        agents: [{ kind: 'agent', key: 'Explore', label: 'Explore', calls: 2, failed: 0, lastAt: NOW }],
        mcp: [{ kind: 'mcp', key: 'supabase', label: 'supabase', calls: 3, failed: 1, lastAt: NOW }],
      },
      memoryCalls: { search: 2, get: 1 },
    })],
    ['s-b', tab({
      items: {
        files: [fileItem(`${WT}\\b-slug\\src\\shared.js`, { added: 4, removed: 1 }), fileItem(`${WT}\\b-slug\\src\\read.js`)],
        network: [{ kind: 'mcp', key: 'supabase', label: 'supabase', calls: 1, failed: 0, lastAt: NOW }],
      },
    })],
  ]);
  const procs = new Map([
    ['s-a', procMap([proc(11, 'node', [3000])])],
    ['s-b', procMap([proc(22, 'vite', [3000, 5173]), proc(23, 'old', [], false)])],
  ]);
  return { view, tabs, procs };
}

const byId = (web) => new Map(web.nodes.map((n) => [n.id, n]));
const hasEdge = (web, from, to) => web.edges.some((e) => e.from === from && e.to === to);

test('fileKey: a worktree path becomes repo-relative, anything else keeps its shape', () => {
  assert.equal(M.fileKey(`${WT}\\slug\\src\\a.js`), 'src/a.js');
  assert.equal(M.fileKey('/home/m/.luna-worktrees/repo/slug/src/a.js'), 'src/a.js');
  assert.equal(M.fileKey('C:/dev/.Luna-Worktrees/repo/slug/README.md'), 'README.md');
  assert.equal(M.fileKey('C:\\dev\\repo\\src\\a.js'), 'C:/dev/repo/src/a.js');
  assert.equal(M.fileKey('./src/a.js'), 'src/a.js');
  // The worktree folder itself (no file below it) is not a repo path.
  assert.equal(M.fileKey(`${WT}\\slug`), 'C:/dev/.luna-worktrees/Luna-Core-HUD/slug');
  assert.equal(M.fileKey(''), '');
  assert.equal(M.fileKey(42), '');
  assert.equal(M.fileKey('x'.repeat(2000)), '');
  assert.equal(M.baseName('src/a/b.js'), 'b.js');
});

test('buildWeb: run -> workers with model, context and phase; a worker without a tab has no session detail', () => {
  const s = sample();
  const web = M.buildWeb({ ...deepFreeze(s), runLabel: 'Luna-Core-HUD', now: NOW });
  const n = byId(web);
  const run = n.get(M.RUN_ID);
  assert.equal(run.layer, 'run');
  assert.equal(run.label, 'Luna-Core-HUD');
  assert.deepEqual(run.fixed, { x: 0, y: 0 });
  assert.equal(run.total, 4);
  // a and c are launched, b is verifying; d waits.
  assert.equal(run.active, 3);
  const a = n.get('w:a');
  assert.equal(a.layer, 'worker');
  assert.equal(a.hasTab, true);
  assert.equal(a.model, 'Opus 5.5');
  assert.equal(a.context, 0.25);
  assert.equal(a.sessionId, 's-a');
  assert.equal(n.get('w:b').phase, 'queued');
  assert.equal(n.get('w:b').stateKey, 'waitingVerify');
  const c = n.get('w:c');
  assert.equal(c.hasTab, false);
  assert.equal(c.context, null);
  const d = n.get('w:d');
  assert.equal(d.sessionId, null);
  assert.equal(d.active, false);
  for (const id of ['w:a', 'w:b', 'w:c', 'w:d']) assert.ok(hasEdge(web, M.RUN_ID, id), id);
  assert.equal(web.bySession.get('s-a'), 'w:a');
  assert.equal(web.counts.workers, 4);
});

test('files: one node per repo path, shared across worktrees; overlap only for a clash', () => {
  const web = M.buildWeb({ ...deepFreeze(sample()), now: NOW });
  const n = byId(web);
  // a changed it (git), b changed it (lines): two unrelated workers -> overlap.
  const shared = n.get('f:src/shared.js');
  assert.deepEqual(shared.workers.map((w) => w.pkgId).sort(), ['a', 'b']);
  assert.equal(shared.overlap, true);
  assert.equal(shared.shared, true);
  assert.ok(hasEdge(web, 'w:a', 'f:src/shared.js') && hasEdge(web, 'w:b', 'f:src/shared.js'));
  // a and c both changed shared-ac.js, but c builds on a: expected, no warning.
  const ac = n.get('f:src/shared-ac.js');
  assert.equal(ac.changed, true);
  assert.equal(ac.overlap, false);
  // Both only read read.js: shared, not a clash.
  const read = n.get('f:src/read.js');
  assert.equal(read.shared, true);
  assert.equal(read.changed, false);
  assert.equal(read.overlap, false);
  assert.equal(n.get('f:src/c-only.js').shared, false);
  assert.equal(read.label, 'read.js');
  assert.equal(web.counts.files, 4);
});

test('processes, ports (a port held from two tabs clashes), verify, subagents, MCP and memory', () => {
  const web = M.buildWeb({ ...deepFreeze(sample()), now: NOW });
  const n = byId(web);
  const node = n.get('p:s-a:11');
  assert.equal(node.layer, 'process');
  assert.equal(node.command, 'node --serve');
  assert.ok(hasEdge(web, 'w:a', 'p:s-a:11'));
  // Port 3000 from s-a and s-b: a collision.
  const p3000 = n.get('port:3000');
  assert.equal(p3000.overlap, true);
  assert.equal(p3000.holders.length, 2);
  assert.ok(hasEdge(web, 'p:s-a:11', 'port:3000') && hasEdge(web, 'p:s-b:22', 'port:3000'));
  assert.equal(n.get('port:5173').overlap, false);
  // An exited process stays a while, faded.
  assert.equal(n.get('p:s-b:23').alive, false);
  const later = M.buildWeb({ ...sample(), now: NOW + M.GONE_KEEP_MS + 1 });
  assert.equal(byId(later).has('p:s-b:23'), false);
  // Verify: b waits for the verify queue.
  const v = n.get('v:b');
  assert.equal(v.layer, 'verify');
  assert.equal(v.phase, 'queued');
  assert.ok(hasEdge(web, 'w:b', 'v:b'));
  // Subagent of a, MCP server shared by a (mcp station) and b (network station).
  assert.ok(hasEdge(web, 'w:a', 'a:s-a:Explore'));
  const supa = n.get('m:supabase');
  assert.deepEqual(supa.workers.map((w) => [w.pkgId, w.calls, w.failed]), [['a', 3, 1], ['b', 1, 0]]);
  // One memory node, with a's calls.
  const mem = n.get(M.MEMORY_ID);
  assert.equal(mem.layer, 'memory');
  assert.deepEqual(mem.workers.map((w) => w.pkgId), ['a']);
  assert.equal(mem.workers[0].calls.search, 2);
  assert.ok(hasEdge(web, 'w:a', M.MEMORY_ID));
  assert.equal(web.counts.overlaps, 2);
  assert.equal(web.counts.processes, 2);
  // A failed package with a verify tail keeps a failed verify node.
  const failed = M.buildWeb({ view: { packages: [pkg('x', { state: 'failed', verifyTail: 'AssertionError: 1 !== 2' })] }, now: NOW });
  assert.equal(byId(failed).get('v:x').phase, 'failed');
  assert.equal(byId(failed).get('v:x').tail, 'AssertionError: 1 !== 2');
});

test('nodes come parents first, every edge joins two nodes, ids are unique', () => {
  const web = M.buildWeb({ ...sample(), now: NOW });
  const seen = new Set();
  for (const node of web.nodes) {
    assert.ok(!seen.has(node.id), `duplicate ${node.id}`);
    if (node.parent !== null) assert.ok(seen.has(node.parent), `${node.id} before its parent ${node.parent}`);
    seen.add(node.id);
    assert.ok(M.LAYERS.includes(node.layer), node.layer);
  }
  for (const e of web.edges) assert.ok(seen.has(e.from) && seen.has(e.to), e.id);
  assert.equal(new Set(web.edges.map((e) => e.id)).size, web.edges.length);
});

test('the node cap keeps the telling nodes and summarizes the rest per layer', () => {
  const packages = [];
  const tabs = new Map();
  for (let i = 0; i < 30; i += 1) {
    const sid = `s${i}`;
    packages.push(pkg(`p${i}`, { sessionId: sid, touched: i < 2 ? ['src/clash.js'] : [] }));
    const files = [];
    for (let f = 0; f < 12; f += 1) files.push(fileItem(`${WT}\\p${i}\\src\\f${i}-${f}.js`));
    tabs.set(sid, tab({ items: { files } }));
  }
  const web = M.buildWeb({ view: { packages }, tabs, now: NOW, cap: 120 });
  assert.ok(web.nodes.length <= 120, `${web.nodes.length} nodes`);
  const n = byId(web);
  // The spine and the clash survive; read-only files are what goes.
  for (let i = 0; i < 30; i += 1) assert.ok(n.has(`w:p${i}`));
  assert.equal(n.get('f:src/clash.js').overlap, true);
  const more = n.get('more:file');
  assert.equal(more.layer, 'more');
  assert.equal(more.moreOf, 'file');
  assert.equal(more.count, web.dropped.file);
  assert.equal(more.label, `+${more.count}`);
  assert.ok(hasEdge(web, M.RUN_ID, 'more:file'));
  const shownFiles = web.nodes.filter((x) => x.layer === 'file').length;
  assert.equal(shownFiles + more.count, 30 * 12 + 1);
  assert.equal(web.counts.files, 30 * 12 + 1);
  // The default cap is the named constant.
  assert.equal(M.MAX_WEB_NODES, 360);
  const big = M.buildWeb({ view: { packages }, tabs, now: NOW });
  assert.ok(big.nodes.length <= M.MAX_WEB_NODES);
});

test('a port whose process the cap dropped hangs off its worker instead', () => {
  const packages = [pkg('a', { sessionId: 's-a' })];
  // One exited process with a port, and a dozen more exited ones: 16 nodes.
  const entries = [proc(1, 'gone', [8080], false)];
  for (let pid = 2; pid <= 13; pid += 1) entries.push(proc(pid, `gone${pid}`, [], false));
  const procs = new Map([['s-a', procMap(entries)]]);
  const web = M.buildWeb({ view: { packages }, procs, now: NOW, cap: 13 });
  const n = byId(web);
  // Over the cap, 13 - one summary slot per layer leaves 3: run, worker and the port
  // (an exited process ranks below a port).
  assert.equal(n.has('p:s-a:1'), false);
  assert.ok(hasEdge(web, 'w:a', 'port:8080'));
  assert.equal(n.get('more:process').count, 13);
  for (const e of web.edges) assert.ok(n.has(e.from) && n.has(e.to));
});

test('filterWeb hides a layer with its edges and summaries; run and workers stay', () => {
  const web = M.buildWeb({ ...sample(), now: NOW });
  const noFiles = M.filterWeb(web, ['file', 'worker', 'bogus']);
  assert.ok(!noFiles.nodes.some((x) => x.layer === 'file'));
  assert.ok(noFiles.nodes.some((x) => x.layer === 'worker'));
  assert.ok(noFiles.nodes.some((x) => x.id === M.RUN_ID));
  const ids = new Set(noFiles.nodes.map((x) => x.id));
  for (const e of noFiles.edges) assert.ok(ids.has(e.from) && ids.has(e.to));
  assert.equal(M.filterWeb(web, []), web);
  assert.equal(M.filterWeb(web, null), web);
  const capped = M.buildWeb({ ...sample(), now: NOW, cap: 12 });
  const hiddenMore = M.filterWeb(capped, M.FILTER_LAYERS);
  assert.ok(!hiddenMore.nodes.some((x) => x.layer === 'more' && M.FILTER_LAYERS.includes(x.moreOf)));
});

test('the hidden-layer preference round-trips and ignores junk', () => {
  assert.deepEqual([...M.parseHiddenLayers('port, file,bogus,run,file')], ['port', 'file']);
  assert.equal(M.parseHiddenLayers(null).size, 0);
  assert.equal(M.parseHiddenLayers(42).size, 0);
  assert.equal(M.hiddenLayersText(new Set(['port', 'file', 'run'])), 'file,port');
  assert.equal(M.hiddenLayersText(null), '');
  assert.deepEqual(M.parseHiddenLayers(M.hiddenLayersText(new Set(M.FILTER_LAYERS))), new Set(M.FILTER_LAYERS));
});

test('toolEvents: new calls start, settled calls end, failures are marked', () => {
  const r = (callId, status, extra = {}) => ({ callId, station: 'files', file: 'C:\\x\\a.js', detail: '', status, ...extra });
  const prev = { recent: [r('1', 'running'), r('2', 'ok')] };
  const next = { recent: [r('1', 'failed'), r('2', 'ok'), r('3', 'running'), r('4', 'ok', { station: 'shell' })] };
  const evs = M.toolEvents(prev, next);
  assert.deepEqual(evs.map((e) => [e.callId, e.phase, e.failed]), [
    ['1', 'end', true],
    ['3', 'start', false],
    ['4', 'start', false],
    ['4', 'end', false],
  ]);
  assert.equal(evs[3].station, 'shell');
  // No earlier state (first paint, tab just shown): nothing travels.
  assert.deepEqual(M.toolEvents(null, next), []);
  assert.deepEqual(M.toolEvents(prev, null), []);
  const many = { recent: Array.from({ length: 40 }, (_, i) => r(`n${i}`, 'running')) };
  const capped = M.toolEvents({ recent: [] }, many);
  assert.equal(capped.length, M.MAX_BURST_EVENTS);
  assert.equal(capped[capped.length - 1].callId, 'n39');
});

test('burstEdge: an event travels to what it touched, else along the worker spoke', () => {
  const web = M.buildWeb({ ...sample(), now: NOW });
  const ev = (station, extra = {}) => ({ station, file: '', detail: '', phase: 'start', ...extra });
  assert.deepEqual(M.burstEdge(web, 's-a', ev('files', { file: `${WT}\\a-slug\\src\\shared.js` })), { edge: 'w:a>f:src/shared.js', reverse: false });
  assert.deepEqual(M.burstEdge(web, 's-a', ev('agents', { detail: 'Explore', phase: 'end' })), { edge: 'w:a>a:s-a:Explore', reverse: true });
  assert.deepEqual(M.burstEdge(web, 's-b', ev('network', { detail: 'supabase' })), { edge: 'w:b>m:supabase', reverse: false });
  assert.deepEqual(M.burstEdge(web, 's-a', ev('memory')), { edge: 'w:a>mem', reverse: false });
  assert.deepEqual(M.burstEdge(web, 's-a', ev('shell')), { edge: 'w:a>p:s-a:11', reverse: false });
  // Nothing matching (a file the cap or a filter hid): the run -> worker spoke.
  assert.deepEqual(M.burstEdge(web, 's-a', ev('files', { file: 'elsewhere.js' })), { edge: 'run>w:a', reverse: false });
  const hidden = M.filterWeb(web, ['file']);
  assert.deepEqual(M.burstEdge(hidden, 's-a', ev('files', { file: `${WT}\\a-slug\\src\\shared.js` })), { edge: 'run>w:a', reverse: false });
  assert.equal(M.burstEdge(web, 'nobody', ev('files')), null);
  assert.equal(M.burstEdge(null, 's-a', ev('files')), null);
});

test('junk never throws and yields at most an empty run', () => {
  const junk = [
    undefined,
    {},
    { view: 'x', tabs: 'y', procs: 5 },
    { view: { packages: 'no' } },
    { view: { packages: [null, 7, { id: '' }, { id: 'ok', state: 'weird' }, { id: 'ok' }] }, tabs: new Map([['s', 'junk']]) },
  ];
  for (const input of junk) {
    const web = M.buildWeb(input);
    assert.ok(Array.isArray(web.nodes) && Array.isArray(web.edges));
    assert.equal(web.nodes[0].id, M.RUN_ID);
  }
  const web = M.buildWeb({ view: { packages: [{ id: 'ok', state: 'weird', touched: [1, null, 'src/a.js'] }, { id: 'ok' }] } });
  assert.deepEqual(web.nodes.filter((x) => x.layer === 'worker').map((x) => [x.id, x.state]), [['w:ok', 'pending']]);
  assert.ok(byId(web).has('f:src/a.js'));
  // Bidi and control characters never reach a label.
  const sneaky = M.buildWeb({ view: { packages: [pkg('x\u202Ey', { title: 'a\u0000b' })] } });
  assert.equal(byId(sneaky).get('w:x y').title, 'a b');
  assert.deepEqual(M.ringsFor(0), { worker: 170, outer: 360 });
  assert.ok(M.ringsFor(40).worker > 170);
});
