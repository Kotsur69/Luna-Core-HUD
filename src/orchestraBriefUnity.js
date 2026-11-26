// ============================================================================
// LunaCore - the Unity rule of a God Mode worker brief (src/orchestra.js briefText)
// ----------------------------------------------------------------------------
// 2026-11-25: a worker building LunaCore's own Unity asset commands verified
// them live against the only open Unity editor, which held the game. It left
// Assets/_LunaVerify_*/, a prefab and console errors the Playtester then
// charged to the game. A package that touches Unity gets one rule line.
//
// Detection is a text match on the package's title, prompt and files. A false
// positive only adds one line to a brief, so the match is deliberately wide;
// a package that never names Unity, the playtest bridge or the Pipeline
// client is very unlikely to drive a Unity editor.
// ============================================================================

'use strict';

const UNITY_PACKAGE_RE = /\bunity\b|unityMCP|playtest-bridge|pipeline-http|unity-pipeline-port|lunasworkUnity/i;

// 2026-11-26: workers on the Unity game committed grep.cmd, unity.cmd and
// wrapper .ps1 scripts so that God Mode's verify (run through cmd.exe) would
// pass; the last sentence forbids such shims.
const UNITY_LIVE_RULE =
  "- Unity: never write into a Unity project that another run or Mati owns (the game open in Mati's editor included). A live check that writes (assets, prefabs, scenes, `script eval`, menu items, play mode) needs a scratch Unity project or Mati's explicit OK. Without either, verify with mocked tests and say so in your final message. Never add files whose only purpose is to make a LunaCore verify or check command pass (unity.cmd, grep.cmd, wrapper .ps1 scripts, a package.json with a test script); if a check cannot run here, say so in your final message.";

/**
 * True when a package's text says it works on Unity.
 * @param {{title?:unknown, prompt?:unknown, files?:unknown}} pkg
 */
function isUnityPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  const files = Array.isArray(pkg.files) ? pkg.files.filter((f) => typeof f === 'string') : [];
  const text = [pkg.title, pkg.prompt, ...files].filter((v) => typeof v === 'string').join('\n');
  return UNITY_PACKAGE_RE.test(text);
}

/** The brief's Rules lines for this package: the Unity rule, or none. */
const unityRuleLines = (pkg) => (isUnityPackage(pkg) ? [UNITY_LIVE_RULE] : []);

module.exports = { UNITY_LIVE_RULE, isUnityPackage, unityRuleLines };
