// Tests for the skill categorization heuristic. The function itself is pure -
// the disk scan (scanSkills) lives separately and is not touched here.
//
// Note: the heuristic is deliberately rough ("first match wins"). These tests
// pin down its DOCUMENTED behavior, not an ideal - so a later change to the
// category order will flag here immediately.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { categorize } = require('../src/skills');

/** Shorthand: builds a skill object in the shape categorize() expects. */
const skill = (name, description = '', file = '') => ({ name, description, file });

test('categorize recognizes categories by name', () => {
  assert.equal(categorize(skill('react-patterns')), 'frontend');
  assert.equal(categorize(skill('fastapi-patterns')), 'backend');
  assert.equal(categorize(skill('pytest-runner')), 'tests');
  assert.equal(categorize(skill('postgres-patterns')), 'database');
  assert.equal(categorize(skill('docker-compose-helper')), 'devops');
  assert.equal(categorize(skill('owasp-checklist')), 'security');
});

test('categorize also reads the description, not just the name', () => {
  assert.equal(categorize(skill('something', 'Builds CSS components and styles')), 'frontend');
});

test('categorize also reads the file path', () => {
  assert.equal(categorize(skill('aaa', '', '/home/mati/.claude/skills/react-thing/SKILL.md')), 'frontend');
});

test('categorize is case-insensitive', () => {
  assert.equal(categorize(skill('REACT-Patterns')), 'frontend');
  assert.equal(categorize(skill('Docker')), 'devops');
});

test('categorize applies the "first match wins" rule', () => {
  // 'react' (Frontend) is checked before 'api' (Backend) - the CATEGORIES
  // order here is behavior, not an accident.
  assert.equal(categorize(skill('react-api-client')), 'frontend');
});

test('categorize dumps unmatched skills into the "other" category', () => {
  assert.equal(categorize(skill('aaa')), 'other');
  assert.equal(categorize(skill('zzz', 'a completely unrelated description')), 'other');
});

test('categorize does not choke on empty fields', () => {
  assert.equal(categorize(skill('', '', '')), 'other');
});
