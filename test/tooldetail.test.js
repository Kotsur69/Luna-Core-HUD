// Tests for the sanitized tool-call `detail` (src/tooldetail.js) and its use on
// the Claude path's metrics:tools start events (src/observer.js). Every input
// that looks like a credential or an environment value must come out masked,
// and every detail is at most MAX_DETAIL_CHARS long.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_DETAIL_CHARS, scrubSecrets, commandSummary, safeLabel, claudeToolDetail } = require('../src/tooldetail');
const { toolEventsFromLines, foldToolEvents } = require('../src/observer');

const SECRETS = Object.freeze({
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  openai: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  aws: 'AKIAABCDEFGHIJKLMNOP',
  google: 'AIzaSyAbcdefghijklmnopqrstuvwxyz0123456',
  slack: 'xoxb-1234567890-abcdefghij',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  random: 'Zx9qL2mP8vR4tY6wK1nB3cD5fG7hJ0aS',
});

/** True when no secret value (nor a recognizable piece of one) survived. */
function leaks(text) {
  return Object.values(SECRETS).some((s) => text.includes(s.slice(0, 12)) || text.includes(s.slice(-12)));
}

// ---- shell commands -------------------------------------------------------------

test('commandSummary keeps the binary and allowlisted arguments only', () => {
  assert.equal(commandSummary('npm test'), 'npm test');
  assert.equal(commandSummary('git status --short'), 'git status --short');
  assert.equal(commandSummary('npm run build'), 'npm run build');
  assert.equal(commandSummary('node server.js --watch'), 'node server.js --watch');
  assert.equal(commandSummary('node test/agytranscript.test.js'), 'node test/agytranscript.test.js', 'a script path');
  // A word after a flag may be the flag's value: never shown.
  assert.equal(commandSummary('node --test test/agytranscript.test.js'), 'node --test');
  assert.equal(commandSummary('npx vite --port 5173'), 'npx vite --port');
  assert.equal(commandSummary('node -e "console.log(6*7)"'), 'node -e', 'a quoted argument ends the summary');
  assert.equal(commandSummary('"C:\\Program Files\\nodejs\\node.exe" server.js'), 'node server.js');
  assert.equal(commandSummary('Get-ChildItem -Force; [System.IO.File]::ReadAllBytes(\'x\')'), 'Get-ChildItem', '-Force looks like -pSECRET');
  assert.equal(commandSummary('npm run test:unit'), 'npm run', 'a word with a colon is not shown');
});

test('commandSummary leaks no secret that looks like a plain argument', () => {
  const cases = {
    'curl -u admin:hunter2 host': 'curl -u',
    'mysql -phunter2 db': 'mysql',
    'mysql -p hunter2': 'mysql -p',
    'sshpass -p hunter2 ssh h': 'sshpass -p',
    'docker login -u me -p hunter2': 'docker login',
    'docker login -u me -phunter2': 'docker login',
    'npm publish --otp 123456': 'npm publish',
    'echo hunter2 | sudo -S ls': 'echo',
    'printf hunter2': 'printf',
    'curl https://hooks.slack.com/services/T1/B2/xyz': 'curl',
    'git clone https://user:pw@example.com/r.git': 'git clone',
    'ssh deploy@10.0.0.5': 'ssh',
    'tool ../../etc/passwd.sh': 'tool',
    'redis-cli auth hunter': 'redis-cli auth',
    'mysqladmin password newsecret': 'mysqladmin password',
    'vault login myroottoken': 'vault login',
    'gh auth login': 'gh auth',
  };
  for (const [command, expected] of Object.entries(cases)) assert.equal(commandSummary(command), expected, command);
});

test('the scrubber stays fast on hostile input (no catastrophic backtracking)', () => {
  const payloads = [
    'token'.repeat(800), '-token-'.repeat(580), 'a'.repeat(4096), 'a-'.repeat(2048), 'A_'.repeat(2048),
    'Bearer '.repeat(600), 'x=token:'.repeat(500), `https://a.b/${'?'.repeat(4000)}`, '--password '.repeat(400),
  ];
  const started = process.hrtime.bigint();
  for (const p of payloads) {
    scrubSecrets(p);
    commandSummary(p);
    safeLabel(p);
    claudeToolDetail('Grep', { pattern: p });
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Before the fix one of these took 22 s; all of them together now take milliseconds.
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});

test('commandSummary skips set-up segments and environment assignments', () => {
  assert.equal(commandSummary('cd src && npm run build -- --watch'), 'npm run build');
  assert.equal(commandSummary(`export OPENAI_API_KEY=${SECRETS.openai}; python run.py`), 'python run.py');
  assert.equal(commandSummary(`GITHUB_TOKEN=${SECRETS.github} gh pr list`), 'gh pr list');
  assert.equal(commandSummary('$env:API_KEY="hunter2"; npm start'), 'npm start');
  assert.equal(commandSummary('cd src'), 'cd src', 'a lone set-up segment is still something');
});

test('commandSummary never shows a token, a password or an env value', () => {
  const cases = [
    `gh auth login --with-token ${SECRETS.github}`,
    `curl -H "Authorization: Bearer ${SECRETS.openai}" https://u:p@api.x.com/v1?key=zzz`,
    'mysql --password secret123 -u root',
    'docker run --env PASSWORD=hunter2 img',
    `echo ${SECRETS.anthropic}`,
    `python script.py ${SECRETS.random}`,
    `aws configure set aws_access_key_id ${SECRETS.aws}`,
    `deploy --api-key=${SECRETS.google}`,
  ];
  for (const command of cases) {
    const summary = commandSummary(command);
    assert.ok(!leaks(summary), `${command} -> ${summary}`);
    assert.doesNotMatch(summary, /secret123|hunter2|zzz|u:p@/, summary);
    assert.ok(summary.length <= MAX_DETAIL_CHARS);
  }
  assert.equal(commandSummary('mysql --password secret123 -u root'), 'mysql');
});

test('commandSummary of nothing usable is empty', () => {
  for (const value of [undefined, null, 42, {}, '', '   ', '"just a string"', '$(evil)']) {
    assert.equal(commandSummary(value), '', String(value));
  }
});

// ---- scrubbing ------------------------------------------------------------------

test('scrubSecrets masks credential shapes and keeps ordinary text', () => {
  assert.equal(scrubSecrets('token=abc123 in file'), 'token=[redacted] in file');
  assert.equal(scrubSecrets('password: hunter2'), 'password: [redacted]');
  assert.equal(scrubSecrets('https://x.com/a?sig=1234'), 'https://x.com/a?[redacted]');
  assert.equal(scrubSecrets('src/renderer/modules/workmapmodel.js'), 'src/renderer/modules/workmapmodel.js');
  assert.equal(scrubSecrets('TODO|FIXME'), 'TODO|FIXME');
  for (const secret of Object.values(SECRETS)) {
    assert.ok(!leaks(scrubSecrets(`value ${secret} end`)), secret);
  }
  assert.ok(!leaks(scrubSecrets(`--token ${SECRETS.random}`)));
  assert.ok(!scrubSecrets('postgres://admin:s3cretPass@db:5432/app').includes('s3cretPass'));
});

test('scrubSecrets drops control and line-separator characters and caps the length', () => {
  assert.equal(scrubSecrets('foo\u2028bar\u0007baz\nqux'), 'foo bar baz qux');
  const long = scrubSecrets('a'.repeat(500));
  assert.equal(long.length, MAX_DETAIL_CHARS);
  assert.ok(long.endsWith('\u2026'));
  assert.equal(scrubSecrets(undefined), '');
});

test('safeLabel keeps a short plain label', () => {
  assert.equal(safeLabel('ecc:typescript-reviewer'), 'ecc:typescript-reviewer');
  assert.equal(safeLabel('research: List Line Counter'), 'research: List Line Counter');
  assert.equal(safeLabel('<img src=x onerror=alert(1)>'), 'img srcx onerroralert(1)');
  assert.ok(safeLabel('x'.repeat(200)).length <= 60);
  assert.equal(safeLabel(7), '');
});

// ---- the Claude path ---------------------------------------------------------------

test('claudeToolDetail: shell summary, agent type, search pattern; nothing for the rest', () => {
  assert.equal(claudeToolDetail('Bash', { command: 'npm test -- --watch' }), 'npm test', 'a bare -- ends the summary');
  assert.equal(claudeToolDetail('PowerShell', { command: 'git status' }), 'git status');
  assert.equal(claudeToolDetail('Task', { subagent_type: 'ecc:planner', prompt: 'secret plans' }), 'ecc:planner');
  assert.equal(claudeToolDetail('Agent', { name: 'reviewer' }), 'reviewer');
  assert.equal(claudeToolDetail('Grep', { pattern: 'MEMORY_SERVER' }), 'MEMORY_SERVER');
  assert.equal(claudeToolDetail('Glob', { pattern: '**/*.test.js' }), '**/*.test.js');
  assert.ok(!leaks(claudeToolDetail('Grep', { pattern: `api_key=${SECRETS.openai}` })));
  assert.equal(claudeToolDetail('Read', { file_path: '/x' }), '');
  assert.equal(claudeToolDetail('Bash', null), '');
});

test('observer start events carry the sanitized detail through foldToolEvents; ends do not', () => {
  const entry = (content) => JSON.stringify({ timestamp: '2026-11-22T10:00:00Z', message: { content } });
  const text = [
    entry([
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: `GITHUB_TOKEN=${SECRETS.github} npm test` } },
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/a.js' } },
    ]),
    entry([{ type: 'tool_result', tool_use_id: 'b1' }]),
  ].join('\n');
  const events = foldToolEvents(new Map(), toolEventsFromLines(text));
  const [bash, read] = events.filter((e) => e.phase === 'start');
  assert.equal(bash.detail, 'npm test');
  assert.equal('detail' in read, false, 'no detail key when there is nothing to say');
  assert.equal('detail' in events.find((e) => e.phase === 'end'), false);
  assert.ok(!leaks(JSON.stringify(events)));
});

// ---- errorPrefix and the Skill detail (Live Work Map) ---------------------------

const { errorPrefix, MAX_ERROR_PREFIX_CHARS } = require('../src/tooldetail');

test('errorPrefix reads a string or text parts, one line, at most MAX_ERROR_PREFIX_CHARS', () => {
  assert.equal(MAX_ERROR_PREFIX_CHARS, 160);
  assert.equal(errorPrefix('Exit code 1\n\tboom'), 'Exit code 1 boom');
  assert.equal(errorPrefix([{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }]), 'one two');
  assert.ok(errorPrefix('x'.repeat(1000)).length <= 160);
  assert.equal(errorPrefix(undefined), '');
  assert.equal(errorPrefix({ text: 'not a list' }), '');
});

test('errorPrefix masks a secret in the message (built at run time, never a literal)', () => {
  const secret = ['sk', '-ant-api03-'].join('') + 'Zq9'.repeat(10);
  const out = errorPrefix(`request failed: Authorization failed for ${secret}`);
  assert.ok(!out.includes(secret));
  assert.ok(out.startsWith('request failed'));
});

test('the Skill tool detail is the skill name, scrubbed like any label', () => {
  assert.equal(claudeToolDetail('Skill', { skill: 'ecc:plan' }), 'ecc:plan');
  assert.equal(claudeToolDetail('Skill', {}), '');
  assert.equal(claudeToolDetail('Skill', null), '');
});
