#!/usr/bin/env node
// ============================================================================
// LunaCore - ECC parity check between the native and GLM runners
// ----------------------------------------------------------------------------
// Answers one question: do both runners see the same tools, skills, plugins,
// hooks and MCP servers, and does ONLY the model route differ?
//
// It answers by measurement, not by assertion:
//   1. Runs each runner's env setup in a real child shell (bash and, when
//      available, PowerShell) and dumps the resulting variables. Both shells
//      must agree, or the two entry points have drifted.
//   2. Fails if either runner sets a CAPABILITY variable - anything that moves
//      the config directory, suppresses plugin MCP servers, or otherwise
//      changes WHAT the agent can do rather than WHICH model answers.
//   3. Inventories the shared ~/.claude surface and prints a fingerprint, so
//      the same command on another machine is directly comparable.
//
// Secrets are never printed: token-shaped variables are reduced to a length.
//
//   node scripts/ecc-parity-check.mjs
//   node scripts/ecc-parity-check.mjs --json
// ============================================================================

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Variables the runners are ALLOWED to differ on: they pick the model and the
// transport, nothing else.
const ROUTING_VARS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'API_TIMEOUT_MS', 'MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT',
  'LUNA_RUNNER',
];

// Variables that WOULD break parity. If a runner ever sets one of these, the
// two sessions stop being the same agent with a different brain.
const CAPABILITY_VARS = [
  'CLAUDE_CONFIG_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS',
  'CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT', 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
];

const SECRET_VARS = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // missing or malformed - callers treat both as "nothing here"
  }
};

const listDir = (dir, predicate) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(predicate).map((e) => e.name).sort();
  } catch {
    return [];
  }
};

const maskValue = (name, value) => {
  if (value === undefined || value === '') return null;
  if (!SECRET_VARS.has(name)) return value;
  return `(set, ${value.length} chars)`;
};

// --- Shell probes -----------------------------------------------------------
// Each probe applies one runner's environment in a CHILD process and reports
// what came out. Running the real script is the point: a re-implementation here
// would pass while the script it is meant to verify was broken.

function probeBash(runner) {
  const names = [...ROUTING_VARS, ...CAPABILITY_VARS].join(' ');
  // Git Bash cannot source a path with backslashes - it reads them as escapes
  // and the source silently fails, which would show up as "the runner sets
  // nothing" rather than "the probe broke".
  const setupPath = path.join(SCRIPTS_DIR, 'env-setup.sh').split(path.sep).join('/');
  // The setup path goes in $1, never $0: env-setup.sh decides "sourced vs run"
  // by comparing BASH_SOURCE[0] with $0, so handing it its own path as $0 makes
  // it take the command-line branch and exit 2 before exporting anything.
  const script = [
    '. "$1" "$2" >/dev/null 2>&1 || true',
    `for v in ${names}; do`,
    '  printf "%s=%s\\n" "$v" "${!v-}"',
    'done',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script, 'luna-parity-probe', setupPath, runner], {
    encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseDump(out);
}

function probePowerShell(runner) {
  // Built with an explicit quote character: the command is a PowerShell string
  // full of single quotes, and escaping it inline is unreadable.
  const q = String.fromCharCode(39);
  const setupPath = path.join(SCRIPTS_DIR, 'env-setup.ps1').split(q).join(q + q);
  const names = [...ROUTING_VARS, ...CAPABILITY_VARS].map((n) => q + n + q).join(',');
  const command = [
    `. ${q}${setupPath}${q}`,
    `try { Set-LunaEnv ${runner} } catch { }`,
    `foreach ($n in @(${names})) { ${q}{0}={1}${q} -f $n, [Environment]::GetEnvironmentVariable($n,${q}Process${q}) }`,
  ].join('; ');
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseDump(out);
}

function parseDump(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    result[line.slice(0, eq)] = maskValue(line.slice(0, eq), line.slice(eq + 1));
  }
  return result;
}

function safeProbe(fn, runner) {
  try {
    return { ok: true, env: fn(runner) };
  } catch (err) {
    return { ok: false, error: String(err.message).split('\n')[0] };
  }
}

// --- Shared surface inventory ----------------------------------------------

function inventory() {
  const settings = readJson(path.join(CONFIG_DIR, 'settings.json')) || {};
  const installed = readJson(path.join(CONFIG_DIR, 'plugins', 'installed_plugins.json')) || {};
  const userConfig = readJson(path.join(os.homedir(), '.claude.json')) || {};
  const projectLocal = readJson(path.join(REPO_ROOT, '.claude', 'settings.local.json')) || {};

  const enabledPlugins = Object.entries(settings.enabledPlugins || {})
    .filter(([, on]) => on === true)
    .map(([id]) => id)
    .sort();

  const plugins = enabledPlugins.map((id) => {
    const entry = (installed.plugins || {})[id];
    const record = Array.isArray(entry) && entry[0] ? entry[0] : null;
    const installPath = record ? record.installPath : null;
    const count = (sub) => (installPath ? listDir(path.join(installPath, sub), () => true).length : 0);
    return {
      id,
      version: record ? record.version : null,
      skills: count('skills'),
      agents: count('agents'),
      commands: count('commands'),
    };
  });

  const hookEvents = Object.entries(settings.hooks || {})
    .map(([event, entries]) => `${event}:${Array.isArray(entries) ? entries.length : 0}`)
    .sort();

  const projectMcp = readJson(path.join(REPO_ROOT, '.mcp.json')) || {};

  return {
    configDir: CONFIG_DIR,
    plugins,
    userSkills: listDir(path.join(CONFIG_DIR, 'skills'), (e) => e.isDirectory()),
    userAgents: listDir(path.join(CONFIG_DIR, 'agents'), (e) => e.isFile()),
    hookScripts: listDir(path.join(CONFIG_DIR, 'hooks'), (e) => e.isFile()),
    hookEvents,
    statusLine: Boolean(settings.statusLine),
    mcpGlobal: Object.keys(userConfig.mcpServers || {}).sort(),
    mcpProjectFile: Object.keys(projectMcp.mcpServers || {}).sort(),
    mcpEnabledForProject: [...(projectLocal.enabledMcpjsonServers || [])].sort(),
    memoryFiles: [
      path.join(CONFIG_DIR, 'CLAUDE.md'),
      path.join(path.dirname(REPO_ROOT), 'CLAUDE.md'),
      path.join(REPO_ROOT, 'CLAUDE.md'),
    ].filter((f) => fs.existsSync(f)).map((f) => path.relative(os.homedir(), f)),
  };
}

// --- Report -----------------------------------------------------------------

function diffKeys(a, b) {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].filter((n) => a[n] !== b[n]).sort();
}

function evaluate(probes) {
  const failures = [];
  const notes = [];

  // 1. No runner may touch a capability variable.
  for (const [label, probe] of Object.entries(probes)) {
    if (!probe.ok) {
      notes.push(`${label}: not measured (${probe.error})`);
      continue;
    }
    for (const name of CAPABILITY_VARS) {
      if (probe.env[name]) {
        failures.push(`${label} sets ${name}=${probe.env[name]} - breaks capability parity`);
      }
    }
  }

  // 2. The two shells must produce the same environment for the same runner.
  for (const runner of ['native', 'glm']) {
    const a = probes[`bash/${runner}`];
    const b = probes[`powershell/${runner}`];
    if (!a.ok || !b.ok) continue;
    const drift = diffKeys(a.env, b.env);
    if (drift.length > 0) {
      failures.push(`${runner}: bash and PowerShell disagree on ${drift.join(', ')}`);
    }
  }

  // 3. The GLM runner has to be configured, or there is nothing to compare.
  const glmProbe = probes['bash/glm'].ok ? probes['bash/glm'] : probes['powershell/glm'];
  if (!glmProbe.ok || !glmProbe.env.ANTHROPIC_BASE_URL) {
    notes.push('GLM runner is not configured (no .env.luna key) - routing not measured');
  }

  return { failures, notes };
}

function printReport(probes, inv, fingerprint, failures, notes) {
  const line = (label, value) => console.log(`  ${label.padEnd(24)} ${value}`);

  console.log('\nRUNNER ENVIRONMENTS');
  for (const [label, probe] of Object.entries(probes)) {
    if (!probe.ok) {
      console.log(`\n  ${label}: SKIPPED (${probe.error})`);
      continue;
    }
    console.log(`\n  ${label}`);
    const set = ROUTING_VARS.filter((n) => probe.env[n]);
    if (set.length === 0) console.log('    (no overrides - first-party defaults)');
    for (const name of set) console.log(`    ${name.padEnd(40)} ${probe.env[name]}`);
  }

  console.log('\nSHARED ECC SURFACE');
  line('config dir', inv.configDir);
  line('plugins', `${inv.plugins.length} enabled`);
  for (const p of inv.plugins) {
    line('', `${p.id} @ ${p.version} (skills ${p.skills}, agents ${p.agents}, commands ${p.commands})`);
  }
  line('user skills', inv.userSkills.join(', ') || '(none)');
  line('user agents', inv.userAgents.join(', ') || '(none)');
  line('hook scripts', inv.hookScripts.join(', ') || '(none)');
  line('hook events', inv.hookEvents.join(', ') || '(none)');
  line('status line', inv.statusLine ? 'configured' : '(none)');
  line('MCP (user scope)', inv.mcpGlobal.join(', ') || '(none)');
  line('MCP (.mcp.json)', inv.mcpProjectFile.join(', ') || '(none)');
  line('MCP enabled here', inv.mcpEnabledForProject.join(', ') || '(none)');
  line('memory files', inv.memoryFiles.join(', ') || '(none)');
  line('fingerprint', fingerprint);

  for (const note of notes) console.log(`\nNOTE  ${note}`);
  if (failures.length === 0) {
    // "Unmeasured" is not "passed": say so, or a broken probe reads as a green run.
    const partial = notes.some((n) => n.includes('not measured'));
    const caveat = partial ? ' (some probes unmeasured - see notes)' : '';
    console.log(`\nPARITY OK${caveat} - both runners resolve the same capability surface.\n`);
  } else {
    console.log('');
    for (const failure of failures) console.log(`FAIL  ${failure}`);
    console.log('');
  }
}

function main() {
  const asJson = process.argv.includes('--json');
  const probes = {
    'bash/native': safeProbe(probeBash, 'native'),
    'bash/glm': safeProbe(probeBash, 'glm'),
    'powershell/native': safeProbe(probePowerShell, 'native'),
    'powershell/glm': safeProbe(probePowerShell, 'glm'),
  };

  const inv = inventory();
  const fingerprint = createHash('sha256').update(JSON.stringify(inv)).digest('hex').slice(0, 16);
  const { failures, notes } = evaluate(probes);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ probes, inventory: inv, fingerprint, failures, notes }, null, 2)}\n`);
  } else {
    printReport(probes, inv, fingerprint, failures, notes);
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

main();
