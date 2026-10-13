// ============================================================================
// LunaCore - Mission Control: focus / time per project (pure, main process)
// ----------------------------------------------------------------------------
// LunaCore cannot see Mati working - it only sees moments: a Claude reply in
// a transcript (missionledger.js) or one of his commits (missioncommits.js).
// Hours are built from those moments:
//   - moments of one project less than GAP_MS apart are one block of work;
//   - a block ends TAIL_MS after its last moment (reading the last reply,
//     testing after the last commit), so a lone moment counts TAIL_MS;
//   - blocks are [startMs, endMs, key, name]; that tuple is all that is shared
//     with the other PCs (missionledgersync.js), and mergeBlocks() unions them,
//     so the same session seen by two PCs is not counted twice.
// focusWeek() splits the union into the local Mon-Sun week: hours per project
// and per day, the day's wall-clock total (parallel projects count once), and
// context switches (a different project starting within SWITCH_MS of the last).
// ============================================================================

'use strict';

const MIN_MS = 60 * 1000;
const GAP_MS = 10 * MIN_MS;
const TAIL_MS = 5 * MIN_MS;
const SWITCH_MS = 30 * MIN_MS;
const DAYS = 7;
const MAX_PIECE_MS = 24 * 60 * MIN_MS;

const byStart = (a, b) => a[0] - b[0] || a[1] - b[1];

/** Splits blocks longer than maxMs into maxMs pieces; mergeBlocks() joins them back. */
function splitLong(blocks, maxMs = MAX_PIECE_MS) {
  const out = [];
  for (const [start, end, key, name] of blocks) {
    for (let s = start; s < end; s += maxMs) out.push([s, Math.min(end, s + maxMs), key, name]);
  }
  return out;
}

/**
 * [{ms, key, name}] -> blocks, sorted by key then start. No piece is longer
 * than a day: peers reject longer blocks (missionledgersync.js), and an agent
 * loop can keep one project busy for days.
 */
function eventsToBlocks(events, { gapMs = GAP_MS, tailMs = TAIL_MS } = {}) {
  const byKey = new Map();
  for (const e of events) {
    if (!e || !Number.isFinite(e.ms) || typeof e.key !== 'string') continue;
    if (!byKey.has(e.key)) byKey.set(e.key, { name: e.name, times: [] });
    byKey.get(e.key).times.push(e.ms);
  }
  const blocks = [];
  for (const key of [...byKey.keys()].sort()) {
    const { name, times } = byKey.get(key);
    times.sort((a, b) => a - b);
    let start = times[0];
    let last = times[0];
    for (const t of times.slice(1)) {
      if (t - last < gapMs) {
        last = t;
        continue;
      }
      blocks.push([start, last + tailMs, key, name]);
      start = t;
      last = t;
    }
    blocks.push([start, last + tailMs, key, name]);
  }
  return splitLong(blocks);
}

/** Unions overlapping or touching blocks of the same project; sorted by key then start. */
function mergeBlocks(blocks) {
  const byKey = new Map();
  for (const b of blocks) {
    if (!byKey.has(b[2])) byKey.set(b[2], []);
    byKey.get(b[2]).push(b);
  }
  const out = [];
  for (const key of [...byKey.keys()].sort()) {
    let cur = null;
    for (const [start, end, , name] of byKey.get(key).sort(byStart)) {
      if (cur && start <= cur[1]) {
        cur = [cur[0], Math.max(cur[1], end), key, cur[3]];
        continue;
      }
      if (cur) out.push(cur);
      cur = [start, end, key, name];
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Local Monday 00:00 of the week holding `ms`. */
function mondayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
}

/** Total length of the union of [start, end) intervals. */
function unionMs(intervals) {
  let total = 0;
  let curStart = 0;
  let curEnd = -Infinity;
  for (const [s, e] of [...intervals].sort(byStart)) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else {
      curEnd = Math.max(curEnd, e);
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/**
 * A different project starting within SWITCH_MS of the block that ends last so
 * far - so a short side trip inside a long block is judged against the long
 * one. Starting another project while one is still running (parallel
 * sessions) counts too: attention still moved.
 */
function countSwitches(segments) {
  let switches = 0;
  let prev = null;
  for (const seg of [...segments].sort(byStart)) {
    if (prev && seg[2] !== prev[2] && seg[0] - prev[1] <= SWITCH_MS) switches += 1;
    if (!prev || seg[1] >= prev[1]) prev = seg;
  }
  return switches;
}

/**
 * @param {Array} blocks [startMs, endMs, key, name] from any number of PCs
 * @param {{now:number}} opts
 * @returns {{weekStart:number, totalMs:number, days:Array<{start:number,totalMs:number,switches:number}>,
 *           projects:Array<{key:string,name:string,totalMs:number,days:number[]}>}}
 */
function focusWeek(blocks, { now }) {
  const weekStart = mondayStart(now);
  const ws = new Date(weekStart);
  // Built from the calendar date, not +24 h, so a DST change keeps days at midnight.
  const bounds = Array.from({ length: DAYS + 1 }, (_, i) => new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i).getTime());
  const segsPerDay = Array.from({ length: DAYS }, () => []);
  const projects = new Map();

  for (const [start, end, key, name] of mergeBlocks(blocks)) {
    for (let i = 0; i < DAYS; i++) {
      const s = Math.max(start, bounds[i]);
      const e = Math.min(end, bounds[i + 1], now);
      if (e <= s) continue;
      segsPerDay[i].push([s, e, key]);
      const p = projects.get(key) || { key, name, totalMs: 0, days: new Array(DAYS).fill(0) };
      p.days[i] += e - s;
      p.totalMs += e - s;
      projects.set(key, p);
    }
  }

  const days = segsPerDay.map((segs, i) => ({ start: bounds[i], totalMs: unionMs(segs), switches: countSwitches(segs) }));
  return {
    weekStart,
    totalMs: days.reduce((sum, d) => sum + d.totalMs, 0),
    days,
    projects: [...projects.values()].sort((a, b) => b.totalMs - a.totalMs || a.key.localeCompare(b.key)),
  };
}

module.exports = { eventsToBlocks, mergeBlocks, focusWeek, mondayStart, GAP_MS, TAIL_MS, SWITCH_MS };
