// ============================================================================
// LunaCore - Life budget <-> sync units (pure, shared by main and the phone)
// ----------------------------------------------------------------------------
// A unit is one independently mergeable piece of the budget (key format in
// src/lifesync.js). lifesync.js merges units between PCs; the phone
// (mobile/src/lifemodel.js) builds its budget from the same units and writes
// back only the units an op changed. Peer data is untrusted: validPeer()
// keeps a unit only when lifebudgetrows.normalize() returns it unchanged.
// ============================================================================

'use strict';

const { normalize } = require('./lifebudgetrows');

const DAY_MS = 24 * 60 * 60 * 1000;
// Above the store's own caps summed (5000 expenses, 2000 deposits, 24 months x 100 bills...).
const MAX_UNITS = 10000;
const MAX_GONE = 10000;
const KEY_RE = /^(income|[cebgd]:[a-z0-9-]{1,40}|p:\d{4}-(0[1-9]|1[0-2]):[a-z0-9-]{1,40})$/;
const COLLECTIONS = [
  ['c', 'categories'],
  ['e', 'expenses'],
  ['b', 'bills'],
  ['g', 'goals'],
  ['d', 'deposits'],
];
const COLLECTION_OF = Object.fromEntries(COLLECTIONS);

const validStamp = (t, now) => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= now + DAY_MS;
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Same content, key order ignored (unit values are flat objects). */
function sameValue(a, b) {
  const flat = (v) => JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
  return flat(a) === flat(b);
}

/** A normalized budget -> [key, value] units, in display order. */
function toUnits(b) {
  const units = [['income', b.income]];
  for (const [prefix, name] of COLLECTIONS) for (const row of b[name]) units.push([`${prefix}:${row.id}`, row]);
  for (const m of Object.keys(b.payments).sort()) {
    for (const [billId, pay] of Object.entries(b.payments[m])) units.push([`p:${m}:${billId}`, pay]);
  }
  return units;
}

/** [key, value] units -> a budget, validated by the store's own normalize(). */
function fromUnits(units) {
  const lists = Object.fromEntries(COLLECTIONS.map(([, name]) => [name, []]));
  const payments = {};
  let income;
  for (const [k, v] of units) {
    const [prefix, a, b] = k.split(':');
    if (k === 'income') income = v;
    else if (prefix === 'p') payments[a] = { ...payments[a], [b]: v };
    else lists[COLLECTION_OF[prefix]].push(v);
  }
  return normalize({ income, payments, ...lists });
}

/** A peer's body {units, gone} -> only the units that survive normalize() unchanged. */
function validPeer(data, now) {
  const seen = new Set();
  const raw = [];
  for (const x of Array.isArray(data.units) ? data.units.slice(0, MAX_UNITS) : []) {
    if (!x || typeof x.k !== 'string' || !KEY_RE.test(x.k) || seen.has(x.k)) continue;
    if (!isPlainObject(x.v) || !validStamp(x.u, now)) continue;
    // 'e:aaa' carrying id 'bbb' would take the real 'e:bbb' row's place in normalize().
    const [prefix, rowId] = x.k.split(':');
    if (COLLECTION_OF[prefix] && x.v.id !== rowId) continue;
    seen.add(x.k);
    raw.push(x);
  }
  const clean = new Map(toUnits(fromUnits(raw.map((x) => [x.k, x.v]))));
  const units = raw.filter((x) => clean.has(x.k) && sameValue(clean.get(x.k), x.v)).map((x) => ({ k: x.k, v: clean.get(x.k), u: x.u }));
  const gone = {};
  for (const [k, t] of Object.entries(isPlainObject(data.gone) ? data.gone : {}).slice(0, MAX_GONE)) {
    if (KEY_RE.test(k) && validStamp(t, now)) gone[k] = t;
  }
  return { units, gone };
}

module.exports = { toUnits, fromUnits, validPeer, sameValue, KEY_RE };
