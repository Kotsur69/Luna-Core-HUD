// Phone Host page model (mobile/src/hostmodel.js): host pick, clone URL from a
// repo key, "/name" insertion, the chat built from host_events (text chunks
// joined, tool results attached, approval cards with their decision) and the
// session list across hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickHost, cloneUrl, insertName, pickerNames, chatModel, sessionList, hostList } from '../mobile/src/hostmodel.js';

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-8999-000000000000';
const NOW = 1_800_000_000_000;
const at = (ms) => new Date(ms).toISOString();
const ev = (seq, kind, data, sid = SID, t = NOW) => ({ session_id: sid, seq, host: 'KT-PC', kind, data, at: at(t) });

test('pickHost: current, then default, then online, then first', () => {
  const hosts = [
    { machine: 'A', online: true, default: false },
    { machine: 'B', online: false, default: true },
  ];
  assert.equal(pickHost(hosts, 'A').machine, 'A');
  assert.equal(pickHost(hosts, 'gone').machine, 'B');
  assert.equal(pickHost([{ machine: 'C', online: false }, { machine: 'D', online: true }], '').machine, 'D');
  assert.equal(pickHost([], 'A'), null);
});

test('cloneUrl only for GitHub repo keys', () => {
  assert.equal(cloneUrl('git:github.com/kotsur69/luna-core-hud'), 'https://github.com/kotsur69/luna-core-hud');
  assert.equal(cloneUrl('git:gitlab.com/a/b'), null);
  assert.equal(cloneUrl('local:folder'), null);
  assert.equal(cloneUrl(null), null);
});

test('insertName puts "/name " at the cursor', () => {
  assert.deepEqual(insertName('', 0, 'plan'), { text: '/plan ', cursor: 6 });
  assert.deepEqual(insertName('do it', 5, 'review'), { text: 'do it /review ', cursor: 14 });
  assert.equal(insertName('a b', 2, 'x').text, 'a /x b');
});

test('pickerNames merges skills and commands, unique and sorted', () => {
  assert.deepEqual(pickerNames({ skills: ['b', 'a'], commands: ['a', 'c'] }), ['a', 'b', 'c']);
  assert.deepEqual(pickerNames(null), []);
});

test('chatModel joins text, attaches results, tracks approvals', () => {
  const m = chatModel([
    ev(0, 'status', { status: 'working' }),
    ev(1, 'prompt', { text: 'fix it' }),
    ev(2, 'text', { text: 'Look' }),
    ev(3, 'text', { text: 'ing' }),
    ev(4, 'tool', { id: 't1', name: 'Bash', summary: 'npm test' }),
    ev(5, 'tool_result', { id: 't1', text: 'ok', isError: false, clipped: false }),
    ev(6, 'permission', { requestId: 'r1', tool: 'Edit', summary: 'a.js', preview: '- a\n+ b' }),
    ev(7, 'status', { status: 'waiting' }),
  ]);
  assert.deepEqual(m.items.map((i) => i.type), ['prompt', 'text', 'tool', 'approval']);
  assert.equal(m.items[1].text, 'Looking');
  assert.deepEqual(m.items[2].result, { text: 'ok', isError: false, clipped: false });
  assert.equal(m.items[3].decision, null);
  assert.equal(m.status, 'waiting');
  assert.equal(m.open, true);
  assert.equal(m.lastSeq, 7);
  const after = chatModel([ev(6, 'permission', { requestId: 'r1', tool: 'Edit', summary: '', preview: '' }), ev(8, 'decision', { requestId: 'r1', decision: 'allow' })]);
  assert.equal(after.items[0].decision, 'allow');
  assert.equal(after.open, false);
});

test('chatModel drops junk rows (unknown kinds, html, bad ids)', () => {
  const m = chatModel([ev(0, 'html', { text: '<img onerror=x>' }), { session_id: 'x', seq: 1, kind: 'text', data: { text: 'y' }, at: at(NOW) }, null]);
  assert.deepEqual(m.items, []);
});

test('sessionList: newest status per session, live from the heartbeat', () => {
  const hosts = hostList([{ machine: 'KT-PC', data: { v: 1, at: NOW, repos: [], sessions: [{ id: SID, repoId: 'r', status: 'working' }] }, updated_at: at(NOW) }], NOW);
  const rows = [
    ev(5, 'status', { status: 'done' }, SID, NOW - 1000),
    ev(2, 'status', { status: 'working' }, SID, NOW - 5000),
    ev(9, 'status', { status: 'error' }, SID2, NOW - 9000),
  ];
  const list = sessionList(rows, hosts);
  assert.deepEqual(list.map((s) => [s.sessionId, s.status, s.live]), [[SID, 'done', true], [SID2, 'error', false]]);
});

// ---- Messenger-style chat page: route, menu list, status light ----------------

test('chatHash / chatRoute round-trip and reject anything else', async () => {
  const { chatHash, chatRoute } = await import('../mobile/src/hostmodel.js');
  assert.equal(chatHash('KT-PC-LLM', SID), `#chat/KT-PC-LLM/${SID}`);
  assert.deepEqual(chatRoute(`#chat/KT-PC-LLM/${SID}`), { host: 'KT-PC-LLM', sessionId: SID });
  assert.equal(chatRoute('#host'), null);
  assert.equal(chatRoute(`#chat/bad host/${SID}`), null);
  assert.equal(chatRoute('#chat/KT-PC/not-a-uuid'), null);
  assert.equal(chatRoute(`#chat/KT-PC/${SID}/extra`), null);
  assert.equal(chatRoute(undefined), null);
});

test('menuSessions: live first, then ended ones from the last 24 h, capped', async () => {
  const { menuSessions } = await import('../mobile/src/hostmodel.js');
  const SID3 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const hosts = hostList([{ machine: 'KT-PC', data: { v: 1, at: NOW, repos: [{ id: 'luna', name: 'LunaCore', cloned: true }], sessions: [{ id: SID2, repoId: 'luna', status: 'working' }] }, updated_at: at(NOW) }], NOW);
  const rows = [
    ev(3, 'status', { status: 'done' }, SID, NOW - 60_000),
    ev(1, 'status', { status: 'working' }, SID2, NOW - 3_600_000),
    ev(4, 'status', { status: 'done' }, SID3, NOW - 25 * 3_600_000),
  ];
  const list = menuSessions(rows, hosts, NOW, { [SID]: 'Synthara' });
  assert.deepEqual(list.map((s) => [s.sessionId, s.live, s.label]), [[SID2, true, 'LunaCore'], [SID, false, 'Synthara']]);
  assert.equal(list[0].host, 'KT-PC');
  const many = Array.from({ length: 12 }, (_, i) => ev(i, 'status', { status: 'done' }, `${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`, NOW - i * 1000));
  assert.equal(menuSessions(many, [], NOW, {}).length, 8);
});

test('sessionLight: status -> light class, an ended "working" session is idle', async () => {
  const { sessionLight } = await import('../mobile/src/hostmodel.js');
  assert.equal(sessionLight({ status: 'working', live: true }), 'is-working');
  assert.equal(sessionLight({ status: 'waiting', live: true }), 'is-approval');
  assert.equal(sessionLight({ status: 'error', live: false }), 'is-failed');
  assert.equal(sessionLight({ status: 'done', live: false }), 'is-done');
  assert.equal(sessionLight({ status: 'working', live: false }), 'is-idle');
});

test('sessionList drops sessions whose host is no valid machine name (no dead links)', () => {
  const bad = { ...ev(1, 'status', { status: 'done' }, SID2), host: 'evil/host' };
  const list = sessionList([ev(2, 'status', { status: 'done' }), bad], []);
  assert.deepEqual(list.map((s) => s.sessionId), [SID]);
});
