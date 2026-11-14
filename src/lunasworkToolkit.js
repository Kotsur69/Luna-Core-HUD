// ============================================================================
// LunaCore - Luna's Work per-project tool kit (docs/tbc_docs/LUNAS_WORK_PLAN.md,
// "Tool kit per role")
// ----------------------------------------------------------------------------
// Which MCP servers and CLIs the God Mode workers of a Luna's Work build may
// use, per role, stored per project in lunaswork-settings.local.json:
//
//   builder   every code package of a build
//   asset     the scene worker package (lunasworkScene SCENE_WORKER_ID): the
//             one worker with the Unity editor, where asset cards land
//
// The other roles are FIXED and not part of the kit: the Director and the
// Critic are read-only headless calls (`--tools Read,Grep,Glob`), and the
// Playtester tests like a player through the PlaytestDriver bridge only
// (lunasworkPlaytest.buildPlaytestArgs, --strict-mcp-config, no code access).
//
// Pure: no IO. The launch side (writing the --mcp-config file) lives in
// src/lunasworkToolkitLaunch.js.
//
//   catalog      TOOLS (MCP server name and/or CLI allow rules per tool id),
//                GAMEDEV_SKILLS, PAID_TOOLS
//   kit          defaultToolkit(adapter), validateToolkit(raw, adapter) strict,
//                normalizeToolkit(raw, adapter) - a broken value is the default
//   servers      validateToolServers / normalizeToolServers: per-PC launch
//                definitions. NO secret values: env / headers may only hold
//                `${VAR}` references, so a key comes from LunaCore's env and
//                never sits in a file on disk
//   launch       roleLaunch(kit, role, opts) -> mcpConfig, allowedTools,
//                disallowedTools, addDirs, note (the worker brief's lines)
//   guardrails   GIT_GUARD_RULES (no force-push, no history rewrite),
//                HOME_GUARD_RULES, isWritablePath, matchesBashRule
//   spend        DEFAULT_SPEND_CAPS_USD, normalizeSpendCaps, validateSpendCaps,
//                checkSpend(run, tool, cost), spendCapCard
//   tool down    toolDownOf(result) - a step result that means a tool is down
// ============================================================================

'use strict';

const path = require('path');

const KIT_ROLES = Object.freeze(['builder', 'asset']);
// Documented, never configurable: see the header.
const FIXED_ROLES = Object.freeze(['director', 'critic', 'playtester']);

/**
 * Tool ids -> what they open. `server` is the MCP server name (the same names
 * the Claude setups use: blade&bullet START_POINT.md), `rules` the CLI /
 * built-in allow rules. `launch` is a built-in launch definition, only for
 * public servers that need no key; the rest come from the PC's toolServers
 * setting or the user's own Claude config.
 */
const TOOLS = Object.freeze({
  unity: Object.freeze({ server: 'unity', rules: Object.freeze(['Bash(unity:*)', 'Bash(Unity:*)', 'Bash(Unity.exe:*)']) }),
  blender: Object.freeze({ server: 'blender', rules: Object.freeze(['Bash(blender:*)', 'Bash(blender.exe:*)']) }),
  higgsfield: Object.freeze({ server: 'higgsfield-bridge', rules: Object.freeze(['Bash(higgsfield:*)']), paid: true }),
  comfyui: Object.freeze({ server: 'comfyui', rules: Object.freeze([]) }),
  meshy: Object.freeze({ server: 'meshy', rules: Object.freeze([]), paid: true }),
  context7: Object.freeze({
    server: 'context7',
    rules: Object.freeze([]),
    launch: Object.freeze({ type: 'http', url: 'https://mcp.context7.com/mcp' }),
  }),
  websearch: Object.freeze({ server: null, rules: Object.freeze(['WebSearch', 'WebFetch']) }),
  git: Object.freeze({ server: null, rules: Object.freeze(['Bash(git:*)']) }),
});
const TOOL_IDS = Object.freeze(Object.keys(TOOLS));
const PAID_TOOLS = Object.freeze(TOOL_IDS.filter((id) => TOOLS[id].paid === true));
// A God Mode worker commits its work: git can never be taken away.
const REQUIRED_TOOLS = Object.freeze(['git']);
const UNITY_DEFAULT_TOOLS = TOOL_IDS;
const APP_DEFAULT_TOOLS = Object.freeze(['context7', 'websearch', 'git']);

const GAMEDEV_SKILLS = Object.freeze([
  'unity-2d-gameplay',
  'unity-mcp-workflow',
  'blender-game-assets',
  'higgsfield-media',
  'ecc:csharp-reviewer',
]);
const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,47}(:[a-z0-9][a-z0-9-]{0,47})?$/;
const MAX_SKILLS = 20;
const MAX_ART_DIRS = 5;
const MAX_PATH_CHARS = 500;

// No force-push, no remote ref deletion and no history rewrite, whatever the
// kit allows. Deny rules apply in every permission mode, bypassPermissions
// included. Every subcommand pattern is denied after `git` / `git.exe` and
// after global options (`git -C . push -f`, `git -c x=y push -f`); an alias
// that could hide one is denied at its definition. What the CLI cannot see
// through (a script, `bash -c`, another language) needs the remote's branch
// protection - see docs/tbc_docs/LUNAS_WORK_PLAN.md "Tool kit per role".
const GIT_BINS = Object.freeze(['git', 'git.exe']);
const GUARDED_GIT = Object.freeze([
  'push*--force*', 'push* -f*', 'push* -uf*', 'push* -fu*', 'push*--mirror*', 'push* +*',
  // `:**`, not `:*`: a rule ending in `:*` is the CLI's prefix syntax.
  'push*--delete*', 'push* -d*', 'push* :**', 'push*--prune*',
  'reset*--hard*', 'reset*--merge*', 'reset*--keep*',
  'rebase*', 'filter-branch*', 'filter-repo*', 'replace*', 'update-ref*',
  'reflog expire*', 'reflog delete*', 'gc*--prune*', 'stash clear*', 'clean* -*f*',
  'config*alias*',
]);
const GIT_GUARD_RULES = Object.freeze(GIT_BINS.flatMap((bin) => [
  ...['', ' -*'].flatMap((globals) => GUARDED_GIT.map((sub) => `Bash(${bin}${globals} ${sub})`)),
  // `git -c alias.p='push -f' p`: an alias defined for one command.
  `Bash(${bin} -c*alias*)`,
]));
// Outside the repo: places a worker must never write (nor read, for the keys).
// The CLI has no "deny all but", so the brief carries the positive rule (repo
// + art dirs); a write through Bash is not covered by Edit rules.
const HOME_GUARD_RULES = Object.freeze([
  'Edit(~/.claude/**)',
  'Edit(~/.claude.json)',
  'Edit(~/.ssh/**)',
  'Edit(~/.aws/**)',
  'Edit(~/.gnupg/**)',
  'Edit(~/.docker/**)',
  'Edit(~/.kube/**)',
  'Edit(~/.gitconfig)',
  'Edit(~/.git-credentials)',
  'Edit(~/.npmrc)',
  'Edit(~/.bashrc)',
  'Edit(~/.bash_profile)',
  'Edit(~/.profile)',
  'Edit(~/.config/**)',
  'Edit(~/AppData/**)',
  'Edit(~/Documents/PowerShell/**)',
  'Edit(~/Documents/WindowsPowerShell/**)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.git-credentials)',
]);

// ---- spend caps --------------------------------------------------------------------

const DEFAULT_HIGGSFIELD_CAP_USD = 10;
const DEFAULT_MESHY_CAP_USD = 10;
const DEFAULT_SPEND_CAPS_USD = Object.freeze({ higgsfield: DEFAULT_HIGGSFIELD_CAP_USD, meshy: DEFAULT_MESHY_CAP_USD });
const MAX_SPEND_CAP_USD = 1000;
// A single call above this is not a real generation price: refused, not booked.
const MAX_SINGLE_COST_USD = 100;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const money = (n) => `$${n.toFixed(2)}`;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// U+2018-U+201B: PowerShell treats the typographic quotes as ' too.
const SHELL_UNSAFE = /['`‘-‛]/;

// ---- kit -----------------------------------------------------------------------------

/** The kit a project gets when it has none: everything for a Unity game, docs + web + git otherwise. */
function defaultToolkit(adapter) {
  const tools = adapter === 'unity' ? [...UNITY_DEFAULT_TOOLS] : [...APP_DEFAULT_TOOLS];
  const skills = adapter === 'unity' ? [...GAMEDEV_SKILLS] : [];
  return {
    builder: { tools: [...tools], skills: [...skills] },
    asset: { tools: [...tools], skills: [...skills] },
    artDirs: [],
  };
}

/** @returns {string|null} why the art folder is refused, null when usable */
function artDirProblem(dir, home) {
  if (typeof dir !== 'string' || !dir.trim()) return 'an art folder must be a non-empty string';
  if (dir.length > MAX_PATH_CHARS || CONTROL_CHARS.test(dir) || SHELL_UNSAFE.test(dir)) return 'an art folder has characters LunaCore cannot pass on';
  if (!path.isAbsolute(dir)) return `art folder '${dir}' must be an absolute path`;
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved) return `art folder '${dir}' is a drive root`;
  if (home) {
    const h = path.resolve(home);
    const rel = path.relative(resolved, h);
    // The home folder itself or one of its parents.
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return `art folder '${dir}' contains the home folder`;
    const claude = path.join(h, '.claude');
    const inClaude = path.relative(claude, resolved);
    if (inClaude === '' || (!inClaude.startsWith('..') && !path.isAbsolute(inClaude))) return `art folder '${dir}' is inside ~/.claude`;
  }
  return null;
}

function roleProblem(raw, role) {
  if (!isObj(raw)) return { value: null, reason: `${role} must be an object` };
  const tools = raw.tools === undefined ? [] : raw.tools;
  const skills = raw.skills === undefined ? [] : raw.skills;
  if (!Array.isArray(tools)) return { value: null, reason: `${role}.tools must be a list` };
  if (!Array.isArray(skills) || skills.length > MAX_SKILLS) return { value: null, reason: `${role}.skills must be a list of at most ${MAX_SKILLS}` };
  for (const t of tools) {
    if (typeof t !== 'string' || !own(TOOLS, t)) return { value: null, reason: `unknown tool '${String(t)}' for ${role}` };
  }
  for (const s of skills) {
    if (typeof s !== 'string' || !SKILL_RE.test(s)) return { value: null, reason: `bad skill name '${String(s)}' for ${role}` };
  }
  // Catalog order, each once, git always in.
  const set = new Set([...tools, ...REQUIRED_TOOLS]);
  return { value: { tools: TOOL_IDS.filter((t) => set.has(t)), skills: [...new Set(skills)] }, reason: null };
}

/**
 * Strict validation of a project's tool kit (what the settings UI writes).
 * @param {unknown} raw
 * @param {{home?:string}} [opts]
 * @returns {{toolkit: object|null, reason: string|null}}
 */
function validateToolkit(raw, opts = {}) {
  if (!isObj(raw)) return { toolkit: null, reason: 'toolkit must be an object' };
  for (const key of Object.keys(raw)) {
    if (FIXED_ROLES.includes(key)) return { toolkit: null, reason: `the ${key}'s tools are fixed and not part of the kit` };
    if (!KIT_ROLES.includes(key) && key !== 'artDirs') return { toolkit: null, reason: `unknown toolkit role '${key}'` };
  }
  const out = {};
  for (const role of KIT_ROLES) {
    const { value, reason } = roleProblem(raw[role] === undefined ? {} : raw[role], role);
    if (!value) return { toolkit: null, reason };
    out[role] = value;
  }
  const dirs = raw.artDirs === undefined ? [] : raw.artDirs;
  if (!Array.isArray(dirs) || dirs.length > MAX_ART_DIRS) return { toolkit: null, reason: `artDirs must be a list of at most ${MAX_ART_DIRS}` };
  for (const d of dirs) {
    const problem = artDirProblem(d, opts.home);
    if (problem) return { toolkit: null, reason: problem };
  }
  out.artDirs = [...new Set(dirs.map((d) => path.resolve(d)))];
  return { toolkit: out, reason: null };
}

/** The project's kit; missing or broken = the adapter's default. Never throws. */
function normalizeToolkit(raw, adapter, opts = {}) {
  if (raw === undefined || raw === null) return defaultToolkit(adapter);
  const { toolkit } = validateToolkit(raw, opts);
  return toolkit || defaultToolkit(adapter);
}

// ---- per-PC server definitions -----------------------------------------------------------

const ENV_REF_RE = /^\$\{[A-Z_][A-Z0-9_]{0,63}\}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
// An arg that names a credential and carries no ${VAR} reference: refused, a
// literal key would sit in the --mcp-config file and the process list.
const SECRET_WORD_RE = /(api[-_]?key|token|secret|passw|bearer|authorization|credential)/i;
// A bare flag name (`--api-key`, its value in the next arg) is fine; `--api-key=<value>` is not.
const hasSecretShape = (arg) =>
  typeof arg === 'string' && SECRET_WORD_RE.test(arg) && !arg.includes('${') && (!arg.startsWith('-') || /[=:]/.test(arg));
const MAX_ARGS = 30;

/** env / headers: only `${VAR}` references - a literal value would put a secret on disk. */
function refsProblem(raw, name) {
  if (raw === undefined) return null;
  if (!isObj(raw)) return `${name} must be an object`;
  for (const [k, v] of Object.entries(raw)) {
    if (!ENV_KEY_RE.test(k)) return `${name} key '${k}' is not allowed`;
    if (typeof v !== 'string' || !ENV_REF_RE.test(v)) return `${name}.${k} must be a \${VAR} reference, never a value`;
  }
  return null;
}

/** @returns {{server: object|null, reason: string|null}} one launch definition */
function validateServer(raw, id) {
  const fail = (reason) => ({ server: null, reason: `${id}: ${reason}` });
  if (!isObj(raw)) return fail('must be an object');
  const refs = refsProblem(raw.env, 'env') || refsProblem(raw.headers, 'headers');
  if (refs) return fail(refs);
  const extras = (keys) => Object.fromEntries(keys.filter((k) => raw[k] !== undefined && Object.keys(raw[k]).length).map((k) => [k, { ...raw[k] }]));
  if (raw.type === 'http' || raw.type === 'sse') {
    let url;
    try {
      url = new URL(String(raw.url));
    } catch {
      return fail('url is not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('url must be http or https');
    if (url.username || url.password) return fail('url must not carry credentials');
    // A key in the query string would sit in the --mcp-config file: env / headers only.
    if (url.search || url.hash) return fail('url must not carry a query string or fragment (pass keys as ${VAR} headers)');
    if (String(raw.url).length > MAX_PATH_CHARS) return fail('url is too long');
    return { server: { type: raw.type, url: String(raw.url), ...extras(['headers']) }, reason: null };
  }
  if (raw.type !== undefined && raw.type !== 'stdio') return fail(`unknown type '${String(raw.type)}'`);
  if (typeof raw.command !== 'string' || !raw.command.trim() || raw.command.length > MAX_PATH_CHARS || CONTROL_CHARS.test(raw.command)) {
    return fail('command must be a one-line string');
  }
  const args = raw.args === undefined ? [] : raw.args;
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((a) => typeof a !== 'string' || a.length > MAX_PATH_CHARS || CONTROL_CHARS.test(a))) {
    return fail(`args must be a list of at most ${MAX_ARGS} one-line strings`);
  }
  if (args.some(hasSecretShape)) return fail('an arg looks like a key or token: pass it through env as a ${VAR} reference');
  return { server: { type: 'stdio', command: raw.command.trim(), args: [...args], ...extras(['env']) }, reason: null };
}

/** Strict: {toolId: definition}; only tools with an MCP server. */
function validateToolServers(raw) {
  if (!isObj(raw)) return { servers: null, reason: 'toolServers must be an object' };
  const out = {};
  for (const [id, def] of Object.entries(raw)) {
    if (!own(TOOLS, id) || !TOOLS[id].server) return { servers: null, reason: `toolServers: '${id}' is not an MCP tool` };
    const { server, reason } = validateServer(def, id);
    if (!server) return { servers: null, reason: `toolServers ${reason}` };
    out[id] = server;
  }
  return { servers: out, reason: null };
}

/** Lenient: the valid entries only. */
function normalizeToolServers(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [id, def] of Object.entries(raw)) {
    if (!own(TOOLS, id) || !TOOLS[id].server) continue;
    const { server } = validateServer(def, id);
    if (server) out[id] = server;
  }
  return out;
}

// ---- launch ------------------------------------------------------------------------------

const toolRules = (id) => {
  const t = TOOLS[id];
  return [...(t.server ? [`mcp__${t.server}`] : []), ...t.rules];
};

/**
 * One role's launch pieces, from its kit. A tool that is out of the kit or
 * capped (its spend cap reached) is denied by name, so a server the user's own
 * Claude config loads is closed too. The guard rules are always denied.
 * @param {object} kit normalizeToolkit()
 * @param {string} role a KIT_ROLES entry
 * @param {{toolServers?:object, capped?:string[], repoPath?:string, spendCaps?:object}} [opts]
 * @returns {{role:string, tools:string[], skills:string[], mcpConfig:{mcpServers:object},
 *   allowedTools:string[], disallowedTools:string[], addDirs:string[], fromClaudeSetup:string[],
 *   note:string}|null} null for a role outside the kit (the fixed roles)
 */
function roleLaunch(kit, role, opts = {}) {
  if (!KIT_ROLES.includes(role) || !isObj(kit) || !isObj(kit[role])) return null;
  const servers = isObj(opts.toolServers) ? opts.toolServers : {};
  const capped = new Set((Array.isArray(opts.capped) ? opts.capped : []).filter((t) => PAID_TOOLS.includes(t)));
  const tools = kit[role].tools.filter((t) => own(TOOLS, t) && !capped.has(t));
  const denied = TOOL_IDS.filter((t) => !tools.includes(t));
  const mcpServers = {};
  const fromClaudeSetup = [];
  for (const id of tools) {
    const t = TOOLS[id];
    if (!t.server) continue;
    const def = own(servers, id) ? servers[id] : t.launch;
    if (def) mcpServers[t.server] = { ...def };
    else fromClaudeSetup.push(id);
  }
  const artDirs = Array.isArray(kit.artDirs) ? kit.artDirs : [];
  const result = {
    role,
    tools,
    skills: [...kit[role].skills],
    mcpConfig: { mcpServers },
    allowedTools: tools.flatMap(toolRules),
    disallowedTools: [...GIT_GUARD_RULES, ...HOME_GUARD_RULES, ...denied.flatMap(toolRules)],
    addDirs: [...artDirs],
    fromClaudeSetup,
  };
  return { ...result, note: kitNote({ ...result, spendCaps: normalizeSpendCaps(opts.spendCaps) }, { capped: [...capped], repoPath: opts.repoPath }) };
}

/** The lines a worker's brief gets about its kit and the guardrails. */
function kitNote(launch, { capped = [], repoPath } = {}) {
  const lines = ["## Tool kit (Luna's Work)", `Tools you may use: ${launch.tools.join(', ')}.`];
  if (launch.skills.length) lines.push(`Skills to load when they fit: ${launch.skills.join(', ')}.`);
  if (capped.length) lines.push(`Spend cap reached, do not use: ${capped.join(', ')}.`);
  const paid = launch.tools.filter((t) => PAID_TOOLS.includes(t));
  if (paid.length && isObj(launch.spendCaps)) {
    lines.push(`Paid tools have a budget for this whole run: ${paid.map((t) => `${t} ${money(launch.spendCaps[t])}`).join(', ')}. Generate only what your cards need, and say in your final message how many generations you made.`);
  }
  const roots = [repoPath ? 'this repository' : null, ...launch.addDirs].filter(Boolean);
  lines.push(`Write only inside ${roots.length ? roots.join(', ') : 'this repository'}.`);
  lines.push('Never force-push, reset --hard, rebase or rewrite history: those commands are blocked.');
  lines.push('If a tool is down or not connected, say so in your final message and stop using it; do not retry in a loop.');
  return lines.join('\n');
}

// ---- guardrails ----------------------------------------------------------------------------

/**
 * Claude Code's Bash rule semantics, for tests and reviews: `prefix:*` matches
 * the prefix, `*` elsewhere matches any run of characters.
 */
function matchesBashRule(rule, command) {
  const m = /^Bash\((.*)\)$/.exec(String(rule));
  if (!m) return false;
  const cmd = String(command).trim().replace(/\s+/g, ' ');
  const body = m[1];
  // Plain string prefix: the wider reading, so a test never passes on a gap.
  if (body.endsWith(':*')) return cmd.startsWith(body.slice(0, -2));
  const re = new RegExp(`^${body.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(cmd);
}

/** Whether a git command is one the guard denies. */
function isGuardedGitCommand(command) {
  return GIT_GUARD_RULES.some((r) => matchesBashRule(r, command));
}

const within = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Writes only inside the project repo and its art folders - for LunaCore code
 * that writes on a worker's behalf (later asset work).
 * @param {string} target
 * @param {{repoPath:string, artDirs?:string[]}} roots
 */
function isWritablePath(target, { repoPath, artDirs = [] } = {}, fsImpl = require('fs')) {
  if (typeof target !== 'string' || !target || CONTROL_CHARS.test(target) || typeof repoPath !== 'string' || !repoPath) return false;
  const abs = realPathOf(path.resolve(repoPath, target), fsImpl);
  return [repoPath, ...(Array.isArray(artDirs) ? artDirs : [])]
    .some((root) => typeof root === 'string' && root && within(realPathOf(path.resolve(root), fsImpl), abs));
}

/**
 * The real path of `p`: its deepest existing ancestor resolved through
 * symlinks / junctions, the rest appended - so a junction inside the repo that
 * points outside it is judged by where it really goes.
 */
function realPathOf(p, fsImpl) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fsImpl.realpathSync.native ? fsImpl.realpathSync.native(cur) : fsImpl.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// ---- spend caps ------------------------------------------------------------------------------

const isCap = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_SPEND_CAP_USD;

/** Strict: a partial {tool: usd} map of paid tools. */
function validateSpendCaps(raw) {
  if (!isObj(raw)) return { caps: null, reason: 'spendCaps must be an object' };
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PAID_TOOLS.includes(k)) return { caps: null, reason: `'${k}' is not a paid tool` };
    if (!isCap(v)) return { caps: null, reason: `spendCaps.${k} must be a number from 0 to ${MAX_SPEND_CAP_USD}` };
    out[k] = v;
  }
  return { caps: out, reason: null };
}

/** Every paid tool's cap: the valid override, else the default. */
function normalizeSpendCaps(raw) {
  const src = isObj(raw) ? raw : {};
  return Object.fromEntries(PAID_TOOLS.map((t) => [t, isCap(src[t]) ? src[t] : DEFAULT_SPEND_CAPS_USD[t]]));
}

/** The run's spend so far per paid tool (never negative, never NaN). */
function normalizeSpend(raw) {
  const src = isObj(raw) ? raw : {};
  return Object.fromEntries(PAID_TOOLS.map((t) => [t, Number.isFinite(src[t]) && src[t] > 0 ? src[t] : 0]));
}

/**
 * Books one paid generation against the run's cap, BEFORE it runs. Pure: the
 * caller saves `spend` when ok, and stops generating when not.
 * @param {{spend?:object, spendCaps?:object}} run
 * @param {string} tool
 * @param {number} cost USD
 * @returns {{ok:boolean, reason:string|null, tool:string, spent:number, cap:number|null,
 *   remaining:number|null, spend:object}}
 */
function checkSpend(run, tool, cost) {
  const r = isObj(run) ? run : {};
  const spend = normalizeSpend(r.spend);
  const base = { tool: String(tool), spend, spent: 0, cap: null, remaining: null };
  if (!own(TOOLS, tool)) return { ...base, ok: false, reason: 'unknownTool' };
  if (!PAID_TOOLS.includes(tool)) return { ...base, ok: true, reason: null };
  const cap = normalizeSpendCaps(r.spendCaps)[tool];
  const spent = spend[tool];
  const known = { ...base, spent, cap, remaining: Math.max(0, cap - spent) };
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > MAX_SINGLE_COST_USD) return { ...known, ok: false, reason: 'badCost' };
  if (spent + cost > cap) return { ...known, ok: false, reason: 'capReached' };
  const next = { ...spend, [tool]: spent + cost };
  return { ...known, ok: true, reason: null, spend: next, spent: next[tool], remaining: cap - next[tool] };
}

/** The card filed when a cap is reached (Critic card shape). */
function spendCapCard(tool, spent, cap) {
  return {
    kind: 'missing',
    severity: 'medium',
    text: `${tool} spend cap reached (${money(spent)} of ${money(cap)}): generation stopped`,
    details: `Luna's Work stopped ${tool} generation for this run. Raise the cap in Settings -> Luna's Work -> tool kit for the next run, or make the remaining assets by hand.`,
    acceptance: [`The remaining ${tool} assets are made, or the cap is raised for the next run`],
    files: [],
    updatesCardId: null,
    splitsCardId: null,
  };
}

// ---- tool down ---------------------------------------------------------------------------------

const TOOL_DOWN_PATTERNS = Object.freeze([
  { tool: 'unity', re: /Unity editor not open|Unity Pipeline port file/i },
  { tool: 'blender', re: /blender[^\n]{0,40}(not connected|refused|unreachable|failed to connect)/i },
  { tool: 'higgsfield', re: /higgsfield[^\n]{0,40}(not connected|refused|unreachable|failed to connect|503|502)/i },
  { tool: 'comfyui', re: /comfyui[^\n]{0,40}(not connected|refused|unreachable|failed to connect)/i },
  { tool: 'meshy', re: /meshy[^\n]{0,40}(not connected|refused|unreachable|failed to connect|503|502)/i },
]);

/**
 * A step result that means one of the kit's tools is down: an explicit
 * {error:'toolDown', tool}, or a failure whose detail names a known tool
 * that does not answer.
 * @returns {{tool:string, detail:string}|null}
 */
function toolDownOf(res) {
  if (!isObj(res) || res.ok === true) return null;
  const detail = String(res.detail || res.error || '').slice(0, 300);
  if (res.error === 'toolDown' && typeof res.tool === 'string' && own(TOOLS, res.tool)) return { tool: res.tool, detail };
  const hit = TOOL_DOWN_PATTERNS.find((p) => p.re.test(detail));
  return hit ? { tool: hit.tool, detail } : null;
}

module.exports = {
  KIT_ROLES,
  FIXED_ROLES,
  TOOLS,
  TOOL_IDS,
  PAID_TOOLS,
  REQUIRED_TOOLS,
  GAMEDEV_SKILLS,
  GIT_GUARD_RULES,
  HOME_GUARD_RULES,
  hasSecretShape,
  DEFAULT_HIGGSFIELD_CAP_USD,
  DEFAULT_MESHY_CAP_USD,
  DEFAULT_SPEND_CAPS_USD,
  MAX_SPEND_CAP_USD,
  defaultToolkit,
  validateToolkit,
  normalizeToolkit,
  validateToolServers,
  normalizeToolServers,
  roleLaunch,
  matchesBashRule,
  isGuardedGitCommand,
  isWritablePath,
  validateSpendCaps,
  normalizeSpendCaps,
  normalizeSpend,
  checkSpend,
  spendCapCard,
  toolDownOf,
};
