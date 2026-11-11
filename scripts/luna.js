#!/usr/bin/env node
// ============================================================================
// LunaCore - `luna` command line: memory search without the app
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, phase 1.
//
//   node scripts/luna.js memory search "worktree junction"
//   node scripts/luna.js memory list | status | enable | disable
//   node scripts/luna.js memory import-auto        Claude Code auto-memory -> mirror
//   node scripts/luna.js memory eval golden.json   recall of a golden question set
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

const { projectFromRepoKey, GLOBAL } = require('../src/memoryrecord');
const { scan } = require('../src/memorystore');
const { createIndex, DEFAULT_LIMIT } = require('../src/memoryindex');
const { importAutoMemory, autoMemoryDir } = require('../src/memoryimport');
const { setEnabled, readEnabled } = require('../src/memoryprojects');
const { localStatus, memoryPaths } = require('../src/memorysync');
const { createRepoKeys } = require('../src/missionrepokey');
const { machineName } = require('../src/missionledgersync');

const USAGE = `Usage: node scripts/luna.js memory <command> [options]

  search <question>     search memories        [--limit n] [--only] [--json]
  list                  list memories          [--all]
  status                counts, broken files, sync health per PC
  enable | disable      switch memory on/off for the project
  import-auto           import Claude Code auto-memory   [--from <folder>] [--force]
  eval <golden.json>    recall@k of [{"q": "...", "expect": "<id>"}]   [--limit n]

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

const COMMANDS = {
  search: cmdSearch,
  list: cmdList,
  status: cmdStatus,
  enable: (ctx) => cmdEnable(ctx, true),
  disable: (ctx) => cmdEnable(ctx, false),
  'import-auto': cmdImportAuto,
  eval: cmdEval,
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
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [area, command, ...rest] = positionals;
  if (values.help || area !== 'memory' || !Object.hasOwn(COMMANDS, command)) {
    out(USAGE);
    return values.help ? 0 : 1;
  }
  const configDir = resolveConfigDir(values.dir);
  COMMANDS[command]({ configDir, dir: memoryPaths(configDir).dir, project: resolveProject(values.project), values, positionals: rest });
  return process.exitCode || 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof UsageError ? err.message : `failed: ${(err && err.message) || err}`}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, resolveConfigDir, installedConfigDir };
