// ============================================================================
// LunaCore - Luna's Work on Unity: one scene worker + UnityYAMLMerge (LW 3.36b)
// ----------------------------------------------------------------------------
// One Unity editor = one Unity MCP connection, and scene / prefab YAML merges
// badly. So a parallel build splits like this:
//
//   code packages   run in parallel worktrees as usual, and are told not to
//                   touch *.unity / *.prefab or open the editor
//   asset-prep      packages whose files are only raw asset files (FBX, GLB,
//   packages        PNG, WAV ... and their .meta) under Assets/**/Art/ or
//                   art/, plus the asset bookkeeping (design/ASSETS.md,
//                   design/ASSET_LICENSES.md, design/asset-renders/). They
//                   fetch / generate / export in parallel, without the
//                   editor; their Unity import and prefab step is deferred
//                   to the scene worker
//   scene worker    ONE package (id `scene-worker`) gets every card and every
//                   planned package whose files are scenes or prefabs (a
//                   mixed asset + scene card included). It is the only one
//                   that opens the editor, and it dependsOn the asset-prep
//                   packages, so it runs one import / prefab / placement
//                   pass after they finish.
//
// routeScenePackages() does that on the God Mode planner's answer
// (lunasworkBuild.wrapPlanner), before God Mode validates it. Dependencies
// on a merged package point at the scene worker; a package that would close
// a dependency cycle through it is folded into it too, so the plan never
// becomes unlaunchable. An asset-prep package that itself waits for the
// scene worker is not made a dependency of it (that would be a cycle). A
// plan without scene work is returned untouched.
//
// sceneOwnership() is the same rule as an ownership map in the shape of LW
// 2.12 (`{path|glob: owner}`, makePlan ctx.ownership): with the 2.12 guard
// merged, a code worker that edits a scene or prefab is stopped at once.
//
// configureUnityMerge(): UnityYAMLMerge as the git merge driver for
// .unity / .prefab / .asset - a managed block in the common git dir's
// info/attributes (git reads $GIT_COMMON_DIR/info/attributes in every
// worktree, so it covers the builders' worktrees too, and it is never a
// tracked file) and `git config merge.*` (local config is shared by every
// worktree of the repo too).
//
// The tracked .gitattributes is never written: a block there left the game
// checkout dirty after every run. A managed block an earlier LunaCore wrote
// into .gitattributes is removed only while it is uncommitted (the index
// copy has no block) - that edit was LunaCore's alone, and taking it out
// leaves the checkout as clean as it was. Once the block is committed or
// staged it is part of the project's history (Mati's or a build's commit):
// it is left alone, as it says nothing info/attributes does not.
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
// A Unity scene named in card text; a card naming one is never asset-prep.
const UNITY_SCENE_MENTION_RE = /[\w-]\.unity\b(?![.\w])/i;
const SCENE_GLOBS = Object.freeze(['**/*.unity', '**/*.prefab']);
// Raw asset files an asset-prep package makes without the Unity editor, with their .meta.
const RAW_ASSET_RE = /\.(?:fbx|glb|gltf|obj|blend|png|jpe?g|tga|exr|hdr|ogg|wav|mp3)(?:\.meta)?$/i;
// Where they live: Assets/**/Art/ (the Unity art root) or art/ (the sources).
// Case-insensitive: Windows and macOS checkouts do not tell Art from art.
const ART_PATH_RE = /^(?:Assets\/(?:[^/]+\/)*Art|art)\/[^/]/i;
// The asset bookkeeping an asset-prep package updates next to its files.
const ASSET_BOOKKEEPING = Object.freeze(new Set(['design/ASSET_LICENSES.md', 'design/ASSETS.md']));
const ASSET_RENDER_RE = /^design\/asset-renders\/[^/]+\.(?:png|jpe?g)$/i;
// The scene worker's import pass lists at most this many asset files.
const MAX_IMPORT_FILES = 20;
const MODEL_RANK = { sonnet: 0, opus: 1, fable: 2 };
// God Mode's planner limits (orchestraPlan.js).
const MAX_PROMPT_CHARS = 8000;
const MAX_TITLE_CHARS = 120;
const MAX_FILES = 50;

const SCENE_WORKER_BRIEF = [
  'You are the SCENE WORKER of this build: the only worker allowed to open the Unity editor (through Unity MCP) and to change scenes and prefabs (*.unity, *.prefab).',
  'One editor = one Unity MCP connection, so every scene and prefab change of this build is yours. Other packages run in parallel and change code only.',
  'Save every scene / prefab you change in the editor and commit them with your work.',
  'A luna_asset_* answer that says the Unity import is deferred means YOUR editor is not connected: that is a failure for you, not for an asset-prep worker. Open the Unity editor on this project and import the files with your Unity MCP before you finish.',
].join('\n');
const CODE_WORKER_NOTE =
  `Do not open the Unity editor and do not edit *.unity or *.prefab files: the ${SCENE_WORKER_ID} package owns all scene and prefab work in this build.`;
const ASSET_PREP_NOTE = [
  'This package prepares raw asset files only and runs in parallel, without the Unity editor: do not open Unity and do not create or edit *.unity or *.prefab files.',
  `The Unity import / prefab step is deferred to the ${SCENE_WORKER_ID} package, which runs after this one. A luna_asset_* answer that says the Unity import is deferred is expected, not a failure: the files are saved and ledgered.`,
].join(' ');

// UnityYAMLMerge as a git merge driver.
const MERGE_DRIVER = 'unityyamlmerge';
const MERGE_EXTENSIONS = Object.freeze(['unity', 'prefab', 'asset']);
const BLOCK_BEGIN = "# >>> LunaCore: UnityYAMLMerge for scenes, prefabs and assets (Luna's Work) >>>";
const BLOCK_END = '# <<< LunaCore: UnityYAMLMerge <<<';
const GITATTRIBUTES = '.gitattributes';
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

/** A repo path with forward slashes and no leading "./"; '' for anything else. */
function repoPath(file) {
  if (typeof file !== 'string') return '';
  const p = file.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return p.split('/').includes('..') ? '' : p;
}

/**
 * True for a file an asset-prep package may make without the Unity editor:
 * a raw asset file (or its .meta) under Assets/**\/Art/ or art/, or the asset
 * bookkeeping (design/ASSETS.md, design/ASSET_LICENSES.md, an asset render).
 */
function isAssetPrepFile(file) {
  const p = repoPath(file);
  if (!p) return false;
  if (ASSET_BOOKKEEPING.has(p) || ASSET_RENDER_RE.test(p)) return true;
  return ART_PATH_RE.test(p) && RAW_ASSET_RE.test(p);
}

const namesUnityScene = (card) => [card.text, card.details].some((t) => typeof t === 'string' && UNITY_SCENE_MENTION_RE.test(t));

/**
 * An asset-prep card lists files, every one of them an asset-prep file, and
 * names no Unity scene in its text. It runs in a parallel worktree; a prefab
 * named in its text is the one the scene worker makes later.
 */
function isAssetPrepCard(card) {
  if (!isObj(card)) return false;
  const files = list(card.files);
  return files.length > 0 && files.every(isAssetPrepFile) && !namesUnityScene(card);
}

/**
 * A card is scene work when it lists a scene / prefab file or names one in
 * its text, and is not an asset-prep card. A card mixing asset files with a
 * scene / prefab file is scene work.
 */
function isSceneCard(card) {
  if (!isObj(card) || isAssetPrepCard(card)) return false;
  if (list(card.files).some(isSceneFile)) return true;
  return [card.text, card.details].some((t) => typeof t === 'string' && SCENE_MENTION_RE.test(t));
}

/**
 * An asset-prep package (not scene work, checked first): its files are all
 * asset-prep files, or it lists no files and covers asset-prep cards only.
 * A package that also covers a code card (one listing other files) is not.
 */
function isAssetPrepPackage(pkg, assetAts, codeAts) {
  const ats = list(pkg.todoAts);
  if (ats.some((at) => codeAts.has(at))) return false;
  const files = list(pkg.files);
  if (files.length) return files.every(isAssetPrepFile);
  return ats.length > 0 && ats.every((at) => assetAts.has(at));
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

const unique = (xs) => [...new Set(xs)];

/** The scene worker's first step: import what the asset-prep packages made. '' without any. */
function importPass(feeders) {
  if (!feeders.length) return '';
  const files = unique(feeders.flatMap((p) => list(p.files).map(repoPath)).filter((f) => f.startsWith('Assets/') && !f.endsWith('.meta')));
  const shown = files.slice(0, MAX_IMPORT_FILES);
  return [
    '## Asset import pass (do this first)',
    `These packages prepared raw asset files without the Unity editor and are merged before you start: ${feeders.map((p) => p.id).join(', ')}.`,
    'Their Unity import and prefab step is yours, in one pass: import the new files under Assets/**/Art/ (the sources under art/ are not imported), make a prefab next to each model (FBX / GLB, same name) and a material for each texture that needs one, then use them in the scene work below.',
    ...(shown.length ? [`Their files: ${shown.join(', ')}${files.length > shown.length ? ', ...' : ''}.`] : []),
  ].join('\n');
}

function mergeScenePackages(members, memberIds, feeders) {
  const prompt = [
    SCENE_WORKER_BRIEF,
    importPass(feeders),
    ...members.map((p) => `## ${p.title || p.id}\n\n${typeof p.prompt === 'string' ? p.prompt : ''}`),
  ].filter(Boolean).join('\n\n');
  return {
    id: SCENE_WORKER_ID,
    title: `Scene worker: ${members.map((p) => p.title || p.id).join(', ')}`.slice(0, MAX_TITLE_CHARS),
    todoAts: unique(members.flatMap((p) => list(p.todoAts))),
    prompt: prompt.slice(0, MAX_PROMPT_CHARS),
    files: unique(members.flatMap((p) => list(p.files))).slice(0, MAX_FILES),
    dependsOn: unique([...members.flatMap((p) => list(p.dependsOn)).filter((d) => !memberIds.has(d)), ...feeders.map((p) => p.id)]),
    verify: (members.find((p) => typeof p.verify === 'string' && p.verify.trim()) || {}).verify || '',
    model: strongest(members.map((p) => p.model), MODEL_RANK) || members[0].model,
    effort: strongest(members.map((p) => p.effort), effortRank) || members[0].effort,
  };
}

/**
 * The asset-prep packages the scene worker waits for: not merged into it,
 * and not waiting for it themselves (that edge would close a cycle).
 */
function feederPackages(plain, memberIds, cards) {
  const assetAts = new Set(cards.filter(isAssetPrepCard).map((c) => c.at));
  const codeAts = new Set(cards.filter((c) => isObj(c) && list(c.files).length > 0 && !isAssetPrepCard(c)).map((c) => c.at));
  const depsOf = new Map(plain.map((p) => [p.id, list(p.dependsOn)]));
  const waitsForScene = (p) => [...closure(list(p.dependsOn), depsOf)].some((id) => id === SCENE_WORKER_ID || memberIds.has(id));
  return plain.filter((p) => !memberIds.has(p.id) && isAssetPrepPackage(p, assetAts, codeAts) && !waitsForScene(p));
}

/**
 * Routes ALL scene / prefab work of a planned build to the one scene worker;
 * asset-prep packages stay parallel and the scene worker depends on them.
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
  const feeders = feederPackages(plain, memberIds, list(cards));
  const feederIds = new Set(feeders.map((p) => p.id));
  const scene = mergeScenePackages(members, memberIds, feeders);
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
    const note = feederIds.has(p.id) ? ASSET_PREP_NOTE : CODE_WORKER_NOTE;
    const prompt = typeof p.prompt === 'string' ? `${p.prompt}\n\n${note}`.slice(0, MAX_PROMPT_CHARS) : p.prompt;
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

/** `text` without the managed block and the blank lines around it ('' when nothing else is left). */
function withoutAttributesBlock(text) {
  const src = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
  const start = src.indexOf(BLOCK_BEGIN);
  const end = start >= 0 ? src.indexOf(BLOCK_END, start) : -1;
  if (start < 0 || end < 0) return src;
  const rest = [src.slice(0, start).replace(/\n+$/, ''), src.slice(end + BLOCK_END.length).replace(/^\n+/, '')].filter(Boolean).join('\n');
  return rest ? rest.replace(/\n*$/, '\n') : '';
}

// Line endings and trailing blank lines do not count when two attribute files are compared.
const sameAttributes = (a, b) => String(a).replace(/\r\n/g, '\n').trimEnd() === String(b).replace(/\r\n/g, '\n').trimEnd();

/**
 * Takes a managed block an earlier LunaCore left uncommitted out of the
 * tracked .gitattributes; a committed or staged one is kept (see the header).
 * @returns {Promise<'none'|'kept'|'removed'>}
 */
async function dropUncommittedBlock(repoDir, execImpl, fsImpl) {
  const file = path.join(repoDir, GITATTRIBUTES);
  let text;
  try {
    text = String(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return 'none';
  }
  if (!text.includes(BLOCK_BEGIN)) return 'none';
  const stripped = withoutAttributesBlock(text);
  const listed = await runGit(repoDir, ['ls-files', '--', GITATTRIBUTES], execImpl);
  if (!listed.ok) return 'kept';
  if (!listed.stdout.trim()) {
    // Never committed: LunaCore made the file, or put its block into one nobody added yet.
    if (stripped) fsImpl.writeFileSync(file, stripped);
    else fsImpl.rmSync(file, { force: true });
    return 'removed';
  }
  const indexed = await runGit(repoDir, ['show', `:${GITATTRIBUTES}`], execImpl);
  if (!indexed.ok || indexed.stdout.includes(BLOCK_BEGIN)) return 'kept';
  if (!sameAttributes(stripped, indexed.stdout)) {
    // Mati's own uncommitted rules stay; only the block goes.
    fsImpl.writeFileSync(file, stripped);
    return 'removed';
  }
  // The block was the only change: the index copy comes back byte for byte (line endings too).
  const restored = await runGit(repoDir, ['checkout', '--', GITATTRIBUTES], execImpl);
  if (!restored.ok) fsImpl.writeFileSync(file, stripped);
  return 'removed';
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
 * @returns {Promise<{ok:boolean, attributes:boolean, driver:boolean, tool?:string, warning?:string, error?:string,
 *   legacyBlock?:'removed'|'kept'}>} legacyBlock: what became of a LunaCore block found in .gitattributes
 */
async function configureUnityMerge(repoDir, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const execImpl = opts.execImpl || execFile;
  try {
    const common = await runGit(repoDir, ['rev-parse', '--git-common-dir'], execImpl);
    if (!common.ok || !common.stdout.trim()) return { ok: false, attributes: false, driver: false, error: 'notGitRepo' };
    upsertAttributes(path.join(path.resolve(repoDir, common.stdout.trim()), 'info', 'attributes'), fsImpl);
    const legacy = await dropUncommittedBlock(repoDir, execImpl, fsImpl);
    const base = { ok: true, attributes: true, driver: false, ...(legacy === 'none' ? {} : { legacyBlock: legacy }) };

    const tool = opts.mergeTool || findUnityYamlMerge(repoDir, { fsImpl, platform: opts.platform, env: opts.env });
    if (!tool) return { ...base, warning: "UnityYAMLMerge not found for the project's editor version" };
    if (UNSAFE_TOOL_CHARS.test(tool)) return { ...base, ok: false, error: 'badMergeTool' };
    for (const [key, value] of driverConfig(tool)) {
      const res = await runGit(repoDir, ['config', key, value], execImpl);
      if (!res.ok) return { ...base, ok: false, error: 'gitConfigFailed', detail: res.stderr.trim().slice(0, 300) };
    }
    return { ...base, driver: true, tool };
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
  ASSET_PREP_NOTE,
  isSceneFile,
  isSceneCard,
  isAssetPrepFile,
  isAssetPrepCard,
  routeScenePackages,
  sceneOwnership,
  isUnityProject,
  findUnityYamlMerge,
  withAttributesBlock,
  withoutAttributesBlock,
  configureUnityMerge,
};
