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
//
// It reads and writes the same files as the app (the mirror under
// <config>/memory). The app is what syncs them: a memory written here is
// pushed by the next sync of a running LunaCore.
//
// Which config folder: --dir, then LUNA_CONFIG_DIR, then an installed
// LunaCore's folder if there is one, then this clone's config/.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('node:util');

const { projectFromRepoKey, splitKey, GLOBAL } = require('../src/memoryrecord');
const { scan, writeRecord } = require('../src/memorystore');
const { listInbox, approve, reject } = require('../src/memoryinbox');
const { extractPiece } = require('../src/memorycapture');
const { sourceNotes } = require('../src/memoryextract');
const { runJob } = require('../src/missionrunner');
const { createIndex, DEFAULT_LIMIT } = require('../src/memoryindex');
const { createEmbedder, createVectorStore, vectorsPath } = require('../src/memoryembed');
const { importAutoMemory, autoMemoryDir } = require('../src/memoryimport');
const { setEnabled, readEnabled } = require('../src/memoryprojects');
const { localStatus, memoryPaths } = require('../src/memorysync');
const { cardFor, MAX_CARD_CHARS } = require('../src/memorycard');
const { createRepoKeys, findRepo } = require('../src/missionrepokey');
const { createLog, logPath, captureStats, usage, rejectedTitles, DAY_MS } = require('../src/memorylog');
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
  inbox                 memories that wait for approval
  approve | reject <id> approve or delete one of them
  capture <transcript>  run the extractor over a Claude Code transcript   [--save]
                        (one small-model call; without --save nothing is written)
  review                confirmed memories that are stale, name a missing file, or were reported wrong
  verify | retire <id>  say one of them is still true, or delete it on every PC
  stats                 approval rate of captured memories and how often memories are read   [--days n]

  --project <host/owner/repo>   default: the repository of the current folder
  --dir <config folder>         default: LUNA_CONFIG_DIR, an installed LunaCore, this clone
`;

const out = (text = '') => process.stdout.write(`${text}\n`);

class UsageError extends Error {}

/** The per-user data folder of an installed LunaCore (Electron's userData + /config). */
function installedConfigDir() {
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'LunaCore', 'config');
}

function resolveConfigDir(flag) {
  if (flag) return path.resolve(flag);
  if (process.env.LUNA_CONFIG_DIR) return path.resolve(process.env.LUNA_CONFIG_DIR);
  const installed = installedConfigDir();
  return fs.existsSync(installed) ? installed : path.join(__dirname, '..', 'config');
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
  if (!card) return out(`No confirmed memory for ${project} yet: its tabs get no card.`);
  out(card.text);
  out();
  out(`-- ${card.shown} of ${card.total} confirmed memories, ${card.chars} characters, about ${card.tokens} tokens (budget ${MAX_CARD_CHARS} characters)`);
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

/** Phase 4: the memories that wait for approval, newest first. */
function cmdInbox({ dir }) {
  const { items, total } = listInbox(dir);
  if (!total) return out('The inbox is empty.');
  for (const item of items) {
    out(`[${item.type}] ${item.title}`);
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
  const decided = (ev, record) => log.add({ ev, key, type: record.type, ...(ev === 'rejected' ? { title: record.title } : {}) });
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
    out(`[${record.type}] ${record.title}`);
    out(`   ${record.project}/${record.id}${record.supersedes.length ? `  replaces: ${record.supersedes.join(', ')}` : ''}`);
    if (sourceNotes(record.source).suggestedGlobal) out('   suggested as global (filed under this project; Make global in the HUD inbox)');
    out(record.body.replace(/^/gm, '   '));
    out();
    if (values.save) {
      writeRecord(dir, record);
      log.add({ ev: 'proposed', key: `${record.project}/${record.id}`, type: record.type });
    }
  }
  for (const r of res.rejected) out(`dropped (${r.reason}): ${r.title}`);
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
  const dropped = Object.entries(stats.dropped);
  if (dropped.length) out(`  dropped by the filter: ${dropped.map(([reason, n]) => `${reason} ${n}`).join(', ')}`);
  const read = [...usage(events, { since })].sort(([, a], [, b]) => b.opened - a.opened || b.found - a.found);
  out(`  memories read: ${read.length}`);
  for (const [key, u] of read.slice(0, MAX_USAGE_LINES)) out(`    found ${u.found}x, opened ${u.opened}x  ${key}`);
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
  // `capture`, `search` and `eval` call a model and are asynchronous.
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

module.exports = { main, resolveConfigDir, installedConfigDir };
