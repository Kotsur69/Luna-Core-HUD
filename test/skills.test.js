// Testy heurystyki kategoryzacji skilli. Sama funkcja jest czysta - skan dysku
// (scanSkills) siedzi osobno i nie jest tu dotykany.
//
// Uwaga: heurystyka jest z zalozenia zgrubna ("pierwsze trafienie wygrywa").
// Te testy przypinaja jej UDOKUMENTOWANE zachowanie, a nie ideal - dzieki temu
// pozniejsza zmiana kolejnosci kategorii od razu sie tu zapali.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { categorize } = require('../src/skills');

/** Skrot: buduje obiekt skilla w ksztalcie, jakiego oczekuje categorize(). */
const skill = (name, description = '', file = '') => ({ name, description, file });

test('categorize rozpoznaje kategorie po nazwie', () => {
  assert.equal(categorize(skill('react-patterns')), 'Frontend');
  assert.equal(categorize(skill('fastapi-patterns')), 'Backend');
  assert.equal(categorize(skill('pytest-runner')), 'Testy');
  assert.equal(categorize(skill('postgres-patterns')), 'Database');
  assert.equal(categorize(skill('docker-compose-helper')), 'DevOps / Deploy');
  assert.equal(categorize(skill('owasp-checklist')), 'Security');
});

test('categorize czyta rowniez opis, nie tylko nazwe', () => {
  assert.equal(categorize(skill('cos-tam', 'Buduje komponenty i style CSS')), 'Frontend');
});

test('categorize czyta rowniez sciezke pliku', () => {
  assert.equal(categorize(skill('aaa', '', '/home/mati/.claude/skills/react-thing/SKILL.md')), 'Frontend');
});

test('categorize jest niewrazliwa na wielkosc liter', () => {
  assert.equal(categorize(skill('REACT-Patterns')), 'Frontend');
  assert.equal(categorize(skill('Docker')), 'DevOps / Deploy');
});

test('categorize stosuje zasade "pierwsze trafienie wygrywa"', () => {
  // 'react' (Frontend) jest sprawdzany przed 'api' (Backend) - kolejnosc
  // CATEGORIES jest tu zachowaniem, nie przypadkiem.
  assert.equal(categorize(skill('react-api-client')), 'Frontend');
});

test('categorize wrzuca niedopasowane skille do kategorii "Inne"', () => {
  assert.equal(categorize(skill('aaa')), 'Inne');
  assert.equal(categorize(skill('zzz', 'zupelnie nieokreslony opis')), 'Inne');
});

test('categorize nie wywraca sie na pustych polach', () => {
  assert.equal(categorize(skill('', '', '')), 'Inne');
});
