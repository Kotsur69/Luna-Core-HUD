'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clearLineSequence } = require('../src/shellClearLine');

test('powershell clears with Esc', () => {
  assert.equal(clearLineSequence('powershell.exe'), '\x1b');
  assert.equal(clearLineSequence('PowerShell'), '\x1b');
});

test('pwsh clears with Esc, by name and by path', () => {
  assert.equal(clearLineSequence('pwsh'), '\x1b');
  assert.equal(clearLineSequence('C:\\Program Files\\PowerShell\\7\\PWSH.EXE'), '\x1b');
});

test('bash and zsh clear with Ctrl+U, by name and by path', () => {
  assert.equal(clearLineSequence('bash'), '\x15');
  assert.equal(clearLineSequence('/bin/bash'), '\x15');
  assert.equal(clearLineSequence('/usr/bin/zsh'), '\x15');
  assert.equal(clearLineSequence('sh'), '\x15');
});

test('cmd clears with Esc', () => {
  assert.equal(clearLineSequence('cmd.exe'), '\x1b');
  assert.equal(clearLineSequence('C:\\Windows\\System32\\cmd.exe'), '\x1b');
});

test('unknown or missing shell falls back to Ctrl+U', () => {
  assert.equal(clearLineSequence('fish'), '\x15');
  assert.equal(clearLineSequence(''), '\x15');
  assert.equal(clearLineSequence(undefined), '\x15');
});
