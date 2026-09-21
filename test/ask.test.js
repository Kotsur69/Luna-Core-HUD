// ============================================================================
// LunaCore - /ask tool recommender tests (src/ask.js)
// ----------------------------------------------------------------------------
// Pure functions only - buildCatalogContext, buildAskPrompt, parseAskResponse -
// same pure-vs-impure split test/lmstudio.test.js documents. runAsk() itself
// spawns a real `claude` process and is deliberately left untested, same
// convention as that file's probeEndpoint/LocalModelWatcher.
//
// parseAskResponse is the highest-value target here: it is the only thing
// standing between a model's JSON reply and a displayed card, mirroring why
// test/libraries.test.js drills safeUrl()/resolveLibraryUrl() so hard. The bad
// URL list below is the same one that file uses, for the same reason - a
// scheme rejected there must be rejected here too, since both funnel through
// the same safeUrl().
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCatalogContext, buildAskPrompt, parseAskResponse } = require('../src/ask.js');

/** A minimal valid catalog, shaped like loadLibraries()'s output. */
function catalog(over = {}) {
  return {
    total: 2,
    categories: [
      {
        title: { pl: 'Edytory wideo', en: 'Video Editors' },
        icon: 'video',
        items: [
          { id: 'kdenlive', name: 'Kdenlive', url: 'https://kdenlive.org', description: 'Free, open-source non-linear video editor.' },
        ],
      },
      {
        title: 'UI Kits',
        icon: 'default',
        items: [
          { id: 'daisyui', name: 'daisyUI', url: 'https://daisyui.com', description: 'Tailwind CSS component library.' },
        ],
      },
    ],
    ...over,
  };
}

/** Wraps a payload the way `claude --output-format json` does. */
function envelope(answer) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer) });
}

// ---- buildCatalogContext ----------------------------------------------------

test('buildCatalogContext lists each item with category, name, id and description', () => {
  const ctx = buildCatalogContext(catalog());
  assert.match(ctx, /Video Editors — Kdenlive \(id: kdenlive\): Free, open-source non-linear video editor\./);
  assert.match(ctx, /UI Kits — daisyUI \(id: daisyui\): Tailwind CSS component library\./);
});

test('buildCatalogContext handles an empty or malformed catalog', () => {
  assert.equal(buildCatalogContext({ categories: [] }), '');
  assert.equal(buildCatalogContext({}), '');
  assert.equal(buildCatalogContext(null), '');
  assert.equal(buildCatalogContext(undefined), '');
});

test('buildCatalogContext caps each line length', () => {
  const longDescription = 'x'.repeat(500);
  const huge = catalog({
    categories: [
      {
        title: 'Category',
        items: [{ id: 'thing', name: 'Thing', url: 'https://example.com', description: longDescription }],
      },
    ],
  });
  const ctx = buildCatalogContext(huge);
  const line = ctx.split('\n')[0];
  assert.ok(line.length <= 140, `line too long: ${line.length}`);
  assert.ok(line.endsWith('…'), 'a truncated line should end with an ellipsis marker');
});

test('buildCatalogContext caps the total number of entries', () => {
  const items = [];
  for (let i = 0; i < 250; i++) {
    items.push({ id: `item-${i}`, name: `Item ${i}`, url: 'https://example.com', description: 'A thing.' });
  }
  const big = catalog({ categories: [{ title: 'Big', items }] });
  const lines = buildCatalogContext(big).split('\n');
  assert.ok(lines.length <= 200, `expected at most 200 lines, got ${lines.length}`);
});

test('buildCatalogContext skips an item with no name or no id', () => {
  const bad = catalog({
    categories: [
      {
        title: 'Category',
        items: [
          { id: '', name: 'No id', url: 'https://example.com', description: 'x' },
          { id: 'ok', name: '', url: 'https://example.com', description: 'x' },
        ],
      },
    ],
  });
  assert.equal(buildCatalogContext(bad), '');
});

// ---- buildAskPrompt ----------------------------------------------------------

test('buildAskPrompt includes the question and the catalog context verbatim', () => {
  const ctx = 'Video Editors — Kdenlive (id: kdenlive): Free video editor.';
  const prompt = buildAskPrompt('what should I use to edit gaming clips', ctx);
  assert.match(prompt, /QUESTION: what should I use to edit gaming clips/);
  assert.ok(prompt.includes(ctx), 'prompt should include the catalog context verbatim');
});

test('buildAskPrompt instructs a JSON-only reply matching the schema', () => {
  const prompt = buildAskPrompt('question', 'context');
  assert.match(prompt, /ONLY a single JSON object/);
  assert.match(prompt, /"recommended"/);
  assert.match(prompt, /"suggestions"/);
  assert.match(prompt, /"capability"/);
  assert.match(prompt, /highlight-extractor/);
});

test('buildAskPrompt falls back to a placeholder for an empty catalog context', () => {
  const prompt = buildAskPrompt('question', '');
  assert.match(prompt, /catalog is currently empty/);
});

// ---- parseAskResponse: the security boundary --------------------------------

test('parseAskResponse accepts a valid full response', () => {
  const answer = {
    summary: 'Use Kdenlive for cutting clips; kdenlive is free and open source.',
    recommended: [{ id: 'kdenlive' }],
    suggestions: [
      {
        name: 'HitFilm',
        url: 'https://fxhome.com/hitfilm',
        description: 'Video editor with effects.',
        category: 'Video Editors',
        capability: null,
      },
    ],
  };
  const result = parseAskResponse(envelope(answer), catalog());
  assert.equal(result.ok, true);
  assert.equal(result.summary, answer.summary);
  assert.deepEqual(result.recommended, [
    {
      id: 'kdenlive',
      name: 'Kdenlive',
      url: 'https://kdenlive.org',
      description: 'Free, open-source non-linear video editor.',
      categoryTitle: 'Video Editors',
    },
  ]);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].name, 'HitFilm');
  assert.equal(result.suggestions[0].category, 'Video Editors');
  assert.equal(result.suggestions[0].capability, null);
});

test('parseAskResponse drops a recommended.id that is not in the loaded catalog', () => {
  const answer = {
    summary: 'x',
    recommended: [{ id: 'kdenlive' }, { id: 'totally-made-up-id' }],
    suggestions: [],
  };
  const result = parseAskResponse(envelope(answer), catalog());
  assert.equal(result.ok, true);
  assert.equal(result.recommended.length, 1);
  assert.equal(result.recommended[0].id, 'kdenlive');
});

test('parseAskResponse rejects a recommended entry with no id, or a non-array recommended', () => {
  const withBadEntry = parseAskResponse(
    envelope({ summary: 'x', recommended: [{}, { id: 42 }], suggestions: [] }),
    catalog()
  );
  assert.equal(withBadEntry.recommended.length, 0);

  const notAnArray = parseAskResponse(
    envelope({ summary: 'x', recommended: 'kdenlive', suggestions: [] }),
    catalog()
  );
  assert.equal(notAnArray.ok, true);
  assert.deepEqual(notAnArray.recommended, []);
});

test('parseAskResponse drops a suggestion whose url uses a rejected scheme', () => {
  // Same bad-scheme list test/libraries.test.js uses against safeUrl().
  const badUrls = [
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ms-msdt:/id',
    'vbscript:msgbox(1)',
    'not a url',
    '',
  ];
  for (const url of badUrls) {
    const answer = {
      summary: 'x',
      recommended: [],
      suggestions: [{ name: 'Bad Tool', url, description: 'x', category: 'new', capability: null }],
    };
    const result = parseAskResponse(envelope(answer), catalog());
    assert.equal(result.ok, true);
    assert.equal(result.suggestions.length, 0, `should have dropped suggestion with url: ${url}`);
  }
});

test('parseAskResponse keeps a suggestion with a valid http(s) url', () => {
  const answer = {
    summary: 'x',
    recommended: [],
    suggestions: [{ name: 'Good Tool', url: 'https://example.com/tool', description: 'x', category: 'new', capability: null }],
  };
  const result = parseAskResponse(envelope(answer), catalog());
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].url, 'https://example.com/tool');
});

test('parseAskResponse coerces an unrecognized capability to null', () => {
  const answer = {
    summary: 'x',
    recommended: [],
    suggestions: [
      { name: 'A', url: 'https://example.com/a', description: 'x', category: 'new', capability: 'rm-rf' },
      { name: 'B', url: 'https://example.com/b', description: 'x', category: 'new', capability: undefined },
      { name: 'C', url: 'https://example.com/c', description: 'x', category: 'new', capability: 'highlight-extractor' },
    ],
  };
  const result = parseAskResponse(envelope(answer), catalog());
  assert.equal(result.suggestions[0].capability, null);
  assert.equal(result.suggestions[1].capability, null);
  assert.equal(result.suggestions[2].capability, 'highlight-extractor');
});

test('parseAskResponse coerces an out-of-catalog category to "new"', () => {
  const answer = {
    summary: 'x',
    recommended: [],
    suggestions: [
      { name: 'A', url: 'https://example.com/a', description: 'x', category: 'Some Made Up Category', capability: null },
    ],
  };
  const result = parseAskResponse(envelope(answer), catalog());
  assert.equal(result.suggestions[0].category, 'new');
});

test('parseAskResponse keeps a suggestion category matching a real catalog title', () => {
  const answer = {
    summary: 'x',
    recommended: [],
    suggestions: [{ name: 'A', url: 'https://example.com/a', description: 'x', category: 'UI Kits', capability: null }],
  };
  const result = parseAskResponse(envelope(answer), catalog());
  assert.equal(result.suggestions[0].category, 'UI Kits');
});

test('parseAskResponse caps name/description/category string lengths', () => {
  const answer = {
    summary: 'x'.repeat(2000),
    recommended: [],
    suggestions: [
      {
        name: 'n'.repeat(500),
        url: 'https://example.com/a',
        description: 'd'.repeat(2000),
        category: 'c'.repeat(500),
        capability: null,
      },
    ],
  };
  const result = parseAskResponse(envelope(answer), catalog());
  assert.ok(result.summary.length <= 600, `summary too long: ${result.summary.length}`);
  assert.ok(result.suggestions[0].name.length <= 80, `name too long: ${result.suggestions[0].name.length}`);
  assert.ok(result.suggestions[0].description.length <= 300, `description too long: ${result.suggestions[0].description.length}`);
  // 'c'.repeat(500) is neither 'new' nor a real category, so it is coerced to
  // 'new' before the length cap would even matter - covered separately above.
});

test('parseAskResponse drops a suggestion with no name', () => {
  const answer = {
    summary: 'x',
    recommended: [],
    suggestions: [{ name: '', url: 'https://example.com/a', description: 'x', category: 'new', capability: null }],
  };
  const result = parseAskResponse(envelope(answer), catalog());
  assert.equal(result.suggestions.length, 0);
});

test('parseAskResponse rejects malformed top-level JSON', () => {
  const result = parseAskResponse('not json at all {{{', catalog());
  assert.deepEqual(result, { ok: false, reason: 'bad-json' });
});

test('parseAskResponse rejects when the envelope result field is not valid JSON', () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'not valid json' });
  const result = parseAskResponse(stdout, catalog());
  assert.deepEqual(result, { ok: false, reason: 'bad-json' });
});

test('parseAskResponse rejects a top-level value that is not an object', () => {
  assert.deepEqual(parseAskResponse('42', catalog()), { ok: false, reason: 'bad-json' });
  assert.deepEqual(parseAskResponse('null', catalog()), { ok: false, reason: 'bad-json' });
  assert.deepEqual(parseAskResponse('[1,2,3]', catalog()), { ok: false, reason: 'bad-json' });
  assert.deepEqual(parseAskResponse('"just a string"', catalog()), { ok: false, reason: 'bad-json' });
});

test('parseAskResponse accepts the answer directly when stdout is not wrapped in the CLI envelope', () => {
  // Defensive handling per src/ask.js: an object with no string `result` field
  // is treated as the answer itself.
  const answer = { summary: 'x', recommended: [], suggestions: [] };
  const result = parseAskResponse(JSON.stringify(answer), catalog());
  assert.equal(result.ok, true);
  assert.equal(result.summary, 'x');
});

test('parseAskResponse tolerates a missing/malformed catalog without throwing', () => {
  const answer = { summary: 'x', recommended: [{ id: 'kdenlive' }], suggestions: [] };
  assert.doesNotThrow(() => parseAskResponse(envelope(answer), null));
  assert.doesNotThrow(() => parseAskResponse(envelope(answer), {}));
  assert.doesNotThrow(() => parseAskResponse(envelope(answer), undefined));
  const result = parseAskResponse(envelope(answer), null);
  assert.equal(result.ok, true);
  assert.deepEqual(result.recommended, []);
});
