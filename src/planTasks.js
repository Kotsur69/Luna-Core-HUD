// ============================================================================
// LunaCore - Free God Mode v2 plan runs: PLAN.md tasks (slice F1b)
// ----------------------------------------------------------------------------
// parsePlanTasks() reads the `## Tasks` checkbox list a synthesis package
// wrote; checkTaskSizing() checks every task is small enough to become one
// God Mode package:
//
//   light  - format OK and an acceptance test present
//   strict - also: each file exists or is marked (new); at most
//            MAX_TASK_FILES files in at most MAX_TASK_AREAS top-level area;
//            at most ~MAX_TOUCHED_LINES lines of EXISTING code touched; an
//            acceptance test that is a command or a concrete check; task
//            text under MAX_TASK_TEXT_CHARS
//
// A strict failure sends ONE split brief back to the synthesis writer
// (nextSizingStep); a second failure flags the tasks for the board - it never
// blocks the run.
//
// Pure: the fs helpers are injected.
// ============================================================================

'use strict';

const path = require('path');

// Sizing limits (Mati's decision Q7).
const MAX_TASK_FILES = 5;
const MAX_TASK_AREAS = 1;
const MAX_TOUCHED_LINES = 400;
const MAX_TASK_TEXT_CHARS = 300;
// Split briefs sent to the synthesis writer before tasks are only flagged.
const MAX_SPLIT_ROUNDS = 1;

const ROOT_AREA = '(root)';
const TAB_WIDTH = 4;

const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\](?:\s+|$))?(.*)$/;
const FILES_KEY_RE = /^\**\s*(?:files?(?:\s*(?:\/|and|&)\s*areas?)?|areas?|paths?)\s*\**\s*:\s*\**\s*(.*)$/i;
const ACCEPT_KEY_RE = /^\**\s*(?:acceptance(?:\s+test)?|accept|test|verify|check)\s*\**\s*:\s*\**\s*(.*)$/i;
// Inline keys on a task line count only at the start of a clause - after
// `;`, `|`, `(` or a spaced dash - so "zero-byte files: skip" stays task text.
const INLINE_ACCEPT_RE = /(?:^|[;|(]|\s[-–—])\s*\**acceptance(?:\s+test)?\**\s*:\s*(.+)$/i;
const INLINE_FILES_RE = /(?:^|[;|(]|\s[-–—])\s*\**files?\**\s*:\s*(.+)$/i;

// Only words that do not open ordinary English sentences ("Make sure ...",
// "Go to ..."); `make` / `go` still count inside backticks.
const COMMAND_WORDS = new Set([
  'npm', 'npx', 'node', 'pnpm', 'yarn', 'bun', 'deno', 'git', 'python', 'python3', 'pytest',
  'pip', 'cargo', 'curl', 'bash', 'pwsh', 'powershell', 'dotnet', 'mvn',
  'gradle', 'tsc', 'eslint', 'jest', 'vitest', 'playwright', 'electron',
]);
const VAGUE_RE = /^(?:it\s+)?(?:works?|tests?\s+pass(?:es)?|all\s+good|looks\s+(?:good|right|fine)|manual(?:ly)?(?:\s+(?:test|check|testing))?|n\/?a|tbd|todo|none|-|ok|done|verify(?:\s+it)?\s+works?)\.?$/i;
const CONCRETE_RE =
  /\d|["'`]|\/|\.\w{1,5}\b|\b(?:shows?|returns?|contains?|prints?|exits?|renders?|displays?|equals?|lists?|opens?|logs?|fails?|pass(?:es)?|appears?|reads?|writes?|creates?|responds?|matches?)\b/i;
const MIN_CHECK_WORDS = 4;

/** Indent width of a line's leading whitespace (a tab counts TAB_WIDTH). */
function indentOf(ws) {
  return [...ws].reduce((n, c) => n + (c === '\t' ? TAB_WIDTH : 1), 0);
}

/**
 * Line range of the `## Tasks` section, or null. The PLAN.md outline's exact
 * `## Tasks` wins over a `### Tasks` nested under another section (e.g.
 * Milestones) or a looser `## Tasks (8)`. Headings inside fences never count.
 */
function tasksSection(lines) {
  const headings = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (l.trim().startsWith('```')) inFence = !inFence;
    else if (!inFence && /^#/.test(l.trim())) headings.push(i);
  });
  const exact = headings.find((i) => /^##\s+tasks\s*:?\s*$/i.test(lines[i].trim()));
  const loose = headings.find((i) => /^#{2,3}\s+tasks\b/i.test(lines[i].trim()));
  const start = exact !== undefined ? exact : loose;
  if (start === undefined) return null;
  const level = lines[start].trim().match(/^#+/)[0].length;
  let end = lines.length;
  let fenced = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('```')) fenced = !fenced;
    if (fenced) continue;
    const h = t.match(/^(#+)\s/);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
  }
  return { start: start + 1, end };
}

/**
 * One entry of a files list: `src/x.js`, `` `src/x.js` (new) ``, `new: src/y.js`.
 * @returns {{path:string, isNew:boolean} | null}
 */
function parseFileEntry(raw) {
  let text = String(raw || '').trim();
  let isNew = false;
  const prefix = text.match(/^(?:\(new\)|\[new\]|new\s*:|new\s+file\s*:?)\s*/i);
  if (prefix) {
    isNew = true;
    text = text.slice(prefix[0].length);
  }
  const m = text.match(/^`([^`]+)`\s*(.*)$/) || text.match(/^([^\s(`[]+)\s*(.*)$/);
  if (!m) return null;
  if (/\bnew\b/i.test(m[2])) isNew = true;
  const p = m[1]
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/[.,;:]+$/, '');
  return p ? { path: p, isNew } : null;
}

/** Splits on `,` / `;` / ` and ` outside parentheses and backticks. */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let tick = false;
  let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '`') tick = !tick;
    else if (!tick && c === '(') depth += 1;
    else if (!tick && c === ')') depth = Math.max(0, depth - 1);
    const top = !tick && depth === 0;
    const and = top ? text.slice(i).match(/^\s+and\s+/i) : null;
    if (top && (c === ',' || c === ';' || and)) {
      out.push(cur);
      cur = '';
      if (and) i += and[0].length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Looks like a file or folder path, not a prose word ("the", "tests"). */
const looksLikePath = (p) => /[/.]/.test(p) || /file$/i.test(p);

/** A comma/semicolon separated files list. */
function parseFileList(text) {
  return splitTopLevel(String(text || ''))
    .map(parseFileEntry)
    .filter((f) => f && looksLikePath(f.path));
}

/** Splits inline `Files:` / `Acceptance:` parts off a task line. */
function splitInline(text) {
  let rest = text;
  let acceptance = null;
  let files = [];
  const acc = rest.match(INLINE_ACCEPT_RE);
  if (acc) {
    acceptance = acc[1].trim();
    rest = rest.slice(0, acc.index);
  }
  const fl = rest.match(INLINE_FILES_RE);
  if (fl) {
    files = parseFileList(fl[1]);
    rest = rest.slice(0, fl.index);
  }
  return { text: rest.replace(/[\s;|,(–—-]+$/, '').trim(), acceptance, files };
}

function newTask(index, line, item) {
  const inline = splitInline(item.body);
  return {
    index,
    line,
    text: inline.text,
    checked: item.mark === 'x' || item.mark === 'X',
    hasCheckbox: item.mark !== undefined,
    files: inline.files,
    acceptance: inline.acceptance,
    subtasks: [],
    notes: [],
  };
}

/**
 * Reads the tasks of a PLAN.md. Top-level list items of the `## Tasks`
 * section are tasks; nested `Files:` / `Acceptance:` lines (or inline
 * `Files: ... Acceptance: ...` on the task line) fill them in; nested
 * checkboxes are subtasks; anything else nested is a note. A missing section
 * yields an empty list.
 * @param {string} markdown
 * @returns {Array<{index:number, line:number, text:string, checked:boolean, hasCheckbox:boolean,
 *   files:Array<{path:string, isNew:boolean}>, acceptance:string|null,
 *   subtasks:Array<{text:string, checked:boolean}>, notes:string[]}>}
 */
function parsePlanTasks(markdown) {
  if (typeof markdown !== 'string') return [];
  const lines = markdown.split(/\r?\n/);
  const section = tasksSection(lines);
  if (!section) return [];

  const tasks = [];
  let topIndent = null;
  let current = null;
  let filesIndent = null; // a `Files:` line with no inline value collects deeper items
  let fenced = false;

  for (let i = section.start; i < section.end; i += 1) {
    const raw = lines[i];
    if (raw.trim().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !raw.trim()) continue;
    const m = raw.match(ITEM_RE);
    if (!m) {
      if (current) current.notes.push(raw.trim());
      continue;
    }
    const indent = indentOf(m[1]);
    const item = { mark: m[2], body: m[3].trim() };
    if (topIndent === null || indent <= topIndent) {
      topIndent = topIndent === null ? indent : Math.min(topIndent, indent);
      current = newTask(tasks.length, i + 1, item);
      tasks.push(current);
      filesIndent = null;
      continue;
    }
    if (!current) continue;
    if (filesIndent !== null && indent > filesIndent && item.mark === undefined) {
      current.files.push(...parseFileList(item.body));
      continue;
    }
    filesIndent = null;
    const files = item.mark === undefined && item.body.match(FILES_KEY_RE);
    if (files) {
      if (files[1].trim()) current.files.push(...parseFileList(files[1]));
      else filesIndent = indent;
      continue;
    }
    const acc = item.mark === undefined && item.body.match(ACCEPT_KEY_RE);
    if (acc) {
      current.acceptance = acc[1].trim() || current.acceptance;
      continue;
    }
    if (item.mark !== undefined) current.subtasks.push({ text: item.body, checked: item.mark !== ' ' });
    else current.notes.push(item.body);
  }
  return tasks;
}

/**
 * What kind of acceptance test a task has.
 * @param {string|null} text
 * @returns {'missing'|'command'|'check'|'vague'}
 */
function acceptanceKind(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return 'missing';
  if (/`[^`]+`/.test(t)) return 'command';
  const first = t.replace(/^run\s+/i, '').split(/\s+/)[0].toLowerCase();
  if (COMMAND_WORDS.has(first)) return 'command';
  if (VAGUE_RE.test(t)) return 'vague';
  if (t.split(/\s+/).length < MIN_CHECK_WORDS) return 'vague';
  return CONCRETE_RE.test(t) ? 'check' : 'vague';
}

/** First path segment, or ROOT_AREA for a file at the repo root. */
function areaOf(p) {
  const i = p.indexOf('/');
  return i < 0 ? ROOT_AREA : p.slice(0, i);
}

/** A path that cannot be a plain repo-relative file. */
function isBadPath(p) {
  return /^[a-zA-Z]:|^\//.test(p) || p.split('/').some((s) => s === '..');
}

const fail = (code, reason) => ({ code, reason });

/** Format checks that hold in light and strict mode. */
function lightFailures(task) {
  const out = [];
  if (!task.hasCheckbox) out.push(fail('noCheckbox', 'not a checkbox item (`- [ ] ...`)'));
  if (!task.text) out.push(fail('emptyText', 'the task has no text'));
  if (acceptanceKind(task.acceptance) === 'missing') out.push(fail('noAcceptance', 'no acceptance test'));
  return out;
}

/** File checks of strict mode. */
function fileFailures(task, { repoRoot, fileExists, lineCount }) {
  const out = [];
  if (!task.files.length) return [fail('noFiles', 'no files or areas listed')];
  let touched = 0;
  for (const f of task.files) {
    if (isBadPath(f.path)) {
      out.push(fail('badPath', `\`${f.path}\` is not a repo-relative path`));
      continue;
    }
    const abs = path.join(repoRoot || '', f.path);
    if (f.isNew) continue;
    if (!fileExists(abs, f.path)) {
      out.push(fail('missingFile', `\`${f.path}\` does not exist and is not marked (new)`));
      continue;
    }
    const n = Number(lineCount(abs, f.path));
    if (Number.isFinite(n) && n > 0) touched += n;
  }
  if (task.files.length > MAX_TASK_FILES) {
    out.push(fail('tooManyFiles', `${task.files.length} files (max ${MAX_TASK_FILES})`));
  }
  const areas = [...new Set(task.files.map((f) => areaOf(f.path)))];
  if (areas.length > MAX_TASK_AREAS) {
    out.push(fail('tooManyAreas', `${areas.length} top-level areas: ${areas.join(', ')} (max ${MAX_TASK_AREAS})`));
  }
  if (touched > MAX_TOUCHED_LINES) {
    out.push(fail('tooManyLines', `touches ~${touched} lines of existing code (max ~${MAX_TOUCHED_LINES})`));
  }
  return out;
}

/**
 * Checks every task's size and format.
 * @param {ReturnType<typeof parsePlanTasks>} tasks
 * @param {{strict?:boolean, repoRoot?:string,
 *          fileExists?:(abs:string, rel:string)=>boolean, lineCount?:(abs:string, rel:string)=>number}} [opts]
 *   fileExists / lineCount are required in strict mode
 * @returns {{ok:boolean, strict:boolean, tasks:Array<{index:number, text:string, failures:Array<{code:string, reason:string}>}>,
 *   failing:Array<{index:number, text:string, failures:Array<{code:string, reason:string}>}>}}
 */
function checkTaskSizing(tasks, opts = {}) {
  const strict = opts.strict === true;
  if (strict && (typeof opts.fileExists !== 'function' || typeof opts.lineCount !== 'function')) {
    throw new TypeError('strict task sizing needs fileExists and lineCount helpers');
  }
  const results = (Array.isArray(tasks) ? tasks : []).map((task) => {
    const failures = lightFailures(task);
    if (strict) {
      const kind = acceptanceKind(task.acceptance);
      if (kind === 'vague') {
        failures.push(fail('vagueAcceptance', 'the acceptance test is neither a command nor a concrete check'));
      }
      if (task.text.length > MAX_TASK_TEXT_CHARS) {
        failures.push(fail('textTooLong', `task text is ${task.text.length} chars (max ${MAX_TASK_TEXT_CHARS})`));
      }
      failures.push(...fileFailures(task, opts));
    }
    return { index: task.index, text: task.text, failures };
  });
  const failing = results.filter((r) => r.failures.length);
  return { ok: failing.length === 0, strict, tasks: results, failing };
}

/**
 * The follow-up brief to the synthesis writer: split the failing tasks.
 * @param {Array<{index:number, text:string, failures:Array<{reason:string}>}>} failing
 * @param {{planPath:string}} opts
 */
function buildSplitBrief(failing, { planPath }) {
  return [
    `Some tasks in \`${planPath}\` are too big or unclear to become one work package each. Split these tasks:`,
    '',
    ...failing.flatMap((t) => [
      `- Task ${t.index + 1}: ${t.text || '(no text)'}`,
      ...t.failures.map((f) => `  - ${f.reason}`),
    ]),
    '',
    'Limits for every task:',
    `- at most ${MAX_TASK_FILES} files, all in ${MAX_TASK_AREAS === 1 ? 'one top-level folder' : `${MAX_TASK_AREAS} top-level folders`}`,
    `- at most ~${MAX_TOUCHED_LINES} lines of existing code touched (sum of the files' lengths)`,
    '- every file exists, or is marked `(new)`',
    '- `- Acceptance:` is a command (e.g. `npm test`) or one concrete check',
    `- task text under ${MAX_TASK_TEXT_CHARS} characters`,
    '',
    `Edit only the \`## Tasks\` section of \`${planPath}\`: replace each task above with smaller tasks in the same format. Keep the other tasks unchanged. Commit the change.`,
  ].join('\n');
}

/**
 * What to do with a sizing result.
 * @param {ReturnType<typeof checkTaskSizing>} sizing
 * @param {{splitsSent?:number, planPath:string}} opts
 * @returns {{action:'accept'}
 *   | {action:'split', brief:string}
 *   | {action:'flag', flagged:Array<{index:number, text:string, reasons:string[]}>}}
 *   flag: the tasks go to the board marked, the run is NOT blocked
 */
function nextSizingStep(sizing, { splitsSent = 0, planPath }) {
  if (sizing.ok) return { action: 'accept' };
  if (sizing.strict && splitsSent < MAX_SPLIT_ROUNDS) {
    return { action: 'split', brief: buildSplitBrief(sizing.failing, { planPath }) };
  }
  return {
    action: 'flag',
    flagged: sizing.failing.map((t) => ({ index: t.index, text: t.text, reasons: t.failures.map((f) => f.reason) })),
  };
}

module.exports = {
  MAX_TASK_FILES,
  MAX_TASK_AREAS,
  MAX_TOUCHED_LINES,
  MAX_TASK_TEXT_CHARS,
  MAX_SPLIT_ROUNDS,
  ROOT_AREA,
  parsePlanTasks,
  parseFileList,
  acceptanceKind,
  checkTaskSizing,
  buildSplitBrief,
  nextSizingStep,
};
