// ============================================================================
// LunaCore - which process holds a file open (Windows Restart Manager)
// ----------------------------------------------------------------------------
// Used when a build fails with EBUSY: the failure reason names the holder
// instead of leaving a bare "resource busy or locked". Add-Type compiles C#
// first, which took about 20 s on a loaded machine: hence the long timeout.
//
// One PowerShell process compiles a tiny Restart Manager wrapper (Add-Type)
// and asks RmGetList who has the file open. The script is a fixed constant
// sent as -EncodedCommand; the file path reaches it only through an
// environment variable, never through the command line. Every failure is
// an answer ({ok:false, reason}), never a throw.
// ============================================================================

'use strict';

const path = require('path');
const { execFile } = require('child_process');

const LOOKUP_TIMEOUT_MS = 45 * 1000;
const MAX_HOLDERS = 5;
const MAX_NAME = 80;
const PATH_ENV = 'LUNA_LOCKED_FILE';

// RmGetList: ERROR_MORE_DATA (234) is the "here is how many" answer.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LunaRm {
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nSvcs, string[] svcs);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static string Holders(string file) {
    uint h; var key = new StringBuilder(64);
    int rc = RmStartSession(out h, 0, key);
    if (rc != 0) throw new Exception("RmStartSession " + rc);
    try {
      rc = RmRegisterResources(h, 1, new string[] { file }, 0, IntPtr.Zero, 0, null);
      if (rc != 0) throw new Exception("RmRegisterResources " + rc);
      uint needed = 0, count = 0, reasons = 0;
      rc = RmGetList(h, out needed, ref count, null, ref reasons);
      if (rc == 0) return "";
      if (rc != 234) throw new Exception("RmGetList " + rc);
      var info = new RM_PROCESS_INFO[needed];
      count = needed;
      rc = RmGetList(h, out needed, ref count, info, ref reasons);
      if (rc != 0) throw new Exception("RmGetList " + rc);
      var sb = new StringBuilder();
      for (int i = 0; i < count; i++) {
        string app = (info[i].strAppName ?? "").Replace('\\r', ' ').Replace('\\n', ' ').Replace('\\t', ' ');
        sb.Append(info[i].Process.dwProcessId).Append('\\t').Append(app).Append('\\n');
      }
      return sb.ToString();
    } finally { RmEndSession(h); }
  }
}
'@
foreach ($line in [LunaRm]::Holders($env:${PATH_ENV}) -split "\`n") {
  if (-not $line) { continue }
  $id, $app = $line -split "\`t", 2
  $exe = ''
  try { $exe = (Get-Process -Id ([int]$id)).ProcessName + '.exe' } catch { $exe = '' }
  "$id\`t$app\`t$exe"
}
`;

const encoded = () => Buffer.from(SCRIPT, 'utf16le').toString('base64');

const clip = (v) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_NAME);

/**
 * Pure. The script's `pid<TAB>appName<TAB>exe` lines as holders.
 * @param {string} stdout
 * @returns {{pid:number, app:string, exe:string}[]}
 */
function parseHolders(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((cols) => /^\d{1,10}$/.test((cols[0] || '').trim()))
    .slice(0, MAX_HOLDERS)
    .map(([pid, app, exe]) => ({ pid: Number(pid.trim()), app: clip(app), exe: clip(exe) }));
}

/**
 * Pure. Holders in words: 'electron.exe (pid 123), Code.exe (pid 9)'.
 * @param {{pid:number, app:string, exe:string}[]} holders
 * @returns {string}
 */
function describeHolders(holders) {
  return (Array.isArray(holders) ? holders : []).map((h) => `${h.exe || h.app || 'unknown process'} (pid ${h.pid})`).join(', ');
}

/**
 * Pure. The path an EBUSY error names ("EBUSY: resource busy or locked,
 * unlink 'C:\\...\\app.asar'"), or null.
 * @param {string} output tool output
 * @returns {string|null}
 */
function lockedPathOf(output) {
  // Greedy to the last quote on the line: a path may hold an apostrophe (O'Brien).
  const m = /EBUSY: resource busy or locked, \w+ '(.{1,1024})'/.exec(String(output || ''));
  return m ? m[1] : null;
}

/**
 * Who has `file` open, by the Restart Manager.
 * @param {string} file absolute path
 * @param {{exec?:Function, platform?:string, env?:object}} [deps]
 * @returns {Promise<{ok:true, holders:{pid:number, app:string, exe:string}[]}|{ok:false, reason:string}>} never rejects
 */
function findLockHolders(file, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return Promise.resolve({ ok: false, reason: 'lookup needs Windows' });
  if (typeof file !== 'string' || !file || file.length > 1024) return Promise.resolve({ ok: false, reason: 'no file' });
  const run = deps.exec || execFile;
  const baseEnv = deps.env || process.env;
  // The system copy by full path: a bare name could resolve from the cwd first.
  const bin = path.join(baseEnv.SystemRoot || process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded()];
  const env = { ...baseEnv, [PATH_ENV]: file };
  return new Promise((resolve) => {
    try {
      run(bin, args, { windowsHide: true, timeout: LOOKUP_TIMEOUT_MS, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const why = err.killed ? 'lookup timed out' : clip(String(stderr || '').split(/\r?\n/).find(Boolean) || err.message);
          resolve({ ok: false, reason: `lock holder lookup failed: ${why}` });
          return;
        }
        resolve({ ok: true, holders: parseHolders(stdout) });
      });
    } catch (err) {
      resolve({ ok: false, reason: `lock holder lookup failed: ${clip(err instanceof Error ? err.message : err)}` });
    }
  });
}

module.exports = { findLockHolders, parseHolders, describeHolders, lockedPathOf, LOOKUP_TIMEOUT_MS };
