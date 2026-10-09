// ============================================================================
// LunaCore - Mission Control ledger tests (src/missionledger.js)
// ----------------------------------------------------------------------------
// Synthetic transcripts in a temp dir shaped like ~/.claude/projects
// (<project>/<session>.jsonl and <project>/<session>/subagents/*.jsonl).
// resolveKey is injected; the clock is fixed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseAssistantLine, createLedger, summarize, HOUR_MS } = require('../src/missionledger.js');

const NOW = Date.parse('2026-10-09T12:00:00Z');
const at = (iso) => Date.parse(iso);

function line({ id, ts = '2026-10-09T10:15:00Z', cwd = '/r/alpha', model = 'claude-opus-5-5', u = {} }) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    timestamp: ts,
    message: {
      id,
      model,
      usage: {
        input_tokens: u.input ?? 100,
        cache_creation_input_tokens: u.cw ?? 0,
        cache_read_input_tokens: u.cr ?? 0,
        output_tokens: u.output ?? 10,
      },
    },
  });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ledger-'));
  fs.mkdirSync(path.join(root, 'proj-a', 'sess-1', 'subagents'), { recursive: true });
  return root;
}

const keys = (cwd) => ({ key: `local:${path.basename(cwd)}`, name: path.basename(cwd) });

function ledgerFor(root, opts = {}) {
  return createLedger({ root, resolveKey: keys, now: () => NOW, ...opts });
}

test('parseAssistantLine keeps only assistant lines with an id, usage and a real model', () => {
  const ok = parseAssistantLine(line({ id: 'm1', u: { input: 5, cw: 6, cr: 7, output: 8 } }));
  assert.deepEqual(ok, {
    id: 'm1',
    ms: at('2026-10-09T10:15:00Z'),
    cwd: '/r/alpha',
    model: 'claude-opus-5-5',
    u: { input: 5, cacheWrite: 6, cacheRead: 7, output: 8 },
  });
  assert.equal(parseAssistantLine('{"type":"user","message":{}}'), null);
  assert.equal(parseAssistantLine('not json "assistant"'), null);
  assert.equal(parseAssistantLine(line({ id: 'm2', model: '<synthetic>' })), null);
  assert.equal(parseAssistantLine(line({ id: 'm3', ts: 'yesterday' })), null);
  const noId = JSON.parse(line({ id: 'x' }));
  delete noId.message.id;
  assert.equal(parseAssistantLine(JSON.stringify(noId)), null);
});

test('parseAssistantLine clamps negative or non-numeric token counts to 0', () => {
  const raw = JSON.parse(line({ id: 'm1' }));
  raw.message.usage.input_tokens = -5;
  raw.message.usage.output_tokens = 'lots';
  const p = parseAssistantLine(JSON.stringify(raw));
  assert.equal(p.u.input, 0);
  assert.equal(p.u.output, 0);
});

test('duplicate message ids count once, with the max of each usage field', async () => {
  const root = setup();
  fs.writeFileSync(
    path.join(root, 'proj-a', 'sess-1.jsonl'),
    [
      line({ id: 'm1', u: { input: 100, output: 5 } }),
      line({ id: 'm1', u: { input: 100, output: 40 } }),
      line({ id: 'm2', u: { input: 1, output: 1 } }),
    ].join('\n') + '\n'
  );
  const ledger = ledgerFor(root);
  await ledger.scan();
  const rows = ledger.rows();
  assert.equal(rows.length, 1);
  const [hour, key, name, model, input, cw, cr, output] = rows[0];
  assert.equal(hour, at('2026-10-09T10:00:00Z'));
  assert.deepEqual([key, name, model, input, cw, cr, output], ['local:alpha', 'alpha', 'claude-opus-5-5', 101, 0, 0, 41]);
});

test('subagent transcripts are counted', async () => {
  const root = setup();
  fs.writeFileSync(path.join(root, 'proj-a', 'sess-1.jsonl'), line({ id: 'm1' }) + '\n');
  fs.writeFileSync(path.join(root, 'proj-a', 'sess-1', 'subagents', 'agent-x.jsonl'), line({ id: 's1', cwd: '/r/beta' }) + '\n');
  const ledger = ledgerFor(root);
  await ledger.scan();
  assert.deepEqual(ledger.rows().map((r) => r[1]).sort(), ['local:alpha', 'local:beta']);
});

test('records older than the history window are dropped', async () => {
  const root = setup();
  fs.writeFileSync(
    path.join(root, 'proj-a', 'sess-1.jsonl'),
    [line({ id: 'old', ts: '2026-09-01T10:00:00Z' }), line({ id: 'new' })].join('\n') + '\n'
  );
  const ledger = ledgerFor(root, { historyDays: 14 });
  await ledger.scan();
  assert.equal(ledger.rows().length, 1);
});

test('an unchanged file is not re-read; an appended file is read from the last offset', async () => {
  const root = setup();
  const file = path.join(root, 'proj-a', 'sess-1.jsonl');
  fs.writeFileSync(file, line({ id: 'm1' }) + '\n' + line({ id: 'm2' }).slice(0, 20));
  const ledger = ledgerFor(root);
  await ledger.scan();
  assert.equal(ledger.stats().bytesRead, fs.statSync(file).size);
  assert.equal(ledger.rows()[0][4], 100);

  await ledger.scan();
  assert.equal(ledger.stats().bytesRead, fs.statSync(file).size, 'second scan reads nothing');

  // Finish the partial line and add one more: only the tail is read.
  const before = fs.statSync(file).size;
  fs.writeFileSync(file, line({ id: 'm1' }) + '\n' + line({ id: 'm2' }) + '\n' + line({ id: 'm3' }) + '\n');
  fs.utimesSync(file, new Date(NOW), new Date(NOW + 1000));
  await ledger.scan();
  assert.equal(ledger.rows()[0][4], 300);
  const firstLineBytes = Buffer.byteLength(line({ id: 'm1' }) + '\n');
  assert.equal(ledger.stats().bytesRead, before + fs.statSync(file).size - firstLineBytes);
});

test('a file that shrank is re-read from the start', async () => {
  const root = setup();
  const file = path.join(root, 'proj-a', 'sess-1.jsonl');
  fs.writeFileSync(file, line({ id: 'm1' }) + '\n' + line({ id: 'm2' }) + '\n');
  const ledger = ledgerFor(root);
  await ledger.scan();
  fs.writeFileSync(file, line({ id: 'm9' }) + '\n');
  fs.utimesSync(file, new Date(NOW), new Date(NOW + 2000));
  await ledger.scan();
  assert.equal(ledger.rows()[0][4], 100);
});

test('a deleted file leaves the ledger', async () => {
  const root = setup();
  const file = path.join(root, 'proj-a', 'sess-1.jsonl');
  fs.writeFileSync(file, line({ id: 'm1' }) + '\n');
  const ledger = ledgerFor(root);
  await ledger.scan();
  fs.rmSync(file);
  await ledger.scan();
  assert.deepEqual(ledger.rows(), []);
});

test('a missing root scans to an empty ledger', async () => {
  const ledger = ledgerFor(path.join(os.tmpdir(), 'lc-ledger-does-not-exist-xyz'));
  await ledger.scan();
  assert.deepEqual(ledger.rows(), []);
});

const RATES = {
  rates: [
    { id: 'claude-opus-5-5', input: 4, output: 20 },
    { id: 'claude-haiku-5-5', input: 0.1, output: 0.5 },
  ],
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
};

test('summarize prices tokens per model and splits the window by project', () => {
  const h = at('2026-10-09T10:00:00Z');
  const rows = [
    // alpha: 1M input + 1M output on opus = 4 + 20 = $24
    [h, 'git:a', 'alpha', 'claude-opus-5-5', 1e6, 0, 0, 1e6],
    // beta: 1M cache write + 1M cache read on opus = 5 + 0.4 = $5.4; plus 1M haiku input = 0.1
    [h, 'git:b', 'beta', 'claude-opus-5-5', 0, 1e6, 1e6, 0],
    [h, 'git:b', 'beta', 'claude-haiku-5-5', 1e6, 0, 0, 0],
    // unknown model: tokens shown as unpriced, never guessed
    [h, 'git:b', 'beta', 'claude-mystery-9', 500, 0, 0, 500],
    // before the window
    [h - 3 * 24 * HOUR_MS, 'git:a', 'alpha', 'claude-opus-5-5', 1e9, 0, 0, 0],
  ];
  const s = summarize(rows, { sinceMs: h - HOUR_MS, untilMs: h + HOUR_MS, rates: RATES });
  assert.ok(Math.abs(s.totalUsd - 29.5) < 1e-9);
  assert.equal(s.unpricedTokens, 1000);
  assert.deepEqual(
    s.projects.map((p) => [p.key, p.name, Number(p.usd.toFixed(4)), Number(p.share.toFixed(4)), p.unpricedTokens]),
    [
      ['git:a', 'alpha', 24, Number((24 / 29.5).toFixed(4)), 0],
      ['git:b', 'beta', 5.5, Number((5.5 / 29.5).toFixed(4)), 1000],
    ]
  );
});

test('summarize counts the bucket holding sinceMs (hour granularity)', () => {
  const h = at('2026-10-09T10:00:00Z');
  const rows = [[h, 'git:a', 'alpha', 'claude-opus-5-5', 1e6, 0, 0, 0]];
  const s = summarize(rows, { sinceMs: h + 30 * 60 * 1000, untilMs: h + HOUR_MS * 5, rates: RATES });
  assert.equal(s.projects.length, 1);
});

test('summarize of nothing is zero with no NaN shares', () => {
  const s = summarize([], { sinceMs: 0, untilMs: NOW, rates: RATES });
  assert.deepEqual(s, { totalUsd: 0, unpricedTokens: 0, projects: [] });
});

test('parseAssistantLine clamps absurd token counts', () => {
  const raw = JSON.parse(line({ id: 'm1' }));
  raw.message.usage.input_tokens = 1e308;
  assert.equal(parseAssistantLine(JSON.stringify(raw)).u.input, 1e12);
});
