// ============================================================================
// LunaCore - Luna's Work design match score (docs/LUNAS_WORK_PLAN.md B6, LW 2.19a)
// ----------------------------------------------------------------------------
// The mockups in design/references/ (mapped to screens by the table in
// design/references/README.md, lunasworkPack.readDesignMappings) against what
// the app really shows:
//
//   targets   designTargets(projectDir) - each mapped mockup resolved inside
//             design/references/ (no links out), a real PNG / JPEG, with its
//             width and height
//   capture   the explore pass's prompt (designMatchPrompt) has the
//             Playtester resize the browser to the mockup's width and take
//             `design-<screen>.png`; it answers them in `designShots`
//   evidence  runDesignMatch copies each mockup into the evidence dir next to
//             the screenshot, writes a structural diff image (both pictures
//             sampled onto one grid, so different sizes still compare) and
//             its changed-pixel ratio - supporting evidence only
//   score     one vision call with the Playtester's model (judgeArgs: the Read
//             tool only, inside the evidence dir, nothing else) scores each
//             pair 0-10 on layout, hierarchy, colors and spacing
//   report    validateDesignMatch - THE TRUST BOUNDARY: an entry without
//             BOTH images (real image files inside the evidence dir) is
//             dropped; scores outside 0-10 become null. Each entry carries
//             the previous iteration's score (design-match.json next to the
//             screen baselines)
//   critic    designMatchCards - a low score or a big drop vs the previous
//             iteration becomes a `feel` card naming both images
//
// Never throws: a broken mockup, diff or judge call costs that entry's piece,
// with a warning, never the playtest.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { parsePlannerOutput } = require('./orchestraPlan');
const { DESIGN_DIR, readDesignMappings } = require('./lunasworkPack');

const REFERENCES_DIR = 'references';
const SHOT_PREFIX = 'design-';
const MOCKUP_PREFIX = 'mockup-';
const DIFF_PREFIX = 'diff-design-';
const MATCH_FILE = 'design-match.json';
const MAX_SCORE = 10;
// The Critic files a feel card under this score, or on a drop of DROP_POINTS or more.
const LOW_SCORE = 6;
const DROP_POINTS = 2;
const HIGH_SEVERITY_BELOW = 4;
const MAX_VIEWPORT = 4000;
const MAX_CAPTURE_HEIGHT = 1200;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PNG_PIXELS = 16 * 1000 * 1000;
// The diff grid: never wider than this, so a 4K mockup stays cheap.
const MAX_GRID_WIDTH = 800;
// Per-channel difference (0-255) above which a grid pixel counts as changed.
const CHANNEL_THRESHOLD = 40;
const MAX_NOTES_CHARS = 600;
const MAX_SCREEN_CHARS = 120;
const MAX_PATH_CHARS = 500;
const JUDGE_BUDGET_USD = 1;
const JUDGE_TIMEOUT_MS = 10 * 60 * 1000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
// Everything but Read: the judge only looks at two images.
const JUDGE_DENIED = [
  'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Task', 'Agent',
];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clean = (raw, max) => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const isInside = (root, file) => {
  const rel = path.relative(root, file);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** Screen name -> file stem: a-z0-9 and single dashes (lunasworkPlaytest's screenSlug rule). */
function slugOf(raw) {
  return clean(raw, 200).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '');
}

// ---- images -----------------------------------------------------------------------

/** 'png' | 'jpeg' | null from the file's first bytes. */
function imageType(head) {
  if (head.length >= PNG_MAGIC.length && head.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'png';
  if (head.length >= 3 && head.subarray(0, 3).equals(JPEG_MAGIC)) return 'jpeg';
  return null;
}

/** JPEG width / height from its first SOF marker. */
function jpegSize(buf) {
  let at = 2;
  while (at + 9 < buf.length) {
    if (buf[at] !== 0xff) return null;
    const marker = buf[at + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
    at += 2 + buf.readUInt16BE(at + 2);
  }
  return null;
}

/**
 * Type and size of a PNG / JPEG, from its header.
 * @returns {{type:'png'|'jpeg', width:number, height:number}|null}
 */
function imageInfo(file) {
  try {
    if (fs.statSync(file).size > MAX_IMAGE_BYTES) return null;
    const buf = fs.readFileSync(file);
    const type = imageType(buf);
    let size = null;
    if (type === 'png' && buf.length >= 24) size = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    else if (type === 'jpeg') size = jpegSize(buf);
    return size && size.width > 0 && size.height > 0 ? { type, ...size } : null;
  } catch {
    return null;
  }
}

/** A decoded PNG (pixel count checked from the header first), or null for a JPEG. */
function readPng(file) {
  const info = imageInfo(file);
  if (!info || info.type !== 'png') return null;
  if (info.width * info.height > MAX_PNG_PIXELS) throw new Error('image too large');
  return PNG.sync.read(fs.readFileSync(file));
}

// ---- targets ------------------------------------------------------------------------

/**
 * The mapped mockups that are usable: inside design/references/ after
 * resolving links, a real PNG / JPEG.
 * @param {string} projectDir
 * @param {{screen:string, route:string, mockup:string}[]} [mappings] default: the README table
 * @returns {{targets:{screen:string, slug:string, route:string, mockup:string, mockupPath:string,
 *   type:string, width:number, height:number}[], warnings:object[]}}
 */
function designTargets(projectDir, mappings) {
  const out = { targets: [], warnings: [] };
  const list = Array.isArray(mappings) ? mappings : readDesignMappings(projectDir);
  if (!list.length) return out;
  let root;
  try {
    root = fs.realpathSync.native(path.join(projectDir, DESIGN_DIR, REFERENCES_DIR));
  } catch {
    return out;
  }
  const seen = new Set();
  for (const m of list) {
    const slug = isObj(m) ? slugOf(m.screen) : '';
    if (!slug || seen.has(slug)) continue;
    let file = null;
    try {
      file = fs.realpathSync.native(path.resolve(root, String(m.mockup)));
    } catch {
      file = null;
    }
    const info = file && isInside(root, file) ? imageInfo(file) : null;
    if (!info) {
      out.warnings.push({ code: 'badMockup', screen: clean(m.screen, MAX_SCREEN_CHARS), mockup: clean(m.mockup, MAX_PATH_CHARS) });
      continue;
    }
    seen.add(slug);
    out.targets.push({
      screen: clean(m.screen, MAX_SCREEN_CHARS),
      slug,
      route: m.route,
      mockup: m.mockup,
      mockupPath: file,
      type: info.type,
      width: Math.min(MAX_VIEWPORT, info.width),
      height: Math.min(MAX_VIEWPORT, info.height),
    });
  }
  return out;
}

const shotName = (slug) => `${SHOT_PREFIX}${slug}.png`;

/** The explore prompt's design match rules ([] without targets). */
function designMatchPrompt(targets) {
  if (!Array.isArray(targets) || !targets.length) return [];
  return [
    '',
    'Design match - for each screen below, in chromium only: browser_resize to the given size, browser_navigate to the route on the app, wait until it has loaded, and take a full-page screenshot with exactly the given filename. Report each one in designShots ({screen, screenshot}) with the screen name as written here. Do not judge the look here - the comparison is done separately.',
    ...targets.map((t) => `  - "${t.screen}": route ${t.route}, browser_resize ${t.width}x${Math.min(t.height, MAX_CAPTURE_HEIGHT)}, screenshot "${shotName(t.slug)}"`),
  ];
}

/** The PLAYTEST_SCHEMA property for the captures. */
const DESIGN_SHOTS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['screen', 'screenshot'],
    properties: { screen: { type: 'string' }, screenshot: { type: 'string' } },
  },
};

/**
 * The Playtester's captures matched to the targets it was given. A screenshot
 * counts only as evidence of this pass (lunasworkPlaytest's evidenceFile).
 * @param {unknown} raw report.designShots
 * @param {object[]} targets
 * @param {(p:unknown)=>string|null} evidenceFile
 * @param {object[]} warnings pushed to
 * @returns {{slug:string, screenshot:string}[]}
 */
function cleanDesignShots(raw, targets, evidenceFile, warnings) {
  const wanted = new Set((Array.isArray(targets) ? targets : []).map((t) => t.slug));
  const out = [];
  for (const s of (Array.isArray(raw) ? raw : []).slice(0, wanted.size * 2)) {
    const slug = isObj(s) ? slugOf(s.screen) : '';
    if (!wanted.has(slug) || out.some((o) => o.slug === slug)) continue;
    const screenshot = evidenceFile(s.screenshot);
    if (!screenshot || !/\.png$/i.test(screenshot)) {
      warnings.push({ code: 'badDesignShot', screen: clean(s.screen, MAX_SCREEN_CHARS) });
      continue;
    }
    out.push({ slug, screenshot });
  }
  return out;
}

// ---- structural diff ------------------------------------------------------------------

/**
 * Both images sampled onto one grid (the mockup's aspect, at most
 * MAX_GRID_WIDTH wide); a grid pixel whose colour differs by more than
 * CHANNEL_THRESHOLD on any channel is changed. The diff image paints changed
 * pixels red over a faded mockup.
 * @returns {{ratio:number|null, diff:string|null, reason?:string}}
 */
function structuralDiff(mockupFile, shotFile, diffFile) {
  const a = readPng(mockupFile);
  const b = readPng(shotFile);
  if (!a || !b) return { ratio: null, diff: null, reason: 'only PNG pairs are diffed' };
  const width = Math.max(1, Math.min(MAX_GRID_WIDTH, a.width));
  const height = Math.max(1, Math.round((a.height * width) / a.width));
  const out = new PNG({ width, height });
  let changed = 0;
  for (let y = 0; y < height; y += 1) {
    const ay = Math.min(a.height - 1, Math.floor((y * a.height) / height));
    const by = Math.min(b.height - 1, Math.floor((y * b.height) / height));
    for (let x = 0; x < width; x += 1) {
      const ai = (ay * a.width + Math.min(a.width - 1, Math.floor((x * a.width) / width))) * 4;
      const bi = (by * b.width + Math.min(b.width - 1, Math.floor((x * b.width) / width))) * 4;
      const oi = (y * width + x) * 4;
      const differs = [0, 1, 2].some((c) => Math.abs(a.data[ai + c] - b.data[bi + c]) > CHANNEL_THRESHOLD);
      if (differs) {
        changed += 1;
        out.data.set([255, 0, 0, 255], oi);
      } else {
        const grey = Math.round(0.3 * a.data[ai] + 0.59 * a.data[ai + 1] + 0.11 * a.data[ai + 2]);
        const faded = Math.round(255 - (255 - grey) * 0.3);
        out.data.set([faded, faded, faded, 255], oi);
      }
    }
  }
  fs.writeFileSync(diffFile, PNG.sync.write(out));
  return { ratio: changed / (width * height), diff: diffFile };
}

// ---- the vision judge ------------------------------------------------------------------

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['screens'],
  properties: {
    screens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['screen', 'score', 'notes'],
        properties: {
          screen: { type: 'string' },
          score: { type: 'number', minimum: 0, maximum: MAX_SCORE },
          notes: { type: 'string' },
        },
      },
    },
  },
};

/** argv for the judge: Read inside its cwd (the evidence dir) and nothing else - never a shell string. */
function judgeArgs({ model, budgetUsd = JUDGE_BUDGET_USD }) {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(JUDGE_SCHEMA),
    '--model', model,
    '--tools', 'Read',
    '--permission-mode', 'dontAsk',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--allowedTools', 'Read(./**)',
    '--disallowedTools', JUDGE_DENIED.join(','),
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

/** The judge's prompt: file names relative to its cwd, never a path outside. */
function judgePrompt(pairs) {
  return [
    'You compare a web app with its design mockups. Use the Read tool to look at both images of every pair below (they are in the current folder).',
    'Score each pair from 0 to 10 for design fidelity: layout (what sits where), visual hierarchy (what stands out), colors, and spacing. 10 = matches the mockup; 5 = clearly the same screen with visible differences; 0 = unrelated. Ignore differences in the example text and data.',
    'notes: one or two sentences on the biggest differences, so a builder knows what to fix.',
    'The pixel diff share is supporting evidence only (it also flags harmless shifts); judge what you see.',
    '',
    ...pairs.map((p) => `- screen "${p.screen}": mockup ${path.basename(p.mockup)}, screenshot ${path.basename(p.screenshot)}${p.pixelDiff === null ? '' : `, pixel diff ${(p.pixelDiff * 100).toFixed(1)}% of the grid`}`),
  ].join('\n');
}

/** slug -> {score, notes} from the judge's answer; unknown screens and bad scores are dropped. */
function judged(raw, pairs) {
  const known = new Set(pairs.map((p) => p.slug));
  const out = new Map();
  for (const s of isObj(raw) && Array.isArray(raw.screens) ? raw.screens : []) {
    const slug = isObj(s) ? slugOf(s.screen) : '';
    if (!known.has(slug) || out.has(slug) || !Number.isFinite(s.score) || s.score < 0 || s.score > MAX_SCORE) continue;
    out.set(slug, { score: Math.round(s.score * 10) / 10, notes: clean(s.notes, MAX_NOTES_CHARS) });
  }
  return out;
}

// ---- history ---------------------------------------------------------------------------

function readPrevious(baselinesDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(baselinesDir, MATCH_FILE), 'utf8'));
    return isObj(raw) && isObj(raw.scores) ? raw.scores : {};
  } catch {
    return {}; // first pass, or a broken file: nothing to compare with
  }
}

function writeScores(baselinesDir, entries, previous) {
  const scores = { ...previous };
  for (const e of entries) if (Number.isFinite(e.score)) scores[slugOf(e.screen)] = e.score;
  fs.mkdirSync(baselinesDir, { recursive: true });
  fs.writeFileSync(path.join(baselinesDir, MATCH_FILE), `${JSON.stringify({ scores }, null, 2)}\n`);
}

// ---- validation ------------------------------------------------------------------------

/** A real image file inside the evidence dir (after resolving links), or null. */
function evidenceImage(raw, evidenceDir) {
  const p = clean(raw, MAX_PATH_CHARS);
  if (!p) return null;
  try {
    const root = fs.realpathSync.native(evidenceDir);
    const file = fs.realpathSync.native(path.resolve(root, p));
    return isInside(root, file) && imageInfo(file) ? file : null;
  } catch {
    return null;
  }
}

const scoreOrNull = (v) => (Number.isFinite(v) && v >= 0 && v <= MAX_SCORE ? v : null);

/**
 * THE TRUST BOUNDARY of report.designMatch. An entry is valid only with a
 * screen name and BOTH images - the mockup copy and the app screenshot -
 * real image files inside the evidence dir. The diff image is optional.
 * @param {unknown} list
 * @param {{evidenceDir:string}} ctx
 * @returns {{entries:{screen:string, route:string|null, mockup:string, screenshot:string, diff:string|null,
 *   pixelDiff:number|null, score:number|null, previousScore:number|null, notes:string}[], warnings:object[]}}
 */
function validateDesignMatch(list, { evidenceDir }) {
  const entries = [];
  const warnings = [];
  for (const e of Array.isArray(list) ? list : []) {
    const screen = isObj(e) ? clean(e.screen, MAX_SCREEN_CHARS) : '';
    const mockup = screen ? evidenceImage(e.mockup, evidenceDir) : null;
    const screenshot = screen ? evidenceImage(e.screenshot, evidenceDir) : null;
    if (!screen || !mockup || !screenshot) {
      warnings.push({ code: 'badDesignMatch', screen });
      continue;
    }
    entries.push({
      screen,
      route: clean(e.route, MAX_PATH_CHARS) || null,
      mockup,
      screenshot,
      diff: e.diff ? evidenceImage(e.diff, evidenceDir) : null,
      pixelDiff: Number.isFinite(e.pixelDiff) && e.pixelDiff >= 0 && e.pixelDiff <= 1 ? e.pixelDiff : null,
      score: scoreOrNull(e.score),
      previousScore: scoreOrNull(e.previousScore),
      notes: clean(e.notes, MAX_NOTES_CHARS),
    });
  }
  return { entries, warnings };
}

// ---- run -------------------------------------------------------------------------------

/** Mockup copy + structural diff for one captured screen. */
function evidencePair(target, shot, evidenceDir, warnings) {
  const ext = target.type === 'png' ? 'png' : 'jpg';
  const mockup = path.join(evidenceDir, `${MOCKUP_PREFIX}${target.slug}.${ext}`);
  fs.copyFileSync(target.mockupPath, mockup);
  let diff = { ratio: null, diff: null };
  try {
    diff = structuralDiff(mockup, shot.screenshot, path.join(evidenceDir, `${DIFF_PREFIX}${target.slug}.png`));
  } catch (err) {
    warnings.push({ code: 'designDiffFailed', screen: target.screen, detail: clean(err && err.message, 300) });
  }
  return { slug: target.slug, screen: target.screen, route: target.route, mockup, screenshot: shot.screenshot, diff: diff.diff, pixelDiff: diff.ratio };
}

/** The judge call; resolves the scores per slug, or an empty map with a warning. */
async function askJudge(runJudge, pairs, { model, evidenceDir }, warnings) {
  if (typeof runJudge !== 'function') {
    warnings.push({ code: 'designJudgeUnavailable' });
    return { scores: new Map(), costUsd: null };
  }
  let res;
  try {
    res = await runJudge({ args: judgeArgs({ model }), prompt: judgePrompt(pairs), cwd: evidenceDir, timeoutMs: JUDGE_TIMEOUT_MS });
  } catch (err) {
    res = { error: 'failed', detail: clean(err && err.message, 300) };
  }
  const parsed = isObj(res) && !res.error ? parsePlannerOutput(res.stdout) : { ok: false, error: (isObj(res) && res.error) || 'failed' };
  if (!parsed.ok) {
    warnings.push({ code: 'designJudgeFailed', detail: clean(String(parsed.error || ''), 100) });
    return { scores: new Map(), costUsd: null };
  }
  return { scores: judged(parsed.raw, pairs), costUsd: parsed.costUsd };
}

/**
 * The design match of one explore pass: evidence, scores, history, checked.
 * @param {{targets:object[], shots:{slug:string, screenshot:string}[], evidenceDir:string,
 *   baselinesDir:string, model:string, runJudge?:(call:object)=>Promise<object>}} opts
 * @returns {Promise<{designMatch:object[], warnings:object[], costUsd:number|null}>}
 */
async function runDesignMatch(opts) {
  const warnings = [];
  const targets = Array.isArray(opts.targets) ? opts.targets : [];
  const shots = new Map((Array.isArray(opts.shots) ? opts.shots : []).map((s) => [s.slug, s]));
  if (!targets.length) return { designMatch: [], warnings, costUsd: null };
  const pairs = [];
  for (const t of targets) {
    const shot = shots.get(t.slug);
    if (!shot) {
      warnings.push({ code: 'designShotMissing', screen: t.screen });
      continue;
    }
    try {
      pairs.push(evidencePair(t, shot, opts.evidenceDir, warnings));
    } catch (err) {
      warnings.push({ code: 'designEvidenceFailed', screen: t.screen, detail: clean(err && err.message, 300) });
    }
  }
  if (!pairs.length) return { designMatch: [], warnings, costUsd: null };
  const { scores, costUsd } = await askJudge(opts.runJudge, pairs, opts, warnings);
  const previous = readPrevious(opts.baselinesDir);
  const raw = pairs.map((p) => {
    const s = scores.get(p.slug);
    return { ...p, score: s ? s.score : null, notes: s ? s.notes : '', previousScore: Number.isFinite(previous[p.slug]) ? previous[p.slug] : null };
  });
  const checked = validateDesignMatch(raw, { evidenceDir: opts.evidenceDir });
  try {
    writeScores(opts.baselinesDir, checked.entries, previous);
  } catch (err) {
    warnings.push({ code: 'designHistoryFailed', detail: clean(err && err.message, 300) });
  }
  return { designMatch: checked.entries, warnings: [...warnings, ...checked.warnings], costUsd };
}

// ---- the Critic's cards -----------------------------------------------------------------

const cardHead = (screen) => `Design match: "${screen}"`;

/**
 * LW 2.19a, Critic: a `feel` card per screen that scores under LOW_SCORE or
 * dropped DROP_POINTS or more since the previous iteration, naming both
 * images. An open card about the same screen is updated, not doubled.
 * @param {unknown} designMatch report.designMatch (validated)
 * @param {{at:number, text:string}[]} [openCards] the run's updatable cards
 * @returns {object[]} lunasworkCritic card shape
 */
function designMatchCards(designMatch, openCards = []) {
  const cards = [];
  for (const e of Array.isArray(designMatch) ? designMatch : []) {
    if (!isObj(e) || !Number.isFinite(e.score) || typeof e.mockup !== 'string' || typeof e.screenshot !== 'string') continue;
    const drop = Number.isFinite(e.previousScore) ? e.previousScore - e.score : 0;
    if (e.score >= LOW_SCORE && drop < DROP_POINTS) continue;
    const screen = clean(e.screen, MAX_SCREEN_CHARS);
    const head = cardHead(screen);
    const open = (Array.isArray(openCards) ? openCards : []).find((c) => isObj(c) && typeof c.text === 'string' && c.text.startsWith(head));
    const why = drop >= DROP_POINTS ? `dropped from ${e.previousScore}/10 to ${e.score}/10` : `scores ${e.score}/10`;
    cards.push({
      kind: 'feel',
      severity: e.score < HIGH_SEVERITY_BELOW ? 'high' : 'medium',
      text: `${head} ${why} against its mockup`,
      details: [
        `The "${screen}" screen${e.route ? ` (${e.route})` : ''} ${why} against its mockup in design/references/ (layout, hierarchy, colors, spacing).`,
        e.notes ? `Playtester: ${e.notes}` : '',
        `Mockup: ${e.mockup}`,
        `Screenshot: ${e.screenshot}`,
        e.diff ? `Diff: ${e.diff}${Number.isFinite(e.pixelDiff) ? ` (${(e.pixelDiff * 100).toFixed(1)}% of the grid differs)` : ''}` : '',
        'Compare both images and bring the screen closer to the mockup.',
      ].filter(Boolean).join('\n'),
      acceptance: [`The "${screen}" screen matches its mockup in layout, hierarchy, colors and spacing (design match ${LOW_SCORE}/10 or more)`],
      files: [],
      updatesCardId: open ? open.at : null,
    });
  }
  return cards;
}

module.exports = {
  LOW_SCORE,
  DROP_POINTS,
  MATCH_FILE,
  DESIGN_SHOTS_SCHEMA,
  JUDGE_SCHEMA,
  imageInfo,
  designTargets,
  designMatchPrompt,
  cleanDesignShots,
  structuralDiff,
  judgeArgs,
  judgePrompt,
  validateDesignMatch,
  runDesignMatch,
  designMatchCards,
};
