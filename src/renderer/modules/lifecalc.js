// ============================================================================
// LunaCore - Life dashboard: amount calculator (pure, no DOM)
// ----------------------------------------------------------------------------
// The Money panel's amount fields accept arithmetic ("45+120,5", "2*12.99").
// A tiny recursive-descent parser over numbers, + - * / and parentheses -
// never eval / Function. Decimal comma or dot; spaces are ignored (so
// "1 200" is 1200). Anything else, a division by zero or a non-finite result
// gives null. The result is rounded to grosze.
// ============================================================================

'use strict';

const MAX_LEN = 80;

/**
 * @param {string} input
 * @returns {number|null}
 */
export function evalAmount(input) {
  if (typeof input !== 'string') return null;
  const src = input.replace(/\s+/g, '').replace(/,/g, '.');
  if (!src || src.length > MAX_LEN || !/^[0-9.+\-*/()]+$/.test(src)) return null;
  let pos = 0;

  const fail = () => {
    throw new Error('parse');
  };

  function number() {
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(pos));
    if (!m) fail();
    pos += m[0].length;
    return Number(m[0]);
  }

  function factor() {
    if (src[pos] === '-') {
      pos += 1;
      if (src[pos] === '-') fail();
      return -factor();
    }
    if (src[pos] === '(') {
      pos += 1;
      const v = expr();
      if (src[pos] !== ')') fail();
      pos += 1;
      return v;
    }
    return number();
  }

  function term() {
    let v = factor();
    while (src[pos] === '*' || src[pos] === '/') {
      const op = src[pos];
      pos += 1;
      const r = factor();
      if (op === '/' && r === 0) fail();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }

  function expr() {
    let v = term();
    while (src[pos] === '+' || src[pos] === '-') {
      const op = src[pos];
      pos += 1;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  try {
    const v = expr();
    if (pos !== src.length || !Number.isFinite(v)) return null;
    return Math.round(v * 100) / 100;
  } catch {
    return null;
  }
}
