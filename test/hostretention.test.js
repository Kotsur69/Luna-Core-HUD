// ============================================================================
// LunaCore - retention for host_commands / push_sent
// (supabase/migrations/20261104120000_host_retention.sql)
// ----------------------------------------------------------------------------
// The migration is never applied from here; these checks read its SQL text:
// a pending command ('new' / 'claimed') is never deleted, only finished rows
// older than the retention go, the prune can't be called by anon or a
// logged-in session, and a daily pg_cron job runs it.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20261104120000_host_retention.sql';
const raw = fs.readFileSync(path.join(DIR, FILE), 'utf8');
// SQL without "--" comments, whitespace collapsed, lower case.
const sql = raw.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase();

/** The text of `delete from <table> ... ;`. */
function deleteOf(table) {
  const m = sql.match(new RegExp(`delete from public\\.${table} (where [^;]*);`));
  assert.ok(m, `a delete on ${table}`);
  return m[1];
}

test('the migration sorts after the ones it builds on and follows the naming style', () => {
  const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  // Later migrations may follow it; the host tables it cleans must come first.
  assert.ok(all.indexOf(FILE) > all.indexOf('20261021130000_host_events.sql'));
  assert.match(FILE, /^\d{14}_[a-z_]+\.sql$/);
});

test('host_commands: only finished rows older than the cutoff go; pending rows never', () => {
  const where = deleteOf('host_commands');
  assert.match(where, /status in \('done', 'refused', 'failed'\)/);
  assert.match(where, /created_at < v_cutoff/);
  assert.doesNotMatch(where, /'new'|'claimed'/);
  assert.doesNotMatch(where, /\bor\b|status not in|status <>/, 'no clause that could widen the status filter');
  assert.equal((sql.match(/delete from public\.host_commands/g) || []).length, 1, 'one delete on host_commands');
});

test('push_sent: keys older than the cutoff go', () => {
  assert.match(deleteOf('push_sent'), /^where at < v_cutoff$/);
});

test('the retention defaults to 30 days and refuses a too-short or missing one', () => {
  assert.match(sql, /p_days integer default 30/);
  assert.match(sql, /if p_days is null or p_days < 7 or p_days > 3650 then raise exception/);
  assert.match(sql, /v_cutoff := now\(\) - make_interval\(days => p_days\)/);
});

test('the prune is locked down: fixed search_path, not callable by anon or logged-in users', () => {
  assert.match(sql, /create or replace function public\.prune_host_retention/, 're-runnable');
  assert.match(sql, /security invoker set search_path = ''/);
  assert.doesNotMatch(sql, /security definer/);
  assert.match(sql, /revoke execute on function public\.prune_host_retention\(integer\) from public, anon, authenticated;/);
  assert.doesNotMatch(sql, /grant execute/);
});

test('a named daily pg_cron job runs the prune', () => {
  assert.match(sql, /create extension if not exists pg_cron/);
  assert.match(sql, /select cron\.schedule\('lunacore-host-retention', '17 3 \* \* \*', \$\$select public\.prune_host_retention\(30\)\$\$\);/);
});
