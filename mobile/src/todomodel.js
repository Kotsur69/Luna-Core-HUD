// ============================================================================
// LunaCore phone - to-do model (pure)
// ----------------------------------------------------------------------------
// docs/CLOUD_SYNC_PLAN.md phase 4a. The phone has no local to-do file: the
// pulled `todos` mirror ({key: {v, u, d}}, built by cloudrows.applyRows) IS
// its state, and every change is one cloud unit {k, v, u, d} that the server
// orders newest-wins. Rows come from other machines, so lists() runs every
// item through the same validators todosync.js uses on a PC, and the units
// built here are already normalised: a PC drops a pulled item unless
// normalizeTodo() returns it unchanged.
// ============================================================================

import rows from '../../src/cloudrows.js';
import ledger from '../../src/missionledgersync.js';
import todoRows from '../../src/todorows.js';

const { splitTodoKey, MAX_KEY } = rows;
const { validKey } = ledger;
const { normalizeTodo, MAX_TEXT_CHARS } = todoRows;

const validAt = (at) => Number.isSafeInteger(at) && at > 0;

// Zero-width and bidi-override characters: a `local:` key may carry them, and
// they could make one list's name display as another's.
const HIDDEN_RE = /[​-‏‪-‮⁦-⁩﻿]/g;

/** 'git:github.com/kotsur69/luna-core-hud' -> 'luna-core-hud', 'local:home' -> 'home'. */
export function projectName(key) {
  const name = key.startsWith('local:') ? key.slice('local:'.length) : key.slice(key.lastIndexOf('/') + 1);
  return name.replace(HIDDEN_RE, '');
}

/** Open items first, then oldest first - the order the desktop widget adds them in. */
const byState = (a, b) => Number(a.done) - Number(b.done) || a.at - b.at;

/**
 * The mirror -> validated lists, one per project key.
 * @param {Record<string, {v: unknown, u: number, d: number|null}>} mirror untrusted
 * @returns {{key: string, name: string, items: object[]}[]} items carry `u`
 */
export function lists(mirror) {
  const byKey = new Map();
  for (const [k, row] of Object.entries(mirror)) {
    const split = splitTodoKey(k);
    if (!split || row.d !== null) continue;
    const [key, at] = split;
    if (!validKey(key) || key === 'other') continue;
    const todo = normalizeTodo(row.v && typeof row.v === 'object' ? { ...row.v, at } : null);
    if (!todo || !validAt(todo.at)) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ ...todo, u: row.u });
  }
  return [...byKey]
    .map(([key, items]) => ({ key, name: projectName(key), items: items.sort(byState) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A stamp newer than the one it replaces, even with a phone clock a little behind. */
const stampAfter = (prev, now) => Math.max(Math.floor(now), (prev || 0) + 1);

/**
 * A new item in `key`. `now` doubles as the item id (`at`), like on a PC.
 * @returns {{k: string, v: object, u: number, d: null}|null} null = nothing to add
 */
export function addUnit(key, text, now = Date.now()) {
  if (!validKey(key) || key === 'other' || key.length + 17 > MAX_KEY) return null;
  const at = Math.floor(now);
  const v = normalizeTodo({ text: String(text ?? '').slice(0, MAX_TEXT_CHARS), done: false, at });
  return v ? { k: `${key}:${at}`, v, u: at, d: null } : null;
}

/** The item ticked or unticked; card fields ride along untouched. */
export function toggleUnit(key, item, now = Date.now()) {
  const { u, ...rest } = item;
  const v = normalizeTodo({ ...rest, done: !item.done });
  return v ? { k: `${key}:${item.at}`, v, u: stampAfter(u, now), d: null } : null;
}

/** A tombstone: beats every older version of the item on every machine. */
export function deleteUnit(key, item, now = Date.now()) {
  const t = stampAfter(item.u, now);
  return { k: `${key}:${item.at}`, v: null, u: t, d: t };
}
