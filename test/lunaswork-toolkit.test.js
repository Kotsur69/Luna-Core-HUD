'use strict';

// Luna's Work per-project tool kit: settings validation, the builder's kit
// for a Unity game, the fixed Playtester, spend caps, the git guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const K = require('../src/lunasworkToolkit');
const S = require('../src/lunasworkSettings');
const { createToolsFor, hasLiteralSecret } = require('../src/lunasworkToolkitLaunch');
const { createToolGuard, cleanGuardFields, TOOL_DOWN_REASON, TOOL_DOWN_WAIT_MS } = require('../src/lunasworkToolGuard');
const { withTaskBrief } = require('../src/launch');
const { buildPlaytestArgs } = require('../src/lunasworkPlaytest');
const { createGodModeBuilder } = require('../src/lunasworkBuild');
const { SCENE_WORKER_ID } = require('../src/lunasworkScene');

const GAME_SERVERS = ['unity', 'blender', 'higgsfield-bridge', 'comfyui', 'meshy'];
// A blade&bullet-like PC: every game tool has a launch definition, keys only as ${VAR}.
const PC_SERVERS = {
  unity: { command: 'unity-editor-mcp', args: [] },
  blender: { command: 'uvx', args: ['blender-mcp'] },
  higgsfield: { command: 'higgsfield-bridge', args: ['--stdio'], env: { HIGGSFIELD_API_KEY: '${HIGGSFIELD_API_KEY}' } },
  comfyui: { type: 'http', url: 'http://127.0.0.1:8188/mcp' },
  meshy: { command: 'npx', args: ['-y', 'meshy-mcp'], env: { MESHY_API_KEY: '${MESHY_API_KEY}' } },
};
const bladeSettings = () => ({
  toolServers: PC_SERVERS,
  projects: { 'blade-bullet': { profile: { adapter: 'unity' } } },
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lw-toolkit-'));
}

// ---- settings validation ------------------------------------------------------------

test('a Unity project without a kit gets every game tool and the gamedev skills for builders and asset workers', () => {
  const kit = S.toolkitFor(bladeSettings(), 'blade-bullet');
  for (const role of K.KIT_ROLES) {
    assert.deepEqual(kit[role].tools, K.TOOL_IDS);
    assert.deepEqual(kit[role].skills, [...K.GAMEDEV_SKILLS]);
  }
  // A web project's default: docs, web search and git only.
  assert.deepEqual(S.toolkitFor({}, 'web-app').builder.tools, ['context7', 'websearch', 'git']);
});

test('validateToolkit refuses unknown roles, unknown tools, the fixed roles and bad skills', () => {
  assert.match(K.validateToolkit({ wizard: {} }).reason, /unknown toolkit role/);
  assert.match(K.validateToolkit({ builder: { tools: ['photoshop'] } }).reason, /unknown tool 'photoshop'/);
  assert.match(K.validateToolkit({ playtester: { tools: ['unity'] } }).reason, /fixed/);
  assert.match(K.validateToolkit({ director: { tools: [] } }).reason, /fixed/);
  assert.match(K.validateToolkit({ builder: { skills: ['../evil'] } }).reason, /bad skill/);
  assert.match(K.validateToolkit('all').reason, /must be an object/);
  // git always stays: a worker commits its work.
  assert.deepEqual(K.validateToolkit({ builder: { tools: ['unity'] } }).toolkit.builder.tools, ['unity', 'git']);
});

test('art folders must be absolute and outside the home folder root and ~/.claude', () => {
  const home = path.resolve(os.tmpdir(), 'fake-home');
  const art = path.join(home, 'Art', 'blade');
  assert.deepEqual(K.validateToolkit({ artDirs: [art] }, { home }).toolkit.artDirs, [art]);
  assert.match(K.validateToolkit({ artDirs: ['Art'] }, { home }).reason, /absolute/);
  assert.match(K.validateToolkit({ artDirs: [home] }, { home }).reason, /home folder/);
  assert.match(K.validateToolkit({ artDirs: [path.join(home, '.claude', 'x')] }, { home }).reason, /\.claude/);
  assert.match(K.validateToolkit({ artDirs: [path.parse(home).root] }, { home }).reason, /drive root/);
  assert.match(K.validateToolkit({ artDirs: [`${art}'x`] }, { home }).reason, /characters/);
});

test('a broken kit in the settings file reads as the default and never throws', () => {
  for (const junk of ['x', 42, [], { builder: { tools: ['nope'] } }, { playtester: {} }]) {
    const settings = { projects: { p: { profile: { adapter: 'unity' }, toolkit: junk } } };
    assert.deepEqual(S.toolkitFor(settings, 'p'), K.defaultToolkit('unity'));
  }
});

test('withProject stores a valid kit and spend caps, refuses a bad one and null removes it', () => {
  const { settings, reason } = S.withProject({}, 'p', { toolkit: { builder: { tools: ['unity'] } }, spendCaps: { meshy: 3 } });
  assert.equal(reason, null);
  assert.deepEqual(settings.projects.p.toolkit.builder.tools, ['unity', 'git']);
  assert.deepEqual(S.spendCapsFor(settings, 'p'), { higgsfield: K.DEFAULT_HIGGSFIELD_CAP_USD, meshy: 3 });
  assert.match(S.withProject(settings, 'p', { toolkit: { builder: { tools: ['x'] } } }).reason, /unknown tool/);
  assert.match(S.withProject(settings, 'p', { spendCaps: { comfyui: 1 } }).reason, /not a paid tool/);
  assert.match(S.withProject(settings, 'p', { spendCaps: { meshy: -1 } }).reason, /from 0 to/);
  assert.equal(S.withProject(settings, 'p', { toolkit: null, spendCaps: null }).settings.projects.p, undefined);
});

test('tool servers keep secrets out of the file: env and headers take only ${VAR} references', () => {
  assert.equal(K.validateToolServers(PC_SERVERS).reason, null);
  const literal = 'lit' + 'eral-value-'.repeat(3);
  assert.match(K.validateToolServers({ meshy: { command: 'npx', env: { MESHY_API_KEY: literal } } }).reason, /reference, never a value/);
  assert.match(K.validateToolServers({ comfyui: { type: 'http', url: 'http://u:p@host/mcp' } }).reason, /credentials/);
  assert.match(K.validateToolServers({ git: { command: 'x' } }).reason, /not an MCP tool/);
  // Lenient read: the bad entry is dropped, the good one kept.
  assert.deepEqual(Object.keys(S.normalizeSettings({ toolServers: { blender: PC_SERVERS.blender, meshy: { command: '' } } }).toolServers), ['blender']);
  assert.equal(hasLiteralSecret({ mcpServers: { a: { env: { K: literal } } } }), true);
  assert.equal(hasLiteralSecret({ mcpServers: { a: { env: { K: '${K}' } } } }), false);
});

// ---- the builder's kit for a blade&bullet-like Unity project ------------------------------

test('a blade&bullet builder gets Unity, Blender, Higgsfield, ComfyUI and Meshy in its --mcp-config plus the gamedev skills', () => {
  const dir = tmpDir();
  try {
    const toolsFor = createToolsFor({ readSettings: bladeSettings, dir: () => dir });
    const kit = toolsFor({ projectId: 'blade-bullet', repoPath: dir, role: 'builder' });
    const config = JSON.parse(fs.readFileSync(kit.mcpConfigPath, 'utf8'));
    for (const server of GAME_SERVERS) {
      assert.ok(config.mcpServers[server], `${server} in --mcp-config`);
      assert.ok(kit.allowedTools.includes(`mcp__${server}`), `${server} allowed`);
    }
    assert.ok(config.mcpServers.context7);
    assert.ok(kit.allowedTools.includes('Bash(higgsfield:*)'));
    assert.ok(kit.allowedTools.includes('Bash(blender:*)'));
    assert.ok(kit.allowedTools.includes('Bash(unity:*)'));
    assert.ok(kit.allowedTools.includes('WebSearch'));
    assert.deepEqual(kit.skills, [...K.GAMEDEV_SKILLS]);
    for (const skill of K.GAMEDEV_SKILLS) assert.ok(kit.note.includes(skill));
    // The key stays a reference: the file holds no secret value.
    assert.equal(config.mcpServers.meshy.env.MESHY_API_KEY, '${MESHY_API_KEY}');
    assert.equal(hasLiteralSecret(config), false);
    // The asset worker gets the same game tools.
    const asset = toolsFor({ projectId: 'blade-bullet', repoPath: dir, role: 'asset' });
    for (const server of GAME_SERVERS) assert.ok(asset.allowedTools.includes(`mcp__${server}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tool with no launch definition on this PC is still allowed and comes from the Claude setup', () => {
  const launch = K.roleLaunch(K.defaultToolkit('unity'), 'builder', {});
  assert.ok(launch.allowedTools.includes('mcp__unity'));
  assert.equal(launch.mcpConfig.mcpServers.unity, undefined);
  assert.ok(launch.fromClaudeSetup.includes('unity'));
  assert.deepEqual(Object.keys(launch.mcpConfig.mcpServers), ['context7']);
});

test('a tool out of the kit is denied by name', () => {
  const kit = K.normalizeToolkit({ builder: { tools: ['unity'] }, asset: { tools: ['unity'] } }, 'unity');
  const launch = K.roleLaunch(kit, 'builder', { toolServers: PC_SERVERS });
  assert.ok(launch.disallowedTools.includes('mcp__meshy'));
  assert.ok(launch.disallowedTools.includes('Bash(higgsfield:*)'));
  assert.ok(!launch.disallowedTools.includes('Bash(git:*)'));
  assert.deepEqual(Object.keys(launch.mcpConfig.mcpServers), ['unity']);
});

test('God Mode workers of a build get the kit per role: the scene worker is the asset role', () => {
  const calls = [];
  const builder = createGodModeBuilder({
    orchestra: { makePlan: () => new Promise(() => {}), launch: async () => ({ ok: true }), cancelPlanWait: () => {} },
    profileId: () => null,
    env: () => ({}),
    isUnityProject: () => false,
    toolsFor: (req) => {
      calls.push(req);
      return { allowedTools: ['mcp__unity'], disallowedTools: ['Bash(git rebase:*)'], mcpConfigPath: null, addDirs: [], note: 'kit' };
    },
  });
  assert.equal(builder.workerTools({ id: 'p1' }), null, 'no kit while idle');
  builder.build({ projectId: 'blade-bullet', repoPath: '/repo', cards: [{ at: 1, text: 'x' }], checkCommand: '', cappedTools: ['meshy'] });
  builder.workerTools({ id: 'p1' });
  builder.workerTools({ id: SCENE_WORKER_ID });
  assert.deepEqual(calls.map((c) => c.role), ['builder', 'asset']);
  assert.deepEqual(calls[0].capped, ['meshy']);
  assert.equal(calls[0].repoPath, '/repo');
});

// ---- the Playtester stays narrow ---------------------------------------------------------

test('the Playtester is not part of the kit and its argv is unchanged', () => {
  assert.equal(K.roleLaunch(K.defaultToolkit('unity'), 'playtester'), null);
  const tools = {
    mcpConfig: { mcpServers: { 'luna-playtest': { type: 'stdio', command: 'node', args: ['bridge.js'] } } },
    allowedTools: ['mcp__luna-playtest__screenshot', 'mcp__luna-playtest__press'],
  };
  const args = buildPlaytestArgs({ model: 'sonnet', tools });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--tools'), 'Read');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(at('--mcp-config'), JSON.stringify(tools.mcpConfig));
  assert.equal(at('--allowedTools'), 'mcp__luna-playtest__screenshot,mcp__luna-playtest__press,Read(./**)');
  assert.equal(
    at('--disallowedTools'),
    'Grep,Glob,Edit,MultiEdit,Write,NotebookEdit,Bash,PowerShell,WebFetch,WebSearch,Task,Agent,'
      + 'Read(./*.log),Read(./**/*.log),Read(./lighthouse/**),Read(./unity-*.json),Read(./.playtest-control.json)',
  );
  assert.equal(at('--permission-mode'), 'dontAsk');
  for (const server of GAME_SERVERS) assert.ok(!args.join(' ').includes(`mcp__${server}`));
});

// ---- guardrails -----------------------------------------------------------------------------

test('force-push and history rewrites are denied, ordinary git is not', () => {
  const denied = [
    'git push --force',
    'git push --force origin main',
    'git push -f origin main',
    'git push origin main --force',
    'git push origin main --force-with-lease',
    'git push --force-with-lease',
    'git push origin +main',
    'git reset --hard origin/main',
    'git rebase -i HEAD~3',
    'git rebase origin/main',
    'git filter-branch --tree-filter x',
    'git filter-repo --path x',
  ];
  for (const cmd of denied) assert.ok(K.isGuardedGitCommand(cmd), `denied: ${cmd}`);
  for (const cmd of ['git push origin luna/x', 'git push -u origin luna/x', 'git commit -m "feat: x"', 'git status', 'git pull --ff-only']) {
    assert.equal(K.isGuardedGitCommand(cmd), false, `allowed: ${cmd}`);
  }
  // On every kit role, whatever the kit.
  for (const role of K.KIT_ROLES) {
    const launch = K.roleLaunch(K.defaultToolkit('unity'), role);
    for (const rule of K.GIT_GUARD_RULES) assert.ok(launch.disallowedTools.includes(rule));
  }
});

test('the worker command carries the deny rules, the --mcp-config and the art folders', () => {
  const art = path.resolve(os.tmpdir(), 'art');
  const cfg = path.resolve(os.tmpdir(), 'tools', 'builder.local.json');
  const launch = K.roleLaunch(K.defaultToolkit('unity'), 'builder');
  const cmd = withTaskBrief('claude', {
    briefPath: path.resolve(os.tmpdir(), 'brief.md'),
    permissionMode: 'bypassPermissions',
    allowedTools: launch.allowedTools,
    disallowedTools: launch.disallowedTools,
    mcpConfigPath: cfg,
    addDirs: [art, 'relative/dir'],
  });
  assert.ok(cmd.includes("--disallowedTools 'Bash(git push --force:*)'"));
  assert.ok(cmd.includes("'Bash(git push *+*)'"));
  assert.ok(cmd.includes("'Edit(~/.claude/**)'"));
  assert.ok(cmd.includes("'mcp__higgsfield-bridge'"));
  assert.ok(cmd.includes(`--mcp-config '${cfg}'`));
  assert.ok(cmd.includes(`--add-dir '${art}'`));
  assert.ok(!cmd.includes('relative/dir'));
  // A rule that would break the single quotes is dropped.
  assert.ok(!withTaskBrief('claude', { briefPath: path.resolve('b.md'), disallowedTools: ["Bash(x';rm)"] }).includes('rm'));
});

test('writes only inside the repo and its art folders', () => {
  const repo = path.resolve(os.tmpdir(), 'repo');
  const art = path.resolve(os.tmpdir(), 'art');
  assert.equal(K.isWritablePath('Assets/Art/a.png', { repoPath: repo }), true);
  assert.equal(K.isWritablePath(path.join(art, 'a.blend'), { repoPath: repo, artDirs: [art] }), true);
  assert.equal(K.isWritablePath('../outside.txt', { repoPath: repo }), false);
  assert.equal(K.isWritablePath(path.join(os.homedir(), '.claude', 'x'), { repoPath: repo, artDirs: [art] }), false);
  assert.equal(K.isWritablePath('', { repoPath: repo }), false);
});

// ---- spend caps -------------------------------------------------------------------------------

test('checkSpend books under the cap and refuses past it', () => {
  const run = { spendCaps: { higgsfield: 5, meshy: 1 }, spend: { higgsfield: 4 } };
  const ok = K.checkSpend(run, 'higgsfield', 0.5);
  assert.equal(ok.ok, true);
  assert.equal(ok.spend.higgsfield, 4.5);
  assert.equal(run.spend.higgsfield, 4, 'the run is not mutated');
  const over = K.checkSpend(run, 'higgsfield', 1.5);
  assert.deepEqual([over.ok, over.reason, over.spent, over.cap], [false, 'capReached', 4, 5]);
  assert.equal(K.checkSpend(run, 'unity', 999).ok, true, 'free tools are never capped');
  assert.equal(K.checkSpend(run, 'meshy', -1).reason, 'badCost');
  assert.equal(K.checkSpend(run, 'meshy', Number.NaN).reason, 'badCost');
  assert.equal(K.checkSpend(run, 'dalle', 1).reason, 'unknownTool');
  // Defaults when the run has no caps.
  assert.equal(K.checkSpend({}, 'meshy', K.DEFAULT_MESHY_CAP_USD).ok, true);
  assert.equal(K.checkSpend({}, 'meshy', K.DEFAULT_MESHY_CAP_USD + 0.01).ok, false);
});

function guardHarness(fields = {}) {
  let run = { id: 'r1', projectId: 'p', ...cleanGuardFields({ spendCaps: { meshy: 2 } }), ...fields };
  const cards = [];
  const waits = [];
  const notices = [];
  const guard = createToolGuard({
    run: () => run,
    update: (f) => {
      run = { ...run, ...f };
    },
    logEvent: () => {},
    armWait: (until, reason) => waits.push({ until, reason }),
    fileCards: (c) => {
      cards.push(...c);
      return c.map((_, i) => i + 1);
    },
    now: () => 1000,
    onToolDown: [(_run, down) => notices.push(down)],
  });
  return { guard, cards, waits, notices, run: () => run };
}

test('a reached spend cap stops generation, files one card and denies the tool to later workers', () => {
  const h = guardHarness();
  assert.equal(h.guard.recordSpend({ tool: 'meshy', costUsd: 1.5 }).ok, true);
  assert.equal(h.run().spend.meshy, 1.5);
  const over = h.guard.recordSpend({ tool: 'meshy', costUsd: 1 });
  assert.deepEqual([over.ok, over.reason], [false, 'capReached']);
  assert.equal(h.guard.recordSpend({ tool: 'meshy', costUsd: 0.1 }).ok, false, 'stays stopped');
  assert.equal(h.cards.length, 1);
  assert.match(h.cards[0].text, /meshy spend cap reached/);
  assert.deepEqual(h.guard.cappedTools(), ['meshy']);
  const launch = K.roleLaunch(K.defaultToolkit('unity'), 'asset', { capped: h.guard.cappedTools(), toolServers: PC_SERVERS });
  assert.ok(launch.disallowedTools.includes('mcp__meshy'));
  assert.ok(!launch.allowedTools.includes('mcp__meshy'));
  assert.equal(launch.mcpConfig.mcpServers.meshy, undefined);
  assert.match(launch.note, /Spend cap reached, do not use: meshy/);
  assert.equal(h.guard.recordSpend('junk').ok, false);
});

test('a tool that is down pauses the run with a notification instead of retrying', () => {
  const h = guardHarness();
  const res = { ok: false, error: 'launchFailed', detail: 'Unity editor not open on C:/game, or com.unity.pipeline not installed' };
  assert.equal(h.guard.toolDown(res, 'playtester'), true);
  assert.deepEqual(h.waits, [{ until: 1000 + TOOL_DOWN_WAIT_MS, reason: TOOL_DOWN_REASON }]);
  assert.deepEqual(h.notices.map((n) => [n.tool, n.role]), [['unity', 'playtester']]);
  assert.equal(h.guard.toolDown({ ok: false, error: 'toolDown', tool: 'meshy' }, 'builder'), true);
  // Not a tool problem: left to the usual retry.
  assert.equal(h.guard.toolDown({ ok: false, error: 'planner failed' }, 'builder'), false);
  assert.equal(h.guard.toolDown({ ok: true }, 'builder'), false);
  assert.equal(h.waits.length, 2);
});
