// ============================================================================
// LunaCore - building the session start command
// ----------------------------------------------------------------------------
// Pure string logic, deliberately kept out of main.js so it can be tested
// without booting Electron.
//
// This decides whether a session can be PINNED. Transcripts are named after the
// session id, so when we pass `--session-id <uuid>` ourselves we know the exact
// file a tab writes to. Without it the watcher has to infer ownership from file
// timestamps - and two sessions started seconds apart in one folder race, which
// is what made an Opus tab show a Sonnet tab's numbers.
//
// If this function wrongly refuses, nothing crashes: the app just silently falls
// back to the old guessing. That is precisely why it is unit-tested.
// ============================================================================

'use strict';

const path = require('path');
const { isEffort } = require('./efforts');
const { isAgyModel, agyModelIdOf } = require('./workerModels');
const { relativeBriefPath } = require('./workerBrief');

// Flags meaning "the session id is already decided" - the CLI resumes an
// existing conversation, or the profile stated an id itself. Adding a second
// --session-id would either conflict or quietly override the user's intent.
const SESSION_ID_DECIDED =
  /(^|\s)(-c|--continue|-r|--resume|--from-pr|--fork-session|--session-id)(\s|$)/;

// ---- Antigravity CLI (`agy`) --------------------------------------------------
// agy's flags, taken from the strings and changelog built into agy.exe 1.5.9 on
// 2026-11-16: `agy --help` printed nothing on this machine (it hung, also in a
// pseudo-console), so none of this comes from a help run.
//   --prompt-interactive <text>   first prompt; the session stays interactive (-i).
//                                 agy reads a prompt ONLY from -p/--print,
//                                 -i/--prompt-interactive or stdin: a positional
//                                 argument (what `claude` takes) is ignored.
//   --conversation=<id>           resume a conversation by id (agy prints this form itself)
//   --continue                    resume the latest conversation
//   --add-dir <path>              an extra folder the agent may read
//   --mode accept-edits           auto-accept file edits
//   --dangerously-skip-permissions
//   --model <id>                  run on one model of `agy models` (ids differ
//                                 per account: src/agymodels.js reads them live)
//   --effort low|medium|high|xhigh|max
// agy 1.5.12's usage text (2026-11-19, printed on a bad flag) confirms
// --model, --effort, --mode and --prompt-interactive. `--print` takes the
// prompt as its value; headless calls pipe stdin instead (src/orchestraAgy.js).
// A worker task's model 'agy:<id>' becomes `--model <id>` and its God Mode
// effort `--effort <level>`, each unless the profile's command already sets
// it; plain 'agy' passes no --model (agy's own default model). In a Workers
// pool run the agy entry only selects the variant (the --model); the
// --effort is the package's own effort, never a level from the pool entry
// (src/orchestraPoolEffort.js claudePoolEffort). Main checks the
// id against the live list before it gets here; this file checks its shape.
// Not found, so never injected: a flag that SETS a new session's id (no
// pinning for agy tabs), and any flag that passes MCP servers (agy reads them
// only from ~/.gemini/config/mcp_config.json - src/agyintake.js writes there).
// Claude-only task flags (--model with a Claude alias, allow / deny tool
// rules, a tool kit's --mcp-config) have no agy equivalent and are dropped.
const AGY_PROMPT_FLAG = '--prompt-interactive';
/** The command already picks its model (claude and agy spell it the same). */
const MODEL_DECIDED = /(^|\s)--model(\s|=|$)/;
/** The command already picks its effort (claude and agy spell it the same). */
const EFFORT_DECIDED = /(^|\s)--effort(\s|=|$)/;
/** The command already brings its own first prompt (or runs headless). */
const AGY_PROMPT_DECIDED = /(^|\s)(-i|--prompt-interactive|-p|--print|--prompt)(\s|=|$)/;
/** The command already resumes a conversation. */
const AGY_SESSION_DECIDED = /(^|\s)(-c|--continue|--conversation)(\s|=|$)/;
/** The command already decides how agy asks for permissions. */
const AGY_PERMISSION_DECIDED = /(^|\s)(--mode|--dangerously-skip-permissions)(\s|=|$)/;
/** Worker permission modes (WORKER_PERMISSION_MODES) in agy's syntax. */
const AGY_PERMISSION_FLAGS = Object.freeze({
  acceptEdits: Object.freeze(['--mode', 'accept-edits']),
  bypassPermissions: Object.freeze(['--dangerously-skip-permissions']),
});
/** First message of an agy tab resumed by LunaCore. No quotes in it. */
const AGY_RESUME_MESSAGE = 'LunaCore restarted this session. Continue exactly where you left off.';

/**
 * Appends `--session-id <uuid>` to a start command when it is safe to do so.
 *
 * Conservative by design: anything that is not a plain `claude` launch is left
 * alone and keeps the heuristic fallback. That includes `agy`: it has no flag
 * that sets a new session's id, so an agy tab is never pinned.
 * @param {string} command full start command, e.g. "claude --model opus"
 * @param {string} uuid session id to pin
 * @returns {string|null} modified command, or null when it must not be pinned
 */
function withSessionId(command, uuid) {
  const cmd = String(command || '').trim();
  if (!cmd || !uuid) return null; // bare shell - the user launches what they like

  const first = cmd.split(/\s+/)[0].replace(/^["']|["']$/g, '');
  const bin = path
    .basename(first)
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  if (bin !== 'claude') return null; // some other program - not ours to label
  if (SESSION_ID_DECIDED.test(cmd)) return null;

  return `${cmd} --session-id ${uuid}`;
}

/**
 * Appends `--mcp-config '<path>'` (the tab's task-intake server, src/intake.js)
 * to a plain `claude` start command. Left alone: non-claude commands, and a
 * command already running under --strict-mcp-config (a lean local-model tab
 * asked for NO extra MCP servers - honour that). The path is single-quoted for
 * the shell it is typed into, so one containing a quote is refused.
 *
 * An `agy` command is returned unchanged as well: agy takes no MCP flag, so
 * its tab's intake server goes into agy's own config file instead
 * (src/agyintake.js), and intakeState() is told whether that worked.
 * @param {string} command
 * @param {string|null} configPath
 * @returns {string} the command, with or without the flag
 */
function withIntakeMcp(command, configPath) {
  const cmd = String(command || '').trim();
  if (!cmd || typeof configPath !== 'string' || !configPath || configPath.includes("'")) return cmd;
  const first = cmd.split(/\s+/)[0].replace(/^["']|["']$/g, '');
  const bin = path.basename(first).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  if (bin !== 'claude' || /(^|\s)--strict-mcp-config(\s|$)/.test(cmd)) return cmd;
  return `${cmd} --mcp-config '${configPath}'`;
}

// Flags meaning "this launch decides its own system prompt, or wants nothing
// extra": a lean local-model tab (--strict-mcp-config), --bare, or a profile
// that already sets or appends a system prompt.
const CARD_DECIDED = /(^|\s)(--strict-mcp-config|--bare|--(append-)?system-prompt(-file)?)(\s|=|$)/;

/**
 * Appends `--append-system-prompt-file '<path>'` (the project card of Luna
 * Core Memory, src/memorycard.js) to a plain `claude` start command. Same
 * rules as withIntakeMcp: other programs and commands matching CARD_DECIDED
 * are left alone, and a path that would break the single-quoted shell
 * argument is refused.
 *
 * agy has no system-prompt flag, so an `agy` tab gets the card as its first
 * prompt instead (agyMemoryCard). Not when the command already brings a first
 * prompt (a God Mode worker's brief, which carries the project memory itself)
 * or resumes a conversation that already had its card.
 * @param {string} command
 * @param {string|null} cardPath
 * @returns {string} the command, with or without the flag
 */
function withMemoryCard(command, cardPath) {
  const cmd = String(command || '').trim();
  // U+2018-U+201B: PowerShell treats the typographic quotes as ' too.
  if (!cmd || typeof cardPath !== 'string' || !cardPath || /['`\r\n‘-‛]/.test(cardPath)) return cmd;
  if (isAgyCommand(cmd)) return agyMemoryCard(cmd, cardPath);
  if (!isClaudeCommand(cmd) || CARD_DECIDED.test(cmd)) return cmd;
  return `${cmd} --append-system-prompt-file '${cardPath}'`;
}

/**
 * withMemoryCard() for an `agy` command: the card is read as the first
 * prompt, and its folder is added so reading it asks for no permission.
 * @param {string} cmd trimmed agy command
 * @param {string} cardPath already checked to fit single quotes
 * @returns {string}
 */
function agyMemoryCard(cmd, cardPath) {
  if (AGY_PROMPT_DECIDED.test(cmd) || AGY_SESSION_DECIDED.test(cmd) || PATH_CONTROL_RE.test(cardPath)) return cmd;
  const [bin, ...rest] = cmd.split(/\s+/);
  const message =
    `Read the LunaCore project memory card in the file \`${cardPath}\`. ` +
    'It is background about this project, not a task: change nothing, ' +
    'answer in one short line that you have read it, then wait for my request.';
  return [bin, AGY_PROMPT_FLAG, `'${message}'`, ...rest, '--add-dir', `'${path.dirname(cardPath)}'`].join(' ');
}

/**
 * What a tab's start command means for the intake MCP tools, for the to-do
 * widget's "rewrite with Claude" button: 'ready' when withIntakeMcp() really
 * attached the config, 'off' for a `claude` launched without it (tools turned
 * off, no config, or --strict-mcp-config), 'none' when the tab is not Claude.
 * An `agy` tab's command never changes (its server sits in agy's config file),
 * so for agy the caller says whether that entry was written.
 * @param {string} command the start command as configured
 * @param {string} launched what withIntakeMcp() turned it into
 * @param {boolean} [agyRegistered] agy only: src/agyintake.js wrote the tab's server
 * @returns {'ready'|'off'|'none'}
 */
function intakeState(command, launched, agyRegistered = false) {
  if (isAgyCommand(command)) return agyRegistered === true ? 'ready' : 'off';
  if (!isClaudeCommand(command)) return 'none';
  return launched !== String(command || '').trim() ? 'ready' : 'off';
}

/**
 * Whether withMemoryCard() really attached the card: it hands the command
 * back unchanged (trimmed) when there was no card or the command decides its
 * own system prompt.
 * @param {string} launched the command before withMemoryCard()
 * @param {string} carded what withMemoryCard() returned
 * @returns {boolean}
 */
function memoryCardLoaded(launched, carded) {
  return typeof carded === 'string' && carded !== withMemoryCard(launched, null);
}

/**
 * The program a start command runs: its first word, unquoted, without folder
 * or Windows launcher extension, lowercased ("C:\x\Claude.EXE --y" -> "claude").
 * @param {string} command
 * @returns {string}
 */
function commandBinary(command) {
  const first = String(command || '').trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
  return path.basename(first).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** True when a start command launches the `claude` CLI itself. */
function isClaudeCommand(command) {
  return commandBinary(command) === 'claude';
}

/**
 * True when a start command launches the Antigravity CLI: `agy`, `agy.exe`
 * or `agy.cmd`, with or without a folder, in any letter case - the same rule
 * as isClaudeCommand().
 * @param {string} command
 * @returns {boolean}
 */
function isAgyCommand(command) {
  return commandBinary(command) === 'agy';
}

// Same quote rule as the brief path: a first message that would break the
// single-quoted shell argument falls back to the default one. U+2018-U+201B:
// PowerShell treats the typographic quotes as ' too.
const UNSAFE_QUOTE_RE = /['`\r\n‘-‛]/;

/**
 * Hands a God Mode worker tab its task (DONE_ORCHESTRATOR_PLAN.md slice 3): the
 * brief sits in a file inside the tab's cwd (`<cwd>/.luna-brief/`, see
 * src/workerBrief.js), so reading it needs no --add-dir - an --add-dir
 * outside a trusted folder stops Claude Code 2.1.326+ at a trust dialog - and
 * the first message - a positional argument - tells Claude to read it. A positional prompt is delivered by the CLI itself, so
 * nothing is typed into a shell that might not have started Claude yet.
 *
 * The prompt goes right after the binary, before any profile flag, so a
 * variadic option (`--add-dir <dirs...>`, `--allowedTools <tools...>`) can
 * never swallow it. Single quotes suit both shells LunaCore types into
 * (PowerShell, POSIX sh); a path containing one is refused instead of escaped.
 *
 * `permissionMode` (slice 4, Settings -> God Mode workers) is appended unless
 * the profile already decides it - same rule as `--model`. So is `effort`.
 *
 * An `agy` command gets the same first message through --prompt-interactive
 * (agyTaskBrief); a model of 'agy' never becomes `claude --model agy`.
 * @param {string} command
 * @param {{briefPath:string, model?:string|null, effort?:string|null, permissionMode?:string|null}} task
 * @param {string} [firstMessage] replaces "read your brief" (a resume after an
 *   account switch keeps the worker's flags but must not restart the task)
 * @returns {string|null} the command, or null when it cannot carry the task
 */
function withTaskBrief(command, task, firstMessage) {
  const cmd = String(command || '').trim();
  // A plan-run worker's task never starts without its lockdown
  // (orchestraPlanRunLaunch.js withPlanLockdown builds that command).
  if (task && task.lockdown) return null;
  const briefPath = task && typeof task.briefPath === 'string' ? task.briefPath : '';
  // U+2018-U+201B: PowerShell treats the typographic quotes as ' too.
  if (!briefPath || /['`\r\n‘-‛]/.test(briefPath)) return null;
  if (isAgyCommand(cmd)) {
    // A first message holding a control character falls back to "read your brief".
    const first = typeof firstMessage === 'string' && PATH_CONTROL_RE.test(firstMessage) ? undefined : firstMessage;
    return agyTaskBrief(cmd, task, briefMessage(briefPath, first));
  }
  if (!isClaudeCommand(cmd)) return null;
  const [bin, ...rest] = cmd.split(/\s+/);
  const message = briefMessage(briefPath, firstMessage);
  // No --add-dir for the brief: it sits inside the tab's cwd (src/workerBrief.js).
  const parts = [bin, `'${message}'`, ...rest];
  if (task.model && !isAgyModel(task.model) && /^[a-z0-9.-]+$/i.test(task.model) && !MODEL_DECIDED.test(cmd)) {
    parts.push('--model', task.model);
  }
  // Only the four God Mode levels are ever appended - never `low`.
  if (isEffort(task.effort) && !EFFORT_DECIDED.test(cmd)) {
    parts.push('--effort', task.effort);
  }
  if (WORKER_PERMISSION_MODES.includes(task.permissionMode) && !PERMISSION_DECIDED.test(cmd)) {
    parts.push('--permission-mode', task.permissionMode);
  }
  // Allow rules learned from stalled prompts (God Mode idea #5). Single
  // quotes are literal in PowerShell and POSIX shells alike; the shape check
  // keeps a quote, `$` or backtick out of them.
  const rules = Array.isArray(task.allowedTools) ? task.allowedTools.filter((r) => TOOL_RULE_RE.test(r)) : [];
  if (rules.length && !/(^|\s)--allowed-?tools(\s|=|$)/i.test(cmd)) {
    parts.push('--allowedTools', ...rules.map((r) => `'${r}'`));
  }
  parts.push(...kitFlags(task));
  return parts.join(' ');
}

/**
 * A worker's first message: "read your brief", or `firstMessage` when it fits
 * the single quotes. Backticks around the path: unquoted, the model cut a path
 * at its first space and asked for the wrong file (verified live).
 * @param {string} briefPath
 * @param {string|undefined} firstMessage
 * @returns {string}
 */
function briefMessage(briefPath, firstMessage) {
  if (typeof firstMessage === 'string' && firstMessage && !UNSAFE_QUOTE_RE.test(firstMessage)) return firstMessage;
  // A brief in `<cwd>/.luna-brief/` is named relative to the tab's cwd.
  const shown = relativeBriefPath(briefPath) || briefPath;
  return `Your task brief is in the file \`${shown}\` - read it first, then carry it out.`;
}

/**
 * withTaskBrief() for an `agy` command: the message goes in through
 * --prompt-interactive right after the binary, a tool kit's art folders
 * through --add-dir (the brief is inside the cwd), an 'agy:<id>' model as
 * `--model <id>`, the God Mode effort as `--effort`, and the worker permission mode in
 * agy's syntax. Null when the command brings its own first prompt (two
 * prompts would fight over the session).
 * @param {string} cmd trimmed agy command
 * @param {object} task the worker task (briefPath already checked)
 * @param {string} message the first message, already checked to fit single quotes
 * @returns {string|null}
 */
function agyTaskBrief(cmd, task, message) {
  if (AGY_PROMPT_DECIDED.test(cmd)) return null;
  // A control character would be typed into the PTY as a keystroke (Ctrl-C...).
  if (PATH_CONTROL_RE.test(message) || PATH_CONTROL_RE.test(task.briefPath)) return null;
  const [bin, ...rest] = cmd.split(/\s+/);
  // The brief sits inside the tab's cwd: no --add-dir for it.
  const parts = [bin, AGY_PROMPT_FLAG, `'${message}'`, ...rest];
  // 'agy:<id>' -> agy's own `--model <id>`; the id's shape keeps quotes and flags out.
  const model = agyModelIdOf(task.model);
  if (model && !MODEL_DECIDED.test(cmd)) parts.push('--model', model);
  if (isEffort(task.effort) && !EFFORT_DECIDED.test(cmd)) parts.push('--effort', task.effort);
  parts.push(...agyPermissionFlags(cmd, task));
  for (const dir of Array.isArray(task.addDirs) ? task.addDirs : []) {
    const quoted = quotablePath(dir);
    if (quoted) parts.push('--add-dir', quoted);
  }
  return parts.join(' ');
}

/**
 * The agy flags of a worker's permission mode, unless the command decides it.
 * agy cannot take deny rules, so a task that carries any (even ones Claude
 * would drop as malformed) gets no permission flag at all: agy then asks
 * before every edit and command instead of auto-accepting a denied one.
 * @param {string} cmd
 * @param {object} task
 * @returns {string[]}
 */
function agyPermissionFlags(cmd, task) {
  if (AGY_PERMISSION_DECIDED.test(cmd)) return [];
  if (Array.isArray(task.disallowedTools) && task.disallowedTools.length > 0) return [];
  const mode = task.permissionMode;
  return WORKER_PERMISSION_MODES.includes(mode) ? [...AGY_PERMISSION_FLAGS[mode]] : [];
}

// eslint-disable-next-line no-control-regex
const PATH_CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** An absolute path that fits a single-quoted shell argument (no quotes, no control characters), or null. */
const quotablePath = (p) =>
  (typeof p === 'string' && p && path.isAbsolute(p) && !UNSAFE_QUOTE_RE.test(p) && !PATH_CONTROL_RE.test(p) ? `'${p}'` : null);

/**
 * The tool kit's flags of a Luna's Work worker task (src/lunasworkToolkitLaunch.js):
 * deny rules always go on - more deny rules are never less safe - then the
 * kit's --mcp-config and its art folders.
 */
function kitFlags(task) {
  const out = [];
  const denied = Array.isArray(task.disallowedTools) ? task.disallowedTools.filter(isPassableDenyRule) : [];
  if (denied.length) out.push('--disallowedTools', ...denied.map((r) => `'${r}'`));
  const config = quotablePath(task.mcpConfigPath);
  if (config) out.push('--mcp-config', config);
  for (const dir of Array.isArray(task.addDirs) ? task.addDirs : []) {
    const quoted = quotablePath(dir);
    if (quoted) out.push('--add-dir', quoted);
  }
  return out;
}

/** First message of a tab resumed on another Claude account. No quotes in it. */
const ACCOUNT_RESUME_MESSAGE =
  'The usage limit was hit, so LunaCore moved this session to another Claude account. Continue exactly where you left off.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The start command that resumes conversation `uuid` (same transcript, the
 * CLI keeps the id unless --fork-session) and sends "continue" as its first
 * message. A God Mode worker keeps its model / effort / permission flags via
 * withTaskBrief. Null when the command is not a plain `claude` launch or
 * already decides its own session (then the caller falls back to waiting).
 * @param {string} command the profile's start command
 * @param {string} uuid transcript id to resume
 * @param {object|null} [task] the worker task the tab was first started with
 * @param {string|null} [message] first message instead of the account one (a
 *   God Mode resume after a PC shutdown); one that would break the single
 *   quotes falls back to the account message
 * @returns {string|null}
 */
function withAccountResume(command, uuid, task = null, message = null) {
  const cmd = String(command || '').trim();
  if (isAgyCommand(cmd)) return agyResume(cmd, uuid, task, message);
  if (!isClaudeCommand(cmd) || !UUID_RE.test(String(uuid || '')) || SESSION_ID_DECIDED.test(cmd)) return null;
  // A plan-run worker is never resumed without its lockdown: the caller waits instead.
  if (task && task.lockdown) return null;
  const first = typeof message === 'string' && message && !UNSAFE_QUOTE_RE.test(message) ? message : ACCOUNT_RESUME_MESSAGE;
  const withFlags = task ? withTaskBrief(cmd, task, first) : null;
  if (withFlags) return `${withFlags} --resume ${uuid}`;
  const [bin, ...rest] = cmd.split(/\s+/);
  return [bin, `'${first}'`, ...rest, '--resume', uuid].join(' ');
}

/**
 * withAccountResume() for an `agy` command: the same conversation through
 * `--conversation=<id>`, with a neutral first message (agy runs on a Google
 * account, so the Claude-account message would be wrong). A worker keeps its
 * agy flags via withTaskBrief, and is not resumed (null) when they cannot be
 * rebuilt: without them it would stop at every permission prompt.
 * @param {string} cmd trimmed agy command
 * @param {string} uuid conversation id (agy's are UUIDs too)
 * @param {object|null} task
 * @param {string|null} message
 * @returns {string|null}
 */
function agyResume(cmd, uuid, task, message) {
  if (!UUID_RE.test(String(uuid || '')) || AGY_SESSION_DECIDED.test(cmd) || AGY_PROMPT_DECIDED.test(cmd)) return null;
  if (task && task.lockdown) return null;
  const safe = typeof message === 'string' && message && !UNSAFE_QUOTE_RE.test(message) && !PATH_CONTROL_RE.test(message);
  const first = safe ? message : AGY_RESUME_MESSAGE;
  if (task) {
    const withFlags = withTaskBrief(cmd, task, first);
    return withFlags ? `${withFlags} --conversation=${uuid}` : null;
  }
  const [bin, ...rest] = cmd.split(/\s+/);
  return [bin, AGY_PROMPT_FLAG, `'${first}'`, ...rest, `--conversation=${uuid}`].join(' ');
}

/**
 * The start command that reopens conversation `uuid` and sends nothing: the
 * tabs of the last run after a crash (src/tabResume.js). An `agy` command
 * resumes with `--conversation=<id>`. Null when the command is neither a
 * plain `claude` nor a plain `agy` launch, or already decides its own session.
 * @param {string} command the profile's start command
 * @param {string} uuid transcript id to resume
 * @returns {string|null}
 */
function withPlainResume(command, uuid) {
  const cmd = String(command || '').trim();
  if (isAgyCommand(cmd)) {
    return UUID_RE.test(String(uuid || '')) && !AGY_SESSION_DECIDED.test(cmd) ? `${cmd} --conversation=${uuid}` : null;
  }
  if (!isClaudeCommand(cmd) || !UUID_RE.test(String(uuid || '')) || SESSION_ID_DECIDED.test(cmd)) return null;
  return `${cmd} --resume ${uuid}`;
}

// Permission modes a God Mode worker may be started in. 'default' adds no
// flag on purpose: it is what the CLI does anyway.
const WORKER_PERMISSION_MODES = ['acceptEdits', 'bypassPermissions'];
const PERMISSION_DECIDED = /(^|\s)(--permission-mode|--dangerously-skip-permissions)(\s|=|$)/;
// Rules a worker task may carry: orchestraSupervisor's ALLOW_RULE_RE shape plus `~` / `+` inside the
// parentheses (the tool kit's home-folder and refspec guards) and MCP server
// names with a hyphen (mcp__higgsfield-bridge). Nothing a single-quoted
// argument treats specially in PowerShell or a POSIX shell.
const TOOL_RULE_RE = /^(?:[A-Za-z][A-Za-z0-9_]{0,63}(\([A-Za-z0-9 _.:*/@=~+-]{1,100}\))?|mcp__[A-Za-z0-9_-]{1,64}(__[A-Za-z0-9_-]{1,64})?)$/;
// A deny rule only ever takes a tool away, so it may also hold `&` and `\` and
// run longer: the Unity editor guard names the main checkout's path
// (blade&bullet, C:\...) in it (src/lunasworkWorktreeEditors.js). Both are
// literal inside single quotes in PowerShell and a POSIX shell alike; a quote,
// `$`, a backtick and control characters stay out.
const DENY_RULE_RE = /^(?:[A-Za-z][A-Za-z0-9_]{0,63}(\([A-Za-z0-9 _.:*/@=~+&\\-]{1,300}\))?|mcp__[A-Za-z0-9_-]{1,64}(__[A-Za-z0-9_-]{1,64})?)$/;

/** True for a deny rule kitFlags passes on to the CLI (every other one is dropped). */
function isPassableDenyRule(rule) {
  return typeof rule === 'string' && DENY_RULE_RE.test(rule);
}

// Extensions Windows will actually execute for a bare name. The empty string is
// last on purpose: `claude` with no extension is the POSIX case and also catches
// an extensionless shim, but on Windows the .cmd/.exe forms are what npm and the
// native installer really drop, so they should win.
const WIN_EXTS = ['.exe', '.cmd', '.bat', '.ps1', ''];

/**
 * Looks up an executable on a PATH string. Pure: the filesystem arrives as an
 * `exists` callback, so this is unit-testable without touching a real disk.
 *
 * D3 uses it to answer one question honestly - is Claude Code installed at all?
 * Without it a newcomer gets a shell printing `command not found` and no idea
 * what to install. Note this runs on the env AFTER withClaudeOnPath() has had
 * its say, so a native install in ~/.local/bin counts as found.
 *
 * @param {string} name bare command name, e.g. "claude"
 * @param {string} pathEnv the PATH value to search
 * @param {boolean} isWindows
 * @param {(p: string) => boolean} exists
 * @returns {string|null} full path to the executable, or null when absent
 */
function findExecutable(name, pathEnv, isWindows, exists) {
  if (!name) return null;
  const sep = isWindows ? ';' : ':';
  const exts = isWindows ? WIN_EXTS : [''];
  // Join with the TARGET platform's rules, not the host's. path.join alone would
  // hand back backslashes while isWindows said false, so the flag and the
  // separator could disagree - harmless while we only ship Windows, and a
  // silent wrong answer the moment anyone runs this anywhere else.
  const join = isWindows ? path.win32.join : path.posix.join;
  for (const raw of String(pathEnv || '').split(sep)) {
    const dir = raw.trim().replace(/^["']|["']$/g, '');
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      try {
        if (exists(full)) return full;
      } catch {
        // An unreadable or malformed PATH entry must not abort the search -
        // one bad directory should never make a present binary look absent.
      }
    }
  }
  return null;
}

module.exports = {
  withSessionId,
  withPlainResume,
  withIntakeMcp,
  withMemoryCard,
  memoryCardLoaded,
  intakeState,
  withTaskBrief,
  withAccountResume,
  ACCOUNT_RESUME_MESSAGE,
  AGY_RESUME_MESSAGE,
  WORKER_PERMISSION_MODES,
  isPassableDenyRule,
  isClaudeCommand,
  isAgyCommand,
  SESSION_ID_DECIDED,
  findExecutable,
  WIN_EXTS,
};
