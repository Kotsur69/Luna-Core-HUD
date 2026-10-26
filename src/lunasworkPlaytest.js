// ============================================================================
// LunaCore - Luna's Work headless Playtester (docs/LUNAS_WORK_PLAN.md, slice 1.3b)
// ----------------------------------------------------------------------------
// One `claude -p --output-format json --json-schema <PLAYTEST_SCHEMA>` call that
// plays the running app through the tester adapter's tools (Playwright MCP for
// `web`) and answers with findings, scores and journeys. Same "always
// resolves, never rejects" shape as orchestraPlan.js's runPlanner().
//
// ANTI-SELF-GRADING (plan: "Roles"). The Playtester sees the running app,
// design/TEST_PLAN.md and design/SHIP_CRITERIA.md - nothing else:
//   - the prompt is built only from those two files and the app url; the
//     criteria's checkbox state ([x] = an earlier gate verdict) is cleared
//   - the argv is the guarantee, not the prompt: `--tools ""` (no built-ins),
//     DENIED_TOOLS by name on top, `--strict-mcp-config` + the adapter's own
//     --mcp-config (no user MCP servers), `--setting-sources ""` (no allow
//     rules or hooks), `--permission-mode dontAsk` (nothing outside
//     --allowedTools is callable)
//   - cwd is the iteration's evidence dir, never the project repo
//   - B1: the explore pass also gets the app checks of the cards that were
//     just built (src/lunasworkChecks.js) - card text, never code
//
// THE TRUST BOUNDARY IS validateReport(). Scores without evidence are dropped;
// a screenshot only counts when it is a real image file inside the evidence
// dir written during THIS run (so a ship pass cannot cite an explore pass's
// screenshot); every text field is capped.
//
// Screen comparison: `screens` (named key-screen screenshots) are pixel-diffed
// against config/runs/lunaswork-<runId>/baselines/<name>.png. The baseline
// rolls forward after every comparison: Luna's Work changes the UI on purpose
// every iteration, so a fixed baseline would re-flag every intended change
// forever. A change is reported once, with both images and the diff, and the
// Critic decides whether it was meant.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { PNG } = require('pngjs');
const { parsePlannerOutput } = require('./orchestraPlan');
const { isUsageLimitText } = require('./orchestraPlanWait');
const { pickModel } = require('./lunasworkRules');
const { DESIGN_DIR, readPackFile } = require('./lunasworkPack');
const { killTree } = require('./lunasworkAdapters');
const { checksSchema, checksPrompt, cleanChecks } = require('./lunasworkChecks');

const MODES = ['explore', 'shipConfirm'];
// Plan: "The SHIP confirmation pass always gets opus" - whatever the settings say.
const SHIP_CONFIRM_MODEL = 'opus';
const FALLBACK_MODEL = 'sonnet';
const PLAYTEST_BUDGET_USD = 5;
const PLAYTEST_TIMEOUT_MS = 30 * 60 * 1000;
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

// Denied by name on top of `--tools ""`: a removed tool does not exist in the
// session at all, so even a future CLI default cannot hand one back.
const DENIED_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Task', 'Agent',
];
const MCP_TOOL_RE = /^mcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_]+$/;

const KINDS = ['bug', 'feel', 'missing', 'idea'];
const SEVERITIES = ['blocker', 'high', 'medium', 'low'];
const MAX_SCORE = 10;

const MAX_DOC_CHARS = 20000;
const MAX_FINDINGS = 100;
const MAX_SCORES = 100;
const MAX_JOURNEYS = 50;
const MAX_SCREENS = 30;
const MAX_TITLE_CHARS = 200;
const MAX_NAME_CHARS = 120;
const MAX_SCREEN_NAME_CHARS = 60;
const MAX_STEPS = 20;
const MAX_STEP_CHARS = 300;
const MAX_CONSOLE_ERRORS = 20;
const MAX_CONSOLE_CHARS = 500;
const MAX_PATH_CHARS = 500;
const IMAGE_EXT = /\.(png|jpe?g)$/i;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
// Written into the evidence dir when a pass starts; its mtime is the "written
// during this run" line, on the file system's own clock (no Date.now skew).
const START_MARKER = '.playtest-start';

// Screen diff: pixelmatch's per-pixel colour tolerance (its default), and the
// share of changed pixels above which a screen counts as changed.
const PIXEL_THRESHOLD = 0.1;
const DIFF_THRESHOLD = 0.02;
const MAX_PNG_BYTES = 25 * 1024 * 1024;
// Checked from the header BEFORE decoding: a blank 16000x16000 PNG is tiny on
// disk and ~1 GB decoded. Key screens are viewport shots (1440x900, 390x844).
const MAX_PNG_PIXELS = 8 * 1000 * 1000;
const BASELINES_DIR = 'baselines';

// ---- schema -----------------------------------------------------------------------

const stringList = { type: 'array', items: { type: 'string' } };
const EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['screenshot', 'steps'],
  properties: { screenshot: { type: 'string' }, steps: stringList },
};

/** JSON schema handed to `--json-schema`. Mirrors validateReport() below. */
const PLAYTEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'scores', 'journeys', 'screens'],
  properties: {
    findings: {
      type: 'array',
      maxItems: MAX_FINDINGS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'severity', 'title', 'steps', 'screenshot', 'consoleErrors'],
        properties: {
          kind: { type: 'string', enum: KINDS },
          severity: { type: 'string', enum: SEVERITIES },
          title: { type: 'string', maxLength: MAX_TITLE_CHARS },
          steps: stringList,
          screenshot: { type: 'string' },
          consoleErrors: stringList,
        },
      },
    },
    scores: {
      type: 'array',
      maxItems: MAX_SCORES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['milestone', 'criterion', 'score', 'evidence'],
        properties: {
          milestone: { type: 'string' },
          criterion: { type: 'string' },
          score: { type: 'number', minimum: 0, maximum: MAX_SCORE },
          evidence: EVIDENCE_SCHEMA,
        },
      },
    },
    journeys: {
      type: 'array',
      maxItems: MAX_JOURNEYS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'passed', 'evidence'],
        properties: { name: { type: 'string' }, passed: { type: 'boolean' }, evidence: EVIDENCE_SCHEMA },
      },
    },
    screens: {
      type: 'array',
      maxItems: MAX_SCREENS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'screenshot'],
        properties: { name: { type: 'string' }, screenshot: { type: 'string' } },
      },
    },
    // Optional: only a pass that was given built cards' checks answers it.
    checks: checksSchema(EVIDENCE_SCHEMA),
  },
};

// ---- small helpers ----------------------------------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Trimmed, capped string ('' when unusable). */
function clean(raw, max) {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

/** Non-empty trimmed strings, capped in count and length. */
function strings(raw, maxItems, maxChars) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => clean(s, maxChars)).filter(Boolean).slice(0, maxItems);
}

/** Screen name -> baseline file stem: a-z0-9 and single dashes. */
function screenSlug(raw) {
  return clean(raw, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SCREEN_NAME_CHARS)
    .replace(/^-+|-+$/g, '');
}

/** @returns {URL|null} the parsed url when it is http(s) */
function httpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/** The origins the adapter's MCP servers restrict the browser to (`--allowed-origins`). */
function allowedOrigins(tools) {
  const servers = isObj(tools && tools.mcpConfig && tools.mcpConfig.mcpServers) ? tools.mcpConfig.mcpServers : {};
  const out = [];
  for (const server of Object.values(servers)) {
    const args = Array.isArray(server && server.args) ? server.args : [];
    const i = args.indexOf('--allowed-origins');
    if (i >= 0 && typeof args[i + 1] === 'string') out.push(...args[i + 1].split(';'));
  }
  return out;
}

/** Same file, compared the way the OS does (case-insensitive on Windows). */
const samePath = (a, b) => path.relative(a, b) === '';
const isInside = (root, file) => {
  const rel = path.relative(root, file);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// ---- model --------------------------------------------------------------------------

/**
 * @param {string} mode 'explore' | 'shipConfirm'
 * @param {object} [models] Luna's Work models per role (settings)
 * @returns {{model:string, reason:string}}
 */
function playtestModel(mode, models) {
  if (mode === 'shipConfirm') return { model: SHIP_CONFIRM_MODEL, reason: 'SHIP confirmation pass' };
  return pickModel('playtester', models, { shipConfirm: false }) || { model: FALLBACK_MODEL, reason: 'default' };
}

// ---- prompt -------------------------------------------------------------------------

/** Clears `- [x]` marks: a ticked criterion is an earlier verdict, not a spec. */
function clearVerdicts(md) {
  return md.replace(/\[[xX]\]/g, '[ ]');
}

/**
 * True when design/<file> really is that file: no link or junction - on the
 * file or on design/ itself - may point it at code or at PLAYTEST_LOG.md.
 */
function isRealPackFile(projectDir, file) {
  try {
    const real = fs.realpathSync.native(path.join(projectDir, DESIGN_DIR, file));
    return samePath(path.join(fs.realpathSync.native(projectDir), DESIGN_DIR, file), real);
  } catch {
    return false;
  }
}

/**
 * The only two files the Playtester's prompt is built from. Fixed names, read
 * only when they are not links - never code, never PLAYTEST_LOG.md, never a
 * score.
 * @returns {{testPlan:string, shipCriteria:string}} '' for a missing file
 */
function loadPlaytestInputs(projectDir) {
  const read = (file) =>
    isRealPackFile(projectDir, file) ? clean(readPackFile(projectDir, file) || '', MAX_DOC_CHARS) : '';
  return { testPlan: read('TEST_PLAN.md'), shipCriteria: clearVerdicts(read('SHIP_CRITERIA.md')) };
}

const fence = (title, body) => [`${title}:`, '<<<', body || '(empty)', '>>>'];

const SHARED_RULES = [
  `- Check everything at desktop width (browser_resize ${DESKTOP.width}x${DESKTOP.height}) AND at mobile width (browser_resize ${MOBILE.width}x${MOBILE.height}).`,
  '- Read the browser console (browser_console_messages) after every journey and screen; put the errors that belong to a finding in its consoleErrors.',
  '- Every finding needs a screenshot: browser_take_screenshot with a short, unique filename (for example "f3-mobile-cart.png"). Put exactly that filename in "screenshot".',
  '- Judge only what you see in the browser. You have no access to the source code; do not ask for it or guess at it.',
  '',
  'Report:',
  '- findings: kind "bug" (broken), "feel" (works but looks or feels wrong, slow, confusing), "missing" (expected but absent), "idea"; severity blocker/high/medium/low; steps = exact steps to reproduce, one action each.',
  '- scores: score each ship criterion you checked from 0 to 10, with its milestone. evidence = a screenshot filename you took in THIS session plus the steps that show it. A score without evidence is thrown away.',
];

/**
 * @param {{mode:string, url:string, testPlan:string, shipCriteria:string, checks?:object[]}} input
 *   checks = lunasworkChecks.checkList of the built cards (explore pass only)
 * @returns {string}
 */
function buildPlaytestPrompt({ mode, url, testPlan, shipCriteria, checks = [] }) {
  if (mode === 'shipConfirm') {
    return [
      'You are an independent SHIP confirmation tester for a web app. Nobody has told you whether it passes - find out yourself.',
      `The app is running at ${url}. You have only a browser (Playwright tools).`,
      '',
      'What to do:',
      '- Check every ship criterion below, one by one, strictly. A criterion passes only if you saw it work.',
      ...SHARED_RULES,
      '- Name every screenshot with a "ship-" prefix.',
      '- journeys: one entry per user flow you exercised to check the criteria; passed true only if it completed end to end at both widths.',
      '- screens: leave empty.',
      '',
      ...fence('Ship criteria (design/SHIP_CRITERIA.md)', shipCriteria),
    ].join('\n');
  }
  return [
    'You are the Playtester for a web app: test it like a real, careful user.',
    `The app is running at ${url}. You have only a browser (Playwright tools).`,
    '',
    'What to do:',
    '1. Run every journey in the test plan below, end to end, step by step.',
    '2. Then explore freely: empty and invalid input, edge cases, back/forward, reload, double clicks, long text.',
    ...SHARED_RULES,
    '- journeys: one entry per test-plan journey (its exact name); passed true only if it completed end to end at both widths.',
    '- screens: the start screen and the main screen of every journey, at both widths, named "<screen>-desktop" / "<screen>-mobile", each with a viewport screenshot (not full page). Use the same names every run - they are compared with the previous run.',
    '',
    ...fence('Test plan (design/TEST_PLAN.md)', testPlan),
    '',
    ...fence('Ship criteria (design/SHIP_CRITERIA.md)', shipCriteria),
    ...checksPrompt(checks),
  ].join('\n');
}

// ---- argv ---------------------------------------------------------------------------

/**
 * Only MCP tools of a server the adapter's own config declares. Anything else
 * the adapter hands over - a built-in name, another server's tool - is dropped.
 * @param {{mcpConfig:object, allowedTools:string[]}} tools adapter.tools()
 * @returns {string[]}
 */
function allowedAdapterTools(tools) {
  const servers = isObj(tools && tools.mcpConfig && tools.mcpConfig.mcpServers)
    ? Object.keys(tools.mcpConfig.mcpServers)
    : [];
  const list = Array.isArray(tools && tools.allowedTools) ? tools.allowedTools : [];
  return [...new Set(list.filter((t) => {
    const m = typeof t === 'string' && t.match(MCP_TOOL_RE);
    return !!m && servers.includes(m[1]);
  }))];
}

/**
 * argv for the headless Playtester - never a shell string. The prompt goes in
 * on stdin (a long test plan can outgrow the Windows command line).
 * @param {{model:string, tools:{mcpConfig:object, allowedTools:string[]}, budgetUsd?:number}} opts
 * @returns {string[]}
 */
function buildPlaytestArgs({ model, tools, budgetUsd = PLAYTEST_BUDGET_USD }) {
  const allowed = allowedAdapterTools(tools);
  if (!allowed.length) throw new Error('the tester adapter offers no usable MCP tools');
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(PLAYTEST_SCHEMA),
    '--model', model,
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(tools.mcpConfig),
    '--allowedTools', allowed.join(','),
    '--disallowedTools', DENIED_TOOLS.join(','),
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

// ---- validation ---------------------------------------------------------------------

/** True when the file starts with a PNG or JPEG signature - not text named x.png. */
function hasImageMagic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(PNG_MAGIC.length);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return (n >= PNG_MAGIC.length && head.equals(PNG_MAGIC)) || head.subarray(0, 3).equals(JPEG_MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A screenshot path the report may cite: a real image file inside the
 * evidence dir (after resolving links), written at or after `since`.
 * @returns {string|null} the absolute path, null when unusable
 */
function evidenceFile(raw, { evidenceDir, since }) {
  const p = clean(raw, MAX_PATH_CHARS);
  if (!p || !IMAGE_EXT.test(p)) return null;
  try {
    const root = fs.realpathSync.native(evidenceDir);
    const file = fs.realpathSync.native(path.resolve(root, p));
    if (!isInside(root, file) || !IMAGE_EXT.test(file)) return null;
    const st = fs.statSync(file);
    return st.isFile() && st.mtimeMs >= since && hasImageMagic(file) ? file : null;
  } catch {
    return null;
  }
}

function cleanEvidence(raw, ctx) {
  const src = isObj(raw) ? raw : {};
  return { screenshot: evidenceFile(src.screenshot, ctx), steps: strings(src.steps, MAX_STEPS, MAX_STEP_CHARS) };
}

function cleanFinding(f, ctx, warnings) {
  const title = isObj(f) ? clean(f.title, MAX_TITLE_CHARS) : '';
  if (!title || !KINDS.includes(f.kind) || !SEVERITIES.includes(f.severity)) {
    warnings.push({ code: 'badFinding', title });
    return null;
  }
  const screenshot = evidenceFile(f.screenshot, ctx);
  if (!screenshot) warnings.push({ code: 'badScreenshot', title });
  return {
    kind: f.kind,
    severity: f.severity,
    title,
    steps: strings(f.steps, MAX_STEPS, MAX_STEP_CHARS),
    screenshot,
    consoleErrors: strings(f.consoleErrors, MAX_CONSOLE_ERRORS, MAX_CONSOLE_CHARS),
  };
}

function cleanScore(s, ctx, warnings) {
  const milestone = isObj(s) ? clean(s.milestone, MAX_NAME_CHARS) : '';
  const criterion = isObj(s) ? clean(s.criterion, MAX_TITLE_CHARS) : '';
  const valid = Number.isFinite(s && s.score) && s.score >= 0 && s.score <= MAX_SCORE;
  if (!milestone || !criterion || !valid) {
    warnings.push({ code: 'badScore', criterion });
    return null;
  }
  const evidence = cleanEvidence(s.evidence, ctx);
  if (!evidence.screenshot || !evidence.steps.length) {
    warnings.push({ code: 'noEvidence', criterion });
    return null;
  }
  return { milestone, criterion, score: s.score, evidence };
}

function cleanJourney(j, ctx, warnings) {
  const name = isObj(j) ? clean(j.name, MAX_NAME_CHARS) : '';
  if (!name || typeof j.passed !== 'boolean') {
    warnings.push({ code: 'badJourney', name });
    return null;
  }
  const evidence = cleanEvidence(j.evidence, ctx);
  // A pass is a claim like a score: without evidence it does not count.
  const proven = !!evidence.screenshot && evidence.steps.length > 0;
  if (j.passed && !proven) warnings.push({ code: 'noEvidence', journey: name });
  return { name, passed: j.passed && proven, evidence };
}

function cleanScreens(list, ctx, warnings) {
  const seen = new Set();
  const out = [];
  for (const s of list.slice(0, MAX_SCREENS)) {
    const name = isObj(s) ? screenSlug(s.name) : '';
    const screenshot = name ? evidenceFile(s.screenshot, ctx) : null;
    if (!name || seen.has(name) || !screenshot || !/\.png$/i.test(screenshot)) {
      warnings.push({ code: 'badScreen', name });
      continue;
    }
    seen.add(name);
    out.push({ name, screenshot });
  }
  return out;
}

const REPORT_KEYS = ['findings', 'scores', 'journeys', 'screens'];

/** The report a failed run yields: nothing found, nothing scored, one error note. */
function emptyReport(mode, error) {
  return { mode, findings: [], scores: [], journeys: [], screens: [], checks: [], warnings: [], errors: error ? [error] : [] };
}

/**
 * Validates and normalizes the Playtester's reply. Never throws. A reply
 * missing any of the four lists is malformed as a whole (the `result`
 * fallback skips the schema) - an empty report with an error, never a silent
 * "nothing found".
 * @param {unknown} raw model output
 * @param {{evidenceDir:string, since?:number, mode?:string, checks?:object[]}} opts since = ms;
 *   screenshots older than this are not evidence of this run; checks = what was asked
 * @returns {{mode:string, findings:object[], scores:object[], journeys:object[],
 *   screens:object[], checks:object[], warnings:object[], errors:object[]}}
 */
function validateReport(raw, { evidenceDir, since = 0, mode = 'explore', checks = [] }) {
  if (!isObj(raw) || !REPORT_KEYS.every((key) => Array.isArray(raw[key]))) {
    return emptyReport(mode, { code: 'badReport' });
  }
  const ctx = { evidenceDir, since };
  const warnings = [];
  const keep = (key, max, fn) => raw[key].slice(0, max).map((x) => fn(x, ctx, warnings)).filter(Boolean);
  return {
    mode,
    findings: keep('findings', MAX_FINDINGS, cleanFinding),
    scores: keep('scores', MAX_SCORES, cleanScore),
    journeys: keep('journeys', MAX_JOURNEYS, cleanJourney),
    screens: cleanScreens(raw.screens.slice(0, MAX_SCREENS), ctx, warnings),
    checks: cleanChecks(raw.checks, checks, (e) => cleanEvidence(e, ctx), warnings),
    warnings,
    errors: [],
  };
}

// ---- screen comparison --------------------------------------------------------------

/** config/runs/lunaswork-<runId>/baselines - the evidence dir's sibling. */
function baselinesDirFor(evidenceDir) {
  return path.join(path.dirname(path.resolve(evidenceDir)), BASELINES_DIR);
}

function readPng(file) {
  if (fs.statSync(file).size > MAX_PNG_BYTES) throw new Error('image file too large');
  const buf = fs.readFileSync(file);
  // Signature (8) + IHDR length/type (8) + width (4) + height (4).
  if (buf.length < 24 || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error('not a PNG');
  if (buf.readUInt32BE(16) * buf.readUInt32BE(20) > MAX_PNG_PIXELS) throw new Error('image too large');
  return PNG.sync.read(buf);
}

/** pixelmatch 7 is ESM-only; Node 22.12+ / Electron's Node load it with require(). */
function loadPixelmatch() {
  const mod = require('pixelmatch');
  return mod.default || mod;
}

function compareOne(screen, ctx) {
  const baseline = path.join(ctx.baselinesDir, `${screen.name}.png`);
  const current = readPng(screen.screenshot);
  let before = null;
  try {
    before = fs.existsSync(baseline) ? readPng(baseline) : null;
  } catch {
    before = null; // a broken baseline is replaced, never compared
  }
  if (!before) {
    fs.copyFileSync(screen.screenshot, baseline);
    return { result: { name: screen.name, status: 'baseline', ratio: 0 }, finding: null };
  }

  const { width, height } = current;
  const sameSize = before.width === width && before.height === height;
  let ratio = 1;
  let diffImage = null;
  if (sameSize) {
    diffImage = new PNG({ width, height });
    const changed = ctx.pixelmatch(before.data, current.data, diffImage.data, width, height, {
      threshold: PIXEL_THRESHOLD,
    });
    ratio = changed / (width * height);
  }

  let finding = null;
  if (ratio > ctx.threshold) {
    const kept = path.join(ctx.evidenceDir, `baseline-${screen.name}.png`);
    fs.copyFileSync(baseline, kept);
    const diff = diffImage ? path.join(ctx.evidenceDir, `diff-${screen.name}.png`) : null;
    if (diff) fs.writeFileSync(diff, PNG.sync.write(diffImage));
    const what = sameSize
      ? `${(ratio * 100).toFixed(1)}% of pixels differ`
      : `size changed from ${before.width}x${before.height} to ${width}x${height}`;
    finding = {
      kind: 'feel',
      severity: 'medium',
      title: `Screen "${screen.name}" changed since the previous run: ${what}`,
      steps: [`Open the "${screen.name}" screen and compare it with the previous run's image`],
      screenshot: screen.screenshot,
      baseline: kept,
      diff,
      consoleErrors: [],
    };
  }
  // Roll forward: the next run compares against this one.
  fs.copyFileSync(screen.screenshot, baseline);
  return { result: { name: screen.name, status: ratio > ctx.threshold ? 'changed' : 'same', ratio }, finding };
}

/**
 * Pixel-diffs each named screen against its baseline, then makes the new
 * screenshot the baseline. Never throws: a screen that cannot be compared is
 * skipped with a warning.
 * @param {Array<{name:string, screenshot:string}>} screens validated (validateReport)
 * @param {{evidenceDir:string, baselinesDir?:string, threshold?:number, pixelmatch?:Function}} opts
 * @returns {{results:object[], findings:object[], warnings:object[]}}
 */
function compareScreens(screens, opts) {
  const out = { results: [], findings: [], warnings: [] };
  if (!Array.isArray(screens) || !screens.length) return out;
  const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0 && opts.threshold <= 1
    ? opts.threshold
    : DIFF_THRESHOLD;
  let pixelmatch = opts.pixelmatch;
  try {
    pixelmatch = pixelmatch || loadPixelmatch();
  } catch (err) {
    out.warnings.push({ code: 'diffUnavailable', detail: clean(err.message, 300) });
    return out;
  }
  const ctx = {
    evidenceDir: opts.evidenceDir,
    baselinesDir: opts.baselinesDir || baselinesDirFor(opts.evidenceDir),
    threshold,
    pixelmatch,
  };
  try {
    fs.mkdirSync(ctx.baselinesDir, { recursive: true });
  } catch (err) {
    out.warnings.push({ code: 'diffUnavailable', detail: clean(err.message, 300) });
    return out;
  }
  for (const raw of screens) {
    // Re-slugged here too: the name becomes a file name in baselinesDir.
    const screen = { name: screenSlug(raw && raw.name), screenshot: raw && raw.screenshot };
    try {
      if (!screen.name || typeof screen.screenshot !== 'string') throw new Error('bad screen');
      const { result, finding } = compareOne(screen, ctx);
      out.results.push(result);
      if (finding) out.findings.push(finding);
    } catch (err) {
      out.results.push({ name: screen.name, status: 'skipped', ratio: null });
      out.warnings.push({ code: 'diffFailed', name: screen.name, detail: clean(err.message, 300) });
    }
  }
  return out;
}

// ---- run ----------------------------------------------------------------------------

/**
 * One headless call. Resolves {stdout} or {error, detail}; never rejects.
 * The timeout kills the whole tree, not just `claude`: on Windows execFile's
 * own timeout would leave npx, the Playwright MCP server and Chromium running.
 */
function callClaude({ args, prompt, cwd, env, execImpl, timeoutMs, killTreeImpl }) {
  return new Promise((resolve) => {
    let timedOut = false;
    let timer = null;
    const child = execImpl(
      'claude',
      args,
      { cwd, env, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        clearTimeout(timer);
        if (timedOut) return resolve({ error: 'timeout' });
        if (error && error.code === 'ENOENT') return resolve({ error: 'noClaude' });
        if (error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return resolve({ error: 'failed', detail: 'playtester output too large' });
        }
        if (error && error.killed) return resolve({ error: 'failed', detail: 'playtester was killed' });
        // A non-zero exit still prints the JSON envelope (is_error: true).
        if (error && !stdout) {
          const detail = clean(error.message, 300);
          return resolve({ error: isUsageLimitText(detail) ? 'limit' : 'failed', detail });
        }
        resolve({ stdout });
      },
    );
    if (child && Number.isInteger(child.pid)) {
      timer = setTimeout(() => {
        timedOut = true;
        killTreeImpl(child.pid);
      }, timeoutMs);
    }
    if (child && child.stdin) {
      child.stdin.on('error', () => {}); // a child that died early must not crash main
      child.stdin.end(prompt);
    }
  });
}

/**
 * Runs one Playtester pass against an already started adapter. Always
 * resolves; a failure carries an empty report with the error noted, so the
 * run goes on (plan: never reject the run).
 *
 * @param {{projectDir:string, adapter:{evidenceDir:string, tools:Function},
 *   url:string, mode?:'explore'|'shipConfirm', checks?:object[], models?:object, env?:object,
 *   execImpl?:Function, timeoutMs?:number, budgetUsd?:number,
 *   threshold?:number, now?:()=>number, killTreeImpl?:(pid:number)=>void}} opts
 * @returns {Promise<{ok:boolean, mode:string, model:string|null, modelReason:string|null,
 *   report:object, screenDiff:object|null, costUsd:number|null, durationMs:number,
 *   error?:string, detail?:string}>}
 */
async function runPlaytest(opts) {
  const { projectDir, adapter, url, mode = 'explore', models, env = process.env } = opts;
  const now = opts.now || Date.now;
  const started = now();
  const pick = MODES.includes(mode) ? playtestModel(mode, models) : null;
  const base = { mode, model: pick && pick.model, modelReason: pick && pick.reason, screenDiff: null, costUsd: null };
  const fail = (error, detail) => ({
    ok: false,
    ...base,
    error,
    ...(detail ? { detail } : {}),
    report: emptyReport(mode, { code: error, ...(detail ? { detail } : {}) }),
    durationMs: now() - started,
  });

  try {
    if (!pick) return fail('badMode', String(mode));
    const appUrl = httpUrl(url);
    if (!appUrl) return fail('badUrl', clean(String(url), 300));
    if (!adapter || typeof adapter.tools !== 'function' || typeof adapter.evidenceDir !== 'string') {
      return fail('badAdapter');
    }
    const tools = adapter.tools();
    // The browser must be locked to the app the adapter started - an unstarted
    // adapter has no origin lock and could reach LunaCore's own local servers.
    if (!allowedOrigins(tools).includes(appUrl.origin)) return fail('badUrl', 'url is not the started app origin');
    const inputs = loadPlaytestInputs(projectDir);
    // The ship pass verifies the SHIP criteria only.
    const checks = mode === 'explore' && Array.isArray(opts.checks) ? opts.checks : [];
    if (mode === 'shipConfirm' && !inputs.shipCriteria) return fail('noShipCriteria');
    if (!inputs.testPlan && !inputs.shipCriteria) return fail('noDesignPack');

    const { evidenceDir } = adapter;
    fs.mkdirSync(evidenceDir, { recursive: true });
    const marker = path.join(evidenceDir, START_MARKER);
    fs.writeFileSync(marker, `${mode}\n`);
    const since = fs.statSync(marker).mtimeMs;
    const killImpl = opts.killTreeImpl
      || ((pid) => killTree(pid, { platform: process.platform, execFile, kill: process.kill.bind(process) }));
    const call = await callClaude({
      args: buildPlaytestArgs({ model: pick.model, tools, budgetUsd: opts.budgetUsd }),
      prompt: buildPlaytestPrompt({ mode, url: appUrl.href, ...inputs, checks }),
      cwd: evidenceDir, // never the repo: the Playtester must not see the code
      env,
      execImpl: opts.execImpl || execFile,
      timeoutMs: opts.timeoutMs || PLAYTEST_TIMEOUT_MS,
      killTreeImpl: killImpl,
    });
    if (call.error) return fail(call.error, call.detail);
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return fail(parsed.error, parsed.detail);

    const validated = validateReport(parsed.raw, { evidenceDir, since, mode, checks });
    if (validated.errors.length) return fail(validated.errors[0].code);
    // The ship pass verifies criteria; visual drift is the explore pass's job.
    const screenDiff = mode === 'explore'
      ? compareScreens(validated.screens, { evidenceDir, threshold: opts.threshold })
      : null;
    const report = screenDiff
      ? {
        ...validated,
        findings: [...validated.findings, ...screenDiff.findings],
        warnings: [...validated.warnings, ...screenDiff.warnings],
      }
      : validated;
    return { ok: true, ...base, screenDiff, report, costUsd: parsed.costUsd, durationMs: now() - started };
  } catch (err) {
    return fail('crashed', clean(err && err.message, 300));
  }
}

module.exports = {
  MODES,
  SHIP_CONFIRM_MODEL,
  DENIED_TOOLS,
  PLAYTEST_SCHEMA,
  DIFF_THRESHOLD,
  DESKTOP,
  MOBILE,
  playtestModel,
  loadPlaytestInputs,
  buildPlaytestPrompt,
  allowedAdapterTools,
  buildPlaytestArgs,
  validateReport,
  emptyReport,
  baselinesDirFor,
  compareScreens,
  runPlaytest,
};
