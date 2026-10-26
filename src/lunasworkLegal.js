// ============================================================================
// LunaCore - Luna's Work GDPR / legal pack for EU web apps (docs/LUNAS_WORK_PLAN.md C6, LW 2.26)
// ----------------------------------------------------------------------------
//   detection  euWebApp({brief, design}) - the pack flag "EU web app: yes/no"
//              in BRIEF.md or DESIGN.md wins; otherwise an EU audience or an
//              EU country named in either file (GDPR / RODO / "EU" / the 27
//              member states)
//   trackers   detectTrackers(repoDir, docs) - non-essential cookies and
//              trackers: known analytics / ad packages in package.json, their
//              snippets in the source, or the docs asking for them. The cookie
//              consent card exists only when this finds something
//   cards      legalCards({cookies}) - privacy policy, cookie consent (only
//              with trackers), data export, account / data deletion. Critic
//              card shape (lunasworkCritic.applyCards), each tagged
//              `legal:<slug>` so the Director creates it once
//   drafts     findDraftFiles(repoDir) - the repo files carrying the DRAFT
//              marker, for the return pack (lunasworkReport)
//
// The Director schedules the cards before SHIP; the journeys they must pass
// go into design/TEST_PLAN.md (lunasworkPack.appendLegalJourneys). Every card
// tells the builder to mark all legal text with LEGAL_DRAFT_MARKER in the
// page source: none of it is legal advice.
//
// Reads only; never throws.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const LEGAL_DRAFT_MARKER = 'DRAFT - check before publishing';
const LEGAL_TAG_PREFIX = 'legal:';
const LEGAL_SLUGS = Object.freeze(['privacy', 'cookies', 'export', 'delete']);

const MAX_WALK_FILES = 3000;
const MAX_WALK_DEPTH = 8;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DRAFTS = 50;
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'venv', '__pycache__', 'design',
]);
const SOURCE_EXT_RE = /\.(html?|[cm]?[jt]sx?|vue|svelte|astro|php|erb|ejs|hbs|liquid|jinja2?|py)$/i;
const DRAFT_EXT_RE = /\.(html?|[cm]?[jt]sx?|vue|svelte|astro|php|erb|ejs|hbs|liquid|jinja2?|py|mdx?|txt|json)$/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const stripComments = (md) => (typeof md === 'string' ? md.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '') : '');

// ---- detection ----------------------------------------------------------------------------

const EU_COUNTRIES = [
  'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Czech Republic', 'Denmark', 'Estonia',
  'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg',
  'Malta', 'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden',
  'Polska', 'Niemcy', 'Deutschland',
];
const EU_WORDS_RE = /\b(GDPR|RODO|DSGVO|European Union|Unia Europejska|European|Europe|EEA)\b/i;
// "EU" only in capitals, as a word: "eu" turns up inside other words and languages.
const EU_ABBR_RE = /(^|[^A-Za-z])EU([^A-Za-z]|$)/m;
const COUNTRY_RE = new RegExp(`\\b(${EU_COUNTRIES.join('|')})\\b`, 'i');
const FLAG_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?EU web app(?:\*\*)?\s*:\s*\**\s*(yes|no|true|false|tak|nie)\b/im;

/**
 * THE DETECTION: is this an EU web app (so the GDPR pack applies)?
 * @param {{brief?:string, design?:string}} docs BRIEF.md / DESIGN.md text
 * @returns {{eu:boolean, source:'flag'|'text'|null, reason:string}}
 */
function euWebApp(docs) {
  const d = isObj(docs) ? docs : {};
  const texts = [stripComments(d.brief), stripComments(d.design)];
  for (const text of texts) {
    const flag = text.match(FLAG_RE);
    if (flag) {
      const answer = flag[1].toLowerCase();
      return { eu: ['yes', 'true', 'tak'].includes(answer), source: 'flag', reason: `"EU web app: ${answer}" in the design pack` };
    }
  }
  const all = texts.join('\n');
  const word = all.match(EU_WORDS_RE);
  if (word) return { eu: true, source: 'text', reason: `the design pack names "${word[1]}"` };
  if (EU_ABBR_RE.test(all)) return { eu: true, source: 'text', reason: 'the design pack names "EU"' };
  const country = all.match(COUNTRY_RE);
  if (country) return { eu: true, source: 'text', reason: `the design pack names "${country[1]}"` };
  return { eu: false, source: null, reason: 'no EU audience or country in BRIEF.md / DESIGN.md' };
}

// Analytics / ad / session-replay packages that set non-essential cookies.
const TRACKER_PACKAGES = [
  'react-ga', 'react-ga4', 'ga-4-react', 'vue-gtag', 'vue-gtm', '@next/third-parties', 'nextjs-google-analytics',
  'react-gtm-module', '@analytics/google-analytics', 'mixpanel', 'mixpanel-browser', '@segment/analytics-next',
  'analytics-node', 'posthog-js', '@hotjar/browser', 'react-hotjar', 'react-facebook-pixel', '@amplitude/analytics-browser',
  'amplitude-js', '@fullstory/browser', 'logrocket', '@microsoft/clarity', 'heap-api', '@intercom/messenger-js-sdk',
  'react-use-intercom', 'hubspot-tracking-code',
];
// Snippets in the source of the same kind of tools.
const TRACKER_SNIPPETS = [
  ['googletagmanager.com', /googletagmanager\.com/i],
  ['google-analytics.com', /google-analytics\.com/i],
  ['gtag()', /\bgtag\s*\(/],
  ['Facebook pixel', /\bfbq\s*\(|connect\.facebook\.net/],
  ['Hotjar', /hotjar\.com/i],
  ['Microsoft Clarity', /clarity\.ms/i],
  ['Segment', /cdn\.segment\.com/i],
  ['Mixpanel', /cdn\.mxpnl\.com|mixpanel\.init/i],
  ['PostHog', /posthog\.init/i],
  ['HubSpot', /js\.hs-scripts\.com/i],
  ['DoubleClick', /doubleclick\.net/i],
];
const DOC_TRACKER_RE = /\b(Google Analytics|GA4|Google Tag Manager|Facebook Pixel|Meta Pixel|Hotjar|Mixpanel|Segment|PostHog|Amplitude|FullStory|LogRocket|Microsoft Clarity|tracking pixels?|ad tracking|retargeting|third-party cookies|marketing cookies|analytics cookies)\b/i;

/** Every file under the repo matching `extRe`, bounded; no links, no dot, build or vendor dirs. */
function walkRepo(root, extRe) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_WALK_FILES) return;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_WALK_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
      } else if (e.isFile() && extRe.test(e.name)) out.push(full);
    }
  };
  walk(root, 1);
  return out;
}

const repoRoot = (repoDir) => (typeof repoDir === 'string' && path.isAbsolute(repoDir) ? path.resolve(repoDir) : null);

function readSmall(file) {
  try {
    return fs.statSync(file).size <= MAX_FILE_BYTES ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

function packageTrackers(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = { ...(isObj(pkg.dependencies) ? pkg.dependencies : {}), ...(isObj(pkg.devDependencies) ? pkg.devDependencies : {}) };
    return TRACKER_PACKAGES.filter((name) => Object.prototype.hasOwnProperty.call(deps, name)).map((name) => `package ${name}`);
  } catch {
    return [];
  }
}

/**
 * Non-essential cookies / trackers: in package.json, in the source, or asked
 * for by BRIEF.md / DESIGN.md (a tracker the design wants will be built).
 * @param {string} repoDir absolute
 * @param {{brief?:string, design?:string}} [docs]
 * @returns {{found:boolean, hits:string[]}}
 */
function detectTrackers(repoDir, docs = {}) {
  const root = repoRoot(repoDir);
  const hits = new Set(root ? packageTrackers(root) : []);
  for (const file of root ? walkRepo(root, SOURCE_EXT_RE) : []) {
    const text = readSmall(file);
    for (const [name, re] of TRACKER_SNIPPETS) if (re.test(text)) hits.add(name);
  }
  const d = isObj(docs) ? docs : {};
  const asked = `${stripComments(d.brief)}\n${stripComments(d.design)}`.match(DOC_TRACKER_RE);
  if (asked) hits.add(`design pack: ${asked[1]}`);
  return { found: hits.size > 0, hits: [...hits].slice(0, 20) };
}

// ---- cards --------------------------------------------------------------------------------

const legalTag = (slug) => `${LEGAL_TAG_PREFIX}${slug}`;

const DRAFT_RULE = `Mark ALL legal text "${LEGAL_DRAFT_MARKER}": a comment with exactly that phrase next to the text in the page source, and the same words visibly at the top of the page. It is a draft for Mati's lawyer, not legal advice. Leave the company name, address and contact as clearly marked placeholders unless DESIGN.md gives them.`;
const DRAFT_ACCEPTANCE = `The legal text is marked "${LEGAL_DRAFT_MARKER}" in the page source and on the page`;

const LEGAL_CARD_SPECS = {
  privacy: {
    text: 'Legal: privacy policy page (GDPR)',
    details: [
      'Add a privacy policy page for this EU web app, linked from the footer of every page.',
      "Cover: who the controller is, what personal data the app collects and why, the legal basis for each purpose, how long it is kept, who it is shared with (hosting, email, analytics), the user's rights (access, rectification, erasure, portability, objection, complaint to the supervisory authority) and how to contact the controller.",
      'Base it on what the app really does (read the code), not on a generic template.',
      'Add a test that the page renders and that the footer link reaches it.',
    ],
    acceptance: ['The privacy policy page is reachable from the footer of every page'],
  },
  cookies: {
    text: 'Legal: cookie consent before any tracker loads (GDPR / ePrivacy)',
    details: [
      'The app uses non-essential cookies or trackers. Add a cookie consent banner on first visit.',
      '- No non-essential cookie is set and no tracker script loads before the user opts in.',
      '- "Accept" and "Reject" are equally easy (same level, same prominence); rejecting keeps the app fully usable.',
      '- The choice is remembered; a footer link reopens the settings so consent can be withdrawn.',
      '- Essential cookies (session, CSRF, the consent choice itself) need no consent - list them in the privacy policy.',
      'Add a test that no tracker request is made before opt-in, and that it is made after "Accept".',
    ],
    acceptance: [
      'No tracker request or non-essential cookie before opt-in; after "Accept" the tracker loads',
      'Rejecting is as easy as accepting and the choice can be changed later',
    ],
  },
  export: {
    text: 'Legal: data export for a signed-in user (GDPR art. 15 / 20)',
    details: [
      'A signed-in user can download all personal data the app holds about them, in a machine-readable file (JSON), from their account settings.',
      'Include everything stored for that user (profile, records they created, consents) and nothing about anyone else.',
      "Add a test that the export contains the user's data and no other user's data.",
      'If the app has no user accounts, add a contact route for data requests to the privacy policy instead, and say so in design/DECISIONS.md.',
    ],
    acceptance: ["A signed-in user downloads a JSON file with all their data and none of anyone else's"],
  },
  delete: {
    text: 'Legal: account and data deletion (GDPR art. 17)',
    details: [
      'A signed-in user can delete their account and personal data from their account settings, after a clear confirmation step.',
      'Delete (or anonymise, where another law requires keeping a record such as an invoice) every personal record of that user, end their session, and show what happened.',
      'Add a test that after deletion the user cannot sign in and their personal data is gone.',
      'If the app has no user accounts, add a contact route for erasure requests to the privacy policy instead, and say so in design/DECISIONS.md.',
    ],
    acceptance: ['After confirming, the account and its personal data are gone and the user cannot sign in'],
  },
};

/**
 * The legal card list (lunasworkCritic.applyCards shape, tag in extraTags).
 * @param {{cookies?:boolean}} [opts] cookies = trackers were detected
 * @returns {object[]} in LEGAL_SLUGS order; the cookie card only with trackers
 */
function legalCards({ cookies } = {}) {
  return LEGAL_SLUGS.filter((slug) => slug !== 'cookies' || cookies === true).map((slug) => {
    const spec = LEGAL_CARD_SPECS[slug];
    return {
      kind: 'missing',
      severity: 'high',
      text: spec.text,
      details: [...spec.details, '', DRAFT_RULE].join('\n'),
      acceptance: [...spec.acceptance, DRAFT_ACCEPTANCE],
      files: [],
      updatesCardId: null,
      extraTags: [legalTag(slug)],
    };
  });
}

// ---- drafts -------------------------------------------------------------------------------

/**
 * Repo files that carry the DRAFT marker (legal text still to be checked).
 * @param {string} repoDir absolute
 * @returns {string[]} repo-relative posix paths, sorted, at most MAX_DRAFTS
 */
function findDraftFiles(repoDir) {
  const root = repoRoot(repoDir);
  if (!root) return [];
  return walkRepo(root, DRAFT_EXT_RE)
    .filter((file) => readSmall(file).includes(LEGAL_DRAFT_MARKER))
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .sort()
    .slice(0, MAX_DRAFTS);
}

/** LW 2.26: the GDPR journeys lunasworkPack.appendLegalJourneys adds to TEST_PLAN.md. */
const LEGAL_JOURNEYS = Object.freeze([
  {
    name: 'Legal: privacy policy is reachable',
    body: `1. Open the start page.
2. Click the privacy policy link in the footer.
3. Do the same from two other main pages.

Expected: the privacy policy page opens from every page, and it shows the note "${LEGAL_DRAFT_MARKER}".`,
  },
  {
    name: 'Legal: cookie consent blocks trackers before opt-in',
    cookies: true,
    body: `1. Open the app in a fresh session (no cookies stored).
2. Before clicking anything, list the network requests (browser_network_requests).
3. Click "Reject" and use the app for a moment; list the network requests again.
4. Reopen the cookie settings from the footer, click "Accept" and reload.

Expected: no request to an analytics, ad or tracking domain before "Accept" (also not after "Reject", and the app keeps working); tracker requests appear only after "Accept". "Reject" is as easy to find as "Accept".`,
  },
  {
    name: 'Legal: data export works',
    body: `1. Sign in as a test user (a fixture user when the seed data has one).
2. Open the account settings and request the data export.

Expected: the export completes and holds this user's data - and no other user's data.`,
  },
  {
    name: 'Legal: account deletion works',
    body: `1. Sign up a new throwaway user and sign in.
2. Open the account settings, delete the account and confirm.
3. Try to sign in again with the same email and password.

Expected: deletion asks for confirmation first, then signs the user out; signing in again fails because the account is gone.`,
  },
]);

module.exports = {
  LEGAL_DRAFT_MARKER,
  LEGAL_TAG_PREFIX,
  LEGAL_SLUGS,
  LEGAL_JOURNEYS,
  euWebApp,
  detectTrackers,
  legalTag,
  legalCards,
  findDraftFiles,
};
