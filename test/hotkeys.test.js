// Tests for the navigation-chord resolvers behind Alt+Left/Right (tab bar)
// and Alt+1..9 (project jump). The chords themselves live inside
// createWindow's before-input-event handler, which needs a real Electron
// window; what a chord RESOLVES TO is pure, and that is what is pinned here.
//
// The crux case is the no-op: a single open tab has nowhere to move, and the
// main.js side reads that null as "stay put and stay silent" rather than
// re-activating the tab already on screen.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROJECT_DIGIT_MAX,
  cycleSessionId,
  parseDigitCode,
  projectIdForDigit,
  findSessionIdForProject,
} = require('../src/hotkeys');

// ---- cycleSessionId ---------------------------------------------------------

test('cycleSessionId steps right to the next tab', () => {
  assert.equal(cycleSessionId(['s1', 's2', 's3'], 's1', 1), 's2');
});

test('cycleSessionId steps left to the previous tab', () => {
  assert.equal(cycleSessionId(['s1', 's2', 's3'], 's2', -1), 's1');
});

test('cycleSessionId wraps past the last tab round to the first', () => {
  assert.equal(cycleSessionId(['s1', 's2', 's3'], 's3', 1), 's1');
});

test('cycleSessionId wraps before the first tab round to the last', () => {
  assert.equal(cycleSessionId(['s1', 's2', 's3'], 's1', -1), 's3');
});

test('cycleSessionId returns null for a single open tab (nowhere to move)', () => {
  assert.equal(cycleSessionId(['s1'], 's1', 1), null);
  assert.equal(cycleSessionId(['s1'], 's1', -1), null);
});

test('cycleSessionId returns null when there are no tabs at all', () => {
  assert.equal(cycleSessionId([], null, 1), null);
});

test('cycleSessionId lands on the first tab when the active one is unknown', () => {
  // e.g. the active tab was closed between the keystroke and this call
  assert.equal(cycleSessionId(['s1', 's2'], 'gone', -1), 's1');
});

test('cycleSessionId returns null when a full lap lands back on the same tab', () => {
  assert.equal(cycleSessionId(['s1', 's2', 's3'], 's2', 3), null);
});

test('cycleSessionId rejects a non-array and a non-integer step', () => {
  assert.equal(cycleSessionId(null, 's1', 1), null);
  assert.equal(cycleSessionId(['s1', 's2'], 's1', 1.5), null);
});

// ---- parseDigitCode ---------------------------------------------------------

test('parseDigitCode reads the digit out of a top-row key code', () => {
  assert.equal(parseDigitCode('Digit1'), 1);
  assert.equal(parseDigitCode('Digit9'), 9);
});

test('parseDigitCode rejects Digit0 - there is no tenth project slot', () => {
  assert.equal(parseDigitCode('Digit0'), null);
});

test('parseDigitCode rejects numpad and non-digit codes', () => {
  // Numpad keys report as ArrowLeft/ArrowRight with NumLock off, which the
  // tab chords already claim - accepting them here would be a collision.
  assert.equal(parseDigitCode('Numpad3'), null);
  assert.equal(parseDigitCode('KeyT'), null);
  assert.equal(parseDigitCode(''), null);
  assert.equal(parseDigitCode(undefined), null);
});

// ---- projectIdForDigit ------------------------------------------------------

const PROJECTS = [
  { id: 'home', label: 'Home (~)', path: '~' },
  { id: 'lunacore', label: 'Luna-Core-HUD', path: '~/repos/Luna-Core-HUD' },
];

test('projectIdForDigit maps Alt+1 to the first entry in the switcher order', () => {
  assert.equal(projectIdForDigit(PROJECTS, 1), 'home');
});

test('projectIdForDigit maps Alt+2 to the second entry', () => {
  assert.equal(projectIdForDigit(PROJECTS, 2), 'lunacore');
});

test('projectIdForDigit returns null for a digit past the end of the list', () => {
  assert.equal(projectIdForDigit(PROJECTS, 3), null);
});

test('projectIdForDigit refuses digits outside 1..9', () => {
  assert.equal(projectIdForDigit(PROJECTS, 0), null);
  assert.equal(projectIdForDigit(PROJECTS, PROJECT_DIGIT_MAX + 1), null);
  assert.equal(projectIdForDigit(PROJECTS, 1.5), null);
});

test('projectIdForDigit tolerates a missing or malformed list', () => {
  assert.equal(projectIdForDigit(null, 1), null);
  assert.equal(projectIdForDigit([{ label: 'no id' }], 1), null);
  assert.equal(projectIdForDigit([{ id: '' }], 1), null);
});

test('projectIdForDigit reaches the ninth slot when the list is long enough', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}` }));
  assert.equal(projectIdForDigit(many, PROJECT_DIGIT_MAX), 'p9');
});

// ---- findSessionIdForProject ------------------------------------------------
// This is what keeps the project chords non-destructive: main.js focuses the
// tab this returns, and only opens a new one when it returns null. It never
// restarts anything, so a mistyped digit cannot kill a running session.

const TABS = [
  { id: 's1', projectId: 'home' },
  { id: 's2', projectId: 'lunacore' },
  { id: 's3', projectId: 'lunacore' },
];

test('findSessionIdForProject finds the tab already running that project', () => {
  assert.equal(findSessionIdForProject(TABS, 'home'), 's1');
});

test('findSessionIdForProject returns the leftmost tab when several match', () => {
  // Deliberately not "cycle through them" - one chord, one destination.
  assert.equal(findSessionIdForProject(TABS, 'lunacore'), 's2');
});

test('findSessionIdForProject returns null when no tab runs that project', () => {
  // main.js reads this as "open a new tab there".
  assert.equal(findSessionIdForProject(TABS, 'somewhere-else'), null);
});

test('findSessionIdForProject ignores tabs with no project of their own', () => {
  assert.equal(findSessionIdForProject([{ id: 's1', projectId: null }], 'home'), null);
});

test('findSessionIdForProject tolerates a missing list or a blank id', () => {
  assert.equal(findSessionIdForProject(null, 'home'), null);
  assert.equal(findSessionIdForProject(TABS, ''), null);
  assert.equal(findSessionIdForProject(TABS, undefined), null);
  assert.equal(findSessionIdForProject([{ projectId: 'home' }], 'home'), null);
});
