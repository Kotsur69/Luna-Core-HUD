// ============================================================================
// LunaCore - import Claude Code auto-memory into the memory mirror (CLI)
// ----------------------------------------------------------------------------
// docs/untouched_docs/rag-stylememory.md, decision 16. Claude Code keeps
// hand-written facts per project and per machine in
//
//   ~/.claude/projects/<cwd with every non-alphanumeric as '-'>/memory/*.md
//
// (MEMORY.md is its index, not a memory). Importing them is the first content
// of the synced store. A memory that already exists in the mirror is KEPT as
// it is: it may have been edited or verified since, and the auto-memory copy
// is the older one. `force` overwrites.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { fromAutoMemory, keyOf } = require('./memoryrecord');
const { scan, writeRecord } = require('./memorystore');

const INDEX_FILE = 'MEMORY.md';
const MAX_FILE_BYTES = 64 * 1024;

/** Where Claude Code keeps the auto-memory of the project at `cwd`. */
function autoMemoryDir(cwd, home) {
  return path.join(home, '.claude', 'projects', path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'), 'memory');
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {{from: string, dir: string, project: string, force?: boolean}} opts
 *   from = an auto-memory folder, dir = the mirror, project = `host/owner/repo`
 * @returns {{imported: string[], kept: string[], failed: {file: string, error: string}[]}}
 *   imported / kept hold unit keys
 */
function importAutoMemory({ from, dir, project, force = false }) {
  const names = fs
    .readdirSync(from)
    .filter((n) => n.endsWith('.md') && n !== INDEX_FILE)
    .sort();
  const existing = new Set(scan(dir).records.map(([k]) => k));
  const imported = [];
  const kept = [];
  const failed = [];
  for (const name of names) {
    const file = path.join(from, name);
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) throw new Error('file-too-big');
      const res = fromAutoMemory(fs.readFileSync(file, 'utf8'), {
        fileId: path.basename(name, '.md'),
        project,
        fallbackDate: isoDate(stat.mtimeMs),
      });
      if (!res.record) throw new Error(res.error);
      const key = keyOf(res.record);
      if (existing.has(key) && !force) {
        kept.push(key);
        continue;
      }
      writeRecord(dir, res.record);
      existing.add(key);
      imported.push(key);
    } catch (err) {
      failed.push({ file: name, error: (err && (err.code || err.message)) || 'failed' });
    }
  }
  return { imported, kept, failed };
}

module.exports = { importAutoMemory, autoMemoryDir };
