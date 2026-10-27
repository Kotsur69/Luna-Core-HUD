// ============================================================================
// LunaCore - Luna's Work research step (docs/LUNAS_WORK_PLAN.md, idea #14)
// ----------------------------------------------------------------------------
// When the design pack points at other products ("like Linear", "similar to
// Notion", a URL), a headless researcher fills design/references/ before the
// builders work from it:
//
//   detection  -> detectReferences / pendingReferences: pure scan of BRIEF.md
//                 and DESIGN.md. A reference whose design/references/<slug>/
//                 NOTES.md exists is done; the researcher's own "References
//                 (research ...)" sections in DESIGN.md are never scanned, so
//                 its cited sources do not count as new references.
//   researcher -> runResearch: one `claude -p --json-schema` call with
//                 WebSearch / WebFetch and a headless browser that can only
//                 navigate and take screenshots. No file tools: the model
//                 answers with JSON, screenshots land in a temp staging dir.
//   writes     -> referencePath / writeReferenceFile: THE WRITE CONFINEMENT.
//                 Only <repo>/design/references/<slug>/<file> is writable,
//                 never through a symlink or junction. NOTES.md (internal
//                 reference, sources cited) and the copied screenshots go
//                 there; a short summary is appended to DESIGN.md through
//                 lunasworkPack.appendReferences (append-only).
//   controller -> createResearchStep: lunaswork.js calls beforeDirecting()
//                 at the start of every iteration, so the step runs after
//                 pre-production, before the first Director and again
//                 whenever DESIGN.md gains a reference. It never blocks the
//                 run: a failure is one log line and a researcher entry in
//                 the run report's model choices, then the run goes on.
//
// runResearch always resolves, never rejects.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pack = require('./lunasworkPack');
const { pickModel } = require('./lunasworkRules');
const { parsePlannerOutput } = require('./orchestraPlan');
const { execClaude } = require('./lunasworkCritic');
const { checkCwd } = require('./projects');

const REFERENCES_DIR = 'references';
const NOTES_FILE = 'NOTES.md';
const SCANNED_FILES = ['BRIEF.md', 'DESIGN.md'];
const RESEARCH_BUDGET_USD = 2;
const RESEARCH_TIMEOUT_MS = 15 * 60 * 1000;
const FALLBACK_MODEL = 'sonnet';

const MAX_DETECTED = 20;
// References per researcher call; the rest wait for the next iteration.
const MAX_PER_CALL = 5;
const MAX_NAME_CHARS = 60;
const MAX_URL_CHARS = 500;
const MAX_LIST = 12;
const MAX_ITEM_CHARS = 400;
const MAX_NOTES_CHARS = 8000;
const MAX_SOURCES = 10;
const MAX_SCREENSHOTS = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Screenshots per reference end up committed with the repo: keep them small.
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
// Windows device names: a file or folder called CON / NUL / COM1 ... is never a file.
const RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const MAX_FILE_CHARS = 80;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const IMAGE_EXT = /\.(png|jpe?g)$/i;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

// The browser: Playwright MCP, headless, its screenshots in the staging dir.
const BROWSER_SERVER = 'playwright';
const BROWSER_PACKAGE = '@playwright/mcp@latest';
const BROWSER_TOOLS = [`mcp__${BROWSER_SERVER}__browser_navigate`, `mcp__${BROWSER_SERVER}__browser_take_screenshot`];
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
// Denied by name on top of `--tools`: no repo reads, no writes, no shell, no sub-agents.
const DENIED_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Task', 'Agent'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
// One line, no control characters, no HTML comment markers (NOTES.md is markdown).
const oneLine = (v, max) =>
  typeof v === 'string'
    ? v.replace(/<!--|-->/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
const block = (v, max) =>
  typeof v === 'string'
    ? v.replace(/\r\n/g, '\n').replace(/<!--|-->/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max)
    : '';

// ---- detection (pure) ------------------------------------------------------------

// The phrase is matched case by case (no `i` flag), so the name must start
// with a capital or a digit: "like Linear" counts, "like this" does not.
const PHRASE = String.raw`(?:[Ll]ike|[Ss]imilar to|[Ii]nspired by|[Ii]n the style of|[Mm]odell?ed (?:on|after)|[AaÀà] la)`;
// A name starts with a capital letter: "like 2 columns" is not a product.
const NAME = String.raw`[A-Z][\w.&+'-]*(?:[ \t]+[A-Z0-9][\w.&+'-]*){0,3}`;
const PHRASE_RE = new RegExp(String.raw`\b${PHRASE}[ \t]+(?:"([^"\n]{2,${MAX_NAME_CHARS}})"|(${NAME}))`, 'g');
// The word right before a match, read from a short window (no regex prefix: an
// optional `\S+` before the phrase backtracks quadratically on long tokens).
const wordBefore = (text, index) => (text.slice(Math.max(0, index - 40), index).match(/(\S+)[ \t]+$/) || [])[1] || '';
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"'`]+/gi;
// "I would like Mati to ..." is a wish, not a product reference.
const WISH_WORDS = new Set(['would', "i'd", "we'd", "you'd", "they'd"]);
const NOT_NAMES = new Set(['this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they', 'mati', 'luna', 'before', 'above', 'below', 'so']);
const LOCAL_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/i;
// The researcher's own summary sections in DESIGN.md (lunasworkPack.appendReferences).
const OWN_SECTION_RE = /^##\s+References \(research\b/;

/** A folder-safe slug, or null. */
function slugify(text) {
  const s = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/-+$/, '');
  return SLUG_RE.test(s) ? s : null;
}

/** The text a scan may look at: comments, code fences and the researcher's own sections removed. */
function scannable(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  let skip = false;
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (/^#{1,2}\s/.test(line)) skip = OWN_SECTION_RE.test(line);
    if (!skip && !fence) out.push(line);
  }
  return out.join('\n');
}

function cleanName(raw) {
  const name = String(raw || '')
    .replace(/[.,;:!?'-]+$/, '')
    .replace(/'s$/i, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim();
  if (!name || name.length > MAX_NAME_CHARS || NOT_NAMES.has(name.toLowerCase())) return null;
  return name;
}

function urlReference(raw, file) {
  const text = raw.replace(/[.,;:!?]+$/, '').slice(0, MAX_URL_CHARS);
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, '');
  if (!host || LOCAL_HOST_RE.test(url.hostname)) return null;
  const slug = slugify(host);
  return slug ? { slug, name: host, url: url.href, file, phrase: text } : null;
}

/**
 * Product references in one markdown text: "like X", "similar to X",
 * "inspired by X", "in the style of X", "modeled on X", "a la X" (a quoted
 * name works too), and http(s) URLs (local addresses are the app itself).
 * @param {string} md
 * @param {string} [file] the pack file it came from, kept on each reference
 * @returns {{slug:string, name:string, url:string|null, file:string|null, phrase:string}[]} first-seen order, unique slugs
 */
function detectReferences(md, file = null) {
  const text = scannable(md);
  const found = [];
  const seen = new Set();
  const urls = [];
  for (const m of text.matchAll(URL_RE)) urls.push({ index: m.index, ref: urlReference(m[0], file) });
  const phrases = [];
  // URLs blanked out first: a path segment is never read as a "like X" name.
  const blanked = text.replace(URL_RE, (u) => ' '.repeat(u.length));
  for (const m of blanked.matchAll(PHRASE_RE)) {
    if (WISH_WORDS.has(wordBefore(blanked, m.index).toLowerCase())) continue;
    const name = cleanName(m[1] || m[2]);
    const slug = name && slugify(name);
    if (slug) phrases.push({ index: m.index, ref: { slug, name, url: null, file, phrase: m[0].trim().slice(0, 120) } });
  }
  for (const { ref } of [...urls, ...phrases].sort((a, b) => a.index - b.index)) {
    if (!ref || seen.has(ref.slug) || found.length >= MAX_DETECTED) continue;
    seen.add(ref.slug);
    found.push(ref);
  }
  return found;
}

/** References in BRIEF.md + DESIGN.md of a repo, unique by slug. */
function packReferences(repoDir) {
  const seen = new Set();
  return SCANNED_FILES.flatMap((file) => detectReferences(pack.readPackFile(repoDir, file) || '', file)).filter((r) => {
    if (seen.has(r.slug)) return false;
    seen.add(r.slug);
    return true;
  });
}

function notesExist(repoDir, slug) {
  const target = referencePath(repoDir, `${slug}/${NOTES_FILE}`);
  try {
    return !!target && fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * The references that still need research: no NOTES.md yet and not in `skip`
 * (the slugs this controller already tried).
 * @param {string} repoDir
 * @param {Set<string>} [skip]
 */
function pendingReferences(repoDir, skip = new Set()) {
  return packReferences(repoDir).filter((r) => !skip.has(r.slug) && !notesExist(repoDir, r.slug));
}

// ---- write confinement -------------------------------------------------------------

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const referencesRoot = (repoDir) => path.join(path.resolve(repoDir), pack.DESIGN_DIR, REFERENCES_DIR);

/**
 * The absolute target of `<slug>/<file>` inside <repo>/design/references/,
 * or null for anything else: absolute paths, `..`, deeper paths, odd names.
 */
function referencePath(repoDir, rel) {
  if (typeof repoDir !== 'string' || !path.isAbsolute(repoDir) || typeof rel !== 'string') return null;
  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.length !== 2 || !SLUG_RE.test(parts[0]) || !FILE_RE.test(parts[1]) || parts[1].includes('..')) return null;
  if (parts.some((p) => RESERVED_RE.test(p))) return null;
  const root = referencesRoot(repoDir);
  const target = path.resolve(root, parts[0], parts[1]);
  return path.dirname(path.dirname(target)) === root ? target : null;
}

/**
 * The one writer of this module. Refuses any path outside design/references/
 * and any write through a symlink / junction on the way there.
 * @returns {{ok:boolean, error?:string}}
 */
function writeReferenceFile(repoDir, rel, data) {
  const target = referencePath(repoDir, rel);
  if (!target) return { ok: false, error: 'path outside design/references/' };
  const root = referencesRoot(repoDir);
  const chain = [path.dirname(root), root, path.dirname(target), target];
  const linked = () => chain.some(isLink);
  if (linked()) return { ok: false, error: 'link on the way to design/references/' };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Checked again after mkdir: a link created in between is still refused.
    if (linked()) return { ok: false, error: 'link on the way to design/references/' };
    fs.writeFileSync(target, data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errText(err).slice(0, 200) };
  }
}

// ---- the researcher call ---------------------------------------------------------------

const stringList = { type: 'array', items: { type: 'string' } };

const RESEARCH_SCHEMA = {
  type: 'object',
  required: ['references'],
  properties: {
    references: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'summary', 'strengths', 'screens', 'notes', 'sources', 'screenshots'],
        properties: {
          slug: { type: 'string' },
          summary: { type: 'string' },
          strengths: stringList,
          screens: {
            type: 'array',
            items: { type: 'object', required: ['name', 'description'], properties: { name: { type: 'string' }, description: { type: 'string' } } },
          },
          notes: { type: 'string' },
          sources: stringList,
          screenshots: {
            type: 'array',
            items: {
              type: 'object',
              required: ['file', 'caption', 'source'],
              properties: { file: { type: 'string' }, caption: { type: 'string' }, source: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

/**
 * argv for the headless researcher - never a shell string. The built-in tools
 * are cut down to WebSearch / WebFetch; the browser offers navigate and
 * screenshot only, and its files go to `stagingDir`.
 */
function buildResearchArgs({ model, stagingDir, budgetUsd = RESEARCH_BUDGET_USD }) {
  const browserArgs = [BROWSER_PACKAGE, '--headless', '--isolated', '--output-dir', stagingDir];
  const mcpConfig = { mcpServers: { [BROWSER_SERVER]: { type: 'stdio', command: 'npx', args: browserArgs } } };
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(RESEARCH_SCHEMA),
    '--model', model,
    '--tools', WEB_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(mcpConfig),
    '--allowedTools', [...WEB_TOOLS, ...BROWSER_TOOLS].join(','),
    '--disallowedTools', DENIED_TOOLS.join(','),
    '--max-budget-usd', String(budgetUsd),
    '--no-session-persistence',
  ];
}

function buildResearchPrompt(refs, brief) {
  const list = refs
    .map((r) => `- slug "${r.slug}": ${r.url || `"${r.name}"`} (from ${r.file || 'the design pack'}: "${oneLine(r.phrase, 120)}")`)
    .join('\n');
  return `You are the researcher for Luna's Work, an autonomous build loop. The design
pack of the product being built points at other products. Research each one so
the builders know what "like X" means. Internal reference only - never copy
text or assets into the product.

The product being built (BRIEF.md):
${brief || '(no brief)'}

References to research:
${list}

For each reference:
1. Use WebSearch / WebFetch to find the product's own pages, docs and good reviews.
2. Use browser_navigate + browser_take_screenshot for up to ${MAX_SCREENSHOTS} screenshots of
   its key screens (viewport, not full page). Give every screenshot a short
   unique filename like "<slug>-home.png" and report exactly that filename in "file".
3. Answer per reference with the slug given above:
   - summary: one or two sentences, what it is and why it is a reference here
   - strengths: what it does well that matters for this product
   - screens: the key screens and flows, name + what is on them / how they work
   - notes: anything else a builder should know (layout, tone, patterns), plain text
   - sources: every URL you used. Every claim needs a source; no source, no claim.
   - screenshots: file, caption, and the URL the screenshot shows
If a reference cannot be identified, leave it out of the answer.`;
}

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

/** A screenshot the researcher took: a real image file inside the staging dir, else null. */
function stagedImage(raw, stagingDir) {
  const name = oneLine(raw, 300);
  if (!name || !IMAGE_EXT.test(name)) return null;
  try {
    const root = fs.realpathSync.native(stagingDir);
    const file = fs.realpathSync.native(path.resolve(root, name));
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !IMAGE_EXT.test(file)) return null;
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MAX_IMAGE_BYTES && hasImageMagic(file) ? file : null;
  } catch {
    return null;
  }
}

function isWebUrl(u) {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}

const cleanUrls = (list) =>
  [...new Set((Array.isArray(list) ? list : []).map((u) => oneLine(u, MAX_URL_CHARS)).filter(isWebUrl))].slice(0, MAX_SOURCES);
const cleanList = (list) => (Array.isArray(list) ? list : []).map((s) => oneLine(s, MAX_ITEM_CHARS)).filter(Boolean).slice(0, MAX_LIST);

/** A safe, unique file name for a copied screenshot inside the reference folder. */
function imageName(file, used) {
  // The extension from the image check, so ".png" alone still ends in .png.
  const ext = file.match(IMAGE_EXT)[0].toLowerCase();
  const stem = path.basename(file).slice(0, -ext.length).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, MAX_FILE_CHARS - 10);
  const base = stem && !RESERVED_RE.test(stem) ? stem : `shot-${stem || 'image'}`.replace(/-+$/, '');
  let name = `${base}${ext}`;
  for (let i = 2; used.has(name); i += 1) name = `${base}-${i}${ext}`;
  used.add(name);
  return name;
}

function cleanScreenshots(list, stagingDir) {
  const used = new Set();
  return (Array.isArray(list) ? list : [])
    .filter(isObj)
    .map((s) => {
      const source = oneLine(s.source, MAX_URL_CHARS);
      return { src: stagedImage(s.file, stagingDir), caption: oneLine(s.caption, MAX_ITEM_CHARS), source: isWebUrl(source) ? source : null };
    })
    .filter((s) => s.src)
    .slice(0, MAX_SCREENSHOTS)
    .map((s) => ({ ...s, name: imageName(s.src, used) }));
}

/**
 * The trust boundary: the researcher's reply, per requested reference. A
 * slug nobody asked for and an entry without a single source are dropped.
 * @returns {{entries:object[], warnings:{code:string, slug?:string}[]}}
 */
function validateResearch(raw, refs, stagingDir) {
  const bySlug = new Map(refs.map((r) => [r.slug, r]));
  const entries = [];
  const warnings = [];
  for (const e of isObj(raw) && Array.isArray(raw.references) ? raw.references : []) {
    const slug = isObj(e) ? oneLine(e.slug, MAX_NAME_CHARS) : '';
    if (!bySlug.has(slug) || entries.some((x) => x.ref.slug === slug)) {
      warnings.push({ code: 'unknownSlug', slug });
      continue;
    }
    const sources = cleanUrls(e.sources);
    if (!sources.length) {
      warnings.push({ code: 'noSources', slug });
      continue;
    }
    entries.push({
      ref: bySlug.get(slug),
      summary: oneLine(e.summary, MAX_ITEM_CHARS),
      strengths: cleanList(e.strengths),
      screens: (Array.isArray(e.screens) ? e.screens : [])
        .filter(isObj)
        .map((s) => ({ name: oneLine(s.name, MAX_NAME_CHARS), description: oneLine(s.description, MAX_ITEM_CHARS) }))
        .filter((s) => s.name)
        .slice(0, MAX_LIST),
      notes: block(e.notes, MAX_NOTES_CHARS),
      sources,
      screenshots: cleanScreenshots(e.screenshots, stagingDir),
    });
  }
  return { entries, warnings };
}

const bullets = (items) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none found)');

/** NOTES.md of one reference. */
function formatNotes(entry, date) {
  const { ref } = entry;
  return `# ${ref.name} - reference notes

<!-- Written by the Luna's Work researcher on ${date}. Internal reference only:
     do not copy its text or assets into the product. -->

Referenced in ${ref.file || 'the design pack'}: "${oneLine(ref.phrase, 120)}"${ref.url ? `\nURL: ${ref.url}` : ''}

${entry.summary}

## What it does well

${bullets(entry.strengths)}

## Key screens and flows

${bullets(entry.screens.map((s) => `**${s.name}**${s.description ? `: ${s.description}` : ''}`))}

## Notes

${entry.notes || '(none)'}

## Screenshots

${bullets(entry.screenshots.map((s) => `![${s.caption || s.name}](${s.name})${s.source ? ` - source: ${s.source}` : ''}`))}

## Sources

${bullets(entry.sources)}
`;
}

/** One summary line per researched reference for the DESIGN.md section. */
const summaryLine = (entry) =>
  `**${entry.ref.name}** - ${entry.summary || 'see the notes'} (notes: design/${REFERENCES_DIR}/${entry.ref.slug}/${NOTES_FILE}; sources: ${entry.sources.slice(0, 3).join(', ')})`;

/** Writes the screenshots, then NOTES.md, of one entry. @returns {string|null} an error, null when written */
function writeEntry(repoDir, entry, date) {
  const kept = [];
  let bytes = 0;
  for (const shot of entry.screenshots) {
    let data;
    try {
      data = fs.readFileSync(shot.src);
    } catch {
      continue;
    }
    // Over the per-reference budget: the shot is left out, the notes still go in.
    if (bytes + data.length > MAX_REFERENCE_BYTES) continue;
    const res = writeReferenceFile(repoDir, `${entry.ref.slug}/${shot.name}`, data);
    if (!res.ok) return res.error;
    bytes += data.length;
    kept.push(shot);
  }
  // NOTES.md last: its presence marks the reference as done.
  const res = writeReferenceFile(repoDir, `${entry.ref.slug}/${NOTES_FILE}`, formatNotes({ ...entry, screenshots: kept }, date));
  return res.ok ? null : res.error;
}

/**
 * A reference the researcher could not identify ("like Button") gets a stub
 * NOTES.md, so it is not paid for again on every restart. Deleting the stub
 * asks for a new try.
 */
function writeStub(repoDir, ref, date) {
  const text = `# ${ref.name} - reference notes

<!-- Written by the Luna's Work researcher on ${date}. Delete this file to research it again. -->

Referenced in ${ref.file || 'the design pack'}: "${oneLine(ref.phrase, 120)}"

The researcher could not identify this as a product with sources; nothing was collected.
`;
  return writeReferenceFile(repoDir, `${ref.slug}/${NOTES_FILE}`, text).ok;
}

function cleanRequested(references) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(references) ? references : []) {
    if (!isObj(r) || typeof r.slug !== 'string' || !SLUG_RE.test(r.slug) || seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push({
      slug: r.slug,
      name: oneLine(r.name, MAX_NAME_CHARS) || r.slug,
      url: isWebUrl(r.url) ? r.url : null,
      file: SCANNED_FILES.includes(r.file) ? r.file : null,
      phrase: oneLine(r.phrase, 120),
    });
  }
  return out.slice(0, MAX_PER_CALL);
}

/**
 * One researcher pass over `references`. Writes design/references/<slug>/
 * and appends the DESIGN.md summary; never rejects.
 * @param {{repoDir:string, references:object[], model?:string, budgetUsd?:number, env?:object,
 *   runClaude?:Function, now?:()=>number, timeoutMs?:number, stagingRoot?:string, log?:Function}} opts
 * @returns {Promise<{ok:boolean, error?:string, detail?:string, written:string[], unidentified?:string[],
 *   warnings:object[], costUsd:number|null}>}
 */
async function runResearch(opts) {
  const o = isObj(opts) ? opts : {};
  const now = o.now || Date.now;
  let result = { ok: false, written: [], warnings: [], costUsd: null };
  const fail = (error, detail) => ({ ...result, ok: false, error, ...(detail ? { detail: oneLine(detail, 300) } : {}) });
  let stagingDir = null;
  try {
    if (!checkCwd(o.repoDir).ok) return fail('noRepo');
    const refs = cleanRequested(o.references);
    if (!refs.length) return fail('noReferences');
    stagingDir = fs.mkdtempSync(path.join(o.stagingRoot || os.tmpdir(), 'lw-research-'));
    const runner = typeof o.runClaude === 'function' ? o.runClaude : execClaude;
    const call = await runner({
      args: buildResearchArgs({ model: o.model || FALLBACK_MODEL, stagingDir, budgetUsd: o.budgetUsd }),
      prompt: buildResearchPrompt(refs, oneLine(pack.readPackFile(o.repoDir, 'BRIEF.md') || '', 4000)),
      // Not the repo: the researcher has no business there.
      cwd: stagingDir,
      env: o.env || process.env,
      timeoutMs: o.timeoutMs || RESEARCH_TIMEOUT_MS,
    });
    if (!isObj(call) || call.error) return fail((isObj(call) && call.error) || 'failed', isObj(call) ? call.detail : undefined);
    const parsed = parsePlannerOutput(call.stdout);
    if (!parsed.ok) return fail(parsed.error, parsed.detail);
    const { entries, warnings } = validateResearch(parsed.raw, refs, stagingDir);
    result = { ...result, costUsd: parsed.costUsd, warnings };
    const date = new Date(now()).toISOString().slice(0, 10);
    const written = [];
    for (const entry of entries) {
      const error = writeEntry(o.repoDir, entry, date);
      if (error) result = { ...result, warnings: [...result.warnings, { code: 'writeFailed', slug: entry.ref.slug, detail: error }] };
      else written.push(entry);
    }
    const answered = new Set(entries.map((e) => e.ref.slug));
    const unidentified = refs.filter((r) => !answered.has(r.slug) && writeStub(o.repoDir, r, date)).map((r) => r.slug);
    result = { ...result, written: written.map((e) => e.ref.slug), unidentified };
    if (!written.length) return fail('nothingWritten', result.warnings.map((w) => `${w.code} ${w.slug || ''}`.trim()).join(', '));
    const op = pack.appendReferences(written.map(summaryLine), date);
    const applied = op ? pack.applyWrite(o.repoDir, op) : { ok: false, error: 'empty summary' };
    if (!applied.ok) result = { ...result, warnings: [...result.warnings, { code: 'designNotUpdated', detail: applied.error }] };
    return { ...result, ok: true };
  } catch (err) {
    return fail('failed', errText(err));
  } finally {
    if (stagingDir) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch (err) {
        if (typeof o.log === 'function') o.log(`[lunaswork] research staging dir not removed: ${errText(err)}`);
      }
    }
  }
}

// ---- controller seam -----------------------------------------------------------------

/**
 * The step lunaswork.js runs at the start of every iteration. Each reference
 * is tried once per controller (a failed one is not retried every lap); one
 * with NOTES.md is never tried again.
 * @param {{research?:(opts:object)=>Promise<object>, logEvent:(text:string)=>void,
 *   logModel:(role:string, model:string, reason:string)=>void}} deps
 */
function createResearchStep(deps) {
  const tried = new Set();

  /** @returns {Promise<object|null>} the research result, null when nothing ran */
  async function beforeDirecting(run) {
    if (!deps || typeof deps.research !== 'function' || !run || !run.repoPath) return null;
    let refs;
    try {
      refs = pendingReferences(run.repoPath, tried).slice(0, MAX_PER_CALL);
    } catch (err) {
      deps.logEvent(`research: references not read (${errText(err).slice(0, 150)}) - going on`);
      return null;
    }
    if (!refs.length) return null;
    for (const r of refs) tried.add(r.slug);
    const pick = pickModel('researcher', run.models) || { model: FALLBACK_MODEL, reason: 'default' };
    const names = refs.map((r) => r.name).join(', ');
    let res;
    try {
      res = await deps.research({ repoDir: run.repoPath, runId: run.id, iteration: run.iteration, references: refs, model: pick.model });
    } catch (err) {
      res = { ok: false, error: 'failed', detail: errText(err) };
    }
    const r = isObj(res) ? res : { ok: false, error: 'failed' };
    const written = Array.isArray(r.written) ? r.written.length : 0;
    const outcome = r.ok
      ? `researched ${names}: ${written} into design/${REFERENCES_DIR}/`
      : `research of ${names} failed (${oneLine(r.error, 40) || 'failed'}) - the run went on without it`;
    // The model entry carries the outcome into the run report's model choices.
    deps.logModel('researcher', pick.model, `${pick.reason}; ${outcome}`);
    deps.logEvent(r.ok || !r.detail ? outcome : `${outcome}: ${oneLine(r.detail, 150)}`);
    return r;
  }

  return { beforeDirecting };
}

module.exports = {
  RESEARCH_SCHEMA,
  BROWSER_TOOLS,
  WEB_TOOLS,
  NOTES_FILE,
  MAX_PER_CALL,
  slugify,
  detectReferences,
  packReferences,
  pendingReferences,
  referencePath,
  writeReferenceFile,
  buildResearchArgs,
  buildResearchPrompt,
  validateResearch,
  formatNotes,
  runResearch,
  createResearchStep,
};
