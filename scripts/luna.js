#!/usr/bin/env node
// ============================================================================
// LunaCore - `luna` command line: memory search without the app
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 1.
//
//   node scripts/luna.js memory search "worktree junction"
//   node scripts/luna.js memory list | status | enable | disable
//   node scripts/luna.js memory import-auto        Claude Code auto-memory -> mirror
//   node scripts/luna.js memory card               the project card a new tab gets
//   node scripts/luna.js memory eval golden.json   recall of a golden question set
//   node scripts/luna.js memory inbox | approve <id> | reject <id>
//   node scripts/luna.js memory capture <transcript.jsonl>   what capture would keep
//   node scripts/luna.js memory review | verify <id> | retire <id>   confirmed memories that need a look
//   node scripts/luna.js memory stats              what capture proposed, what was approved, what is read
//   node scripts/luna.js memory notes [--since <tag|date>]   what the memory gained and lost since a release
//
// It reads and writes the same files as the app (the mirror under
// <config>/memory). The app is what syncs them: a memory written here is
// pushed by the next sync of a running LunaCore.
//
// Which config folder: --dir, then LUNA_CONFIG_DIR, then the folder the app
// itself uses. The app decides by app.isPackaged (src/paths.js resolveUserDir):
// `npm start` from a clone keeps its memories in the clone's config/, an
// installed LunaCore in %APPDATA%\LunaCore\config (or the platform's
// equivalent). A plain node script cannot know which of the two Mati runs, so:
// this clone's config/ when the script runs from a git clone whose mirror holds
// memories, else the installed folder if it exists, else this clone's config/.
// When both folders hold memories, one stderr line names the one used and the
// other (--dir picks explicitly).
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, promisify } = require('node:util');
const { execFile } = require('node:child_process');

const { projectFromRepoKey, splitKey, GLOBAL } = require('../src/memoryrecord');
const { scan, writeRecord } = require('../src/memorystore');
const { listInbox, approve, reject } = require('../src/memoryinbox');
const { extractPiece, droppedEvents } = require('../src/memorycapture');
const { sourceNotes } = require('../src/memoryextract');
const { runJob } = require('../src/missionrunner');
const { createIndex, DEFAULT_LIMIT } = require('../src/memoryindex');
const { createEmbedder, createVectorStore, vectorsPath } = require('../src/memoryembed');
const { importAutoMemory, autoMemoryDir } = require('../src/memoryimport');
const { setEnabled, readEnabled } = require('../src/memoryprojects');
const { localStatus, memoryPaths } = require('../src/memorysync');
const { cardFor, MAX_CARD_CHARS } = require('../src/memorycard');
const { saveNote } = require('../src/memorynote');
const { createRepoKeys, findRepo } = require('../src/missionrepokey');
const { createLog, logPath, captureStats, usage, rejectedTitles, decisionEvent, memoryNotes, DAY_MS, USEFULNESS_BANDS } = require('../src/memorylog');
const { cardSessions, cardSessionLines } = require('../src/memoryuse');
const { reviewList, verify, retire } = require('../src/memoryreview');
const { machineName } = require('../src/missionledgersync');

const USAGE = `Usage: node scripts/luna.js memory <command> [options]

  search <question>     search memories        [--limit n] [--only] [--json] [--keyword]
                        (by meaning when LM Studio serves an embedding model; --keyword = keywords only)
  list                  list memories          [--all]
  status                counts, broken files, sync health per PC
  enable | disable      switch memory on/off for the project
  import-auto           import Claude Code auto-memory   [--from <folder>] [--force]
  card                  the project card a new tab gets, and its size
  eval <golden.json>    recall@k of [{"q": "...", "expect": "<id>"}]   [--limit n] [--keyword]
  inbox                 memories that wait for approval, most useful first
  approve | reject <id> approve or delete one of them
  capture <transcript>  run the extractor over a Claude Code transcript   [--save]
                        (one small-model call; without --save nothing is written)
  review                confirmed memories that are stale, name a missing file, or were reported wrong
  verify | retire <id>  say one of them is still true, or delete it on every PC
  stats                 approval rate of captured memories, per usefulness band, and how often memories are read   [--days n]
  notes                 markdown list of memories confirmed, superseded, archived and retired, titles only
                        [--since <tag|YYYY-MM-DD>] [--all]   default: the latest v* tag; tags are read
                        from the repository of the current folder, whatever --project says

  --project <host/owner/repo>   default: the repository of the current folder
  --dir <config folder>         default: LUNA_CONFIG_DIR, else this clone's config/ when its memory
                                folder has memories, else an installed LunaCore's, else this clone's
`;

const out = (text = '') => process.stdout.write(`${text}\n`);

class UsageError extends Error {}

/** The repository this script lies in, and its config/ (what `npm start` uses: src/paths.js BUNDLED_DIR). */
const REPO_ROOT = path.join(__dirname, '..');
const CLONE_CONFIG_DIR = path.join(REPO_ROOT, 'config');

/**
 * The per-user data folder of an installed LunaCore (Electron's userData + /config).
 * @param {{env?: object, home?: string, platform?: string}} [where] injectable for tests
 */
function installedConfigDir({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const base =
    platform === 'win32'
      ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'LunaCore', 'config');
}

/** Whether a config folder's memory mirror holds at least one valid memory. */
const hasMemories = (configDir) => scan(memoryPaths(configDir).dir).records.length > 0;

/**
 * The config folder the CLI works on (see the header comment for the order).
 * @param {string|undefined} flag the --dir value
 * @param {{env?: object, installed?: string, clone?: string, isClone?: boolean,
 *   warn?: (line: string) => void}} [opts] injectable for tests:
 *   installed = an installed LunaCore's folder; clone = this clone's config/;
 *   isClone = whether the script runs from a git checkout; warn = one stderr line
 * @returns {string} an absolute path
 */
function resolveConfigDir(flag, opts = {}) {
  const {
    env = process.env,
    installed = installedConfigDir({ env }),
    clone = CLONE_CONFIG_DIR,
    isClone = fs.existsSync(path.join(REPO_ROOT, '.git')),
    warn = (line) => process.stderr.write(`${line}\n`),
  } = opts;
  if (flag) return path.resolve(flag);
  if (env.LUNA_CONFIG_DIR) return path.resolve(env.LUNA_CONFIG_DIR);
  const cloneDir = path.resolve(clone);
  const installedDir = path.resolve(installed);
  const cloneHas = hasMemories(cloneDir);
  const chosen = isClone && cloneHas ? cloneDir : fs.existsSync(installedDir) ? installedDir : cloneDir;
  const other = chosen === cloneDir ? installedDir : cloneDir;
  const has = (dir) => (dir === cloneDir ? cloneHas : hasMemories(dir));
  if (other !== chosen && has(chosen) && has(other)) {
    warn(`note: memories in ${chosen} (used) and in ${other} (not used); --dir picks one`);
  }
  return chosen;
}

function resolveProject(flag) {
  if (flag) {
    const project = projectFromRepoKey(flag);
    if (!project) throw new UsageError(`not a project key (host/owner/repo): ${flag}`);
    return project;
  }
  return projectFromRepoKey(createRepoKeys().resolve(process.cwd()).key);
}

function needProject(project) {
  if (!project) throw new UsageError('this folder is not a repository with an origin remote; pass --project host/owner/repo');
  return project;
}

/**
 * The search of this PC: by meaning and keywords when LM Studio serves an
 * embedding model (src/memoryembed.js), by keywords otherwise or with --keyword.
 * @returns {Promise<{search: (query: string, opts: object) => Promise<object[]>, mode: string}>}
 */
async function openSearch({ dir, configDir, values }) {
  const { records, invalid } = scan(dir);
  if (invalid.length) process.stderr.write(`warning: ${invalid.length} file(s) are not valid memories (see "memory status")\n`);
  if (values.keyword) {
    const index = createIndex(records);
    return { search: async (query, opts) => index.search(query, opts), mode: 'keyword' };
  }
  // The embedder's own state lines are replaced by the one `mode` line below.
  let reason = '';
  const embedder = createEmbedder({
    log: (line) => {
      reason = line.replace(/^\[memory\] /, '');
    },
  });
  const store = createVectorStore({ file: vectorsPath(configDir), embedder });
  const vectors = store.prepare(records);
  await store.ready();
  const index = createIndex(records, { vectors });
  // The cache can hold vectors while no model answers: then the search is keywords only.
  const model = await embedder.model();
  const hybrid = Boolean(model) && model === store.status().model && vectors.size > 0;
  return {
    search: async (query, opts) => index.search(query, { ...opts, vector: await store.queryVector(query) }),
    mode: hybrid ? `meaning + keyword (${model}, ${vectors.size} of ${records.length} memories embedded)` : `keyword (${/ off/.test(reason) ? reason : 'no memory is embedded'})`,
  };
}

const verifiedNote = (hit) => (hit.last_verified ? `verified ${hit.last_verified}` : hit.confidence === 'confirmed' ? 'never re-verified' : 'NOT VERIFIED');

function printHits(hits) {
  if (!hits.length) return out('No memory matches.');
  hits.forEach((hit, i) => {
    out(`${i + 1}. [${hit.type}] ${hit.title}`);
    out(`   ${hit.project}/${hit.id}`);
    out(`   ${hit.confidence}, created ${hit.created}, ${verifiedNote(hit)}${hit.source ? `, source: ${hit.source}` : ''}`);
    out(`   ${hit.snippet}`);
    if (hit.links.length) out(`   see also: ${hit.links.join(', ')}`);
  });
}

async function cmdSearch({ configDir, dir, project, values, positionals }) {
  const question = positionals.join(' ').trim();
  if (!question) throw new UsageError('search needs a question');
  const limit = values.limit ? Number.parseInt(values.limit, 10) : DEFAULT_LIMIT;
  const { search, mode } = await openSearch({ dir, configDir, values });
  const hits = await search(question, { project, limit, only: values.only ? needProject(project) : null });
  if (values.json) return out(JSON.stringify(hits, null, 2));
  printHits(hits);
  out(`-- search: ${mode}`);
}

function cmdList({ dir, project, values }) {
  const { records } = scan(dir);
  const shown = values.all || !project ? records : records.filter(([, r]) => r.project === project || r.project === GLOBAL);
  for (const [key, r] of shown) out(`${key}  [${r.type}, ${r.confidence}]  ${r.title}`);
  out(`${shown.length} of ${records.length} memories`);
}

const ago = (ms, now) => {
  const hours = Math.round((now - ms) / 3600000);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

function cmdStatus({ configDir }) {
  const now = Date.now();
  const status = localStatus(configDir, machineName(os.hostname()), now);
  out(`Mirror:   ${status.dir}`);
  out(`Memories: ${status.count}`);
  out(`Switched on for: ${status.enabled.length ? status.enabled.join(', ') : '(no project)'}`);
  for (const bad of status.invalid) out(`BROKEN (sync is paused until fixed): ${bad.file} - ${bad.error}`);
  for (const file of status.ignored) out(`ignored (not a memory by name or place, never synced): ${file}`);
  for (const key of status.blocked) out(`HELD BACK by the secret scanner (not synced): ${key}`);
  if (!status.machines.length) out('Sync health: no PC has synced memory yet.');
  for (const m of status.machines) {
    out(`Sync health: ${m.machine}${m.self ? ' (this PC)' : ''} - last synced ${ago(m.at, now)}, ${m.count} memories${m.silent ? '  <-- SILENT TOO LONG' : ''}`);
  }
}

function cmdEnable({ configDir, project }, on) {
  const list = setEnabled(memoryPaths(configDir).projects, needProject(project), on);
  out(`Memory ${on ? 'on' : 'off'} for ${project}. Switched on: ${list.length ? list.join(', ') : '(no project)'}`);
}

function cmdImportAuto({ configDir, dir, project, values }) {
  needProject(project);
  const from = values.from ? path.resolve(values.from) : autoMemoryDir(process.cwd(), os.homedir());
  if (!fs.existsSync(from)) throw new UsageError(`no auto-memory folder at ${from}`);
  const projectsFile = memoryPaths(configDir).projects;
  if (!readEnabled(projectsFile).includes(project)) {
    setEnabled(projectsFile, project, true);
    out(`Memory switched on for ${project}.`);
  }
  const { imported, kept, failed } = importAutoMemory({ from, dir, project, force: Boolean(values.force) });
  for (const key of imported) out(`imported  ${key}`);
  for (const key of kept) out(`kept      ${key} (already in the mirror; --force overwrites)`);
  for (const f of failed) out(`FAILED    ${f.file}: ${f.error}`);
  out(`${imported.length} imported, ${kept.length} kept, ${failed.length} failed -> ${dir}`);
  if (failed.length) process.exitCode = 1;
}

/** The project card a tab of this project would get (phase 3), with its size against the budget. */
function cmdCard({ configDir, project }) {
  needProject(project);
  if (!readEnabled(memoryPaths(configDir).projects).includes(project)) {
    out(`Memory is switched off for ${project}: its tabs get no card. ("memory enable" switches it on.)`);
    return;
  }
  const card = cardFor(configDir, project, machineName(os.hostname()));
  if (!card) return out(`No confirmed memory and no recent "where we stopped" note for ${project} yet: its tabs get no card.`);
  out(card.text);
  out();
  const note = card.note ? ' + the "where we stopped" note' : '';
  out(`-- ${card.shown} of ${card.total} confirmed memories${note}, ${card.chars} characters, about ${card.tokens} tokens (budget ${MAX_CARD_CHARS} characters)`);
}

async function cmdEval({ configDir, dir, project, values, positionals }) {
  const file = positionals[0];
  if (!file) throw new UsageError('eval needs a golden file');
  const golden = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!Array.isArray(golden) || !golden.every((g) => g && typeof g.q === 'string' && typeof g.expect === 'string')) {
    throw new UsageError('the golden file must be [{"q": "...", "expect": "<memory id>"}]');
  }
  const limit = values.limit ? Number.parseInt(values.limit, 10) : DEFAULT_LIMIT;
  const { search, mode } = await openSearch({ dir, configDir, values });
  out(`search: ${mode}`);
  let found = 0;
  let first = 0;
  for (const { q, expect } of golden) {
    const rank = (await search(q, { project, limit })).findIndex((h) => h.id === expect) + 1;
    if (rank) found++;
    if (rank === 1) first++;
    else out(`${rank ? `rank ${rank}` : 'MISS  '}  ${expect}  <-  ${q}`);
  }
  const pct = (n) => (golden.length ? `${Math.round((100 * n) / golden.length)}%` : 'n/a');
  out(`recall@${limit}: ${found}/${golden.length} (${pct(found)}), top hit: ${first}/${golden.length} (${pct(first)})`);
}

const today = () => new Date().toISOString().slice(0, 10);

/** The extractor's usefulness score as shown: "72%", or "?" when unknown. */
const scoreText = (usefulness) => (Number.isInteger(usefulness) ? `${usefulness}%` : '?');

/** Phase 4: the memories that wait for approval, the most useful first (listInbox's order). */
function cmdInbox({ dir }) {
  const { items, total } = listInbox(dir);
  if (!total) return out('The inbox is empty.');
  for (const item of items) {
    out(`[${item.type}] ${item.title}  (usefulness ${scoreText(item.usefulness)})`);
    out(`   ${item.key}`);
    out(`   created ${item.created}${item.source ? `, ${item.source}` : ''}${item.duplicates ? `, +${item.duplicates} duplicate(s)` : ''}`);
    if (item.project === GLOBAL) out("   GLOBAL: approving puts it on every project's card");
    else if (item.suggestedGlobal) out('   suggested as global by the extractor (Make global in the HUD inbox)');
    if (item.outside) out(`   the session read ${item.outside} outside source(s) (web or MCP): check the text before approving`);
    for (const old of item.supersedes) out(`   would replace: ${old.id} (${old.title})`);
    if (item.similar) out(`   looks like the confirmed memory ${item.similar.key}`);
  }
  out(`${total} waiting`);
}

/** A key as typed: a full key, or a bare id of this project or of global. */
function resolveKey(dir, project, wanted) {
  if (!wanted) throw new UsageError('give the id or the key of a memory (see "memory inbox")');
  if (splitKey(wanted)) return wanted;
  const waiting = new Set(listInbox(dir).items.map((i) => i.key));
  const key = [project ? `${project}/${wanted}` : null, `${GLOBAL}/${wanted}`].find((k) => k && waiting.has(k));
  if (!key) throw new UsageError(`no waiting memory with the id ${wanted}`);
  return key;
}

function cmdDecide({ configDir, dir, project, positionals }, accept) {
  const key = resolveKey(dir, project, positionals[0]);
  const log = createLog(logPath(configDir));
  // The same line the app writes: a rejected title goes back to the extractor.
  const decided = (ev, record) => log.add(decisionEvent(ev, record));
  const res = accept ? approve(dir, key, today(), decided) : reject(dir, key, decided);
  if (!res.ok) throw new UsageError(`${key}: ${res.reason}`);
  out(`${accept ? 'Approved' : 'Rejected'} ${key}${res.removed.length ? ` (and ${res.removed.length} duplicate(s) removed)` : ''}`);
}

const CAPTURE_TIMEOUT_MS = 180000;

/** Phase 4: what capture would keep from one transcript. Writes only with --save. */
async function cmdCapture({ configDir, dir, project, values, positionals }) {
  needProject(project);
  const file = positionals[0];
  if (!file) throw new UsageError('capture needs a transcript file (~/.claude/projects/<folder>/<session>.jsonl)');
  const log = createLog(logPath(configDir));
  const res = await extractPiece({
    notWanted: rejectedTitles(log.read(), project),
    text: fs.readFileSync(path.resolve(file), 'utf8'),
    project,
    dir,
    source: `captured from session ${path.basename(file, '.jsonl').slice(0, 8)} on ${machineName(os.hostname())}`,
    today: today(),
    run: ({ prompt }) => runJob({ prompt, model: 'haiku', lean: true, stdin: true, env: process.env, timeoutMs: CAPTURE_TIMEOUT_MS }),
  });
  if (!res.ok) throw new Error(`the extractor failed: ${res.reason}`);
  for (const record of res.records) {
    out(`[${record.type}] ${record.title}  (usefulness ${scoreText(record.usefulness)})`);
    out(`   ${record.project}/${record.id}${record.supersedes.length ? `  replaces: ${record.supersedes.join(', ')}` : ''}`);
    if (sourceNotes(record.source).suggestedGlobal) out('   suggested as global (filed under this project; Make global in the HUD inbox)');
    out(record.body.replace(/^/gm, '   '));
    out();
    if (values.save) {
      writeRecord(dir, record);
      log.add({ ev: 'proposed', key: `${record.project}/${record.id}`, type: record.type, usefulness: record.usefulness });
    }
  }
  if (values.save) for (const event of droppedEvents(res.rejected, project)) log.add(event);
  for (const r of res.rejected) out(`dropped (${r.reason}${r.usefulness === undefined ? '' : `, usefulness ${r.usefulness}%`}): ${r.title}`);
  if (res.status) {
    out(`Where we stopped: ${res.status}`);
    if (values.save) {
      const at = Math.floor(fs.statSync(path.resolve(file)).mtimeMs);
      const noted = saveNote(dir, { project, text: res.status, date: today(), session: path.basename(file, '.jsonl'), at });
      out(noted ? '   saved as the project note' : '   not saved: the project note comes from a later session (or could not be written)');
    }
  } else if (res.outside) {
    out('No "where we stopped" note: the session read outside content.');
  }
  const wrote = values.save ? 'saved to the inbox' : 'nothing written (--save writes them)';
  if (res.outside) out(`The session read ${res.outside} outside source(s) (web or MCP): the inbox asks to check these before approving.`);
  out(`${res.records.length} candidate(s), ${res.rejected.length} dropped (${res.reason}) - ${wrote}`);
}

/** Where the project of the current folder lies, for the anchor check: {<project>: folder}. */
function rootsHere(project) {
  const repo = project ? findRepo(process.cwd()) : null;
  return repo && resolveProject(null) === project ? { [project]: repo.root } : {};
}

const FLAG_TEXT = {
  disputed: (f) => `REPORTED WRONG by a session${f.note ? `: ${f.note}` : ''}`,
  anchor: (f) => `names a file that is gone: ${f.missing.join(', ')}`,
  stale: (f) => `not verified since ${f.since}`,
  unopened: (f) => `never opened in ${f.days} days (low priority)`,
};

/** Phase 5: the confirmed memories that need a look. */
function cmdReview({ configDir, dir, project }) {
  const roots = rootsHere(project);
  const { items, total } = reviewList({ records: scan(dir).records, today: today(), events: createLog(logPath(configDir)).read(), roots });
  if (!project || !roots[project]) out('(Run this inside a repository to also check the files its memories name.)');
  if (!total) return out('Nothing to review.');
  for (const item of items) {
    out(`[${item.type}] ${item.title}`);
    out(`   ${item.key}`);
    for (const flag of item.flags) out(`   ${FLAG_TEXT[flag.kind](flag)}`);
  }
  out(`${total} to review ("memory verify <id>" = still true, "memory retire <id>" = delete)`);
}

/** A confirmed memory as typed: a full key, or a bare id of this project or of global. */
function resolveConfirmed(dir, project, wanted) {
  if (!wanted) throw new UsageError('give the id or the key of a memory (see "memory review")');
  if (splitKey(wanted)) return wanted;
  const confirmed = new Set(scan(dir).records.filter(([, r]) => r.confidence === 'confirmed').map(([k]) => k));
  const key = [project ? `${project}/${wanted}` : null, `${GLOBAL}/${wanted}`].find((k) => k && confirmed.has(k));
  if (!key) throw new UsageError(`no confirmed memory with the id ${wanted}`);
  return key;
}

function cmdSettle({ configDir, dir, project, positionals }, keep) {
  const key = resolveConfirmed(dir, project, positionals[0]);
  const log = createLog(logPath(configDir));
  const res = keep ? verify(dir, key, today(), { log, roots: rootsHere(project) }) : retire(dir, key, { log });
  if (!res.ok) throw new UsageError(`${key}: ${res.reason}`);
  out(keep ? `Verified ${key}: still true as of ${today()}` : `Retired ${key}: deleted here, and on the other PCs after the next sync`);
}

const pct = (rate) => (rate === null ? 'n/a' : `${Math.round(rate * 100)}%`);
const MAX_USAGE_LINES = 15;

/** Phase 5: the approval rate of what capture proposed, and which memories are read. */
function cmdStats({ configDir, project, values }) {
  if (values.days !== undefined && !/^[1-9]\d{0,3}$/.test(values.days)) throw new UsageError('--days must be a whole number of days');
  const days = values.days ? Number.parseInt(values.days, 10) : 7;
  const events = createLog(logPath(configDir)).read();
  const since = Date.now() - days * DAY_MS;
  const stats = captureStats(events, { since, project: values.all ? null : project });
  out(`Last ${days} day(s)${project && !values.all ? `, ${project}` : ', every project'} (this PC's log):`);
  out(`  captures: ${stats.captures}, proposed: ${stats.proposed}, approved: ${stats.approved} (${stats.edited} after an edit), rejected: ${stats.rejected}`);
  out(`  approval rate: ${pct(stats.rate)} of ${stats.approved + stats.rejected} decided${stats.rate !== null && stats.rate < 1 / 3 ? '  <-- under a third: the extractor prompt needs work' : ''}`);
  for (const [type, c] of Object.entries(stats.byType)) out(`  ${type}: proposed ${c.proposed}, approved ${c.approved}, rejected ${c.rejected}, rate ${pct(c.rate)}`);
  // Calibration: a score that predicts the decision shows a rising approval rate band by band.
  out('  by usefulness score (decided):');
  for (const b of stats.bands) out(`    ${b.label.padStart(6)}: approved ${b.approved}, rejected ${b.rejected}`);
  if (stats.under.approved + stats.under.rejected) out(`    under ${USEFULNESS_BANDS[0].min}: approved ${stats.under.approved}, rejected ${stats.under.rejected}`);
  if (stats.unscored.approved + stats.unscored.rejected) out(`    no score: approved ${stats.unscored.approved}, rejected ${stats.unscored.rejected}`);
  const dropped = Object.entries(stats.dropped);
  if (dropped.length) out(`  dropped by the filter: ${dropped.map(([reason, n]) => `${reason} ${n}`).join(', ')}`);
  const read = [...usage(events, { since })].sort(([, a], [, b]) => b.opened - a.opened || b.found - a.found);
  out(`  memories read: ${read.length}`);
  for (const [key, u] of read.slice(0, MAX_USAGE_LINES)) out(`    found ${u.found}x, opened ${u.opened}x  ${key}`);
  // Section 9: does a session that starts with the card use the memory tools differently?
  out('  sessions by tab start (memory tool calls that succeeded):');
  for (const text of cardSessionLines(cardSessions(events, { since, project: values.all ? null : project }))) out(`    ${text}`);
}

// ---- notes: what the memory gained and lost since a release ------------------------

/** A tag name as typed: no path, glob, option or `..` (it is passed to git as a ref). */
const TAG_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
/**
 * Where git is started from. On Windows a bare `git` is looked up in the
 * working folder first, so a cloned repository holding a git.exe would run
 * it: git starts in Node's own folder and is pointed at the repository with -C.
 */
const GIT_START_DIR = path.dirname(process.execPath);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const GIT_TIMEOUT_MS = 15000;
const execFileAsync = promisify(execFile);

/**
 * The --since value: an ISO date (or date-time with a zone), a tag name, or
 * nothing (the latest v* tag). A date wins over a tag of the same spelling.
 * @param {string|undefined} value
 * @returns {{date: number, label: string}|{tag: string}|{latest: true}}
 */
function parseSince(value) {
  if (value === undefined) return { latest: true };
  if (ISO_DATE_RE.test(value)) {
    const day = value.slice(0, 10);
    // Date.parse rolls 2026-02-31 over to March: the calendar day alone must survive the round trip.
    const dayAt = Date.parse(`${day}T00:00:00Z`);
    const date = Date.parse(value.length === 10 ? `${day}T00:00:00Z` : value);
    const realDay = Number.isFinite(dayAt) && new Date(dayAt).toISOString().slice(0, 10) === day;
    if (realDay && Number.isFinite(date)) return { date, label: value };
    throw new UsageError(`--since: not a valid date: ${value}`);
  }
  if (TAG_RE.test(value)) return { tag: value };
  throw new UsageError('--since takes a tag name (v0.28.0) or an ISO date (2026-11-01)');
}

/** One git query about the repository of the current folder, without a shell; its first output line. */
async function gitLine(args) {
  const { stdout } = await execFileAsync('git', ['-C', process.cwd(), ...args], { cwd: GIT_START_DIR, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' });
  return String(stdout).split(/\r?\n/)[0].trim();
}

/** The moment --since names: a date as given, or the date of a tag (its tagger date, else its commit's). */
async function sinceMoment(value) {
  const since = parseSince(value);
  if (since.date !== undefined) return since;
  const tag = since.tag || (await gitLine(['for-each-ref', '--sort=-creatordate', '--count=1', '--format=%(refname:strip=2)', 'refs/tags/v*']));
  if (!tag) throw new UsageError('no v* tag in this repository; pass --since <tag|YYYY-MM-DD>');
  if (!TAG_RE.test(tag)) throw new UsageError(`unexpected tag name from git: ${tag}`);
  const when = await gitLine(['for-each-ref', '--count=1', '--format=%(creatordate:iso-strict)', `refs/tags/${tag}`]);
  const date = Date.parse(when);
  if (!when || !Number.isFinite(date)) throw new UsageError(`no tag named ${tag} in this repository`);
  return { date, label: tag };
}

/** Release notes of the memory: titles only, never a body. Writes nothing. */
async function cmdNotes({ configDir, dir, project, values }) {
  const { date, label } = await sinceMoment(values.since);
  const { records, invalid } = scan(dir);
  if (invalid.length) process.stderr.write(`warning: ${invalid.length} file(s) are not valid memories (see "memory status")\n`);
  const events = createLog(logPath(configDir)).read();
  process.stdout.write(memoryNotes({ records: records.map(([, r]) => r), events, since: date, project: values.all ? null : project, label }));
}

const COMMANDS = {
  search: cmdSearch,
  list: cmdList,
  status: cmdStatus,
  enable: (ctx) => cmdEnable(ctx, true),
  disable: (ctx) => cmdEnable(ctx, false),
  'import-auto': cmdImportAuto,
  card: cmdCard,
  eval: cmdEval,
  inbox: cmdInbox,
  approve: (ctx) => cmdDecide(ctx, true),
  reject: (ctx) => cmdDecide(ctx, false),
  capture: cmdCapture,
  review: cmdReview,
  verify: (ctx) => cmdSettle(ctx, true),
  retire: (ctx) => cmdSettle(ctx, false),
  stats: cmdStats,
  notes: cmdNotes,
};

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      project: { type: 'string' },
      from: { type: 'string' },
      limit: { type: 'string' },
      days: { type: 'string' },
      since: { type: 'string' },
      only: { type: 'boolean' },
      keyword: { type: 'boolean' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      save: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [area, command, ...rest] = positionals;
  if (values.help || area !== 'memory' || !Object.hasOwn(COMMANDS, command)) {
    out(USAGE);
    return values.help ? 0 : 1;
  }
  const configDir = resolveConfigDir(values.dir);
  const done = COMMANDS[command]({ configDir, dir: memoryPaths(configDir).dir, project: resolveProject(values.project), values, positionals: rest });
  // `capture`, `search` and `eval` call a model, `notes` asks git: they are asynchronous.
  return done && typeof done.then === 'function' ? done.then(() => process.exitCode || 0) : process.exitCode || 0;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof UsageError ? err.message : `failed: ${(err && err.message) || err}`}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main, resolveConfigDir, installedConfigDir, parseSince, UsageError, CLONE_CONFIG_DIR };
