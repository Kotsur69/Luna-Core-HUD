// ============================================================================
// LunaCore - notification hub N5: the remaining sources + OS toasts
// ----------------------------------------------------------------------------
// docs/tbc_docs/NOTIFICATION_HUB_PLAN.md N5. Each new collector (mail needs-call,
// cloud, Google, host setup, manual to-dos, weekly review, worker approval)
// with empty / broken / normal input, the readers wired through
// registerHubIpc, and the toast rule (once per new Needs-you item, only
// unfocused, only with both opt-ins).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../src/hubcollect.js');
const { mergeItems } = require('../src/hub.js');
const { registerHubIpc } = require('../src/hubipc.js');

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const BROKEN = [undefined, null, 42, 'x', [], { now: NOW }, { now: 'soon' }];

/** Every item survives the hub's own boundary cleaning unchanged in id and kind. */
function clean(items) {
  const merged = mergeItems([items], { now: NOW }).items;
  assert.deepEqual(merged.map((i) => i.id).sort(), items.map((i) => i.id).sort(), 'all items pass cleanItem');
  return merged;
}

const neverThrows = (fn) => {
  for (const bad of BROKEN) assert.deepEqual(fn(bad), [], JSON.stringify(bad));
};

test('mail: one needs item per scan with threads waiting, none otherwise', () => {
  neverThrows(c.collectMail);
  assert.deepEqual(c.collectMail({ mail: null }), []);
  assert.deepEqual(c.collectMail({ mail: { needsCall: 0, at: NOW } }), []);
  assert.deepEqual(c.collectMail({ mail: { needsCall: 2, at: 'x' } }), []);
  const [item] = clean(c.collectMail({ mail: { needsCall: 3, at: NOW } }));
  assert.equal(item.id, `mail:needscall:${NOW}`);
  assert.equal(item.kind, 'needs');
  assert.equal(item.vars.count, 3);
  assert.deepEqual(item.primary, { action: 'openMission' });
});

test('cloud: logged out, a lasting error; nothing without a cloud or in the grace window', () => {
  neverThrows(c.collectCloud);
  assert.deepEqual(c.collectCloud({ cloud: { configured: false, loggedIn: false }, now: NOW }), [], 'no cloud configured');
  assert.deepEqual(c.collectCloud({ cloud: { loggedIn: true, error: null }, now: NOW }), []);
  const [out] = clean(c.collectCloud({ cloud: { configured: true, loggedIn: false }, now: NOW }));
  assert.match(out.id, /^cloud:loggedout:\d{4}-\d{2}-\d{2}$/, 'per day: a synced done mark snoozes it until tomorrow, not for 30 days');
  assert.notEqual(clean(c.collectCloud({ cloud: { loggedIn: false }, now: NOW + DAY }))[0].id, out.id);
  assert.deepEqual(out.primary, { action: 'openSettings', arg: 'setup-center' });
  const fresh = { loggedIn: true, error: 'push-failed', lastSync: NOW - 60 * 1000 };
  assert.deepEqual(c.collectCloud({ cloud: fresh, now: NOW }), [], 'one failed poll is noise');
  const lasting = { loggedIn: true, error: 'push-failed', lastSync: NOW - c.CLOUD_ERROR_GRACE_MS - 1 };
  const [err] = clean(c.collectCloud({ cloud: lasting, now: NOW }));
  assert.equal(err.id, `cloud:error:${lasting.lastSync}`);
  assert.ok(!JSON.stringify(err).includes('push-failed'), 'the error text never travels');
  assert.deepEqual(c.collectCloud({ cloud: { loggedIn: true, error: 'failed', lastSync: null }, now: NOW }), [], 'never synced (offline launch): no telling how long, so no item');
});

test('google: a set-up client whose grant is gone; nothing when not set up', () => {
  neverThrows(c.collectGoogle);
  assert.deepEqual(c.collectGoogle({ google: { configured: false, connected: false }, now: NOW }), []);
  assert.deepEqual(c.collectGoogle({ google: { configured: true, connected: true }, now: NOW }), []);
  const [item] = clean(c.collectGoogle({ google: { configured: true, connected: false }, now: NOW }));
  assert.match(item.id, /^google:disconnected:\d{4}-\d{2}-\d{2}$/);
  assert.equal(item.kind, 'needs');
});

test('host: host mode on and not ready; off or ready is nothing', () => {
  neverThrows(c.collectHost);
  assert.deepEqual(c.collectHost({ host: null, now: NOW }), [], 'host mode off');
  assert.deepEqual(c.collectHost({ host: { on: true, state: 'ready' }, now: NOW }), []);
  assert.deepEqual(c.collectHost({ host: { on: true, state: 'bogus' }, now: NOW }), []);
  const [item] = clean(c.collectHost({ host: { on: true, state: 'pair' }, now: NOW }));
  assert.match(item.id, /^host:setup:pair:\d{4}-\d{2}-\d{2}$/);
  assert.equal(item.local, true);
});

test('todo: one info count of open manual cards across every project', () => {
  neverThrows(c.collectTodo);
  assert.deepEqual(c.collectTodo({ store: {}, now: NOW }), []);
  const store = {
    p1: [{ text: 'a', manual: true }, { text: 'b', manual: true, done: true }, { text: 'c' }],
    p2: [{ text: 'd', manual: true }, null, 'junk'],
    p3: 'not a list',
  };
  const [item] = clean(c.collectTodo({ store, now: NOW }));
  assert.equal(item.id, 'todo:manual:2');
  assert.equal(item.kind, 'info', 'info: no badge (plan Answer 2)');
  assert.equal(item.vars.count, 2);
});

test('weekly: the newest review while fresh, as a brief; a failed or stale one is nothing', () => {
  neverThrows(c.collectWeekly);
  assert.deepEqual(c.collectWeekly({ weekly: { weeks: {} }, now: NOW }), []);
  const weeks = { '2026-W43': { at: NOW - 8 * DAY, review: {} }, '2026-W44': { at: NOW - DAY, review: { headline: 'x' } }, bogus: { at: NOW, review: {} } };
  const [item] = clean(c.collectWeekly({ weekly: { weeks }, now: NOW }));
  assert.equal(item.id, 'life:weekly:2026-W44');
  assert.equal(item.kind, 'brief');
  assert.deepEqual(item.primary, { action: 'openLife', arg: 'week' });
  assert.deepEqual(c.collectWeekly({ weekly: { weeks: { '2026-W44': { at: NOW - DAY, review: null } } }, now: NOW }), [], 'failed review');
  assert.deepEqual(c.collectWeekly({ weekly: { weeks: { '2026-W44': { at: NOW - c.WEEKLY_READY_MS - 1, review: {} } } }, now: NOW }), [], 'stale');
});

test('approval: stalled needsApproval workers of every run, jump to the tab', () => {
  neverThrows(c.collectApproval);
  const views = [
    { projectId: 'alpha', view: { id: 'p1abc', packages: [
      { id: 'pkg-a', title: 'Add login', state: 'stalled', error: 'needsApproval', sessionId: 's4', startedAt: NOW - 1000 },
      { id: 'pkg-b', title: 'Other', state: 'stalled', error: 'verifyFailed', sessionId: 's5' },
      { id: 'pkg-c', title: 'No tab', state: 'stalled', error: 'needsApproval', sessionId: null },
      { id: 'pkg-d', title: 'Bad tab', state: 'stalled', error: 'needsApproval', sessionId: 'x y' },
    ] } },
    { projectId: 'beta', view: null },
    { projectId: 'gamma', view: { id: 'BAD ID', packages: [{ id: 'z', state: 'stalled', error: 'needsApproval', sessionId: 's9' }] } },
    'junk',
  ];
  const items = clean(c.collectApproval({ views, now: NOW }));
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'approval:p1abc:pkg-a');
  assert.deepEqual(items[0].primary, { action: 'openTab', arg: 's4' });
  assert.equal(items[0].vars.name, 'Add login');
});

test('registerHubIpc wires the new sources; a throwing getter yields nothing', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  registerHubIpc({
    ipcMain,
    send: () => {},
    doneFile: () => null,
    seenFile: () => null,
    runsDir: () => null,
    accounts: {
      mail: () => ({ needsCall: 2, at: NOW }),
      cloud: () => { throw new Error('cloud broke'); },
      google: () => ({ configured: true, connected: false }),
      hostOn: () => false,
    },
    readers: {
      checkin: () => ({}),
      goals: () => ({}),
      bills: () => ({}),
      todo: () => ({ store: { p: [{ text: 'x', manual: true }] } }),
      weekly: () => ({ weekly: null }),
    },
    autoStart: false,
  });
  const res = await handlers.get('hub:list')();
  const ids = res.items.map((i) => i.id);
  assert.ok(ids.includes(`mail:needscall:${NOW}`));
  assert.ok(ids.some((id) => id.startsWith('google:disconnected:')));
  assert.ok(ids.includes('todo:manual:1'));
  assert.ok(!ids.some((id) => id.startsWith('cloud:') || id.startsWith('host:')));
});

// --- OS toasts ----------------------------------------------------------------

test('toastPlan: the first view is a baseline, then once per new needs item', async () => {
  const { toastPlan, MAX_TOASTS_PER_VIEW } = await import('../src/renderer/modules/hubrules.js');
  const on = { enabled: true, hubToasts: true, focused: false };
  const a = { id: 'life:a', kind: 'needs' };
  const b = { id: 'life:b', kind: 'needs' };
  const info = { id: 'update:1', kind: 'info' };
  let plan = toastPlan({ known: null, items: [a, info], ...on });
  assert.deepEqual(plan.toast, [], 'launch baseline: nothing toasts');
  plan = toastPlan({ known: plan.known, items: [a, b, info], ...on });
  assert.deepEqual(plan.toast.map((i) => i.id), ['life:b'], 'only the new needs item');
  plan = toastPlan({ known: plan.known, items: [a, b], ...on });
  assert.deepEqual(plan.toast, [], 'never twice');
  plan = toastPlan({ known: plan.known, items: [b], ...on });
  plan = toastPlan({ known: plan.known, items: [a, b], ...on });
  assert.deepEqual(plan.toast, [], 'a returning item does not toast again');
  const burst = Array.from({ length: 10 }, (_, i) => ({ id: `godmode:r:needs:${i}`, kind: 'needs' }));
  assert.equal(toastPlan({ known: plan.known, items: burst, ...on }).toast.length, MAX_TOASTS_PER_VIEW);
});

test('toastPlan respects the notify opt-in, the hub switch and focus', async () => {
  const { toastPlan } = await import('../src/renderer/modules/hubrules.js');
  const known = new Set();
  const items = [{ id: 'life:new', kind: 'needs' }];
  assert.deepEqual(toastPlan({ known, items, enabled: false, hubToasts: true, focused: false }).toast, [], 'notify.js opt-in off');
  assert.deepEqual(toastPlan({ known, items, enabled: true, hubToasts: false, focused: false }).toast, [], 'hub toasts off');
  const focused = toastPlan({ known, items, enabled: true, hubToasts: true, focused: true });
  assert.deepEqual(focused.toast, [], 'window focused');
  assert.ok(focused.known.has('life:new'), 'seen while focused: no toast later either');
  assert.equal(toastPlan({ known, items, enabled: true, hubToasts: true, focused: false }).toast.length, 1);
});

test('toasts go through notify.js (its opt-in) and open the drawer', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'modules', 'hubtoast.js'), 'utf8');
  assert.ok(src.includes("from './notify.js'") && src.includes('isNotifyEnabled()'));
  assert.ok(src.includes('openHub()'), 'the click opens the drawer');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'modules', 'hubicon.js'), 'utf8').includes('wireHubToasts()'));
});

// --- N8: the old '!' inbox folded into the hub --------------------------------

test('gmail: a needs item while the report-email grant is missing, nothing otherwise', () => {
  neverThrows(c.collectGmail);
  assert.deepEqual(c.collectGmail({ gmail: null, now: NOW }), [], 'unknown status = nothing');
  assert.deepEqual(c.collectGmail({ gmail: { configured: true, connected: true }, now: NOW }), []);
  assert.deepEqual(c.collectGmail({ gmail: { configured: true }, now: NOW }), [], 'connected must be an explicit false');
  assert.deepEqual(c.collectGmail({ gmail: { configured: true, connected: false }, now: 'x' }), []);
  const [item] = clean(c.collectGmail({ gmail: { configured: true, connected: false, address: 'someone@example.com' }, now: NOW }));
  assert.equal(item.kind, 'needs');
  assert.equal(item.source, 'gmail');
  assert.match(item.id, /^gmail:disconnected:\d{4}-\d{2}-\d{2}$/, 'day-keyed: Mark done snoozes it until tomorrow');
  assert.deepEqual(item.primary, { action: 'openSettings', arg: 'mail-section' }, 'Settings -> Report emails');
  assert.equal(item.detailKey, 'hub.item.gmailOffDetail');
  assert.ok(!JSON.stringify(item).includes('someone@'), 'the address never travels');
  const [noClient] = c.collectGmail({ gmail: { configured: false, connected: false }, now: NOW });
  assert.equal(noClient.detailKey, 'hub.item.gmailNoClient');
});

test('gmail: in the accounts group, wired through registerHubIpc, and its anchor exists', async () => {
  const { HUB_SOURCE_GROUPS, isCollectorOn } = require('../src/hubsources.js');
  assert.ok(HUB_SOURCE_GROUPS.accounts.includes('gmail'));
  assert.equal(isCollectorOn('gmail', { accounts: false }), false);
  const handlers = new Map();
  registerHubIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    send: () => {},
    doneFile: () => null,
    seenFile: () => null,
    runsDir: () => null,
    update: () => null,
    accounts: { gmail: () => ({ configured: true, connected: false }) },
    prefs: { readPrefs: () => ({}), writePrefs: () => ({}), file: () => null },
    readers: { checkin: () => ({}), goals: () => ({}), bills: () => ({}), todo: () => ({}), weekly: () => ({}), host: () => ({}) },
    now: () => NOW,
    autoStart: false,
  });
  const { items } = await handlers.get('hub:list')();
  assert.ok(items.some((i) => i.source === 'gmail' && i.kind === 'needs'));
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('id="mail-section"'), 'openSettings lands on the Report emails heading');
});

test('summaryAction: openRunSummary with a validated <machine>:<runId> arg', () => {
  assert.deepEqual(c.summaryAction('KT-PC', 'p1abc'), { action: 'openRunSummary', arg: 'KT-PC:p1abc' });
  for (const [m, id] of [[null, 'p1abc'], ['KT PC', 'p1abc'], ['KT-PC', 'P1ABC'], ['KT-PC', '../x'], ['KT-PC', ''], ['', 'p1abc'], ['a'.repeat(64), 'p1abc'], ['KT-PC:x', 'p1abc']]) {
    assert.equal(c.summaryAction(m, id), undefined, `${m} ${id}`);
  }
});

test('local godmode: the run item opens its summary, each line still opens the report', () => {
  const report = ['# God Mode', '', '- Repo: `C:\\r\\Repo`', '- Result: 2 of 2 packages pushed', '', '## Needs you', '', '- merge by hand', '', '## Manual actions', '', 'None.'].join('\n');
  const items = clean(c.collectGodmode({ runs: [{ id: 'p1abc', mtime: NOW - DAY, text: report }], machine: 'HOME-PC', now: NOW }));
  const run = items.find((i) => i.id === 'godmode:p1abc');
  assert.deepEqual(run.primary, { action: 'openRunSummary', arg: 'HOME-PC:p1abc' });
  const lines = items.filter((i) => i.id !== 'godmode:p1abc');
  assert.ok(lines.length > 0 && lines.every((i) => i.primary.action === 'openReport' && i.primary.arg === 'p1abc'));
  // No usable machine name: the run item falls back to the local report.
  const bare = c.collectGodmode({ runs: [{ id: 'p1abc', mtime: NOW - DAY, text: report }], machine: 'bad name', now: NOW });
  assert.deepEqual(bare.find((i) => i.id === 'godmode:p1abc').primary, { action: 'openReport', arg: 'p1abc' });
});

test('hub boundary: openRunSummary needs a <machine>:<runId> arg', () => {
  const base = { id: 'godmode:p1abc', kind: 'info', source: 'godmode', title: 'Run', at: NOW };
  const keep = (primary) => mergeItems([[{ ...base, primary }]], { now: NOW }).items[0].primary;
  assert.deepEqual(keep({ action: 'openRunSummary', arg: 'PC1:p1abc' }), { action: 'openRunSummary', arg: 'PC1:p1abc' });
  for (const arg of [undefined, 'p1abc', 'PC1:P1ABC', 'PC 1:p1abc', 'PC1:p1abc:extra', 'https://x', 42]) {
    assert.equal(keep({ action: 'openRunSummary', arg }), undefined, String(arg));
  }
});
