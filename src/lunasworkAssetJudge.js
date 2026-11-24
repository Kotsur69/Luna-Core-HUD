// ============================================================================
// LunaCore - Luna's Work asset judge (the luna_asset_judge MCP tool)
// ----------------------------------------------------------------------------
// The asset worker makes several candidates for one asset (ComfyUI drafts,
// Blender renders, Higgsfield results, library picks), then asks the Critic
// which one to keep BEFORE anything is imported or paid for:
//
//   judge({name, kind, candidates})   2 to 8 candidates; each one is
//       - a repo-relative image path under art/ or the art root, or
//       - a library result {source, id} (src/lunasworkFreeSources.js): its
//         preview image (item.preview) is downloaded through the public-https
//         downloader (src/lunasworkAssetTools.js createDownloader: no key, no
//         auth header) into art/candidates/<slug>/
//     One read-only `claude -p --output-format json --json-schema` call (the
//     Critic role, buildStyleArgs / buildStylePrompt of src/lunasworkAssets.js)
//     scores every candidate 0-10 against design/references/ and
//     ART_DIRECTION_RULE. The answer: {ranking, winner, pass, reason}, with
//     pass = winner score >= STYLE_PASS_SCORE.
//     Audio cannot be viewed: kind "audio" is judged on metadata only (name,
//     tags, duration, license text) and the answer says basis: 'metadata'.
//
// Every verdict goes to the run's asset log (tool 'judge'). A passing verdict
// whose winner is free (library) or local (not a Higgsfield output) is kept in
// the verdict store; higgsfieldFinal then refuses a paid final for the same
// asset with 'freeCandidatePassed' (src/lunasworkAssetPipeline.js).
//
// Verdict store: one per LunaCore process (createAssetToolsFor builds it once),
// keyed by the worker's repo path (its per-package worktree) and the asset
// slug, so it is scoped to the run's package that judged. Entries expire after
// VERDICT_TTL_MS, so a verdict of an old run cannot block a later one forever.
//
// Boundaries: a candidate path must stay inside the repo with no `..`, must
// not pass through a junction or symlink (realpath compared with the plain
// path), must sit under art/ or the art root, have an image extension and
// image magic bytes (PNG, JPEG, WEBP). Model output only scores; it never
// names a file this module reads or writes.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { imageKind, audioKind } = require('./lunasworkComfy');
const { isWritablePath } = require('./lunasworkToolkit');
const { KINDS, ART_DIRECTION_RULE, SOURCE_DIRS, slugOf, artRootOf } = require('./lunasworkAssetPipeline');
const { SOURCE_IDS, redact } = require('./lunasworkFreeSources');

const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 8;
const CANDIDATES_DIR = 'art/candidates';
const ART_DIR = 'art';
const IMAGE_EXTS = Object.freeze({ png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp' });
const AUDIO_EXTS = Object.freeze({ wav: 'wav', ogg: 'ogg', mp3: 'mp3' });
const MAX_PATH_CHARS = 300;
const MAX_ID_CHARS = 100;
const MAX_NAME_CHARS = 80;
const MAX_CANDIDATE_BYTES = 50 * 1024 * 1024;
const HEAD_BYTES = 4096;
const MAX_NOTES_CHARS = 300;
const MAX_SPEC_CHARS = 300;
const JUDGE_TIMEOUT_MS = 6 * 60 * 1000;
const VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VERDICTS = 500;
const MAX_HIGGSFIELD_RECORDS = 500;
const MAX_RECORD_BYTES = 256 * 1024;
const LOCAL_AUDIO_LICENSE = 'own work (local file)';
const LIBRARY_ID_RE = /^[A-Za-z0-9][\w:.-]{0,99}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail: oneLine(detail, 300) } : {}) });
const label = (i) => `candidate-${i + 1}`;
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// Loaded on first use: src/lunasworkAssets.js reaches src/intake.js, which
// loads the asset tools (and this module) - a top-level require would cycle.
const critic = () => ({
  ...require('./lunasworkAssets'),
  parsePlannerOutput: require('./orchestraPlan').parsePlannerOutput,
  execClaude: require('./lunasworkCritic').execClaude,
});

// ---- verdict store ----------------------------------------------------------------------

/**
 * Passing verdicts with a free or local winner, per worker repo and asset slug.
 * @param {{now?:()=>number, ttlMs?:number}} [opts]
 * @returns {{record:(repoPath:string, slug:string)=>void, freePassed:(repoPath:string, slug:string)=>boolean}}
 */
function createVerdictStore(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : VERDICT_TTL_MS;
  const passed = new Map();
  const keyOf = (repoPath, slug) => {
    const repo = path.resolve(String(repoPath));
    return `${process.platform === 'win32' ? repo.toLowerCase() : repo}\u0000${slug}`;
  };
  const fresh = (at) => typeof at === 'number' && now() - at <= ttlMs;

  function record(repoPath, slug) {
    for (const [k, at] of passed) if (!fresh(at)) passed.delete(k);
    passed.delete(keyOf(repoPath, slug));
    passed.set(keyOf(repoPath, slug), now());
    // Map order is insertion order: the oldest entries go first.
    while (passed.size > MAX_VERDICTS) passed.delete(passed.keys().next().value);
  }

  const freePassed = (repoPath, slug) => typeof slug === 'string' && fresh(passed.get(keyOf(repoPath, slug)));

  return { record, freePassed };
}

// ---- candidate paths --------------------------------------------------------------------

function readHead(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Path shape only: repo-relative, no traversal, under art/ or the art root. */
function relOf(raw, artRoot) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_PATH_CHARS || CONTROL_RE.test(raw)) return fail('badPath', 'a candidate path must be a short repo-relative path');
  const slashed = raw.replace(/\\/g, '/');
  if (path.isAbsolute(raw) || slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return fail('outsideRepo', `${oneLine(raw, 120)} is not a repo-relative path`);
  const segments = slashed.split('/').filter((s) => s && s !== '.');
  if (segments.includes('..')) return fail('pathTraversal', `${oneLine(raw, 120)} contains ".."`);
  const rel = segments.join('/');
  if (![ART_DIR, artRootOf(artRoot)].some((root) => rel.startsWith(`${root}/`))) return fail('notArtPath', `${rel} is not under ${ART_DIR}/ or ${artRootOf(artRoot)}/`);
  return { ok: true, rel, segments };
}

/**
 * One local candidate, checked from shape to bytes. Audio files skip the
 * image checks; they must be WAV / OGG / MP3 instead.
 * @returns {{ok:true, rel:string, abs:string, size:number, head:Buffer}|{ok:false, error:string, detail?:string}}
 */
function checkCandidatePath(repoPath, artRoot, raw, { audio = false } = {}) {
  const shape = relOf(raw, artRoot);
  if (!shape.ok) return shape;
  const { rel, segments } = shape;
  const exts = audio ? AUDIO_EXTS : IMAGE_EXTS;
  const ext = path.posix.extname(rel).slice(1).toLowerCase();
  if (!own(exts, ext)) return fail(audio ? 'notAudio' : 'notImage', `${rel} needs one of the extensions ${Object.keys(exts).join(', ')}`);
  const abs = path.join(repoPath, ...segments);
  let real;
  try {
    real = fs.realpathSync.native(abs);
  } catch (err) {
    return fail('notFound', `${rel} cannot be read (${err && err.code ? err.code : errText(err)})`);
  }
  // A junction or symlink anywhere on the way makes the real path differ from the plain one.
  if (!samePath(real, path.join(fs.realpathSync.native(repoPath), ...segments))) return fail('linkedPath', `${rel} goes through a junction or symlink`);
  if (!isWritablePath(abs, { repoPath })) return fail('outsideRepo', `${rel} resolves outside the project repo`);
  const st = fs.statSync(real);
  if (!st.isFile()) return fail('notFile', `${rel} is not a file`);
  if (st.size > MAX_CANDIDATE_BYTES) return fail('tooLarge', `${rel} is over ${MAX_CANDIDATE_BYTES} bytes`);
  const head = readHead(real);
  const proven = audio ? audioKind(head) : imageKind(head);
  if (proven !== exts[ext]) return fail(audio ? 'badAudio' : 'badImage', `${rel} is not a real ${exts[ext].toUpperCase()} file (magic bytes)`);
  return { ok: true, rel, abs: real, size: st.size, head };
}

/** Seconds of a WAV file from its header, or null. */
function wavSeconds(head, size) {
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= head.length;) {
    const id = head.toString('latin1', at, at + 4);
    const len = head.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 16 <= head.length) byteRate = head.readUInt32LE(at + 16);
    if (id === 'data') return byteRate > 0 ? Math.round((Math.min(len, size - at - 8) / byteRate) * 100) / 100 : null;
    at += 8 + len + (len % 2);
  }
  return null;
}

/** True when a Higgsfield record (art/higgsfield/<kind>/*.json) lists `rel` as an output: a paid file. */
function isHiggsfieldOutput(repoPath, rel) {
  const base = path.join(repoPath, ...SOURCE_DIRS.higgsfield.split('/'));
  let seen = 0;
  for (const kind of Object.keys(KINDS)) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(base, kind), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
    } catch {
      continue; // no records of this kind
    }
    for (const n of names) {
      if ((seen += 1) > MAX_HIGGSFIELD_RECORDS) return false;
      try {
        const file = path.join(base, kind, n);
        if (fs.statSync(file).size > MAX_RECORD_BYTES) continue;
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (isObj(rec) && Array.isArray(rec.outputs) && rec.outputs.includes(rel)) return true;
      } catch {
        // An unreadable record proves nothing; the file counts as local.
      }
    }
  }
  return false;
}

// ---- input ------------------------------------------------------------------------------

/** {name, kind, candidates} checked for shape; candidates are not touched yet. */
function cleanRequest(raw) {
  const r = isObj(raw) ? raw : {};
  const name = oneLine(r.name, MAX_NAME_CHARS);
  const slug = slugOf(name);
  if (!slug) return fail('badName', 'name must contain letters or digits');
  if (!own(KINDS, r.kind)) return fail('badKind', `kind must be one of ${Object.keys(KINDS).join(', ')}`);
  const list = Array.isArray(r.candidates) ? r.candidates : null;
  if (!list || list.length < MIN_CANDIDATES || list.length > MAX_CANDIDATES) return fail('badCandidates', `give ${MIN_CANDIDATES} to ${MAX_CANDIDATES} candidates`);
  const candidates = [];
  const keys = new Set();
  for (const [i, c] of list.entries()) {
    let cand = null;
    if (typeof c === 'string') cand = { type: 'file', path: c, key: c.replace(/\\/g, '/') };
    else if (isObj(c) && SOURCE_IDS.includes(c.source) && typeof c.id === 'string' && LIBRARY_ID_RE.test(c.id)) cand = { type: 'library', source: c.source, id: c.id, key: `${c.source}:${c.id}` };
    if (!cand) return fail('badCandidates', `${label(i)} must be a repo path or a library result {source, id}`);
    if (keys.has(cand.key)) return fail('badCandidates', `${label(i)} is listed twice`);
    keys.add(cand.key);
    candidates.push(cand);
  }
  return { ok: true, name, slug, kind: r.kind, candidates };
}

// ---- the Critic call --------------------------------------------------------------------

function metadataLine(c, i) {
  const m = c.meta;
  const duration = Number.isFinite(m.duration) ? `${m.duration} s` : 'unknown';
  return `- "${label(i)}": name "${oneLine(m.name, 120)}"; tags: ${oneLine(m.tags.join(', '), 200) || 'none'}; duration: ${duration}; license: ${oneLine(m.license, 120) || 'none stated'}; from: ${c.display}`;
}

function audioPrompt(req, cands) {
  return [
    `You are the Critic of Luna's Work, judging sound candidates for ONE game asset, "${req.name}" (audio).`,
    'Sounds cannot be viewed or heard here: judge every candidate on its metadata only (name, tags, duration, license text). Do not open any file.',
    '',
    'Candidates:',
    ...cands.map(metadataLine),
    '',
    `The game's art direction, for its tone: ${ART_DIRECTION_RULE}`,
    `Score every candidate from 0 to 10 for how well it fits this asset; below ${critic().STYLE_PASS_SCORE} = it would not fit.`,
    'Answer with JSON. scores: one entry per candidate - name (exactly as listed), score, reference (""), notes (one or two sentences), silhouette and palette (a sound has neither: repeat its score).',
  ].join('\n');
}

function imagePrompt(req, cands, references, buildStylePrompt) {
  const assets = cands.map((c, i) => ({ name: label(i), type: req.kind, spec: oneLine(`${req.name} - ${c.spec}`, MAX_SPEC_CHARS), render: c.file }));
  return [
    buildStylePrompt({ assets, references, look: '' }),
    '',
    `Art direction rule, for every candidate: ${ART_DIRECTION_RULE}`,
    ...(references.length ? [] : ['There are no reference images in design/references/: score against the art direction rule alone.']),
    `The assets above are ${cands.length} candidates for ONE asset, "${req.name}" (${req.kind}). Score each on its own; only the best one is kept.`,
  ].join('\n');
}

/** Scores by candidate label from the Critic's answer; unknown or repeated names are dropped. */
function scoresOf(raw, count) {
  const out = new Map();
  for (const s of isObj(raw) && Array.isArray(raw.scores) ? raw.scores : []) {
    const i = isObj(s) && typeof s.name === 'string' ? Number((/^candidate-(\d+)$/.exec(s.name) || [])[1]) - 1 : -1;
    if (!(i >= 0 && i < count) || out.has(i) || !Number.isFinite(s.score)) continue;
    out.set(i, { score: Math.round(Math.min(10, Math.max(0, s.score))), notes: oneLine(s.notes, MAX_NOTES_CHARS) });
  }
  return out;
}

// ---- the judge --------------------------------------------------------------------------

/**
 * @param {{repoPath:string, artRoot?:string, files:{write:(rel:string, data:Buffer)=>string},
 *   log:(entry:object)=>boolean, sources:Record<string, {info:(id:string)=>Promise<object>}>,
 *   download:(url:string)=>Promise<Buffer>, verdicts:{record:Function},
 *   runClaude?:Function, env?:object, model?:string, timeoutMs?:number, secrets?:()=>string[]}} deps
 * @returns {{judge:(raw:object)=>Promise<object>}}
 */
function createAssetJudge(deps) {
  const d = isObj(deps) ? deps : {};
  if (typeof d.repoPath !== 'string' || !path.isAbsolute(d.repoPath)) throw new Error('the asset judge needs the absolute project repo path');
  const repoPath = path.resolve(d.repoPath);
  const secrets = () => (typeof d.secrets === 'function' ? d.secrets() : []);
  const hide = (text) => redact(text, secrets());

  /** A library item's record (license, tags) from its API; throws a coded error. */
  async function itemOf(c) {
    const client = isObj(d.sources) ? d.sources[c.source] : null;
    if (!client || typeof client.info !== 'function') throw Object.assign(new Error(`${c.source} is not available`), { code: 'libraryFailed' });
    try {
      return await client.info(c.id);
    } catch (err) {
      throw Object.assign(new Error(`${c.key}: ${errText(err)}`), { code: 'libraryFailed' });
    }
  }

  /** Library preview -> art/candidates/<slug>/<source>-<id>.<ext>, checked like any other path. */
  async function previewOf(c, item, slug) {
    if (typeof item.preview !== 'string' || !item.preview) throw Object.assign(new Error(`${c.key} has no preview image in its library API`), { code: 'noPreview' });
    let data;
    try {
      data = await d.download(item.preview);
    } catch (err) {
      throw Object.assign(new Error(`${c.key} preview: ${errText(err)}`), { code: 'previewFailed' });
    }
    const ext = imageKind(data);
    if (!ext) throw Object.assign(new Error(`${c.key} preview is not a PNG, JPEG or WEBP image`), { code: 'badPreview' });
    const rel = d.files.write(`${CANDIDATES_DIR}/${slug}/${c.source}-${c.id.replace(/[^\w-]/g, '_').slice(0, 60)}.${ext}`, data);
    return rel;
  }

  /** Every candidate made ready to judge: an image file, or audio metadata. */
  async function prepare(req, audio) {
    const out = [];
    for (const [i, c] of req.candidates.entries()) {
      const at = (res) => ({ ...res, detail: `${label(i)}: ${res.detail || res.error}` });
      if (c.type === 'file') {
        const checked = checkCandidatePath(repoPath, d.artRoot, c.path, { audio });
        if (!checked.ok) return at(checked);
        const origin = isHiggsfieldOutput(repoPath, checked.rel) ? 'paid' : 'local';
        const meta = audio ? { name: path.posix.basename(checked.rel), tags: [], duration: wavSeconds(checked.head, checked.size), license: LOCAL_AUDIO_LICENSE } : null;
        out.push({ candidate: checked.rel, display: checked.rel, file: checked.rel, origin, spec: `${origin} file ${checked.rel}`, meta });
        continue;
      }
      const item = await itemOf(c);
      if ((item.type === 'audio') !== audio) return at(fail('kindMismatch', `${c.key} is a ${item.type} asset, not one for kind "${req.kind}"`));
      const base = { candidate: { source: c.source, id: c.id }, display: c.key, origin: 'library' };
      if (audio) {
        out.push({ ...base, file: null, meta: { name: item.name, tags: Array.isArray(item.tags) ? item.tags : [], duration: Number.isFinite(item.duration) ? item.duration : null, license: item.license } });
        continue;
      }
      const rel = await previewOf(c, item, req.slug);
      const checked = checkCandidatePath(repoPath, d.artRoot, rel);
      if (!checked.ok) return at(checked);
      out.push({ ...base, file: checked.rel, spec: `library ${c.key} "${oneLine(item.name, 80)}" (${oneLine(item.license, 40)}), preview image` });
    }
    return { ok: true, list: out };
  }

  async function callCritic(req, cands, audio) {
    const c = critic();
    const references = audio ? [] : c.referenceImages(repoPath);
    const runner = typeof d.runClaude === 'function' ? d.runClaude : c.execClaude;
    const call = await runner({
      args: c.buildStyleArgs({ model: d.model }),
      prompt: audio ? audioPrompt(req, cands) : imagePrompt(req, cands, references, c.buildStylePrompt),
      cwd: repoPath,
      env: d.env || process.env,
      timeoutMs: d.timeoutMs || JUDGE_TIMEOUT_MS,
    });
    if (!isObj(call) || call.error) return fail((isObj(call) && call.error) || 'judgeFailed', isObj(call) ? call.detail : undefined);
    const parsed = c.parsePlannerOutput(call.stdout);
    if (!parsed.ok) return fail(parsed.error, parsed.detail);
    return { ok: true, scores: scoresOf(parsed.raw, cands.length), costUsd: parsed.costUsd, references, passScore: c.STYLE_PASS_SCORE };
  }

  /** Ranked best first; equal scores keep the given order. Unscored candidates rank last at 0. */
  function rank(cands, scores) {
    return cands
      .map((c, i) => ({ i, c, s: scores.get(i) || { score: 0, notes: 'not scored by the Critic' } }))
      .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
      .map(({ i, c, s }) => ({ candidate: c.candidate, label: label(i), score: s.score, notes: s.notes, origin: c.origin, ...(c.file ? { file: c.file } : {}) }));
  }

  async function judge(raw) {
    try {
      const req = cleanRequest(raw);
      if (!req.ok) return req;
      const audio = req.kind === 'audio';
      const ready = await prepare(req, audio);
      if (!ready.ok) return ready;
      const verdict = await callCritic(req, ready.list, audio);
      if (!verdict.ok) return verdict;
      if (!verdict.scores.size) return fail('judgeFailed', 'the Critic scored no candidate');
      const ranking = rank(ready.list, verdict.scores);
      const winner = ranking[0];
      const pass = winner.score >= verdict.passScore;
      const reason = `${winner.label} scored ${winner.score}/10 (pass mark ${verdict.passScore}): ${winner.notes}`;
      if (pass && winner.origin !== 'paid') d.verdicts.record(repoPath, req.slug);
      const where = winner.file || (isObj(winner.candidate) ? `${winner.candidate.source}:${winner.candidate.id}` : winner.candidate);
      const logged = d.log({ tool: 'judge', kind: req.kind, name: req.name, prompt: `${pass ? 'pass' : 'no pass'} - ${reason}`, path: where, sources: ranking.slice(0, 4).map((r) => `${r.label} ${r.score}/10`), imported: false });
      const notes = [
        audio ? 'Judged on metadata only (name, tags, duration, license): sounds cannot be viewed.' : null,
        pass ? 'Import or keep only the winner.' : 'No candidate passed: import none of them and move to the next rung of the fallback ladder.',
        logged ? null : 'The run report could not log this verdict; mention it in your hand-back.',
      ].filter(Boolean);
      return { ok: true, name: req.name, kind: req.kind, basis: audio ? 'metadata' : 'image', ranking, winner, pass, passScore: verdict.passScore, reason, references: verdict.references, costUsd: verdict.costUsd, note: notes.join(' ') };
    } catch (err) {
      return fail(err && typeof err.code === 'string' && /^[a-z][A-Za-z]+$/.test(err.code) ? err.code : 'judgeFailed', hide(errText(err)));
    }
  }

  return { judge };
}

module.exports = {
  MIN_CANDIDATES,
  MAX_CANDIDATES,
  CANDIDATES_DIR,
  VERDICT_TTL_MS,
  createVerdictStore,
  checkCandidatePath,
  createAssetJudge,
};
