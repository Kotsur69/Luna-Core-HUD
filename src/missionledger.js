// ============================================================================
// LunaCore - Mission Control: Claude spend per project (main process)
// ----------------------------------------------------------------------------
// Reads the local Claude Code transcripts (~/.claude/projects/<p>/<s>.jsonl
// and <p>/<s>/subagents/*.jsonl) and turns every assistant message's usage
// into hour x project x model token totals. Free - no model call, no network.
//
// Transcript facts this relies on (verified live 2026-10-09):
//   - one assistant message is often written on several lines sharing one
//     message.id, and their usage can differ (the last chunk carries the final
//     output count) -> dedupe by id, keep the max of each field;
//   - files are append-only while a session runs -> remember the byte offset
//     of the last complete line and read only the tail next time; a file whose
//     size and mtime did not change is never opened again;
//   - files untouched for longer than the history window are skipped unread.
//
// summarize() prices the rows with src/rates.js. An unknown model is counted as
// "unpriced tokens", never guessed (same rule as rates.js).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { rateFor, estimateCost } = require('./rates');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_HISTORY_DAYS = 14;
const CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;
const ASSISTANT = Buffer.from('"assistant"');
const MAX_ID = 200;
const MAX_MODEL = 80;
const MAX_TOKENS = 1e12;

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), MAX_TOKENS) : 0);

/**
 * One transcript line -> {id, ms, cwd, model, u} for an assistant message
 * with usage, or null for anything else (user lines, tool results, junk).
 */
function parseAssistantLine(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return null;
  const m = o.message;
  const usage = m.usage;
  if (typeof m.id !== 'string' || !m.id || m.id.length > MAX_ID) return null;
  if (typeof m.model !== 'string' || !m.model || m.model.length > MAX_MODEL || m.model.startsWith('<')) return null;
  if (!usage || typeof usage !== 'object') return null;
  const ms = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(ms)) return null;
  return {
    id: m.id,
    ms,
    cwd: typeof o.cwd === 'string' ? o.cwd : '',
    model: m.model,
    u: {
      input: count(usage.input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      output: count(usage.output_tokens),
    },
  };
}

const maxUsage = (a, b) => ({
  input: Math.max(a.input, b.input),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  output: Math.max(a.output, b.output),
});

/** Lists every transcript file with its stat; a missing root is an empty list. */
async function listTranscripts(root) {
  const out = [];
  const dirents = async (dir) => {
    try {
      return await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const project of await dirents(root)) {
    if (!project.isDirectory()) continue;
    const pdir = path.join(root, project.name);
    for (const entry of await dirents(pdir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path.join(pdir, entry.name));
      if (!entry.isDirectory()) continue;
      const sub = path.join(pdir, entry.name, 'subagents');
      for (const agent of await dirents(sub)) {
        if (agent.isFile() && agent.name.endsWith('.jsonl')) out.push(path.join(sub, agent.name));
      }
    }
  }
  const withStat = [];
  for (const file of out) {
    try {
      const st = await fs.promises.stat(file);
      withStat.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // Removed between readdir and stat - skip it.
    }
  }
  return withStat;
}

/**
 * @param {{root:string, resolveKey:(cwd:string)=>{key:string,name:string},
 *          now?:()=>number, historyDays?:number}} opts
 */
function createLedger({ root, resolveKey, now = Date.now, historyDays = DEFAULT_HISTORY_DAYS }) {
  /** file -> {size, mtimeMs, offset, msgs: Map<id, {hour,key,name,model,u}>} */
  const files = new Map();
  let bytesRead = 0;
  let scanning = null;

  const cutoff = () => now() - historyDays * DAY_MS;

  function addLine(state, buf, start, end) {
    const hit = buf.indexOf(ASSISTANT, start);
    if (hit === -1 || hit >= end) return;
    const rec = parseAssistantLine(buf.toString('utf8', start, end));
    if (!rec || rec.ms < cutoff()) return;
    const prev = state.msgs.get(rec.id);
    if (prev) {
      prev.u = maxUsage(prev.u, rec.u);
      return;
    }
    const { key, name } = resolveKey(rec.cwd);
    state.msgs.set(rec.id, { hour: rec.ms - (rec.ms % HOUR_MS), key, name, model: rec.model, u: rec.u });
  }

  /** Reads complete lines from state.offset to EOF; a partial last line waits. */
  async function readTail(file, state) {
    const fh = await fs.promises.open(file, 'r');
    try {
      let pos = state.offset;
      let carry = Buffer.alloc(0);
      for (;;) {
        const chunk = Buffer.alloc(CHUNK);
        const { bytesRead: n } = await fh.read(chunk, 0, CHUNK, pos);
        if (n === 0) break;
        pos += n;
        bytesRead += n;
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        let start = 0;
        let nl;
        while ((nl = buf.indexOf(NEWLINE, start)) !== -1) {
          addLine(state, buf, start, nl);
          start = nl + 1;
        }
        state.offset += start;
        carry = Buffer.from(buf.subarray(start));
      }
    } finally {
      await fh.close();
    }
  }

  async function doScan() {
    const seen = new Set();
    for (const { file, size, mtimeMs } of await listTranscripts(root)) {
      if (mtimeMs < cutoff()) continue;
      seen.add(file);
      let state = files.get(file);
      if (state && state.size === size && state.mtimeMs === mtimeMs) continue;
      if (!state || size < state.offset) {
        state = { size: 0, mtimeMs: 0, offset: 0, msgs: new Map() };
        files.set(file, state);
      }
      try {
        await readTail(file, state);
        state.size = size;
        state.mtimeMs = mtimeMs;
      } catch (err) {
        // Locked or vanished mid-read: drop it, the next scan starts it over.
        console.error('[ledger] read failed:', path.basename(file), err && err.code);
        files.delete(file);
        seen.delete(file);
      }
    }
    for (const file of [...files.keys()]) if (!seen.has(file)) files.delete(file);
  }

  return {
    /** Brings the cache up to date; concurrent calls share one pass. */
    scan() {
      if (!scanning) scanning = doScan().finally(() => (scanning = null));
      return scanning;
    },

    /** [hour, key, name, model, input, cacheWrite, cacheRead, output] per bucket. */
    rows() {
      const minHour = cutoff() - (cutoff() % HOUR_MS);
      const buckets = new Map();
      for (const state of files.values()) {
        for (const r of state.msgs.values()) {
          if (r.hour < minHour) continue;
          const id = `${r.hour}\u0000${r.key}\u0000${r.model}`;
          const b = buckets.get(id);
          if (b) {
            b[4] += r.u.input;
            b[5] += r.u.cacheWrite;
            b[6] += r.u.cacheRead;
            b[7] += r.u.output;
          } else {
            buckets.set(id, [r.hour, r.key, r.name, r.model, r.u.input, r.u.cacheWrite, r.u.cacheRead, r.u.output]);
          }
        }
      }
      return [...buckets.values()];
    },

    stats: () => ({ files: files.size, bytesRead }),
  };
}

/**
 * Prices rows inside [sinceMs, untilMs) and splits them by project. The
 * bucket holding sinceMs counts whole (hour granularity).
 * @param {Array} rows from ledger.rows() (any number of machines, concatenated)
 * @param {{sinceMs:number, untilMs:number, rates:{rates:Array,cacheReadMultiplier?:number,cacheWriteMultiplier?:number}}} opts
 */
function summarize(rows, { sinceMs, untilMs, rates }) {
  const from = sinceMs - (sinceMs % HOUR_MS);
  const byKey = new Map();
  let totalUsd = 0;
  let unpricedTokens = 0;
  for (const [hour, key, name, model, input, cacheWrite, cacheRead, output] of rows) {
    if (hour < from || hour >= untilMs) continue;
    let p = byKey.get(key);
    if (!p) {
      p = { key, name, usd: 0, tokens: 0, unpricedTokens: 0, share: 0 };
      byKey.set(key, p);
    }
    const tokens = input + cacheWrite + cacheRead + output;
    p.tokens += tokens;
    const cost = estimateCost({ input, output, cacheRead, cacheWrite }, rateFor(model, rates.rates), rates);
    if (cost) {
      p.usd += cost.usd;
      totalUsd += cost.usd;
    } else {
      p.unpricedTokens += tokens;
      unpricedTokens += tokens;
    }
  }
  const projects = [...byKey.values()]
    .map((p) => ({ ...p, share: totalUsd > 0 ? p.usd / totalUsd : 0 }))
    .sort((a, b) => b.usd - a.usd || b.unpricedTokens - a.unpricedTokens);
  return { totalUsd, unpricedTokens, projects };
}

module.exports = { parseAssistantLine, createLedger, summarize, HOUR_MS, DEFAULT_HISTORY_DAYS };
