// ============================================================================
// LunaCore - God Mode push protection: secret shapes, scan, rejection text
// ----------------------------------------------------------------------------
// GitHub push protection (GH013, "Push cannot contain secrets") rejects a push
// when ANY pushed commit adds a secret-shaped string - even a fake one in a
// test - so a fix commit on top never helps: the commits that never reached
// origin have to be rewritten. This module holds the pure half of handling
// that (orchestraFinish.js runs git, orchestra.js routes the result):
//
//   scanAddedLines(log)      - secret shapes on the lines a `git log -p`
//                              adds: kind, file, line and commit, NEVER the
//                              value
//   redactSecrets(text)      - the same shapes masked, before git's output is
//                              stored or shown anywhere
//   pushRejectionDetail(err) - every `remote:` line of a rejected push
//                              (redacted, capped), not just the first one
//   pushBlockKind(err)       - 'secret' | 'rule' | null for a GH013 rejection
//   secretScanText / pushBlockText - the fix-up round pasted to the worker
//
// Pure; never throws.
// ============================================================================

'use strict';

const { scrub } = require('./hostscrub');

const MAX_DETAIL_CHARS = 2000;
const MAX_HITS = 20;
// A minified line can be huge: only its start is matched (bounded regex work).
const MAX_LINE_SCAN_CHARS = 20000;
// The commit marker LunaCore asks `git log --format` for.
const COMMIT_MARK = 'luna-commit ';

/**
 * Common secret shapes (the ones GitHub push protection blocks most often).
 * Global regexes: used through replace() and the lastIndex-safe test below.
 */
const SECRET_RULES = [
  { kind: 'privateKey', label: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: 'stripeKey', label: 'Stripe key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'githubToken', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'anthropicKey', label: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'awsKey', label: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'googleKey', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
];

const LABEL = Object.fromEntries(SECRET_RULES.map((r) => [r.kind, r.label]));

/** Every known secret shape in `text` masked as `[redacted <kind>]`, then the host scrubber. */
function redactSecrets(text) {
  const masked = SECRET_RULES.reduce((s, r) => s.replace(r.re, `[redacted ${r.kind}]`), String(text == null ? '' : text));
  return scrub(masked);
}

/** The secret kinds found in one line (each kind once). */
function kindsIn(line) {
  const part = line.length > MAX_LINE_SCAN_CHARS ? line.slice(0, MAX_LINE_SCAN_CHARS) : line;
  return SECRET_RULES.filter((r) => {
    r.re.lastIndex = 0;
    const found = r.re.test(part);
    r.re.lastIndex = 0;
    return found;
  }).map((r) => r.kind);
}

/** `+++ b/path` -> path; a deleted file (/dev/null) -> null. Git-quoted paths are unquoted. */
function newPathOf(header) {
  const raw = header.slice(4).trim();
  if (raw === '/dev/null') return null;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.replace(/^b\//, '');
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Secret shapes on the lines a `git log -p --unified=0 --format='luna-commit %H'`
 * output adds. Only added lines count. Hits say where, never what.
 * @param {string} logText
 * @returns {Array<{kind:string, label:string, file:string, line:number, commit:string}>}
 */
function scanAddedLines(logText) {
  const hits = [];
  const seen = new Set();
  let commit = '';
  let file = null;
  let inHunk = false;
  let lineNo = 0;
  for (const raw of String(logText || '').split('\n')) {
    if (hits.length >= MAX_HITS) break;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith(COMMIT_MARK)) {
      commit = line.slice(COMMIT_MARK.length).trim();
      inHunk = false;
      file = null;
    } else if (line.startsWith('diff --git ')) {
      inHunk = false;
      file = null;
    } else if (!inHunk && line.startsWith('+++ ')) {
      file = newPathOf(line);
    } else if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      inHunk = !!m;
      lineNo = m ? Number(m[1]) : 0;
    } else if (inHunk && line.startsWith('+')) {
      if (file) {
        for (const kind of kindsIn(line.slice(1))) {
          const key = `${kind}:${file}:${lineNo}`;
          if (seen.has(key) || hits.length >= MAX_HITS) continue;
          seen.add(key);
          hits.push({ kind, label: LABEL[kind], file, line: lineNo, commit: commit.slice(0, 12) });
        }
      }
      lineNo += 1;
    } else if (inHunk && line.startsWith(' ')) {
      lineNo += 1;
    }
  }
  return hits;
}

const cap = (text, max) => (text.length > max ? `${text.slice(0, max - 16)}\n... (truncated)` : text);

/**
 * What a rejected push said, for pkg.detail and the report: every `remote:`
 * line with content (GitHub names the rule, the secret type, the file and
 * the commit there), plus git's `! [remote rejected]` line. Secret values are
 * redacted before anything is kept. No `remote:` lines -> git's first line.
 * @param {string} stderr
 * @returns {string} at most MAX_DETAIL_CHARS
 */
function pushRejectionDetail(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  const remote = lines
    .filter((l) => /^remote:/i.test(l))
    .map((l) => l.replace(/^remote:/i, '').trim())
    // Blank lines and GitHub's decorative rules carry nothing.
    .filter((l) => l && !/^[\s—–─_=-]+$/.test(l));
  if (!remote.length) {
    const first = lines.map((l) => l.trim()).find(Boolean) || '';
    return cap(redactSecrets(first), MAX_DETAIL_CHARS);
  }
  const rejected = lines.map((l) => l.trim()).find((l) => l.startsWith('! ['));
  return cap(redactSecrets([...remote, ...(rejected ? [rejected] : [])].join('\n')), MAX_DETAIL_CHARS);
}

/**
 * A GH013 rejection: 'secret' (push protection found a secret), 'rule' (some
 * other repository rule), or null for any other push failure.
 * @param {string} text stderr or a stored detail
 * @returns {'secret'|'rule'|null}
 */
function pushBlockKind(text) {
  const s = String(text || '');
  if (/push cannot contain secrets|GITHUB PUSH PROTECTION|secret-scanning\/unblock-secret/i.test(s)) return 'secret';
  if (/\bGH013\b|repository rule violations/i.test(s)) return 'rule';
  return null;
}

/** The fake-secret rule every worker brief carries (orchestra.js briefText). */
const FAKE_SECRET_RULE =
  '- Never write a secret-shaped string as a literal, not even a fake one in a test (Stripe, GitHub, Anthropic, AWS, Google keys, private key headers): GitHub push protection rejects the push when ANY commit contains one. Assemble fake secrets at runtime from parts (e.g. a prefix joined with a repeated filler) so the full shape never appears in the source.';

/** How to rewrite only what never reached origin. */
function rewriteSteps(range) {
  const onto = String(range || '').split('..')[0] || 'the base commit';
  return [
    `Rewrite ONLY the commits that never reached origin (\`git log --oneline ${range}\`) so that none of them contains it:`,
    `for example \`git reset --soft ${onto}\` and commit the fixed tree again, or \`git commit --amend\` when it is only in the last commit.`,
    'Never rewrite or force-push commits that are already on origin, and do not push - LunaCore pushes once you are done.',
  ];
}

/**
 * The fix-up round after LunaCore's own scan found secret shapes in commits
 * that were not pushed yet. Names file, line and commit - never the value.
 * @param {string} pkgId
 * @param {Array<{label:string, file:string, line:number, commit:string}>} hits
 * @param {string} range the unpushed commit range, e.g. `<base>..HEAD`
 * @returns {string}
 */
function secretScanText(pkgId, hits, range) {
  const where = hits.map((h) => `- ${h.label} in ${h.file}:${h.line}${h.commit ? ` (commit ${h.commit.slice(0, 7)})` : ''}`);
  return [
    'LunaCore scanned the commits you have not pushed yet and found secret-shaped strings. GitHub push protection rejects a push when ANY commit contains one, so a fix commit on top is not enough:',
    '',
    ...where,
    '',
    'Remove each one: a fake key in a test must be assembled at runtime from parts, never written as one literal; a real key belongs in an environment variable.',
    ...rewriteSteps(range),
    `Then run the verify command again and end with LUNA_DONE ${pkgId}.`,
  ].join('\n');
}

/**
 * The fix-up round after GitHub rejected the push with GH013.
 * @param {string} pkgId
 * @param {string} detail pushRejectionDetail() output (already redacted)
 * @param {string} range
 * @param {'secret'|'rule'} kind
 * @returns {string}
 */
function pushBlockText(pkgId, detail, range, kind) {
  const what =
    kind === 'secret'
      ? 'GitHub push protection rejected your branch (GH013: Push cannot contain secrets). A commit adds a secret-shaped string; GitHub checks every pushed commit, so a fix commit on top does not help. Its report:'
      : 'GitHub rejected your branch because of a repository rule (GH013). Its report:';
  return [
    what,
    '',
    '```',
    redactSecrets(detail),
    '```',
    '',
    kind === 'secret'
      ? 'Remove or fix the string at the path above: a fake key in a test must be assembled at runtime from parts, never one literal; a real key belongs in an environment variable.'
      : 'Fix what the rule asks for (commit message, file, signature) in the commits it names.',
    ...rewriteSteps(range),
    `Then end with LUNA_DONE ${pkgId}. LunaCore pushes once more; a second rejection stops the package.`,
  ].join('\n');
}

/** One-line summary of scan hits for pkg.detail (no values). */
function hitsSummary(hits) {
  const list = hits.slice(0, 5).map((h) => `${h.label} in ${h.file}:${h.line}`);
  const more = hits.length > 5 ? ` and ${hits.length - 5} more` : '';
  return `${list.join(', ')}${more}`;
}

module.exports = {
  SECRET_RULES,
  COMMIT_MARK,
  MAX_DETAIL_CHARS,
  FAKE_SECRET_RULE,
  redactSecrets,
  scanAddedLines,
  pushRejectionDetail,
  pushBlockKind,
  secretScanText,
  pushBlockText,
  hitsSummary,
};
