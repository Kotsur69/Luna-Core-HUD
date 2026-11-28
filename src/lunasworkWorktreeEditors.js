// ============================================================================
// LunaCore - Luna's Work on Unity: which Unity editor a builder may drive
// ----------------------------------------------------------------------------
// Seen live in run lwmwzajado (blade&bullet):
//
//   - The scene worker, in its worktree .luna-worktrees/blade&bullet/
//     scene-worker-n8xvl, sent an open-scene request with its worktree path to
//     Mati's live editor (opened on the main checkout, which the playtest
//     uses). Unity showed the modal "About to open another project! ...
//     [Open] [Cancel]", which blocks the editor; Open would have broken the run.
//   - Builders reported "I couldn't compile it or run its tests in Unity", and
//     an untested BuildSandbox hook later left the main editor stuck between
//     edit and play mode (score 76 -> 4).
//
// So, in a Unity build, every God Mode package (each one runs in its own
// worktree) gets one of two editor modes:
//
//   'none'      the default. No Unity editor at all: the Unity MCP servers,
//               the `unity` CLI and the Unity binary are denied by name
//               (lunasworkToolkit.roleLaunch), and the brief says so. Scene
//               work is file edits; editor checks run in the live editor
//               after the merge.
//   'worktree'  the scene worker (lunasworkScene SCENE_WORKER_ID) and every
//               package whose files are editor code (editor scripts, play-mode
//               commands, the playtest driver: isEditorCodeFile). It opens
//               its OWN editor on its worktree, verifies there (EditMode tests
//               + a short play-mode smoke, both reported) and closes it before
//               it finishes. The `unity` CLI talks to the editor of the folder
//               it runs in (src/orchestraUnityVerify.js), so it is allowed;
//               a Unity MCP server is not (its target editor is set by the
//               Claude setup, not by the worktree), and neither is any unity
//               command or `cd` naming the main checkout.
//
// HARD RULE (as in src/unityWorktreeEditors.js): the editor on the main
// checkout belongs to the playtest after the merge. No builder ever drives it.
//
// At most MAX_WORKTREE_EDITORS 'worktree' packages run at once (RAM: a Unity
// editor with a fresh import holds several GB); God Mode holds the rest back
// (src/orchestraEditorSlots.js) and closes a package's editor once the
// package settles. Worktree removal closes editors too (src/worktrees.js).
//
// Deny rules are Claude Code permission rules: they hold in every permission
// mode, but they only see the command line. What they cannot see through (a
// script, `bash -c`, another shell, a relative path to the main checkout) is
// covered by the brief alone.
//
// Pure: no IO.
// ============================================================================

'use strict';

const path = require('path');
const { SCENE_WORKER_ID } = require('./lunasworkScene');

/** Worktree editors open at once in a Luna's Work build (RAM). */
const MAX_WORKTREE_EDITORS = 2;

const EDITOR_NONE = 'none';
const EDITOR_WORKTREE = 'worktree';
const EDITOR_MODES = Object.freeze([EDITOR_NONE, EDITOR_WORKTREE]);

// MCP servers that drive a live Unity editor, by the names Unity setups give
// them: `unity` (the kit's own, blade&bullet START_POINT.md), `unityMCP` (MCP
// for Unity in Mati's gamedev Claude profile) and the usual spellings. A deny
// rule for a server that is not configured does nothing.
const UNITY_MCP_SERVERS = Object.freeze(['unity', 'unityMCP', 'UnityMCP', 'unity-mcp', 'mcp-unity', 'unity_mcp', 'mcpforunity']);
// The unity CLI and the editor binary, as a command word (Windows does not tell their case apart).
const UNITY_BINS = Object.freeze(['unity', 'Unity', 'unity.exe', 'Unity.exe']);
// Commands that move a shell into another folder.
const CD_BINS = Object.freeze(['cd', 'pushd']);
// A rule body cannot hold these (the permission syntax is Tool(body)).
// eslint-disable-next-line no-control-regex
const RULE_UNSAFE = /[()\u0000-\u001f\u007f]/;
// Shorter than this is a drive root or "/": a rule on it would deny far too much.
const MIN_GUARDED_PATH_CHARS = 4;

// Editor code: an Editor folder anywhere under Assets/, the game's dev scripts,
// the playtest driver (src/lunasworkUnity.js PLAYTEST_DRIVER_FILES), and a
// C# file or asmdef named after the playtest (its `playtest ...` commands).
const EDITOR_FOLDER_RE = /^Assets\/(?:[^/]+\/)*Editor\//i;
const DEV_SCRIPTS_RE = /(?:^|\/)Scripts\/Dev\//i;
const PLAYTEST_DRIVER_RE = /^Assets\/LunaPlaytest\//i;
const PLAYTEST_FILE_RE = /(?:^|\/)[^/]*playtest[^/]*\.(?:cs|asmdef)$/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

/** A repo path with forward slashes and no leading "./"; '' for anything else. */
function repoFile(file) {
  if (typeof file !== 'string') return '';
  const p = file.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return p.split('/').includes('..') ? '' : p;
}

/** True for a file whose change needs a Unity editor to verify (see the header). */
function isEditorCodeFile(file) {
  const p = repoFile(file);
  if (!p) return false;
  return EDITOR_FOLDER_RE.test(p) || DEV_SCRIPTS_RE.test(p) || PLAYTEST_DRIVER_RE.test(p) || PLAYTEST_FILE_RE.test(p);
}

/**
 * True for a package that opens its own Unity editor on its worktree: the
 * scene worker, or a package with an editor-code file. Reads only the
 * package's id and files, so the brief (lunasworkBuild.kitOf) and God Mode's
 * launch cap (src/orchestraEditorSlots.js) always agree.
 * @param {unknown} pkg a planned package
 */
function needsWorktreeEditor(pkg) {
  if (!isObj(pkg)) return false;
  return pkg.id === SCENE_WORKER_ID || list(pkg.files).some(isEditorCodeFile);
}

/** The editor mode of a package in a Unity build. */
function editorModeOf(pkg) {
  return needsWorktreeEditor(pkg) ? EDITOR_WORKTREE : EDITOR_NONE;
}

// ---- deny rules --------------------------------------------------------------------

/** The spellings a shell command may use for `dir`: as given, forward slashes, backslashes, Git Bash's /c/... */
function pathForms(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return [];
  const raw = dir.trim().replace(/[\\/]+$/, '');
  const forward = raw.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(forward);
  const back = drive ? forward.replace(/\//g, '\\') : null;
  const gitBash = drive ? `/${drive[1].toLowerCase()}/${forward.slice(3)}` : null;
  return [...new Set([raw, forward, back, gitBash].filter((p) => p && p.length >= MIN_GUARDED_PATH_CHARS && !RULE_UNSAFE.test(p)))];
}

/** Every Unity MCP server, denied by name. */
function unityMcpDenyRules() {
  return UNITY_MCP_SERVERS.map((s) => `mcp__${s}`);
}

/**
 * Bash deny rules for a unity command or a `cd` that names the main checkout.
 * LunaCore's worktrees live in <parent>/.luna-worktrees/, never under the main
 * checkout, so no rule matches a package's own worktree path.
 * @param {string} mainCheckout absolute
 */
function mainCheckoutDenyRules(mainCheckout) {
  // Either platform's absolute form: the rules are strings, read the same on every OS.
  const absolute = (p) => path.win32.isAbsolute(p) || path.posix.isAbsolute(p);
  if (typeof mainCheckout !== 'string' || !absolute(mainCheckout.trim())) return [];
  return pathForms(mainCheckout).flatMap((p) => [...UNITY_BINS, ...CD_BINS].map((bin) => `Bash(${bin} *${p}*)`));
}

/**
 * The deny rules of one editor mode on top of the kit's: every Unity MCP
 * server always; in 'worktree' mode also any unity command or `cd` naming the
 * main checkout. ('none' takes the unity tool out of the kit, so roleLaunch
 * denies its CLI rules with the other tools out of the kit.)
 * @param {'none'|'worktree'} mode
 * @param {string} [mainCheckout]
 * @returns {string[]}
 */
function editorDenyRules(mode, mainCheckout) {
  if (!EDITOR_MODES.includes(mode)) return [];
  return [...unityMcpDenyRules(), ...(mode === EDITOR_WORKTREE ? mainCheckoutDenyRules(mainCheckout) : [])];
}

// ---- brief ---------------------------------------------------------------------------

const where = (mainCheckout) => (typeof mainCheckout === 'string' && mainCheckout.trim() ? ` (${mainCheckout.trim()})` : '');

/** The rule every package of a Unity build gets, whatever its mode. */
function mainEditorRule(mainCheckout) {
  return [
    `Unity editors: the live Unity editor on the main checkout${where(mainCheckout)} belongs to the playtest after the merge. Never drive it:`,
    'no Unity MCP call, no scene open, no play mode, no `unity` command aimed at it (a request with your worktree path makes it show "About to open another project!", which blocks it).',
    'Scene work is done by editing files, by Unity in batchmode on your own worktree, or in your own worktree editor - the last two only when this brief gives this package one.',
  ].join(' ');
}

const NO_EDITOR_LINES = Object.freeze([
  'This package has no Unity editor: Unity MCP, the `unity` CLI and the Unity binary are blocked for it (batchmode too). Edit the files only (C#, asmdef, scene / prefab YAML where your cards allow it).',
  'A check in this prompt that needs the Unity editor (a `unity ...` command, play mode, the Test Runner) is not run here, whatever a line above says: review your C# carefully for compile errors (usings, asmdef references, method signatures) and list that check as "not run here" in your hand-back. It runs in the live editor after the merge.',
]);

function worktreeEditorLines(max) {
  return [
    'This package gets its OWN Unity editor on this worktree (it changes scenes / prefabs or editor code: editor scripts, play-mode commands, the playtest driver). The worktree is your own copy of the project: tests and play mode there are allowed.',
    `LunaCore runs at most ${max} worktree editors at once and holds the next package back until one closes, so keep yours open only while you need it.`,
    '1. Open it on this worktree, the folder you run in: the Unity editor of the project\'s version (ProjectSettings/ProjectVersion.txt, in Unity Hub\'s Editor folder) with -projectPath "<this worktree>". Drive it with the `unity` CLI run inside this worktree; Unity MCP tools are blocked in this build (they can reach the main checkout\'s editor). The first open imports the whole project: wait for it.',
    '2. EditMode tests: run them in this editor (Test Runner, or `unity command test run ...`), or in batchmode before you open it (-batchmode -projectPath "<this worktree>" -runTests -testPlatform EditMode -testResults <a file in the OS temp folder>). Fix until they pass.',
    '3. Play-mode smoke: enter play mode in this editor, let it run about 10 seconds, read the Console (no exceptions, no compile errors), stop play mode and check the editor is back in edit mode - never left between edit and play mode.',
    '4. Close the editor before you finish (File > Exit). LunaCore also closes it when this package finishes or its worktree is removed.',
    '5. Report both in your final message, one line each: "EditMode tests: <N passed, N failed | not run: why>" and "Play-mode smoke: <ok | failed: what you saw>".',
  ];
}

/**
 * The brief lines for one editor mode (none for no mode: not a Unity build).
 * @param {'none'|'worktree'|null|undefined} mode
 * @param {{mainCheckout?:string, max?:number}} [opts]
 * @returns {string[]}
 */
function editorBriefLines(mode, { mainCheckout, max = MAX_WORKTREE_EDITORS } = {}) {
  if (!EDITOR_MODES.includes(mode)) return [];
  return [mainEditorRule(mainCheckout), ...(mode === EDITOR_WORKTREE ? worktreeEditorLines(max) : NO_EDITOR_LINES)];
}

module.exports = {
  MAX_WORKTREE_EDITORS,
  EDITOR_NONE,
  EDITOR_WORKTREE,
  EDITOR_MODES,
  UNITY_MCP_SERVERS,
  UNITY_BINS,
  isEditorCodeFile,
  needsWorktreeEditor,
  editorModeOf,
  pathForms,
  mainCheckoutDenyRules,
  editorDenyRules,
  mainEditorRule,
  editorBriefLines,
};
