// ============================================================================
// LunaCore - God Mode: Unity verify commands that need an editor
// ----------------------------------------------------------------------------
// The `unity` CLI talks to a running editor's Pipeline for the project folder
// it is run in. No editor is open on a God Mode integration worktree, and none
// may be (a full import, and the run-end reaper closes worktree editors). Seen
// live in Luna's Work run lwmwxd1zal (2026-11-26): every package's verify
// (`unity command ...`) failed there with "No Pipeline instance found for
// project: ...", nothing merged, and every iteration repeated it.
//
// Three parts:
//   planning    (lunasworkBuild.wrapPlanner, Unity builds only): the planner
//               is told `verify` is always empty, and EVERY verify a package
//               still has is moved into its prompt as a check in its
//               definition of done; `verify` is left empty. God Mode runs a
//               verify through cmd.exe on Windows (no grep, no test), and
//               workers once committed grep.cmd / unity.cmd shims to make
//               theirs pass. The note fits the worker's role: next to a scene
//               worker, a code / asset-prep package never opens Unity, so its
//               check is left for the live editor after the merge.
//   integration (orchestraIntegrate.mergeAndVerify): a verify that failed
//               ONLY for want of an editor is deferred, not red. The merge
//               stays; Luna's Work checks it in the live editor after the
//               checkout update (recompile + compile check, then the playtest).
//               "Only" is read from the output AND the command's shape: the
//               no-Pipeline error, nothing else failing, a unity call, every
//               part before it chained with && (it ran, so they passed) and
//               nothing but unity calls after it. Anything else stays red.
//               It still guards manual God Mode runs on a Unity project.
//   self-check  (orchestraFinalize -> orchestraSelfCheck, Unity builds): God
//               Mode's default `npm test` is no check command (a Unity repo
//               has no package.json; a fix-up worker once committed one whose
//               test script called the editor), so the tests step is skipped;
//               a check command that failed only for want of an editor is
//               'deferred', never red, and starts no fix-up worker.
//
// Pure: nothing here runs anything.
// ============================================================================

'use strict';

const { parseVerifyOutput } = require('./orchestraVerifyDetail');

/** Why a merged package's verify did not run: no Unity editor on the integration worktree. */
const VERIFY_DEFERRED_UNITY = 'unity-editor';

// The unity CLI's answer when no editor has the project open (2026-11-26).
const NO_PIPELINE_RE = /\bNo Pipeline instance found\b/i;

// What may stand in front of a command word: env assignments, `env`, `npx`, `timeout <s>`.
const WRAPPERS = String.raw`(?:(?:timeout\s+\S+|npx|env|[A-Za-z_]\w*=\S*)\s+)*`;
// The unity CLI as a command: at the start, after a shell operator, a line
// break, a subshell, or inside a quoted `-c "..."` string; then a word, so
// `grep "unity" f` is not one.
const UNITY_CLI_RE = new RegExp(String.raw`(?:^|&&|\|\||[;&|({!"'\x60\r\n])\s*${WRAPPERS}unity(?:\.exe)?\s+[a-z-]`, 'i');
// The Unity editor binary run headless: it imports the whole project and
// cannot open one an editor already holds.
const UNITY_BATCH_RE = /(?<![\w.-])unity(?:\.exe)?["']?\s+(?:[^;&|]*\s)?-(?:batchmode|projectPath|executeMethod|runTests)\b/i;
// A whole segment that runs the unity CLI (quotes already blanked out).
const UNITY_SEGMENT_RE = new RegExp(String.raw`^[\s({!]*${WRAPPERS}(?:\S*[\\/])?unity(?:\.exe)?(?:\s|\)|$)`, 'i');
const OPERATOR_RE = /&&|\|\||[;|&\r\n]/g;

const QUOTED_RE = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
// A parenthesised group that reads like a sentence: `(edit mode: ok true, empty errors)`.
const PROSE_GROUP_RE = /\([^()]*(?::\s|,\s)[^()]*\)/;
// Bare English words a shell command does not carry outside quotes, counted
// once each. Short words that double as file names (a, in, to, it...) and
// command names (make, check) are left out.
const PROSE_WORDS = new Set([
  'the', 'and', 'that', 'this', 'its', 'then', 'with', 'against', 'should', 'must', 'when', 'until', 'into', 'from',
  'confirm', 'sure',
]);
const MIN_PROSE_WORDS = 2;

// The check moved into a package prompt (a verify is at most 300 chars once
// validated; the raw planner value is capped here too).
const MAX_CHECK_CHARS = 300;
const NOTE_GAP = '\n\n';
/** Who may run a moved check: 'editor' in its own Unity editor; 'noEditor' never opens Unity (a scene worker owns it). */
const CHECK_ROLES = Object.freeze(['editor', 'noEditor']);
// 'editor', for a verify that needs the editor (or is prose).
const EDITOR_CHECK_NOTE =
  'Editor check: LunaCore cannot run this one after the merge (no Unity editor is open on its merge worktree), so run it yourself against your own Unity editor before you commit, and fix until it passes:';
// 'editor', for any other verify (it may need no editor at all).
const CHECK_NOTE =
  'Check: LunaCore runs no package verify command in this Unity project, so run this one yourself before you commit, and fix until it passes:';
// 'noEditor': a code or asset-prep package next to the scene worker.
const NO_EDITOR_CHECK_NOTE = [
  'Check (not run here): do not open the Unity editor for it - the scene worker owns the editor in this build.',
  "It runs after the merge in the live Unity editor (Luna's Work's recompile, compile check and playtest).",
  'So review your C# carefully for compile errors (usings, asmdef references, method signatures), and list this check as "not run here" in your hand-back:',
].join(' ');

/** The planner's Unity rules (handed over as extraPrompt, after the to-do list). */
const UNITY_PLANNER_RULES = Object.freeze([
  'This is a Unity project. These rules override the "verify" rule above, a to-do\'s own verify included:',
  '- "verify" is always "" (empty) in this project. LunaCore runs no package verify command here: it checks the merged build itself in the live Unity editor (script recompile, compile check, then a playtest).',
  "- Every check a package needs goes into its prompt's definition of done instead (for example: scripts recompile with a clean Console, `unity command test run ...` passes, a behaviour seen in play mode). The worker runs the checks it can before it commits and names in its hand-back any it could not run.",
]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const oneLine = (text, max) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * True when a red verify's OUTPUT says only that no Unity editor (Pipeline)
 * is open on its folder: the no-Pipeline error is there and nothing else
 * shows a failure - no failing tests, no conflict markers, no timeout, no
 * earlier error line. Silent failures (`grep -q`) are invisible here: see
 * deferToUnityEditor for the command's side.
 * @param {{ok?:boolean, output?:string, timedOut?:boolean}|null} result runVerify's result
 * @returns {boolean}
 */
function unityEditorMissing(result) {
  if (!isObj(result) || result.ok !== false || result.timedOut === true) return false;
  const output = String(result.output || '');
  if (!NO_PIPELINE_RE.test(output)) return false;
  const p = parseVerifyOutput(output);
  if (p.timedOut || p.markerFiles || p.names.length) return false;
  return !p.error || NO_PIPELINE_RE.test(p.error);
}

/** A command split at its shell operators (quoted text blanked first): {parts, ops}; null when a part is empty. */
function segmentsOf(command) {
  const bare = command.replace(QUOTED_RE, ' Q ');
  const parts = [];
  const ops = [];
  let from = 0;
  for (const m of bare.matchAll(OPERATOR_RE)) {
    parts.push(bare.slice(from, m.index).trim());
    ops.push(m[0]);
    from = m.index + m[0].length;
  }
  parts.push(bare.slice(from).trim());
  // A trailing `;` or line break leaves one empty part: dropped with its operator.
  while (parts.length > 1 && !parts[parts.length - 1] && /^[;\r\n&]$/.test(ops[ops.length - 1])) {
    parts.pop();
    ops.pop();
  }
  return parts.every(Boolean) ? { parts, ops } : null;
}

/**
 * True when a no-Pipeline failure of `command` can only come from its unity
 * calls: it has one, every part before the first is chained with `&&` (the
 * unity call ran, so they all passed) and every part from it on is a unity
 * call too (a later part never ran, or failed the same way).
 */
function onlyUnityCanFail(command) {
  const seg = segmentsOf(command);
  if (!seg) return false;
  const isUnity = (part) => UNITY_SEGMENT_RE.test(part);
  const first = seg.parts.findIndex(isUnity);
  if (first < 0) return false;
  return seg.ops.slice(0, first).every((op) => op === '&&') && seg.parts.slice(first).every(isUnity);
}

/**
 * True when a red verify failed only because no Unity editor is open on the
 * folder it ran in: the output says so (unityEditorMissing) and the command
 * leaves no other part that may have failed or never ran (onlyUnityCanFail).
 * @param {unknown} command the package's verify
 * @param {{ok?:boolean, output?:string, timedOut?:boolean}|null} result runVerify's result
 * @returns {boolean}
 */
function deferToUnityEditor(command, result) {
  return typeof command === 'string' && onlyUnityCanFail(command) && unityEditorMissing(result);
}

/** True when the unquoted text of a command reads like a sentence, not a shell command. */
function isProse(command) {
  const bare = command.replace(QUOTED_RE, ' ');
  // Markdown code spans, an apostrophe, a quote never closed: not a shell command.
  // (A backtick command substitution counts too: rare in a verify, and the
  // worker still gets the check in its prompt.)
  if (/[`"']/.test(bare)) return true;
  if (PROSE_GROUP_RE.test(bare)) return true;
  const words = new Set(bare.split(/[\s;&|()!{}]+/).map((w) => w.toLowerCase()).filter((w) => PROSE_WORDS.has(w)));
  return words.size >= MIN_PROSE_WORDS;
}

/**
 * Why a verify command cannot run on a worktree without a Unity editor:
 * 'unity' (it calls the unity CLI or the editor binary), 'prose' (it is not a
 * shell command at all), or null (it can run as it is).
 * @param {unknown} command
 * @returns {'unity'|'prose'|null}
 */
function editorBoundReason(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  if (UNITY_CLI_RE.test(command) || UNITY_BATCH_RE.test(command)) return 'unity';
  return isProse(command) ? 'prose' : null;
}

/**
 * The check a package prompt gets for its `verify`, worded for the worker's
 * role: 'editor' (default) runs it itself; 'noEditor' leaves it for the live
 * editor after the merge and reports it as not run.
 * @param {unknown} verify
 * @param {'editor'|'noEditor'} [role]
 * @returns {string}
 */
function editorCheckNote(verify, role = 'editor') {
  const lead = role === 'noEditor' ? NO_EDITOR_CHECK_NOTE : editorBoundReason(verify) ? EDITOR_CHECK_NOTE : CHECK_NOTE;
  return `${lead} ${oneLine(verify, MAX_CHECK_CHARS)}`;
}

/** `prompt` with `note` after it, within `maxChars`: the prompt is never cut, the note is shortened instead. */
function appendWithin(prompt, note, maxChars) {
  const base = typeof prompt === 'string' ? prompt : '';
  const room = maxChars - base.length - NOTE_GAP.length;
  if (room <= 0) return base;
  return [base, note.slice(0, room)].filter(Boolean).join(NOTE_GAP);
}

/**
 * A planned package of a Unity build with its verify - ANY non-empty one, a
 * shell check included - moved into its prompt as a check in its definition
 * of done (editorCheckNote for `role`; shortened or left out when the prompt
 * is at its cap - the caller can tell by comparing) and `verify` emptied. A
 * package without a verify is returned as it is (the same object).
 * @param {object} pkg a raw planner package
 * @param {number} maxPromptChars the planner's prompt cap
 * @param {'editor'|'noEditor'} [role] who may run the check (CHECK_ROLES)
 * @returns {object}
 */
function editorFreeVerify(pkg, maxPromptChars, role = 'editor') {
  if (!isObj(pkg) || typeof pkg.verify !== 'string' || !pkg.verify.trim()) return pkg;
  return { ...pkg, verify: '', prompt: appendWithin(pkg.prompt, editorCheckNote(pkg.verify, role), maxPromptChars) };
}

// ---- self-check (orchestraFinalize -> orchestraSelfCheck) ----------------------

/**
 * The self-check's check command, and for a Unity build the rule its tests
 * step is read with (selfCheckDeferred). A Unity build is a Luna's Work build
 * on the `unity` adapter (`build`) or a Unity project (`unityDir`). There,
 * God Mode's default `fallback` (`npm test`) is no check command - unless it
 * is the profile's own - and no command means the tests step is skipped:
 * Luna's Work's live-editor gate after the checkout update is the real test.
 * Any other run: the command, else `fallback`, exactly as before.
 * @param {{command:unknown, build?:{own?:boolean}|null, unityDir?:boolean, fallback:string}} args
 *   build.own: the command is the Luna's Work profile's own, not God Mode's 'Final check command'
 * @returns {{checkCommand:string, unity?:{own:boolean}}}
 */
function selfCheckCommandOf({ command, build, unityDir, fallback }) {
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!isObj(build) && unityDir !== true) return { checkCommand: cmd || fallback };
  const own = !!cmd && isObj(build) && build.own === true;
  if (!cmd || (!own && cmd === fallback)) return { checkCommand: '', unity: { own: false } };
  return { checkCommand: cmd, unity: { own } };
}

// A line that shows a failure of its own next to the no-Pipeline error (a
// wrapper script that carried on after a failing step, then called the unity
// CLI). parseVerifyOutput reads only `Error:`-style lines and test names, so
// these cover what it misses: compiler diagnostics, failing counts, a missing
// command, an exception. Zero counts ("0 Error(s)", "Failed: 0") never match.
const GENUINE_FAILURE_RES = Object.freeze([
  /\b[Ee]rror\s+[A-Z]{1,5}\d{2,5}\b/, // error CS1002, error MSB3073
  /\bcompil\w*\s+(?:failed|errors?)\b|\bcompiler errors?\b/i,
  /\b(?:tests?|assert\w*)\s+fail/i, // Tests failed, Assertion failed
  /^FAIL\b/,
  /\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b/i, // 3 failed, 2 errors
  /\b(?:failed|failures?|errors?)\s*[:=]\s*[1-9]/i, // Failed: 2
  /\bnot recognized as\b|\bcommand not found\b/i, // cmd.exe, bash
  /\b\w*Exception\b/, // NullReferenceException
]);
// A wrapper's report of its own exit, not a failure of its own: npm's error /
// warn lines and its script echo (`> unity command ...`).
const WRAPPER_NOISE_RE = /^(?:npm (?:error|ERR!|warn|WARN)(?:\s|$)|>\s)/;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * True when a line of `output` other than the no-Pipeline error and a
 * wrapper's exit noise shows a failure of its own (GENUINE_FAILURE_RES).
 * @param {unknown} output
 * @returns {boolean}
 */
function otherFailureShown(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((l) => l.replace(ANSI_RE, '').trim())
    .filter((l) => l && !NO_PIPELINE_RE.test(l) && !WRAPPER_NOISE_RE.test(l))
    .some((l) => GENUINE_FAILURE_RES.some((re) => re.test(l)));
}

/**
 * True when a Unity build's red check command failed only for want of an
 * editor. God Mode's command: by its output and its shape
 * (deferToUnityEditor). The profile's own command (any shape, e.g. a wrapper
 * script): by its output alone - unityEditorMissing, and no other line shows
 * a failure of its own (otherFailureShown), so a real red is never deferred.
 * Never outside a Unity build (`unity` null).
 * @param {unknown} command
 * @param {{ok?:boolean, output?:string, timedOut?:boolean}|null} result runVerify's result
 * @param {{own?:boolean}|null|undefined} unity selfCheckCommandOf's `unity`
 * @returns {boolean}
 */
function selfCheckDeferred(command, result, unity) {
  if (!isObj(unity)) return false;
  if (unity.own === true) return unityEditorMissing(result) && !otherFailureShown(result.output);
  return deferToUnityEditor(command, result);
}

/** The self-check fix-up brief's extra rule in a Unity build: no files that only make a check pass. */
const UNITY_FIXUP_RULE =
  '- This is a Unity project: never add a package.json, *.cmd / *.bat shims (unity.cmd, grep.cmd) or wrapper scripts (.ps1, .sh) whose only purpose is to make the check command pass. If the check cannot run here, say so and end with `LUNA_BLOCKED selfcheck: <reason>`.';

/**
 * runPlanner args with the Unity rules added to extraPrompt (after any extra
 * request already there, e.g. a re-size).
 * @param {object} args
 * @returns {object}
 */
function withUnityPlannerRules(args) {
  const a = isObj(args) ? args : {};
  const extra = typeof a.extraPrompt === 'string' && a.extraPrompt.trim() ? a.extraPrompt.trim() : '';
  return { ...a, extraPrompt: [extra, UNITY_PLANNER_RULES.join('\n')].filter(Boolean).join('\n\n') };
}

module.exports = {
  VERIFY_DEFERRED_UNITY,
  UNITY_PLANNER_RULES,
  UNITY_FIXUP_RULE,
  CHECK_ROLES,
  unityEditorMissing,
  deferToUnityEditor,
  editorBoundReason,
  editorCheckNote,
  editorFreeVerify,
  withUnityPlannerRules,
  selfCheckCommandOf,
  selfCheckDeferred,
};
