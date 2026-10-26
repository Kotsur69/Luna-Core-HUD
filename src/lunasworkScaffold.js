// ============================================================================
// LunaCore - Luna's Work iteration 0: scaffold a new project (LUNAS_WORK_PLAN B2)
// ----------------------------------------------------------------------------
// A run on an empty repo (no package manifest, no source folder besides the
// design pack in design/) first builds the project's skeleton from a stack
// template, before the Director schedules any feature card:
//
//   nextjs   Next.js + TypeScript (the default frontend), via create-next-app
//   python   Python with uv + pytest, via uv init
//
// Every template has the same five steps, one God Mode card each, chained
// with dependsOn so they land in order: generate the app with the official
// generator, tests (one passing example), lint config, a CI workflow
// (.github/workflows) and `.env.example` (never a real .env). The cards go
// through the normal God Mode build + self-check gate like any other card;
// the builder runs the generators, nothing here writes project files.
//
// The stack is chosen by an explicit `Stack:` line in design/BRIEF.md, then
// design/DESIGN.md, then the project profile's `stack`, else nextjs. The pack
// can only pick one of the fixed templates below - no text from it reaches a
// card or a command.
//
// Each template also brings profile defaults (startCommand, url,
// checkCommand). They are only a suggestion for a project with no profile
// yet: Mati sees them in the start confirmation, and the profile stays in
// LunaCore's local settings (src/lunasworkSettings.js), never in the repo.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const pack = require('./lunasworkPack');
const { applyAdd } = require('./intake');
const { normalizeTodos, runTag } = require('./todorows');

const SCAFFOLD_TAG = 'scaffold';
const DEFAULT_STACK = 'nextjs';
// The design pack's folder: the one source folder an empty repo may have.
const PACK_DIR = 'design';

// A file any of these names at the top level means the project exists.
const MANIFESTS = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'pipfile',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'gemfile',
  'deno.json',
  'pubspec.yaml',
  'mix.exs',
]);
const MANIFEST_EXT_RE = /\.(csproj|fsproj|sln)$/i;
// Top-level source files count as a project too, never scaffolded over.
const SOURCE_EXT_RE = /\.(js|jsx|mjs|cjs|ts|tsx|py|html|css|cs|go|rs|java|kt|php|rb|swift|dart|c|cpp|h|vue|svelte)$/i;
// `Stack: python` / `**Stack:** Next.js` / `- Stack: uv` on its own line.
const STACK_LINE_RE = /^[ \t]*[-*]?[ \t]*\**[ \t]*stack[ \t]*\**[ \t]*:[ \t]*\**[ \t]*([^\r\n*]+?)[ \t]*\**[ \t]*$/im;

const STACK_ALIASES = {
  nextjs: 'nextjs',
  next: 'nextjs',
  'next.js': 'nextjs',
  'next.js + typescript': 'nextjs',
  'nextjs + typescript': 'nextjs',
  python: 'python',
  'python + uv': 'python',
  uv: 'python',
};

const CI_NOTE = 'The workflow must run on push and pull_request and stay green on a fresh clone.';
const ENV_NOTE =
  'Create `.env.example` with every variable the app reads (placeholder values only, a comment per variable). '
  + 'Never create or commit a real `.env`; make sure `.gitignore` ignores `.env` and `.env.*` but not `.env.example`.';
const KEEP_PACK = 'Keep design/ exactly as it is.';

/** The fixed templates. Card text and details are constants, never model output. */
const TEMPLATES = Object.freeze({
  nextjs: Object.freeze({
    stack: 'nextjs',
    label: 'Next.js + TypeScript',
    profile: Object.freeze({ adapter: 'web', startCommand: 'npm run dev', url: 'http://localhost:3000', readyTimeoutSec: 120, checkCommand: 'npm test' }),
    steps: Object.freeze([
      {
        key: 'generate',
        text: 'Scaffold: generate the Next.js + TypeScript app with create-next-app',
        details:
          'Run the official generator: `npx create-next-app@latest <tmp> --ts --eslint --app --src-dir --use-npm --import-alias "@/*" --yes` '
          + 'in a temporary folder (create-next-app refuses a folder that already has design/), then move its files to the repo root. '
          + `${KEEP_PACK} Commit package-lock.json. \`npm run build\` must pass.`,
        files: ['package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'src/app/'],
        acceptance: ['npm run build passes', 'npm run dev serves the start page on http://localhost:3000'],
        size: 'M',
      },
      {
        key: 'tests',
        text: 'Scaffold: test setup with one passing example test',
        details:
          'Add Vitest with @testing-library/react and jsdom (npm install -D), a vitest config, an `npm test` script that runs once '
          + '(`vitest run`), and one passing example test that renders the start page.',
        files: ['vitest.config.ts', 'src/app/page.test.tsx', 'package.json'],
        acceptance: ['npm test passes with one example test'],
        size: 'S',
      },
      {
        key: 'lint',
        text: 'Scaffold: lint config and a clean `npm run lint`',
        details:
          'Keep the ESLint config create-next-app made (eslint.config.mjs, next/core-web-vitals + next/typescript), add a '
          + '`typecheck` script (`tsc --noEmit`), and make `npm run lint` and `npm run typecheck` pass.',
        files: ['eslint.config.mjs', 'package.json'],
        acceptance: ['npm run lint passes', 'npm run typecheck passes'],
        size: 'S',
      },
      {
        key: 'ci',
        text: 'Scaffold: CI workflow (lint, typecheck, test, build)',
        details:
          'Add `.github/workflows/ci.yml`: actions/checkout, actions/setup-node with the LTS version and npm cache, `npm ci`, '
          + `then lint, typecheck, test and build. ${CI_NOTE}`,
        files: ['.github/workflows/ci.yml'],
        acceptance: ['.github/workflows/ci.yml runs lint, typecheck, test and build'],
        size: 'S',
      },
      {
        key: 'env',
        text: 'Scaffold: .env.example and env hygiene',
        details: ENV_NOTE,
        files: ['.env.example', '.gitignore'],
        acceptance: ['.env.example exists', 'no .env file is committed', '.gitignore ignores .env'],
        size: 'S',
      },
    ]),
  }),
  python: Object.freeze({
    stack: 'python',
    label: 'Python (uv + pytest)',
    profile: Object.freeze({
      adapter: 'web',
      startCommand: 'uv run uvicorn app.main:app --port 8000',
      url: 'http://localhost:8000',
      readyTimeoutSec: 120,
      checkCommand: 'uv run pytest',
    }),
    steps: Object.freeze([
      {
        key: 'generate',
        text: 'Scaffold: generate the Python project with uv init',
        details:
          'Run the official generator: `uv init --app --vcs none` in the repo root, then `uv add fastapi uvicorn` and a minimal '
          + `app package (app/__init__.py, app/main.py with a FastAPI \`app\` and a GET / route). ${KEEP_PACK} Commit uv.lock.`,
        files: ['pyproject.toml', 'uv.lock', '.python-version', 'app/main.py'],
        acceptance: ['uv run uvicorn app.main:app --port 8000 serves GET / on http://localhost:8000'],
        size: 'M',
      },
      {
        key: 'tests',
        text: 'Scaffold: pytest setup with one passing example test',
        details:
          'Add pytest and httpx as dev dependencies (`uv add --dev pytest httpx`), `[tool.pytest.ini_options]` in pyproject.toml, '
          + "and one passing example test in tests/ that calls GET / through FastAPI's TestClient.",
        files: ['tests/test_app.py', 'pyproject.toml'],
        acceptance: ['uv run pytest passes with one example test'],
        size: 'S',
      },
      {
        key: 'lint',
        text: 'Scaffold: ruff lint config and a clean lint',
        details:
          'Add ruff as a dev dependency (`uv add --dev ruff`) and a `[tool.ruff]` section in pyproject.toml (line length, '
          + 'select E, F, I, UP, B). Make `uv run ruff check .` and `uv run ruff format --check .` pass.',
        files: ['pyproject.toml'],
        acceptance: ['uv run ruff check . passes', 'uv run ruff format --check . passes'],
        size: 'S',
      },
      {
        key: 'ci',
        text: 'Scaffold: CI workflow (ruff, pytest)',
        details:
          'Add `.github/workflows/ci.yml`: actions/checkout, astral-sh/setup-uv, `uv sync --locked`, then ruff check, '
          + `ruff format --check and pytest. ${CI_NOTE}`,
        files: ['.github/workflows/ci.yml'],
        acceptance: ['.github/workflows/ci.yml runs ruff and pytest'],
        size: 'S',
      },
      {
        key: 'env',
        text: 'Scaffold: .env.example and env hygiene',
        details: ENV_NOTE,
        files: ['.env.example', '.gitignore'],
        acceptance: ['.env.example exists', 'no .env file is committed', '.gitignore ignores .env'],
        size: 'S',
      },
    ]),
  }),
});

const STACKS = Object.keys(TEMPLATES);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

// ---- detection ------------------------------------------------------------------------

/**
 * Pure: whether a repo's top-level entries describe an empty / new project.
 * Dot entries (.git, .gitignore, .github, .vscode) and plain files like
 * README.md or LICENSE do not count; a manifest, a source file, or any folder
 * other than design/ does.
 * @param {Array<{name:string, dir:boolean}>} entries
 * @returns {boolean}
 */
function isEmptyProject(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.every((e) => {
    if (!isObj(e) || typeof e.name !== 'string') return true;
    const name = e.name;
    if (name.startsWith('.')) return true;
    if (e.dir) return name === PACK_DIR;
    return !MANIFESTS.has(name.toLowerCase()) && !MANIFEST_EXT_RE.test(name) && !SOURCE_EXT_RE.test(name);
  });
}

/**
 * Reads the repo's top level. A folder that cannot be read is NOT empty:
 * iteration 0 never runs on a guess.
 * @param {string} repoDir
 * @param {{readdirSync:Function}} [fsImpl]
 * @returns {boolean}
 */
function detectEmptyRepo(repoDir, fsImpl = fs) {
  if (typeof repoDir !== 'string' || !path.isAbsolute(repoDir)) return false;
  try {
    const entries = fsImpl.readdirSync(repoDir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
    return isEmptyProject(entries);
  } catch {
    return false;
  }
}

// ---- stack choice ---------------------------------------------------------------------

/** A known stack id for free text ('Next.js', 'python'), or null. */
function normalizeStack(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
  return STACK_ALIASES[key] || null;
}

/** The explicit `Stack:` line of one pack file, or null. */
function stackFromText(md) {
  if (typeof md !== 'string' || !md) return null;
  const m = md.match(STACK_LINE_RE);
  return m ? normalizeStack(m[1]) : null;
}

/**
 * Pure: BRIEF.md, then DESIGN.md, then the profile, else the default.
 * @param {{brief?:string|null, design?:string|null, profile?:object|null}} input
 * @returns {{stack:string, source:'brief'|'design'|'profile'|'default'}}
 */
function chooseStack({ brief, design, profile } = {}) {
  const fromBrief = stackFromText(brief);
  if (fromBrief) return { stack: fromBrief, source: 'brief' };
  const fromDesign = stackFromText(design);
  if (fromDesign) return { stack: fromDesign, source: 'design' };
  const fromProfile = isObj(profile) ? normalizeStack(profile.stack) : null;
  if (fromProfile) return { stack: fromProfile, source: 'profile' };
  return { stack: DEFAULT_STACK, source: 'default' };
}

// ---- cards ----------------------------------------------------------------------------

/**
 * Pure: the to-do tasks of one template, in order. dependsOn holds batch
 * indexes (src/intake.js applyAdd resolves them to the new cards' ats).
 * @param {string} stack
 * @param {string} runId
 * @returns {object[]}
 */
function templateCards(stack, runId) {
  const template = TEMPLATES[stack];
  if (!template) return [];
  const tags = [SCAFFOLD_TAG, runTag(runId)].filter(Boolean);
  return template.steps.map((step, i) => ({
    text: step.text,
    details: step.details,
    files: [...step.files],
    acceptance: [...step.acceptance],
    size: step.size,
    tags,
    ...(i > 0 ? { dependsOn: [i - 1] } : {}),
  }));
}

/** A copy of the template's profile defaults (for a project with no profile yet). */
function profileDefaults(stack) {
  const template = TEMPLATES[stack];
  return template ? { ...template.profile, stack: template.stack } : null;
}

/**
 * Plans iteration 0 for a repo, or null when the repo is not empty.
 * @param {string} repoDir
 * @param {{profile?:object|null, fsImpl?:object, readFile?:(repoDir:string, name:string)=>string|null}} [opts]
 * @returns {{stack:string, source:string, label:string, profile:object}|null}
 */
function planScaffold(repoDir, opts = {}) {
  if (!detectEmptyRepo(repoDir, opts.fsImpl)) return null;
  const readFile = opts.readFile || pack.readPackFile;
  const choice = chooseStack({ brief: readFile(repoDir, 'BRIEF.md'), design: readFile(repoDir, 'DESIGN.md'), profile: opts.profile });
  return { stack: choice.stack, source: choice.source, label: TEMPLATES[choice.stack].label, profile: profileDefaults(choice.stack) };
}

/**
 * Puts the template's cards into the project's to-do store and returns them.
 * Open scaffold cards of the same run already there (a restart between this
 * write and the next phase) are reused, never added twice.
 * @param {{read:()=>unknown, write:(list:object[])=>boolean}} store
 * @param {{stack:string, runId:string, now:number}} ctx
 * @returns {{ok:true, cards:object[], reused:boolean}|{ok:false, error:string}}
 */
function seedScaffoldCards(store, { stack, runId, now }) {
  const tasks = templateCards(stack, runId);
  if (!tasks.length) return { ok: false, error: 'unknownStack' };
  try {
    const list = normalizeTodos(store.read());
    const tag = runTag(runId);
    const mine = list.filter((t) => !t.done && Array.isArray(t.tags) && t.tags.includes(SCAFFOLD_TAG) && t.tags.includes(tag));
    if (mine.length) return { ok: true, cards: mine, reused: true };
    const outcome = applyAdd(list, tasks, now);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    if (!store.write(outcome.list)) return { ok: false, error: 'could not save the to-do list' };
    return { ok: true, cards: outcome.added, reused: false };
  } catch (err) {
    return { ok: false, error: errText(err).slice(0, 200) };
  }
}

/**
 * The controller's deps.scaffold (src/lunaswork.js).
 * @param {{fsImpl?:object, readFile?:Function}} [deps]
 */
function createScaffolder(deps = {}) {
  return {
    plan: (repoDir, profile) => planScaffold(repoDir, { profile, fsImpl: deps.fsImpl, readFile: deps.readFile }),
    seed: (store, ctx) => seedScaffoldCards(store, ctx),
  };
}

module.exports = {
  SCAFFOLD_TAG,
  DEFAULT_STACK,
  STACKS,
  TEMPLATES,
  isEmptyProject,
  detectEmptyRepo,
  normalizeStack,
  stackFromText,
  chooseStack,
  templateCards,
  profileDefaults,
  planScaffold,
  seedScaffoldCards,
  createScaffolder,
};
