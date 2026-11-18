// ============================================================================
// LunaCore - the live Antigravity (agy) worker-model choices, renderer side
// ----------------------------------------------------------------------------
// Main runs `agy models` (src/agymodels.js) when a worker-model picker opens
// and hands back [{id, name}] - plain 'agy' plus one 'agy:<id>' per model.
// This module keeps the variants for the pickers (Settings, Approve) and the
// package badges. A failed call leaves only plain 'agy' (main logs why).
// No DOM; text from main goes into the page via textContent only.
// ============================================================================

'use strict';

import { agyModelIdOf } from '../../workerModels.js';

/** Longest name shown for one model. */
const MAX_NAME_CHARS = 120;

/** [{id: 'agy:<id>', name}] from the last successful read. */
let variants = [];

/**
 * The variants of main's reply, shape-checked: well-formed 'agy:<id>' ids
 * only, names as plain capped strings (the id when there is none).
 * @param {unknown} choices
 * @returns {{id:string, name:string}[]}
 */
export function cleanAgyChoices(choices) {
  const out = [];
  for (const c of Array.isArray(choices) ? choices : []) {
    if (!c || typeof c !== 'object' || agyModelIdOf(c.id) === null || out.some((v) => v.id === c.id)) continue;
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, MAX_NAME_CHARS) : c.id;
    out.push({ id: c.id, name });
  }
  return out;
}

/** The 'agy:<id>' ids of the last read, in agy's order. */
export const agyVariantIds = () => variants.map((v) => v.id);

/** The live name of an 'agy:<id>' choice, else null. */
export function agyChoiceName(model) {
  const hit = variants.find((v) => v.id === model);
  return hit ? hit.name : null;
}

/**
 * Asks main to read `agy models` again. Resolves with the variant ids; a
 * failed call leaves none (only plain 'agy' is offered then).
 * @returns {Promise<string[]>}
 */
export async function refreshAgyModels() {
  try {
    const res = await window.lunacore.agyModels();
    variants = cleanAgyChoices(res && res.choices);
  } catch (err) {
    console.warn('[agymodels] reading the agy model list failed:', err);
    variants = [];
  }
  return agyVariantIds();
}
