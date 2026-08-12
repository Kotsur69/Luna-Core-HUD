// ============================================================================
// LunaCore - Windows SAPI TTS wrapper (§11.2)
// ----------------------------------------------------------------------------
// Synthesizes arbitrary text to a WAV file via helpers/tts/sapi-speak.ps1
// (System.Speech, fully offline - ZERO EXTRA TOKENS, see
// SOUNDS_IMPLEMENTATION_PLAN.md #11.2 and ttsExtract.js). `text` never
// touches a command line: it is written to a temp .txt file the fixed
// PowerShell script reads with Get-Content, and spawn() is called with an
// args array (no shell), so nothing in Claude's own output - quotes,
// backticks, `$vars` - can be interpreted as a shell/PowerShell token.
//
// Fails silent, same degrade-gracefully rule as soundManager.js: non-Windows,
// a spawn failure, a timeout, or a missing output file all resolve to null,
// never a crash or a surfaced error.
//
// Not unit-tested (thin OS-process wrapper, same as soundManager.js/
// PortWatcher aren't) - the pure piece (text extraction) lives in
// ttsExtract.js and IS tested.
// ============================================================================

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';
const SCRIPT_PATH = path.join(__dirname, '..', 'helpers', 'tts', 'sapi-speak.ps1');

// Generous but bounded - a stuck/missing SAPI voice must not hang the
// narration channel forever.
const SYNTH_TIMEOUT_MS = 20000;

let seq = 0;

/** Absolute path for a fresh temp file scoped to this process + call. */
function tempFile(ext) {
  seq += 1;
  return path.join(os.tmpdir(), `lunacore-tts-${process.pid}-${Date.now()}-${seq}.${ext}`);
}

/**
 * Synthesizes `text` to a WAV file via Windows SAPI. The WAV file is left on
 * disk for the caller to play (soundManager plays it async) and is not
 * cleaned up here - same "let the OS temp dir sweep it" tradeoff mpv's own
 * IPC socket path takes, kept simple on purpose.
 * @param {string} text
 * @returns {Promise<string|null>} absolute path to the WAV file, or null on
 *   any failure (non-Windows, empty text, spawn error, timeout, non-zero exit)
 */
function synthesizeToWav(text) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!IS_WINDOWS || !clean) return Promise.resolve(null);

  const textFile = tempFile('txt');
  const wavFile = tempFile('wav');

  try {
    fs.writeFileSync(textFile, clean, 'utf8');
  } catch {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        fs.unlinkSync(textFile);
      } catch {
        /* best effort - temp dir gets swept eventually either way */
      }
      resolve(result);
    };

    let proc;
    try {
      proc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          SCRIPT_PATH,
          '-TextFile',
          textFile,
          '-WavFile',
          wavFile,
        ],
        { stdio: 'ignore', windowsHide: true },
      );
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
      finish(null);
    }, SYNTH_TIMEOUT_MS);

    proc.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0 && fs.existsSync(wavFile) ? wavFile : null);
    });
  });
}

module.exports = { synthesizeToWav };
