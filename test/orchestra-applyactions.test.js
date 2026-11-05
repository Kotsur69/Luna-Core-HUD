// God Mode: apply the run's Supabase actions after the merge
// (src/orchestraApplyActions.js, src/orchestraAsk.js) and how the run report
// shows them. Every command goes through a fake execFile and every file
// through an in-memory fs: no real supabase / claude / git call is made.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  applyManualActions,
  supabaseGate,
  pendingActions,
  detectTooling,
  parseMcpList,
  mcpPrefix,
  linkedRefFromList,
  parseFunctionHeader,
  destructiveKeyword,
  buildPlan,
  gateOf,
  workerArgs,
  parseWorkerResult,
  scrub,
  MODES,
  DEFAULT_MODE,
  RESULT_TAG,
} = require('../src/orchestraApplyActions.js');
const { createOrchestraAsk } = require('../src/orchestraAsk.js');
const { buildReport, renderRunReportHtml, needsYouLines } = require('../src/orchestraReport.js');
const { runEntry } = require('../src/godmodesnapshot.js');
const { createFinalizer, POST_MERGE_STEPS } = require('../src/orchestraFinalize.js');
const { readUiPrefs, SUPABASE_APPLY_MODES } = require('../src/uiprefs.js');

const REPO = path.resolve('/fake/lunarepo');
const TMP = path.resolve('/fake/tmp');
const T = Date.UTC(2026, 10, 3, 10, 0);
const REF = 'abcdefghijklmnopqrst';
const RAND = 'f00d'.repeat(16);
const HEAD = 'a'.repeat(40);

const MIG = '20261101000000_add_votes.sql';
const DROP_MIG = '20261102000000_drop_legacy.sql';

const HEADER = [
  '// ============================================================================',
  '// feedback - the client feedback widget endpoint',
  '// ----------------------------------------------------------------------------',
  '// Deploy: supabase functions deploy feedback --no-verify-jwt',
  '// Secrets: WIDGET_IP_SALT (any random string); RESEND_API_KEY (from resend.com).',
  '// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.',
  '// ============================================================================',
  '',
  'export default {};',
  '',
].join('\n');

const FILES = {
  'supabase/config.toml': 'project_id = "lunarepo"\n',
  'supabase/.temp/project-ref': `${REF}\n`,
  [`supabase/migrations/${MIG}`]:
    'create table votes (id bigint primary key, item bigint references items(id) on delete cascade);\n' +
    'create policy votes_del on votes for delete using (auth.uid() = owner);\n',
  [`supabase/migrations/${DROP_MIG}`]: 'drop table if exists legacy_votes;\n',
  'supabase/functions/feedback/index.js': HEADER,
  'supabase/functions/feedback/core.mjs': '// Pure core of the feedback function.\nexport const x = 1;\n',
};

const ACTIONS = [
  { kind: 'migration', what: MIG, from: 'abcdef1234' },
  { kind: 'edgeFunction', what: 'feedback', from: 'abcdef1234' },
  { kind: 'env', what: 'RESEND_API_KEY' },
  { kind: 'note', what: 'tell the client' },
];

const MCP_NONE = 'Checking MCP server health...\n\ncodebase-memory-mcp: node server.js - ✓ Connected\n';
const MCP_SUPABASE = `Checking MCP server health...\n\nsupabase: https://mcp.supabase.com/mcp?project_ref=${REF} (HTTP) - ✓ Connected\nplugin:ecc:chrome-devtools: npx chrome-devtools-mcp@latest - ✗ Failed to connect\n`;
const PROJECTS = (linked) =>
  [
    '  LINKED | ORG ID | REFERENCE ID         | NAME     | REGION | CREATED AT (UTC)',
    '  -------|--------|----------------------|----------|--------|-----------------',
    `     ${linked ? '●' : ' '}   | orgx   | ${REF} | lunarepo | eu     | 2026-01-01`,
    '         | orgx   | zyxwvutsrqponmlkjihg | other    | eu     | 2026-01-01',
  ].join('\n');

const ok = (stdout = '') => ({ stdout });
const fail = (stderr, code = 1) => ({ code, stderr });
const ENOENT = { code: 'ENOENT', stderr: 'spawn ENOENT' };

// ---- fakes ------------------------------------------------------------------

function fakeFs(files, { links = [] } = {}) {
  const store = new Map();
  for (const [rel, body] of Object.entries(files)) if (body !== null) store.set(path.join(REPO, rel), body);
  const linked = new Set(links.map((rel) => path.join(REPO, rel)));
  const dirs = new Set([REPO, TMP]);
  const written = [];
  const removed = [];
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const under = (dir) => [...store.keys()].filter((k) => k.startsWith(dir + path.sep));
  const isDir = (p) => dirs.has(p) || under(p).length > 0;
  const stat = (p, lstat) => {
    const n = path.resolve(p);
    const link = lstat && linked.has(n);
    if (store.has(n)) return { isFile: () => !link, isDirectory: () => false, isSymbolicLink: () => link, size: Buffer.byteLength(store.get(n)) };
    if (isDir(n)) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0 };
    throw enoent(n);
  };
  return {
    store,
    written,
    removed,
    statSync: (p) => stat(p, false),
    lstatSync: (p) => stat(p, true),
    mkdtempSync(prefix) {
      const dir = path.resolve(`${prefix}abc123`);
      dirs.add(dir);
      return dir;
    },
    readFileSync(p) {
      const n = path.resolve(p);
      if (!store.has(n)) throw enoent(n);
      return store.get(n);
    },
    readdirSync(p) {
      const n = path.resolve(p);
      if (!isDir(n)) throw enoent(n);
      return [...new Set(under(n).map((k) => k.slice(n.length + 1).split(path.sep)[0]))];
    },
    writeFileSync(p, body, opts) {
      const n = path.resolve(p);
      if (opts && opts.flag === 'wx' && store.has(n)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      written.push({ file: n, body: String(body), opts });
      store.set(n, String(body));
    },
    rmSync(p) {
      const n = path.resolve(p);
      removed.push(n);
      for (const k of [...store.keys()]) if (k === n || k.startsWith(n + path.sep)) store.delete(k);
      dirs.delete(n);
    },
  };
}

/**
 * The world the commands see. o.cli: the supabase CLI is on PATH; o.mcpList:
 * the `claude mcp list` result (undefined = claude not on PATH); o.pending:
 * what `db push --dry-run` lists before the push.
 */
function routeFor(o) {
  let pushed = false;
  const pendingBefore = o.pending || [MIG, DROP_MIG];
  const dryRun = () => {
    if (o.dryRun) return o.dryRun(pushed);
    const names = pushed ? (o.stillPending || []) : pendingBefore;
    return names.length ? ok(`Would push these migrations:\n${names.map((n) => ` • ${n}`).join('\n')}\n`) : ok('Remote database is up to date.\n');
  };
  return (bin, args) => {
    const a = args.join(' ');
    if (bin === 'git') {
      if (a.includes('symbolic-ref')) return ok(`${o.branch || 'main'}\n`);
      if (a.includes('merge-base')) return o.notMerged ? fail('') : ok();
      if (a.includes('status --porcelain')) return ok(o.dirty || '');
      if (a.includes('rev-parse')) return ok(`${o.headNow ? o.headNow() : HEAD}\n`);
    }
    if (bin === 'claude' && a === 'mcp list') return o.mcpList === undefined ? ENOENT : o.mcpList;
    if (bin === 'claude') return o.worker ? o.worker() : ENOENT;
    if (bin === 'supabase') {
      if (!o.cli) return ENOENT;
      if (a === '--version') return ok('2.40.7\n');
      if (a === 'projects list') return o.projectsList || ok(PROJECTS(true));
      if (a === 'secrets list') return o.secretsList || ok('  NAME          | DIGEST\n  --------------|-------\n  SUPABASE_URL  | 1a2b3c\n');
      if (a.startsWith('secrets set')) return o.secretsSet || ok('Finished supabase secrets set.\n');
      if (a === 'db push --dry-run') return dryRun();
      if (a === 'db push --yes') {
        pushed = true;
        return o.push || ok('Finished supabase db push.\n');
      }
      if (a.startsWith('functions deploy')) return o.deploy ? o.deploy(args) : ok('Deployed Functions\n');
    }
    return fail(`unexpected ${bin} ${a}`);
  };
}

function fakeExec(route) {
  const calls = [];
  const execImpl = (bin, args, opts, cb) => {
    const call = { bin, args: [...args], line: [bin, ...args].join(' '), opts, input: undefined };
    calls.push(call);
    const r = route(bin, args) || ENOENT;
    setImmediate(() => {
      if (r.code) cb(Object.assign(new Error(r.stderr || 'failed'), { code: r.code, killed: !!r.killed }), r.stdout || '', r.stderr || '');
      else cb(null, r.stdout || '', r.stderr || '');
    });
    return {
      stdin: {
        on() {},
        end(input) {
          call.input = input;
        },
      },
    };
  };
  return { execImpl, calls };
}

function setup(o = {}) {
  const fsx = fakeFs({ ...FILES, ...(o.files || {}) }, { links: o.links || [] });
  const ex = fakeExec(routeFor(o));
  const asked = [];
  const deps = {
    mode: () => (o.mode === undefined ? 'ask' : o.mode),
    env: () => ({ PATH: '/fake/bin' }),
    execImpl: ex.execImpl,
    fs: fsx,
    now: () => T,
    random: (n) => (n === 32 ? RAND : 'x'.repeat(n * 2)),
    tmpdir: () => TMP,
    ask:
      o.ask === null
        ? undefined
        : async (spec) => {
          asked.push(spec);
          return o.ask ? o.ask(spec) : { answer: 'approve', by: 'hud' };
        },
    log: () => {},
  };
  return { fsx, ex, asked, deps };
}

/** detectTooling's io over the same fakes. */
function ioFor(o = {}) {
  const fsx = fakeFs({ ...FILES, ...(o.files || {}) });
  const route = routeFor(o);
  const calls = [];
  const cwds = new Map();
  return {
    calls,
    cwds,
    fs: fsx,
    tmpdir: () => TMP,
    log: () => {},
    run: async (bin, args, opts = {}) => {
      calls.push([bin, ...args].join(' '));
      cwds.set([bin, ...args].join(' '), opts.cwd);
      const r = route(bin, args) || ENOENT;
      return { ok: !r.code, stdout: r.stdout || '', stderr: r.stderr || '', code: r.code || 0, killed: false };
    },
  };
}

const ctxOf = (over = {}) => ({
  planId: 'pabc123',
  repoPath: REPO,
  base: 'main',
  headSha: HEAD,
  manualActions: ACTIONS,
  previous: {},
  results: {},
  ...over,
});

const item = (res, kind, what) => res.items.find((i) => i.kind === kind && i.what === what);
const applyCalls = (calls) => calls.map((c) => c.line).filter((l) => /db push|functions deploy|secrets set|^claude -p/.test(l));

const viewWith = (supabase, over = {}) => ({
  id: 'pabc123',
  repoPath: REPO,
  baseBranch: 'main',
  workerModel: 'opus',
  permissionMode: 'bypassPermissions',
  integrationMode: 'merge',
  integration: { state: 'done', skipped: [], partial: false, manualActions: ACTIONS, postMerge: supabase ? { supabase: { ...supabase, at: T } } : {} },
  options: { unattendedApprovalMin: 30 },
  runStartedAt: T - 60 * 60 * 1000,
  pausedTotalMs: 0,
  overlaps: [],
  packages: [{ id: 'a', title: 'A', state: 'pushed', branch: 'luna/a', headSha: 'abcdef123', merged: true }],
  ...over,
});

const section = (md, name) => {
  const start = md.indexOf(`## ${name}\n`);
  assert.ok(start >= 0, `section ${name} missing`);
  const next = md.indexOf('\n## ', start + 3);
  return md.slice(start, next < 0 ? md.length : next);
};

// ---- detection --------------------------------------------------------------

test('parseMcpList reads names with colons and spaces, and only a live server counts', () => {
  const rows = parseMcpList(`${MCP_SUPABASE}claude.ai Supabase Docs: https://x.y/mcp - ! Needs authentication\n`);
  assert.deepEqual(rows.map((r) => [r.name, r.connected]), [
    ['supabase', true],
    ['plugin:ecc:chrome-devtools', false],
    ['claude.ai Supabase Docs', false],
  ]);
  assert.equal(mcpPrefix('claude.ai Supabase'), 'mcp__claude_ai_Supabase__');
  assert.equal(linkedRefFromList(PROJECTS(true)), REF);
  assert.equal(linkedRefFromList(PROJECTS(false)), null);
});

test('detection (a): a connected Supabase MCP server is used first', async () => {
  const io = ioFor({ mcpList: ok(MCP_SUPABASE), cli: false });
  const t = await detectTooling(REPO, io);
  assert.equal(t.tool, 'mcp');
  assert.equal(t.mcp.server, 'supabase');
  assert.equal(t.mcp.prefix, 'mcp__supabase__');
  assert.equal(t.ref, REF);
  assert.match(t.missing, /supabase CLI is not on PATH/);
  // Never from the repo: its .mcp.json / settings / CLAUDE.md are worker-written files.
  const mcpTmp = path.join(TMP, 'lunacore-supabase-abc123');
  assert.equal(io.cwds.get('claude mcp list'), mcpTmp);
  assert.ok(io.fs.removed.includes(mcpTmp), 'the empty folder is removed again');
});

test('detection (b): the supabase CLI linked to the project (project-ref file, else projects list)', async () => {
  const io = ioFor({ mcpList: ok(MCP_SUPABASE), cli: true });
  const t = await detectTooling(REPO, io);
  assert.equal(t.tool, 'cli');
  assert.equal(t.cli.ref, REF);
  assert.equal(t.missing, '');
  assert.ok(!io.calls.includes('claude mcp list'), 'with the CLI, MCP is not even listed');
  assert.ok(!io.calls.includes('supabase projects list'), 'the linked ref file is enough');

  const viaList = await detectTooling(REPO, ioFor({ mcpList: ok(MCP_NONE), cli: true, files: { 'supabase/.temp/project-ref': null } }));
  assert.equal(viaList.tool, 'cli');
  assert.equal(viaList.ref, REF);

  const unlinked = await detectTooling(
    REPO,
    ioFor({ mcpList: ok(MCP_NONE), cli: true, projectsList: ok(PROJECTS(false)), files: { 'supabase/.temp/project-ref': null } }),
  );
  assert.equal(unlinked.tool, null);
  assert.match(unlinked.missing, /installed but this repo is not linked.*supabase link --project-ref <ref>/);
  assert.match(unlinked.missing, /no Supabase MCP server in your user-scope `claude mcp list` - add it with `claude mcp add --scope user/);
});

test('detection: MCP-only needs a known project, matching the linked one', async () => {
  const other = 'zyxwvutsrqponmlkjihg';
  const mismatch = await detectTooling(REPO, ioFor({ mcpList: ok(MCP_SUPABASE.replace(REF, other)), cli: false }));
  assert.equal(mismatch.tool, 'mcp');
  assert.match(mismatch.blocked, new RegExp(`pinned to project ${other} but this repo is linked to ${REF}`));

  const unknown = await detectTooling(
    REPO,
    ioFor({ mcpList: ok('supabase: https://mcp.supabase.com/mcp (HTTP) - ✓ Connected\n'), cli: false, files: { 'supabase/.temp/project-ref': null } }),
  );
  assert.equal(unknown.tool, 'mcp');
  assert.match(unknown.blocked, /project is unknown/);
});

test('detection: only the official Supabase MCP server - its URL or npx running its package', async () => {
  const lookalikes = [
    'supabase: node ./tools/supabase-shim.js - ✓ Connected\n',
    'supabase: node x.js @supabase/mcp-server-supabase - ✓ Connected\n',
    'supabase: https://mcp.supabase.com.evil.example/mcp (HTTP) - ✓ Connected\n',
    'supabase: https://evil.example/?u=https://mcp.supabase.com (HTTP) - ✓ Connected\n',
  ];
  for (const list of lookalikes) {
    const t = await detectTooling(REPO, ioFor({ cli: false, mcpList: ok(list) }));
    assert.equal(t.tool, null, list);
    assert.match(t.missing, /"supabase" is not the official Supabase one/);
  }

  const npx = await detectTooling(REPO, ioFor({ cli: false, mcpList: ok(`supabase-local: npx -y @supabase/mcp-server-supabase@latest --project-ref=${REF} - ✓ Connected\n`) }));
  assert.equal(npx.tool, 'mcp');
  assert.equal(npx.ref, REF);
  const win = await detectTooling(REPO, ioFor({ cli: false, mcpList: ok(`supabase: cmd /c npx -y @supabase/mcp-server-supabase --project-ref=${REF} - ✓ Connected\n`) }));
  assert.equal(win.tool, 'mcp');
});

test('detection (c): neither tool - the missing ones are named', async () => {
  const none = await detectTooling(REPO, ioFor({ cli: false }));
  assert.equal(none.tool, null);
  assert.match(none.missing, /the claude CLI is not on PATH/);
  assert.match(none.missing, /the supabase CLI is not on PATH/);

  const auth = await detectTooling(REPO, ioFor({ cli: false, mcpList: ok('supabase: https://mcp.supabase.com/mcp (HTTP) - ! Needs authentication\n') }));
  assert.equal(auth.tool, null);
  assert.match(auth.missing, /Supabase MCP server "supabase" is not connected/);
});

// ---- plan: destructive SQL, headers, secrets --------------------------------

test('destructiveKeyword: DROP / TRUNCATE / DELETE count; ON DELETE and FOR DELETE do not', () => {
  assert.equal(destructiveKeyword(FILES[`supabase/migrations/${MIG}`]), null);
  assert.equal(destructiveKeyword('alter table x drop column y;'), 'DROP');
  assert.equal(destructiveKeyword('ALTER TABLE x DROP CONSTRAINT y;'), 'DROP');
  assert.equal(destructiveKeyword('truncate table logs;'), 'TRUNCATE');
  assert.equal(destructiveKeyword('delete from votes where true;'), 'DELETE');
  assert.equal(destructiveKeyword('-- we never drop anything\nselect 1;'), 'DROP', 'a comment still asks: never hide SQL');
  assert.equal(destructiveKeyword(null), 'unreadable');
});

test('destructiveKeyword: data-changing and privilege SQL asks too; trigger and FK syntax does not', () => {
  const cases = [
    ['update votes set score = 0;', 'UPDATE'],
    ["do $$ begin execute 'dr' || 'op table x'; end $$;", 'dynamic SQL (EXECUTE / DO)'],
    ["select format('x'); execute 'select 1';", 'dynamic SQL (EXECUTE / DO)'],
    ['alter table votes alter column score type text;', 'ALTER ... TYPE'],
    ['alter table votes rename to old_votes;', 'RENAME'],
    ['grant all on votes to anon;', 'GRANT / REVOKE'],
    ['alter table votes disable row level security;', 'DISABLE ROW LEVEL SECURITY'],
    ['alter policy p on votes using (true);', 'ALTER POLICY'],
    ['create or replace function f() returns int as $$ select 1 $$ language sql;', 'CREATE OR REPLACE'],
    ["alter role authenticator set statement_timeout = '1s';", 'a role change'],
    ['create function f() returns void security definer as $$ $$ language sql;', 'SECURITY DEFINER'],
    // A benign phrase never spans lines: a comment ending in "of" hides nothing.
    ['-- clean up of\nDELETE FROM users;', 'DELETE'],
    ['-- runs before\nupdate profiles set role = 1;', 'UPDATE'],
    ['create policy open_read on votes for select using (true);', 'a policy open to everyone (true)'],
    ['create policy open_ins on votes for insert with check ( true );', 'a policy open to everyone (true)'],
    ['alter table votes disable trigger all;', 'DISABLE TRIGGER'],
  ];
  for (const [sql, label] of cases) assert.equal(destructiveKeyword(sql), label, sql);
  const benign = [
    'create table t (id int references u(id) on delete cascade on update cascade);',
    'create trigger t_touch before update on t for each row execute function touch();',
    'create trigger t_log after insert or update or delete on t for each row execute procedure log();',
    'create policy p on t for update using (auth.uid() = owner);',
    'alter table t add column updated_at timestamptz; alter table t add column deleted_at timestamptz;',
  ];
  for (const sql of benign) assert.equal(destructiveKeyword(sql), null, sql);
});

test('parseFunctionHeader: known deploy flags only, random only for "any random string"', () => {
  const h = parseFunctionHeader(
    [
      'Deploy: supabase functions deploy x --no-verify-jwt --import-map ./map.json',
      'Secrets: A_KEY, B_SALT (any random string); CRON_SECRET: any random value;',
      'OWNER_USER_ID (your auth user id); SUPABASE_URL is provided.',
    ].join('\n'),
  );
  assert.deepEqual(h.flags, ['--no-verify-jwt']);
  assert.deepEqual(h.unknown, ['--import-map']);
  assert.deepEqual(h.secrets, [
    { name: 'A_KEY', random: false },
    { name: 'B_SALT', random: true },
    { name: 'CRON_SECRET', random: true },
    { name: 'OWNER_USER_ID', random: false },
  ]);
  assert.deepEqual(parseFunctionHeader('Deployed with verify_jwt = false').flags, ['--no-verify-jwt']);
  assert.deepEqual(parseFunctionHeader('verify_jwt = false: core.mjs checks the session').flags, ['--no-verify-jwt']);
  assert.deepEqual(parseFunctionHeader('Never set verify_jwt = false here.').flags, [], 'a sentence is not the setting');
  assert.deepEqual(parseFunctionHeader('Do not run functions deploy x --no-verify-jwt by hand.').flags, []);
  assert.deepEqual(parseFunctionHeader('no secrets here').secrets, []);
});

test("buildPlan on this repo's real functions: only WIDGET_IP_SALT is random, the push keys need real values", () => {
  const root = path.join(__dirname, '..');
  const plan = buildPlan(root, [{ kind: 'edgeFunction', what: 'lunaswork-feedback' }, { kind: 'edgeFunction', what: 'push' }], fs);
  assert.deepEqual(plan.manual, []);
  assert.ok(plan.functions.every((f) => f.flags.includes('--no-verify-jwt')));
  const random = plan.secrets.filter((s) => s.random).map((s) => s.name);
  assert.deepEqual(random, ['WIDGET_IP_SALT']);
  for (const name of ['VAPID_PRIVATE_KEY', 'OWNER_USER_ID', 'CRON_SECRET']) {
    assert.equal(plan.secrets.find((s) => s.name === name).random, false, `${name} is never invented`);
  }
  assert.ok(!plan.secrets.some((s) => s.name.startsWith('SUPABASE_')), 'platform secrets are left out');
});

test('buildPlan: migrations in filename order; a bad name or a missing file stays manual', () => {
  const plan = buildPlan(
    REPO,
    [
      { kind: 'migration', what: DROP_MIG },
      { kind: 'migration', what: MIG },
      { kind: 'migration', what: '../../etc/passwd' },
      { kind: 'migration', what: '20261105000000_gone.sql' },
      { kind: 'edgeFunction', what: 'nope' },
    ],
    fakeFs(FILES),
  );
  assert.deepEqual(plan.migrations.map((m) => [m.what, m.destructive]), [
    [MIG, null],
    [DROP_MIG, 'DROP'],
  ]);
  assert.deepEqual(plan.manual.map((m) => m.what), ['../../etc/passwd', '20261105000000_gone.sql', 'nope']);
  assert.ok(plan.manual.every((m) => m.state === 'manual'));

  const linked = buildPlan(REPO, [{ kind: 'migration', what: MIG }], fakeFs(FILES, { links: [`supabase/migrations/${MIG}`] }));
  assert.deepEqual(linked.migrations, [], 'a symlinked migration is never read');
  assert.match(linked.manual[0].why, /not a regular file/);
});

// ---- the gate ---------------------------------------------------------------

test('gateOf: off never applies, ask asks, automatic applies - unless destructive', () => {
  assert.deepEqual(MODES, ['off', 'ask', 'automatic']);
  assert.equal(DEFAULT_MODE, 'ask');
  assert.equal(gateOf('off', false), 'off');
  assert.equal(gateOf('off', true), 'off');
  assert.equal(gateOf('ask', false), 'ask');
  assert.equal(gateOf('automatic', false), 'apply');
  assert.equal(gateOf('automatic', true), 'ask');
  assert.equal(gateOf('bogus', false), 'ask', 'an unknown mode is ask, never automatic');
  assert.equal(gateOf(undefined, false), 'ask');
});

test('no tooling (Mati today): nothing runs, the report names the missing tools and the commands', async () => {
  const { ex, asked, deps } = setup({ cli: false });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(res.tool, 'none');
  assert.match(res.missing, /claude CLI is not on PATH/);
  assert.match(res.missing, /supabase CLI is not on PATH/);
  assert.equal(asked.length, 0, 'nobody is asked when nothing can apply');
  assert.deepEqual(applyCalls(ex.calls), []);
  assert.equal(item(res, 'migration', MIG).command, 'supabase db push');
  assert.match(item(res, 'migration', MIG).why, /no Supabase tool/);
  assert.equal(item(res, 'edgeFunction', 'feedback').command, 'supabase functions deploy feedback --no-verify-jwt');
  assert.match(item(res, 'secret', 'WIDGET_IP_SALT').command, /^supabase secrets set WIDGET_IP_SALT=\$\(node -e .*randomBytes\(32\)/);
  assert.equal(item(res, 'secret', 'RESEND_API_KEY').command, 'supabase secrets set RESEND_API_KEY=<value>');

  const md = buildReport(viewWith(res), { now: T, suggestions: [] });
  const manual = section(md, 'Manual actions');
  assert.match(manual, /Supabase: nothing applied - .*supabase CLI is not on PATH.*Run the commands below/);
  assert.match(manual, new RegExp(`${MIG}.*still manual: no Supabase tool.*Run: \`supabase db push\``));
  assert.match(manual, /`feedback`.*Run: `supabase functions deploy feedback --no-verify-jwt`/);
  assert.match(manual, /### Secrets[\s\S]*`RESEND_API_KEY`.*Run: `supabase secrets set RESEND_API_KEY=<value>`/);
  assert.doesNotMatch(manual, /### Env vars/, 'an env var the step handled shows once, under Secrets');
  assert.match(section(md, 'Needs you'), /5 manual actions/);
});

test('off: not a single command, every action stays manual', async () => {
  const { ex, asked, deps } = setup({ mode: 'off', cli: true, mcpList: ok(MCP_SUPABASE) });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(res.decision, 'off');
  assert.equal(ex.calls.length, 0);
  assert.equal(asked.length, 0);
  assert.ok(res.items.every((i) => i.state === 'manual' && /off in Settings/.test(i.why)));
  assert.match(section(buildReport(viewWith(res), { now: T }), 'Manual actions'), /Apply Supabase actions is off in Settings/);
});

test('ask + approve (CLI): secrets, then migrations, then functions - applied, with time, in the report', async () => {
  const { fsx, ex, asked, deps } = setup({ cli: true, mcpList: ok(MCP_NONE), pending: [MIG] });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(asked.length, 1);
  const spec = asked[0];
  assert.equal(spec.kind, 'migration');
  assert.deepEqual(spec.options, ['approve', 'reject']);
  assert.equal(spec.defaultAnswer, 'reject');
  assert.equal(spec.runId, 'pabc123');
  assert.match(spec.question, /^Apply 1 migration\(s\), deploy 1 edge function\(s\), set 1 random secret\(s\) on Supabase for lunarepo/);
  assert.match(spec.detail, new RegExp(`project ${REF}`));

  assert.equal(res.decision, 'approved');
  assert.equal(res.tool, 'cli');
  assert.match(spec.detail, /check [0-9a-f]{12}/);
  const lines = applyCalls(ex.calls);
  const tempDir = path.join(TMP, 'lunacore-secrets-abc123');
  assert.equal(lines[0], `supabase secrets set --env-file ${path.join(tempDir, 'secrets.env')}`);
  assert.deepEqual(lines.slice(1), ['supabase db push --dry-run', 'supabase db push --yes', 'supabase db push --dry-run', 'supabase functions deploy feedback --no-verify-jwt']);
  assert.ok(ex.calls.every((c) => c.opts.cwd === undefined || c.opts.cwd === REPO));

  // The random salt: a file in a fresh private temp folder, removed again, never in any argv.
  assert.equal(fsx.written.length, 1);
  assert.equal(fsx.written[0].file, path.join(tempDir, 'secrets.env'));
  assert.equal(fsx.written[0].body, `WIDGET_IP_SALT=${RAND}\n`);
  assert.equal(fsx.written[0].opts.mode, 0o600);
  assert.equal(fsx.written[0].opts.flag, 'wx');
  assert.deepEqual(fsx.removed, [tempDir]);
  assert.ok(!fsx.store.has(fsx.written[0].file));
  assert.ok(ex.calls.every((c) => !c.line.includes(RAND)));

  assert.equal(item(res, 'migration', MIG).state, 'applied');
  assert.equal(item(res, 'migration', MIG).at, T);
  assert.equal(item(res, 'edgeFunction', 'feedback').state, 'applied');
  assert.equal(item(res, 'secret', 'WIDGET_IP_SALT').state, 'applied');
  assert.equal(item(res, 'secret', 'RESEND_API_KEY').state, 'manual');
  assert.match(item(res, 'secret', 'RESEND_API_KEY').why, /never invents one/);
  assert.ok(!JSON.stringify(res).includes(RAND), 'the value is not kept in the run state');

  const view = viewWith(res);
  const md = buildReport(view, { now: T });
  const manual = section(md, 'Manual actions');
  assert.match(manual, /Supabase: run with the supabase CLI 2\.40\.7 \(project `abcdefghijklmnopqrst`\), approved by you\./);
  assert.match(manual, new RegExp(`${MIG}.*applied 2026-11-03 10:00 UTC`));
  assert.match(manual, /`WIDGET_IP_SALT` - applied 2026-11-03 10:00 UTC \(set to a random value\)/);
  assert.match(manual, /`RESEND_API_KEY` - still manual: needs a real value/);
  assert.match(section(md, 'After the merge'), /- Supabase: 3 applied, 1 still manual - see Manual actions/);
  assert.ok(needsYouLines(view).some((l) => /2 manual actions/.test(l)), 'only what is still open needs Mati');
  const html = renderRunReportHtml(view, { now: T });
  assert.match(html, /applied 2026-11-03 10:00 UTC/);
  assert.match(html, /still manual: needs a real value/);
  assert.doesNotMatch(html, /<script/i);
  const entry = runEntry(view, { now: T });
  assert.ok(entry.manual.includes(`migration: ${MIG} - applied`));
});

test('ask + declined on the phone: nothing is applied', async () => {
  const { ex, deps } = setup({ cli: true, mcpList: ok(MCP_NONE), ask: () => ({ answer: 'reject', by: 'phone' }) });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(res.decision, 'declined');
  assert.deepEqual(applyCalls(ex.calls), []);
  assert.ok(!ex.calls.some((c) => c.line === 'supabase secrets list'), 'not even read before the yes');
  assert.ok(res.items.every((i) => i.state === 'manual'));
  assert.equal(item(res, 'migration', MIG).why, 'you declined it');
  assert.match(section(buildReport(viewWith(res), { now: T }), 'Manual actions'), /you declined applying \(project `abcdefghijklmnopqrst`\)/);
});

test('ask + no answer by the deadline (or a broken ask): the safe default, nothing applied', async () => {
  for (const ask of [() => ({ answer: 'reject', by: 'default' }), () => ({ answer: null, by: 'error' }), () => {
    throw new Error('dialog crashed');
  }]) {
    const { ex, deps } = setup({ cli: true, mcpList: ok(MCP_NONE), ask });
    const res = await applyManualActions(ctxOf(), deps);
    assert.equal(res.decision, 'timeout');
    assert.deepEqual(applyCalls(ex.calls), []);
    assert.match(item(res, 'migration', MIG).why, /no answer before the deadline/);
  }
  const { ex, deps } = setup({ cli: true, mcpList: ok(MCP_NONE), ask: null });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(res.decision, 'timeout', 'no ask service = no yes');
  assert.deepEqual(applyCalls(ex.calls), []);
});

test('automatic: applies without asking', async () => {
  const { ex, asked, deps } = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), pending: [MIG] });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(asked.length, 0);
  assert.equal(res.decision, 'automatic');
  assert.equal(item(res, 'migration', MIG).state, 'applied');
  assert.ok(applyCalls(ex.calls).includes('supabase db push --yes'));
  assert.match(section(buildReport(viewWith(res), { now: T }), 'Manual actions'), /automatically\./);
});

test('automatic + a destructive migration: it asks anyway, and a no applies nothing', async () => {
  const actions = [...ACTIONS, { kind: 'migration', what: DROP_MIG }];
  const { ex, asked, deps } = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), ask: () => ({ answer: 'reject', by: 'hud' }) });
  const res = await applyManualActions(ctxOf({ manualActions: actions }), deps);
  assert.equal(asked.length, 1);
  assert.match(asked[0].detail, new RegExp(`^${DROP_MIG} contains DROP`));
  assert.match(asked[0].question, /Apply 2 migration\(s\)/);
  assert.equal(res.decision, 'declined');
  assert.deepEqual(applyCalls(ex.calls), []);

  const yes = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), pending: [MIG, DROP_MIG] });
  const applied = await applyManualActions(ctxOf({ manualActions: actions }), yes.deps);
  assert.equal(yes.asked.length, 1);
  assert.equal(applied.decision, 'approved');
  assert.equal(item(applied, 'migration', DROP_MIG).state, 'applied');
});

// ---- secrets ----------------------------------------------------------------

test('secrets: one already set is left alone; a failed list never overwrites blindly', async () => {
  const set = setup({ cli: true, mcpList: ok(MCP_NONE), pending: [MIG], secretsList: ok('NAME | DIGEST\n-----|-------\nWIDGET_IP_SALT | 9f9f\nRESEND_API_KEY | 1234\n') });
  const res = await applyManualActions(ctxOf(), set.deps);
  assert.equal(item(res, 'secret', 'WIDGET_IP_SALT').state, 'unchanged');
  assert.equal(item(res, 'secret', 'RESEND_API_KEY').state, 'unchanged');
  assert.ok(!set.ex.calls.some((c) => c.line.startsWith('supabase secrets set')));
  assert.equal(set.fsx.written.length, 0);
  assert.match(section(buildReport(viewWith(res), { now: T }), 'Manual actions'), /`WIDGET_IP_SALT` - already set, left unchanged/);

  const broken = setup({ cli: true, mcpList: ok(MCP_NONE), pending: [MIG], secretsList: fail('Unauthorized') });
  const res2 = await applyManualActions(ctxOf(), broken.deps);
  assert.equal(item(res2, 'secret', 'WIDGET_IP_SALT').state, 'manual');
  assert.match(item(res2, 'secret', 'WIDGET_IP_SALT').why, /not overwritten blindly/);
  assert.ok(!broken.ex.calls.some((c) => c.line.startsWith('supabase secrets set')));
  assert.equal(item(res2, 'migration', MIG).state, 'applied', 'the migration does not depend on the list');

  // An output without the NAME table is not "nothing set".
  const odd = setup({ cli: true, mcpList: ok(MCP_NONE), pending: [MIG], secretsList: ok('{"secrets":[]}\n') });
  const res3 = await applyManualActions(ctxOf(), odd.deps);
  assert.match(item(res3, 'secret', 'WIDGET_IP_SALT').why, /not overwritten blindly/);
  assert.ok(!odd.ex.calls.some((c) => c.line.startsWith('supabase secrets set')));
});

test('a function whose header names an unknown deploy flag is never deployed with a guess', async () => {
  const files = { 'supabase/functions/feedback/index.js': HEADER.replace('--no-verify-jwt', '--no-verify-jwt --import-map ./map.json') };
  const { ex, deps } = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), pending: [MIG], files });
  const res = await applyManualActions(ctxOf(), deps);
  const fn = item(res, 'edgeFunction', 'feedback');
  assert.equal(fn.state, 'manual');
  assert.equal(fn.command, 'supabase functions deploy feedback --no-verify-jwt --import-map');
  assert.ok(!ex.calls.some((c) => c.line.startsWith('supabase functions deploy')));
});

// ---- CLI apply guards -------------------------------------------------------

test('CLI: db push is refused when it would push more than the listed migrations', async () => {
  const { ex, deps } = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), pending: [MIG, '20260101000000_someone_else.sql'] });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(item(res, 'migration', MIG).state, 'failed');
  assert.match(item(res, 'migration', MIG).error, /other pending migrations would be pushed too \(20260101000000_someone_else\.sql\) - nothing pushed/);
  assert.ok(!ex.calls.some((c) => c.line === 'supabase db push --yes'));
  assert.equal(item(res, 'edgeFunction', 'feedback').error, 'not deployed: a migration failed');
  assert.ok(!ex.calls.some((c) => c.line.startsWith('supabase functions deploy')));
  assert.match(section(buildReport(viewWith(res), { now: T }), 'Manual actions'), /failed: other pending migrations/);
});

test('CLI: a migration still pending after the push is failed; one already applied is not pushed', async () => {
  const still = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), pending: [MIG], stillPending: [MIG] });
  const res = await applyManualActions(ctxOf(), still.deps);
  assert.equal(item(res, 'migration', MIG).state, 'failed');
  assert.equal(item(res, 'migration', MIG).error, 'still pending after supabase db push');

  const done = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), pending: [] });
  const res2 = await applyManualActions(ctxOf(), done.deps);
  assert.equal(item(res2, 'migration', MIG).state, 'applied');
  assert.equal(item(res2, 'migration', MIG).note, 'already applied on the project');
  assert.ok(!done.ex.calls.some((c) => c.line === 'supabase db push --yes'));

  const unreadable = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), dryRun: () => ok('something new\n') });
  const res3 = await applyManualActions(ctxOf(), unreadable.deps);
  assert.match(item(res3, 'migration', MIG).error, /could not read the output/);
  assert.ok(!unreadable.ex.calls.some((c) => c.line === 'supabase db push --yes'));

  // A pending file whose name does not parse would be pushed unseen.
  const odd = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), dryRun: () => ok(`Would push these migrations:\n • ${MIG}\n • 2024_x.v2.sql\n`) });
  const res4 = await applyManualActions(ctxOf(), odd.deps);
  assert.match(item(res4, 'migration', MIG).error, /lists a migration LunaCore cannot read - nothing pushed/);
  assert.ok(!odd.ex.calls.some((c) => c.line === 'supabase db push --yes'));
});

test('a failing deploy reports the error line, with credentials masked', async () => {
  const deploy = () => fail('Uploading asset...\nError: unexpected status 401: token=sbp_0123456789abcdef0123 invalid\n');
  const { deps } = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), pending: [MIG], deploy });
  const res = await applyManualActions(ctxOf(), deps);
  const fn = item(res, 'edgeFunction', 'feedback');
  assert.equal(fn.state, 'failed');
  assert.match(fn.error, /unexpected status 401/);
  assert.doesNotMatch(fn.error, /sbp_0123/);
  assert.equal(scrub('postgres://user:pw@db.x.supabase.co'), 'postgres://***@db.x.supabase.co');
});

// ---- MCP apply: one worker --------------------------------------------------

test('MCP: one headless worker with an allowlist, a strict brief, and its result checked', async () => {
  const worker = () => ok(`Done.\n${RESULT_TAG} {"actions":[{"kind":"migration","what":"${MIG}","state":"applied","detail":"already applied"},{"kind":"migration","what":"other.sql","state":"applied"}]}\n`);
  const { ex, deps } = setup({ cli: false, mcpList: ok(MCP_SUPABASE), worker });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(res.tool, 'mcp');
  const runs = ex.calls.filter((c) => c.bin === 'claude' && c.args[0] === '-p');
  assert.equal(runs.length, 1, 'exactly one worker');
  const args = runs[0].args;
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
  const denied = args[args.indexOf('--disallowedTools') + 1].split(',');
  assert.ok(allowed.includes('mcp__supabase__apply_migration'));
  assert.ok(allowed.includes('mcp__supabase__deploy_edge_function'));
  assert.ok(!allowed.some((t) => /Bash|PowerShell|Write|Edit|execute_sql/.test(t)));
  assert.ok(denied.includes('Bash') && denied.includes('mcp__supabase__execute_sql'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!args.includes('bypassPermissions') && !args.includes('--dangerously-skip-permissions'));
  // An empty folder, the checkout only added: no repo .mcp.json / settings / CLAUDE.md.
  assert.equal(runs[0].opts.cwd, path.join(TMP, 'lunacore-supabase-abc123'));
  assert.equal(args[args.indexOf('--add-dir') + 1], REPO);
  const brief = runs[0].input;
  const repo = REPO.replace(/\\/g, '/');
  assert.ok(brief.includes(`\`${repo}/supabase/migrations/${MIG}\``));
  assert.ok(brief.includes(`\`feedback\` - Read every file in \`${repo}/supabase/functions/feedback/\``));
  assert.match(brief, /deploy them unchanged with deploy_edge_function \(verify_jwt false\)/);
  assert.match(brief, /NEVER drop, truncate or delete data/);
  assert.match(brief, /NEVER apply, deploy or change anything that is not listed/);
  assert.match(brief, new RegExp(`Supabase project: \`${REF}\``));
  assert.match(brief, new RegExp(`${RESULT_TAG} \\{`));
  assert.ok(!brief.includes(RAND) && !/WIDGET_IP_SALT/.test(brief), 'no secret goes to the model');

  assert.equal(item(res, 'migration', MIG).state, 'applied');
  assert.equal(item(res, 'migration', MIG).note, 'already applied');
  assert.equal(item(res, 'edgeFunction', 'feedback').state, 'failed');
  assert.equal(item(res, 'edgeFunction', 'feedback').error, 'the worker did not report it');
  assert.ok(!res.items.some((i) => i.what === 'other.sql'), 'what the worker made up is ignored');
  assert.match(item(res, 'secret', 'WIDGET_IP_SALT').why, /needs the supabase CLI/);
});

test('MCP is never automatic: a model carries the SQL, so it always asks', async () => {
  const { ex, asked, deps } = setup({ mode: 'automatic', cli: false, mcpList: ok(MCP_SUPABASE), ask: () => ({ answer: 'reject', by: 'phone' }) });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(asked.length, 1);
  assert.match(asked[0].detail, /^a Claude worker applies it through MCP; project abcdefghijklmnopqrst; via MCP server supabase; check [0-9a-f]{12}/);
  assert.equal(res.decision, 'declined');
  assert.deepEqual(applyCalls(ex.calls), []);
});

test('MCP with an unknown project: nothing runs, the report says why', async () => {
  const { ex, asked, deps } = setup({ cli: false, mcpList: ok('supabase: https://mcp.supabase.com/mcp (HTTP) - ✓ Connected\n'), files: { 'supabase/.temp/project-ref': null } });
  const res = await applyManualActions(ctxOf(), deps);
  assert.equal(asked.length, 0);
  assert.match(res.missing, /project is unknown/);
  assert.deepEqual(applyCalls(ex.calls), []);
  assert.match(section(buildReport(viewWith(res), { now: T }), 'Manual actions'), /Supabase: nothing applied - the Supabase project is unknown/);
});

test('a yes covers what it was given: files or HEAD changing while waiting applies nothing', async () => {
  let s = null;
  s = setup({
    cli: true,
    mcpList: ok(MCP_NONE),
    pending: [MIG],
    ask: () => {
      s.fsx.store.set(path.join(REPO, 'supabase', 'migrations', MIG), 'create table votes (id int);\ndrop table users;\n');
      return { answer: 'approve', by: 'phone' };
    },
  });
  const res = await applyManualActions(ctxOf(), s.deps);
  assert.equal(res.decision, 'approved');
  assert.match(res.stopped, /the Supabase files changed while waiting/);
  assert.deepEqual(applyCalls(s.ex.calls), []);
  assert.ok(res.items.every((i) => i.state === 'manual'));
  assert.match(section(buildReport(viewWith(res), { now: T }), 'Manual actions'), /you approved, but nothing applied - the Supabase files changed/);

  let n = 0;
  const moved = setup({ cli: true, mcpList: ok(MCP_NONE), pending: [MIG], headNow: () => (n++ === 0 ? HEAD : 'b'.repeat(40)) });
  const res2 = await applyManualActions(ctxOf(), moved.deps);
  assert.match(res2.stopped, /moved while waiting/);
  assert.deepEqual(applyCalls(moved.ex.calls), []);

  // Everything a deploy bundles is pinned, _shared included.
  let f = null;
  f = setup({
    cli: true,
    mcpList: ok(MCP_NONE),
    pending: [MIG],
    ask: () => {
      f.fsx.store.set(path.join(REPO, 'supabase', 'functions', '_shared', 'cors.ts'), 'export const x = fetch("https://evil.example");\n');
      return { answer: 'approve', by: 'hud' };
    },
  });
  const res3 = await applyManualActions(ctxOf(), f.deps);
  assert.match(res3.stopped, /the Supabase files changed while waiting/);
  assert.deepEqual(applyCalls(f.ex.calls), []);
});

test('an edge function whose folder holds a link stays manual (what would be bundled is unknown)', async () => {
  const { ex, deps } = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), pending: [MIG], links: ['supabase/functions/feedback/core.mjs'] });
  const res = await applyManualActions(ctxOf(), deps);
  const fn = item(res, 'edgeFunction', 'feedback');
  assert.equal(fn.state, 'manual');
  assert.match(fn.why, /its files hold a link/);
  assert.equal(fn.command, 'supabase functions deploy feedback --no-verify-jwt');
  assert.ok(!ex.calls.some((c) => c.line.startsWith('supabase functions deploy')));
  assert.equal(item(res, 'migration', MIG).state, 'applied', 'the migration is not held back');
});

test('parseWorkerResult: the last tagged line, valid entries only, errors masked', () => {
  assert.equal(parseWorkerResult('no tag here'), null);
  assert.equal(parseWorkerResult(`${RESULT_TAG} {not json`), null);
  const text = [
    `${RESULT_TAG} {"actions":[{"kind":"migration","what":"a.sql","state":"failed","error":"old"}]}`,
    `${RESULT_TAG} {"actions":[{"kind":"migration","what":"a.sql","state":"failed","error":"password=hunter2 nope"},{"kind":"secret","what":"X_Y","state":"applied"},{"kind":"edgeFunction","what":"f","state":"maybe"}]}`,
  ].join('\n');
  const map = parseWorkerResult(text);
  assert.equal(map.size, 1);
  const a = [...map.values()][0];
  assert.equal(a.state, 'failed');
  assert.equal(a.error, 'password=*** nope');
  assert.ok(workerArgs({ mcp: { prefix: 'mcp__s__' } }, REPO).includes('--no-session-persistence'));
});

// ---- when the step runs -----------------------------------------------------

test('supabaseGate: only Supabase actions an earlier pass did not apply', () => {
  assert.equal(supabaseGate(ctxOf()), true);
  assert.equal(supabaseGate(ctxOf({ manualActions: [{ kind: 'env', what: 'X_Y' }, { kind: 'note', what: 'n' }] })), false);
  assert.equal(supabaseGate(ctxOf({ manualActions: undefined })), false);
  const previous = { supabase: { items: [{ kind: 'migration', what: MIG, state: 'applied' }, { kind: 'edgeFunction', what: 'feedback', state: 'failed' }] } };
  assert.deepEqual(pendingActions(ctxOf({ previous })).map((a) => a.what), ['feedback']);
});

test('the main checkout must hold the merge, on the base branch, clean under supabase/', async () => {
  for (const [o, why] of [
    [{ branch: 'feature' }, /not on main/],
    [{ notMerged: true }, /not in the main checkout yet/],
    [{ dirty: ' M supabase/migrations/x.sql\n' }, /local changes under supabase/],
  ]) {
    const { ex, deps } = setup({ mode: 'automatic', cli: true, mcpList: ok(MCP_NONE), ...o });
    const res = await applyManualActions(ctxOf(), deps);
    assert.match(item(res, 'migration', MIG).why, why);
    assert.ok(ex.calls.every((c) => c.bin === 'git'), 'no tool runs');
  }
  const { deps } = setup({ mode: 'automatic', cli: true });
  const res = await applyManualActions(ctxOf({ headSha: 'not-a-sha' }), deps);
  assert.match(item(res, 'migration', MIG).why, /merged head is unknown/);
});

test('finalize: the supabase step runs after cleanup and before the release, with the manual actions', async () => {
  const plan = {
    id: 'pabc123',
    projectId: 'proj1',
    repoPath: REPO,
    baseBranch: 'main',
    integrationMode: 'merge',
    workerModel: 'opus',
    permissionMode: 'bypassPermissions',
    notes: '',
    approvalLog: [],
    options: { releaseAfter: true },
    // What the self-check gate left (orchestraSelfCheck.detectManualActions).
    integration: {
      state: 'idle',
      error: null,
      detail: null,
      at: null,
      selfCheck: { tests: 'ok', syntax: 'ok', smoke: 'skipped', fixups: 0, tail: '' },
      manualActions: ACTIONS,
    },
    packages: [{ id: 'core', title: 'Core', state: 'pushed', branch: 'luna/core-ab12c', dependsOn: [], verify: 'npm test', merged: false }],
  };
  const order = [];
  const seen = [];
  const reports = [];
  const finalizer = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => Object.assign(plan.packages.find((p) => p.id === id), fields),
    commit: () => {},
    view: () => ({ ...plan, packages: plan.packages.map((p) => ({ ...p })), integration: { ...plan.integration } }),
    onRunEvent: () => {},
    now: () => T,
    integrateMerge: async () => ({ ok: true, merged: ['core'], skipped: [], headSha: HEAD }),
    writeReport: (_id, text) => reports.push(text),
    postMerge: {
      updateLocalBase: async () => (order.push('localBase'), { updated: true }),
      cleanupMergedRun: async () => (order.push('cleanup'), { worktree: 'none', deleted: [], kept: [] }),
      applySupabaseActions: async (ctx) => {
        order.push('supabase');
        seen.push(ctx);
        return { mode: 'ask', tool: 'none', missing: 'the supabase CLI is not on PATH', decision: null, ref: null, items: [{ kind: 'migration', what: MIG, state: 'manual', why: 'no Supabase tool', command: 'supabase db push' }] };
      },
      releaseAfterMerge: async () => (order.push('release'), { skipped: 'tests failed' }),
    },
    sleep: async () => {},
  });
  await finalizer.finalize();
  assert.deepEqual(POST_MERGE_STEPS.map((s) => s.name), ['localBase', 'cleanup', 'supabase', 'release']);
  assert.deepEqual(order, ['localBase', 'cleanup', 'supabase', 'release']);
  assert.deepEqual(seen[0].manualActions, ACTIONS);
  assert.equal(seen[0].headSha, HEAD);
  assert.equal(plan.integration.postMerge.supabase.items[0].state, 'manual');
  assert.match(reports[reports.length - 1], /Supabase: nothing applied - the supabase CLI is not on PATH/);
});

// ---- the ask service (HUD dialog + phone) -----------------------------------

function askService(confirm) {
  const timers = [];
  const changes = [];
  const svc = createOrchestraAsk({
    confirm,
    now: () => T,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
    onChange: (list) => changes.push(list),
  });
  return { svc, timers, changes };
}

const SPEC = { kind: 'migration', question: 'Apply 1 migration(s) on Supabase for lunarepo?', detail: MIG, options: ['approve', 'reject'], defaultAnswer: 'reject', deadlineMs: 60 * 60 * 1000, runId: 'pabc123', repoName: 'lunarepo' };

test('ask: the HUD dialog answers; the phone sees the question meanwhile', async () => {
  const { svc, changes } = askService(async () => true);
  const res = await svc.ask(SPEC);
  assert.deepEqual(res, { answer: 'approve', by: 'hud' });
  assert.equal(changes[0].length, 1);
  assert.equal(changes[0][0].runId, 'pabc123');
  assert.equal(changes[0][0].repoName, 'lunarepo');
  assert.equal(changes[0][0].defaultAnswer, 'reject');
  assert.deepEqual(svc.pending(), []);
});

test('ask: a phone answer counts only for its run and a listed option, and closes the dialog', async () => {
  let signal = null;
  const { svc } = askService((_q, s) => {
    signal = s;
    return new Promise(() => {});
  });
  const pending = svc.ask(SPEC);
  await new Promise((r) => setImmediate(r));
  const [d] = svc.pending();
  assert.equal(svc.applyAnswers([{ id: d.id, runId: 'otherrun', answer: 'approve' }]), 0);
  assert.equal(svc.applyAnswers([{ id: d.id, runId: 'pabc123', answer: 'yes please' }]), 0);
  assert.equal(svc.applyAnswers([{ id: d.id + 1, runId: 'pabc123', answer: 'approve' }]), 0);
  assert.equal(svc.applyAnswers([null, 'x', { id: d.id, runId: 'pabc123', answer: 'reject' }]), 1);
  assert.deepEqual(await pending, { answer: 'reject', by: 'phone' });
  assert.equal(signal.aborted, true);
  assert.equal(svc.applyAnswers([{ id: d.id, runId: 'pabc123', answer: 'approve' }]), 0, 'answered once');
});

test('ask: the deadline takes the safe default; a bad spec never waits', async () => {
  const { svc, timers } = askService(async () => null);
  const pending = svc.ask(SPEC);
  assert.equal(timers[0].ms, 60 * 60 * 1000);
  timers[0].fn();
  assert.deepEqual(await pending, { answer: 'reject', by: 'default' });

  assert.equal((await svc.ask({ ...SPEC, runId: 'Bad Id' })).by, 'error');
  assert.equal((await svc.ask({ ...SPEC, defaultAnswer: 'maybe' })).by, 'error');

  const later = svc.ask(SPEC);
  svc.cancelAll();
  assert.deepEqual(await later, { answer: 'reject', by: 'default' });
});

test('ask: pullAnswers reads the phone unit from the todos scope', async () => {
  const { svc } = askService(() => new Promise(() => {}));
  const pending = svc.ask(SPEC);
  const [d] = svc.pending();
  const cloud = { hooks: () => ({ extraPeers: () => [{ 'lunaswork-answer': { items: [{ at: d.id, runId: 'pabc123', answer: 'approve', u: T }] } }] }) };
  assert.equal(svc.pullAnswers(cloud), 1);
  assert.deepEqual(await pending, { answer: 'approve', by: 'phone' });
  assert.equal(svc.pullAnswers({ hooks: () => { throw new Error('offline'); } }), 0);
});

// ---- the setting ------------------------------------------------------------

test('setting: validated in main, ask by default, pl + en strings, same list in the renderer', () => {
  assert.deepEqual(SUPABASE_APPLY_MODES, MODES);
  assert.ok(SUPABASE_APPLY_MODES.includes(readUiPrefs().orchestraSupabaseApply));
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  for (const key of ['orchset.supabase', 'orchset.supabase.hint', 'orchset.supabase.off', 'orchset.supabase.ask', 'orchset.supabase.automatic']) {
    const rows = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
    assert.equal(rows.length, 2, `${key} in pl and en`);
    assert.doesNotMatch(rows[0], /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/, `${key}: pl without diacritics`);
  }
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'modules', 'orchestrasettings.js'), 'utf8');
  assert.match(settings, /const SUPABASE_APPLY_MODES = \['off', 'ask', 'automatic'\];/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /<select id="orchestra-supabase-apply"/);
});
