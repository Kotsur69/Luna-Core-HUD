// ============================================================================
// LunaCore - wiedza o modelach (okno kontekstu + ladna etykieta)
// ----------------------------------------------------------------------------
// Czysty modul: string -> liczba / string. Zero I/O, zero sieci, zero tokenow.
// Zastepuje stala CONTEXT_LIMIT=200000, przez ktora pasek kontekstu KLAMAL na
// sesjach z oknem 1M (pokazywal 100% przy 200k, choc bylo dopiero 20%).
//
// UCZCIWA UWAGA CO DO WYKRYWANIA 1M:
//   Plan zakladal, ze okno da sie wyczytac z samego id modelu. W praktyce 1M
//   bywa WLASCIWOSCIA SESJI (naglowek beta), a nie czescia id w transkrypcie -
//   wiec samo id czesto nie wystarcza. Dlatego mamy DWA sygnaly:
//     1. marker "1m" w id modelu (gdy jest - wierzymy mu),
//     2. OBSERWACJA: jesli liczba tokenow przekroczyla zakladane okno, to
//        zalozenie bylo zle. Kontekst nie moze przekroczyc wlasnego okna, wiec
//        awansujemy do najblizszego znanego progu.
//   Sygnal (2) jest tym, ktory naprawia pasek sam z siebie - bez niego pasek
//   staje przypiety do 100%, a uzbrojony auto-compact moglby strzelac bez powodu.
// ============================================================================

'use strict';

/** Domyslne okno kontekstu rodziny Claude. */
const DEFAULT_CONTEXT_LIMIT = 200000;

/** Znane progi okien kontekstu, rosnaco. */
const KNOWN_TIERS = [200000, 1000000];

/**
 * Realne okna kontekstu znanych modeli (prefiks id -> limit).
 *
 * POPRAWKA 2026-07-24: pierwsza wersja tego pliku zakladala 200k dla wszystkiego
 * i awansowala dopiero z obserwacji. To bylo zle: biezaca rodzina Claude ma okno
 * 1M (wyjatek: Haiku 4.5 = 200k), wiec pasek pokazywalby 100% przy 20% i
 * uzbrojony auto-compact strzelalby duzo za wczesnie. Obserwacja zostaje jako
 * druga linia obrony, ale nie moze byc pierwsza - zanim zadziala, pasek juz sklamal.
 */
const MODEL_WINDOWS = [
  { prefix: 'claude-haiku-4-5', limit: 200000 },
  { prefix: 'claude-opus-4-8', limit: 1000000 },
  { prefix: 'claude-opus-4-7', limit: 1000000 },
  { prefix: 'claude-opus-4-6', limit: 1000000 },
  { prefix: 'claude-sonnet-5', limit: 1000000 },
  { prefix: 'claude-sonnet-4-6', limit: 1000000 },
  { prefix: 'claude-fable-5', limit: 1000000 },
  { prefix: 'claude-mythos-5', limit: 1000000 },
];

/** Szuka okna po najdluzszym pasujacym prefiksie id. Zwraca null, gdy brak. */
function windowFromTable(id) {
  let best = null;
  for (const row of MODEL_WINDOWS) {
    if (id.startsWith(row.prefix) && (!best || row.prefix.length > best.prefix.length)) {
      best = row;
    }
  }
  return best ? best.limit : null;
}

/** Rodziny modeli rozpoznawane przy budowaniu etykiety. */
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

/** Czy id modelu niesie marker okna 1M (np. "sonnet-4-5-1m", "...[1m]"). */
function hasOneMillionMarker(id) {
  return /(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(id);
}

/**
 * Zwraca okno kontekstu dla modelu.
 * @param {string} model id modelu z transkryptu (moze byc pusty/nieznany)
 * @param {number} [observedTokens] realnie zaobserwowane zuzycie - sygnal
 *   korygujacy, gdy id modelu nie mowi prawdy o oknie
 * @returns {number}
 */
function contextLimitFor(model, observedTokens = 0) {
  const id = String(model || '').toLowerCase();
  // Kolejnosc sygnalow: jawny marker 1m > tablica znanych modeli > domyslne 200k.
  let limit = hasOneMillionMarker(id) ? 1000000 : windowFromTable(id) || DEFAULT_CONTEXT_LIMIT;

  // Korekta z obserwacji: kontekst nie moze byc wiekszy niz jego wlasne okno.
  if (observedTokens > limit) {
    limit =
      KNOWN_TIERS.find((tier) => tier >= observedTokens) ||
      KNOWN_TIERS[KNOWN_TIERS.length - 1];
  }
  return limit;
}

/**
 * Zamienia id modelu na krotka etykiete do kafelka ("claude-opus-4-8" ->
 * "Opus 4.8"). Nieznane id (np. lokalny model z LM Studio) zwracamy BEZ ZMIAN -
 * lepiej pokazac surowa nazwe niz zgadywac i sklamac.
 * @param {string} model
 * @returns {string}
 */
function modelLabel(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';

  const s = raw
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '') // data wydania: -20250929
    .replace(/-latest$/, '');

  const oneM = hasOneMillionMarker(s);
  const family = FAMILIES.find((f) => s.includes(f));
  if (!family) return raw; // nieznana rodzina - oddaj oryginal

  // Wersja to ostatnia grupa cyfr (dziala i dla "opus-4-8", i dla "3-5-sonnet").
  const withoutMarker = s.replace(/(^|[^a-z0-9])1m([^a-z0-9]|$)/, '$1');
  const groups = withoutMarker.match(/\d+(?:-\d+)*/g) || [];
  const version = groups.length > 0 ? groups[groups.length - 1].replace(/-/g, '.') : '';

  const name = family[0].toUpperCase() + family.slice(1);
  const label = version ? `${name} ${version}` : name;
  return oneM ? `${label} 1M` : label;
}

module.exports = {
  contextLimitFor,
  modelLabel,
  DEFAULT_CONTEXT_LIMIT,
  KNOWN_TIERS,
  MODEL_WINDOWS,
};
