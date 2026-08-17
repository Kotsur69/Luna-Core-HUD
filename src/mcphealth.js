// ============================================================================
// LunaCore - MCP server health (harness audit)
// ----------------------------------------------------------------------------
// Answers the question nothing else in Claude Code answers: WHICH OF MY MCP
// SERVERS AM I ACTUALLY USING? Configuring one is a single line; noticing that
// it has been dead for two months is not, and every server still costs tool
// definitions in the context window of every session.
//
// Three sources, deliberately layered cheapest-first:
//
//   1. CONFIG    - ~/.claude.json (global + per project) and each project's
//                  own .mcp.json. Instant, and the only source of truth for
//                  what is DEFINED and whether it is disabled.
//   2. USAGE     - mined from the session transcripts in ~/.claude/projects.
//                  Claude Code records `skillUsage` and `pluginUsage` in its
//                  config, but NOT mcp usage, so last-used has to be read back
//                  out of what the transcripts show actually being called.
//   3. PROBE     - spawn ONE server on an explicit click and do a real MCP
//                  initialize + tools/list handshake. Never automatic: probing
//                  everything means ~20 processes at once, several of which
//                  authenticate against a network on boot.
//
// Passive Observer, same as ports.js: reads config and files on disk, spawns
// nothing unless asked. Nothing here reaches the model, and it costs no tokens.
//
// WHAT "NEVER USED" DOES AND DOES NOT MEAN. The transcripts are Claude Code's,
// on this machine. A server this panel calls unused may be busy in another
// client (Codex and Gemini read their own MCP config), on your other PC, or in
// sessions whose transcripts have since been cleaned up. It is evidence, not a
// verdict - which is why nothing here deletes anything, and the panel's job
// ends at telling you where to look.
//
// SECRETS: server specs carry `env`, which is where API keys live. This module
// exports env KEY NAMES and never their values - a HUD panel has no business
// rendering a credential, and one bad innerHTML would put it on screen.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

// How long since the last call before a server is worth a second look. A week
// covers "I only use it on that project"; a month is the point where the honest
// answer is usually that you forgot it was installed.
const FRESH_DAYS = 7;
const IDLE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

// A handshake that has not answered in this long is not going to.
const PROBE_TIMEOUT_MS = 10000;

/** Path helpers, indirected so the tests can point them at a fixture. */
function configFile(home = os.homedir()) {
  return path.join(home, '.claude.json');
}
function projectsDir(home = os.homedir()) {
  return path.join(home, '.claude', 'projects');
}

/** Safe read + JSON parse. Returns null when missing or invalid. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isPlainObject(o) {
  return o && typeof o === 'object' && !Array.isArray(o);
}

/**
 * Normalizes one raw MCP server spec into a row.
 *
 * `transport` matters for the probe: only a stdio server can be spawned and
 * handshaken locally. Remote ones (http/sse) are reported as such rather than
 * probed, because "can this machine reach that URL" is a different question
 * from "is this server configured correctly", and answering the first one
 * silently would look like an answer to the second.
 */
function normalizeServer(name, spec, scope, scopeLabel, enabled) {
  const s = isPlainObject(spec) ? spec : {};
  const type = typeof s.type === 'string' ? s.type.toLowerCase() : '';
  const url = typeof s.url === 'string' ? s.url : '';
  // A spec with a url is remote whatever it calls itself; one with a command is
  // stdio. `type` is only consulted when neither is conclusive.
  let transport = 'stdio';
  if (url) transport = type === 'sse' ? 'sse' : 'http';
  else if (type === 'sse' || type === 'http') transport = type;

  return {
    name: String(name),
    scope,
    scopeLabel: scopeLabel || '',
    transport,
    command: typeof s.command === 'string' ? s.command : '',
    args: Array.isArray(s.args) ? s.args.map(String) : [],
    url,
    // Names only. See the SECRETS note in the header.
    envKeys: isPlainObject(s.env) ? Object.keys(s.env) : [],
    enabled: enabled !== false,
    lastUsed: null,
    calls: 0,
    status: 'never',
  };
}

/**
 * Walks a parsed ~/.claude.json into a flat server list.
 *
 * Pure (config object -> rows) so the whole scope/disabled tangle is unit
 * tested without a home directory. A server defined both globally and in a
 * project is ONE row: the global definition wins and the project is noted, so
 * the panel counts what the context window actually pays for rather than how
 * many times it appears in a config file.
 */
function collectServers(config, { projectMcpJson = {} } = {}) {
  const out = new Map();

  const add = (name, spec, scope, scopeLabel, enabled) => {
    if (!name || out.has(name)) return;
    out.set(name, normalizeServer(name, spec, scope, scopeLabel, enabled));
  };

  const cfg = isPlainObject(config) ? config : {};

  // Global scope first, so it wins the dedupe above.
  const global = isPlainObject(cfg.mcpServers) ? cfg.mcpServers : {};
  for (const [name, spec] of Object.entries(global)) {
    add(name, spec, 'global', '', true);
  }

  const projects = isPlainObject(cfg.projects) ? cfg.projects : {};
  for (const [dir, p] of Object.entries(projects)) {
    if (!isPlainObject(p)) continue;
    const label = path.basename(dir) || dir;

    // Three separate disable lists, because Claude Code tracks servers from
    // config and servers from a repo's .mcp.json differently.
    const disabled = new Set([
      ...(Array.isArray(p.disabledMcpServers) ? p.disabledMcpServers : []),
      ...(Array.isArray(p.disabledMcpjsonServers) ? p.disabledMcpjsonServers : []),
    ]);

    const own = isPlainObject(p.mcpServers) ? p.mcpServers : {};
    for (const [name, spec] of Object.entries(own)) {
      add(name, spec, 'project', label, !disabled.has(name));
    }

    // Servers a repo commits for everyone who opens it.
    const fromFile = isPlainObject(projectMcpJson[dir]) ? projectMcpJson[dir] : null;
    const shared = fromFile && isPlainObject(fromFile.mcpServers) ? fromFile.mcpServers : {};
    for (const [name, spec] of Object.entries(shared)) {
      add(name, spec, 'project', label, !disabled.has(name));
    }
  }

  return [...out.values()];
}

// What a server name may look like. Anything else came from prose, not from a
// call - see the `"name":` note below.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Pulls every ACTUALLY CALLED `mcp__<server>__<tool>` out of one transcript
 * line, with the line's timestamp.
 *
 * Anchored on `"name":"mcp__` rather than on `mcp__` anywhere in the line, and
 * that distinction is the whole measurement. A transcript is full of server
 * names that were never called: the tool definitions themselves, the deferred
 * tool listing, and documentation that literally spells the pattern out as
 * `mcp__<server>__<tool>`. Counting mentions made every server on this machine
 * look "used today" and invented one called `<server>` - which is the exact
 * failure this panel exists to prevent, so it fails loudly in the tests.
 * Only a tool_use block carries the name in a JSON `"name"` field.
 *
 * Non-greedy up to the first `__` is what makes this correct for names that
 * contain single underscores of their own (`claude_ai_Bigdata_com`): the
 * delimiter is the DOUBLE underscore.
 */
function parseUsageLine(line) {
  if (typeof line !== 'string' || !line.includes('mcp__')) return null;
  const names = new Set();
  const re = /"name":"mcp__([^"]+?)__/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (NAME_RE.test(m[1])) names.add(m[1]);
  }
  if (!names.size) return null;
  const ts = line.match(/"timestamp":"([^"]+)"/);
  const at = ts ? Date.parse(ts[1]) : NaN;
  return { names: [...names], at: Number.isFinite(at) ? at : null };
}

/** Folds parsed lines into { name -> { lastUsed, calls } }. */
function foldUsage(entries) {
  const usage = Object.create(null);
  for (const e of entries) {
    if (!e) continue;
    for (const name of e.names) {
      const cur = usage[name] || (usage[name] = { lastUsed: null, calls: 0 });
      cur.calls += 1;
      if (e.at !== null && (cur.lastUsed === null || e.at > cur.lastUsed)) cur.lastUsed = e.at;
    }
  }
  return usage;
}

/**
 * How idle is idle. Pure, and the one place the words are decided.
 * `never` is not a failure state on its own - a server installed this morning
 * has never been called either - but combined with a config entry it is the
 * strongest deletion candidate there is.
 */
function classifyIdle(lastUsed, now = Date.now()) {
  if (!lastUsed) return 'never';
  const days = (now - lastUsed) / DAY_MS;
  if (days <= FRESH_DAYS) return 'fresh';
  if (days <= IDLE_DAYS) return 'idle';
  return 'stale';
}

/**
 * Where a server that usage found but config never mentioned actually comes
 * from.
 *
 * `~/.claude.json` is not the only place servers come from, and calling all the
 * others "unknown" would read as a warning about something perfectly healthy.
 * Plugins prefix their servers; claude.ai connectors are configured server-side
 * and this machine never sees a spec for them at all.
 */
function scopeOfUnconfigured(name) {
  if (name.startsWith('plugin_')) return 'plugin';
  if (name.startsWith('claude_ai_')) return 'connector';
  return 'external';
}

/**
 * Joins config rows to mined usage, and appends the servers usage knows about
 * that config does not.
 *
 * That last part is the point rather than an edge case: plugin-provided servers
 * never appear in ~/.claude.json, so without it every plugin MCP would read as
 * "not installed" while quietly filling the context window.
 */
function mergeUsage(servers, usage, now = Date.now()) {
  const seen = new Set();
  const rows = servers.map((s) => {
    seen.add(s.name);
    const u = usage[s.name];
    const lastUsed = u ? u.lastUsed : null;
    return { ...s, lastUsed, calls: u ? u.calls : 0, status: classifyIdle(lastUsed, now) };
  });

  for (const [name, u] of Object.entries(usage)) {
    if (seen.has(name)) continue;
    rows.push({
      ...normalizeServer(name, {}, scopeOfUnconfigured(name), '', true),
      lastUsed: u.lastUsed,
      calls: u.calls,
      status: classifyIdle(u.lastUsed, now),
    });
  }

  // Most neglected first: that is the list you act on.
  const rank = { never: 0, stale: 1, idle: 2, fresh: 3 };
  return rows.sort(
    (a, b) => rank[a.status] - rank[b.status] || (a.lastUsed || 0) - (b.lastUsed || 0)
  );
}

/** Streams one transcript, returning its parsed usage entries. */
function scanFile(file) {
  return new Promise((resolve) => {
    const entries = [];
    let stream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8' });
    } catch {
      resolve(entries);
      return;
    }
    stream.on('error', () => resolve(entries));
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const parsed = parseUsageLine(line);
      if (parsed) entries.push(parsed);
    });
    rl.on('close', () => resolve(entries));
    rl.on('error', () => resolve(entries));
  });
}

/**
 * Mines every transcript for MCP calls.
 *
 * The corpus is ~166 MB here and grows, so this is line-streamed and gated by a
 * cheap `includes('mcp__')` before anything is parsed - JSON.parse on every line
 * of every session would take minutes for an answer we can get in seconds.
 * Results are cached per file by size+mtime, so the first call pays for the
 * whole history and every refresh after it only reads what changed.
 */
const fileCache = new Map(); // file -> { size, mtimeMs, entries }

async function mineUsage(dir = projectsDir()) {
  let projects;
  try {
    projects = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return {};
  }

  const files = [];
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const sub = path.join(dir, p.name);
    let names;
    try {
      names = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.endsWith('.jsonl')) files.push(path.join(sub, n));
    }
  }

  const all = [];
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const hit = fileCache.get(file);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      all.push(...hit.entries);
      continue;
    }
    const entries = await scanFile(file);
    fileCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, entries });
    all.push(...entries);
  }

  return foldUsage(all);
}

/** Reads the .mcp.json each known project may commit, keyed by project dir. */
function readProjectMcpJson(config) {
  const out = {};
  const projects = isPlainObject(config) && isPlainObject(config.projects) ? config.projects : {};
  for (const dir of Object.keys(projects)) {
    const data = readJson(path.join(dir, '.mcp.json'));
    if (data) out[dir] = data;
  }
  return out;
}

/** The whole picture: config joined to mined usage. */
async function getMcpHealth({ home = os.homedir(), now = Date.now() } = {}) {
  const config = readJson(configFile(home));
  const servers = collectServers(config, { projectMcpJson: readProjectMcpJson(config) });
  const usage = await mineUsage(projectsDir(home));
  return { servers: mergeUsage(servers, usage, now), scannedAt: now };
}

/**
 * Spawns ONE stdio server and runs a real MCP handshake against it.
 *
 * initialize tells us it starts and speaks the protocol; tools/list tells us
 * what it costs, which is the number that actually matters when you are
 * deciding whether to keep it - a server contributing 30 tool definitions to
 * every session is a different proposition from one contributing 3.
 */
function handshake(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        // The real server gets its keys from the same environment Claude Code
        // gives it. We never read them back out - see the SECRETS note.
        env: process.env,
        // NEVER shell: true. With a shell the args array is concatenated into a
        // command line instead of passed as argv, so an entry containing `&` or
        // `|` in ~/.claude.json would execute - and Node deprecated exactly this
        // combination (DEP0190). The only reason it was tempting is that `npx`
        // and `npm` are .cmd wrappers on Windows; commandCandidates() resolves
        // those by name instead, which is the narrow fix rather than a shell.
        shell: false,
      });
    } catch (err) {
      resolve({ ok: false, reason: String(err && err.message), tools: null, ms: 0, spawnFailed: true });
      return;
    }

    let settled = false;
    let buffer = '';
    let tools = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ ...result, ms: Date.now() - started });
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', tools }), timeoutMs);

    const send = (msg) => {
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch {
        /* the exit handler below reports it */
      }
    };

    // ENOENT means this NAME does not exist, not that the server is broken -
    // the caller retries the next candidate. Anything else is a real failure.
    child.on('error', (err) =>
      finish({
        ok: false,
        reason: String(err && err.message),
        tools,
        spawnFailed: err && err.code === 'ENOENT',
      })
    );
    child.on('exit', (code) => finish({ ok: false, reason: `exited (${code})`, tools }));

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // servers that log plain text to stdout are not fatal
        }
        if (msg.id === 1 && msg.result) {
          // Handshake accepted. Ask what it brings before declaring success.
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 1 && msg.error) {
          finish({ ok: false, reason: 'initialize rejected', tools });
        } else if (msg.id === 2) {
          tools = msg.result && Array.isArray(msg.result.tools) ? msg.result.tools.length : null;
          finish({ ok: true, reason: '', tools });
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lunacore', version: '1' },
      },
    });
  });
}

/**
 * What to actually hand spawn() for a configured command. Pure, so the Windows
 * rule below is pinned by a test on every platform.
 *
 * The MCP launchers people configure - `npx`, `npm`, `uvx`, `bunx` - are not
 * executables on Windows but `.cmd` shims, and since CVE-2024-27980 Node
 * REFUSES to spawn those without a shell: you get EINVAL, not ENOENT. So there
 * is no shell-free way to start a bare `npx`.
 *
 * `shell: true` would work and is what the first version did. It is also how
 * the args stop being argv and become a concatenated command line nobody
 * escaped - Node deprecated exactly that combination (DEP0190), and these args
 * can come from a `.mcp.json` inside a cloned repo.
 *
 * Running the shim through `cmd.exe /c` gets both: the shim starts, and because
 * the arguments are still passed as an ARRAY with `shell: false`, Node escapes
 * each one. Verified: an arg of `x & echo PWNED` arrives as a single literal
 * argv entry rather than a second command.
 */
function spawnPlan(command, args = [], platform = process.platform) {
  const argv = Array.isArray(args) ? args : [];
  // An explicit path or a real .exe needs none of this.
  if (platform !== 'win32' || path.extname(command)) return { file: command, args: argv };
  return { file: 'cmd.exe', args: ['/c', command, ...argv] };
}

/** Handshakes one stdio server. */
function probeServer(server, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!server || server.transport !== 'stdio' || !server.command) {
    return Promise.resolve({ ok: false, reason: 'remote', tools: null, ms: 0 });
  }
  const plan = spawnPlan(server.command, server.args);
  return handshake(plan.file, plan.args, timeoutMs);
}

// The parsers and the join are pure and carry every rule worth pinning; the
// scan and the probe touch the disk and spawn processes, so only their inputs
// and outputs are tested.
module.exports = {
  getMcpHealth,
  probeServer,
  spawnPlan,
  mineUsage,
  collectServers,
  normalizeServer,
  parseUsageLine,
  foldUsage,
  mergeUsage,
  classifyIdle,
  FRESH_DAYS,
  IDLE_DAYS,
};
