// ============================================================================
// Live map, Luna's Work tab: the loop model (src/renderer/modules/
// lunasworkMapModel.js) and the loop view's pure geometry
// ----------------------------------------------------------------------------
// Phase -> station mapping for every real phase, the status' own role
// winning over the phase, unknown phases (-> 'other', never thrown on), no
// run, malformed input of any shape, a stale dashboard, verdict / cards /
// wheel / queue, the lunaswork:event fold, and the pl / en strings the tab
// builds at runtime.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const M = require('../src/renderer/modules/lunasworkMapModel.js');
const V = require('../src/renderer/modules/lunasworkMapView.js');

const RUN = 'run7abc';
const ALL_PHASES = ['preprod', 'directing', 'building', 'launching', 'playtesting', 'critiquing', 'handed', 'done'];

const status = (over = {}) => ({ active: true, runId: RUN, projectId: 'demo', iteration: 3, phase: 'building', role: 'builder', ...over });
const model = (input) => M.buildLoopModel(input);
const statesOf = (m) => Object.fromEntries(m.roles.map((r) => [r.key, r.state]));

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// --- phase -> station -----------------------------------------------------------

test('phaseInfo maps every loop phase to its station', () => {
  assert.deepEqual(M.phaseInfo('directing'), { stage: 'loop', role: 'director', phase: 'directing' });
  assert.deepEqual(M.phaseInfo('building'), { stage: 'loop', role: 'build', phase: 'building' });
  assert.deepEqual(M.phaseInfo('launching'), { stage: 'loop', role: 'playtester', phase: 'launching' });
  assert.deepEqual(M.phaseInfo('playtesting'), { stage: 'loop', role: 'playtester', phase: 'playtesting' });
  assert.deepEqual(M.phaseInfo('critiquing'), { stage: 'loop', role: 'critic', phase: 'critiquing' });
});

test('phaseInfo puts preprod / handed / done outside the loop and no phase at none', () => {
  for (const phase of ['preprod', 'handed', 'done']) assert.deepEqual(M.phaseInfo(phase), { stage: phase, role: null, phase });
  for (const phase of [null, undefined, '']) assert.deepEqual(M.phaseInfo(phase), { stage: 'none', role: null, phase: null });
});

test('phaseInfo turns any unknown phase into other, prototype names included', () => {
  for (const phase of ['researching', 'BUILDING', 'toString', 'constructor', '__proto__', 42, {}, [], true]) {
    assert.deepEqual(M.phaseInfo(phase), { stage: 'other', role: 'other', phase: 'other' }, String(phase));
  }
});

test('a running run lights the station of its phase; earlier ones are done, later ones next', () => {
  const cases = [
    ['directing', 'director', { director: 'active', build: 'pending', playtester: 'pending', critic: 'pending' }],
    ['building', 'build', { director: 'done', build: 'active', playtester: 'pending', critic: 'pending' }],
    ['launching', 'playtester', { director: 'done', build: 'done', playtester: 'active', critic: 'pending' }],
    ['playtesting', 'playtester', { director: 'done', build: 'done', playtester: 'active', critic: 'pending' }],
    ['critiquing', 'critic', { director: 'done', build: 'done', playtester: 'done', critic: 'active' }],
  ];
  for (const [phase, role, states] of cases) {
    const m = model({ status: status({ phase, role: undefined }) });
    assert.equal(m.activeRole, role, phase);
    assert.deepEqual(statesOf(m), states, phase);
    assert.equal(m.stage, 'loop');
    assert.equal(m.phase, phase);
  }
});

test('the status role wins over the phase when it names a station', () => {
  assert.equal(model({ status: status({ phase: 'critiquing', role: 'reviewer' }) }).activeRole, 'critic');
  assert.equal(model({ status: status({ phase: 'building', role: 'builder' }) }).activeRole, 'build');
  assert.equal(model({ status: status({ phase: 'launching', role: 'playtester' }) }).activeRole, 'playtester');
  // A role with no station (or junk) falls back to the phase.
  assert.equal(model({ status: status({ phase: 'directing', role: 'researcher' }) }).activeRole, 'director');
  assert.equal(model({ status: status({ phase: 'directing', role: 'hasOwnProperty' }) }).activeRole, 'director');
  // The role only counts inside the loop.
  assert.equal(model({ status: status({ phase: 'preprod', role: 'director' }) }).activeRole, null);
  assert.equal(M.stationOfRole('builder'), 'build');
  assert.equal(M.stationOfRole('toString'), null);
});

test('an unknown phase in a running run is other: no station lit, nothing thrown', () => {
  const m = model({ status: status({ phase: 'teleporting', role: undefined }) });
  assert.equal(m.empty, false);
  assert.equal(m.stage, 'other');
  assert.equal(m.phase, 'other');
  assert.equal(m.activeRole, 'other');
  assert.deepEqual(m.roles.map((r) => r.state), ['idle', 'idle', 'idle', 'idle']);
});

test('outside the loop and in a stopped run no station is active', () => {
  for (const phase of ['preprod', 'handed', 'done']) {
    const m = model({ status: status({ phase, role: undefined }) });
    assert.equal(m.activeRole, null, phase);
    assert.ok(m.roles.every((r) => r.state === 'idle'), phase);
  }
  const stopped = model({ status: status({ active: false, phase: 'building' }) });
  assert.equal(stopped.activeRole, null);
  assert.equal(stopped.active, false);
  assert.equal(stopped.empty, false);
});

// --- no run, malformed input ----------------------------------------------------------

test('no run gives the empty model with four idle stations', () => {
  for (const input of [undefined, {}, { status: { active: false } }, { status: {}, dashboard: null, queue: [] }]) {
    const m = model(input);
    assert.equal(m.empty, true);
    assert.equal(m.runId, null);
    assert.equal(m.stage, 'none');
    assert.equal(m.activeRole, null);
    assert.equal(m.verdict, null);
    assert.equal(m.handedOver, 'no');
    assert.equal(m.iteration, 0);
    assert.deepEqual(m.roles.map((r) => [r.key, r.state, r.lastResult]), M.LOOP_ROLES.map((k) => [k, 'idle', null]));
  }
  // The queue still shows without a run.
  assert.deepEqual(model({ queue: [{ projectId: 'next', label: 'Next' }] }).queue, [{ projectId: 'next', label: 'Next' }]);
});

test('malformed input of any shape never throws and gives a well-formed model', () => {
  const inputs = [
    null, 'x', 42, [], true,
    { status: 'x' }, { status: [1, 2] }, { status: null, dashboard: 'x', queue: 7 },
    { status: { runId: 'BAD ID!', active: true, phase: 'building' } },
    { status: { runId: RUN, active: 'yes', phase: {}, iteration: -1, stepFailures: 'x', waitUntil: 'soon', verdict: 'win' } },
    { status: { runId: RUN, active: true, phase: 'building', stepFailures: { count: 'two' }, waitUntil: -5 } },
    { dashboard: { runId: RUN, timeline: 'x', cards: 'x' } },
    { dashboard: { runId: RUN, timeline: [null, 'x', 3, { n: '1' }, { n: 2.5 }], cards: { opened: -1, closed: 1.5 } } },
    { status: status(), dashboard: { runId: RUN, timeline: [{ n: 1, cardsOpened: 'x', score: 'high', verdict: 9, playtestOk: 'y' }] } },
    { queue: 'x' }, { queue: [null, { projectId: 5 }, { projectId: '' }, 'demo'] },
    { status: { runId: RUN, projectId: { x: 1 }, milestone: ['m'], iteration: 2 ** 60 } },
  ];
  for (const input of inputs) {
    let m;
    assert.doesNotThrow(() => { m = model(input); }, JSON.stringify(input));
    assert.equal(m.roles.length, 4);
    assert.ok(m.roles.every((r) => M.ROLE_STATES.includes(r.state)));
    assert.ok(Number.isSafeInteger(m.iteration) && m.iteration >= 0);
    assert.ok(Number.isSafeInteger(m.cardsCreated) && m.cardsCreated >= 0);
    assert.ok(Array.isArray(m.queue));
    assert.ok(['no', 'requested', 'handed'].includes(m.handedOver));
    assert.ok(m.project === null || typeof m.project === 'string');
  }
  assert.equal(model({ status: { runId: 'BAD ID!', active: true } }).empty, true, 'a bad run id is no run');
});

test('the model never mutates its input', () => {
  const input = deepFreeze({
    status: status({ waitUntil: 2e12, stepFailures: { count: 1, max: 3 } }),
    dashboard: { runId: RUN, timeline: [{ n: 2, verdict: 'continue' }, { n: 1, verdict: 'ship' }], cards: { opened: 4, closed: 2 } },
    queue: [{ projectId: 'b', label: 'B' }],
  });
  assert.doesNotThrow(() => model(input));
  assert.doesNotThrow(() => M.applyLunasworkEvent(input, { type: 'phase', status: status({ phase: 'critiquing' }) }));
});

// --- dashboard, verdict, cards, wheel, queue ----------------------------------------------------

test('a dashboard of another run is ignored', () => {
  const m = model({
    status: status(),
    dashboard: { runId: 'oldrun', timeline: [{ n: 9, verdict: 'ship', cardsOpened: 5 }], cards: { opened: 40, closed: 30 }, verdict: 'ship' },
  });
  assert.equal(m.runId, RUN);
  assert.equal(m.cardsCreated, 0);
  assert.equal(m.verdict, null);
  assert.equal(m.lastIteration, null);
});

test('without a run in the status the dashboard describes the run', () => {
  const m = model({
    status: { active: false },
    dashboard: { runId: RUN, projectId: 'demo', active: false, phase: 'done', iteration: 5, milestone: 'M2', verdict: 'plateau', timeline: [], cards: { opened: 7, closed: 6 } },
  });
  assert.equal(m.empty, false);
  assert.equal(m.project, 'demo');
  assert.equal(m.iteration, 5);
  assert.equal(m.stage, 'done');
  assert.equal(m.milestone, 'M2');
  assert.deepEqual(m.verdict, { key: 'plateau', final: true });
  assert.equal(m.cardsCreated, 7);
});

test('each station shows what it did in the last finished iteration', () => {
  const dashboard = {
    runId: RUN,
    timeline: [
      { n: 3, cardsOpened: 4, cardsClosed: 3, playtestOk: false, verdict: 'ship', shipAgrees: false, score: 7.5 },
      { n: 1, cardsOpened: 9, playtestOk: true, verdict: 'ship' },
    ],
  };
  const m = model({ status: status(), dashboard });
  assert.equal(m.lastIteration, 3);
  const results = Object.fromEntries(m.roles.map((r) => [r.key, r.lastResult]));
  assert.deepEqual(results.director, { key: 'cards', tone: 'dim', n: 4 });
  assert.deepEqual(results.build, { key: 'closed', tone: 'good', n: 3 });
  assert.deepEqual(results.playtester, { key: 'playtestFailed', tone: 'bad' });
  assert.deepEqual(results.critic, { key: 'shipRefused', tone: 'warn', score: 7.5 });
});

test('the build result names the worst thing that happened', () => {
  assert.equal(M.lastResultOf('build', { buildFailed: true, rolledBack: true }).key, 'buildFailed');
  assert.equal(M.lastResultOf('build', { rolledBack: true, selfCheck: 'red' }).key, 'rolledBack');
  assert.equal(M.lastResultOf('build', { selfCheck: 'red' }).key, 'red');
  assert.equal(M.lastResultOf('build', { skipped: true, cardsClosed: 2 }).key, 'skipped');
  assert.equal(M.lastResultOf('build', {}), null);
  assert.deepEqual(M.lastResultOf('critic', { verdict: 'continue', score: 4 }), { key: 'continue', tone: 'dim', score: 4 });
  assert.deepEqual(M.lastResultOf('critic', { score: 6 }), { key: 'score', tone: 'dim', score: 6 });
  assert.equal(M.lastResultOf('critic', {}), null);
  assert.equal(M.lastResultOf('other', { n: 1 }), null);
  assert.equal(M.lastResultOf('director', null), null);
});

test('the verdict is the final one when there is one, else the last Critic call', () => {
  const row = (r) => ({ runId: RUN, timeline: [{ n: 1, ...r }] });
  assert.deepEqual(model({ status: status({ verdict: 'red' }), dashboard: row({ verdict: 'continue' }) }).verdict, { key: 'red', final: true });
  assert.deepEqual(model({ status: status(), dashboard: { ...row({}), verdict: 'stop' } }).verdict, { key: 'stop', final: true });
  assert.deepEqual(model({ status: status(), dashboard: row({ verdict: 'ship' }) }).verdict, { key: 'shipProposed', final: false });
  assert.deepEqual(model({ status: status(), dashboard: row({ verdict: 'ship', shipAgrees: false }) }).verdict, { key: 'shipRefused', final: false });
  assert.deepEqual(model({ status: status(), dashboard: row({ verdict: 'continue' }) }).verdict, { key: 'continue', final: false });
  assert.equal(model({ status: status() }).verdict, null);
});

test('cards come from the dashboard totals, else from the timeline sum', () => {
  const tl = [{ n: 1, cardsOpened: 2, cardsClosed: 1 }, { n: 2, cardsOpened: 3, cardsClosed: 3 }];
  const summed = model({ status: status(), dashboard: { runId: RUN, timeline: tl } });
  assert.equal(summed.cardsCreated, 5);
  assert.equal(summed.cardsClosed, 4);
  const totals = model({ status: status(), dashboard: { runId: RUN, timeline: tl, cards: { opened: 11, closed: 8 } } });
  assert.equal(totals.cardsCreated, 11);
  assert.equal(totals.cardsClosed, 8);
});

test('the wheel: requested, handed (by the wheel or the phase) or still with Luna', () => {
  assert.equal(model({ status: status({ wheel: 'requested' }) }).handedOver, 'requested');
  assert.equal(model({ status: status({ wheel: 'handed' }) }).handedOver, 'handed');
  assert.equal(model({ status: status({ phase: 'handed', wheel: 'running' }) }).handedOver, 'handed');
  assert.equal(model({ status: status({ wheel: 'running' }) }).handedOver, 'no');
});

test('the queue keeps valid entries only, labels them and stops at the cap', () => {
  const queue = [{ projectId: 'a', label: 'Alpha' }, { projectId: 'b' }, null, { label: 'no id' }, { projectId: 'c', label: '' }];
  assert.deepEqual(M.queueOf(queue), [{ projectId: 'a', label: 'Alpha' }, { projectId: 'b', label: 'b' }, { projectId: 'c', label: 'c' }]);
  const long = Array.from({ length: M.MAX_QUEUE + 5 }, (_, i) => ({ projectId: `p${i}` }));
  assert.equal(M.queueOf(long).length, M.MAX_QUEUE);
  assert.deepEqual(M.queueOf('x'), []);
});

test('a wait or a retried step marks the active station instead of active', () => {
  const waiting = model({ status: status({ waitUntil: 2e12, waitReason: 'usage limit' }) });
  assert.equal(statesOf(waiting).build, 'waiting');
  assert.deepEqual(waiting.waiting, { until: 2e12, reason: 'usage limit' });
  const retrying = model({ status: status({ stepFailures: { count: 2, max: 3 } }) });
  assert.equal(statesOf(retrying).build, 'retrying');
  assert.deepEqual(retrying.retrying, { count: 2, max: 3 });
  // Zero failures is no retry.
  assert.equal(model({ status: status({ stepFailures: { count: 0, max: 3 } }) }).retrying, null);
  assert.equal(model({ status: status({ stopRequested: true }) }).stopRequested, true);
});

test('the second opinion appears only with an explicit mark', () => {
  assert.deepEqual(model({ status: status() }).roles.map((r) => r.key), M.LOOP_ROLES);
  const marked = model({ status: status({ phase: 'critiquing', role: undefined }), dashboard: { runId: RUN, timeline: [{ n: 1, secondOpinion: { agrees: false } }] } });
  assert.deepEqual(marked.roles.map((r) => r.key), [...M.LOOP_ROLES, M.SECOND_OPINION]);
  assert.equal(statesOf(marked)[M.SECOND_OPINION], 'pending');
  assert.deepEqual(marked.roles[4].lastResult, { key: 'disagrees', tone: 'warn' });
  assert.equal(model({ status: status({ secondOpinion: true }) }).roles.length, 5);
  assert.equal(model({ status: status({ secondOpinion: 'yes' }) }).roles.length, 4);
});

// --- lunaswork:event ---------------------------------------------------------------

test('a run event replaces the status; anything else leaves the same input', () => {
  const input = { status: status(), dashboard: { runId: RUN }, queue: [] };
  for (const type of ['phase', 'wait', 'resume', 'stopping', 'decision', 'wheel']) {
    const next = M.applyLunasworkEvent(input, { type, status: status({ phase: 'critiquing' }) });
    assert.notEqual(next, input, type);
    assert.equal(next.status.phase, 'critiquing');
    assert.equal(next.dashboard, input.dashboard);
    assert.equal(input.status.phase, 'building', 'the old input is untouched');
  }
  for (const event of [{ type: 'playtestOnce', stage: 'start', projectId: 'demo' }, { type: 'phase' }, { type: 'phase', status: 'x' }, null, 'phase', { type: 'toString', status: {} }]) {
    assert.equal(M.applyLunasworkEvent(input, event), input, JSON.stringify(event));
  }
  assert.deepEqual(M.applyLunasworkEvent(null, { type: 'phase', status: { runId: RUN } }), { status: { runId: RUN } });
});

// --- the view's geometry -------------------------------------------------------------

test('loopArc runs clockwise between two stations and stays clear of both discs', () => {
  const r = V.LOOP_R;
  const cx = V.LOOP_CENTER.x;
  const cy = V.LOOP_CENTER.y;
  const at = (deg) => ({ x: cx + r * Math.cos((deg * Math.PI) / 180), y: cy + r * Math.sin((deg * Math.PI) / 180) });
  for (const [from, to] of [[-90, 0], [0, 90], [90, 180], [180, -90]]) {
    const d = V.loopArc(from, to);
    const m = d.match(/^M([\d.-]+),([\d.-]+) A([\d.]+),([\d.]+) 0 ([01]) 1 ([\d.-]+),([\d.-]+)$/);
    assert.ok(m, d);
    const start = { x: Number(m[1]), y: Number(m[2]) };
    const end = { x: Number(m[6]), y: Number(m[7]) };
    assert.equal(m[5], '0', 'a quarter loop is a small arc');
    assert.ok(Math.hypot(start.x - at(from).x, start.y - at(from).y) > V.LOOP_STATION_R, `start clear of ${from}`);
    assert.ok(Math.hypot(end.x - at(to).x, end.y - at(to).y) > V.LOOP_STATION_R, `end clear of ${to}`);
    // Both ends lie on the ring.
    assert.ok(Math.abs(Math.hypot(start.x - cx, start.y - cy) - r) < 0.05);
    assert.ok(Math.abs(Math.hypot(end.x - cx, end.y - cy) - r) < 0.05);
  }
  // One station alone: the arrow goes almost all the way round.
  assert.match(V.loopArc(-90, -90), / 0 1 1 /);
});

test('result labels sit outside the ring, away from the arrows', () => {
  const R = V.LOOP_STATION_R;
  const c = V.LOOP_CENTER;
  const top = V.resultLabelPos({ x: c.x, y: c.y - V.LOOP_R });
  const bottom = V.resultLabelPos({ x: c.x, y: c.y + V.LOOP_R });
  const right = V.resultLabelPos({ x: c.x + V.LOOP_R, y: c.y });
  const left = V.resultLabelPos({ x: c.x - V.LOOP_R, y: c.y });
  assert.ok(top.y < c.y - V.LOOP_R - R && top.anchor === 'middle');
  assert.ok(bottom.y > c.y + V.LOOP_R + R && bottom.anchor === 'middle');
  assert.ok(right.x > c.x + V.LOOP_R + R && right.anchor === 'start');
  assert.ok(left.x < c.x - V.LOOP_R - R && left.anchor === 'end');
  // Everything stays inside the view box.
  assert.ok(top.y > 12 && bottom.y < V.LOOP_VIEW.h);
});

// --- strings ----------------------------------------------------------------------

test('every Luna\'s Work map string exists in pl and en, without Polish diacritics', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/i18n.js'), 'utf8');
  const enAt = src.indexOf('\n  en: {');
  const pl = src.slice(0, enAt);
  const en = src.slice(enAt);
  const keys = new Set();
  for (const file of ['lunasworkMapView.js', 'liveMapLunasWork.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/modules', file), 'utf8');
    for (const m of code.matchAll(/'(lm\.(?:lw|state)\.[A-Za-z0-9_.]+)'/g)) keys.add(m[1]);
  }
  // Built at runtime: station names and states, results, verdicts, the wheel, phases.
  for (const k of [...M.LOOP_ROLES, M.SECOND_OPINION]) keys.add(`lm.lw.role.${k}`);
  for (const s of M.ROLE_STATES) keys.add(`lm.lw.state.${s}`);
  const rows = [
    { cardsOpened: 1, cardsClosed: 1, playtestOk: true, verdict: 'ship', score: 1, secondOpinion: { agrees: true } },
    { buildFailed: true, playtestOk: false, verdict: 'ship', shipAgrees: false, secondOpinion: { agrees: false } },
    { rolledBack: true, verdict: 'continue' }, { selfCheck: 'red', score: 2 }, { skipped: true },
  ];
  for (const row of rows) {
    for (const role of [...M.LOOP_ROLES, M.SECOND_OPINION]) {
      const r = M.lastResultOf(role, row);
      if (r) keys.add(`lm.lw.result.${r.key}`);
    }
    const v = model({ status: status(), dashboard: { runId: RUN, timeline: [{ n: 1, ...row }] } }).verdict;
    if (v && !v.final) keys.add(`lm.lw.verdict.${v.key}`);
  }
  for (const w of ['no', 'requested', 'handed']) keys.add(`lm.lw.wheel.${w}`);
  for (const p of ALL_PHASES) keys.add(`lw.phase.${p}`);
  for (const v of M.FINAL_VERDICTS) keys.add(`lw.verdict.${v}`);
  assert.ok(keys.size >= 60, `found only ${keys.size} keys`);
  for (const key of keys) {
    assert.ok(pl.includes(`'${key}':`), `missing pl: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en: ${key}`);
  }
  for (const line of pl.split('\n').filter((l) => /^\s*'lm\.lw\./.test(l))) assert.doesNotMatch(line, /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, line);
});
