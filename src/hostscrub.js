// ============================================================================
// LunaCore - secret scrubber for what a host writes to the cloud (main + phone)
// ----------------------------------------------------------------------------
// docs/done_docs/DONE_REMOTE_HOST_PLAN.md "Security review" M1. Tool results, approval
// previews and prompts sit in `host_events` / `host_commands` for 14 days,
// readable by anyone holding the cloud session: a session that reads `.env`
// would put its keys there. Every string the host inserts goes through
// scrub() first. Masked:
//
//   sk-...                       OpenAI / Anthropic style API keys
//   ghp_ / gho_ / ghu_ / ghs_ / ghr_ ..., github_pat_...   GitHub tokens
//   AKIA... / ASIA...            AWS access key ids
//   sk_live_ / sk_test_ / rk_live_ / rk_test_ / pk_live_ ...   Stripe keys
//   eyJ... . ... . ...           JWTs (Supabase anon / service keys)
//   Bearer <token>               the token only; the word Bearer stays
//   xoxb- / xoxp- / xoxa- / xoxr- / xoxs- ...   Slack tokens
//   AIza...                      Google API keys
//   npm_...                      npm tokens
//   scheme://user:PASSWORD@host  the password only; scheme, user, host stay
//   -----BEGIN ... KEY----- ... -----END ... KEY-----      PEM key blocks
//                                (a block cut off before its END line too)
//   NAME=value                   NAME with a KEY / TOKEN / SECRET / PASSWORD
//                                segment, any case (API_KEY=, db_password=)
//
// Pure and idempotent: scrub(scrub(x)) === scrub(x), so the host's copy of an
// approval card and the row the phone reads back stay equal. Shared with the
// phone build (mobile/vite.config.js SHARED) through src/hostevents.js.
// ============================================================================

'use strict';

const MASK = '[redacted]';
const MAX_DEPTH = 8;
const SECRET_NAME = '(?:[A-Za-z0-9]+_)*(?:KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)(?:_[A-Za-z0-9]+)*';
const SECRET_VALUE = `(?!\\[)("[^"\\n]*"|'[^'\\n]*'|[^\\s"']+)`;

const RULES = [
  // A PEM block first: its base64 body would otherwise be left half-masked.
  [/-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, `sk-${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, `github_pat_${MASK}`],
  [/\b(gh[pousr])_[A-Za-z0-9]{20,}/g, `$1_${MASK}`],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, `$1${MASK}`],
  [/\b((?:sk|rk)_(?:live|test)|pk_live)_[A-Za-z0-9]{16,}/g, `$1_${MASK}`],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, `eyJ${MASK}`],
  [/\b(xox[bpars])-[A-Za-z0-9-]{10,}/g, `$1-${MASK}`],
  [/\bAIza[\w-]{35,}/g, `AIza${MASK}`],
  [/\bnpm_[A-Za-z0-9]{30,}/g, `npm_${MASK}`],
  // After the shapes above, so a JWT or key behind Bearer is already masked
  // and its leftover is too short to match again. Token characters per
  // RFC 6750; one starting with '/' or '.' is a path, not a token.
  [/\b([Bb]earer[ \t]+)(?![./])[A-Za-z0-9._~+/=-]{16,}/g, `$1${MASK}`],
  // scheme://user:PASSWORD@host (the user may be empty: redis://:pw@host).
  // Re-masking '[redacted]' yields '[redacted]', so this stays idempotent.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)[^\s@/]+@/gi, `$1${MASK}@`],
  // NAME=value: the name must hold a secret-ish word as one of its _-segments.
  // Spaces around '=' only count at a line start (an .env line), so source code
  // like `const key = map.get(id)` stays readable. A value starting with '[' is
  // an earlier mask (maybe clipped): left as is.
  [new RegExp(`^((?:export\\s+)?${SECRET_NAME})(\\s*=\\s*)${SECRET_VALUE}`, 'gim'), `$1$2${MASK}`],
  [new RegExp(`\\b(${SECRET_NAME})(=)${SECRET_VALUE}`, 'gi'), `$1$2${MASK}`],
];

/** One string with every known secret shape masked; non-strings pass through. */
function scrub(text) {
  if (typeof text !== 'string' || !text) return text;
  return RULES.reduce((s, [re, to]) => s.replace(re, to), text);
}

/** A copy of a JSON-ish value with every string in it scrubbed. */
function scrubDeep(value, depth = 0) {
  if (typeof value === 'string') return scrub(value);
  if (!value || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, depth + 1)]));
}

module.exports = { scrub, scrubDeep, MASK };
