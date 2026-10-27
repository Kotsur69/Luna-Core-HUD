// ============================================================================
// LunaCore - Luna's Work on Unity: one scene worker + UnityYAMLMerge (LW 3.36b)
// ----------------------------------------------------------------------------
// One Unity editor = one Unity MCP connection, and scene / prefab YAML merges
// badly. So a parallel build splits like this:
//
//   code packages   run in parallel worktrees as usual, and are told not to
//                   touch *.unity / *.prefab or open the editor
//   scene worker    ONE package (id `scene-worker`) gets every card and every
//                   planned package whose files are scenes or prefabs. It is
//                   the only one that opens the editor.
//
// routeScenePackages() does that on the God Mode planner's answer
// (lunasworkBuild.wrapPlanner), before God Mode validates it. Dependencies
// on a merged package point at the scene worker; a package that would close
// a dependency cycle through it is folded into it too, so the plan never
// becomes unlaunchable. A plan without scene work is returned untouched.
//
// sceneOwnership() is the same rule as an ownership map in the shape of LW
// 2.12 (`{path|glob: owner}`, makePlan ctx.ownership): with the 2.12 guard
// merged, a code worker that edits a scene or prefab is stopped at once.
//
// configureUnityMerge(): UnityYAMLMerge as the git merge driver for
// .unity / .prefab / .asset - a managed block in .gitattributes, the same
// block in the common git dir's info/attributes (shared by every worktree,
// effective before anything is committed), and `git config merge.*` (local
// config is shared by every worktree of the repo too).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runGit } = require('./worktrees');
const { EFFORTS } = require('./efforts');

const SCENE_WORKER_ID = 'scene-worker';
const SCENE_FILE_RE = /\.(?:unity|prefab)$/i;
// A scene / prefab file named in card text: "Main.unity", not "com.unity.inputsystem".
const SCENE_MENTION_RE = /[\w-]\.(?:unity|prefab)\b(?![.\w])/i;
const SCENE_GLOBS = Object.freeze(['**/*.unity', '**/*.prefab']);
const MODEL_RANK = { sonnet: 0, opus: 1 };
// God Mode's planner limits (orchestraPlan.js).
const MAX_PROMPT_CHARS = 8000;
const MAX_TITLE_CHARS = 120;
const MAX_FILES = 50;

const SCENE_WORKER_BRIEF = [
  'You are the SCENE WORKER of this build: the only worker allowed to open the Unity editor (through Unity MCP) and to change scenes and prefabs (*.unity, *.prefab).',
  'One editor = one Unity MCP connection, so every scene and prefab change of this build is yours. Other packages run in parallel and change code only.',
  'Save every scene / prefab you change in the editor and commit them with your work.',
].join('\n');
const CODE_WORKER_NOTE =
  `Do not open the Unity editor and do not edit *.unity or *.prefab files: the ${SCENE_WORKER_ID} package owns all scene and prefab work in this build.`;

// UnityYAMLMerge as a git merge driver.
const MERGE_DRIVER = 'unityyamlmerge';
const MERGE_EXTENSIONS = Object.freeze(['unity', 'prefab', 'asset']);
const BLOCK_BEGIN = "# >>> LunaCore: UnityYAMLMerge for scenes, prefabs and assets (Luna's Work) >>>";
const BLOCK_END = '# <<< LunaCore: UnityYAMLMerge <<<';
const VERSION_RE = /^\d{4}\.\d+\.\d+[abfpx]\d+$/;
// Goes into a command git runs through sh: no quoting or expansion characters.
const UNSAFE_TOOL_CHARS = /["$`\n\r]/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

// ---- scene work -----------------------------------------------------------------------

/** True for a *.unity / *.prefab path. */
function isSceneFile(file) {
  return typeof file === 'string' && SCENE_FILE_RE.test(file.trim());
}

/** A card is scene work when it lists a scene / prefab file or names one in its text. */
function isSceneCard(card) {
  if (!isObj(card)) return false;
  if (list(card.files).some(isSceneFile)) return true;
  return [card.text, card.details].some((t) => typeof t === 'string' && SCENE_MENTION_RE.test(t));
}

/** Ids reachable from `starts` through dependsOn. */
function closure(starts, depsOf) {
  const seen = new Set();
  const stack = [...starts];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...list(depsOf.get(id)));
  }
  return seen;
}

/**
 * The member ids, grown by every package that sits on a dependency path from
 * the scene worker back to itself (merging would otherwise create a cycle).
 */
function foldCycles(packages, memberIds) {
  const depsOf = new Map(packages.map((p) => [p.id, list(p.dependsOn)]));
  const members = new Set(memberIds);
  for (let changed = true; changed;) {
    changed = false;
    const below = closure([...members].flatMap((id) => list(depsOf.get(id))), depsOf);
    for (const p of packages) {
      if (members.has(p.id) || !below.has(p.id)) continue;
      // p is something the scene worker waits for; does p wait for the scene worker?
      if ([...closure(list(depsOf.get(p.id)), depsOf)].some((id) => members.has(id))) {
        members.add(p.id);
        changed = true;
      }
    }
  }
  return members;
}

const strongest = (values, rank) => values.reduce((best, v) => (v in rank && (best === null || rank[v] > rank[best]) ? v : best), null);
const effortRank = Object.fromEntries(EFFORTS.map((e, i) => [e, i]));

function mergeScenePackages(members, memberIds) {
  const unique = (xs) => [...new Set(xs)];
  const prompt = [
    SCENE_WORKER_BRIEF,
    ...members.map((p) => `## ${p.title || p.id}\n\n${typeof p.prompt === 'string' ? p.prompt : ''}`),
  ].join('\n\n');
  return {
    id: SCENE_WORKER_ID,
    title: `Scene worker: ${members.map((p) => p.title || p.id).join(', ')}`.slice(0, MAX_TITLE_CHARS),
    todoAts: unique(members.flatMap((p) => list(p.todoAts))),
    prompt: prompt.slice(0, MAX_PROMPT_CHARS),
    files: unique(members.flatMap((p) => list(p.files))).slice(0, MAX_FILES),
    dependsOn: unique(members.flatMap((p) => list(p.dependsOn)).filter((d) => !memberIds.has(d))),
    verify: (members.find((p) => typeof p.verify === 'string' && p.verify.trim()) || {}).verify || '',
    model: strongest(members.map((p) => p.model), MODEL_RANK) || members[0].model,
    effort: strongest(members.map((p) => p.effort), effortRank) || members[0].effort,
  };
}

/**
 * Routes ALL scene / prefab work of a planned build to the one scene worker.
 * @param {unknown[]} packages the planner's raw packages
 * @param {object[]} cards the build's cards (their `at`, files, text)
 * @returns {unknown[]} a new list; the same list when there is no scene work
 */
function routeScenePackages(packages, cards) {
  if (!Array.isArray(packages)) return packages;
  const sceneAts = new Set(list(cards).filter(isSceneCard).map((c) => c.at));
  const plain = packages.filter(isObj);
  const isScenePackage = (p) =>
    p.id === SCENE_WORKER_ID || list(p.files).some(isSceneFile) || list(p.todoAts).some((at) => sceneAts.has(at));
  const seeds = plain.filter(isScenePackage).map((p) => p.id);
  if (!seeds.length) return packages;

  const memberIds = foldCycles(plain, seeds);
  const members = plain.filter((p) => memberIds.has(p.id));
  const scene = mergeScenePackages(members, memberIds);
  const out = [];
  for (const p of packages) {
    if (!isObj(p)) {
      out.push(p);
      continue;
    }
    if (memberIds.has(p.id)) {
      if (p === members[0]) out.push(scene);
      continue;
    }
    const deps = [...new Set(list(p.dependsOn).map((d) => (memberIds.has(d) ? SCENE_WORKER_ID : d)))];
    const prompt = typeof p.prompt === 'string' ? `${p.prompt}\n\n${CODE_WORKER_NOTE}`.slice(0, MAX_PROMPT_CHARS) : p.prompt;
    out.push({ ...p, dependsOn: deps, prompt });
  }
  return out;
}

/**
 * The scene rule as an ownership map (LW 2.12 shape, owner = package id):
 * every scene and prefab belongs to the scene worker. A given map keeps its
 * code entries; scene / prefab entries of other owners move to the worker.
 * @param {Record<string,string|number>|Array<{path:string, owner?:string|number, cardId?:number}>|null} [base]
 * @returns {Record<string,string|number>}
 */
function sceneOwnership(base = null) {
  const pairs = Array.isArray(base)
    ? base.filter(isObj).map((e) => [e.path, e.owner !== undefined ? e.owner : e.cardId])
    : Object.entries(isObj(base) ? base : {});
  const out = {};
  for (const [p, owner] of pairs) {
    if (typeof p !== 'string' || !p) continue;
    out[p] = isSceneFile(p) ? SCENE_WORKER_ID : owner;
  }
  for (const glob of SCENE_GLOBS) out[glob] = SCENE_WORKER_ID;
  return out;
}

// ---- Unity project + merge driver -------------------------------------------------------

/** A Unity project has ProjectSettings/ProjectVersion.txt at its root. */
function isUnityProject(repoDir, fsImpl = fs) {
  try {
    return typeof repoDir === 'string' && fsImpl.existsSync(path.join(repoDir, 'ProjectSettings', 'ProjectVersion.txt'));
  } catch {
    return false;
  }
}

/** The editor version the project was saved with, or null (validated: it becomes part of a path). */
function editorVersion(repoDir, fsImpl = fs) {
  try {
    const text = String(fsImpl.readFileSync(path.join(repoDir, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'));
    const m = /^m_EditorVersion:\s*(\S+)\s*$/m.exec(text);
    return m && VERSION_RE.test(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

/** Where Unity Hub installs UnityYAMLMerge for that editor version. */
function yamlMergeCandidates(version, { platform, env }) {
  if (platform === 'win32') {
    const roots = [...new Set([env.ProgramFiles, 'C:\\Program Files'].filter(Boolean))];
    return roots.map((r) => path.win32.join(r, 'Unity', 'Hub', 'Editor', version, 'Editor', 'Data', 'Tools', 'UnityYAMLMerge.exe'));
  }
  if (platform === 'darwin') return [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/Tools/UnityYAMLMerge`];
  return env.HOME ? [path.posix.join(env.HOME, 'Unity', 'Hub', 'Editor', version, 'Editor', 'Data', 'Tools', 'UnityYAMLMerge')] : [];
}

/** The installed UnityYAMLMerge of the project's editor version, or null. */
function findUnityYamlMerge(repoDir, { fsImpl = fs, platform = process.platform, env = process.env } = {}) {
  const version = editorVersion(repoDir, fsImpl);
  if (!version) return null;
  return yamlMergeCandidates(version, { platform, env }).find((p) => fsImpl.existsSync(p)) || null;
}

/** The .gitattributes lines, inside the managed block. */
function attributesBlock() {
  return [BLOCK_BEGIN, ...MERGE_EXTENSIONS.map((ext) => `*.${ext} merge=${MERGE_DRIVER} eol=lf`), BLOCK_END].join('\n');
}

/** `text` with the managed block replaced, or appended when missing. */
function withAttributesBlock(text) {
  const block = attributesBlock();
  const src = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
  const start = src.indexOf(BLOCK_BEGIN);
  const end = start >= 0 ? src.indexOf(BLOCK_END, start) : -1;
  if (start >= 0 && end >= 0) return `${src.slice(0, start)}${block}${src.slice(end + BLOCK_END.length)}`;
  const body = src.replace(/\n*$/, '');
  return `${body ? `${body}\n\n` : ''}${block}\n`;
}

/** Writes the managed block into one attributes file. @returns {boolean} whether it changed */
function upsertAttributes(file, fsImpl) {
  let before = '';
  try {
    before = String(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    before = '';
  }
  const after = withAttributesBlock(before);
  if (after === before) return false;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, after);
  return true;
}

/** git config entries of the merge driver. Forward slashes: git runs the driver through sh. */
function driverConfig(tool) {
  const bin = tool.replace(/\\/g, '/');
  return [
    [`merge.${MERGE_DRIVER}.name`, 'Unity SmartMerge (UnityYAMLMerge)'],
    [`merge.${MERGE_DRIVER}.driver`, `"${bin}" merge -h -p --force %O %B %A %A`],
    [`merge.${MERGE_DRIVER}.recursive`, 'binary'],
  ];
}

/**
 * Configures UnityYAMLMerge for the repo and all its worktrees. Idempotent;
 * resolves a result, never rejects.
 * @param {string} repoDir
 * @param {{mergeTool?:string, execImpl?:Function, fsImpl?:object, platform?:string, env?:object}} [opts]
 *   mergeTool: an explicit UnityYAMLMerge path (otherwise Unity Hub's, for the project's version)
 * @returns {Promise<{ok:boolean, attributes:boolean, driver:boolean, tool?:string, warning?:string, error?:string}>}
 */
async function configureUnityMerge(repoDir, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const execImpl = opts.execImpl || execFile;
  try {
    const common = await runGit(repoDir, ['rev-parse', '--git-common-dir'], execImpl);
    if (!common.ok || !common.stdout.trim()) return { ok: false, attributes: false, driver: false, error: 'notGitRepo' };
    upsertAttributes(path.join(repoDir, '.gitattributes'), fsImpl);
    upsertAttributes(path.join(path.resolve(repoDir, common.stdout.trim()), 'info', 'attributes'), fsImpl);

    const tool = opts.mergeTool || findUnityYamlMerge(repoDir, { fsImpl, platform: opts.platform, env: opts.env });
    if (!tool) return { ok: true, attributes: true, driver: false, warning: "UnityYAMLMerge not found for the project's editor version" };
    if (UNSAFE_TOOL_CHARS.test(tool)) return { ok: false, attributes: true, driver: false, error: 'badMergeTool' };
    for (const [key, value] of driverConfig(tool)) {
      const res = await runGit(repoDir, ['config', key, value], execImpl);
      if (!res.ok) return { ok: false, attributes: true, driver: false, error: 'gitConfigFailed', detail: res.stderr.trim().slice(0, 300) };
    }
    return { ok: true, attributes: true, driver: true, tool };
  } catch (err) {
    return { ok: false, attributes: false, driver: false, error: 'failed', detail: String(err && err.message).slice(0, 300) };
  }
}

module.exports = {
  SCENE_WORKER_ID,
  SCENE_GLOBS,
  MERGE_DRIVER,
  MERGE_EXTENSIONS,
  CODE_WORKER_NOTE,
  isSceneFile,
  isSceneCard,
  routeScenePackages,
  sceneOwnership,
  isUnityProject,
  findUnityYamlMerge,
  withAttributesBlock,
  configureUnityMerge,
};
