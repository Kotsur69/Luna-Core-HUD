// ============================================================================
// LunaCore - /ask tool recommender (Ctrl+B)
// ----------------------------------------------------------------------------
// Lets the user type "/ask <question>" into the existing libraries filter box
// and get back a short, grounded tool recommendation - without a new Anthropic
// API key. It reuses the `claude` CLI the app already knows how to launch
// (spawnInto()'s withClaudeOnPath()/stripClaudeSessionMarkers() env prep, see
// main.js), but headless and one-shot: `execFile('claude', ['-p', ...])`, no
// PTY, no terminal tab, just captured stdout. `--model sonnet` is explicit so
// the answer is always Sonnet regardless of which profile's terminal happens
// to be active (a profile can point ANTHROPIC_BASE_URL at a local LM Studio
// endpoint - inheriting that env by accident would silently answer from a
// local model instead).
//
// THE SECURITY BOUNDARY IS parseAskResponse()
// --------------------------------------------
// The model's JSON reply is advisory only and is never allowed to act on
// anything by itself:
//   - `recommended[].id` is cross-referenced against the CATALOG THIS PROCESS
//     ALREADY LOADED (loadLibraries()), exactly like resolveLibraryUrl() does
//     for libraries:open - an id the model invented, or one that no longer
//     exists, is silently dropped rather than trusted.
//   - `suggestions[].url` is run through libraries.js's safeUrl() - the same
//     http(s)-only gate that stands between config/libraries.local.json and
//     shell.openExternal - so a hallucinated `javascript:`/`file:` URL can
//     never reach a link card. A suggestion whose URL fails is DROPPED
//     ENTIRELY rather than kept with a null url: a card with no working link
//     isn't a useful card, and it keeps "every suggestion the UI shows has a
//     url" a card renderer can rely on without a conditional.
//   - every string is length-capped and `capability` is coerced onto a fixed
//     allow-list (`null` | `'highlight-extractor'`), so a hostile or broken
//     model reply can only ever produce a slightly wrong DISPLAY, never a
//     bigger blob, a new capability code the renderer doesn't understand, or
//     (per the plan) an actual filesystem/ffmpeg action - that always goes
//     through a real dialog the user confirms.
//
// Same "always resolves, never rejects" async shape as usage.js's fetchUsage():
// every failure mode is a typed { ok:false, reason } the renderer can show a
// dedicated row for, never a thrown exception.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const { safeUrl } = require('./libraries');
const { titleText } = require('./localized');

/** Default timeout for the one-shot `claude -p` call. */
const DEFAULT_TIMEOUT_MS = 45000;

/** buildCatalogContext caps, so a large catalog can't balloon the prompt. */
const MAX_CATALOG_ENTRY_CHARS = 140;
const MAX_CATALOG_ENTRIES = 200;

/** parseAskResponse caps - generous enough for a real answer, small enough
 *  that a runaway model reply can't blow up the renderer's DOM. */
const MAX_SUMMARY_CHARS = 600;
const MAX_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_CATEGORY_CHARS = 80;
const MAX_RECOMMENDED = 10;
const MAX_SUGGESTIONS = 10;

/** The only capability values the renderer knows how to act on. */
const ALLOWED_CAPABILITIES = new Set([null, 'highlight-extractor']);

/** Fallback category name for a suggestion the model flags "new" but gives no
 *  (or an unusable) newCategoryTitle for - see parseAskResponse() below. */
const DEFAULT_NEW_CATEGORY_TITLE = 'Suggested Tools';

/**
 * Condenses loadLibraries()'s catalog into short lines the prompt can afford:
 * "<category> — <name> (id: <id>): <description>". The id is included (a
 * small deviation from a bare name/description blurb) because `recommended`
 * asks the model for an id, and parseAskResponse() only trusts an id that is
 * actually in the catalog - without showing the id here the model would have
 * no way to answer with one that validates.
 * @param {{categories?: Array<{title:unknown, items?: Array<{id:string,name:string,description?:string}>}>}} catalog
 * @returns {string}
 */
function buildCatalogContext(catalog) {
  const categories = catalog && Array.isArray(catalog.categories) ? catalog.categories : [];
  const lines = [];
  for (const category of categories) {
    const catName = titleText(category && category.title);
    const items = Array.isArray(category && category.items) ? category.items : [];
    for (const item of items) {
      if (!item || typeof item.name !== 'string' || !item.name.trim()) continue;
      if (typeof item.id !== 'string' || !item.id) continue;
      const description = typeof item.description === 'string' ? item.description : '';
      let line = `${catName} — ${item.name} (id: ${item.id}): ${description}`;
      if (line.length > MAX_CATALOG_ENTRY_CHARS) {
        line = `${line.slice(0, MAX_CATALOG_ENTRY_CHARS - 1)}…`;
      }
      lines.push(line);
      if (lines.length >= MAX_CATALOG_ENTRIES) return lines.join('\n');
    }
  }
  return lines.join('\n');
}

/**
 * Builds the exact prompt text sent to `claude -p`. Instructs the model to
 * reply with ONLY JSON matching a fixed schema, grounded in `catalogContext`
 * (from buildCatalogContext()). No URLs are sent to the model - only names,
 * category, description and id - keeping the prompt small and giving the
 * model nothing to just echo back as a "recommendation".
 * @param {string} question
 * @param {string} catalogContext
 * @returns {string}
 */
function buildAskPrompt(question, catalogContext) {
  const catalogBlock = catalogContext && catalogContext.trim() ? catalogContext : '(catalog is currently empty)';
  return [
    'You are the tool-recommendation assistant built into LunaCore, a developer HUD.',
    'The user is asking for a tool recommendation. Answer using the CATALOG below',
    "(the user's own curated list) and your own knowledge of real tools that are not",
    'catalogued yet.',
    '',
    'Reply with ONLY a single JSON object - no prose, no markdown code fences, nothing',
    'before or after it - matching EXACTLY this schema:',
    '{',
    '  "summary": string,',
    '  "recommended": [{ "id": string }],',
    '  "suggestions": [',
    '    { "name": string, "url": string, "description": string, "category": string,',
    '      "newCategoryTitle": string|null, "capability": string|null }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- "summary" is a short (1-3 sentence) plain-language answer to the question.',
    '- "recommended" lists catalog entries worth pointing the user at, referenced by their',
    '  exact "id" as shown in the CATALOG below (the "(id: ...)" part after each name). Use',
    '  [] when nothing in the catalog fits - never invent an id.',
    '- "suggestions" lists real tools that help but are NOT in the catalog. Use [] when none.',
    '- "suggestions[].category" must be copied EXACTLY from one of the category names shown',
    '  in the CATALOG below, OR the literal string "new" when none of them fit.',
    '- "suggestions[].newCategoryTitle" must be null UNLESS "category" is "new" - in that case',
    '  it must be a short (2-4 word) descriptive category name in Title Case for what kind of',
    '  tool this is (e.g. "Video Editing", "Note Taking"), never a vague name like "Other" or',
    '  "Misc".',
    '- "suggestions[].capability" must be null, UNLESS the suggestion is specifically a tool',
    '  for trimming/cutting video clips down to a highlight - in that one case, set it to',
    '  the literal string "highlight-extractor". Otherwise it must be null.',
    '- "suggestions[].url" must be a real http(s) URL for the tool (its homepage or repo).',
    '',
    'CATALOG (category — name (id): description):',
    catalogBlock,
    '',
    `QUESTION: ${question}`,
  ].join('\n');
}

/** Trims a value to a plain string, capped at maxLen. Anything else -> ''. */
function clampString(value, maxLen) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/**
 * Unwraps `claude --output-format json`'s outer envelope. Per the headless
 * print-mode contract that envelope is `{type, subtype, is_error, result, ...}`
 * where `result` is itself a JSON string holding the model's actual reply
 * (because we asked the model to answer in JSON). Coded defensively for both
 * shapes rather than assuming one: try the raw stdout as JSON first, and if
 * the resulting object has a string `result` field, parse THAT as the real
 * answer; otherwise treat the top-level object as the answer directly.
 * @param {string} cliStdout
 * @returns {unknown|null} null on any parse failure at either stage
 */
function unwrapEnvelope(cliStdout) {
  let outer;
  try {
    outer = JSON.parse(cliStdout);
  } catch {
    return null;
  }
  if (outer && typeof outer === 'object' && typeof outer.result === 'string') {
    try {
      return JSON.parse(outer.result);
    } catch {
      return null;
    }
  }
  return outer;
}

/**
 * Parses and validates a `claude -p ... --output-format json` reply. This is
 * the security boundary described in this file's header: nothing here is
 * trusted just because it parsed as JSON.
 * @param {string} cliStdout
 * @param {{categories?: Array<{title:unknown, items?: Array<{id:string,name:string,url:string,description?:string}>}>}} catalog
 * @returns {{ok:true, summary:string, recommended:Array<object>, suggestions:Array<object>} | {ok:false, reason:'bad-json'}}
 */
function parseAskResponse(cliStdout, catalog) {
  const answer = unwrapEnvelope(cliStdout);
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return { ok: false, reason: 'bad-json' };
  }

  // Index the already-loaded catalog once: recommended.id and
  // suggestions.category both cross-reference it, and this is the only
  // "trusted" data in this whole function.
  const itemsById = new Map();
  const categoryTitles = new Set();
  const categories = catalog && Array.isArray(catalog.categories) ? catalog.categories : [];
  for (const category of categories) {
    const catName = titleText(category && category.title);
    if (catName) categoryTitles.add(catName);
    const items = Array.isArray(category && category.items) ? category.items : [];
    for (const item of items) {
      if (item && typeof item.id === 'string' && item.id) {
        itemsById.set(item.id, { ...item, categoryTitle: catName });
      }
    }
  }

  const rawRecommended = Array.isArray(answer.recommended) ? answer.recommended : [];
  const recommended = [];
  for (const entry of rawRecommended) {
    if (recommended.length >= MAX_RECOMMENDED) break;
    const id = entry && typeof entry.id === 'string' ? entry.id : null;
    const full = id ? itemsById.get(id) : undefined;
    if (!full) continue; // never trust an id blindly - drop anything not in the loaded catalog
    recommended.push({
      id: full.id,
      name: full.name,
      url: full.url,
      description: full.description,
      categoryTitle: full.categoryTitle,
    });
  }

  const rawSuggestions = Array.isArray(answer.suggestions) ? answer.suggestions : [];
  const suggestions = [];
  for (const entry of rawSuggestions) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    if (!entry || typeof entry !== 'object') continue;
    const name = clampString(entry.name, MAX_NAME_CHARS);
    if (!name) continue; // a suggestion with no name is not displayable
    const url = safeUrl(entry.url);
    // Dropped entirely, not null'd: a suggestion the user can't open isn't a
    // useful card, and it keeps "every suggestion has a working url" a rule
    // the card renderer can rely on without a null check.
    if (!url) continue;
    const description = clampString(entry.description, MAX_DESCRIPTION_CHARS);
    let category = clampString(entry.category, MAX_CATEGORY_CHARS);
    // Anything that isn't a real category title and isn't the "new" literal
    // is coerced to "new" - the renderer's "not in your library yet" bucket -
    // rather than dropping the whole suggestion over a category name typo.
    if (category !== 'new' && !categoryTitles.has(category)) category = 'new';
    const capability = ALLOWED_CAPABILITIES.has(entry.capability) ? entry.capability : null;
    // Only meaningful when category === 'new' - a real catalog category needs
    // no name of its own, and addLibraryItem() (src/libraries.js) never looks
    // at this field otherwise. This is the "good category" half of "Add to my
    // library": a suggestion that doesn't fit the catalog gets a real,
    // specific bucket instead of one generic dumping ground.
    const newCategoryTitle =
      category === 'new'
        ? clampString(entry.newCategoryTitle, MAX_CATEGORY_CHARS) || DEFAULT_NEW_CATEGORY_TITLE
        : null;
    suggestions.push({ name, url, description, category, capability, newCategoryTitle });
  }

  return {
    ok: true,
    summary: clampString(answer.summary, MAX_SUMMARY_CHARS),
    recommended,
    suggestions,
  };
}

/**
 * Pure argv builder for the headless `claude -p` call - never a shell string,
 * same reasoning src/highlights.js's buildTrimArgs() documents for the same
 * shape. Split out so the one behavioural choice this function makes (when
 * to omit `--model`) is unit-testable without spawning a real process, same
 * pure/impure split as buildTrimArgs()/HighlightBatchJob.
 *
 * `model` is `'sonnet'` by default - the CLI always gets an explicit model
 * when talking to the cloud, per this file's header. Passing a falsy `model`
 * (the ask:query handler's local-model path in src/main.js, gated behind the
 * askUseLocalModel setting) omits the flag entirely: a local endpoint serves
 * whatever it has loaded regardless of the requested model id, and forcing
 * "sonnet" at it would be a name with no effect, not a real choice.
 * @param {{prompt:string, model?:string|null}} args
 * @returns {string[]}
 */
function buildAskArgs({ prompt, model = 'sonnet' }) {
  const args = ['-p', prompt];
  if (model) args.push('--model', model);
  args.push('--output-format', 'json');
  return args;
}

/**
 * The impure orchestrator: validates the question, runs a one-shot headless
 * `claude -p` call and hands its stdout to parseAskResponse(). Always
 * resolves, never rejects/throws - every failure mode is a typed
 * { ok:false, reason }, same convention as fetchUsage()'s { error } states.
 * @param {{question:string, catalog:object, env:Record<string,string>, timeoutMs?:number, model?:string|null}} args
 * @returns {Promise<{ok:true,...}|{ok:false,reason:'empty-question'|'no-claude'|'timeout'|'generic'|'bad-json'}>}
 */
function runAsk({ question, catalog, env, timeoutMs = DEFAULT_TIMEOUT_MS, model = 'sonnet' } = {}) {
  return new Promise((resolve) => {
    const trimmedQuestion = typeof question === 'string' ? question.trim() : '';
    if (!trimmedQuestion) {
      resolve({ ok: false, reason: 'empty-question' });
      return;
    }

    const prompt = buildAskPrompt(trimmedQuestion, buildCatalogContext(catalog));

    execFile(
      'claude',
      buildAskArgs({ prompt, model }),
      { env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          if (error.code === 'ENOENT') {
            resolve({ ok: false, reason: 'no-claude' });
            return;
          }
          // Node kills the child with SIGTERM (the default killSignal) once
          // `timeout` elapses, and marks the resulting error `killed: true`
          // with that signal - that is the documented, stable way to tell a
          // timeout apart from an ordinary non-zero exit. The `|| !error.signal`
          // fallback covers signal reporting being unreliable on Windows
          // (this app's primary platform) even though `killed` still is.
          if (error.killed && (error.signal === 'SIGTERM' || !error.signal)) {
            resolve({ ok: false, reason: 'timeout' });
            return;
          }
          if (!stdout) {
            resolve({ ok: false, reason: 'generic' });
            return;
          }
        }
        resolve(parseAskResponse(stdout || '', catalog));
      }
    );
  });
}

module.exports = { buildCatalogContext, buildAskPrompt, buildAskArgs, parseAskResponse, runAsk };
