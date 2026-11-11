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
const { runJob } = require('../src/missionrunner');
const { createIndex, DEFAULT_LIMIT } = require('../src/memoryindex');
const { importAutoMemory, autoMemoryDir } = require('../src/memoryimport');
const { setEnabled, readEnabled } = require('../src/memoryprojects');
const { localStatus, memoryPaths } = require('../src/memorysync');
const { cardFor, MAX_CARD_CHARS } = require('../src/memorycard');
const { createRepoKeys } = require('../src/missionrepokey');
const { machineName } = require('../src/missionledgersync');

const USAGE = `Usage: node scripts/luna.js memory <command> [options]

  search <question>     search memories        [--limit n] [--only] [--json]
  list                  list memories          [--all]
  status                counts, broken files, sync health per PC
  enable | disable      switch memory on/off for the project
  import-auto           import Claude Code auto-memory   [--from <folder>] [--force]
  card                  the project card a new tab gets, and its size
  eval <golden.json>    recall@k of [{"q": "...", "expect": "<id>"}]   [--limit n]
  inbox                 memories that wait for approval
  approve | reject <id> approve or delete one of them
  capture <transcript>  run the extractor over a Claude Code transcript   [--save]
                        (one small-model call; without --save nothing is written)

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

function loadIndex(dir) {
  const { records, invalid } = scan(dir);
  if (invalid.length) process.stderr.write(`warning: ${invalid.length} file(s) are not valid memories (see "memory status")\n`);
  return { records, index: createIndex(records) };
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

function cmdSearch({ dir, project, values, positionals }) {
  const question = positionals.join(' ').trim();
  if (!question) throw new UsageError('search needs a question');
  const limit = values.limit ? Number.parseInt(values.limit, 10) : DEFAULT_LIMIT;
  const hits = loadIndex(dir).index.search(question, { project, limit, only: values.only ? needProject(project) : null });
  if (values.json) out(JSON.stringify(hits, null, 2));
  else printHits(hits);
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

function cmdEval({ dir, project, values, positionals }) {
  const file = positionals[0];
  if (!file) throw new UsageError('eval needs a golden file');
  const golden = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!Array.isArray(golden) || !golden.every((g) => g && typeof g.q === 'string' && typeof g.expect === 'string')) {
    throw new UsageError('the golden file must be [{"q": "...", "expect": "<memory id>"}]');
  }
  const limit = values.limit ? Number.parseInt(values.limit, 10) : DEFAULT_LIMIT;
  const { index } = loadIndex(dir);
  let found = 0;
  let first = 0;
  for (const { q, expect } of golden) {
    const rank = index.search(q, { project, limit }).findIndex((h) => h.id === expect) + 1;
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

function cmdDecide({ dir, project, positionals }, accept) {
  const key = resolveKey(dir, project, positionals[0]);
  const res = accept ? approve(dir, key, today()) : reject(dir, key);
  if (!res.ok) throw new UsageError(`${key}: ${res.reason}`);
  out(`${accept ? 'Approved' : 'Rejected'} ${key}${res.removed.length ? ` (and ${res.removed.length} duplicate(s) removed)` : ''}`);
}

const CAPTURE_TIMEOUT_MS = 180000;

/** Phase 4: what capture would keep from one transcript. Writes only with --save. */
async function cmdCapture({ dir, project, values, positionals }) {
  needProject(project);
  const file = positionals[0];
  if (!file) throw new UsageError('capture needs a transcript file (~/.claude/projects/<folder>/<session>.jsonl)');
  const res = await extractPiece({
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
    out(record.body.replace(/^/gm, '   '));
    out();
    if (values.save) writeRecord(dir, record);
  }
  for (const r of res.rejected) out(`dropped (${r.reason}): ${r.title}`);
  const wrote = values.save ? 'saved to the inbox' : 'nothing written (--save writes them)';
  out(`${res.records.length} candidate(s), ${res.rejected.length} dropped (${res.reason}) - ${wrote}`);
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
      only: { type: 'boolean' },
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
  // `capture` calls a model and is the one asynchronous command.
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
