// ============================================================================
// Luna's Work client feedback widget (src/lunasworkWidget.js, LW 3.28b).
// Covers: the build/inject guard (only a staging deploy ever gets the widget,
// never production), the generated script (text only, safe config, pl + en),
// the per-run token (random, only its hash leaves the machine, extended
// while the run deploys), revoke at run end (local first, retried), and the
// intake into the run as author `client` (screenshot checked, rows taken
// once). The edge function's own checks live in
// test/lunaswork-widget-fn.test.mjs; the controller side in
// test/lunaswork-feedback.test.js.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const W = require('../src/lunasworkWidget');
const S = require('../src/lunasworkSettings');
const F = require('../src/lunasworkFeedback');
const { createStaging } = require('../src/lunasworkStaging');

const STAGING_REF = 'stagingrefabcdefghij';
const STAGING_URL = 'https://staging.example.test';
const ENDPOINT = 'https://stagingrefabcdefghij.supabase.co/functions/v1/lunaswork-feedback';
const REPO = path.resolve(os.tmpdir(), 'lw-widget-repo');
const RUN_ID = 'lwwidget1';
const CLOCK = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const RAW_PROFILE = {
  adapter: 'web',
  startCommand: 'npm start',
  url: 'http://localhost:3000',
  readyTimeoutSec: 60,
  checkCommand: '',
  stagingUrl: STAGING_URL,
  stagingMigrateCommand: `supabase db push --project-ref ${STAGING_REF}`,
  stagingDeployCommand: 'vercel deploy --yes --scope staging',
  stagingBackupCommand: `supabase db dump --project-ref ${STAGING_REF} --data-only -f "%LUNA_BACKUP_DIR%/data.sql"`,
  stagingRestoreCommand: 'psql "%STAGING_DB_URL%" -f "%LUNA_BACKUP_DIR%/data.sql"',
};
const profileWith = (fields = {}) => {
  const res = S.validateProfile({ ...RAW_PROFILE, ...fields });
  assert.ok(res.profile, res.reason);
  return res.profile;
};
const PROFILE = profileWith();

// A real JPEG start (magic bytes), and a "PNG" that is not one.
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`;
const FAKE_PNG = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The Supabase side, in memory: tokens (hash only), rows, revokes. */
function fakeRegistry() {
  const r = { tokens: [], extended: [], revoked: [], rows: [], acked: [], failRevoke: 0, failAck: 0 };
  r.api = {
    register: async (t) => {
      r.tokens.push(t);
    },
    extend: async (t) => {
      r.extended.push(t);
    },
    revoke: async (runId) => {
      if (r.failRevoke > 0) {
        r.failRevoke -= 1;
        throw new Error('offline');
      }
      r.revoked.push(runId);
      r.rows = r.rows.filter((x) => x.run_id !== runId);
    },
    pull: async (runId, limit) => r.rows.filter((x) => x.run_id === runId).slice(0, limit),
    ack: async (ids) => {
      if (r.failAck > 0) {
        r.failAck -= 1;
        throw new Error('offline');
      }
      r.acked.push(...ids);
      r.rows = r.rows.filter((x) => !ids.includes(x.id));
    },
  };
  return r;
}

function setup(t, { endpoint = ENDPOINT, loggedIn = true } = {}) {
  const s = { clock: CLOCK, reg: fakeRegistry(), runsRoot: tmpDir(t, 'lw-widget-runs-'), lines: [] };
  s.widget = W.createWidget({
    registry: () => (loggedIn ? s.reg.api : null),
    endpoint: () => endpoint,
    runsRoot: () => s.runsRoot,
    now: () => s.clock,
    log: (line) => s.lines.push(line),
  });
  s.runDir = path.join(s.runsRoot, `lunaswork-${RUN_ID}`);
  s.state = () => JSON.parse(fs.readFileSync(path.join(s.runDir, 'widget.json'), 'utf8'));
  return s;
}

const run = (profile = PROFILE) => ({ id: RUN_ID, repoPath: REPO, profile });

/** A controller's public side over a real feedback list (createItem's rules). */
function fakeController({ active = true, runId = RUN_ID } = {}) {
  const c = { list: [], calls: [], active, runId };
  c.status = () => ({ active: c.active, runId: c.runId });
  c.feedback = (p) => {
    c.calls.push(p);
    if (!c.active) return { ok: false, reason: 'no-run' };
    const res = F.createItem({ text: p.text, author: p.author, id: p.id }, { now: CLOCK, list: c.list });
    if (!res.ok) return { ok: false, reason: res.error };
    c.list.push(res.item);
    return { ok: true, id: res.item.id };
  };
  return c;
}

const row = (id, fields = {}) => ({ id, run_id: RUN_ID, text: `the button ${id} is too small`, page_url: null, screenshot: null, created_at: new Date(CLOCK + id).toISOString(), ...fields });

// ---- the guard: never production ------------------------------------------------------

test('guard: only a staging deploy qualifies - never a profile without staging or one that points at production', () => {
  assert.equal(W.widgetGuard(PROFILE), null);
  assert.match(W.widgetGuard(S.validateProfile({ startCommand: 'npm start' }).profile), /no staging/);
  assert.match(W.widgetGuard(null), /no staging/);
  assert.match(W.widgetGuard({ ...PROFILE, stagingDeployCommand: undefined }), /no staging deploy command/);
  assert.match(W.widgetGuard(profileWith({ stagingDeployCommand: 'vercel deploy --prod' })), /touches production.*--prod/);
  assert.match(W.widgetGuard(profileWith({ stagingDeployCommand: 'DEPLOY_ENV=production ./deploy.sh' })), /production env/);
  assert.match(W.widgetGuard(profileWith({ stagingDeployCommand: 'netlify deploy --dir dist --site https://prod.example.com' })), /touches production/);
  assert.match(W.widgetGuard(profileWith({ stagingUrl: 'https://app-prod.example.com' })), /looks like production/);
  assert.match(W.widgetGuard(profileWith({ stagingUrl: 'https://production.example.com/app' })), /looks like production/);
  // An install flag is no deploy target (same rule as the staging guard).
  assert.equal(W.widgetGuard(profileWith({ stagingDeployCommand: 'npm ci --production && vercel deploy --yes' })), null);
});

// ---- the script ----------------------------------------------------------------------

test('script: one self-contained file, text only (no innerHTML), config escaped, pl + en strings', () => {
  const token = W.newToken();
  const script = W.widgetScript({ endpoint: ENDPOINT, token, runId: RUN_ID, origin: STAGING_URL });
  assert.doesNotThrow(() => new Function(script), 'valid JavaScript');
  // Pinned to the staging origin: a copy on any other origin never mounts.
  assert.match(script, /if \(location\.origin !== cfg\.origin\) return;/);
  assert.ok(script.includes(`"origin":"${STAGING_URL}"`));
  assert.throws(() => W.widgetScript({ endpoint: ENDPOINT, token, runId: RUN_ID }), /origin/);
  assert.throws(() => W.widgetScript({ endpoint: ENDPOINT, token, runId: RUN_ID, origin: `${STAGING_URL}/app` }), /origin/);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.match(script, /textContent/);
  assert.ok(script.includes(token) && script.includes(ENDPOINT) && script.includes(RUN_ID));
  // No `</script>` can close an inline copy early, and the file is pure ASCII.
  assert.doesNotMatch(script.slice(script.lastIndexOf('})(')), /[<>]/);
  assert.doesNotMatch(script, /[^\x00-\x7f]/);
  // Only origin + path of the page is sent, and no cookies.
  assert.match(script, /location\.origin \+ location\.pathname/);
  assert.match(script, /credentials: 'omit'/);
  for (const lang of ['pl', 'en']) {
    for (const key of Object.keys(W.TEXT.en)) assert.equal(typeof W.TEXT[lang][key], 'string', `${lang}.${key}`);
  }
  assert.equal(W.TEXT.pl.button, 'Opinia');
  assert.throws(() => W.widgetScript({ endpoint: 'http://insecure.example', token, runId: RUN_ID, origin: STAGING_URL }), /https/);
  assert.throws(() => W.widgetScript({ endpoint: ENDPOINT, token: 'short', runId: RUN_ID, origin: STAGING_URL }), /token/);
  assert.throws(() => W.widgetScript({ endpoint: ENDPOINT, token, runId: 'Bad Id', origin: STAGING_URL }), /runId/);
});

test('token: 256 random bits, base64url; Supabase only ever sees its SHA-256 hash', () => {
  const a = W.newToken();
  assert.match(a, W.TOKEN_RE);
  assert.notEqual(a, W.newToken());
  assert.equal(W.newToken(() => Buffer.alloc(32, 1)), Buffer.alloc(32, 1).toString('base64url'));
  assert.match(W.hashToken(a), /^[0-9a-f]{64}$/);
  assert.notEqual(W.hashToken(a), a);
});

// ---- prepare: the inject step ------------------------------------------------------------

test('prepare: token registered as a hash with the staging origin; the script lives outside the repo', async (t) => {
  const s = setup(t);
  const res = await s.widget.prepare(run());
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(Object.keys(res.env), [W.ENV_KEY]);
  assert.equal(res.env[W.ENV_KEY], res.file);
  assert.ok(path.relative(REPO, res.file).startsWith('..'), 'not inside the repo');
  const token = s.state().token;
  assert.match(token, W.TOKEN_RE);
  assert.ok(fs.readFileSync(res.file, 'utf8').includes(token));
  assert.equal(s.reg.tokens.length, 1);
  assert.deepEqual(s.reg.tokens[0], { runId: RUN_ID, tokenHash: W.hashToken(token), origin: STAGING_URL, expiresAt: CLOCK + W.TOKEN_TTL_MS });
  assert.ok(!JSON.stringify(s.reg.tokens).includes(token), 'the token itself never goes to Supabase');

  // The next deploy reuses it; past half its life it is extended, past its end replaced.
  assert.equal((await s.widget.prepare(run())).ok, true);
  assert.equal(s.reg.tokens.length, 1);
  s.clock += W.TOKEN_TTL_MS / 2 + HOUR;
  await s.widget.prepare(run());
  assert.equal(s.reg.extended.length, 1);
  assert.equal(s.state().token, token);
  s.clock += W.TOKEN_TTL_MS + HOUR;
  await s.widget.prepare(run());
  assert.equal(s.reg.tokens.length, 2);
  assert.notEqual(s.state().token, token);
});

test('prepare refuses without a staging deploy, without the cloud, inside the repo, or after the run ended', async (t) => {
  const s = setup(t);
  assert.match((await s.widget.prepare(run(profileWith({ stagingDeployCommand: 'vercel deploy --prod' })))).reason, /production/);
  assert.match((await s.widget.prepare(run(S.validateProfile({ startCommand: 'npm start' }).profile))).reason, /no staging/);
  assert.match((await s.widget.prepare({ ...run(), id: '../x' })).reason, /bad run/);
  assert.match((await setup(t, { loggedIn: false }).widget.prepare(run())).reason, /not logged in/);
  assert.match((await setup(t, { endpoint: 'http://plain.example/fn' }).widget.prepare(run())).reason, /not logged in/);
  assert.match((await s.widget.prepare({ ...run(), repoPath: s.runsRoot })).reason, /inside the repo/);
  assert.equal(s.reg.tokens.length, 0, 'no token for any refused build');

  assert.equal((await s.widget.prepare(run())).ok, true);
  await s.widget.revoke(RUN_ID);
  assert.match((await s.widget.prepare(run())).reason, /revoked/);
  assert.equal(s.reg.tokens.length, 1, 'no new token once the run ended');
});

// ---- the staging deploy step: the widget never reaches a production build -------------

function fakeGit() {
  return async (cwd, args) => {
    if (args[0] === 'rev-parse') return { ok: true, out: HEAD, err: '' };
    if (args[0] === 'rev-list') return { ok: true, out: BASE, err: '' };
    return { ok: true, out: '', err: '' };
  };
}

async function stagedEnvs(t, { profile = PROFILE, widget }) {
  const calls = [];
  const runsRoot = tmpDir(t, 'lw-widget-stage-');
  const staging = createStaging({
    git: fakeGit(),
    runCommand: async (o) => {
      calls.push(o);
      return { ok: true, code: 0, detail: '' };
    },
    runsRoot: () => runsRoot,
    widget,
  });
  const events = [];
  const store = { list: [], read: () => store.list, write: (l) => (store.list = l) && true };
  const res = await staging.applyIteration({
    run: () => ({ id: RUN_ID, iteration: 2, repoPath: REPO, profile, startedAt: CLOCK, history: [], laps: [], decisions: [] }),
    ask: () => ({ ok: false, reason: 'no queue' }),
    logEvent: (text) => events.push(text),
    todoStore: store,
  });
  return { res, calls, events, env: (step) => (calls.find((c) => c.step === step) || {}).env };
}

test('staging: only the deploy step gets $LUNA_FEEDBACK_WIDGET; migrate never does', async (t) => {
  const s = setup(t);
  const { res, env, events } = await stagedEnvs(t, { widget: s.widget });
  assert.equal(res.ok, true);
  assert.equal(env('migrate')[W.ENV_KEY], undefined);
  const file = env('deploy')[W.ENV_KEY];
  assert.ok(path.isAbsolute(file) && fs.existsSync(file));
  assert.ok(events.some((e) => /widget baked/.test(e)));
});

test('staging: a production-pointing deploy runs WITHOUT the widget and no token is made', async (t) => {
  const s = setup(t);
  const prod = profileWith({ stagingDeployCommand: 'vercel deploy --prod --yes' });
  const { calls, events } = await stagedEnvs(t, { profile: prod, widget: s.widget });
  assert.ok(calls.some((c) => c.step === 'deploy'), "Mati's own command still runs");
  for (const c of calls) assert.equal(c.env[W.ENV_KEY], undefined, `${c.step} has no widget`);
  assert.equal(s.reg.tokens.length, 0);
  assert.ok(!fs.existsSync(path.join(s.runDir, 'widget')), 'no script written');
  assert.ok(events.some((e) => /widget left out \(the staging deploy touches production/.test(e)));
});

test('staging: a broken or overreaching widget never breaks the deploy or overrides its env', async (t) => {
  const thrower = {
    prepare: async () => {
      throw new Error('boom');
    },
  };
  const a = await stagedEnvs(t, { widget: thrower });
  assert.equal(a.res.ok, true);
  assert.equal(a.env('deploy')[W.ENV_KEY], undefined);
  const greedy = { prepare: async () => ({ ok: true, env: { [W.ENV_KEY]: path.resolve(os.tmpdir(), 'w.js'), LUNA_RUN_ID: 'evil', PATH: 'x' } }) };
  const b = await stagedEnvs(t, { widget: greedy });
  assert.equal(b.env('deploy').LUNA_RUN_ID, RUN_ID);
  assert.equal(b.env('deploy').PATH, undefined);
  const relative = { prepare: async () => ({ ok: true, env: { [W.ENV_KEY]: 'w.js' } }) };
  assert.equal((await stagedEnvs(t, { widget: relative })).env('deploy')[W.ENV_KEY], undefined);
  // No staging in the profile: nothing runs, so nothing is ever baked.
  const s = setup(t);
  const plain = await stagedEnvs(t, { profile: S.validateProfile({ startCommand: 'npm start' }).profile, widget: s.widget });
  assert.deepEqual(plain.calls, []);
  assert.equal(s.reg.tokens.length, 0);
});

// ---- revoke ------------------------------------------------------------------------------

test('revoke: local first (no new bake), then Supabase with the untaken rows; a failure is retried by the poll', async (t) => {
  const s = setup(t);
  await s.widget.prepare(run());
  s.reg.rows.push(row(1));
  s.reg.failRevoke = 1;
  assert.equal((await s.widget.revoke(RUN_ID)).ok, false);
  assert.equal(s.state().revokedAt, CLOCK);
  assert.equal(s.state().remoteRevoked, false);
  assert.ok(s.lines.some((l) => /not revoked yet/.test(l)));

  // The poll of a finished run tries again.
  assert.equal(await s.widget.deliver(fakeController({ active: false })), 0);
  assert.deepEqual(s.reg.revoked, [RUN_ID]);
  assert.deepEqual(s.reg.rows, [], 'untaken rows of the run are gone');
  assert.equal(s.state().remoteRevoked, true);
  // Idempotent: nothing more is sent.
  await s.widget.revoke(RUN_ID);
  assert.deepEqual(s.reg.revoked, [RUN_ID]);
  // A run that never baked a widget sends nothing.
  assert.deepEqual(await s.widget.revoke('lwother'), { ok: true, revoked: false });
  assert.deepEqual(s.reg.revoked, [RUN_ID]);
});

test('revoke: a failed remote revoke of an older run is retried even after a new run started', async (t) => {
  const s = setup(t);
  await s.widget.prepare(run());
  s.reg.failRevoke = 1;
  assert.equal((await s.widget.revoke(RUN_ID)).ok, false);
  // The next run is active; its poll still finishes the old run's revoke.
  await s.widget.deliver(fakeController({ runId: 'lwnext1' }));
  assert.deepEqual(s.reg.revoked, [RUN_ID]);
  assert.equal(s.state().remoteRevoked, true);
  // Done once: later polls send nothing more.
  await s.widget.deliver(fakeController({ runId: 'lwnext1' }));
  assert.deepEqual(s.reg.revoked, [RUN_ID]);
});

test('revokeOnRunEnd never throws and never waits', async () => {
  const lines = [];
  assert.doesNotThrow(() => W.revokeOnRunEnd(undefined, RUN_ID));
  const syncThrow = {
    revoke: () => {
      throw new Error('sync');
    },
  };
  assert.doesNotThrow(() => W.revokeOnRunEnd(syncThrow, RUN_ID, (l) => lines.push(l)));
  W.revokeOnRunEnd({ revoke: async () => Promise.reject(new Error('async')) }, RUN_ID, (l) => lines.push(l));
  await new Promise((r) => setImmediate(r));
  assert.equal(lines.length, 2);
});

// ---- intake ------------------------------------------------------------------------------

test('deliver: rows become client items with page + screenshot context; taken once, then deleted', async (t) => {
  const s = setup(t);
  await s.widget.prepare(run());
  s.reg.rows.push(row(1, { page_url: 'https://staging.example.test/settings', screenshot: JPEG }), row(2, { screenshot: FAKE_PNG }));
  const ctl = fakeController();
  assert.equal(await s.widget.deliver(ctl), 2);
  assert.deepEqual(ctl.calls.map((c) => [c.author, c.runId, c.id]), [['client', RUN_ID, CLOCK + 1], ['client', RUN_ID, CLOCK + 2]]);
  const shot = path.join(s.runDir, 'client-feedback', '1.jpg');
  assert.equal(ctl.list[0].text, `the button 1 is too small\n[page] https://staging.example.test/settings\n[screenshot] ${shot}`);
  assert.ok(fs.existsSync(shot));
  // Not a real image: no file, no screenshot line.
  assert.equal(ctl.list[1].text, 'the button 2 is too small');
  assert.ok(!fs.existsSync(path.join(s.runDir, 'client-feedback', '2.png')));
  // Context lines reach the card, never triage.
  assert.deepEqual(F.triageText(ctl.list[0].text), [{ type: 'look', text: 'the button 1 is too small' }]);
  assert.deepEqual(s.reg.acked, [1, 2]);
  assert.equal(await s.widget.deliver(ctl), 0);
});

test('deliver: a failed delete never brings a row in twice; ids stay unique; malformed rows are dropped', async (t) => {
  const s = setup(t);
  await s.widget.prepare(run());
  s.reg.rows.push(row(1));
  s.reg.failAck = 1;
  const ctl = fakeController();
  await assert.rejects(s.widget.deliver(ctl), /offline/);
  assert.equal(ctl.list.length, 1);
  assert.equal(await s.widget.deliver(ctl), 0, 'seen: not added again');
  assert.deepEqual(s.reg.acked, [1]);

  // Two rows in the same ms: the second moves on by 1 ms.
  const same = new Date(CLOCK + 100).toISOString();
  s.reg.rows.push(row(5, { created_at: same }), row(6, { created_at: same }));
  await s.widget.deliver(ctl);
  assert.deepEqual(ctl.list.map((i) => i.id).slice(-2), [CLOCK + 100, CLOCK + 101]);

  s.reg.rows.push({ id: 9, run_id: RUN_ID, text: 'x'.repeat(W.MAX_TEXT + 1), created_at: 'nope' });
  await s.widget.deliver(ctl);
  assert.ok(s.reg.acked.includes(9));
  assert.equal(ctl.list.length, 3);
});

test('deliver: nothing for a run without a widget, for a bad run id, or once the run is gone mid-pull', async (t) => {
  const s = setup(t);
  s.reg.rows.push(row(1));
  assert.equal(await s.widget.deliver(fakeController()), 0, 'no token baked');
  await s.widget.prepare(run());
  assert.equal(await s.widget.deliver(fakeController({ runId: 'lwother' })), 0);
  assert.equal(await s.widget.deliver({ status: () => ({ active: true, runId: '../x' }), feedback: () => assert.fail('no call') }), 0);
  const gone = fakeController();
  gone.feedback = () => ({ ok: false, reason: 'no-run' });
  assert.equal(await s.widget.deliver(gone), 0);
  assert.deepEqual(s.reg.acked, [], 'kept for later');
});

test('startClientFeedbackPoll: one tick at a time, errors logged, the timer unref-ed', async () => {
  const lines = [];
  let release;
  let calls = 0;
  const widget = {
    deliver: () => {
      calls += 1;
      return new Promise((r) => {
        release = r;
      });
    },
  };
  let unref = false;
  const poll = W.startClientFeedbackPoll({
    controller: {},
    widget,
    setTimer: () => ({
      unref: () => {
        unref = true;
      },
    }),
    clearTimer: () => {},
    log: (l) => lines.push(l),
  });
  assert.ok(unref);
  const first = poll.tick();
  await poll.tick();
  assert.equal(calls, 1, 'no overlap');
  release();
  await first;
  widget.deliver = async () => {
    throw new Error('down');
  };
  await poll.tick();
  assert.match(lines[0], /client feedback not read: down/);
});

test('endpointFor builds the function URL on the project URL', () => {
  assert.equal(W.endpointFor('https://abc.supabase.co/'), 'https://abc.supabase.co/functions/v1/lunaswork-feedback');
  assert.equal(W.endpointFor(undefined), null);
});
