// ============================================================================
// LunaCore - Luna's Work fresh code graph (docs/tbc_docs/LUNAS_WORK_PLAN.md, B19,
// LW 2.23)
// ----------------------------------------------------------------------------
// After every merge the controller (via src/lunasworkLoopHooks.js) calls
// refreshGraph() on the project checkout:
//
//   1. index   re-index the repo in codebase-memory. Its own CLI first
//              (`codebase-memory-mcp cli index_repository {"repo_path": ...}`,
//              found on PATH); without it, one headless `claude -p` whose ONLY
//              allowed tool is the codebase-memory MCP tool index_repository
//              (no built-in tool at all).
//   2. maps    refresh docs/CODEMAPS: one headless `claude -p` that may read
//              the repo and write ONLY under docs/CODEMAPS (path-scoped allow
//              rules, dontAsk denies the rest), with no shell, no MCP server
//              and no user settings or hooks. The codemaps workflow is in the
//              prompt itself: with user settings off no plugin loads, so a
//              plugin agent (--agent ecc:doc-updater) is "not found" and the
//              CLI exits 1 before doing anything. In a Unity project the
//              generated folders (Library/, Temp/, ...) are denied to Read.
//              A failed call's note names the cause: exit code or timeout,
//              the signal, and the CLI's stderr or its error JSON. With no
//              claude on PATH or an account at its usage limit the step is
//              skipped with that reason.
//   3. commit  only docs/CODEMAPS is committed (`docs(codemaps): ...`): the
//              commit is built off to the side (a throwaway index, commit-tree
//              on HEAD), pushed to the checkout's branch on origin FIRST, and
//              only then is the checkout fast-forwarded to it - so the next
//              lunasworkWiring.syncCheckout still fast-forwards, and a failed
//              push moves nothing (no reset, ever). It is pushed only when the
//              checkout has no unpublished commit of its own. On any failure
//              the maps are discarded (docs/CODEMAPS back to HEAD), so a dirty
//              checkout never blocks the next fast-forward. Any other tracked
//              file the updater touched is restored; a new one is reported.
//
// Every step is non-fatal: refreshGraph() always resolves, and a failed step
// is one line in `notes` (the run report lists it).
//
// Exports
//   CODEMAPS_DIR        'docs/CODEMAPS'
//   INDEX_TOOL          'mcp__codebase-memory-mcp__index_repository'
//   buildIndexCliArgs(repoPath) -> string[]
//   buildIndexClaudeArgs({model?, budgetUsd?}) -> string[]
//   buildCodemapsArgs({model?, budgetUsd?, unity?}) -> string[]
//   buildCodemapsPrompt({iteration, unity?}) -> string
//   isUnityProject(repoPath) -> boolean
//   describeClaudeFailure(call) -> {skip, detail}   a failed runClaude answer, as a note
//   createGraphRefresher({runClaude?, execImpl?, resolveCli?, env?, log?, timeoutMs?, gitTimeoutMs?})
//       -> {refreshGraph({repoPath, runId?, iteration}) -> Promise<{ok, indexed, via, codemaps,
//           committed, pushed, sha, notes}>}
//     runClaude({args, prompt, cwd, env, timeoutMs}) -> Promise<{stdout}|{error, detail?, exitCode?,
//         signal?, stderr?, timeoutMs?}>
//         (default: lunasworkCritic.execClaude)
//     execImpl  child_process.execFile compatible (default: execFile) - git and the CLI
//     resolveCli(command) -> string|null  absolute path on PATH (default: resolveOnPath)
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parsePlannerOutput } = require('./orchestraPlan');
const { execClaude } = require('./lunasworkCritic');
const { resolveOnPath } = require('./lunasworkSecondOpinion');
const { withScratchIndex } = require('./gitScratchIndex');
const { gitFailure } = require('./worktrees');
const { scrub } = require('./hostscrub');

const CODEMAPS_DIR = 'docs/CODEMAPS';
const CLI_COMMAND = 'codebase-memory-mcp';
const INDEX_TOOL = 'mcp__codebase-memory-mcp__index_repository';
// The updater reads the code and writes the maps; no shell, no MCP server.
const CODEMAPS_TOOLS = 'Read,Grep,Glob,Write,Edit';
// dontAsk denies whatever these rules do not allow: writes outside docs/CODEMAPS included.
const CODEMAPS_ALLOWED = `Read,Grep,Glob,Write(${CODEMAPS_DIR}/**),Edit(${CODEMAPS_DIR}/**)`;
const CODEMAPS_DISALLOWED = 'Bash,NotebookEdit';
const INDEX_MODEL = 'haiku';
const CODEMAPS_MODEL = 'sonnet';
const INDEX_BUDGET_USD = 0.5;
const CODEMAPS_BUDGET_USD = 1;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;
const MAX_NOTE_CHARS = 200;
const MAX_LISTED = 5;
// A failure note carries the CLI's own words (stderr or error JSON) up to this length.
const MAX_FAILURE_CHARS = 400;
// Unity writes these itself (Library/ alone can be gigabytes); they are no code to map.
const UNITY_GENERATED_DIRS = ['Library', 'Temp', 'obj', 'Obj', 'Logs', 'UserSettings', 'Build', 'Builds', 'MemoryCaptures', 'Recordings'];
// Every Unity project has it; nothing else does.
const UNITY_MARKER = path.join('ProjectSettings', 'ProjectVersion.txt');
// node's execFile message starts with the argv: no cause in it.
const ARGV_ECHO_RE = /^Command failed:/;
// The checked-out branch as `git symbolic-ref HEAD` prints it; nothing else goes into a refspec.
const BRANCH_REF_RE = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

const INDEX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['indexed', 'detail'],
  properties: { indexed: { type: 'boolean' }, detail: { type: 'string' } },
};
const CODEMAPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['updated', 'summary'],
  properties: { updated: { type: 'boolean' }, summary: { type: 'string' } },
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The CLI's own words in a note: secrets masked first, then capped.
const said = (s) => clip(scrub(String(s === undefined || s === null ? '' : s)), MAX_FAILURE_CHARS);
const clip = (s, max = MAX_NOTE_CHARS) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const noop = () => {};

/** argv for the codebase-memory CLI - one tool call, the repo path as JSON. */
function buildIndexCliArgs(repoPath) {
  return ['cli', 'index_repository', JSON.stringify({ repo_path: repoPath })];
}

/** argv for the headless index call: no built-in tool, only index_repository. */
function buildIndexClaudeArgs({ model = INDEX_MODEL, budgetUsd = INDEX_BUDGET_USD } = {}) {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(INDEX_SCHEMA),
    '--model', model,
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--allowedTools', INDEX_TOOL,
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

function buildIndexPrompt(repoPath) {
  return [
    'Call the codebase-memory index_repository tool exactly once with repo_path set to the path below. Do nothing else.',
    'Answer ONLY with JSON {"indexed": true|false, "detail": "<one line: what the tool said>"}.',
    '',
    `repo_path: ${repoPath}`,
  ].join('\n');
}

/** A Unity project root: ProjectSettings/ProjectVersion.txt is there. */
function isUnityProject(repoPath) {
  try {
    return fs.statSync(path.join(repoPath, UNITY_MARKER)).isFile();
  } catch {
    return false; // no marker: not a Unity project
  }
}

/** Read deny rules for Unity's generated folders (they cover Grep and Glob as well). */
const unityReadDenies = () => UNITY_GENERATED_DIRS.map((dir) => `Read(./${dir}/**)`);

/**
 * argv for the codemaps updater: read + write files, no shell, no MCP server.
 * No --agent: with --setting-sources '' no plugin loads, so a plugin agent is never found.
 * The schema stays inline: claude.exe is spawned without a shell and the argv is short.
 */
function buildCodemapsArgs({ model = CODEMAPS_MODEL, budgetUsd = CODEMAPS_BUDGET_USD, unity = false } = {}) {
  const disallowed = unity ? [CODEMAPS_DISALLOWED, ...unityReadDenies()].join(',') : CODEMAPS_DISALLOWED;
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(CODEMAPS_SCHEMA),
    '--model', model,
    '--effort', 'low',
    '--tools', CODEMAPS_TOOLS,
    '--permission-mode', 'dontAsk',
    '--setting-sources', '',
    '--allowedTools', CODEMAPS_ALLOWED,
    '--disallowedTools', disallowed,
    '--strict-mcp-config',
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

/** The codemaps workflow (what the ECC doc-updater agent does), spelled out: no plugin is loaded. */
function buildCodemapsPrompt({ iteration, unity = false }) {
  const skip = unity
    ? `This is a Unity project: map Assets/ (scripts, scenes, prefabs, ScriptableObjects), Packages/manifest.json and ProjectSettings/ only. Never open ${UNITY_GENERATED_DIRS.filter((d) => d !== 'Obj').map((d) => `${d}/`).join(', ')} - Unity generates them.`
    : 'Skip generated and vendored folders (node_modules/, dist/, build/, .git/ and the like).';
  return [
    `Refresh the codemaps of this repository after Luna's Work iteration ${iteration}.`,
    `Update the files under ${CODEMAPS_DIR}/ so they match the code as it is now; create them when there are none.`,
    'Workflow:',
    '1. Map the repository: its areas, entry points and framework patterns. Read only what you need; list folders before opening files.',
    `2. Keep ${CODEMAPS_DIR}/INDEX.md as the overview of all areas, plus one <area>.md per area (merge small areas; at most 8 files).`,
    '3. Each codemap: "# <Area> Codemap", "**Entry Points:**", an "## Architecture" ASCII sketch, a "## Key Modules" table (Module | Purpose | Exports | Dependencies), "## Data Flow" and "## Related Areas". Under 500 lines each.',
    '4. Name only files and symbols that exist; keep what still holds in the current maps and fix what does not.',
    skip,
    `Write ONLY files under ${CODEMAPS_DIR}/ - never change any other file.`,
    'Answer ONLY with JSON {"updated": true|false, "summary": "<one line>"}.',
  ].join('\n');
}

/**
 * A failed runClaude answer as one note line: what ended the call (exit code,
 * timeout, signal) and why (the CLI's stderr, or the runner's detail when it
 * is not just node's argv echo). No claude, or an account at its limit: skip.
 * @returns {{skip:boolean, detail:string}}
 */
function describeClaudeFailure(call) {
  if (!isObj(call)) return { skip: false, detail: 'claude gave no answer' };
  if (call.error === 'noClaude') return { skip: true, detail: 'claude CLI not found on PATH' };
  const why = said(call.stderr || (ARGV_ECHO_RE.test(String(call.detail || '')) ? '' : call.detail));
  if (call.error === 'limit') return { skip: true, detail: `Claude usage limit${why ? `: ${why}` : ''}` };
  const signal = call.signal ? ` (${call.signal})` : '';
  const head = call.error === 'timeout'
    ? `claude timed out${Number.isFinite(call.timeoutMs) ? ` after ${Math.round(call.timeoutMs / 1000)}s` : ''}${signal}`
    : Number.isInteger(call.exitCode) ? `claude exited ${call.exitCode}${signal}` : `claude ${call.error || 'failed'}${signal}`;
  return { skip: false, detail: why ? `${head}: ${why}` : head };
}

/** A claude envelope that parsed as an error (is_error JSON on stdout), with the exit code when there was one. */
function describeEnvelopeFailure(call, parsed) {
  const exit = Number.isInteger(call.exitCode) ? `claude exited ${call.exitCode}, ` : '';
  if (parsed.error === 'badJson') return `${exit}claude answer was not JSON${call.stderr ? `: ${said(call.stderr)}` : ''}`;
  return `${exit}claude error JSON (${parsed.error})${parsed.detail ? `: ${said(parsed.detail)}` : ''}`;
}

const inCodemaps = (file) => {
  const p = file.replace(/\\/g, '/');
  return p === CODEMAPS_DIR || p.startsWith(`${CODEMAPS_DIR}/`);
};

/** `git status --porcelain` lines -> [{code, file}] (renames: the new name). */
function parseStatus(out) {
  return String(out || '')
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => {
      const file = l.slice(3).split(' -> ').pop().replace(/^"|"$/g, '');
      return { code: l.slice(0, 2), file };
    });
}

/**
 * @param {{runClaude?:Function, execImpl?:Function, resolveCli?:(command:string)=>string|null,
 *   env?:()=>object, log?:(line:string)=>void, timeoutMs?:number, gitTimeoutMs?:number, tmpBase?:string}} [deps]
 *   gitTimeoutMs: per git call (default GIT_TIMEOUT_MS; tests under load pass more)
 *   tmpBase: where the per-call scratch index folder is made (default os.tmpdir())
 */
function createGraphRefresher(deps = {}) {
  const tmpBase = typeof deps.tmpBase === 'string' && deps.tmpBase ? deps.tmpBase : undefined;
  const runClaude = typeof deps.runClaude === 'function' ? deps.runClaude : execClaude;
  const execImpl = typeof deps.execImpl === 'function' ? deps.execImpl : execFile;
  const envOf = () => (typeof deps.env === 'function' ? deps.env() : process.env);
  const resolveCli = typeof deps.resolveCli === 'function' ? deps.resolveCli : (command) => resolveOnPath(command, { env: envOf() });
  const log = typeof deps.log === 'function' ? deps.log : noop;
  const timeoutMs = deps.timeoutMs || STEP_TIMEOUT_MS;
  const gitTimeoutMs = Number.isInteger(deps.gitTimeoutMs) && deps.gitTimeoutMs > 0 ? deps.gitTimeoutMs : GIT_TIMEOUT_MS;

  /** Why a call failed, never ''. git's own words go through gitFailure (names our timeout). */
  const failureText = (file, err, stderr, timeout) =>
    clip(file === 'git' ? gitFailure(err, stderr, timeout) : String(stderr || '').trim() || (err && err.message) || 'failed');

  /** One execFile call; resolves {ok, out, err}, never rejects. */
  function run(file, args, cwd, timeout = gitTimeoutMs, env = envOf()) {
    return new Promise((resolve) => {
      try {
        execImpl(file, args, { cwd, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) =>
          // Only the end is trimmed: a porcelain status line starts with a meaningful space.
          resolve({ ok: !err, out: String(stdout || '').trimEnd(), err: err ? failureText(file, err, stderr, timeout) : clip(stderr) }));
      } catch (err) {
        resolve({ ok: false, out: '', err: clip(err && err.message) || 'did not start' });
      }
    });
  }

  const git = (cwd, args) => run('git', args, cwd);

  // ---- 1. index ----

  /** The CLI's answer is JSON; an `error` / `isError` in it is a failure too. */
  function cliFailure(out) {
    try {
      const parsed = JSON.parse(out);
      if (isObj(parsed) && (parsed.isError === true || parsed.error)) return clip(parsed.error || out);
    } catch {
      // not JSON: the exit code alone decides
    }
    return null;
  }

  async function indexViaCli(repoPath, file) {
    const res = await run(file, buildIndexCliArgs(repoPath), repoPath, timeoutMs);
    if (!res.ok) return { ok: false, detail: res.err || 'failed' };
    const failure = cliFailure(res.out);
    return failure ? { ok: false, detail: failure } : { ok: true };
  }

  async function indexViaClaude(repoPath) {
    const call = await runClaude({ args: buildIndexClaudeArgs(), prompt: buildIndexPrompt(repoPath), cwd: repoPath, env: envOf(), timeoutMs });
    if (!isObj(call) || call.error) return { ok: false, detail: clip((isObj(call) && (call.detail || call.error)) || 'failed') };
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return { ok: false, detail: clip(parsed.detail || parsed.error) };
    if (!isObj(parsed.raw) || parsed.raw.indexed !== true) return { ok: false, detail: clip((isObj(parsed.raw) && parsed.raw.detail) || 'not indexed') };
    return { ok: true };
  }

  /** The CLI when it is on PATH as a real executable (a .cmd shim would need a shell), else claude. */
  async function index(repoPath) {
    const file = resolveCli(CLI_COMMAND);
    const runnable = typeof file === 'string' && file && !/\.(cmd|bat)$/i.test(file);
    const via = runnable ? 'cli' : 'claude';
    const res = runnable ? await indexViaCli(repoPath, file) : await indexViaClaude(repoPath);
    return { ...res, via };
  }

  // ---- 2 + 3. codemaps and their commit ----

  async function dirtyFiles(repoPath) {
    // quotePath off: a non-ASCII path comes back as is, not C-quoted.
    const res = await git(repoPath, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all']);
    return res.ok ? parseStatus(res.out) : null;
  }

  /** Files the updater changed outside docs/CODEMAPS: tracked ones restored, new ones reported. */
  async function cleanStray(repoPath, before, notes) {
    const after = await dirtyFiles(repoPath);
    if (!after) return;
    const known = new Set(before.map((s) => s.file));
    const stray = after.filter((s) => !known.has(s.file) && !inCodemaps(s.file));
    const tracked = stray.filter((s) => s.code !== '??').map((s) => s.file);
    const untracked = stray.filter((s) => s.code === '??').map((s) => s.file);
    if (tracked.length) {
      const restored = await git(repoPath, ['checkout', '--', ...tracked]);
      notes.push(`codemaps updater touched ${tracked.length} file(s) outside ${CODEMAPS_DIR}${restored.ok ? ' - restored' : ` - not restored (${restored.err})`}`);
    }
    if (untracked.length) {
      notes.push(`codemaps updater left ${untracked.length} new file(s) outside ${CODEMAPS_DIR}: ${untracked.slice(0, MAX_LISTED).join(', ')}`);
    }
  }

  /** @returns {Promise<{ok:boolean, skip?:boolean, detail?:string}>} */
  async function updateCodemaps(repoPath, iteration) {
    const unity = isUnityProject(repoPath);
    const call = await runClaude({ args: buildCodemapsArgs({ unity }), prompt: buildCodemapsPrompt({ iteration, unity }), cwd: repoPath, env: envOf(), timeoutMs });
    if (!isObj(call) || call.error) return { ok: false, ...describeClaudeFailure(call) };
    const parsed = parsePlannerOutput(call.stdout);
    if (parsed.ok) return { ok: true };
    // The account hit its limit mid-call: nothing is wrong with the maps step itself.
    if (parsed.error === 'limit') return { ok: false, skip: true, detail: `Claude usage limit: ${said(parsed.detail)}` };
    return { ok: false, detail: describeEnvelopeFailure(call, parsed) };
  }

  /**
   * HEAD's tree with the current docs/CODEMAPS, built in a throwaway index so
   * the checkout's own index is never touched. @returns {Promise<{tree?:string, err?:string}>}
   */
  function codemapsTree(repoPath) {
    // The index lives in a private folder, never in the temp root (see src/gitScratchIndex.js).
    return withScratchIndex('lw-codemaps-', async (tmpIndex) => {
      const env = { ...envOf(), GIT_INDEX_FILE: tmpIndex };
      const step = (args) => run('git', args, repoPath, gitTimeoutMs, env);
      for (const args of [['read-tree', 'HEAD'], ['add', '-A', '--', CODEMAPS_DIR]]) {
        const res = await step(args);
        if (!res.ok) return { err: res.err };
      }
      const tree = await step(['write-tree']);
      return tree.ok ? { tree: tree.out } : { err: tree.err };
    }, { base: tmpBase, onCleanupError: (err, dir) => log(`codemaps scratch index not removed: ${dir} (${clip(err && err.message)})`) });
  }

  /**
   * docs/CODEMAPS back to HEAD (index and worktree, new files removed): maps
   * that were not committed must not block the next fast-forward.
   */
  async function discardCodemaps(repoPath) {
    await git(repoPath, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', CODEMAPS_DIR]);
    // Fails when HEAD has no maps yet: then there is nothing to restore.
    await git(repoPath, ['checkout', 'HEAD', '--', CODEMAPS_DIR]);
    await git(repoPath, ['clean', '-f', '-d', '-q', '--', CODEMAPS_DIR]);
  }

  /** The checked-out branch on origin, when the checkout has no commit origin lacks. */
  async function publishableBranch(repoPath) {
    const ref = await git(repoPath, ['symbolic-ref', '-q', 'HEAD']);
    if (!ref.ok || !BRANCH_REF_RE.test(ref.out) || ref.out.includes('..')) return { err: 'not on a branch' };
    const fetched = await git(repoPath, ['fetch', '-q', 'origin', ref.out]);
    if (!fetched.ok) return { err: `fetch failed: ${fetched.err}` };
    // Built on HEAD, the maps commit would publish any local commit with it.
    const published = await git(repoPath, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
    return published.ok ? { ref: ref.out } : { err: 'the checkout has commits origin does not have' };
  }

  /**
   * The codemaps commit is made off to the side (commit-tree on HEAD), pushed
   * first, and only then is the checkout fast-forwarded to it. A failed push
   * moves nothing.
   */
  async function commitCodemaps(repoPath, iteration, notes) {
    if (!fs.existsSync(path.join(repoPath, CODEMAPS_DIR))) return { codemaps: 'unchanged' };
    const built = await codemapsTree(repoPath);
    const headTree = await git(repoPath, ['rev-parse', 'HEAD^{tree}']);
    if (!built.tree || !headTree.ok) return { codemaps: 'failed', why: `codemaps not staged: ${built.err || headTree.err || 'git write-tree gave no tree'}` };
    if (built.tree === headTree.out) return { codemaps: 'unchanged' };
    const message = `docs(codemaps): refresh after Luna's Work iteration ${iteration}`;
    const commit = await git(repoPath, ['commit-tree', built.tree, '-p', 'HEAD', '-m', message]);
    const sha = commit.out;
    if (!commit.ok || !SHA_RE.test(sha)) return { codemaps: 'failed', why: `codemaps not committed: ${commit.err || 'no commit'}` };
    const branch = await publishableBranch(repoPath);
    const pushed = branch.ref ? await git(repoPath, ['push', '-q', 'origin', `${sha}:${branch.ref}`]) : { ok: false, err: branch.err };
    if (!pushed.ok) return { codemaps: 'failed', why: `codemaps not pushed (${pushed.err})` };
    // Staged first: the fast-forward then finds the maps already matching its result.
    const staged = await git(repoPath, ['add', '-A', '--', CODEMAPS_DIR]);
    const merged = staged.ok ? await git(repoPath, ['merge', '--ff-only', '-q', sha]) : staged;
    if (!merged.ok) {
      notes.push(`codemaps pushed, checkout not fast-forwarded (${merged.err}) - maps discarded, the next sync brings them`);
      await discardCodemaps(repoPath);
    }
    return { codemaps: 'committed', committed: true, pushed: true, sha };
  }

  async function codemaps(repoPath, iteration, notes) {
    const before = await dirtyFiles(repoPath);
    if (!before) {
      notes.push('codemaps skipped: git status failed');
      return { codemaps: 'skipped' };
    }
    const updated = await updateCodemaps(repoPath, iteration);
    await cleanStray(repoPath, before, notes);
    // What the updater wrote before failing is not committed half-done.
    const res = updated.ok
      ? await commitCodemaps(repoPath, iteration, notes)
      : updated.skip
        ? { codemaps: 'skipped', why: `codemaps skipped: ${updated.detail}` }
        : { codemaps: 'failed', why: `codemaps update failed: ${updated.detail}` };
    if (res.codemaps === 'skipped') {
      // A limit can hit mid-call: whatever was written goes too.
      await discardCodemaps(repoPath);
      notes.push(res.why);
      return { codemaps: 'skipped' };
    }
    if (res.codemaps !== 'failed') return res;
    await discardCodemaps(repoPath);
    notes.push(`${res.why} - maps discarded`);
    return { codemaps: 'failed' };
  }

  /**
   * Re-index + codemaps for the checkout. Always resolves.
   * @param {{repoPath:string, runId?:string, iteration:number}} opts
   */
  async function refreshGraph(opts) {
    const o = isObj(opts) ? opts : {};
    const notes = [];
    const result = (fields) => {
      const out = { indexed: false, via: null, codemaps: 'skipped', committed: false, pushed: false, sha: null, ...fields, notes };
      return { ...out, ok: out.indexed && ['committed', 'unchanged'].includes(out.codemaps) && !notes.length };
    };
    if (typeof o.repoPath !== 'string' || !path.isAbsolute(o.repoPath)) {
      notes.push('graph refresh skipped: no repo folder');
      return result({});
    }
    try {
      const indexed = await index(o.repoPath);
      if (!indexed.ok) notes.push(`code graph not re-indexed (${indexed.via}): ${indexed.detail}`);
      const maps = await codemaps(o.repoPath, Number.isInteger(o.iteration) ? o.iteration : 0, notes);
      log(`[lunaswork] graph refresh: index ${indexed.ok ? 'ok' : 'failed'} via ${indexed.via}, codemaps ${maps.codemaps}`);
      return result({ indexed: indexed.ok, via: indexed.via, ...maps });
    } catch (err) {
      notes.push(`graph refresh crashed: ${clip(err && err.message)}`);
      return result({});
    }
  }

  return { refreshGraph };
}

module.exports = {
  CODEMAPS_DIR,
  INDEX_TOOL,
  buildIndexCliArgs,
  buildIndexClaudeArgs,
  buildCodemapsArgs,
  buildCodemapsPrompt,
  isUnityProject,
  describeClaudeFailure,
  UNITY_GENERATED_DIRS,
  parseStatus,
  createGraphRefresher,
  GIT_TIMEOUT_MS,
};
