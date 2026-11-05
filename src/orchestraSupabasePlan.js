// ============================================================================
// LunaCore - God Mode: the run's Supabase actions, read from the checkout
// ----------------------------------------------------------------------------
// The reading half of src/orchestraApplyActions.js (that module runs the
// tools). Each migration: its sha256, and whether its SQL is risky enough to
// always ask. Each edge function: the deploy flags its header comment names
// (known ones only), the secrets it lists - random only where the header
// itself says "any random string" - and a digest of everything a deploy
// bundles. Plus the exact manual command for anything not applied. Pure
// apart from the injected fs: nothing here throws or runs a command.
// ============================================================================

'use strict';

const path = require('path');
const crypto = require('crypto');

const MAX_HEADER_LINES = 120;
const MAX_FUNCTION_FILES = 8;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SQL_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 300;
const RANDOM_BYTES = 32;
const MIGRATION_RE = /^[0-9]{8,20}_[A-Za-z0-9_-]{1,100}\.sql$/;
const FUNCTION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Env-style names with at least one underscore (WIDGET_IP_SALT, not JSON).
const SECRET_RE = /^[A-Z][A-Z0-9]*_[A-Z0-9_]{1,62}$/;
// Set by the platform; the CLI refuses to set them anyway.
const PLATFORM_SECRET_RE = /^SUPABASE_/;
const SOURCE_RE = /\.(m?js|ts|tsx)$/i;
const KNOWN_FLAGS = new Set(['--no-verify-jwt']);
const RANDOM_TEXT = 'any\\s+random\\s+(?:string|value)';
// A header line that IS the deploy command / the jwt setting - not a sentence mentioning it.
const DEPLOY_LINE_RE = /^\s*(?:[A-Za-z ]{0,20}:\s*)?(?:[$>]\s*)?(?:npx\s+)?supabase\s+functions\s+deploy\b/i;
const VERIFY_JWT_OFF_RE = /^\s*(?:deployed\s+with\s+)?verify_jwt\s*[=:]\s*false\b/i;
// A foreign key's ON DELETE / ON UPDATE, a policy's FOR DELETE, a trigger's
// BEFORE UPDATE OR DELETE ... EXECUTE FUNCTION change no data by themselves.
// Same line only ([ \t], never \s): "-- clean up of" + a DELETE on the next
// line must not read as one phrase.
const BENIGN_SQL_RE = /\b(?:on|for|before|after|of|or)[ \t]+(?:update|delete)\b|\bexecute[ \t]+(?:function|procedure)\b/gi;
// SQL that may lose or expose data: always asked, even on automatic. A
// keyword list, so it errs on asking (a comment saying "drop" asks too).
const RISKY_SQL = [
  [/\bdrop\b/i, 'DROP'],
  [/\btruncate\b/i, 'TRUNCATE'],
  [/\bdelete\b/i, 'DELETE'],
  [/\bupdate\b/i, 'UPDATE'],
  [/\balter\b[^;]*?\btype\b/i, 'ALTER ... TYPE'],
  [/\brename\b/i, 'RENAME'],
  [/\b(?:grant|revoke)\b/i, 'GRANT / REVOKE'],
  [/\b(?:disable|no\s+force)\s+row\s+level\s+security\b/i, 'DISABLE ROW LEVEL SECURITY'],
  [/\balter\s+policy\b/i, 'ALTER POLICY'],
  [/\busing\s*\(\s*true\s*\)|\bwith\s+check\s*\(\s*true\s*\)/i, 'a policy open to everyone (true)'],
  [/\bdisable\s+trigger\b/i, 'DISABLE TRIGGER'],
  [/\bcreate\s+or\s+replace\b/i, 'CREATE OR REPLACE'],
  [/\b(?:alter|create)\s+(?:role|user)\b|\bset\s+(?:role|session\s+authorization)\b/i, 'a role change'],
  [/\balter\s+system\b/i, 'ALTER SYSTEM'],
  [/\bsecurity\s+definer\b/i, 'SECURITY DEFINER'],
  [/\bexecute\b|\bdo\s*(?:\$|')/i, 'dynamic SQL (EXECUTE / DO)'],
  [/\bcopy\b/i, 'COPY'],
];
const MAX_TREE_FILES = 300;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_DEPTH = 8;
const RANDOM_COMMAND = `$(node -e "process.stdout.write(require('crypto').randomBytes(${RANDOM_BYTES}).toString('hex'))")`;
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = MAX_TEXT) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
// lstat: a link under supabase/ could point anywhere on the disk.
const lstatOf = (fsImpl, file) => (typeof fsImpl.lstatSync === 'function' ? fsImpl.lstatSync(file) : fsImpl.statSync(file));
const isLink = (stat) => typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink();

function readText(fsImpl, file, max) {
  try {
    const stat = lstatOf(fsImpl, file);
    if (isLink(stat) || !stat.isFile() || stat.size > max) return null;
    return String(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}


/** What makes a migration risky (always asked: 'DROP', 'UPDATE', ...), 'unreadable', or null. */
function destructiveKeyword(sql) {
  if (typeof sql !== 'string') return 'unreadable';
  const text = sql.replace(BENIGN_SQL_RE, ' ');
  const hit = RISKY_SQL.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

/** The leading comment block of a source file, comment markers stripped. */
function leadingComment(text) {
  const out = [];
  let inBlock = false;
  for (const raw of String(text || '').split(/\r?\n/).slice(0, MAX_HEADER_LINES)) {
    const line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      out.push((end === -1 ? line : line.slice(0, end)).replace(/^\*\s?/, ''));
      inBlock = end === -1;
    } else if (line.startsWith('//')) {
      out.push(line.replace(/^\/\/+\s?/, ''));
    } else if (line.startsWith('/*')) {
      const body = line.replace(/^\/\*+\s?/, '');
      const end = body.indexOf('*/');
      out.push(end === -1 ? body : body.slice(0, end));
      inBlock = end === -1;
    } else if (!line) {
      out.push('');
    } else {
      break;
    }
  }
  return out.join('\n');
}

/**
 * Adds every regular file under dir (sorted, path + content) to hash, within
 * a shared budget. False on a link, a folder too deep or the budget spent:
 * then what a deploy would bundle cannot be pinned. A missing top folder (no
 * _shared) adds nothing.
 */
function hashTree(fsImpl, dir, rel, hash, budget, depth = 0) {
  let names;
  try {
    names = [...fsImpl.readdirSync(dir)].map(String).sort();
  } catch {
    return depth === 0;
  }
  if (depth > MAX_TREE_DEPTH) return false;
  for (const name of names) {
    const file = path.join(dir, name);
    const key = `${rel}/${name}`;
    let stat;
    try {
      stat = lstatOf(fsImpl, file);
    } catch {
      return false;
    }
    if (isLink(stat)) return false;
    if (stat.isDirectory()) {
      if (!hashTree(fsImpl, file, key, hash, budget, depth + 1)) return false;
      continue;
    }
    budget.files -= 1;
    budget.bytes -= stat.size;
    if (!stat.isFile() || budget.files < 0 || budget.bytes < 0) return false;
    try {
      hash.update(`${key}\x00${stat.size}\x00`).update(fsImpl.readFileSync(file)).update('\x00');
    } catch {
      return false;
    }
  }
  return true;
}

/** A side file a deploy reads, for the digest: '' when missing, null when it cannot be pinned (a link, too big). */
function pinText(fsImpl, file) {
  const text = readText(fsImpl, file, MAX_SOURCE_BYTES * 4);
  if (text !== null) return text;
  try {
    lstatOf(fsImpl, file);
    return null;
  } catch {
    return '';
  }
}

/**
 * supabase/functions/<name>/: every top-level source file's header comment
 * (index.* first), and a digest of all `functions deploy` bundles - the whole
 * folder, _shared, the import map / deno.json, config.toml. null without the
 * folder; sha null when it cannot be pinned.
 * @returns {{header:string, sha:string|null}|null}
 */
function functionSource(repoPath, name, fsImpl) {
  const functions = path.join(repoPath, 'supabase', 'functions');
  const dir = path.join(functions, name);
  let files;
  try {
    files = fsImpl.readdirSync(dir).filter((f) => SOURCE_RE.test(f));
  } catch {
    return null;
  }
  files.sort((a, b) => Number(!/^index\./.test(a)) - Number(!/^index\./.test(b)) || a.localeCompare(b));
  const header = files
    .slice(0, MAX_FUNCTION_FILES)
    .map((f) => leadingComment(readText(fsImpl, path.join(dir, f), MAX_SOURCE_BYTES) || ''))
    .join('\n\n');
  const hash = crypto.createHash('sha256');
  const budget = { files: MAX_TREE_FILES, bytes: MAX_TREE_BYTES };
  let pinned = hashTree(fsImpl, dir, name, hash, budget) && hashTree(fsImpl, path.join(functions, '_shared'), '_shared', hash, budget);
  const sides = [path.join(functions, 'import_map.json'), path.join(functions, 'deno.json'), path.join(functions, 'deno.jsonc'), path.join(repoPath, 'supabase', 'config.toml')];
  for (const side of sides) {
    const text = pinText(fsImpl, side);
    if (text === null) pinned = false;
    else hash.update(`${path.basename(side)}\x00${text}\x00`);
  }
  return { header, sha: pinned ? hash.digest('hex') : null };
}

/** "Secrets: A_KEY (any random string); B_KEY ..." paragraphs -> [{name, random}]. */
function parseSecrets(rows) {
  const found = new Map();
  rows.forEach((row, i) => {
    const m = /\bSecrets?\s*:(.*)$/i.exec(row);
    if (!m) return;
    let para = m[1];
    for (let j = i + 1; j < rows.length && rows[j].trim() && !/^[=-]{4,}/.test(rows[j].trim()); j += 1) para += ` ${rows[j].trim()}`;
    for (const n of para.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) {
      const name = n[1];
      if (!SECRET_RE.test(name) || PLATFORM_SECRET_RE.test(name) || found.has(name)) continue;
      // Only the header's own words make a value random - never a guess.
      found.set(name, new RegExp(`\\b${name}\\b\\s*[(:=-]?\\s*${RANDOM_TEXT}`, 'i').test(para));
    }
  });
  return [...found].map(([name, random]) => ({ name, random }));
}

/**
 * What a function's header comment says about deploying it.
 * @returns {{flags:string[], unknown:string[], secrets:Array<{name:string, random:boolean}>}}
 */
function parseFunctionHeader(text) {
  const flags = new Set();
  const unknown = new Set();
  const rows = String(text || '').split('\n');
  for (const row of rows) {
    if (DEPLOY_LINE_RE.test(row)) {
      for (const m of row.matchAll(/(?:^|\s)(--[A-Za-z][A-Za-z0-9-]{0,40})(?=\s|$|[.,;)])/g)) (KNOWN_FLAGS.has(m[1]) ? flags : unknown).add(m[1]);
    }
    if (VERIFY_JWT_OFF_RE.test(row)) flags.add('--no-verify-jwt');
  }
  return { flags: [...flags], unknown: [...unknown], secrets: parseSecrets(rows) };
}

const COMMANDS = {
  migration: () => 'supabase db push',
  edgeFunction: (name, flags) => ['supabase functions deploy', name, ...flags].join(' '),
  secret: (name, random) => `supabase secrets set ${name}=${random ? RANDOM_COMMAND : '<value>'}`,
};

const manualItem = (kind, what, why, command) => ({ kind, what, state: 'manual', why: oneLine(why), ...(command ? { command } : {}) });

/**
 * Reads what the actions need from the main checkout: each migration's SQL
 * (for the destructive check), each function's header (flags, secrets).
 * @returns {{migrations:Array<{what:string, destructive:string|null}>,
 *   functions:Array<{what:string, flags:string[]}>,
 *   secrets:Array<{name:string, random:boolean}>, manual:object[]}}
 */
function buildPlan(repoPath, actions, fsImpl) {
  const plan = { migrations: [], functions: [], secrets: [], manual: [] };
  const migrations = actions.filter((a) => a.kind === 'migration').sort((a, b) => (a.what < b.what ? -1 : a.what > b.what ? 1 : 0));
  for (const a of migrations) {
    if (!MIGRATION_RE.test(a.what)) {
      plan.manual.push(manualItem('migration', a.what, 'not a migration file name LunaCore applies', COMMANDS.migration()));
      continue;
    }
    const sql = readText(fsImpl, path.join(repoPath, 'supabase', 'migrations', a.what), MAX_SQL_BYTES);
    if (sql === null) {
      plan.manual.push(manualItem('migration', a.what, 'not a regular file in the local checkout', COMMANDS.migration()));
      continue;
    }
    plan.migrations.push({ what: a.what, destructive: destructiveKeyword(sql), sha: sha256(sql) });
  }
  const seen = new Set();
  for (const a of actions.filter((x) => x.kind === 'edgeFunction')) {
    if (!FUNCTION_RE.test(a.what)) {
      plan.manual.push(manualItem('edgeFunction', a.what, 'not a function name LunaCore deploys'));
      continue;
    }
    const source = functionSource(repoPath, a.what, fsImpl);
    if (source === null) {
      plan.manual.push(manualItem('edgeFunction', a.what, 'folder not found in the local checkout', COMMANDS.edgeFunction(a.what, [])));
      continue;
    }
    const parsed = parseFunctionHeader(source.header);
    for (const s of parsed.secrets) {
      if (!seen.has(s.name)) plan.secrets.push(s);
      seen.add(s.name);
    }
    if (parsed.unknown.length) {
      const why = `its header names deploy flag(s) LunaCore does not pass: ${parsed.unknown.join(' ')}`;
      plan.manual.push(manualItem('edgeFunction', a.what, why, COMMANDS.edgeFunction(a.what, [...parsed.flags, ...parsed.unknown])));
      continue;
    }
    if (source.sha === null) {
      const why = `its files hold a link, or more than ${MAX_TREE_FILES} files / ${MAX_TREE_BYTES / 1024 / 1024} MB - look, then deploy it by hand`;
      plan.manual.push(manualItem('edgeFunction', a.what, why, COMMANDS.edgeFunction(a.what, parsed.flags)));
      continue;
    }
    plan.functions.push({ what: a.what, flags: parsed.flags, sha: source.sha });
  }
  return plan;
}

/** What Mati approves: the checkout's HEAD, the project and every file's content. */
const planDigest = (plan, head, ref) => sha256(JSON.stringify([head, ref, plan.migrations, plan.functions, plan.secrets]));

/** Every action of the plan as still manual, with `why`. */
function allManual(plan, why) {
  return [
    ...plan.manual,
    ...plan.migrations.map((m) => manualItem('migration', m.what, why, COMMANDS.migration())),
    ...plan.functions.map((f) => manualItem('edgeFunction', f.what, why, COMMANDS.edgeFunction(f.what, f.flags))),
    ...plan.secrets.map((s) => manualItem('secret', s.name, `${why}; set it if it is not set yet`, COMMANDS.secret(s.name, s.random))),
  ];
}


module.exports = {
  MAX_TEXT,
  RANDOM_BYTES,
  MIGRATION_RE,
  FUNCTION_RE,
  SECRET_RE,
  oneLine,
  readText,
  destructiveKeyword,
  leadingComment,
  parseFunctionHeader,
  COMMANDS,
  manualItem,
  buildPlan,
  planDigest,
  allManual,
};
