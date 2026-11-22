// ============================================================================
// LunaCore - short, sanitized tool-call details (pure, no I/O)
// ----------------------------------------------------------------------------
// A metrics:tools start event may carry `detail`: one short line saying what
// a call does - "npm test", "git status", "ecc:planner", a search pattern -
// for the live ticker and the per-session process labels (#agymap slices 2
// and 3). Every input here was written by a model or a user, so it is treated
// as hostile:
//   * a shell command keeps only its binary and up to three arguments from an
//     allowlist: lowercase subcommand words and script names before any
//     flag, and flags that carry no value (`--watch`, `-e`). The first other
//     word - a quoted string, an assignment, `user:pass`, a URL, a word right
//     after a flag (it may be that flag's value) or after `login` / `auth` /
//     `password` - ends the summary, and echo / printf / set show no
//     arguments at all. Known residual: an all-lowercase secret given as the
//     first positional word of an unknown tool (`mytool hunter`) is shown;
//     nothing tells it from a subcommand;
//   * everything is then scrubbed: src/hostscrub.js masks the known secret
//     shapes (API keys, GitHub/Slack/AWS/Google tokens, JWTs, Bearer tokens,
//     URL passwords, NAME=value with a secret-ish name); this module adds what
//     a one-line display also needs - `--token x` flags, `password: x`
//     pairs, URL query strings and long letter+digit runs;
//   * control and line-separator characters go, whitespace collapses, and the
//     result is at most MAX_DETAIL_CHARS long.
// What is left is display text: the renderer sets it with textContent only.
// ============================================================================

'use strict';

const { scrub, MASK } = require('./hostscrub');

/** Longest detail a start event carries. */
const MAX_DETAIL_CHARS = 80;
/** A command is cut to this before it is split into words. */
const MAX_INPUT_CHARS = 4096;
/**
 * Display text is cut to this before the secret patterns run over it: the
 * result is at most MAX_DETAIL_CHARS anyway, and a short input keeps every
 * pattern's cost small on hostile (model-written) text.
 */
const MAX_SCRUB_CHARS = 512;
/** Arguments a shell summary keeps after the binary. */
const MAX_SHELL_ARGS = 3;
/** Bare words (subcommands, script names) among them. */
const MAX_BARE_WORDS = 2;
/** A label (agent role, process name) longer than this is cut. */
const MAX_LABEL_CHARS = 60;
const ELLIPSIS = '…';

/** Control characters, format characters and line/paragraph separators. */
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
/** Words that make a flag or key name a secret's: --token, password:, $env:API_KEY. */
const SECRET_WORD = '(?:token|secret|passw(?:or)?d|pwd|api[-_]?key|apikey|auth|credential|cookie|session|private[-_]?key|access[-_]?key|signature|otp)';
const SECRET_WORD_RE = new RegExp(SECRET_WORD, 'i');
// Bounded on both sides of the secret word: unbounded runs there backtrack
// polynomially on input like 'token'.repeat(n).
/** A secret flag followed by its value as the next word: --token abc, -Password x. */
const SECRET_FLAG_RE = new RegExp(`(--?[\\w-]{0,40}${SECRET_WORD}[\\w-]{0,40})\\s+(?!-)("[^"]*"|'[^']*'|\\S+)`, 'gi');
/** key=value / key: value with a secret-ish key, any case and any separator hostscrub does not cover. */
const SECRET_PAIR_RE = new RegExp(
  `([\\w.$:-]{0,40}${SECRET_WORD}[\\w.-]{0,40})(\\s*[=:]\\s*)(?!\\[redacted)("[^"]*"|'[^']*'|[^\\s"'&;|,]+)`,
  'gi',
);
const URL_QUERY_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#]+)\?[^\s#]*/gi;
/** A long run of key-ish characters: masked when it mixes letters and digits. */
const LONG_RUN_RE = /[A-Za-z0-9+_=-]{32,}/g;
/** A flag that carries no value of its own: --watch, -e (never -pSECRET or --key=x). */
const FLAG_RE = /^(?:--[a-z][a-z-]{0,30}|-[A-Za-z])$/;
/** A subcommand-like bare word: lowercase letters and dashes only (test, run, pr). */
const SUBCOMMAND_RE = /^[a-z][a-z-]{0,23}$/;
/** A script, or a relative path to one: server.js, test/x.test.js. */
const SCRIPT_RE = /^(?!.*\.\.)[\w-][\w./-]{0,47}\.(?:c?js|mjs|ts|tsx|py|sh|ps1|rb|go)$/i;
/** A shell binary as shown: letters, digits and a few separators. */
const SAFE_BINARY_RE = /^[A-Za-z0-9][\w.+-]{0,40}$/;
/** Segments that only set up the shell; the summary skips past them when it can. */
const SETUP_BINARIES = new Set(['cd', 'pushd', 'popd', 'set', 'export', 'source', '.', 'set-location', 'sl', 'chdir', 'setlocal']);
/** Binaries whose arguments are data (often the very secret): only the binary is shown. */
const DATA_BINARIES = new Set(['echo', 'printf', 'write-output', 'write-host', 'set', 'export', 'setx']);
/** Subcommands whose next word is often a secret (vault login X, redis-cli auth X): the summary ends on them. */
const SECRET_LEAD_RE = new RegExp(`^(?:login|logon|signin|pin|key|pass|${SECRET_WORD})$`, 'i');
/** A token that is an environment assignment (FOO=bar, $env:FOO=bar). */
const ENV_ASSIGN_RE = /^(?:\$env:)?[A-Za-z_]\w*=/i;
const TOKEN_RE = /"[^"]*"|'[^']*'|\S+/g;
const SEGMENT_SPLIT_RE = /&&|\|\||[;|\r\n]/;

/** Whitespace collapsed, unprintable characters gone, at most `max` characters read. */
function plainText(value, max = MAX_INPUT_CHARS) {
  if (typeof value !== 'string') return '';
  return value.slice(0, max).replace(UNPRINTABLE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Cut to `max` characters, marking the cut. */
function clip(text, max = MAX_DETAIL_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}${ELLIPSIS}`;
}

/** A long run counts as a secret only when it mixes letters and digits. */
function maskLongRun(run) {
  return /\d/.test(run) && /[A-Za-z]/.test(run) ? MASK : run;
}

/**
 * Removes whatever looks like a credential from display text and cuts it to
 * MAX_DETAIL_CHARS. Over-scrubbing (an `author: x` field) is accepted; a
 * token on screen is not.
 * @param {unknown} value
 * @returns {string} '' for anything that is not a string
 */
function scrubSecrets(value) {
  const text = plainText(value, MAX_SCRUB_CHARS);
  if (!text) return '';
  const masked = scrub(text)
    .replace(URL_QUERY_RE, `$1?${MASK}`)
    .replace(SECRET_FLAG_RE, `$1 ${MASK}`)
    .replace(SECRET_PAIR_RE, `$1$2${MASK}`)
    .replace(LONG_RUN_RE, maskLongRun);
  return clip(masked);
}


/** A binary as shown: its file name without the path, quotes or a Windows launcher extension. */
function binaryName(word) {
  const bare = String(word || '').replace(/^["']|["']$/g, '');
  const base = bare.split(/[\\/]/).pop() || '';
  const name = base.replace(/\.(?:exe|cmd|bat|com)$/i, '');
  return SAFE_BINARY_RE.test(name) ? name : '';
}

/** The words of one command segment, environment assignments in front skipped. */
function segmentWords(segment) {
  const words = segment.match(TOKEN_RE) || [];
  let first = 0;
  while (first < words.length && ENV_ASSIGN_RE.test(words[first])) first++;
  return words.slice(first);
}

/**
 * Binary plus up to MAX_SHELL_ARGS arguments of one segment, or ''. An
 * allowlist, not a filter: only subcommand-like words and script names
 * (before any flag) and flags that carry no value are kept, and the first
 * other word ends the summary. A word after a flag may be that flag's value
 * (`-p hunter2`, `--otp 123456`), so it is never shown.
 */
function summarizeSegment(words) {
  const binary = binaryName(words[0]);
  if (!binary) return '';
  if (DATA_BINARIES.has(binary.toLowerCase())) return binary;
  const kept = [binary];
  let afterFlag = false;
  let bare = 0;
  for (const word of words.slice(1)) {
    if (kept.length > MAX_SHELL_ARGS) break;
    if (FLAG_RE.test(word)) {
      if (SECRET_WORD_RE.test(word)) break;
      kept.push(word);
      afterFlag = true;
      continue;
    }
    if (afterFlag || bare >= MAX_BARE_WORDS) break;
    if (!SUBCOMMAND_RE.test(word) && !SCRIPT_RE.test(word)) break;
    kept.push(word);
    bare++;
    if (SECRET_LEAD_RE.test(word)) break;
  }
  return kept.join(' ');
}

/**
 * A shell command as "binary + plain arguments": `npm test`, `git status`,
 * `node server.js --watch`. Leading `cd x &&` / `export X=1;` segments are
 * skipped when a later segment says more; nothing quoted, assigned, attached
 * to a flag or secret-looking is ever shown.
 * @param {unknown} command
 * @returns {string} '' when there is no usable binary
 */
function commandSummary(command) {
  const text = plainText(command);
  if (!text) return '';
  const segments = text.split(SEGMENT_SPLIT_RE).map(segmentWords).filter((words) => words.length > 0);
  const main = segments.find((words) => !SETUP_BINARIES.has(binaryName(words[0]).toLowerCase())) || segments[0];
  return main ? scrubSecrets(summarizeSegment(main)) : '';
}

/**
 * A short label (an agent's role or type, a process name): plain characters
 * only, scrubbed, at most MAX_LABEL_CHARS.
 * @param {unknown} value
 * @returns {string}
 */
function safeLabel(value) {
  const text = plainText(value).replace(/[^\w:./@ #()+-]/g, '').replace(/\s+/g, ' ').trim();
  return text ? clip(scrubSecrets(text), MAX_LABEL_CHARS) : '';
}

/**
 * The detail of a Claude Code tool call, from its tool_use input:
 * Bash/PowerShell -> command summary, Task/Agent -> the agent type or name,
 * Grep/Glob -> the pattern. Anything else has none ('').
 * @param {unknown} name the tool name ('Bash', 'Task', ...)
 * @param {unknown} input the tool_use input object
 * @returns {string}
 */
function claudeToolDetail(name, input) {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return commandSummary(args.command);
    case 'Task':
    case 'Agent':
      return safeLabel(args.subagent_type || args.name || args.agent_type);
    case 'Grep':
    case 'Glob':
      return scrubSecrets(args.pattern);
    default:
      return '';
  }
}

module.exports = {
  MAX_DETAIL_CHARS,
  scrubSecrets,
  commandSummary,
  safeLabel,
  claudeToolDetail,
};
