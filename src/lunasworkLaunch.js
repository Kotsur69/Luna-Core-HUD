// ============================================================================
// LunaCore - Luna's Work launch assets at SHIP (docs/LUNAS_WORK_PLAN.md C10, LW 3.31b)
// ----------------------------------------------------------------------------
// Once a run ends with SHIP - never at any other verdict - the ECC marketing
// agent runs headless over design/BRIEF.md, design/DESIGN.md and the SHIP
// key-screen screenshots, and its answer becomes the project's marketing/
// folder:
//
//   marketing/LANDING.md          landing page copy (headline, sections, CTA)
//   marketing/PITCH.md            one sentence + one paragraph
//   marketing/STORE_LISTING.md    title, short + long description, keywords
//                                 - only when the project is an app
//   marketing/*.pl.md             the Polish versions, when the project is
//                                 bilingual (pl + en)
//   marketing/screenshots/        the curated key screens, desktop + phone,
//                                 copied from the run's evidence
//
// The command line is fixed (buildLaunchArgs): the agent, model, tools and
// schema are constants here; the only run data on it are --add-dir paths of
// the evidence folder. Everything the model says goes through the prompt on
// stdin and comes back through validateLaunch() - THE TRUST BOUNDARY: every
// text is capped, a picked screen must be one of the offered names, and file
// names are ours, never the model's.
//
// The files are written into the checkout and left uncommitted: the return
// pack (lunasworkReport.js) links them for Mati to review. Always resolves.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { parsePlannerOutput } = require('./orchestraPlan');
const { checkCwd } = require('./projects');
const { execClaude } = require('./lunasworkCritic');
const pack = require('./lunasworkPack');

const MARKETING_DIR = 'marketing';
const SCREENSHOTS_DIR = 'screenshots';
const LAUNCH_AGENT = 'ecc:marketing-agent';
const LAUNCH_MODEL = 'sonnet';
const LAUNCH_EFFORT = 'medium';
const LAUNCH_BUDGET_USD = 3;
const LAUNCH_TIMEOUT_MS = 15 * 60 * 1000;
// Read-only: the agent reads the pack and looks at the screenshots, nothing else.
const LAUNCH_TOOLS = 'Read,Glob';

const MAX_DOC_CHARS = 20000;
const MAX_OFFERED_SCREENS = 16;
const MAX_CURATED_SCREENS = 8;
const MAX_SECTIONS = 8;
const MAX_KEYWORDS = 20;
const LIMITS = {
  headline: 120,
  subheadline: 240,
  heading: 120,
  body: 1500,
  cta: 80,
  sentence: 240,
  paragraph: 1200,
  title: 60,
  short: 160,
  long: 4000,
  keyword: 40,
  screen: 60,
};

// A key screen as the Playtester names it: "<screen>-desktop" / "<screen>-mobile".
const SCREEN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const KEY_SCREEN_RE = /-(desktop|mobile)$/;
// Evidence files that are not screens of the app (the screen diff's own output).
const NOT_A_SCREEN_RE = /^(baseline|diff)-/;

// What makes a project bilingual / an app, read from BRIEF.md + DESIGN.md.
const BILINGUAL_RE = /\b(bilingual|polish|polski|po polsku|pl\s*[/+&]\s*en|en\s*[/+&]\s*pl|dwujezyczn\w*)\b/i;
const APP_RE = /\b(app store|play store|google play|microsoft store|mobile app|desktop app|ios|android|electron|pwa|installable|aplikacj\w*)\b/i;

// ---- schema -------------------------------------------------------------------------

const str = { type: 'string' };
const LANDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'subheadline', 'sections', 'cta'],
  properties: {
    headline: str,
    subheadline: str,
    sections: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['heading', 'body'], properties: { heading: str, body: str } },
    },
    cta: str,
  },
};
const PITCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sentence', 'paragraph'],
  properties: { sentence: str, paragraph: str },
};
const STORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'short', 'long', 'keywords'],
  properties: { title: str, short: str, long: str, keywords: { type: 'array', items: str } },
};
const COPY_PROPERTIES = { landing: LANDING_SCHEMA, pitch: PITCH_SCHEMA, store: STORE_SCHEMA };

/** JSON schema handed to `--json-schema`. Mirrors validateLaunch() below. */
const LAUNCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['landing', 'pitch', 'screens'],
  properties: {
    ...COPY_PROPERTIES,
    screens: { type: 'array', items: str },
    pl: { type: 'object', additionalProperties: false, required: ['landing', 'pitch'], properties: COPY_PROPERTIES },
  },
};

// ---- helpers ------------------------------------------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, max);
// Control characters out, paragraphs kept.
// eslint-disable-next-line no-control-regex
const block = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** True when the brief / design say the project ships in Polish and English. */
const isBilingual = (text) => BILINGUAL_RE.test(String(text || ''));

/** True when the brief / design describe an installable app (store listing). */
const isApp = (text) => APP_RE.test(String(text || ''));

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isPng(file) {
  try {
    return /\.png$/i.test(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function listPngs(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
  } catch {
    return [];
  }
}

/**
 * The key screens the agent may pick from: the SHIP iteration's validated
 * `screens` (desktop + mobile), else the "<screen>-desktop|mobile.png" files
 * in its evidence folder. Only real PNG files.
 * @param {object} run the finished run (onRunEnd snapshot)
 * @returns {Array<{name:string, file:string}>}
 */
function candidateScreens(run) {
  const r = isObj(run) ? run : {};
  const report = isObj(r.current) && isObj(r.current.report) ? r.current.report : null;
  const out = new Map();
  const add = (name, file) => {
    if (out.size >= MAX_OFFERED_SCREENS || out.has(name) || !SCREEN_NAME_RE.test(name) || !isPng(file)) return;
    out.set(name, file);
  };
  for (const s of report && Array.isArray(report.screens) ? report.screens : []) {
    if (isObj(s) && typeof s.name === 'string' && typeof s.screenshot === 'string') add(s.name, s.screenshot);
  }
  if (!out.size && typeof r.evidenceDir === 'string' && r.evidenceDir) {
    for (const f of listPngs(r.evidenceDir)) {
      const name = f.replace(/\.png$/i, '').toLowerCase();
      if (KEY_SCREEN_RE.test(name) && !NOT_A_SCREEN_RE.test(name)) add(name, path.join(r.evidenceDir, f));
    }
  }
  return [...out.entries()].map(([name, file]) => ({ name, file }));
}

// ---- command + prompt ---------------------------------------------------------------

/**
 * The fixed command line. No model text ever reaches it: the --add-dir
 * entries are the run's own evidence folders, so the agent can read the
 * screenshots outside the repo.
 */
function buildLaunchArgs({ addDirs = [], budgetUsd = LAUNCH_BUDGET_USD } = {}) {
  return [
    '-p',
    '--agent', LAUNCH_AGENT,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(LAUNCH_SCHEMA),
    '--model', LAUNCH_MODEL,
    '--effort', LAUNCH_EFFORT,
    '--tools', LAUNCH_TOOLS,
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
    ...addDirs.flatMap((dir) => ['--add-dir', dir]),
  ];
}

/** The prompt on stdin: the pack, the screens to look at, what to write. */
function buildLaunchPrompt({ brief, design, screens, app, bilingual }) {
  const lines = [
    'The project below just shipped. Write its launch assets.',
    '',
    '## BRIEF.md',
    '',
    brief || '(empty)',
    '',
    '## DESIGN.md',
    '',
    design || '(empty)',
    '',
    '## Screenshots of the shipped app',
    '',
    'Open each file with Read to see the screen. Names end in -desktop or -mobile (phone width).',
    ...(screens.length ? screens.map((s) => `- ${s.name}: ${s.file}`) : ['- none']),
    '',
    '## What to write',
    '',
    '- landing: landing page copy - headline, subheadline, 3-6 sections (heading + body), one call to action. Plain text, no HTML.',
    '- pitch: one sentence, and one paragraph of 3-5 sentences.',
    app
      ? '- store: a store listing - title (max 30 characters), short description (max 80), long description, 5-15 keywords.'
      : '- store: leave it out, the project is not a store app.',
    `- screens: the names (from the list above, exact) of the ${MAX_CURATED_SCREENS} or fewer screens that sell the product best, best first, desktop and phone both when there are both.`,
    bilingual
      ? `- pl: the same landing and pitch${app ? ' and store' : ''} in Polish, written for Polish readers, not word for word.`
      : '- pl: leave it out, the project is English only.',
    '- Only claim what BRIEF.md, DESIGN.md and the screenshots show. No invented numbers, prices, reviews or awards.',
  ];
  return lines.join('\n');
}

// ---- validation ---------------------------------------------------------------------

function cleanLanding(raw) {
  if (!isObj(raw)) return null;
  const headline = oneLine(raw.headline, LIMITS.headline);
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .filter(isObj)
    .map((s) => ({ heading: oneLine(s.heading, LIMITS.heading), body: block(s.body, LIMITS.body) }))
    .filter((s) => s.heading && s.body)
    .slice(0, MAX_SECTIONS);
  if (!headline || !sections.length) return null;
  return { headline, subheadline: oneLine(raw.subheadline, LIMITS.subheadline), sections, cta: oneLine(raw.cta, LIMITS.cta) };
}

function cleanPitch(raw) {
  if (!isObj(raw)) return null;
  const sentence = oneLine(raw.sentence, LIMITS.sentence);
  const paragraph = block(raw.paragraph, LIMITS.paragraph);
  return sentence && paragraph ? { sentence, paragraph } : null;
}

function cleanStore(raw) {
  if (!isObj(raw)) return null;
  const title = oneLine(raw.title, LIMITS.title);
  const short = oneLine(raw.short, LIMITS.short);
  const long = block(raw.long, LIMITS.long);
  const keywords = [...new Set((Array.isArray(raw.keywords) ? raw.keywords : []).map((k) => oneLine(k, LIMITS.keyword)).filter(Boolean))]
    .slice(0, MAX_KEYWORDS);
  return title && short && long ? { title, short, long, keywords } : null;
}

function cleanCopy(raw, app) {
  if (!isObj(raw)) return null;
  const landing = cleanLanding(raw.landing);
  const pitch = cleanPitch(raw.pitch);
  if (!landing || !pitch) return null;
  return { landing, pitch, store: app ? cleanStore(raw.store) : null };
}

/**
 * The agent's answer, cleaned. A store listing only for an app, a Polish
 * version only for a bilingual project, screens only from the offered names.
 * @returns {{ok:true, copy:object, pl:object|null, screens:string[]}|{ok:false, error:string}}
 */
function validateLaunch(raw, { app = false, bilingual = false, screenNames = [] } = {}) {
  const copy = cleanCopy(raw, app);
  if (!copy) return { ok: false, error: 'badAssets' };
  const offered = new Set(screenNames);
  const screens = [...new Set((Array.isArray(raw.screens) ? raw.screens : []).map((s) => oneLine(s, LIMITS.screen)))]
    .filter((s) => offered.has(s))
    .slice(0, MAX_CURATED_SCREENS);
  const pl = bilingual ? cleanCopy(raw.pl, app) : null;
  return { ok: true, copy, pl, screens };
}

// ---- markdown -----------------------------------------------------------------------

const HEADINGS = {
  en: { landing: 'Landing page', pitch: 'Pitch', sentence: 'One sentence', paragraph: 'One paragraph', store: 'Store listing',
    title: 'Title', short: 'Short description', long: 'Long description', keywords: 'Keywords', cta: 'Call to action' },
  pl: { landing: 'Strona glowna', pitch: 'Pitch', sentence: 'Jedno zdanie', paragraph: 'Jeden akapit', store: 'Opis w sklepie',
    title: 'Tytul', short: 'Krotki opis', long: 'Dlugi opis', keywords: 'Slowa kluczowe', cta: 'Wezwanie do dzialania' },
};

function landingMarkdown(l, lang) {
  const t = HEADINGS[lang];
  return [
    `# ${t.landing}`,
    '',
    `## ${l.headline}`,
    '',
    ...(l.subheadline ? [l.subheadline, ''] : []),
    ...l.sections.flatMap((s) => [`### ${s.heading}`, '', s.body, '']),
    ...(l.cta ? [`**${t.cta}:** ${l.cta}`, ''] : []),
  ].join('\n');
}

function pitchMarkdown(p, lang) {
  const t = HEADINGS[lang];
  return [`# ${t.pitch}`, '', `## ${t.sentence}`, '', p.sentence, '', `## ${t.paragraph}`, '', p.paragraph, ''].join('\n');
}

function storeMarkdown(s, lang) {
  const t = HEADINGS[lang];
  return [
    `# ${t.store}`,
    '',
    `## ${t.title}`, '', s.title, '',
    `## ${t.short}`, '', s.short, '',
    `## ${t.long}`, '', s.long, '',
    `## ${t.keywords}`, '', s.keywords.join(', ') || '-', '',
  ].join('\n');
}

/** The files to write, relative to marketing/ - names are ours, never the model's. */
function assetFiles(copy, lang) {
  const suffix = lang === 'pl' ? '.pl.md' : '.md';
  return [
    { name: `LANDING${suffix}`, text: landingMarkdown(copy.landing, lang) },
    { name: `PITCH${suffix}`, text: pitchMarkdown(copy.pitch, lang) },
    ...(copy.store ? [{ name: `STORE_LISTING${suffix}`, text: storeMarkdown(copy.store, lang) }] : []),
  ];
}

// ---- effects ------------------------------------------------------------------------

// The screenshots this module writes (NN-<name>.png): replaced on every SHIP.
const CURATED_FILE_RE = /^\d{2}-[a-z0-9_-]+\.png$/;

/** A file write that never follows a link: a linked target could point anywhere. */
function refuseLink(target) {
  if (isLink(target)) throw new Error(`${path.basename(target)} is a link`);
  return target;
}

/** Drops the curated screenshots of an earlier SHIP, so none goes stale. */
function clearCurated(shots) {
  for (const f of fs.existsSync(shots) ? fs.readdirSync(shots) : []) {
    const file = path.join(shots, f);
    if (CURATED_FILE_RE.test(f) && !isLink(file)) fs.rmSync(file, { force: true });
  }
}

/**
 * Writes the assets into <repo>/marketing/. Refuses a linked marketing/ or
 * screenshots/ folder, or a linked file in them. Screens are copied as
 * screenshots/NN-<name>.png in the agent's order.
 * @returns {string[]} the written paths, relative to the repo
 */
function writeAssets(repoDir, { copy, pl, screens }, candidates) {
  const dir = path.join(path.resolve(repoDir), MARKETING_DIR);
  const shots = path.join(dir, SCREENSHOTS_DIR);
  refuseLink(dir);
  refuseLink(shots);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const f of [...assetFiles(copy, 'en'), ...(pl ? assetFiles(pl, 'pl') : [])]) {
    fs.writeFileSync(refuseLink(path.join(dir, f.name)), f.text, 'utf8');
    written.push(`${MARKETING_DIR}/${f.name}`);
  }
  const byName = new Map(candidates.map((c) => [c.name, c.file]));
  // The agent picked none: keep the offered key screens, capped.
  const picked = screens.length ? screens : candidates.slice(0, MAX_CURATED_SCREENS).map((c) => c.name);
  clearCurated(shots);
  if (picked.length) fs.mkdirSync(shots, { recursive: true });
  picked.forEach((name, i) => {
    const file = `${String(i + 1).padStart(2, '0')}-${name}.png`;
    fs.copyFileSync(byName.get(name), refuseLink(path.join(shots, file)));
    written.push(`${MARKETING_DIR}/${SCREENSHOTS_DIR}/${file}`);
  });
  return written;
}

const defaultLog = (message, detail) => console.error('[lunaswork-launch]', message, detail === undefined ? '' : detail);

/**
 * Runs the marketing agent for a shipped run and writes marketing/.
 * Only a SHIP run gets assets: any other verdict is skipped untouched.
 * Always resolves, never rejects.
 *
 * @param {{run:object, env?:object, budgetUsd?:number, timeoutMs?:number,
 *   runClaude?:(call:{args:string[], prompt:string, cwd:string, env:object, timeoutMs:number})=>Promise<object>,
 *   log?:(message:string, detail?:unknown)=>void}} opts
 * @returns {Promise<{ok:boolean, dir?:string, files?:string[], bilingual?:boolean, app?:boolean,
 *   costUsd?:number|null, skipped?:string, error?:string, detail?:string}>}
 */
async function runLaunchAssets(opts) {
  const o = isObj(opts) ? opts : {};
  const log = typeof o.log === 'function' ? o.log : defaultLog;
  const run = isObj(o.run) ? o.run : {};
  const fail = (error, detail) => {
    log(`launch assets failed: ${error}`, detail);
    return { ok: false, error, ...(detail ? { detail } : {}) };
  };
  if (run.verdict !== 'ship') return { ok: false, skipped: 'not-ship' };
  try {
    const repoDir = run.repoPath;
    if (!checkCwd(repoDir).ok) return fail('noRepo', oneLine(repoDir, 300));
    const brief = block(pack.readPackFile(repoDir, 'BRIEF.md') || '', MAX_DOC_CHARS);
    const design = block(pack.readPackFile(repoDir, 'DESIGN.md') || '', MAX_DOC_CHARS);
    const bilingual = isBilingual(`${brief}\n${design}`);
    const app = isApp(`${brief}\n${design}`);
    const candidates = candidateScreens(run);
    const addDirs = [...new Set(candidates.map((c) => path.dirname(path.resolve(c.file))))];
    const runner = typeof o.runClaude === 'function' ? o.runClaude : execClaude;
    const call = await runner({
      args: buildLaunchArgs({ addDirs, budgetUsd: o.budgetUsd }),
      prompt: buildLaunchPrompt({ brief, design, screens: candidates, app, bilingual }),
      cwd: repoDir,
      env: o.env || process.env,
      timeoutMs: o.timeoutMs || LAUNCH_TIMEOUT_MS,
    });
    if (!isObj(call) || call.error) return fail((isObj(call) && call.error) || 'failed', isObj(call) ? call.detail : undefined);
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return fail(parsed.error, parsed.detail);
    const assets = validateLaunch(parsed.raw, { app, bilingual, screenNames: candidates.map((c) => c.name) });
    if (!assets.ok) return fail(assets.error);
    const files = writeAssets(repoDir, assets, candidates);
    return { ok: true, dir: path.join(path.resolve(repoDir), MARKETING_DIR), files, bilingual, app, costUsd: parsed.costUsd };
  } catch (err) {
    return fail('crashed', oneLine(errText(err), 300));
  }
}

module.exports = {
  MARKETING_DIR,
  LAUNCH_AGENT,
  LAUNCH_SCHEMA,
  isBilingual,
  isApp,
  candidateScreens,
  buildLaunchArgs,
  buildLaunchPrompt,
  validateLaunch,
  runLaunchAssets,
};
