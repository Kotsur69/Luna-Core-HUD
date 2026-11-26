'use strict';

// Sequence that empties a shell's current input line, so stray keystrokes that
// landed in a freshly spawned tab are not glued in front of a start command.

const ESC = '\x1b';
const CTRL_U = '\x15';

// PSReadLine (PowerShell / pwsh) binds Esc to RevertLine; cmd.exe's Esc also
// erases the current line.
const ESC_SHELLS = new Set(['powershell', 'pwsh', 'cmd']);
// Readline-style shells bind Ctrl+U to "kill the line before the cursor".
const CTRL_U_SHELLS = new Set(['bash', 'zsh', 'sh']);

/**
 * Lowercase shell name without directory or extension, from a name or a path
 * written with either separator (C:\...\pwsh.exe, /bin/bash).
 * @param {unknown} shell
 * @returns {string}
 */
function shellName(shell) {
  if (typeof shell !== 'string') return '';
  const base = shell.trim().split(/[\\/]/).pop() || '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/**
 * @param {unknown} shell shell name or full path, case-insensitive
 * @returns {string} bytes to write to the pty before a command. An unknown
 *   shell gets Ctrl+U: harmless in most line editors, whereas a stray Esc can
 *   start a vi-mode or meta sequence.
 */
function clearLineSequence(shell) {
  const name = shellName(shell);
  if (ESC_SHELLS.has(name)) return ESC;
  if (CTRL_U_SHELLS.has(name)) return CTRL_U;
  return CTRL_U;
}

module.exports = { clearLineSequence, shellName };
