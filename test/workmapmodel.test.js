// Tests for the pure work map model (src/renderer/modules/workmapmodel.js):
// station mapping, call start/end, errors, tab switching, unknown tools and
// malformed input. Zero DOM.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATIONS,
  MAX_PULSES,
  stationForTool,
  stationForTile,
  stationForMcp,
  createState,
  createTabState,
  activeTabState,
  applyEvent,
  pruneStale,
  subscribe,
} = require('../src/renderer/modules/workmapmodel.js');

const S = 'tab-1';
const tools = (events, sessionId = S, now) => ({ channel: 'metrics:tools', payload: { sessionId, events }, now });
const mcp = (events, sessionId = S) => ({ channel: 'metrics:mcp', payload: { sessionId, events } });
const start = (id, tile, at = 1000) => ({ phase: 'start', id, tile, at, file: '' });
const end = (id, tile, at = 1500) => ({ phase: 'end', id, tile, at, file: '' });
const tab = (state, key = S) => state.tabs.get(key);

function fold(events, state = createState()) {
  return events.reduce((s, ev) => applyEvent(s, ev), state);
}

/** Deep snapshot of a state for "was not mutated" checks (Map -> entries). */
function snapshot(state) {
  return JSON.stringify({ ...state, tabs: [...state.tabs] });
}

// ---- mapping ------------------------------------------------------------------

test('stationForTool maps every built-in tool family named in the brief', () => {
  for (const n of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'MultiEdit']) {
    assert.equal(stationForTool(n), 'files', n);
  }
  assert.equal(stationForTool('Bash'), 'shell');
  assert.equal(stationForTool('PowerShell'), 'shell');
  assert.equal(stationForTool('WebFetch'), 'network');
  assert.equal(stationForTool('WebSearch'), 'network');
  assert.equal(stationForTool('Agent'), 'agents');
  assert.equal(stationForTool('Task'), 'agents');
  assert.equal(stationForTool('Skill'), 'skills');
});

test('stationForTool routes MCP names: lunacore memory, network servers, the rest to mcp', () => {
  assert.equal(stationForTool('mcp__lunacore__memory_search'), 'memory');
  assert.equal(stationForTool('mcp__lunacore__memory_get'), 'memory');
  assert.equal(stationForTool('mcp__lunacore__luna_todo_add'), 'mcp');
  assert.equal(stationForTool('mcp__plugin_ecc_chrome-devtools__click'), 'network');
  assert.equal(stationForTool('mcp__fetch__fetch'), 'network');
  assert.equal(stationForTool('mcp__supabase__execute_sql'), 'mcp');
  assert.equal(stationForTool('mcp__codebase-memory-mcp__search'), 'mcp');
});

test('stationForTool sends unknown and non-string names to other', () => {
  assert.equal(stationForTool('TotallyNewTool'), 'other');
  assert.equal(stationForTool(''), 'other');
  assert.equal(stationForTool(undefined), 'other');
  assert.equal(stationForTool(42), 'other');
  assert.equal(stationForTool('mcp__'), 'other');
});

test('stationForTile covers every tile observer.js sends', () => {
  assert.deepEqual(
    ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Shell', 'Web', 'Task'].map(stationForTile),
    ['files', 'files', 'files', 'files', 'files', 'shell', 'network', 'agents'],
  );
  assert.equal(stationForTile('Nope'), 'other');
  assert.equal(stationForTile(null), 'other');
});

test('stationForMcp puts an agy tab\'s lunacore-<sessionId> memory tools on the Memory station', () => {
  assert.equal(stationForMcp('lunacore-s3', 'memory_search'), 'memory');
  assert.equal(stationForMcp('lunacore', 'memory_get'), 'memory');
  assert.equal(stationForMcp('lunacore-s3', 'luna_todo_list'), 'mcp');
  assert.equal(stationForMcp('lunacore2', 'memory_search'), 'mcp');
  assert.equal(stationForMcp('my-lunacore-s3', 'memory_search'), 'mcp');
});

test('stationForMcp without a server name is other', () => {
  assert.equal(stationForMcp('', 'x'), 'other');
  assert.equal(stationForMcp(undefined, undefined), 'other');
});

test('createTabState has every station idle', () => {
  const t = createTabState();
  assert.deepEqual(Object.keys(t.stations), [...STATIONS]);
  for (const id of STATIONS) assert.deepEqual(t.stations[id], { inFlight: 0, total: 0, errors: 0, lastError: null });
  assert.deepEqual(t.pulses, []);
  assert.equal(t.contextPercent, null);
});

// ---- start / end ----------------------------------------------------------------

test('a start lights the station and adds a pulse', () => {
  const s = applyEvent(createState(), tools([start('t1', 'Shell', 1234)]));
  const t = tab(s);
  assert.equal(t.stations.shell.inFlight, 1);
  assert.equal(t.stations.shell.total, 1);
  assert.deepEqual(t.pulses, [{ callId: 't1', station: 'shell', startedAt: 1234, item: null }]);
});

test('the matching end settles the station and removes the pulse; total stays', () => {
  const s = fold([tools([start('t1', 'Read')]), tools([end('t1', 'Read')])]);
  const t = tab(s);
  assert.equal(t.stations.files.inFlight, 0);
  assert.equal(t.stations.files.total, 1);
  assert.equal(t.stations.files.errors, 0);
  assert.deepEqual(t.pulses, []);
});

test('start and end in the same payload (one watcher tick) still count once', () => {
  const t = tab(applyEvent(createState(), tools([start('t1', 'Grep'), end('t1', 'Grep')])));
  assert.equal(t.stations.files.total, 1);
  assert.equal(t.stations.files.inFlight, 0);
});

test('parallel calls on one station track separately', () => {
  let s = fold([tools([start('a', 'Read'), start('b', 'Edit')])]);
  assert.equal(tab(s).stations.files.inFlight, 2);
  s = applyEvent(s, tools([end('a', 'Read')]));
  assert.equal(tab(s).stations.files.inFlight, 1);
  assert.deepEqual(tab(s).pulses.map((p) => p.callId), ['b']);
});

test('a duplicate start (re-read of the same line) is ignored and returns the same state', () => {
  const s1 = applyEvent(createState(), tools([start('t1', 'Read')]));
  const s2 = applyEvent(s1, tools([start('t1', 'Read')]));
  assert.equal(s2, s1);
  assert.equal(tab(s2).stations.files.total, 1);
});

test('an orphan end (never saw the start) is ignored', () => {
  const s0 = applyEvent(createState(), tools([start('x', 'Read')]));
  const s1 = applyEvent(s0, tools([end('ghost', 'Read')]));
  assert.equal(s1, s0);
});

test('start time falls back to the event clock when the transcript has none', () => {
  const s = applyEvent(createState(), tools([{ phase: 'start', id: 't', tile: 'Read', at: null }], S, 777));
  assert.equal(tab(s).pulses[0].startedAt, 777);
});

test('applyEvent never mutates the state it was given', () => {
  const s0 = applyEvent(createState(), tools([start('t1', 'Read')]));
  const before = snapshot(s0);
  const s1 = applyEvent(s0, tools([end('t1', 'Read'), start('t2', 'Shell')]));
  applyEvent(s1, { channel: 'metrics:turnend', payload: { sessionId: S, turn: { endedAt: 5 } } });
  assert.equal(snapshot(s0), before);
  assert.notEqual(s1, s0);
});

test('pulses are capped per tab', () => {
  const events = Array.from({ length: MAX_PULSES + 10 }, (_, i) => start(`id${i}`, 'Read'));
  const t = tab(applyEvent(createState(), tools(events)));
  assert.equal(t.pulses.length, MAX_PULSES);
  assert.equal(t.stations.files.inFlight, MAX_PULSES);
});

// ---- MCP + errors -----------------------------------------------------------------

test('an MCP memory call lands on the Memory station', () => {
  const s = applyEvent(createState(), mcp([{ phase: 'start', id: 'm1', server: 'lunacore', tool: 'memory_search', at: 1 }]));
  assert.equal(tab(s).stations.memory.inFlight, 1);
});

test('an MCP call that ends with ok:false is flagged with its error text', () => {
  const s = fold([
    mcp([{ phase: 'start', id: 'm1', server: 'supabase', tool: 'execute_sql', at: 1 }]),
    mcp([{ phase: 'end', id: 'm1', server: 'supabase', tool: 'execute_sql', at: 9, ok: false, content: [{ type: 'text', text: ' relation does not exist ' }] }]),
  ]);
  const st = tab(s).stations.mcp;
  assert.equal(st.inFlight, 0);
  assert.equal(st.errors, 1);
  assert.deepEqual(st.lastError, { callId: 'm1', at: 9, message: 'relation does not exist' });
});

test('a successful MCP end leaves errors at zero', () => {
  const s = fold([
    mcp([{ phase: 'start', id: 'm1', server: 'x', tool: 'y', at: 1 }]),
    mcp([{ phase: 'end', id: 'm1', at: 2, ok: true, content: 'fine' }]),
  ]);
  assert.equal(tab(s).stations.mcp.errors, 0);
  assert.equal(tab(s).stations.mcp.lastError, null);
});

test('a tool end flagged ok:false or isError counts as an error (forward-compatible)', () => {
  const s = fold([
    tools([start('a', 'Shell'), start('b', 'Read')]),
    tools([{ ...end('a', 'Shell'), ok: false, error: 'exit 1' }, { ...end('b', 'Read'), isError: true }]),
  ]);
  assert.equal(tab(s).stations.shell.errors, 1);
  assert.equal(tab(s).stations.shell.lastError.message, 'exit 1');
  assert.equal(tab(s).stations.files.errors, 1);
  assert.equal(tab(s).stations.files.lastError.message, '');
});

test('a long MCP error message is truncated', () => {
  const s = fold([
    mcp([{ phase: 'start', id: 'm', server: 'x', tool: 'y' }]),
    mcp([{ phase: 'end', id: 'm', ok: false, content: 'e'.repeat(5000) }]),
  ]);
  assert.equal(tab(s).stations.mcp.lastError.message.length, 200);
});

test('a named tool event (future observer) maps by name, beating the tile', () => {
  const s = applyEvent(createState(), tools([{ phase: 'start', id: 'k', name: 'Skill', tile: 'Read', at: 1 }]));
  assert.equal(tab(s).stations.skills.inFlight, 1);
  assert.equal(tab(s).stations.files.inFlight, 0);
});

// ---- unknown tool -------------------------------------------------------------------

test('an unknown tile lands on the Other station and still pairs with its end', () => {
  const s = fold([tools([start('u', 'Mystery')]), tools([end('u', 'Mystery')])]);
  assert.equal(tab(s).stations.other.total, 1);
  assert.equal(tab(s).stations.other.inFlight, 0);
});

// ---- context, model, turns ---------------------------------------------------------

test('a context sample sets percent, tokens, limit and model', () => {
  const s = applyEvent(createState(), {
    channel: 'metrics:context',
    payload: { sessionId: S, metrics: { tokens: 50000, limit: 200000, percent: 25, model: 'claude-opus-5-5', modelLabel: 'Opus 5.5' } },
  });
  const t = tab(s);
  assert.equal(t.contextPercent, 25);
  assert.equal(t.contextTokens, 50000);
  assert.equal(t.contextLimit, 200000);
  assert.equal(t.model, 'claude-opus-5-5');
  assert.equal(t.modelLabel, 'Opus 5.5');
});

test('a context sample without a model keeps the last known one; percent is clamped', () => {
  const s = fold([
    { channel: 'metrics:context', payload: { sessionId: S, metrics: { percent: 10, model: 'm1' } } },
    { channel: 'metrics:context', payload: { sessionId: S, metrics: { percent: 140 } } },
  ]);
  assert.equal(tab(s).model, 'm1');
  assert.equal(tab(s).contextPercent, 100);
});

test('a turn end counts the turn and clears anything still in flight', () => {
  const s = fold([
    tools([start('a', 'Shell')]),
    { channel: 'metrics:turnend', payload: { sessionId: S, turn: { startedAt: 1, endedAt: 99, text: '' } } },
  ]);
  const t = tab(s);
  assert.equal(t.turns, 1);
  assert.equal(t.lastTurnEndedAt, 99);
  assert.equal(t.stations.shell.inFlight, 0);
  assert.equal(t.stations.shell.total, 1);
  assert.deepEqual(t.pulses, []);
});

test('tab:reset drops in-flight calls but keeps history', () => {
  const s = fold([tools([start('a', 'Shell')]), { channel: 'tab:reset', payload: { sessionId: S } }]);
  assert.equal(tab(s).stations.shell.inFlight, 0);
  assert.equal(tab(s).stations.shell.total, 1);
});

test('pruneStale drops calls older than the watchdog and nothing else', () => {
  const s0 = applyEvent(createState(), tools([start('old', 'Shell', 1000), start('new', 'Read', 9000)]));
  const s1 = pruneStale(s0, 10000, 5000);
  assert.deepEqual(tab(s1).pulses.map((p) => p.callId), ['new']);
  assert.equal(tab(s1).stations.shell.inFlight, 0);
  assert.equal(pruneStale(s1, 10000, 5000), s1);
});

// ---- tab switch -----------------------------------------------------------------------

test('events for different tabs stay separate and tab:active picks which one is shown', () => {
  let s = fold([tools([start('a', 'Shell')], 'tab-1'), tools([start('b', 'Read')], 'tab-2')]);
  assert.equal(activeTabState(s), null);
  s = applyEvent(s, { channel: 'tab:active', payload: { sessionId: 'tab-2' } });
  assert.equal(s.activeTab, 'tab-2');
  assert.equal(activeTabState(s).stations.files.inFlight, 1);
  assert.equal(activeTabState(s).stations.shell.inFlight, 0);
  s = applyEvent(s, { channel: 'tab:active', payload: { sessionId: 'tab-1' } });
  assert.equal(activeTabState(s).stations.shell.inFlight, 1);
});

test('switching to the already-active tab returns the same state', () => {
  const s = applyEvent(createState(), { channel: 'tab:active', payload: { sessionId: S } });
  assert.equal(applyEvent(s, { channel: 'tab:active', payload: { sessionId: S } }), s);
});

test('a background tab keeps folding while another is active', () => {
  let s = applyEvent(createState(), { channel: 'tab:active', payload: { sessionId: 'tab-1' } });
  s = applyEvent(s, tools([start('bg', 'Web')], 'tab-2'));
  assert.equal(s.activeTab, 'tab-1');
  assert.equal(tab(s, 'tab-2').stations.network.inFlight, 1);
});

test('tab:closed forgets the tab and clears activeTab when it was active', () => {
  let s = fold([
    { channel: 'tab:active', payload: { sessionId: S } },
    tools([start('a', 'Read')]),
  ]);
  s = applyEvent(s, { channel: 'tab:closed', payload: { sessionId: S } });
  assert.equal(s.tabs.has(S), false);
  assert.equal(s.activeTab, null);
  assert.equal(applyEvent(s, { channel: 'tab:closed', payload: { sessionId: S } }), s);
});

// ---- malformed input ------------------------------------------------------------------

test('malformed events never throw and leave the state untouched', () => {
  const s0 = applyEvent(createState(), tools([start('a', 'Read')]));
  const before = snapshot(s0);
  const junk = [
    undefined, null, 0, 'metrics:tools', [], {},
    { channel: 42 },
    { channel: 'metrics:tools' },
    { channel: 'metrics:tools', payload: null },
    { channel: 'metrics:tools', payload: 'x' },
    { channel: 'metrics:tools', payload: { sessionId: S } },
    { channel: 'metrics:tools', payload: { sessionId: S, events: 'nope' } },
    { channel: 'metrics:tools', payload: { sessionId: S, events: [null, 1, 'x', {}, { id: 5 }, { id: '', phase: 'start' }, { id: 'q', phase: 'weird' }] } },
    { channel: 'metrics:tools', payload: { sessionId: {}, events: [start('z', 'Read')] } },
    { channel: 'metrics:tools', payload: { sessionId: '', events: [start('z', 'Read')] } },
    { channel: 'metrics:tools', payload: { sessionId: S, tiles: ['Shell'] } },
    { channel: 'metrics:context', payload: { sessionId: S } },
    { channel: 'metrics:context', payload: { sessionId: S, metrics: { percent: 'high' } } },
    { channel: 'metrics:context', payload: { sessionId: S, metrics: { percent: NaN } } },
    { channel: 'metrics:mcp', payload: { sessionId: S, events: [{ phase: 'end', id: 'nobody', ok: false, content: { weird: true } }, { phase: 'start' }, { phase: 'start', id: 7 }] } },
    { channel: 'tab:active', payload: { sessionId: null } },
    { channel: '__proto__', payload: { sessionId: S } },
    { channel: 'constructor', payload: { sessionId: S } },
    { channel: 'toString', payload: { sessionId: S } },
  ];
  for (const ev of junk) {
    assert.doesNotThrow(() => applyEvent(s0, ev), `threw on ${JSON.stringify(ev)}`);
  }
  for (const ev of junk) {
    assert.equal(applyEvent(s0, ev), s0, `changed state on ${JSON.stringify(ev)}`);
  }
  assert.equal(snapshot(s0), before);
});

test('an ok:false MCP end with non-text content closes the call with an empty message', () => {
  const s = fold([
    mcp([{ phase: 'start', id: 'm', server: 'x', tool: 'y', at: 1 }]),
    mcp([{ phase: 'end', id: 'm', ok: false, content: { weird: true } }]),
  ]);
  assert.equal(tab(s).stations.mcp.errors, 1);
  assert.equal(tab(s).stations.mcp.lastError.message, '');
});

test('a start re-delivered after its end does not re-open the call', () => {
  const s = fold([tools([start('x', 'Read')]), tools([end('x', 'Read')]), tools([start('x', 'Read')])]);
  assert.equal(tab(s).stations.files.inFlight, 0);
  assert.equal(tab(s).stations.files.total, 1);
  assert.deepEqual(tab(s).pulses, []);
});

test('a start re-delivered after a turn end cleared it does not re-open it', () => {
  const s = fold([
    tools([start('x', 'Shell')]),
    { channel: 'metrics:turnend', payload: { sessionId: S, turn: { endedAt: 2 } } },
    tools([start('x', 'Shell')]),
  ]);
  assert.equal(tab(s).stations.shell.inFlight, 0);
  assert.equal(tab(s).stations.shell.total, 1);
});

test('the finished-id memory is bounded', () => {
  const events = [];
  for (let i = 0; i < 300; i++) events.push(start(`c${i}`, 'Read'), end(`c${i}`, 'Read'));
  const t = tab(applyEvent(createState(), tools(events)));
  assert.equal(t.endedIds.length, 256);
  assert.equal(t.endedIds[255], 'c299');
  assert.equal(t.stations.files.total, 300);
});

test('a turn end without a turn object is ignored', () => {
  const s0 = createState();
  assert.equal(applyEvent(s0, { channel: 'metrics:turnend', payload: { sessionId: 'z' } }), s0);
  assert.equal(applyEvent(s0, { channel: 'metrics:turnend', payload: { sessionId: 'z', turn: 'x' } }), s0);
});

test('a context sample with only a model or only tokens keeps the other fields', () => {
  const s = fold([
    { channel: 'metrics:context', payload: { sessionId: S, metrics: { percent: 30, tokens: 3, limit: 10 } } },
    { channel: 'metrics:context', payload: { sessionId: S, metrics: { model: 'm2' } } },
    { channel: 'metrics:context', payload: { sessionId: S, metrics: { tokens: 4 } } },
  ]);
  const t = tab(s);
  assert.equal(t.contextPercent, 30);
  assert.equal(t.contextLimit, 10);
  assert.equal(t.contextTokens, 4);
  assert.equal(t.model, 'm2');
});

test('prototype-ish names as session id or call id are plain keys', () => {
  let s = applyEvent(createState(), tools([start('__proto__', 'Read'), start('constructor', 'Shell')], '__proto__'));
  assert.equal(s.tabs.get('__proto__').stations.files.inFlight, 1);
  s = applyEvent(s, tools([end('__proto__', 'Read')], '__proto__'));
  assert.equal(s.tabs.get('__proto__').stations.files.inFlight, 0);
  assert.equal(activeTabState(applyEvent(s, { channel: 'tab:active', payload: { sessionId: 'constructor' } })), null);
});

test('tab:reset keeps totals and errors', () => {
  const s = fold([
    mcp([{ phase: 'start', id: 'm', server: 'x', tool: 'y', at: 1 }]),
    mcp([{ phase: 'end', id: 'm', ok: false, content: 'boom' }]),
    tools([start('a', 'Shell')]),
    { channel: 'tab:reset', payload: { sessionId: S } },
  ]);
  assert.equal(tab(s).stations.mcp.errors, 1);
  assert.equal(tab(s).stations.shell.total, 1);
  assert.equal(tab(s).stations.shell.inFlight, 0);
});

test('a malformed event for an unseen tab does not create an empty tab', () => {
  const s0 = createState();
  assert.equal(applyEvent(s0, { channel: 'metrics:tools', payload: { sessionId: 'new', events: [] } }), s0);
  assert.equal(applyEvent(s0, { channel: 'tab:reset', payload: { sessionId: 'new' } }), s0);
});

test('a garbage state is returned as is rather than thrown on', () => {
  for (const bad of [undefined, null, 5, {}, { tabs: {} }]) {
    assert.doesNotThrow(() => applyEvent(bad, tools([start('a', 'Read')])));
    assert.equal(applyEvent(bad, tools([start('a', 'Read')])), bad);
    assert.equal(pruneStale(bad, 1), bad);
    assert.equal(activeTabState(bad), null);
  }
});

test('a numeric session id is accepted and stringified', () => {
  const s = applyEvent(createState(), tools([start('a', 'Read')], 7));
  assert.equal(s.tabs.has('7'), true);
});

// ---- subscribe -------------------------------------------------------------------------

function fakeBridge() {
  const cbs = {};
  const bridge = {};
  for (const m of ['onTools', 'onMcp', 'onContext', 'onTurnEnd']) bridge[m] = (cb) => { cbs[m] = cb; };
  return { bridge, cbs };
}

test('subscribe folds bridge payloads, follows the active tab and reports changes', () => {
  const { bridge, cbs } = fakeBridge();
  const seen = [];
  let active = 'tab-1';
  const sub = subscribe(bridge, (s) => seen.push(s), { getActiveSessionId: () => active, now: () => 42 });
  cbs.onTools({ sessionId: 'tab-1', events: [{ phase: 'start', id: 'a', tile: 'Shell', at: null }] });
  assert.equal(seen.length, 1);
  assert.equal(sub.getState().activeTab, 'tab-1');
  assert.equal(activeTabState(sub.getState()).pulses[0].startedAt, 42);
  active = 'tab-2';
  cbs.onContext({ sessionId: 'tab-2', metrics: { percent: 5 } });
  assert.equal(sub.getState().activeTab, 'tab-2');
  assert.equal(activeTabState(sub.getState()).contextPercent, 5);
  cbs.onMcp({ sessionId: 'tab-2', events: 'junk' });
  // The junk event changed nothing, so no extra notification.
  assert.equal(seen.length, 2);
  sub.stop();
  cbs.onTurnEnd({ sessionId: 'tab-2', turn: {} });
  assert.equal(seen.length, 2);
});

test('subscribe.prune ages out stuck calls on the subscription clock', () => {
  const { bridge, cbs } = fakeBridge();
  let clock = 1000;
  const seen = [];
  const sub = subscribe(bridge, (s) => seen.push(s), { now: () => clock });
  cbs.onTools({ sessionId: S, events: [{ phase: 'start', id: 'a', tile: 'Shell', at: null }] });
  sub.prune(5000);
  assert.equal(seen.length, 1);
  clock = 7000;
  sub.prune(5000);
  assert.equal(seen.length, 2);
  assert.equal(tab(sub.getState()).stations.shell.inFlight, 0);
});

test('subscribe tolerates a missing or partial bridge', () => {
  assert.doesNotThrow(() => subscribe(undefined, () => {}));
  assert.doesNotThrow(() => subscribe({ onTools: 'not a function' }, null).dispatch(tools([start('a', 'Read')])));
});

// ---- ticker lines and station items (slice 2 of #agymap) ---------------------------

const {
  MAX_RECENT,
  MAX_ITEMS_PER_STATION,
  MAX_DETAIL_CHARS,
  cleanText,
  tabStateOf,
} = require('../src/renderer/modules/workmapmodel.js');

const fileStart = (id, tile, file, at = 1000) => ({ phase: 'start', id, tile, at, file });
const fileEnd = (id, tile, file, added, removed, at = 1500) => ({ phase: 'end', id, tile, at, file, added, removed });

test('a start adds a running ticker line with its tool and sanitized detail', () => {
  const t = tab(applyEvent(createState(), tools([{ phase: 'start', id: 's1', tile: 'Shell', at: 1000, file: '', detail: 'npm test' }])));
  assert.equal(t.recent.length, 1);
  assert.deepEqual(t.recent[0], { callId: 's1', station: 'shell', tool: 'Shell', detail: 'npm test', file: '', added: 0, removed: 0, status: 'running', at: 1000 });
});

test('the end settles its ticker line as ok with its +/- lines', () => {
  const s = fold([tools([fileStart('e1', 'Edit', 'C:/r/src/a.js')]), tools([fileEnd('e1', 'Edit', 'C:/r/src/a.js', 12, 3)])]);
  const line = tab(s).recent[0];
  assert.equal(line.status, 'ok');
  assert.equal(line.added, 12);
  assert.equal(line.removed, 3);
  assert.equal(line.file, 'C:/r/src/a.js');
});

test('a failed MCP call reads failed; a turn end and a stale prune read dropped', () => {
  let s = applyEvent(createState(), mcp([{ phase: 'start', id: 'm1', server: 'supabase', tool: 'execute_sql', at: 1 }]));
  s = applyEvent(s, mcp([{ phase: 'end', id: 'm1', server: 'supabase', tool: 'execute_sql', at: 2, ok: false, content: 'boom' }]));
  assert.equal(tab(s).recent[0].status, 'failed');
  s = applyEvent(s, tools([start('r1', 'Read')]));
  s = applyEvent(s, { channel: 'metrics:turnend', payload: { sessionId: S, turn: { endedAt: 3 } } });
  assert.equal(tab(s).recent[1].status, 'dropped');
  s = applyEvent(s, tools([start('r2', 'Read', 10)]));
  s = pruneStale(s, 10 + 60000, 1000);
  assert.equal(tab(s).recent[2].status, 'dropped');
});

test('the ticker keeps the newest MAX_RECENT calls', () => {
  const events = [];
  for (let i = 0; i < MAX_RECENT + 5; i += 1) events.push(start(`c${i}`, 'Grep', i), end(`c${i}`, 'Grep', i + 1));
  const t = tab(applyEvent(createState(), tools(events)));
  assert.equal(t.recent.length, MAX_RECENT);
  assert.equal(t.recent[0].callId, 'c5');
  assert.equal(t.recent[MAX_RECENT - 1].callId, `c${MAX_RECENT + 4}`);
});

test('MCP calls name their server; the call input is never kept', () => {
  const t = tab(applyEvent(createState(), mcp([{ phase: 'start', id: 'm1', server: 'supabase', tool: 'execute_sql', input: { query: 'select secret' }, at: 1 }])));
  assert.equal(t.recent[0].tool, 'execute_sql');
  assert.equal(t.recent[0].detail, 'supabase');
  assert.doesNotMatch(JSON.stringify(t), /select secret/);
});

test('file tools leave one item per distinct file on Files, most recent last, with their lines', () => {
  const s = fold([
    tools([fileStart('a1', 'Read', 'C:/r/a.js', 1), fileEnd('a1', 'Read', 'C:/r/a.js', 0, 0, 2)]),
    tools([fileStart('b1', 'Edit', 'C:/r/b.js', 3), fileEnd('b1', 'Edit', 'C:/r/b.js', 4, 1, 4)]),
    tools([fileStart('a2', 'Edit', 'C:/r/a.js', 5), fileEnd('a2', 'Edit', 'C:/r/a.js', 2, 2, 6)]),
  ]);
  const files = tab(s).items.files;
  assert.deepEqual(files.map((it) => it.key), ['C:/r/b.js', 'C:/r/a.js']);
  const a = files[1];
  assert.equal(a.kind, 'file');
  assert.equal(a.calls, 2);
  assert.equal(a.added, 2);
  assert.equal(a.removed, 2);
  assert.equal(a.firstAt, 1);
  assert.equal(a.lastAt, 6);
});

test('a Grep has no file item; a Task with an agent type is a subagent item', () => {
  const s = fold([
    tools([{ phase: 'start', id: 'g', tile: 'Grep', at: 1, file: '', detail: 'TODO' }]),
    tools([{ phase: 'start', id: 'k', tile: 'Task', at: 2, file: '', detail: 'code-reviewer' }]),
  ]);
  const t = tab(s);
  assert.deepEqual(t.items.files, []);
  assert.deepEqual(t.items.agents.map((it) => [it.kind, it.label]), [['agent', 'code-reviewer']]);
});

test('MCP servers are items on their station, never on Memory', () => {
  const s = fold([
    mcp([{ phase: 'start', id: 'm1', server: 'supabase', tool: 'list_tables', at: 1 }]),
    mcp([{ phase: 'start', id: 'm2', server: 'plugin_ecc_chrome-devtools', tool: 'click', at: 2 }]),
    mcp([{ phase: 'start', id: 'm3', server: 'lunacore', tool: 'memory_search', at: 3 }]),
  ]);
  const t = tab(s);
  assert.deepEqual(t.items.mcp.map((it) => it.key), ['supabase']);
  assert.deepEqual(t.items.network.map((it) => it.key), ['plugin_ecc_chrome-devtools']);
  assert.deepEqual(t.items.memory, []);
});

test('a station remembers at most MAX_ITEMS_PER_STATION items, dropping the least recent', () => {
  const events = [];
  for (let i = 0; i < MAX_ITEMS_PER_STATION + 3; i += 1) events.push(fileStart(`f${i}`, 'Read', `C:/r/f${i}.js`, i));
  const files = tab(applyEvent(createState(), tools(events))).items.files;
  assert.equal(files.length, MAX_ITEMS_PER_STATION);
  assert.equal(files[0].key, 'C:/r/f3.js');
});

test('feed text is cleaned: control, bidi and zero-width characters go, length is capped', () => {
  assert.equal(cleanText('ls\u202e -la\u0007\nfoo\u200b'), 'ls -la foo');
  assert.equal(cleanText('x'.repeat(500)).length, MAX_DETAIL_CHARS);
  assert.equal(cleanText(42), '');
  assert.equal(cleanText(null), '');
  const t = tab(applyEvent(createState(), tools([{ phase: 'start', id: 'x', tile: 'Shell', at: 1, file: '', detail: 'rm\u2028-rf' }])));
  assert.equal(t.recent[0].detail, 'rm -rf');
});

test('a file path with control characters or of absurd length makes no item', () => {
  const s = applyEvent(createState(), tools([fileStart('p1', 'Read', 'C:/r/a\u0000.js'), fileStart('p2', 'Read', `C:/${'a'.repeat(2000)}`)]));
  assert.deepEqual(tab(s).items.files, []);
  assert.equal(tab(s).stations.files.total, 2);
});

test('junk +/- counts on an end are read as zero', () => {
  const s = fold([tools([fileStart('e1', 'Edit', 'C:/r/a.js')]), tools([fileEnd('e1', 'Edit', 'C:/r/a.js', -4, 'nine')])]);
  assert.equal(tab(s).recent[0].added, 0);
  assert.equal(tab(s).items.files[0].removed, 0);
});

test('recording a call never mutates the previous state', () => {
  const s1 = applyEvent(createState(), tools([fileStart('a', 'Read', 'C:/r/a.js')]));
  const before = snapshot(s1);
  applyEvent(s1, tools([fileEnd('a', 'Read', 'C:/r/a.js', 3, 1), fileStart('b', 'Edit', 'C:/r/a.js')]));
  assert.equal(snapshot(s1), before);
});

test('tabStateOf reads any tab by id, null for junk or unknown ids', () => {
  const s = applyEvent(applyEvent(createState(), tools([start('a', 'Read')], 'one')), tools([start('b', 'Read')], 'two'));
  assert.equal(tabStateOf(s, 'two').stations.files.total, 1);
  assert.equal(tabStateOf(s, 'three'), null);
  assert.equal(tabStateOf(s, 42), null);
  assert.equal(tabStateOf(null, 'one'), null);
});

// ---- Hooks station, built-in tool errors and the Skill tool -------------------

const { isHookRefusal } = require('../src/renderer/modules/workmapmodel.js');

const startNamed = (id, tile, toolName, at = 1000) => ({ phase: 'start', id, tile, toolName, at, file: '' });
const endWith = (id, tile, extra, at = 1500) => ({ phase: 'end', id, tile, at, file: '', ...extra });

test('STATIONS has a Hooks station and createTabState starts it idle', () => {
  assert.ok(STATIONS.includes('hooks'));
  assert.deepEqual(createTabState().stations.hooks, { inFlight: 0, total: 0, errors: 0, lastError: null });
});

test('a Skill call (empty tile, toolName Skill) lights the Skills station and settles', () => {
  let s = applyEvent(createState(), tools([startNamed('k1', '', 'Skill')]));
  assert.equal(tab(s).stations.skills.inFlight, 1);
  assert.equal(tab(s).stations.other.total, 0);
  assert.equal(tab(s).recent[0].tool, 'Skill');
  s = applyEvent(s, tools([endWith('k1', '', { toolName: 'Skill', isError: false })]));
  assert.equal(tab(s).stations.skills.inFlight, 0);
  assert.equal(tab(s).stations.skills.total, 1);
  assert.equal(tab(s).stations.skills.errors, 0);
});

test('a toolName start maps like the tile it comes with', () => {
  const s = applyEvent(createState(), tools([startNamed('t1', 'Shell', 'PowerShell')]));
  assert.equal(tab(s).stations.shell.inFlight, 1);
});

test('isHookRefusal: toolDenialKind alone, the PreToolUse prefix alone, neither', () => {
  assert.equal(isHookRefusal({ toolDenialKind: 'hook' }), true);
  assert.equal(isHookRefusal({ error: 'PreToolUse:Edit hook error: nope' }), true);
  assert.equal(isHookRefusal({ error: '  PreToolUse:Bash hook error: nope' }), true);
  assert.equal(isHookRefusal({ isError: true, error: 'Exit code 1' }), false);
  assert.equal(isHookRefusal({ toolDenialKind: '' }), false);
  assert.equal(isHookRefusal(null), false);
  assert.equal(isHookRefusal('PreToolUse:'), false);
});

test('a refusal flagged by toolDenialKind lights Hooks red, not the Edit', () => {
  let s = applyEvent(createState(), tools([startNamed('e1', 'Edit', 'Edit')]));
  s = applyEvent(s, tools([endWith('e1', 'Edit', { toolName: 'Edit', isError: true, toolDenialKind: 'hook', error: 'gate says no' })]));
  const t = tab(s);
  assert.equal(t.stations.files.inFlight, 0);
  assert.equal(t.stations.files.errors, 0, 'the refused Edit is not a failed Edit');
  assert.equal(t.stations.hooks.errors, 1);
  assert.equal(t.stations.hooks.total, 1);
  assert.equal(t.stations.hooks.inFlight, 0);
  assert.equal(t.stations.hooks.lastError.callId, 'e1');
  assert.equal(t.stations.hooks.lastError.message, 'gate says no');
  assert.equal(t.pulses.length, 0);
  assert.equal(t.recent[0].status, 'failed');
  assert.equal(t.recent[0].station, 'hooks', 'the ticker files it under Hooks');
});

test('a refusal flagged only by the PreToolUse: prefix lands on Hooks too', () => {
  let s = applyEvent(createState(), tools([startNamed('w1', 'Write', 'Write')]));
  s = applyEvent(s, tools([endWith('w1', 'Write', { isError: true, error: 'PreToolUse:Write hook error: [gate] read it first' })]));
  assert.equal(tab(s).stations.hooks.errors, 1);
  assert.equal(tab(s).stations.files.errors, 0);
  assert.match(tab(s).stations.hooks.lastError.message, /^PreToolUse:Write/);
});

test('an ordinary built-in tool error is a red error on its own station, not on Hooks', () => {
  let s = applyEvent(createState(), tools([startNamed('b1', 'Shell', 'Bash')]));
  s = applyEvent(s, tools([endWith('b1', 'Shell', { toolName: 'Bash', isError: true, error: 'Exit code 2' })]));
  const t = tab(s);
  assert.equal(t.stations.shell.errors, 1);
  assert.equal(t.stations.shell.lastError.message, 'Exit code 2');
  assert.equal(t.stations.hooks.errors, 0);
  assert.equal(t.stations.hooks.total, 0);
  assert.equal(t.recent[0].status, 'failed');
  assert.equal(t.recent[0].station, 'shell');
});

test('isError false leaves a clean end clean, and an error text is cleaned of control characters', () => {
  let s = applyEvent(createState(), tools([startNamed('r1', 'Read', 'Read')]));
  s = applyEvent(s, tools([endWith('r1', 'Read', { isError: false })]));
  assert.equal(tab(s).stations.files.errors, 0);
  s = applyEvent(s, tools([startNamed('r2', 'Read', 'Read')]));
  s = applyEvent(s, tools([endWith('r2', 'Read', { isError: true, error: 'bad‮\nthing' })]));
  assert.equal(tab(s).stations.files.lastError.message, 'bad thing');
});

test('a refusal of a call that never opened here is an orphan end and changes nothing', () => {
  const s0 = applyEvent(createState(), tools([startNamed('x0', 'Read', 'Read')]));
  const s1 = applyEvent(s0, tools([endWith('nope', 'Edit', { isError: true, toolDenialKind: 'hook' })]));
  assert.equal(s1, s0);
});

test('an MCP failure still lands on its own station, never on Hooks', () => {
  let s = applyEvent(createState(), mcp([{ phase: 'start', id: 'm1', server: 'srv', tool: 'go', at: 1 }]));
  s = applyEvent(s, mcp([{ phase: 'end', id: 'm1', server: 'srv', tool: 'go', at: 2, ok: false, content: 'PreToolUse:x' }]));
  assert.equal(tab(s).stations.mcp.errors, 1);
  assert.equal(tab(s).stations.hooks.errors, 0);
});
