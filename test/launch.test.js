// Tests for building the start command (src/launch.js).
//
// Why this file matters: withSessionId is the switch that decides whether a tab
// can be pinned to its transcript. A wrong `null` here does not fail loudly - it
// quietly restores the old timestamp guessing, and every other test stays green.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withSessionId, findExecutable } = require('../src/launch');

const UUID = '00000000-0000-0000-0000-000000000000';

// ---- findExecutable (D3) ----------------------------------------------------
// Drives the "Claude Code not found" notice. A false negative nags someone whose
// install is fine; a false positive leaves a newcomer with no explanation at all.

/** Fake filesystem: only the listed paths exist. */
const fsWith = (...present) => {
  const set = new Set(present.map((p) => p.toLowerCase()));
  return (p) => set.has(String(p).toLowerCase());
};

test('findExecutable finds claude.cmd on Windows (npm install)', () => {
  const PATH = 'C:\\Windows;C:\\Users\\x\\AppData\\Roaming\\npm';
  const hit = 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd';
  assert.equal(findExecutable('claude', PATH, true, fsWith(hit)), hit);
});

test('findExecutable finds an extensionless file on POSIX', () => {
  const hit = '/home/x/.local/bin/claude';
  assert.equal(findExecutable('claude', '/usr/bin:/home/x/.local/bin', false, fsWith(hit)), hit);
});

test('findExecutable returns null when the binary is nowhere to be found', () => {
  assert.equal(findExecutable('claude', 'C:\\Windows;C:\\Temp', true, fsWith()), null);
});

test('findExecutable survives an empty and a malformed PATH', () => {
  // Empty segments and quotes around directories are a normal sight in PATH
  // on Windows - they must not be able to break the search.
  const hit = 'C:\\bin\\claude.exe';
  assert.equal(findExecutable('claude', ';;"C:\\bin";', true, fsWith(hit)), hit);
  assert.equal(findExecutable('claude', '', true, fsWith(hit)), null);
  assert.equal(findExecutable('claude', undefined, true, fsWith(hit)), null);
});

test('findExecutable does not choke on an entry that throws', () => {
  // One unreadable directory must not make an existing binary look absent -
  // otherwise we would show a warning to someone who has everything set up fine.
  const hit = 'C:\\good\\claude.exe';
  const exists = (p) => {
    if (String(p).startsWith('C:\\bad')) throw new Error('EACCES');
    return p === hit;
  };
  assert.equal(findExecutable('claude', 'C:\\bad;C:\\good', true, exists), hit);
});

test('findExecutable prefers .exe/.cmd over the extensionless variant', () => {
  const dir = 'C:\\bin';
  const both = fsWith('C:\\bin\\claude.exe', 'C:\\bin\\claude');
  assert.equal(findExecutable('claude', dir, true, both), 'C:\\bin\\claude.exe');
});

test('withSessionId pins a plain claude launch', () => {
  // The default profile (config/profiles.json -> "claude-cloud") is exactly this
  // string. If this case ever returns null, pinning is dead app-wide.
  assert.equal(withSessionId('claude', UUID), `claude --session-id ${UUID}`);
});

test('withSessionId keeps the existing arguments', () => {
  assert.equal(
    withSessionId('claude --model opus', UUID),
    `claude --model opus --session-id ${UUID}`,
  );
});

test('withSessionId accepts a path or .exe/.cmd form of the binary', () => {
  for (const cmd of ['claude.exe', 'claude.cmd', 'C:\\Users\\x\\.local\\bin\\claude.exe']) {
    assert.ok(
      String(withSessionId(cmd, UUID)).includes(`--session-id ${UUID}`),
      `expected ${cmd} to be pinnable`,
    );
  }
});

test('withSessionId refuses an empty command (bare shell profile)', () => {
  assert.equal(withSessionId('', UUID), null);
  assert.equal(withSessionId('   ', UUID), null);
  assert.equal(withSessionId(undefined, UUID), null);
});

test('withSessionId refuses a program that is not claude', () => {
  // A profile may start anything; labelling a foreign process would be a lie.
  assert.equal(withSessionId('pwsh', UUID), null);
  assert.equal(withSessionId('npm start', UUID), null);
  assert.equal(withSessionId('claude-code-proxy', UUID), null);
});

test('withSessionId refuses when the session id is already decided', () => {
  // Resuming picks its own id; forcing ours would conflict or hijack it.
  for (const cmd of [
    'claude -c',
    'claude --continue',
    'claude -r abc',
    'claude --resume abc',
    'claude --fork-session',
    `claude --session-id ${UUID}`,
  ]) {
    assert.equal(withSessionId(cmd, UUID), null, `expected ${cmd} to be left alone`);
  }
});

test('withSessionId does not confuse a flag that merely contains a resume word', () => {
  // Substring matching here would wrongly disable pinning.
  assert.ok(String(withSessionId('claude --continue-on-error', UUID)).includes('--session-id'));
  assert.ok(String(withSessionId('claude --resumable', UUID)).includes('--session-id'));
});

test('withSessionId refuses without a uuid', () => {
  assert.equal(withSessionId('claude', ''), null);
  assert.equal(withSessionId('claude', undefined), null);
});

// ---- Antigravity CLI (agy) ------------------------------------------------------------
// agy takes its first prompt only through --prompt-interactive (a positional
// argument is ignored), resumes with --conversation=<id>, and has no flag to set
// a session id or pass MCP servers. Every claude string below is pinned: agy
// support must leave Claude launches byte-for-byte as they were.

const launch = require('../src/launch');

const BRIEF = 'C:\\cfg\\tasks\\pkg.md';
const BRIEF_MSG = "'Your task brief is in the file `C:\\cfg\\tasks\\pkg.md` - read it first, then carry it out.'";
const RESUME_ID = '38b6ac70-2dba-438b-afaf-8354bb8230db';

test('isAgyCommand knows agy, agy.exe and agy.cmd, with a path and in any case', () => {
  for (const cmd of [
    'agy',
    'agy.exe',
    'agy.cmd',
    'AGY',
    'Agy.EXE --mode plan',
    'C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe',
    '/usr/local/bin/agy -i hi',
    '"C:\\tools\\agy.cmd"',
    '  agy  ',
  ]) {
    assert.equal(launch.isAgyCommand(cmd), true, cmd);
  }
  for (const cmd of ['', '   ', undefined, null, 'claude', 'agy2', 'agyx.exe', 'my-agy', 'agy-cli', 'gemini', 'npx agy']) {
    assert.equal(launch.isAgyCommand(cmd), false, String(cmd));
  }
  assert.equal(launch.isClaudeCommand('agy'), false);
  assert.equal(launch.isAgyCommand('claude.exe'), false);
});

test('withTaskBrief hands an agy worker its brief through --prompt-interactive', () => {
  assert.equal(
    launch.withTaskBrief('agy', { briefPath: BRIEF }),
    `agy --prompt-interactive ${BRIEF_MSG} --add-dir 'C:\\cfg\\tasks'`,
  );
  // The prompt goes right after the binary; the profile's own args follow.
  assert.equal(
    launch.withTaskBrief('C:\\bin\\agy.exe --model gemini-3.8-flash-high', { briefPath: BRIEF }),
    `C:\\bin\\agy.exe --prompt-interactive ${BRIEF_MSG} --model gemini-3.8-flash-high --add-dir 'C:\\cfg\\tasks'`,
  );
});

test('withTaskBrief maps worker permission modes to agy syntax unless the profile decides them', () => {
  const task = (permissionMode, extra = {}) => ({ briefPath: BRIEF, permissionMode, ...extra });
  assert.match(launch.withTaskBrief('agy', task('acceptEdits')), / --mode accept-edits$/);
  assert.match(launch.withTaskBrief('agy', task('bypassPermissions')), / --dangerously-skip-permissions$/);
  assert.doesNotMatch(launch.withTaskBrief('agy', task('default')), /--mode|--dangerously/);
  assert.doesNotMatch(launch.withTaskBrief('agy', task('dontAsk')), /--mode|--dangerously/);
  // The profile already decides: nothing is added.
  assert.equal(launch.withTaskBrief('agy --mode plan', task('bypassPermissions')).match(/--mode|--dangerously/g).length, 1);
  assert.doesNotMatch(launch.withTaskBrief('agy --dangerously-skip-permissions', task('acceptEdits')), /--mode/);
  // agy cannot take deny rules: a task with any (even malformed ones) gets no
  // permission flag at all, so agy asks before every edit and command.
  for (const disallowedTools of [['Bash(git push:*)'], ['not a rule!'], ['Edit(src/secrets/*)', 'Write']]) {
    for (const mode of ['bypassPermissions', 'acceptEdits']) {
      const denied = launch.withTaskBrief('agy', task(mode, { disallowedTools }));
      assert.equal(denied, `agy --prompt-interactive ${BRIEF_MSG} --add-dir 'C:\\cfg\\tasks'`, `${mode} ${disallowedTools}`);
    }
  }
});

test('agy launch helpers refuse control characters that the PTY would read as keystrokes', () => {
  assert.equal(launch.withTaskBrief('agy', { briefPath: 'C:\\cfg\\tasks\\a\u0003b.md' }), null);
  // A first message with one falls back to the brief message.
  assert.equal(
    launch.withTaskBrief('agy', { briefPath: BRIEF }, 'go\u001bon'),
    `agy --prompt-interactive ${BRIEF_MSG} --add-dir 'C:\\cfg\\tasks'`,
  );
  assert.equal(launch.withMemoryCard('agy', 'C:\\cfg\\card\u0008.md'), 'agy');
  assert.equal(
    launch.withAccountResume('agy', RESUME_ID, null, 'go\u0003on'),
    `agy --prompt-interactive '${launch.AGY_RESUME_MESSAGE}' --conversation=${RESUME_ID}`,
  );
});

test('withTaskBrief drops Claude-only flags for agy and keeps the tool kit folders', () => {
  const cmd = launch.withTaskBrief('agy', {
    briefPath: BRIEF,
    model: 'opus',
    effort: 'xhigh',
    allowedTools: ['Bash(npm test)'],
    disallowedTools: [],
    mcpConfigPath: 'C:\\kit\\mcp.json',
    addDirs: ['C:\\art', 'relative\\dir', "C:\\it's"],
  });
  assert.doesNotMatch(cmd, /--model|--effort|--allowedTools|--disallowedTools|--mcp-config/);
  assert.match(cmd, / --add-dir 'C:\\art'$/, 'only absolute, quotable folders are added');
});

test('withTaskBrief refuses an agy command that brings its own prompt, a lockdown, or an unsafe brief path', () => {
  for (const cmd of ['agy -i hello', 'agy --prompt-interactive x', 'agy -p x', 'agy --print x', 'agy --prompt=x']) {
    assert.equal(launch.withTaskBrief(cmd, { briefPath: BRIEF }), null, cmd);
  }
  assert.equal(launch.withTaskBrief('agy', { briefPath: BRIEF, lockdown: { runSlug: 'x' } }), null);
  assert.equal(launch.withTaskBrief('agy', { briefPath: "C:\\it's.md" }), null);
  assert.equal(launch.withTaskBrief('agy', { briefPath: '' }), null);
});

test('withTaskBrief for claude is unchanged, and never passes --model agy', () => {
  assert.equal(
    launch.withTaskBrief('claude --verbose', { briefPath: BRIEF, model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }),
    `claude ${BRIEF_MSG} --verbose --add-dir 'C:\\cfg\\tasks' --model opus --effort high --permission-mode acceptEdits`,
  );
  assert.equal(launch.withTaskBrief('claude', { briefPath: BRIEF, model: 'agy' }), `claude ${BRIEF_MSG} --add-dir 'C:\\cfg\\tasks'`);
  assert.equal(launch.withTaskBrief('codex', { briefPath: BRIEF }), null);
});

test('withSessionId never pins an agy tab: agy cannot set a session id', () => {
  assert.equal(withSessionId('agy', UUID), null);
  assert.equal(withSessionId('agy.exe --mode plan', UUID), null);
});

test('withPlainResume reopens an agy conversation with --conversation=<id>', () => {
  assert.equal(launch.withPlainResume('agy', RESUME_ID), `agy --conversation=${RESUME_ID}`);
  assert.equal(launch.withPlainResume('agy --mode plan', RESUME_ID), `agy --mode plan --conversation=${RESUME_ID}`);
  assert.equal(launch.withPlainResume('agy', 'not-a-uuid'), null);
  for (const cmd of ['agy --continue', 'agy -c', `agy --conversation=${RESUME_ID}`, 'agy --conversation x']) {
    assert.equal(launch.withPlainResume(cmd, RESUME_ID), null, cmd);
  }
  // Claude unchanged.
  assert.equal(launch.withPlainResume('claude --model opus', RESUME_ID), `claude --model opus --resume ${RESUME_ID}`);
  assert.equal(launch.withPlainResume('claude -c', RESUME_ID), null);
});

test('withAccountResume resumes an agy conversation with a neutral message, keeping a worker brief flags', () => {
  assert.equal(
    launch.withAccountResume('agy', RESUME_ID),
    `agy --prompt-interactive '${launch.AGY_RESUME_MESSAGE}' --conversation=${RESUME_ID}`,
  );
  assert.doesNotMatch(launch.AGY_RESUME_MESSAGE, /Claude|['`]/);
  assert.equal(
    launch.withAccountResume('agy', RESUME_ID, { briefPath: BRIEF, permissionMode: 'acceptEdits' }, 'Go on.'),
    `agy --prompt-interactive 'Go on.' --add-dir 'C:\\cfg\\tasks' --mode accept-edits --conversation=${RESUME_ID}`,
  );
  // An unsafe message falls back to the neutral one.
  assert.match(launch.withAccountResume('agy', RESUME_ID, null, "it's"), new RegExp(launch.AGY_RESUME_MESSAGE));
  assert.equal(launch.withAccountResume('agy --continue', RESUME_ID), null);
  assert.equal(launch.withAccountResume('agy -i hi', RESUME_ID), null);
  assert.equal(launch.withAccountResume('agy', 'nope'), null);
  assert.equal(launch.withAccountResume('agy', RESUME_ID, { briefPath: BRIEF, lockdown: { runSlug: 'x' } }), null);
  // A worker whose flags cannot be rebuilt is not resumed without them.
  assert.equal(launch.withAccountResume('agy', RESUME_ID, { permissionMode: 'bypassPermissions' }), null);
  assert.equal(launch.withAccountResume('agy', RESUME_ID, { briefPath: "C:\\it's.md", permissionMode: 'acceptEdits' }), null);
  // Claude unchanged.
  assert.equal(
    launch.withAccountResume('claude', RESUME_ID),
    `claude '${launch.ACCOUNT_RESUME_MESSAGE}' --resume ${RESUME_ID}`,
  );
});

test('withMemoryCard gives a plain agy tab the card as its first prompt', () => {
  const card = 'C:\\cfg\\memory-card-s3.local.md';
  const carded = launch.withMemoryCard('agy --mode plan', card);
  assert.match(carded, /^agy --prompt-interactive 'Read the LunaCore project memory card in the file `C:\\cfg\\memory-card-s3\.local\.md`\. /);
  assert.match(carded, / --mode plan --add-dir 'C:\\cfg'$/);
  assert.equal(launch.memoryCardLoaded('agy --mode plan', carded), true);
  // A first prompt already there (a worker brief) or a resumed conversation: no card.
  const briefed = launch.withTaskBrief('agy', { briefPath: BRIEF });
  assert.equal(launch.withMemoryCard(briefed, card), briefed);
  assert.equal(launch.withMemoryCard(`agy --conversation=${RESUME_ID}`, card), `agy --conversation=${RESUME_ID}`);
  assert.equal(launch.withMemoryCard('agy', "C:\\it's.md"), 'agy');
  assert.equal(launch.withMemoryCard('agy', null), 'agy');
  // Claude unchanged.
  assert.equal(launch.withMemoryCard('claude', card), `claude --append-system-prompt-file '${card}'`);
});

test('withIntakeMcp leaves agy alone; intakeState reads the agy registration instead', () => {
  assert.equal(launch.withIntakeMcp('agy', 'C:\\cfg\\mcp-intake-s1.local.json'), 'agy');
  assert.equal(launch.intakeState('agy', 'agy', true), 'ready');
  assert.equal(launch.intakeState('agy', 'agy', false), 'off');
  assert.equal(launch.intakeState('agy', 'agy'), 'off');
  assert.equal(launch.intakeState('agy.exe', 'agy.exe', 'yes'), 'off', 'only the boolean true counts');
  // Claude ignores the flag.
  assert.equal(launch.intakeState('claude', 'claude', true), 'off');
  assert.equal(launch.intakeState('claude', "claude --mcp-config 'C:/x.json'"), 'ready');
  assert.equal(launch.intakeState('pwsh', 'pwsh', true), 'none');
});

// ---- memoryCardLoaded --------------------------------------------------------------

test('memoryCardLoaded is true only when withMemoryCard really attached the card', () => {
  const { withMemoryCard: attach, memoryCardLoaded } = require('../src/launch.js');
  const card = 'C:\cfg\memory-card-s1.local.md';

  assert.equal(memoryCardLoaded('claude', attach('claude', card)), true);
  assert.equal(memoryCardLoaded('claude', attach('claude', null)), false);
  assert.equal(memoryCardLoaded('claude --bare', attach('claude --bare', card)), false);
  assert.equal(memoryCardLoaded('  claude  ', attach('  claude  ', null)), false, 'trimming alone is not a card');
  assert.equal(memoryCardLoaded('claude', undefined), false);
});
