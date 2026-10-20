// ============================================================================
// LunaCore - Luna sync skill picker: pure list logic
// ----------------------------------------------------------------------------
// No document.*, no window.lunacore - unit-tested in test/lunasyncpicker.test.js.
// The DOM/IPC half is lunasyncpicker.js. With ~350 plugin skills installed,
// the picker draws only a capped slice of the filtered list, picked skills
// first, so the panel stays light and a selection never scrolls out of reach.
// ============================================================================

/**
 * @param {Array<{id:string, plugin:string, name:string}>} skills
 * @param {string} query space-separated terms, all must match the id
 * @param {string[]} picked
 * @param {number} limit max rows to draw
 * @returns {{rows:Array<{id:string, plugin:string, name:string, picked:boolean}>, total:number, hidden:number}}
 */
function filterSkills(skills, query, picked, limit) {
  const list = Array.isArray(skills) ? skills.filter((s) => s && typeof s.id === 'string') : [];
  const chosen = new Set(Array.isArray(picked) ? picked : []);
  const terms = typeof query === 'string' ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const matches = list
    .filter((s) => terms.every((term) => s.id.toLowerCase().includes(term)))
    .map((s) => ({ ...s, picked: chosen.has(s.id) }))
    .sort((a, b) => Number(b.picked) - Number(a.picked) || a.id.localeCompare(b.id));
  const cap = Number.isInteger(limit) && limit > 0 ? limit : matches.length;
  return { rows: matches.slice(0, cap), total: matches.length, hidden: Math.max(0, matches.length - cap) };
}

/**
 * A new picked list with `id` added or removed.
 * @param {string[]} picked
 * @param {string} id
 * @param {boolean} on
 * @returns {string[]}
 */
function togglePicked(picked, id, on) {
  const rest = (Array.isArray(picked) ? picked : []).filter((p) => p !== id);
  return on ? [...rest, id] : rest;
}

export { filterSkills, togglePicked };
