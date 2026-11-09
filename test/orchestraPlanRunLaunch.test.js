'use strict';

// Free God Mode v2 plan runs - the worker lockdown (slice F1c).

const test = require('node:test');
const assert = require('node:assert/strict');

const { withTaskBrief, withAccountResume } = require('../src/launch');
const lock = require('../src/orchestraPlanRunLaunch');

const BRIEF = '/runs/p1/briefs/core.md';
const BRIEF_MSG = "'Your task brief is in the file `/runs/p1/briefs/core.md` - read it first, then carry it out.'";
const UUID = '0123abcd-4567-89ab-cdef-0123456789ab';

test('allow-list is exactly the read tools, read-only Playwright and one Edit rule', () => {
  assert.deepEqual(lock.planAllowedTools('auth-redesign'), [
    'Read',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'mcp__playwright__browser_navigate',
    'mcp__playwright__browser_snapshot',
    'mcp__playwright__browser_evaluate',
    'Edit(docs/plans/auth-redesign/**)',
  ]);
});

test('allow-list never carries Write, Bash or a form tool', () => {
  const rules = lock.planAllowedTools('x-run');
  for (const r of rules) {
    assert.doesNotMatch(r, /^(Write|Bash|PowerShell|NotebookEdit)\b/);
    assert.doesNotMatch(r, /fill_form|_type$|file_upload|select_option|run_code|download/);
  }
});

test('allow-list refuses a bad slug instead of building a rule from it', () => {
  assert.throws(() => lock.planAllowedTools('../etc'));
  assert.throws(() => lock.planAllowedTools(''));
  assert.throws(() => lock.planAllowedTools('a/**'));
});

test('deny-list blocks the shell and every writing Playwright tool', () => {
  assert.deepEqual([...lock.DENIED_TOOLS], [
    'Bash',
    'PowerShell',
    'NotebookEdit',
    'mcp__playwright__browser_fill_form',
    'mcp__playwright__browser_type',
    'mcp__playwright__browser_file_upload',
    'mcp__playwright__browser_select_option',
    'mcp__playwright__browser_run_code',
    'mcp__playwright__browser_install',
    'Task',
    'Agent',
  ]);
  assert.deepEqual([...lock.PLAN_TOOLS], ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Edit', 'Write']);
  for (const t of lock.DENIED_TOOLS) assert.ok(!lock.planAllowedTools('r').includes(t));
});

test('plan worker command: brief launch + dontAsk + allow + deny, byte for byte', () => {
  const task = lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'auth-redesign' });
  assert.equal(
    lock.workerLaunchCommand('claude', task),
    `claude ${BRIEF_MSG} --add-dir '/runs/p1/briefs' --restricted --strict-mcp-config ` +
      "--tools 'Read,Glob,Grep,WebSearch,WebFetch,Edit,Write' --permission-mode dontAsk --allowedTools " +
      "'Read' 'Glob' 'Grep' 'WebSearch' 'WebFetch' 'mcp__playwright__browser_navigate' " +
      "'mcp__playwright__browser_snapshot' 'mcp__playwright__browser_evaluate' " +
      "'Edit(docs/plans/auth-redesign/**)' --disallowedTools 'Bash' 'PowerShell' 'NotebookEdit' " +
      "'mcp__playwright__browser_fill_form' 'mcp__playwright__browser_type' " +
      "'mcp__playwright__browser_file_upload' 'mcp__playwright__browser_select_option' " +
      "'mcp__playwright__browser_run_code' 'mcp__playwright__browser_install' 'Task' 'Agent'",
  );
});

test('plan worker command loads only the Playwright MCP config it is given', () => {
  const task = lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'r1', mcpConfigPath: '/cfg/tasks/luna-plan-mcp.json' });
  assert.deepEqual(task.lockdown, { runSlug: 'r1', mcpConfigPath: '/cfg/tasks/luna-plan-mcp.json' });
  const cmd = lock.workerLaunchCommand('claude', task);
  assert.ok(cmd.includes("--strict-mcp-config --tools 'Read,Glob,Grep,WebSearch,WebFetch,Edit,Write' --mcp-config '/cfg/tasks/luna-plan-mcp.json' --permission-mode dontAsk"));
  // Without a config file: no MCP server at all, still locked down.
  assert.doesNotMatch(lock.workerLaunchCommand('claude', lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'r1' })), /--mcp-config/);
  // A config path that could break the quoting refuses the worker.
  for (const bad of ["/cfg/it's.json", '/cfg/$x.json', '/cfg/a`b.json', 42]) {
    const t = { ...task, lockdown: { runSlug: 'r1', mcpConfigPath: bad } };
    assert.equal(lock.workerLaunchCommand('claude', t), lock.REFUSED_COMMAND, String(bad));
  }
});

test('planMcpConfig: Playwright only, headless, isolated profile', () => {
  assert.deepEqual(lock.planMcpConfig(), {
    mcpServers: { playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest', '--headless', '--isolated'] } },
  });
});

test('a restarted or failed-over plan worker tab relaunches locked down, never unlocked', () => {
  const task = lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'r1' });
  assert.equal(lock.lockedRestartCommand('claude', task), lock.workerLaunchCommand('claude', task));
  assert.match(lock.lockedRestartCommand('claude', task), /--restricted .*--permission-mode dontAsk/);
  assert.equal(lock.lockedRestartCommand('claude --dangerously-skip-permissions', task), lock.REFUSED_COMMAND);
  assert.equal(lock.lockedRestartCommand('codex', task), lock.REFUSED_COMMAND);
  // Any other tab restarts exactly as before (null = the profile command).
  assert.equal(lock.lockedRestartCommand('claude', { briefPath: BRIEF }), null);
  assert.equal(lock.lockedRestartCommand('claude', null), null);
});

test('main.js never starts a plan worker tab with the bare profile command', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /lockedRestartCommand\(profileCommand, session\.launchTask \|\| null\)/);
});

test('plan worker command keeps harmless profile flags and adds no model flag', () => {
  const task = lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'r1' });
  const cmd = lock.workerLaunchCommand('claude --verbose', task);
  assert.ok(cmd.startsWith(`claude ${BRIEF_MSG} --verbose --add-dir`));
  assert.doesNotMatch(cmd, /--model|--effort|acceptEdits|bypassPermissions/);
});

test('a profile that decides permissions or tools never gets a worker started', () => {
  const task = lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'r1' });
  for (const profile of [
    'claude --permission-mode bypassPermissions',
    'claude --dangerously-skip-permissions',
    'claude --allow-dangerously-skip-permissions',
    'claude --allowedTools Bash',
    'claude --allowed-tools=Bash',
    'claude --disallowedTools Read',
    'claude --settings ./s.json',
    'claude --permission-prompt-tool mcp__x__y',
    'claude --setting-sources user',
    'claude --tools Bash',
    'claude --mcp-config ./evil.json',
    'claude --plugin-dir ./p',
  ]) {
    assert.equal(lock.withPlanLockdown(profile, task), null, profile);
    assert.equal(lock.workerLaunchCommand(profile, task), lock.REFUSED_COMMAND, profile);
    assert.equal(lock.canLockdown(profile), false, profile);
  }
});

test('a non-claude profile is refused, never started unlocked', () => {
  const task = lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'r1' });
  assert.equal(lock.workerLaunchCommand('codex', task), lock.REFUSED_COMMAND);
  assert.equal(lock.workerLaunchCommand('', task), lock.REFUSED_COMMAND);
  assert.equal(lock.canLockdown('aider'), false);
  assert.equal(lock.canLockdown('claude'), true);
});

test('an unsafe brief path or a tampered slug falls back to the refusal', () => {
  const bad = { ...lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'r1' }), briefPath: "/runs/it's.md" };
  assert.equal(lock.workerLaunchCommand('claude', bad), lock.REFUSED_COMMAND);
  const tampered = { briefPath: BRIEF, lockdown: { runSlug: '../x' } };
  assert.equal(lock.workerLaunchCommand('claude', tampered), lock.REFUSED_COMMAND);
});

test('the refusal command starts nothing and has no nested quote', () => {
  assert.match(lock.REFUSED_COMMAND, /^echo '[^']*'$/);
  assert.doesNotMatch(lock.REFUSED_COMMAND, /claude/i);
});

test('build and Claude worker launch args are byte-for-byte unchanged', () => {
  const build = { briefPath: BRIEF, model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', allowedTools: ['Bash(npm test)'] };
  const expected =
    `claude ${BRIEF_MSG} --add-dir '/runs/p1/briefs' --model sonnet --effort high ` +
    "--permission-mode acceptEdits --allowedTools 'Bash(npm test)'";
  assert.equal(withTaskBrief('claude', build), expected);
  assert.equal(lock.workerLaunchCommand('claude', build), expected);

  const plain = { briefPath: BRIEF, model: null, effort: null, permissionMode: null };
  assert.equal(withTaskBrief('claude', plain), `claude ${BRIEF_MSG} --add-dir '/runs/p1/briefs'`);
  assert.equal(lock.workerLaunchCommand('claude', plain), withTaskBrief('claude', plain));

  // Free God Mode build workers (luna-free/) take the same path.
  const free = { briefPath: BRIEF, model: 'auto:easy', effort: null, permissionMode: 'bypassPermissions' };
  assert.equal(lock.workerLaunchCommand('claude --verbose', free), withTaskBrief('claude --verbose', free));
});

test('a non-claude build profile still yields null (caller starts the profile as before)', () => {
  assert.equal(lock.workerLaunchCommand('codex', { briefPath: BRIEF }), null);
});

test('launch.js never builds a plain or resumed command for a lockdown task', () => {
  const task = lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'r1' });
  assert.equal(withTaskBrief('claude', task), null);
  assert.equal(withAccountResume('claude', UUID, task), null);
  // Unchanged for a build task.
  assert.match(withAccountResume('claude', UUID, { briefPath: BRIEF }), new RegExp(`--resume ${UUID}$`));
});

test('planWorkerTask: no model, no effort, dontAsk, own allow-list, lockdown slug', () => {
  const task = lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'r1' });
  assert.deepEqual(task, {
    briefPath: BRIEF,
    model: null,
    effort: null,
    permissionMode: 'dontAsk',
    allowedTools: lock.planAllowedTools('r1'),
    lockdown: { runSlug: 'r1', mcpConfigPath: null },
  });
  assert.ok(lock.isLockdownTask(task));
  assert.ok(!lock.isLockdownTask({ briefPath: BRIEF }));
  assert.ok(!lock.isLockdownTask(null));
  assert.throws(() => lock.planWorkerTask({ briefPath: BRIEF, runSlug: 'Bad Slug' }), TypeError);
});

test('isSafePlanBranch mirrors the luna-free prefix-safety rules', () => {
  assert.equal(lock.isSafePlanBranch('luna-plan/auth-topic', 'main'), true);
  assert.equal(lock.planBranchName('auth-topic'), 'luna-plan/auth-topic');
  assert.equal(lock.isSafePlanBranch('luna-plan/', 'main'), false);
  assert.equal(lock.isSafePlanBranch('luna-plan/a..b', 'main'), false);
  assert.equal(lock.isSafePlanBranch('luna-free/a', 'main'), false);
  assert.equal(lock.isSafePlanBranch('luna/a', 'main'), false);
  assert.equal(lock.isSafePlanBranch('main', 'main'), false);
  assert.equal(lock.isSafePlanBranch('master', 'dev'), false);
  assert.equal(lock.isSafePlanBranch('luna-plan/x', 'luna-plan/x'), false);
  assert.equal(lock.isSafePlanBranch(null, 'main'), false);
  assert.equal(lock.isSafePlanBranch(42, 'main'), false);
});

test('planRunSettings fixes profile, integration, prefix and permission mode', () => {
  assert.deepEqual(lock.planRunSettings({ profileExists: false }), { ok: false, error: 'noPlanProfile' });
  assert.deepEqual(lock.planRunSettings({}), { ok: false, error: 'noPlanProfile' });
  assert.deepEqual(lock.planRunSettings({ profileExists: true }), {
    ok: true,
    profileId: 'freellm-auto',
    integrationMode: 'branches',
    branchPrefix: 'luna-plan/',
    permissionMode: 'dontAsk',
  });
});

test('planIntegrationFor pins plan runs to branches and leaves other runs alone', () => {
  assert.equal(lock.planIntegrationFor({ planRun: { runSlug: 'r' } }, 'merge'), 'branches');
  assert.equal(lock.planIntegrationFor({}, 'merge'), 'merge');
  assert.equal(lock.planIntegrationFor(null, 'pr'), 'pr');
});

test('planProfileFrom finds freellm-auto and copies its env', () => {
  const env = { ANTHROPIC_MODEL: 'auto:easy' };
  const p = lock.planProfileFrom([{ id: 'claude', command: 'claude' }, { id: 'freellm-auto', command: 'claude', args: ['--verbose'], env }]);
  assert.deepEqual(p, { id: 'freellm-auto', command: 'claude --verbose', env: { ANTHROPIC_MODEL: 'auto:easy' } });
  assert.notEqual(p.env, env);
  assert.equal(lock.planProfileFrom([{ id: 'claude', command: 'claude' }]), null);
  assert.equal(lock.planProfileFrom(null), null);
  assert.deepEqual(lock.planProfileFrom([{ id: 'freellm-auto', command: 'claude' }]).env, {});
});

test('planBriefText: writes only in the plan folder, no shell, ends with the done line', () => {
  const pkg = { id: 'topic-auth', title: 'Auth topic', prompt: 'Research auth.', planRun: { runSlug: 'r1', role: 'topic' } };
  const text = lock.planBriefText(pkg, 'luna-plan/r1-topic-auth');
  assert.match(text, /docs\/plans\/r1\//);
  assert.match(text, /LUNA_DONE topic-auth/);
  assert.match(text, /LUNA_BLOCKED topic-auth/);
  assert.doesNotMatch(text, /npm test|git commit/);
  assert.match(lock.planBriefText(pkg, 'b', { resume: true }), /RESUMING/);
  assert.match(lock.planBriefText(pkg, 'b', { escalation: { reason: 'idle', detail: null } }), /ESCALATED/);
  assert.match(lock.planBriefText(pkg, 'b', { depMerge: { branches: ['x'] } }), /could not be merged/);
});
