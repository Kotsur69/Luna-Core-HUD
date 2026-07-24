// ============================================================================
// LunaCore - szacowanie kosztu sesji (B4)
// ----------------------------------------------------------------------------
// Laduje cennik z config/rates.json (+ gitignorowany rates.local.json) i liczy
// koszt z LICZNIKOW TOKENOW, ktore i tak juz czytamy z transkryptu. Zero sieci,
// zero tokenow - to nadal Passive Observer, tylko z mnozeniem.
//
// DLACZEGO CENNIK JEST W CONFIGU: ceny sie zmieniaja, a kod nie powinien klamac.
// Nieznany model => BRAK szacunku (null), nigdy zgadywana liczba. Falszywa kwota
// jest gorsza niz zadna, bo wyglada na prawdziwa.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BASE_FILE = path.join(CONFIG_DIR, 'rates.json');
const LOCAL_FILE = path.join(CONFIG_DIR, 'rates.local.json');

const TOKENS_PER_UNIT = 1000000; // ceny sa "za milion tokenow"

// Awaryjne mnozniki cache, gdy config ich nie poda.
const FALLBACK_CACHE_READ = 0.1;
const FALLBACK_CACHE_WRITE = 1.25;

/** Bezpieczny odczyt + parse JSON. Zwraca null przy braku/bledzie. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Waliduje pojedynczy wpis cennika. Zwraca obiekt lub null. */
function normalizeRate(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.input !== 'number' || !(r.input >= 0)) return null;
  if (typeof r.output !== 'number' || !(r.output >= 0)) return null;
  return { id: r.id, input: r.input, output: r.output };
}

/**
 * Laduje cennik: base scalony z local (local nadpisuje po id).
 * @returns {{rates: Array, cacheReadMultiplier: number, cacheWriteMultiplier: number}}
 */
function loadRates() {
  const base = readJson(BASE_FILE) || {};
  const local = readJson(LOCAL_FILE);

  const byId = new Map();
  const collect = (src) => {
    if (!src || !Array.isArray(src.rates)) return;
    for (const raw of src.rates) {
      const r = normalizeRate(raw);
      if (r) byId.set(r.id, r);
    }
  };
  collect(base);
  collect(local);

  const pick = (key, fallback) => {
    for (const src of [local, base]) {
      if (src && typeof src[key] === 'number' && src[key] >= 0) return src[key];
    }
    return fallback;
  };

  return {
    rates: [...byId.values()],
    cacheReadMultiplier: pick('cacheReadMultiplier', FALLBACK_CACHE_READ),
    cacheWriteMultiplier: pick('cacheWriteMultiplier', FALLBACK_CACHE_WRITE),
  };
}

/**
 * Dobiera stawke do id modelu. Dopasowanie dokladne, a jak nie ma - najdluzszy
 * pasujacy prefiks (transkrypt bywa z sufiksem daty: "claude-opus-4-8-20260115").
 * Brak dopasowania => null (patrz naglowek: wolimy brak liczby niz zla liczbe).
 * @returns {{id:string,input:number,output:number}|null}
 */
function rateFor(model, rates) {
  const id = String(model || '').toLowerCase();
  if (!id || !Array.isArray(rates)) return null;

  let best = null;
  for (const r of rates) {
    const candidate = r.id.toLowerCase();
    if (id === candidate) return r;
    if (id.startsWith(candidate) && (!best || candidate.length > best.id.length)) {
      best = r;
    }
  }
  return best;
}

/**
 * Szacuje koszt z sumarycznych licznikow tokenow.
 * @param {{input?:number,output?:number,cacheRead?:number,cacheWrite?:number}} totals
 * @param {{input:number,output:number}} rate
 * @param {{cacheReadMultiplier?:number,cacheWriteMultiplier?:number}} [mult]
 * @returns {{usd:number, input:number, output:number, cacheRead:number, cacheWrite:number}|null}
 */
function estimateCost(totals, rate, mult = {}) {
  if (!rate || !totals) return null;
  const readMult =
    typeof mult.cacheReadMultiplier === 'number' ? mult.cacheReadMultiplier : FALLBACK_CACHE_READ;
  const writeMult =
    typeof mult.cacheWriteMultiplier === 'number' ? mult.cacheWriteMultiplier : FALLBACK_CACHE_WRITE;

  const per = (tokens, price) => ((tokens || 0) / TOKENS_PER_UNIT) * price;
  const input = per(totals.input, rate.input);
  const output = per(totals.output, rate.output);
  // Cache wycenia sie od stawki WEJSCIOWEJ, przemnozonej przez mnoznik.
  const cacheRead = per(totals.cacheRead, rate.input * readMult);
  const cacheWrite = per(totals.cacheWrite, rate.input * writeMult);

  return { usd: input + output + cacheRead + cacheWrite, input, output, cacheRead, cacheWrite };
}

/** Formatuje kwote do kafelka: male kwoty potrzebuja wiecej miejsc po przecinku. */
function formatUsd(usd) {
  if (typeof usd !== 'number' || !isFinite(usd) || usd < 0) return '';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

module.exports = { loadRates, rateFor, estimateCost, formatUsd, normalizeRate };
