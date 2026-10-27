// ============================================================================
// LunaCore - Luna's Work milestone demo video (docs/LUNAS_WORK_PLAN.md B13, LW 3.33)
// ----------------------------------------------------------------------------
// At a milestone gate the iteration's playtest evidence becomes a 30-90 s
// walkthrough, rendered with Mati's existing "Remotion vids" setup:
//
//   1. buildDemoProps(): a title card (the milestone), then one scene per
//      journey in TEST_PLAN.md order - its screenshot, the journey name as
//      the caption, its steps underneath. No journey with a screenshot: the
//      desktop key screens instead. Playwright recordings (.webm) in the
//      evidence folder ride along. Scene length stretches or shrinks so the
//      whole video stays between MIN_SECONDS and MAX_SECONDS.
//   2. The props and the images go to <runsDir>/lunaswork-<runId>/demo-<slug>/
//      (props.json + public/), so the props refer to images by file name
//      (Remotion's staticFile) and the render needs nothing outside.
//   3. renderCommand(): a fixed command - the Remotion CLI of that setup, run
//      by LunaCore's own node, `render <composition> <out.mp4>
//      --props=<props.json> --public-dir=<public>`. Only paths LunaCore made
//      and the composition id (a checked setting) are on it.
//
// Where the setup lives is never guessed: LUNACORE_REMOTION_DIR, else
// `remotionDir` in config/lunaswork-demo.local.json. Neither set (or not a
// Remotion project): nothing renders and the result carries a note that asks
// Mati for the path - the props are still written, ready for a manual render.
//
// The video is attached to the milestone email when it is at most
// ATTACH_MAX_BYTES (gmailsend's binary cap), else it stays in the run folder
// and the email links it. A render failure never blocks the run: make()
// always resolves.
//
// Props shape (version 1), for the Remotion composition:
//   { version, fps, width, height, durationInFrames,
//     title: { text, subtitle, frames },
//     scenes: [{ image, caption, steps[], passed, frames }],
//     recordings: [file names] }
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const paths = require('./paths');
const pack = require('./lunasworkPack');
const { MAX_BINARY_ATTACHMENT } = require('./gmailsend');
const { killTree } = require('./lunasworkAdapters');

const PROPS_VERSION = 1;
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const TITLE_SECONDS = 4;
const SCENE_SECONDS = 6;
const MIN_SECONDS = 30;
const MAX_SECONDS = 90;
const MIN_SCENE_SECONDS = 3;
const MAX_SCENES = Math.floor((MAX_SECONDS - TITLE_SECONDS) / MIN_SCENE_SECONDS);
const MAX_STEPS = 4;
const MAX_RECORDINGS = 5;
const MAX_CAPTION = 120;
const MAX_STEP = 160;
const ATTACH_MAX_BYTES = MAX_BINARY_ATTACHMENT;
const RENDER_TIMEOUT_MS = 15 * 60 * 1000;
// Remotion prints a progress line per frame batch: room for a long render's output.
const RENDER_MAX_BUFFER = 50 * 1024 * 1024;

const SETTINGS_FILE = 'lunaswork-demo.local.json';
const REMOTION_DIR_ENV = 'LUNACORE_REMOTION_DIR';
const DEFAULT_COMPOSITION = 'LunaWorkDemo';
// Remotion composition ids: letters, digits and dashes.
const COMPOSITION_RE = /^[A-Za-z0-9-]{1,64}$/;
// A run id that may name a folder (lunasworkReport FILE_ID_RE).
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_RE = /\.(png|jpe?g)$/i;
const RECORDING_RE = /\.webm$/i;
const VIDEO_RE = /^demo-[a-z0-9-]{1,40}\.mp4$/;

/** The note when the Remotion setup is unknown - user-facing, pl + en. */
const NO_PATH_NOTE = {
  en: "Demo video not rendered: LunaCore does not know where your 'Remotion vids' setup is. "
    + `Set ${REMOTION_DIR_ENV}, or add {"remotionDir": "<folder>"} to config/${SETTINGS_FILE}.`,
  pl: "Film demo nie zostal wyrenderowany: LunaCore nie wie, gdzie jest Twoj projekt 'Remotion vids'. "
    + `Ustaw ${REMOTION_DIR_ENV} albo dopisz {"remotionDir": "<folder>"} do config/${SETTINGS_FILE}.`,
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const slugOf = (v) => oneLine(v, 200).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'milestone';

function isFile(p) {
  try {
    return typeof p === 'string' && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return typeof p === 'string' && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// ---- props --------------------------------------------------------------------------

/** Journeys in TEST_PLAN.md order; ones the plan does not name keep their place after. */
function inJourneyOrder(journeys, order) {
  const rank = new Map((Array.isArray(order) ? order : []).map((name, i) => [name, i]));
  return journeys
    .map((j, i) => ({ j, i, r: rank.has(j.name) ? rank.get(j.name) : rank.size + i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.j);
}

/** The shots of the walkthrough: journeys first, key screens when there are none. */
function shotsFrom(report, order) {
  const r = isObj(report) ? report : {};
  const journeys = (Array.isArray(r.journeys) ? r.journeys : []).filter(
    (j) => isObj(j) && isObj(j.evidence) && IMAGE_RE.test(String(j.evidence.screenshot || '')) && isFile(j.evidence.screenshot),
  );
  if (journeys.length) {
    return inJourneyOrder(journeys, order).map((j) => ({
      from: j.evidence.screenshot,
      caption: oneLine(j.name, MAX_CAPTION),
      steps: (Array.isArray(j.evidence.steps) ? j.evidence.steps : []).map((s) => oneLine(s, MAX_STEP)).filter(Boolean).slice(0, MAX_STEPS),
      passed: j.passed === true,
    }));
  }
  return (Array.isArray(r.screens) ? r.screens : [])
    .filter((s) => isObj(s) && /-desktop$/.test(String(s.name)) && isFile(s.screenshot))
    .map((s) => ({ from: s.screenshot, caption: oneLine(String(s.name).replace(/-desktop$/, '').replace(/[-_]+/g, ' '), MAX_CAPTION), steps: [], passed: true }));
}

/** Frames per scene, so title + scenes land between MIN_SECONDS and MAX_SECONDS. */
function sceneFrames(count) {
  const want = SCENE_SECONDS * FPS;
  const atLeast = Math.ceil(((MIN_SECONDS - TITLE_SECONDS) * FPS) / count);
  const atMost = Math.floor(((MAX_SECONDS - TITLE_SECONDS) * FPS) / count);
  return Math.min(atMost, Math.max(atLeast, want));
}

/**
 * The walkthrough props from one iteration's playtest evidence. Pure apart
 * from checking that the evidence files exist.
 * @param {{milestone?:string|null, repoName?:string, iteration?:number, report?:object,
 *   evidenceDir?:string|null, journeyOrder?:string[]}} input
 * @returns {{props:object, files:Array<{from:string, name:string}>}|null} null = no evidence to show
 */
function buildDemoProps(input) {
  const o = isObj(input) ? input : {};
  const shots = shotsFrom(o.report, o.journeyOrder).slice(0, MAX_SCENES);
  if (!shots.length) return null;
  const frames = sceneFrames(shots.length);
  const files = [];
  const scenes = shots.map((s, i) => {
    const name = `scene-${String(i + 1).padStart(2, '0')}${path.extname(s.from).toLowerCase()}`;
    files.push({ from: s.from, name });
    return { image: name, caption: s.caption, steps: s.steps, passed: s.passed, frames };
  });
  const recordings = listDir(o.evidenceDir)
    .filter((f) => RECORDING_RE.test(f))
    .slice(0, MAX_RECORDINGS)
    .map((f, i) => {
      const name = `recording-${String(i + 1).padStart(2, '0')}.webm`;
      files.push({ from: path.join(o.evidenceDir, f), name });
      return name;
    });
  const titleFrames = TITLE_SECONDS * FPS;
  const milestone = oneLine(o.milestone, 80) || 'Milestone';
  const subtitle = [oneLine(o.repoName, 80), Number.isInteger(o.iteration) ? `iteration ${o.iteration}` : ''].filter(Boolean).join(' - ');
  return {
    props: {
      version: PROPS_VERSION,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      durationInFrames: titleFrames + frames * scenes.length,
      title: { text: `Milestone reached: ${milestone}`, subtitle, frames: titleFrames },
      scenes,
      recordings,
    },
    files,
  };
}

// ---- the Remotion setup -------------------------------------------------------------

function readLocalSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.local(SETTINGS_FILE), 'utf8'));
    return isObj(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Where Mati's Remotion project is: the env var first, then the local
 * setting. Only an absolute folder with a package.json counts.
 * @returns {{dir:string, composition:string}|null}
 */
function remotionSetup({ env = process.env, readLocal = readLocalSettings } = {}) {
  const local = readLocal() || {};
  const raw = (env && env[REMOTION_DIR_ENV]) || local.remotionDir;
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || !isDir(raw) || !isFile(path.join(raw, 'package.json'))) return null;
  const composition = typeof local.composition === 'string' && COMPOSITION_RE.test(local.composition) ? local.composition : DEFAULT_COMPOSITION;
  return { dir: path.resolve(raw), composition };
}

/** The Remotion CLI script installed in that project (its package.json `bin`), or null. */
function remotionCli(dir) {
  const pkgDir = path.join(dir, 'node_modules', '@remotion', 'cli');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : isObj(pkg.bin) ? pkg.bin.remotion : null;
    const file = typeof bin === 'string' ? path.resolve(pkgDir, bin) : null;
    return file && file.startsWith(pkgDir + path.sep) && isFile(file) ? file : null;
  } catch {
    return null;
  }
}

/**
 * The fixed render command: props JSON in, mp4 out. LunaCore's own node runs
 * the CLI script (ELECTRON_RUN_AS_NODE), so no shell and no npx.cmd.
 * @returns {{command:string, args:string[], cwd:string}|null} null = no Remotion CLI there
 */
function renderCommand({ setup, propsFile, outFile, publicDir, nodePath = process.execPath, cli = remotionCli }) {
  const script = cli(setup.dir);
  if (!script) return null;
  return {
    command: nodePath,
    args: [script, 'render', setup.composition, outFile, `--props=${propsFile}`, `--public-dir=${publicDir}`],
    cwd: setup.dir,
  };
}

/**
 * Default renderer: runs the command. Resolves {ok} or {ok:false, error,
 * detail}; never rejects. On timeout the whole tree goes - Remotion's own
 * Chrome and ffmpeg children too, not just the node at the top - so the
 * child runs in its own group off Windows (killTree kills the group).
 */
function execRender(cmd, { env = process.env, timeoutMs = RENDER_TIMEOUT_MS, execImpl = execFile, killTreeImpl } = {}) {
  const killImpl = killTreeImpl || ((pid) => killTree(pid, { platform: process.platform, execFile, kill: process.kill.bind(process) }));
  return new Promise((resolve) => {
    let timedOut = false;
    let timer = null;
    try {
      const child = execImpl(
        cmd.command,
        cmd.args,
        {
          cwd: cmd.cwd,
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          detached: process.platform !== 'win32',
          maxBuffer: RENDER_MAX_BUFFER,
        },
        (error, _stdout, stderr) => {
          clearTimeout(timer);
          if (timedOut) return resolve({ ok: false, error: 'timeout' });
          if (!error) return resolve({ ok: true });
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ ok: false, error: 'failed', detail: 'render output too long' });
          resolve({ ok: false, error: 'failed', detail: oneLine(String(stderr || '').split('\n').filter(Boolean).pop() || error.message, 300) });
        },
      );
      timer = setTimeout(() => {
        timedOut = true;
        if (child && Number.isInteger(child.pid)) Promise.resolve(killImpl(child.pid)).catch(() => {});
      }, timeoutMs);
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, error: 'failed', detail: oneLine(errText(err), 300) });
    }
  });
}

// ---- files --------------------------------------------------------------------------

/** <runsDir>/lunaswork-<runId>; null for an id that may not name a folder. */
function runFolder(runsDir, runId) {
  if (typeof runsDir !== 'string' || !runsDir || typeof runId !== 'string' || !FILE_ID_RE.test(runId)) return null;
  return path.join(runsDir, `lunaswork-${runId}`);
}

/** The rendered demo videos of a run, oldest name first (the return pack links them). */
function listDemoVideos(runsDir, runId) {
  const dir = runFolder(runsDir, runId);
  return dir ? listDir(dir).filter((f) => VIDEO_RE.test(f)).map((f) => path.join(dir, f)) : [];
}

function writeWorkDir(workDir, built) {
  const publicDir = path.join(workDir, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  for (const f of built.files) fs.copyFileSync(f.from, path.join(publicDir, f.name));
  const propsFile = path.join(workDir, 'props.json');
  fs.writeFileSync(propsFile, JSON.stringify(built.props, null, 2), 'utf8');
  return { publicDir, propsFile };
}

// ---- the maker ----------------------------------------------------------------------

const defaultLog = (line) => console.error(line);

/**
 * @param {{runsDir:()=>string, env?:()=>object, readLocal?:()=>object|null,
 *   render?:(cmd:{command:string, args:string[], cwd:string})=>Promise<{ok:boolean, error?:string, detail?:string}>,
 *   cli?:(dir:string)=>string|null, readTestPlan?:(repoPath:string)=>string,
 *   attachMaxBytes?:number, log?:(line:string)=>void}} deps
 */
function createDemoMaker(deps) {
  const log = deps.log || defaultLog;
  const env = deps.env || (() => process.env);
  const render = deps.render || ((cmd) => execRender(cmd, { env: env() }));
  const readTestPlan = deps.readTestPlan || ((repoPath) => pack.readPackFile(repoPath, 'TEST_PLAN.md') || '');
  const attachMax = Number.isFinite(deps.attachMaxBytes) ? deps.attachMaxBytes : ATTACH_MAX_BYTES;

  function journeyOrder(repoPath) {
    try {
      return pack.parseJourneys(readTestPlan(repoPath));
    } catch {
      return [];
    }
  }

  async function renderAndPlace(run, setup, work, outFile, slug) {
    const cmd = renderCommand({ setup, propsFile: work.propsFile, outFile, publicDir: work.publicDir, cli: deps.cli });
    if (!cmd) return { ok: false, error: 'noRemotionCli', propsFile: work.propsFile };
    let res;
    try {
      res = await render(cmd);
    } catch (err) {
      res = { ok: false, error: 'failed', detail: oneLine(errText(err), 300) };
    }
    if (!isObj(res) || !res.ok || !isFile(outFile)) {
      const error = (isObj(res) && res.error) || 'noVideo';
      log(`[lunaswork] demo video not rendered: ${error}${isObj(res) && res.detail ? ` ${res.detail}` : ''}`);
      return { ok: false, error, propsFile: work.propsFile };
    }
    const bytes = fs.statSync(outFile).size;
    if (bytes > attachMax) return { ok: true, file: outFile, bytes, link: outFile };
    const attach = { filename: `lunaswork-${run.id}-demo-${slug}.mp4`, mimeType: 'video/mp4', content: fs.readFileSync(outFile) };
    return { ok: true, file: outFile, bytes, attach };
  }

  /**
   * One milestone's demo video. Never rejects.
   * @param {object} run the run snapshot
   * @param {{milestone?:string, report?:object|null, evidenceDir?:string|null, iteration?:number}} [ctx]
   * @returns {Promise<{ok:boolean, file?:string, bytes?:number, attach?:object, link?:string,
   *   propsFile?:string, note?:{en:string, pl:string}, skipped?:string, error?:string}>}
   */
  async function make(run, ctx = {}) {
    try {
      const r = isObj(run) ? run : {};
      const runDir = runFolder(deps.runsDir(), r.id);
      if (!runDir) return { ok: false, skipped: 'bad-run' };
      const c = isObj(ctx) ? ctx : {};
      const current = isObj(r.current) ? r.current : {};
      const milestone = c.milestone || r.milestone;
      const built = buildDemoProps({
        milestone,
        repoName: path.basename(String(r.repoPath || '')),
        iteration: Number.isInteger(c.iteration) ? c.iteration : r.iteration,
        report: c.report || current.report,
        evidenceDir: c.evidenceDir || r.evidenceDir,
        journeyOrder: journeyOrder(r.repoPath),
      });
      if (!built) return { ok: false, skipped: 'no-evidence' };
      const slug = slugOf(milestone);
      const work = writeWorkDir(path.join(runDir, `demo-${slug}`), built);
      const setup = remotionSetup({ env: env(), readLocal: deps.readLocal });
      if (!setup) return { ok: false, skipped: 'no-remotion', note: NO_PATH_NOTE, propsFile: work.propsFile };
      return await renderAndPlace(r, setup, work, path.join(runDir, `demo-${slug}.mp4`), slug);
    } catch (err) {
      log(`[lunaswork] demo video failed: ${errText(err)}`);
      return { ok: false, error: 'crashed' };
    }
  }

  return { make, videos: (runId) => listDemoVideos(deps.runsDir(), runId) };
}

module.exports = {
  FPS,
  MIN_SECONDS,
  MAX_SECONDS,
  ATTACH_MAX_BYTES,
  SETTINGS_FILE,
  REMOTION_DIR_ENV,
  DEFAULT_COMPOSITION,
  NO_PATH_NOTE,
  buildDemoProps,
  remotionSetup,
  renderCommand,
  execRender,
  listDemoVideos,
  createDemoMaker,
};
