// ============================================================================
// LunaCore - Luna's Work Higgsfield cost guard: the luna_asset_judge verdicts
// it decides from, and the asset each one is about
// ----------------------------------------------------------------------------
// A paid Higgsfield final (luna_asset_higgsfield) is refused with
// 'freeCandidatePassed' while a free or local candidate's pass stands for the
// same asset (src/lunasworkAssetJudge.js judges, src/lunasworkAssetHiggsfield.js
// refuses). This module holds the parts that decide "stands" and "same asset":
//
//   verdict list   run.judgeVerdicts (src/lunasworkToolGuard.js): every judge
//                  verdict {at, kind, name, freePass, pass, winner, candidates},
//                  winner and candidates as keys (a repo path, or
//                  `source:id` for a library pick). It is kept apart from the
//                  run's asset log, whose newest-500 cap is shared by every
//                  asset tool: an early free pass never falls out of it.
//                  compactVerdicts bounds it per asset (kind + slug of the
//                  judged name): withdrawn passes go, standing free passes
//                  are kept one per winner - the first one and the newest, up
//                  to MAX_PASSES_PER_ASSET - plus MAX_OTHERS_PER_ASSET other
//                  verdicts, then MAX_JUDGE_VERDICTS overall, the oldest
//                  non-passes going first. A run recorded before the list
//                  existed has it null: its judge entries in the asset log
//                  are read instead (legacyVerdicts) and carried over on its
//                  next verdict.
//   withdrawal     only a later verdict that passed nothing takes back an
//                  earlier free pass, and only when it judged that pass's
//                  winner (its own winner, or among its candidates - so also
//                  when it judged all the pass's candidates). Junk re-judged
//                  under the same name withdraws nothing, and neither does a
//                  passing verdict whose winner reads as paid or of unknown
//                  origin: that reading comes from record files in the
//                  worker's own worktree. The in-memory store keeps verdicts
//                  the same way, so both sources answer alike.
//   the asset      the name a worker types is free text, so the guard keys on
//                  the asset row of design/ASSETS.md (the cast the asset
//                  card was filed from, src/lunasworkAssets.js) that the name
//                  resolves to: exact slug, then the same words (digits,
//                  "v2", "final"... dropped, plurals and "-en" folded), then
//                  word containment, then a close spelling - one row or
//                  nothing. Rows that are one asset (same slug or spec hash)
//                  share a key. With rows in the list, a paid final whose name
//                  resolves to none is refused (notCastAsset), and so is one
//                  when the list cannot be read (assetListUnreadable): fail
//                  closed. Without a list, the key is kind + slug as before.
//                  The list is read from the run's own checkout when the tab
//                  names it (castRepoPath), not the worker's editable copy.
//
// Everything read back from a run record is untrusted and validated again.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { KINDS, slugOf } = require('./lunasworkAssetPipeline');

const FREE_PASS_PREFIX = 'free pass - ';
const PASS_PREFIX = 'pass - ';
const MAX_NAME_CHARS = 80;
const MAX_KEY_CHARS = 320;
const MAX_CANDIDATE_KEYS = 8;
const MAX_PASSES_PER_ASSET = 8;
const MAX_OTHERS_PER_ASSET = 8;
const MAX_JUDGE_VERDICTS = 1000;
const ASSET_LIST_REL = 'design/ASSETS.md';
const MAX_ASSET_LIST_BYTES = 512 * 1024;
// A close spelling counts only this similar (character bigrams), and this far ahead of the next asset.
const FUZZY_MIN_SCORE = 0.8;
const FUZZY_MIN_LEAD = 0.1;
// Words that tell variants of one asset apart rather than name it.
const NOISE_WORDS = Object.freeze(new Set(['a', 'an', 'the', 'of', 'v', 'new', 'final', 'alt', 'variant', 'version', 'copy', 'draft']));
const NOISE_WORD_RE = /^(v?\d+|\d+(st|nd|rd|th))$/;
// The winner of a verdict the in-memory store got without its details: never a repo path or a library key.
const UNKNOWN_WINNER = '?';
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));

// ---- the verdict list -------------------------------------------------------------------

const cleanKey = (v) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY_CHARS && !CONTROL_RE.test(v) ? v : null);

/** A judge candidate as a verdict key: its repo path, or `source:id` for a library pick. */
const candidateKey = (c) => (isObj(c) ? `${c.source}:${c.id}` : c);

/**
 * One verdict, validated; null when it is not one. An empty candidate list
 * means "not known" (a verdict carried over from the asset log).
 * @returns {{at:number|null, kind:string, name:string, freePass:boolean, pass:boolean, winner:string, candidates:string[]}|null}
 */
function cleanJudgeVerdict(raw) {
  if (!isObj(raw) || !own(KINDS, raw.kind) || typeof raw.name !== 'string') return null;
  const name = oneLine(raw.name, MAX_NAME_CHARS);
  const winner = cleanKey(raw.winner);
  if (!slugOf(name) || !winner) return null;
  const list = Array.isArray(raw.candidates) ? raw.candidates : [];
  if (list.length > MAX_CANDIDATE_KEYS) return null;
  const candidates = [...new Set(list.map(cleanKey))];
  if (candidates.includes(null) || (candidates.length && !candidates.includes(winner))) return null;
  const freePass = raw.freePass === true;
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at >= 0 ? raw.at : null;
  return { at, kind: raw.kind, name, freePass, pass: freePass || raw.pass === true, winner, candidates };
}

/**
 * True when `later` takes back the free pass `pass` (see the header): it passed
 * nothing, and it judged that pass's winner - as its own winner or among its
 * candidates, so also whenever it judged all the pass's candidates.
 */
function withdraws(later, pass) {
  // A passing verdict never does, whatever its winner's origin: an "unknown" or "paid" origin can come
  // from a record file the worker wrote in its own worktree (src/lunasworkAssetJudge.js originOf).
  if (later.pass || !later.winner) return false;
  return later.winner === pass.winner || later.candidates.includes(pass.winner);
}

/**
 * A verdict as the in-memory store keeps it (src/lunasworkAssetJudge.js
 * createVerdictStore), under the kind and slug it was recorded with: the
 * judge's details when they are valid, else a bare one (UNKNOWN_WINNER) that
 * can only withdraw another bare one - never a pass the judge described.
 */
function storeVerdict(kind, slug, freePass, verdict) {
  const passed = freePass === true;
  const clean = cleanJudgeVerdict(verdict);
  const base = { kind: String(kind), slug: String(slug), freePass: passed };
  if (clean) return { ...clean, ...base, pass: clean.pass || passed };
  return { at: null, name: String(slug), pass: passed, winner: UNKNOWN_WINNER, candidates: [], ...base };
}

/** Indexes of the free passes in `list` (oldest first) that no later verdict of the same list withdraws. */
function standingPasses(list) {
  return list.map((v, i) => (v.freePass && !list.slice(i + 1).some((later) => withdraws(later, v)) ? i : -1)).filter((i) => i >= 0);
}

const groupKey = (v) => `${v.kind}/${slugOf(v.name)}`;

/**
 * The standing passes of one asset that are kept: one per winner (passes of one
 * winner are withdrawn together), the oldest and the newest ones, so a flood of
 * later passes never pushes the first one out.
 */
function keptPasses(standing, list) {
  const newestByWinner = new Map();
  for (const i of standing) newestByWinner.set(list[i].winner, i);
  const distinct = [...newestByWinner.values()].sort((a, b) => a - b);
  return distinct.length <= MAX_PASSES_PER_ASSET ? distinct : [distinct[0], ...distinct.slice(1 - MAX_PASSES_PER_ASSET)];
}

/**
 * The list bounded (see the header), oldest first. Only the verdicts that can
 * still matter are kept: a withdrawn pass goes, a standing one stays longest.
 */
function compactVerdicts(list) {
  const groups = new Map();
  list.forEach((v, i) => {
    const key = groupKey(v);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const keep = new Set();
  for (const idx of groups.values()) {
    const standing = standingPasses(idx.map((i) => list[i])).map((j) => idx[j]);
    const others = idx.filter((i) => !list[i].freePass);
    for (const i of [...keptPasses(standing, list), ...others.slice(-MAX_OTHERS_PER_ASSET)]) keep.add(i);
  }
  const kept = list.filter((_, i) => keep.has(i));
  const excess = kept.length - MAX_JUDGE_VERDICTS;
  if (excess <= 0) return kept;
  // Over the bound: verdicts that are not a free pass go first (that only ever blocks more), then the oldest passes.
  const order = [...kept.keys()].sort((a, b) => Number(kept[a].freePass) - Number(kept[b].freePass) || a - b);
  const drop = new Set(order.slice(0, excess));
  return kept.filter((_, i) => !drop.has(i));
}

/** run.judgeVerdicts as stored: null for a record from before the list (read the asset log), else the bounded list. */
function cleanJudgeVerdicts(raw) {
  if (!Array.isArray(raw)) return null;
  return compactVerdicts(raw.slice(-MAX_JUDGE_VERDICTS).map(cleanJudgeVerdict).filter(Boolean));
}

/** The judge entries of an asset log (tool 'judge'), as verdicts with unknown candidates. */
function legacyVerdicts(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => isObj(e) && e.tool === 'judge' && typeof e.prompt === 'string')
    .map((e) => cleanJudgeVerdict({
      at: e.at,
      kind: e.kind,
      name: e.name,
      winner: e.path,
      candidates: [],
      freePass: e.prompt.startsWith(FREE_PASS_PREFIX),
      pass: e.prompt.startsWith(PASS_PREFIX),
    }))
    .filter(Boolean);
}

/**
 * Whether a free pass stands for asset `target` in `verdicts` (oldest first).
 * @param {(v:object)=>string|null} keyOf the asset key of a verdict
 * @returns {boolean|null} null = no verdict for this asset
 */
function freePassStands(verdicts, keyOf, target) {
  const mine = verdicts.filter((v) => keyOf(v) === target);
  return mine.length ? standingPasses(mine).length > 0 : null;
}

/**
 * The cost guard's answer from a run record {runId, verdicts, entries}
 * (src/lunasworkToolGuard.js judgeVerdicts): its verdict list, or for a record
 * from before the list, the judge entries of its asset log.
 * @returns {boolean|null} true = a free pass stands; false = none does; null = the record has no say
 */
function freePassFromRecord(record, runId, target, keyOf) {
  if (!isObj(record) || typeof runId !== 'string' || !runId || record.runId !== runId || typeof target !== 'string') return null;
  let list = null;
  if (Array.isArray(record.verdicts)) list = record.verdicts.slice(-MAX_JUDGE_VERDICTS).map(cleanJudgeVerdict).filter(Boolean);
  else if (Array.isArray(record.entries)) list = legacyVerdicts(record.entries);
  return list ? freePassStands(list, keyOf, target) : null;
}

// ---- the asset a name stands for --------------------------------------------------------

/** Folds plurals and "-en" adjectives, so "Wooden Crates" and "wood crate" read alike. */
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('en')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The words of a name that tell the asset, stemmed and sorted; all of them when every word is noise. */
function wordsOf(name) {
  const all = slugOf(name).split('-').filter(Boolean);
  const kept = all.filter((w) => !NOISE_WORDS.has(w) && !NOISE_WORD_RE.test(w)).map(stem);
  return [...new Set(kept.length ? kept : all)].sort();
}

function bigrams(text) {
  const out = new Map();
  for (let i = 0; i + 1 < text.length; i += 1) out.set(text.slice(i, i + 2), (out.get(text.slice(i, i + 2)) || 0) + 1);
  return out;
}

/** Dice similarity of two strings over character bigrams, 0..1. */
function similarity(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  let total = 0;
  let shared = 0;
  for (const n of x.values()) total += n;
  for (const n of y.values()) total += n;
  for (const [g, n] of x) shared += Math.min(n, y.get(g) || 0);
  return total ? (2 * shared) / total : 0;
}

/** The one key among `hits`, or null when they name more than one asset. */
function onlyKey(hits) {
  const keys = new Set(hits.map((h) => h.key));
  return keys.size === 1 ? [...keys][0] : null;
}

/** The best-scored hits' key, or null when the best is tied between assets. */
function bestKey(scored) {
  const top = Math.max(...scored.map((s) => s.score));
  return onlyKey(scored.filter((s) => s.score === top));
}

/**
 * The asset rows of design/ASSETS.md, ready to resolve names against.
 * @param {{name:string, hash?:string}[]} rows parseAssetList rows (src/lunasworkAssets.js)
 * @returns {{size:number, resolve:(name:string)=>string|null}} resolve -> 'asset:<slug>' or null
 */
function castIndex(rows) {
  const entries = [];
  const bySlug = new Map();
  const byHash = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObj(row) || typeof row.name !== 'string' || !slugOf(row.name)) continue;
    const slug = slugOf(row.name);
    const hash = typeof row.hash === 'string' && row.hash ? row.hash : null;
    // Rows that are one asset (a duplicate by name or spec) share the first row's key.
    const key = bySlug.get(slug) || (hash && byHash.get(hash)) || `asset:${slug}`;
    if (!bySlug.has(slug)) bySlug.set(slug, key);
    if (hash && !byHash.has(hash)) byHash.set(hash, key);
    const words = wordsOf(row.name);
    entries.push({ key, slug, words, text: words.join(' ') });
  }

  function resolve(name) {
    const slug = slugOf(name);
    if (!slug || !entries.length) return null;
    const exact = entries.filter((e) => e.slug === slug);
    if (exact.length) return onlyKey(exact);
    const words = wordsOf(name);
    const text = words.join(' ');
    const same = entries.filter((e) => e.text === text);
    if (same.length) return onlyKey(same);
    // Containment either way ("Big Wooden Crate", "Crate"): the most shared words win, a tie names nothing.
    const within = entries
      .filter((e) => e.words.every((w) => words.includes(w)) || words.every((w) => e.words.includes(w)))
      .map((e) => ({ key: e.key, score: e.words.filter((w) => words.includes(w)).length }));
    if (within.length) return bestKey(within);
    const scored = entries.map((e) => ({ key: e.key, score: similarity(text, e.text) })).sort((a, b) => b.score - a.score);
    const best = scored[0];
    const next = scored.find((s) => s.key !== best.key);
    if (best.score < FUZZY_MIN_SCORE || (next && best.score - next.score < FUZZY_MIN_LEAD)) return null;
    return best.key;
  }

  return { size: entries.length, resolve };
}

/**
 * The asset list of a repo: {ok:true, index:null} when it has none (or no
 * rows), {ok:false, detail} when it cannot be read.
 */
function readCastIndex(repoPath) {
  const file = path.join(repoPath, ...ASSET_LIST_REL.split('/'));
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_ASSET_LIST_BYTES) return { ok: false, detail: `${ASSET_LIST_REL} is not a file under ${MAX_ASSET_LIST_BYTES} bytes` };
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { ok: true, index: null };
    return { ok: false, detail: `${ASSET_LIST_REL} cannot be read (${err && err.code ? err.code : oneLine(errText(err), 80)})` };
  }
  // Loaded on use: src/lunasworkAssets.js reaches src/intake.js, which loads the asset tools.
  const rows = require('./lunasworkAssets').parseAssetList(text).rows.filter((r) => !r.raw);
  const index = castIndex(rows);
  return { ok: true, index: index.size ? index : null };
}

/** The guard's key for a verdict or a request: its cast row, kind + slug without a list, null when it resolves to none. */
function assetKeyOf(index, kind, name) {
  if (!index) return `${kind}/${slugOf(name)}`;
  return index.resolve(name);
}

// ---- the guard of one worker tab --------------------------------------------------------

/**
 * @param {{ctx:{repoPath:string, castRepoPath?:string, judgeVerdicts?:Function, recordJudgeVerdict?:Function},
 *   runId:string|null, store:{record:Function, verdicts:Function}, log?:(line:string)=>void}} o
 *   ctx = the tab's asset tool context (src/lunasworkAssetTools.js createAssetToolsFor);
 *   store = this process's verdict store (src/lunasworkAssetJudge.js createVerdictStore): its
 *   verdicts are resolved to their asset at check time, like the run record's
 * @returns {{record:(repoPath:string, kind:string, slug:string, freePass:boolean, verdict?:object)=>void,
 *   check:(job:{name:string, kind:string, slug:string})=>boolean|{error:string, detail:string}}}
 */
function createFreePassGuard(o) {
  const { ctx, store, runId } = o;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const listRepo = typeof ctx.castRepoPath === 'string' && path.isAbsolute(ctx.castRepoPath) ? ctx.castRepoPath : ctx.repoPath;
  const castList = () => {
    try {
      return readCastIndex(listRepo);
    } catch (err) {
      return { ok: false, detail: `${ASSET_LIST_REL}: ${oneLine(errText(err), 120)}` };
    }
  };

  /** A judge verdict: into the run record (the guard's first source) and this process's store. */
  function record(repoPath, kind, slug, freePass, verdict) {
    store.record(repoPath, kind, slug, freePass, verdict, runId);
    if (typeof ctx.recordJudgeVerdict !== 'function') return;
    try {
      if (!ctx.recordJudgeVerdict(verdict)) log(`[lunaswork-assets] the run record did not keep the judge verdict for ${oneLine(slug, 80)}; this process's store still has it`);
    } catch (err) {
      log(`[lunaswork-assets] judge verdict not recorded in the run: ${oneLine(errText(err), 200)}`);
    }
  }

  /**
   * true = a free pass stands for the asset; false = go on; {error, detail} = refused
   * because the asset cannot be told (fail closed). The run record and this process's
   * store both count: when they disagree, the guard errs on the side of not spending.
   */
  function check(job) {
    const cast = castList();
    if (!cast.ok) return { error: 'assetListUnreadable', detail: `${cast.detail}: a paid final needs it to check the judge's verdicts for "${job.name}"` };
    const target = assetKeyOf(cast.index, job.kind, job.slug);
    if (!target) return { error: 'notCastAsset', detail: `"${job.name}" is not an asset of ${ASSET_LIST_REL}: use the asset name exactly as its card and its ${ASSET_LIST_REL} row give it` };
    const keys = new Map();
    const keyOf = (v) => {
      const k = `${v.kind}/${slugOf(v.name)}`;
      if (!keys.has(k)) keys.set(k, assetKeyOf(cast.index, v.kind, v.name));
      return keys.get(k);
    };
    let fromRun = null;
    if (typeof ctx.judgeVerdicts === 'function') {
      try {
        fromRun = freePassFromRecord(ctx.judgeVerdicts(), runId, target, keyOf);
      } catch (err) {
        log(`[lunaswork-assets] judge verdicts unreadable, using this process's verdicts: ${oneLine(errText(err), 200)}`);
      }
    }
    const kept = typeof store.verdicts === 'function' ? store.verdicts(ctx.repoPath, runId) : [];
    return fromRun === true || freePassStands(Array.isArray(kept) ? kept : [], keyOf, target) === true;
  }

  return { record, check };
}

module.exports = {
  FREE_PASS_PREFIX,
  PASS_PREFIX,
  MAX_PASSES_PER_ASSET,
  MAX_OTHERS_PER_ASSET,
  MAX_JUDGE_VERDICTS,
  candidateKey,
  storeVerdict,
  cleanJudgeVerdict,
  cleanJudgeVerdicts,
  compactVerdicts,
  legacyVerdicts,
  withdraws,
  freePassStands,
  freePassFromRecord,
  castIndex,
  readCastIndex,
  assetKeyOf,
  createFreePassGuard,
};
