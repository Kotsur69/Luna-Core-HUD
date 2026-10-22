// ============================================================================
// LunaCore - minimal QR code encoder (main, pure)
// ----------------------------------------------------------------------------
// The Setup Center shows the phone PWA's URL as a QR code. No dependency for
// one picture: byte mode, error correction level M, versions 1-10 (up to 213
// bytes - URLs are capped at 200 in setupcenter.normalizePwaUrl). Follows the
// structure of Project Nayuki's reference generator (MIT): function patterns,
// Reed-Solomon over GF(256), zig-zag placement, best of the 8 masks.
//
// encodeQr(text) -> {size, bits} where bits is a size*size string of '0'/'1'
// (row-major, '1' = dark). The renderer only paints it.
// ============================================================================

'use strict';

const MAX_VERSION = 10;
// Level M, index = version (0 unused).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_ECL_M = 0; // format bits for level M

const bit = (x, i) => ((x >>> i) & 1) !== 0;

function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (ver) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMul(coef, factor);
    });
  }
  return result;
}

/** Byte-mode segment + terminator + padding -> data codewords for `ver`. */
function dataBytes(bytes, ver) {
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));
  const capacity = dataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

function interleave(data, ver) {
  const numBlocks = NUM_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
    });
  }
  return result;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function formatBits(mask) {
  const data = (FORMAT_ECL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function maskHit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

class Grid {
  constructor(ver) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  setFixed(x, y, dark) {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFixed(6, i, i % 2 === 0);
      this.setFixed(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) this.setFixed(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = alignmentPositions(this.ver);
    const last = pos.length - 1;
    pos.forEach((px, i) => {
      pos.forEach((py, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.setFixed(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      });
    });
    this.drawFormat(0);
    this.drawVersion();
  }

  drawFormat(mask) {
    const bits = formatBits(mask);
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.setFixed(8, i, bit(bits, i));
    this.setFixed(8, 7, bit(bits, 6));
    this.setFixed(8, 8, bit(bits, 7));
    this.setFixed(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFixed(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.setFixed(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFixed(8, size - 15 + i, bit(bits, i));
    this.setFixed(8, size - 8, true);
  }

  drawVersion() {
    if (this.ver < 7) return;
    let rem = this.ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFixed(a, b, bit(bits, i));
      this.setFixed(b, a, bit(bits, i));
    }
  }

  /** Zig-zag placement; also used by the tests to read codewords back. */
  eachDataModule(fn) {
    const { size } = this;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!this.fixed[y][x]) fn(x, y);
        }
      }
    }
  }

  drawCodewords(data) {
    let i = 0;
    this.eachDataModule((x, y) => {
      if (i < data.length * 8) this.dark[y][x] = bit(data[i >>> 3], 7 - (i & 7));
      i++;
    });
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.fixed[y][x] && maskHit(mask, x, y)) this.dark[y][x] = !this.dark[y][x];
      }
    }
  }
}

const FINDER_LIKE = ['10111010000', '00001011101'];

/** The standard penalty score (rules N1-N4); lower scans better. */
function penalty(dark) {
  const size = dark.length;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(dark[i].map((d) => (d ? '1' : '0')).join(''));
    lines.push(dark.map((r) => (r[i] ? '1' : '0')).join(''));
  }
  let score = 0;
  for (const line of lines) {
    for (const run of line.match(/0+|1+/g)) if (run.length >= 5) score += run.length - 2;
    for (const p of FINDER_LIKE) for (let k = line.indexOf(p); k !== -1; k = line.indexOf(p, k + 1)) score += 40;
  }
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dark[y][x]) darkCount++;
      if (x < size - 1 && y < size - 1) {
        const c = dark[y][x];
        if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
      }
    }
  }
  const total = size * size;
  return score + Math.max(0, Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
}

/**
 * @param {string} text
 * @returns {{size:number, bits:string, version:number, mask:number}|null} null when empty or too long
 */
function encodeQr(text) {
  if (typeof text !== 'string' || !text) return null;
  const bytes = [...Buffer.from(text, 'utf8')];
  let ver = 1;
  while (ver <= MAX_VERSION && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > MAX_VERSION) return null;
  const codewords = interleave(dataBytes(bytes, ver), ver);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = new Grid(ver);
    g.drawFunctionPatterns();
    g.drawCodewords(codewords);
    g.applyMask(mask);
    g.drawFormat(mask);
    const score = penalty(g.dark);
    if (!best || score < best.score) best = { score, grid: g, mask };
  }
  const bits = best.grid.dark.map((r) => r.map((d) => (d ? '1' : '0')).join('')).join('');
  return { size: best.grid.size, bits, version: ver, mask: best.mask };
}

module.exports = { encodeQr, maskHit, formatBits, alignmentPositions, dataCodewords, Grid };
