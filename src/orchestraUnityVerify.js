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
// Two halves:
//   planning    (lunasworkBuild.wrapPlanner, Unity builds only): the planner
//               is told package verify runs without an editor, and a verify
//               that calls the unity CLI / the editor, or is prose, is moved
//               into the package prompt as an editor check the worker runs
//               against its own editor. `verify` is left empty.
//   integration (orchestraIntegrate.mergeAndVerify): a verify that failed
//               ONLY for want of an editor is deferred, not red. The merge
//               stays; Luna's Work checks it in the live editor after the
//               checkout update (recompile + compile check, then the playtest).
//               "Only" is read from the output AND the command's shape: the
//               no-Pipeline error, nothing else failing, a unity call, every
//               part before it chained with && (it ran, so they passed) and
//               nothing but unity calls after it. Anything else stays red.
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

// The editor check moved into a package prompt (a verify is at most 300 chars
// once validated; the raw planner value is capped here too).
const MAX_CHECK_CHARS = 300;
const NOTE_GAP = '\n\n';
const EDITOR_CHECK_NOTE =
  'Editor check: LunaCore cannot run this one after the merge (no Unity editor is open on its merge worktree), so run it yourself against your own Unity editor before you commit, and fix until it passes:';

/** The planner's Unity rules (handed over as extraPrompt, after the to-do list). */
const UNITY_PLANNER_RULES = Object.freeze([
  'This is a Unity project. These rules override the "verify" rule above, a to-do\'s own verify included:',
  '- "verify" runs through a shell in a git worktree where no Unity editor is open, after the merge. It must work without an editor: leave it empty (""), or use a static check such as `grep -q "class GameClock" Assets/Scripts/GameClock.cs`. Never a `unity ...` command, never `Unity -batchmode`, never prose.',
  "- Editor checks (script recompile, `unity command test run ...`, play mode, a clean Console) go into the package prompt's definition of done: the worker runs them against its own Unity editor before it commits.",
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

/** The editor check a package prompt gets for an editor-bound `verify`. */
function editorCheckNote(verify) {
  return `${EDITOR_CHECK_NOTE} ${oneLine(verify, MAX_CHECK_CHARS)}`;
}

/** `prompt` with `note` after it, within `maxChars`: the prompt is never cut, the note is shortened instead. */
function appendWithin(prompt, note, maxChars) {
  const base = typeof prompt === 'string' ? prompt : '';
  const room = maxChars - base.length - NOTE_GAP.length;
  if (room <= 0) return base;
  return [base, note.slice(0, room)].filter(Boolean).join(NOTE_GAP);
}

/**
 * A planned package whose verify needs an editor (or is prose), with that
 * verify moved into its prompt as an editor check (editorCheckNote; shortened
 * or left out when the prompt is at its cap - the caller can tell by
 * comparing) and `verify` emptied. Any other package is returned as it is
 * (the same object).
 * @param {object} pkg a raw planner package
 * @param {number} maxPromptChars the planner's prompt cap
 * @returns {object}
 */
function editorFreeVerify(pkg, maxPromptChars) {
  if (!isObj(pkg) || !editorBoundReason(pkg.verify)) return pkg;
  return { ...pkg, verify: '', prompt: appendWithin(pkg.prompt, editorCheckNote(pkg.verify), maxPromptChars) };
}

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
  unityEditorMissing,
  deferToUnityEditor,
  editorBoundReason,
  editorCheckNote,
  editorFreeVerify,
  withUnityPlannerRules,
};
