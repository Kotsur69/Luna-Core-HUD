// ============================================================================
// LunaCore - Luna's Work design pack (docs/LUNAS_WORK_PLAN.md, slice 2)
// ----------------------------------------------------------------------------
// The pre-production pack lives in the PROJECT repo under `design/`:
//
//   templates     -> TEMPLATES, scaffoldPack (writes only missing files)
//   ownership     -> appendDesign / appendPlaytestLog / appendDecision /
//                    appendJourney / writeArchitecture build pure write ops
//                    { file, update(current) -> next }; applyWrite does the IO
//                    and is the one place that touches disk. Only pack files
//                    are writable and the target must resolve inside design/.
//   reading       -> parseShipCriteria (feeds lunasworkRules.gatePassed),
//                    parseJourneys, packCompleteness
//   design match  -> parseDesignMappings / readDesignMappings: the
//                    `screen | route | mockup file` table in
//                    design/references/README.md (LW 2.19a)
//   legal         -> appendLegalJourneys: the GDPR journeys of an EU web app
//                    into TEST_PLAN.md, each once (LW 2.26)
//   interview     -> interviewBrief: system prompt for the Interviewer tab
//
// Same contract as cheatsheets.js / lunasworkStore.js: a missing or broken
// file reads as empty / null, a failed write returns { ok: false } - never a
// throw.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { LEGAL_DRAFT_MARKER, LEGAL_JOURNEYS } = require('./lunasworkLegal');

const DESIGN_DIR = 'design';
const REFERENCES_DIR = 'references';
// Appends are capped so one runaway model reply cannot bloat the pack.
const MAX_APPEND_CHARS = 20000;
const MAX_ARCHITECTURE_CHARS = 100000;

const TEMPLATES = Object.freeze({
  'BRIEF.md': `# Brief

<!-- Written by the Interviewer with Mati. Keep it short: one screen. -->

## What it is

<!-- One paragraph: the product, in plain words. -->

## Who it is for

<!-- The users and the situation they use it in. For users in the EU, add the
     line "EU web app: yes" (or "no") - it turns on the GDPR legal pack. -->

## Success in one sentence

<!-- "It works when ..." - the single test the finished product must pass. -->
`,
  'DESIGN.md': `# Design

<!-- Written by the Interviewer. The Director may append below, never rewrite. -->

## Features

<!-- What the product does, as a list. Mark must-haves vs nice-to-haves. -->

## Screens

<!-- Every screen / view and what is on it. -->

## Rules

<!-- Business rules, calculations, limits, edge cases. -->

## Look and feel

<!-- Style, tone, colors, references in design/references/. -->
`,
  'SHIP_CRITERIA.md': `# Ship criteria

<!-- Milestone ladder. The Critic cannot move to the next milestone until every
     item of the current gate passes. Edit the items to fit the project; keep
     one "## Milestone" heading per rung and one "- [ ]" line per gate item. -->

## Milestone 1: Skeleton

- [ ] The app starts without errors
- [ ] Every main screen is reachable

## Milestone 2: Core flows

- [ ] Every user journey in TEST_PLAN.md completes end to end

## Milestone 3: Complete

- [ ] Every must-have feature in DESIGN.md works
- [ ] No open bug cards of severity high or above

## Milestone 4: Polish

- [ ] Look and feel matches DESIGN.md and design/references/
- [ ] Works at mobile and desktop width
`,
  'TEST_PLAN.md': `# Test plan

<!-- The Playtester runs every journey below on every iteration, then explores
     freely. The Critic may append journeys. One "### " heading per journey,
     steps and the expected result under it. -->

## Free exploration

<!-- What to poke at beyond the journeys: odd inputs, back button, reloads. -->

## Journeys
`,
  'PLAYTEST_LOG.md': `# Playtest log

<!-- Critic only. One entry per iteration: what was played, good, bad, broken,
     missing, scores, verdict. -->
`,
  'ARCHITECTURE.md': `# Architecture

<!-- Project memory, rewritten by the Critic after each iteration. Every
     builder reads this first. -->

## Modules

## Data flow

## Conventions
`,
  'DECISIONS.md': `# Decisions

<!-- Decision log, appended by the Director and the Critic: "chose X because
     Y". Builders must not contradict an entry without adding a new one. -->
`,
  'ROADMAP.md': `# Roadmap

<!-- Goal -> milestones -> epics -> cards. The Director works one epic at a
     time: the first open epic of the first milestone that still has one.
     One "### " heading per milestone under "## Milestones", one line per
     epic: "- [ ] epic:<slug> - <title>" (slug: lowercase letters, digits,
     "-"). The Director ticks an epic "[x]" once all its cards are done. -->

## Goal

## Milestones
`,
});

const REFERENCES_README = `# References

Screenshots, mockups and example data (e.g. a real quote) the build should
match. Drop files here; DESIGN.md and SHIP_CRITERIA.md may point at them.

## Screens

<!-- Design match: the Playtester captures each screen at its mockup's width
     and scores how close it is (0-10). One row per screen; the mockup is a
     PNG or JPEG in this folder. -->

| Screen | Route | Mockup file |
| --- | --- | --- |
`;

const PACK_FILES = Object.freeze(Object.keys(TEMPLATES));
// LW 2.12: written by the Director before a parallel build, never scaffolded.
const CONTRACTS_FILE = 'CONTRACTS.md';
const WRITABLE_FILES = Object.freeze([...PACK_FILES, CONTRACTS_FILE]);
const REQUIRED_FILES = Object.freeze(['BRIEF.md', 'DESIGN.md', 'SHIP_CRITERIA.md', 'TEST_PLAN.md']);

const PURPOSE = Object.freeze({
  'BRIEF.md': 'what it is, who it is for, the one-sentence success',
  'DESIGN.md': 'features, screens, rules, look and feel',
  'SHIP_CRITERIA.md': 'milestone ladder (skeleton -> core flows -> complete -> polish), each gate a "- [ ]" checklist',
  'TEST_PLAN.md': 'user journeys the Playtester runs every iteration ("### " per journey), plus free exploration',
  'PLAYTEST_LOG.md': 'leave as is - the Critic writes it',
  'ARCHITECTURE.md': 'modules, data flow, conventions (may stay a template for a new project)',
  'DECISIONS.md': '"chose X because Y" log - record every decision Mati makes in the interview',
  'ROADMAP.md': 'goal -> milestones ("### " each) -> epics ("- [ ] epic:<slug> - <title>"); the Director works one epic at a time',
});

// ---- paths ---------------------------------------------------------------------

const isRepoDir = (dir) => typeof dir === 'string' && dir.length > 0 && path.isAbsolute(dir);

const designDir = (repoDir) => path.join(path.resolve(repoDir), DESIGN_DIR);

/** Absolute path of a pack file, or null when it is not a pack file or escapes design/. */
function packPath(repoDir, file) {
  if (!isRepoDir(repoDir) || !WRITABLE_FILES.includes(file)) return null;
  const root = designDir(repoDir);
  const target = path.resolve(root, file);
  return path.dirname(target) === root ? target : null;
}

/** @returns {string|null} the file's text, or null when missing / unreadable */
function readPackFile(repoDir, file) {
  const target = packPath(repoDir, file);
  if (!target) return null;
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

// ---- scaffold ------------------------------------------------------------------

/** True when `p` exists and is a symlink (Node reports Windows junctions as one too). */
function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Creates a file only when it does not exist ('wx'). @returns {'created'|'skipped'|'failed'} */
function createIfMissing(target, content) {
  try {
    fs.writeFileSync(target, content, { flag: 'wx' });
    return 'created';
  } catch (err) {
    return err && err.code === 'EEXIST' ? 'skipped' : 'failed';
  }
}

/**
 * Writes every missing pack file plus design/references/README.md. Never
 * overwrites an existing file.
 * @returns {{ok:boolean, created:string[], skipped:string[], failed:string[]}}
 */
function scaffoldPack(repoDir) {
  const result = { ok: false, created: [], skipped: [], failed: [] };
  if (!isRepoDir(repoDir)) return result;
  const root = designDir(repoDir);
  const refs = path.join(root, REFERENCES_DIR);
  // A repo can ship design/ (or references/) as a symlink or junction: writing
  // through it would create files outside the project. Checked before mkdir.
  if (isLink(root) || isLink(refs)) return result;
  try {
    fs.mkdirSync(refs, { recursive: true });
  } catch {
    return result;
  }
  const entries = [
    ...PACK_FILES.map((file) => [file, path.join(root, file), TEMPLATES[file]]),
    [`${REFERENCES_DIR}/README.md`, path.join(root, REFERENCES_DIR, 'README.md'), REFERENCES_README],
  ];
  for (const [name, target, content] of entries) result[createIfMissing(target, content)].push(name);
  return { ...result, ok: result.failed.length === 0 };
}

// ---- ownership: pure write ops -------------------------------------------------

const cleanText = (text, max) => {
  if (typeof text !== 'string') return null;
  const trimmed = text.replace(/\r\n/g, '\n').trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
};

const withBlock = (current, block) => {
  const base = (current || '').replace(/\r\n/g, '\n').replace(/\s*$/, '');
  return `${base ? `${base}\n\n` : ''}${block}\n`;
};

/** Director: appends a section to DESIGN.md; existing text is kept as is. */
function appendDesign(text) {
  const block = cleanText(text, MAX_APPEND_CHARS);
  if (!block) return null;
  return { file: 'DESIGN.md', update: (current) => withBlock(current, block) };
}

/** Critic only: one iteration entry at the end of PLAYTEST_LOG.md. */
function appendPlaytestLog(entry) {
  const block = cleanText(entry, MAX_APPEND_CHARS);
  if (!block) return null;
  return { file: 'PLAYTEST_LOG.md', update: (current) => withBlock(current, block) };
}

/** Director / Critic / interview answer: one "chose X because Y" line in DECISIONS.md. */
function appendDecision(decision) {
  const d = decision && typeof decision === 'object' ? decision : {};
  const choice = cleanText(d.choice, MAX_APPEND_CHARS);
  const because = cleanText(d.because, MAX_APPEND_CHARS);
  if (!choice || !because) return null;
  const source = cleanText(d.source, 100);
  const line = `- Chose ${oneLine(choice)} because ${oneLine(because)}${source ? ` (source: ${oneLine(source)})` : ''}`;
  return { file: 'DECISIONS.md', update: (current) => withLine(current, line) };
}

/** Decision queue (lunasworkDecisions.decisionLine): one ready-made "- ..." line in DECISIONS.md. */
function appendDecisionEntry(entry) {
  const text = cleanText(entry, MAX_APPEND_CHARS);
  if (!text) return null;
  const line = oneLine(text);
  return { file: 'DECISIONS.md', update: (current) => withLine(current, line.startsWith('- ') ? line : `- ${line}`) };
}

const oneLine = (s) => s.replace(/\s+/g, ' ');

const withLine = (current, line) => {
  const base = (current || '').replace(/\r\n/g, '\n').replace(/\s*$/, '');
  return `${base ? `${base}\n` : ''}${line}\n`;
};

/** Critic: a new "### " journey at the end of the Journeys section of TEST_PLAN.md. */
function appendJourney(text) {
  const body = cleanText(text, MAX_APPEND_CHARS);
  if (!body) return null;
  const block = body.startsWith('### ') ? body : `### ${body}`;
  return { file: 'TEST_PLAN.md', update: (current) => insertJourney(current, block) };
}

function insertJourney(current, block) {
  const lines = (current || '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+Journeys\s*$/i.test(l));
  if (start < 0) return withBlock(current, `## Journeys\n\n${block}`);
  const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (next < 0) return withBlock(current, block);
  const head = lines.slice(0, next).join('\n').replace(/\s*$/, '');
  return `${head}\n\n${block}\n\n${lines.slice(next).join('\n')}`;
}

/** Critic: replaces ARCHITECTURE.md as a whole (project memory). */
function writeArchitecture(text) {
  const body = cleanText(text, MAX_ARCHITECTURE_CHARS);
  if (!body) return null;
  return { file: 'ARCHITECTURE.md', update: () => `${body}\n` };
}

/** Critic's hand-back pass (C11): a section about Mati's manual commits at the end of ARCHITECTURE.md. */
function appendArchitecture(text) {
  const block = cleanText(text, MAX_APPEND_CHARS);
  if (!block) return null;
  return { file: 'ARCHITECTURE.md', update: (current) => withBlock(current, block) };
}

// A contract's own "#".."###" lines would sit beside the file's sections.
const demoteHeadings = (text) => text.replace(/^#{1,3}(?=\s)/gm, '####');
// Backticks would break the ownership table's code spans.
const tableCell = (s) => oneLine(String(s)).replace(/[`|]/g, '');

/**
 * LW 2.12, Director: replaces CONTRACTS.md with this iteration's interfaces
 * between packages and the file ownership map. Builders read it first.
 * @param {{contracts?:Array<{name:string, kind:string, spec:string}>,
 *   ownership?:Array<{path:string, owner:string|number}>, iteration?:number}} input
 *   already validated by lunasworkDirector.validateDirection
 * @returns {{file:string, update:Function}|null} null when there is nothing to write
 */
function writeContracts(input) {
  const o = input && typeof input === 'object' ? input : {};
  const contracts = (Array.isArray(o.contracts) ? o.contracts : [])
    .map((c) => (c && typeof c === 'object' ? { name: cleanText(c.name, 200), kind: cleanText(c.kind, 40), spec: cleanText(c.spec, MAX_APPEND_CHARS) } : {}))
    .filter((c) => c.name && c.spec);
  const ownership = (Array.isArray(o.ownership) ? o.ownership : [])
    .filter((e) => e && typeof e.path === 'string' && e.path && (typeof e.owner === 'string' || Number.isFinite(e.owner)));
  if (!contracts.length && !ownership.length) return null;
  const when = Number.isInteger(o.iteration) ? ` (iteration ${o.iteration})` : '';
  const sections = [
    '# Contracts',
    '',
    `<!-- Written by the Director before a parallel build${when}. Builders: respect these interfaces and only edit files you own. -->`,
    ...contracts.flatMap((c) => ['', `## ${oneLine(c.name)}${c.kind ? ` (${oneLine(c.kind)})` : ''}`, '', demoteHeadings(c.spec)]),
  ];
  if (ownership.length) {
    sections.push('', '## File ownership', '', '| Path | Package |', '| --- | --- |');
    for (const e of ownership) sections.push(`| \`${tableCell(e.path)}\` | ${tableCell(e.owner)} |`);
  }
  const body = sections.join('\n');
  if (body.length > MAX_ARCHITECTURE_CHARS) return null;
  return { file: CONTRACTS_FILE, update: () => `${body}\n` };
}

/**
 * The one writer: reads the current file (missing = ''), applies the op and
 * writes the result, only for pack files inside <repo>/design/.
 * @returns {{ok:boolean, error?:string}}
 */
function applyWrite(repoDir, op) {
  if (!op || typeof op.update !== 'function') return { ok: false, error: 'invalid op' };
  const target = packPath(repoDir, op.file);
  if (!target) return { ok: false, error: 'path outside design/' };
  try {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, op.update(current), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'write failed' };
  }
}

// ---- reading -------------------------------------------------------------------

const stripComments = (md) => (typeof md === 'string' ? md.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '') : '');

/**
 * Milestones in file order. Every "## " heading is a milestone; every
 * "- [ ]" / "- [x]" line under it is a gate item. The shape fits
 * lunasworkRules.gatePassed({ criteria }).
 * @returns {{name:string, criteria:{text:string, passed:boolean}[]}[]}
 */
function parseShipCriteria(md) {
  const milestones = [];
  for (const line of stripComments(md).split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      milestones.push({ name: heading[1], criteria: [] });
      continue;
    }
    const item = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (item && milestones.length) {
      milestones[milestones.length - 1].criteria.push({ text: item[2], passed: item[1] !== ' ' });
    }
  }
  return milestones;
}

/** Names of the "### " journeys under "## Journeys" in TEST_PLAN.md. */
function parseJourneys(md) {
  const journeys = [];
  let inJourneys = false;
  for (const line of stripComments(md).split('\n')) {
    if (/^##\s/.test(line)) inJourneys = /^##\s+Journeys\s*$/i.test(line);
    const journey = inJourneys && line.match(/^###\s+(.+?)\s*$/);
    if (journey) journeys.push(journey[1]);
  }
  return journeys;
}

// ---- design match (LW 2.19a) -----------------------------------------------------

const MOCKUP_EXT_RE = /\.(png|jpe?g)$/i;
const MAX_MAPPINGS = 30;
const MAX_MAPPING_CELL_CHARS = 200;
const HEADER_WORDS = ['screen', 'route', 'mockup', 'mockup file', 'file', 'path', 'url', 'ekran', 'makieta'];

/** A table cell's plain value: no backticks, a markdown link's target (or text), no <angle brackets>. */
function cellValue(raw, preferLink) {
  const text = raw.trim();
  const link = text.match(/^!?\[([^\]]*)\]\(\s*<?([^)>\s]+)>?\s*\)$/);
  const value = link ? (preferLink ? link[2] : link[1]) : text;
  return value.replace(/^`+|`+$/g, '').replace(/^<|>$/g, '').trim();
}

/** A route inside the app: "/path?query", from a bare path or a full URL. Null when unusable. */
function cleanRoute(raw) {
  if (!raw || raw.length > MAX_MAPPING_CELL_CHARS || /\s/.test(raw)) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/** A mockup file inside design/references/: relative, no "..", a PNG / JPEG. Null when unusable. */
function cleanMockup(raw) {
  if (!raw || raw.length > MAX_MAPPING_CELL_CHARS) return null;
  const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^design\/references\//i, '');
  if (!MOCKUP_EXT_RE.test(rel) || rel.startsWith('/') || /^[a-z]:/i.test(rel)) return null;
  if (rel.split('/').some((part) => part === '..' || part === '' || part === '.')) return null;
  return rel;
}

/**
 * LW 2.19a: the `screen | route | mockup file` table of
 * design/references/README.md. Tolerant: any markdown table row with three or
 * more cells counts (header and separator rows skipped, outer pipes
 * optional); a row with an unusable route or mockup is dropped; a screen
 * named twice keeps its first row. Missing or broken input reads as [].
 * @param {unknown} md
 * @returns {{screen:string, route:string, mockup:string}[]} mockup = path inside design/references/
 */
function parseDesignMappings(md) {
  if (typeof md !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const line of stripComments(md).split('\n')) {
    if (out.length >= MAX_MAPPINGS) break;
    if (!line.includes('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (cells.length < 3 || cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c) || !c.trim())) continue;
    const screen = oneLine(cellValue(cells[0], false)).slice(0, MAX_MAPPING_CELL_CHARS);
    if (!screen || HEADER_WORDS.includes(screen.toLowerCase())) continue;
    const route = cleanRoute(cellValue(cells[1], true));
    const mockup = cleanMockup(cellValue(cells[2], true));
    const key = screen.toLowerCase();
    if (!route || !mockup || seen.has(key)) continue;
    seen.add(key);
    out.push({ screen, route, mockup });
  }
  return out;
}

/** design/references/README.md's mapping table; [] when missing, linked or broken. */
function readDesignMappings(repoDir) {
  if (!isRepoDir(repoDir)) return [];
  const root = designDir(repoDir);
  const refs = path.join(root, REFERENCES_DIR);
  const file = path.join(refs, 'README.md');
  if (isLink(root) || isLink(refs) || isLink(file)) return [];
  try {
    return parseDesignMappings(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// ---- legal journeys (LW 2.26) ------------------------------------------------------

/**
 * LW 2.26, Director before SHIP: the GDPR journeys of an EU web app into
 * TEST_PLAN.md's Journeys section. A journey already there (by name) is not
 * added again; the cookie journey only when trackers were detected.
 * @param {{cookies?:boolean}} [opts]
 * @returns {{file:string, update:Function}}
 */
function appendLegalJourneys({ cookies } = {}) {
  const wanted = LEGAL_JOURNEYS.filter((j) => !j.cookies || cookies === true);
  return {
    file: 'TEST_PLAN.md',
    update: (current) => {
      const have = new Set(parseJourneys(current || '').map((n) => n.toLowerCase()));
      return wanted
        .filter((j) => !have.has(j.name.toLowerCase()))
        .reduce((text, j) => insertJourney(text, `### ${j.name}\n\n${j.body}`), current || '');
    },
  };
}

// ---- roadmap (LW 2.13) -----------------------------------------------------------

// `epic:<slug>` must stay a valid card tag (todorows TAG_RE: 40 chars max).
const MAX_EPIC_SLUG_CHARS = 35;
const EPIC_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const EPIC_LINE_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;
const EPIC_PREFIX_RES = [/^epic:([a-z0-9][a-z0-9_-]*)\b\s*(.*)$/i, /^`([a-z0-9][a-z0-9_-]*)`\s*(.*)$/i];

const slugify = (text) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, MAX_EPIC_SLUG_CHARS).replace(/-+$/, '');

/** A valid epic slug, lowercased, or null. */
function epicSlug(raw) {
  if (typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase();
  return slug.length <= MAX_EPIC_SLUG_CHARS && EPIC_SLUG_RE.test(slug) ? slug : null;
}

/** One "- [ ] epic:<slug> - <title>" line, or null. A line without a slug gets one from its title. */
function epicFromLine(line) {
  const m = line.match(EPIC_LINE_RE);
  if (!m) return null;
  const body = m[2];
  for (const re of EPIC_PREFIX_RES) {
    const hit = body.match(re);
    if (!hit) continue;
    const slug = epicSlug(hit[1]);
    if (!slug) return null;
    const title = hit[2].replace(/^[-:–—]\s*/, '').trim();
    return { slug, title: title || slug, done: m[1] !== ' ' };
  }
  const slug = slugify(body);
  return slug ? { slug, title: body, done: m[1] !== ' ' } : null;
}

// Comments blanked out but every line kept, so line numbers match the file.
const maskComments = (md) => md.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));

/**
 * One pass over ROADMAP.md. `lines` = every epic with its line number and
 * the offset of its checkbox, for tickEpic. Headings: "## Goal",
 * "## Milestones" with a "### " heading per milestone; another "## " heading
 * naming a milestone ("## Milestone 2: ...") is one too, any other "## "
 * section (Notes, Risks) is skipped.
 */
function scanRoadmap(md) {
  const goal = [];
  const milestones = [];
  const lines = [];
  const seen = new Set();
  let section = null;
  let headed = false;
  const startMilestone = (name) => milestones.push({ name, epics: [] });
  maskComments(md).split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, '');
    const h2 = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h2) {
      headed = true;
      if (/^goal$/i.test(h2[1])) section = 'goal';
      else if (/^milestones?$/i.test(h2[1])) section = 'milestones';
      else if (/\bmilestone\b/i.test(h2[1])) {
        section = 'milestones';
        startMilestone(h2[1]);
      } else section = null;
      return;
    }
    if (/^#\s/.test(line)) return;
    const h3 = line.match(/^###\s+(.+?)\s*#*\s*$/);
    if (h3) {
      if (section === 'milestones') startMilestone(h3[1]);
      return;
    }
    if (section === 'goal') {
      if (line.trim()) goal.push(line.trim());
      return;
    }
    const epic = section === 'milestones' ? epicFromLine(line) : null;
    if (!epic || seen.has(epic.slug)) return;
    seen.add(epic.slug);
    if (!milestones.length) startMilestone(`Milestone ${milestones.length + 1}`);
    milestones[milestones.length - 1].epics.push(epic);
    // Comments are blanked to the same length, so this offset holds in the raw line too.
    lines.push({ index, bracket: line.indexOf('[') + 1, ...epic });
  });
  return { headed, goal: goal.join(' '), milestones, lines };
}

/**
 * LW 2.13: goal -> milestones -> epics. Tolerant: unknown lines are skipped,
 * an epic seen twice keeps its first line. Null when `md` is not a roadmap
 * at all (not text, or no "## " section and no epic).
 * @param {unknown} md ROADMAP.md
 * @returns {{goal:string, milestones:Array<{name:string, epics:Array<{slug:string, title:string, done:boolean}>}>}|null}
 */
function parseRoadmap(md) {
  if (typeof md !== 'string' || !md.trim()) return null;
  try {
    const scan = scanRoadmap(md);
    if (!scan.headed && !scan.lines.length) return null;
    return { goal: scan.goal, milestones: scan.milestones };
  } catch {
    return null;
  }
}

/**
 * The epic the Director works on: the first open epic of the current
 * milestone (the first one that still has an open epic).
 * @param {ReturnType<typeof parseRoadmap>} roadmap
 * @returns {{slug:string, title:string, milestone:string}|null} null = no roadmap or every epic done
 */
function activeEpic(roadmap) {
  const milestones = roadmap && Array.isArray(roadmap.milestones) ? roadmap.milestones : [];
  for (const m of milestones) {
    const epic = (m.epics || []).find((e) => !e.done);
    if (epic) return { slug: epic.slug, title: epic.title, milestone: m.name };
  }
  return null;
}

/**
 * Director: ticks one epic "[x]" in ROADMAP.md. Nothing else in the file
 * changes - not a byte - and an epic that is missing or already done leaves
 * it as it is.
 * @returns {{file:string, update:Function}|null}
 */
function tickEpic(slug) {
  const wanted = epicSlug(slug);
  if (!wanted) return null;
  return {
    file: 'ROADMAP.md',
    update: (current) => {
      const text = typeof current === 'string' ? current : '';
      const hit = scanRoadmap(text).lines.find((l) => l.slug === wanted && !l.done);
      if (!hit) return text;
      const lines = text.split('\n');
      const line = lines[hit.index];
      lines[hit.index] = `${line.slice(0, hit.bracket)}x${line.slice(hit.bracket + 1)}`;
      return lines.join('\n');
    },
  };
}

const normalized = (md) => stripComments(md).replace(/\s+/g, ' ').trim();

/** True when a required file has nothing beyond its template. */
function isEmptyRequired(file, md) {
  if (normalized(md) === normalized(TEMPLATES[file])) return true;
  if (file === 'SHIP_CRITERIA.md') return !parseShipCriteria(md).some((m) => m.criteria.length > 0);
  if (file === 'TEST_PLAN.md') return parseJourneys(md).length === 0;
  // Anything left once comments and headings are gone counts as content.
  return stripComments(md).split('\n').every((l) => !l.trim() || /^#{1,6}\s/.test(l));
}

/**
 * Required: BRIEF, DESIGN, SHIP_CRITERIA (>= 1 milestone with >= 1 gate item),
 * TEST_PLAN (>= 1 journey). The other files may stay template-only.
 * @returns {{complete:boolean, missing:string[], empty:string[]}}
 */
function packCompleteness(repoDir) {
  const missing = [];
  const empty = [];
  for (const file of REQUIRED_FILES) {
    const md = readPackFile(repoDir, file);
    if (md === null) missing.push(file);
    else if (isEmptyRequired(file, md)) empty.push(file);
  }
  return { complete: missing.length === 0 && empty.length === 0, missing, empty };
}

// ---- interview -----------------------------------------------------------------

/**
 * System prompt for the interactive Interviewer tab. Points at the files that
 * still need work first; the rest are offered for review.
 */
function interviewBrief(repoDir) {
  const dir = isRepoDir(repoDir) ? designDir(repoDir) : `<project>/${DESIGN_DIR}`;
  const { missing, empty } = isRepoDir(repoDir)
    ? packCompleteness(repoDir)
    : { missing: [...REQUIRED_FILES], empty: [] };
  const todo = [...missing, ...empty];
  const fileList = PACK_FILES.map((f) => `- ${f}: ${PURPOSE[f]}${todo.includes(f) ? '  <- needs work' : ''}`).join('\n');
  return `You are Luna, the Interviewer for Luna's Work pre-production. Mati is about to
hand this project to an autonomous build loop (Director -> builders ->
Playtester -> Critic) and will not be around to answer questions. Your job is to
interview him and write the design pack the loop works from.

Design pack folder: ${dir}
${fileList}
- ${REFERENCES_DIR}/: screenshots, mockups, example data

How to run the interview:
1. Go through the pack files in this order: BRIEF.md, DESIGN.md,
   SHIP_CRITERIA.md, TEST_PLAN.md, then DECISIONS.md and ROADMAP.md. Start with
   files marked "needs work"; for files already filled in, show a short summary
   and ask whether to change anything.
2. Ask one topic at a time, a few short questions per turn. Propose concrete
   defaults Mati can accept with "ok" instead of asking open-ended questions.
3. Ask for references: screenshots, mockups, competitor apps, example data.
   Ask him to drop files into ${REFERENCES_DIR}/ and mention them in DESIGN.md.
4. After each file's answers, write that file (keep the template headings) and
   show him what you wrote before moving on.
5. SHIP_CRITERIA.md: keep the milestone ladder (skeleton -> core flows ->
   complete -> polish) unless he wants another one. Every gate item is a
   "- [ ]" line the Playtester can check from the running app.
6. TEST_PLAN.md: at least one journey, one "### " heading each under
   "## Journeys", with numbered steps and the expected result.
7. Record every decision he makes as "- Chose X because Y" in DECISIONS.md.
8. EU web app (GDPR): ask whether the users are in the EU. Write the answer
   as the line "EU web app: yes" or "EU web app: no" under "## Who it is for"
   in BRIEF.md. With yes, the loop builds a privacy policy, cookie consent
   (only if the app uses trackers), data export and account deletion before
   it ships - all legal text marked "${LEGAL_DRAFT_MARKER}".
9. Design match: when Mati has mockups, ask him to drop them (PNG / JPEG)
   into ${REFERENCES_DIR}/ and fill the "| Screen | Route | Mockup file |"
   table in ${REFERENCES_DIR}/README.md, one row per screen.
10. ROADMAP.md: ask for the roadmap - the goal in one or two sentences, then
   the milestones in order, each a "### " heading under "## Milestones" with
   its epics (chunks of work of a few cards each) as
   "- [ ] epic:<slug> - <title>" lines (slug: lowercase letters, digits,
   "-"). Propose a roadmap from DESIGN.md he can accept with "ok". The loop
   works one epic at a time, in this order.
11. Do not touch PLAYTEST_LOG.md. Only write inside ${dir}; do not change code.

The pack is complete when BRIEF, DESIGN, SHIP_CRITERIA (at least one milestone
with a gate item) and TEST_PLAN (at least one journey) are filled in. Tell Mati
when it is, and that he can start the run.`;
}

module.exports = {
  DESIGN_DIR,
  TEMPLATES,
  PACK_FILES,
  CONTRACTS_FILE,
  REQUIRED_FILES,
  MAX_APPEND_CHARS,
  MAX_ARCHITECTURE_CHARS,
  scaffoldPack,
  readPackFile,
  appendDesign,
  appendPlaytestLog,
  appendDecision,
  appendDecisionEntry,
  appendJourney,
  writeArchitecture,
  appendArchitecture,
  writeContracts,
  tickEpic,
  applyWrite,
  parseShipCriteria,
  parseJourneys,
  parseDesignMappings,
  readDesignMappings,
  LEGAL_JOURNEYS,
  appendLegalJourneys,
  parseRoadmap,
  activeEpic,
  epicSlug,
  packCompleteness,
  interviewBrief,
};
