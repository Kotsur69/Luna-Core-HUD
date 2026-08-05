// ============================================================================
// LunaCore - lokalny brudnopis (scratchpad)
// ----------------------------------------------------------------------------
// Notatnik na uboczu sesji: wklejone sniplety, TODO na pozniej, fragmenty
// odpowiedzi Claude. Trzymany jako zwykly plik tekstowy, zeby dalo sie go
// otworzyc/zgrepowac poza aplikacja.
//
// Plik jest w .gitignore (tresc = prywatne notatki, nie do repo).
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');

// Prywatne notatki = stan per-maszyna, wiec plik lezy w KATALOGU ZAPISYWALNYM:
// w klonie dev to nadal repo config/, w wersji spakowanej %APPDATA%/LunaCore/
// config (albo folder obok .exe w wersji portable). Sciezka liczona przy kazdym
// wywolaniu, bo modul jest wymagany przed app.whenReady().
const file = () => paths.local('scratchpad.local.md');

// Gorna granica zapisu: brudnopis to notatnik, nie magazyn plikow.
// Chroni przed przypadkowym wklejeniem kilkunastu MB do panelu.
const MAX_BYTES = 256 * 1024;

/** Zwraca tresc brudnopisu; pusty string, gdy pliku jeszcze nie ma. */
function readScratchpad() {
  try {
    return fs.readFileSync(file(), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Zapisuje tresc brudnopisu (walidacja na granicy: typ + rozmiar).
 * @param {string} text
 * @returns {boolean} czy zapis sie powiodl
 */
function writeScratchpad(text) {
  if (typeof text !== 'string') return false;
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return false;
  try {
    paths.ensureUserDir();
    fs.writeFileSync(file(), text, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { readScratchpad, writeScratchpad, MAX_BYTES };
