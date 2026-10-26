// ============================================================================
// LunaCore - Luna's Work docs at SHIP (docs/LUNAS_WORK_PLAN.md, LW 2.22a)
// ----------------------------------------------------------------------------
// A SHIP verdict is not final yet. The controller (src/lunaswork.js) calls
// begin() instead of finishing, and one last docs iteration is built from a
// card list (docsCards):
//
//   1. README.md        what it is, install, run, test, deploy
//   2. USER_GUIDE.md    docs/USER_GUIDE.md, one section per key screen with
//                       its screenshot from the Playtester's evidence
//                       (lunasworkRun.keyScreens)
//   3. release prep     the version bump and CHANGELOG.md's "## [X.Y.Z]"
//                       section, following the project's own release script
//                       or skill when it has one (releaseProcess) - but no tag,
//                       push or publish: God Mode workers never push
//
// begin() first commits CHANGELOG.md (the Critic's per-iteration entries ride
// in the working tree until here) so the builders see it. The docs build runs
// through the normal stepBuilding; end() takes its result. SHIP is final only
// when the build is green and every docs card landed - otherwise the missing
// cards are built again (retryLater: three failures end the run as STOP).
// Then the cards close, the release is published (createReleaser: tag vX.Y.Z
// on origin's branch head, push the tag, `gh release create` with the
// CHANGELOG section) and the run finishes as SHIP. A release that fails is
// reported (lunasworkReport "waits for you"); it never undoes the SHIP.
//
// Exports
//   docsCards({screens, release}) -> Critic-shape cards (pure)
//   releaseProcess(repoPath) -> {manifest, script, skill}
//   latestVersion(md) / changelogSection(md, version) (pure)
//   createReleaser({execImpl?, env?}) -> {release({repoPath}) -> Promise<{ok, tag?, url?, error?, detail?}>}
//   createShipDocsDeps({env}) -> the controller's deps.shipDocs
//   createShipDocs(ctx) -> {begin(final), isDocsBuild(), end(build)}
// ============================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { MAX_DETAILS_CHARS } = require('./todorows');
const { createCommitter } = require('./lunasworkCommit');
const { keyScreens, emptyCurrent } = require('./lunasworkRun');
const { CHANGELOG_FILE } = require('./lunasworkCriticPack');
const { SKILLS_DIR } = require('./lunasworkSkills');

const EXEC_TIMEOUT_MS = 60 * 1000;
const MAX_ERR_CHARS = 200;
const MAX_NOTES_BYTES = 120 * 1024;
const MAX_CHANGELOG_BYTES = 1024 * 1024;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/;
const VERSION_HEADING_RE = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?)\]?(?:\s|$)/;
const BRANCH_REF_RE = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'setup.cfg', 'pom.xml', 'build.gradle', 'build.gradle.kts'];
const RELEASE_SCRIPTS = ['release', 'release:patch', 'release:minor', 'version'];
const DOCS_NOTE = 'docs iteration at SHIP (LW 2.22a)';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, max = MAX_ERR_CHARS) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));

function readSmall(file, max) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ---- the project's release process -----------------------------------------------------

/**
 * How the project releases: its version manifest, a release script in
 * package.json, a release skill in .claude/skills, or a scripts/release* file.
 * @returns {{manifest:string|null, script:string|null, skill:string|null}}
 */
function releaseProcess(repoPath) {
  const out = { manifest: null, script: null, skill: null };
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return out;
  out.manifest = MANIFESTS.find((m) => fs.existsSync(path.join(repoPath, m))) || null;
  try {
    const pkg = JSON.parse(readSmall(path.join(repoPath, 'package.json'), 512 * 1024) || 'null');
    const scripts = isObj(pkg) && isObj(pkg.scripts) ? pkg.scripts : {};
    const name = RELEASE_SCRIPTS.find((s) => typeof scripts[s] === 'string');
    if (name) out.script = `npm run ${name}`;
  } catch {
    // a broken package.json has no release script
  }
  if (!out.script) {
    try {
      const file = fs.readdirSync(path.join(repoPath, 'scripts')).find((f) => /^release([._-][\w.-]*)?$/i.test(f));
      if (file) out.script = `scripts/${file}`;
    } catch {
      // no scripts/ folder
    }
  }
  try {
    const skillsDir = path.join(repoPath, ...SKILLS_DIR.split('/'));
    const slug = fs.readdirSync(skillsDir).find((d) => /release/i.test(d) && fs.existsSync(path.join(skillsDir, d, 'SKILL.md')));
    if (slug) out.skill = `${SKILLS_DIR}/${slug}/SKILL.md`;
  } catch {
    // no project skills
  }
  return out;
}

// ---- the card list (pure) ---------------------------------------------------------------

const capped = (text) => (text.length > MAX_DETAILS_CHARS ? `${text.slice(0, MAX_DETAILS_CHARS - 20)}\n(list cut)` : text);
const card = (text, details, acceptance, files) => ({
  kind: 'missing', severity: 'high', text, details: capped(details), acceptance, files, updatesCardId: null, splitsCardId: null,
});

/**
 * The docs iteration's cards: README, USER_GUIDE (one section per key screen,
 * its screenshot from the evidence) and the release preparation. Pure.
 * @param {{screens?:{name:string, screenshot:string}[], release?:{manifest:string|null, script:string|null, skill:string|null}}} input
 * @returns {object[]} cards in the Critic's shape (lunasworkCards.fileCards)
 */
function docsCards({ screens = [], release = {} } = {}) {
  const shots = (Array.isArray(screens) ? screens : []).filter((s) => isObj(s) && s.name && s.screenshot);
  const r = isObj(release) ? release : {};
  const readme = card(
    'Docs: README.md - what it is, install, run, test, deploy',
    [
      'Write (or bring up to date) README.md at the repo root for someone who has never seen the project.',
      'Sections, in this order: what it is (one paragraph, from design/BRIEF.md), Install, Run, Test, Deploy.',
      'Every command must be one you ran in this repo and that works; take them from package scripts, the Makefile or the docs that exist. No invented steps, no secrets.',
    ].join('\n'),
    ['README.md has the sections What it is, Install, Run, Test and Deploy', 'every command in README.md runs as written'],
    ['README.md'],
  );
  const screenLines = shots.length
    ? shots.map((s) => `- ${s.name}: ${s.screenshot}`)
    : ['- (no screenshots in the evidence: take one per key screen of the running app)'];
  const guide = card(
    'Docs: docs/USER_GUIDE.md - one section per key screen',
    [
      'Write docs/USER_GUIDE.md: a short intro, then one "## <Screen>" section per key screen - what it is for and how to use it, step by step.',
      "Copy each screen's screenshot below into docs/images/<screen>.png and embed it in its section with a caption.",
      "Key screens and their screenshots from the Playtester's evidence:",
      ...screenLines,
    ].join('\n'),
    [
      `docs/USER_GUIDE.md has one section per key screen${shots.length ? `: ${shots.map((s) => s.name).join(', ')}` : ''}`,
      'every section embeds its screenshot from docs/images/ with a caption',
    ],
    ['docs/USER_GUIDE.md', 'docs/images/'],
  );
  const process = [
    r.script ? `The project releases with ${r.script}: follow it for the version bump and the changelog.` : '',
    r.skill ? `The project has a release skill (${r.skill}): follow it.` : '',
  ].filter(Boolean);
  const prep = card(
    'Release: version bump and the CHANGELOG.md section for vX.Y.Z',
    [
      "Prepare the release; Luna's Work tags it and publishes the GitHub release after this merge.",
      'Pick the next version by semver from CHANGELOG.md "## [Unreleased]": Added or Changed = minor, only Fixed = patch (a 0.x project stays 0.x).',
      `Move the Unreleased entries into a new "## [X.Y.Z] - YYYY-MM-DD" section right under an empty "## [Unreleased]", and set the same version in the project's manifest${r.manifest ? ` (${r.manifest}, and its lock file)` : ''}.`,
      ...process,
      'Do NOT create a git tag, push, publish a package or run `gh release` - skip those steps of any release script; they happen after the merge.',
    ].join('\n'),
    ['CHANGELOG.md has a "## [X.Y.Z] - date" section with this release\'s entries', 'the manifest version equals X.Y.Z'],
    [CHANGELOG_FILE, ...(r.manifest ? [r.manifest] : [])],
  );
  return [readme, guide, prep];
}

// ---- CHANGELOG.md (pure) ------------------------------------------------------------------

/** The newest released version in CHANGELOG.md ("## [X.Y.Z]"), or null. */
function latestVersion(md) {
  for (const line of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(VERSION_HEADING_RE);
    if (m) return m[1];
  }
  return null;
}

/** The body of one version's section (up to the next "## "), or ''. */
function changelogSection(md, version) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => {
    const m = l.match(VERSION_HEADING_RE);
    return !!m && m[1] === version;
  });
  if (start < 0) return '';
  const after = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, after < 0 ? lines.length : after).join('\n').trim();
}

// ---- the release ----------------------------------------------------------------------------

/**
 * @param {{execImpl?:Function, env?:()=>object}} [deps] execImpl: child_process.execFile compatible
 */
function createReleaser(deps = {}) {
  const execImpl = typeof deps.execImpl === 'function' ? deps.execImpl : execFile;
  const envOf = () => (typeof deps.env === 'function' ? deps.env() : process.env);

  function run(cmd, cwd, args) {
    return new Promise((resolve) => {
      try {
        execImpl(cmd, args, { cwd, timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, env: envOf() }, (err, stdout, stderr) => {
          resolve({ ok: !err, missing: !!(err && err.code === 'ENOENT'), out: String(stdout || '').trim(), err: clip(String(stderr || '').trim() || (err && err.message)) });
        });
      } catch (err) {
        resolve({ ok: false, missing: false, out: '', err: clip(errText(err)) });
      }
    });
  }

  /** package.json's version when it differs (the other manifests are the builder's to keep in step), else null. */
  function manifestMismatch(repoPath, version) {
    try {
      const pkg = JSON.parse(readSmall(path.join(repoPath, 'package.json'), 512 * 1024) || 'null');
      return isObj(pkg) && typeof pkg.version === 'string' && pkg.version !== version ? pkg.version : null;
    } catch {
      return null;
    }
  }

  /** origin's head of the checked-out branch: the merged docs iteration. */
  async function releaseCommit(repoPath) {
    const ref = await run('git', repoPath, ['symbolic-ref', '-q', 'HEAD']);
    if (!ref.ok || !BRANCH_REF_RE.test(ref.out) || ref.out.includes('..')) return { error: 'notOnBranch' };
    const fetched = await run('git', repoPath, ['fetch', '-q', 'origin', ref.out]);
    if (!fetched.ok) return { error: 'fetchFailed', detail: fetched.err };
    const sha = await run('git', repoPath, ['rev-parse', 'FETCH_HEAD']);
    return sha.ok && SHA_RE.test(sha.out) ? { sha: sha.out } : { error: 'fetchFailed', detail: sha.err };
  }

  async function ensureTag(repoPath, tag, sha) {
    const exists = await run('git', repoPath, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
    if (!exists.ok) {
      const made = await run('git', repoPath, ['tag', '-a', tag, '-m', `Release ${tag}`, sha]);
      if (!made.ok) return { error: 'tagFailed', detail: made.err };
    }
    const pushed = await run('git', repoPath, ['push', '-q', 'origin', `refs/tags/${tag}`]);
    return pushed.ok ? {} : { error: 'tagNotPushed', detail: pushed.err };
  }

  async function ghRelease(repoPath, tag, notes) {
    const seen = await run('gh', repoPath, ['release', 'view', tag, '--json', 'url', '--jq', '.url']);
    if (seen.missing) return { error: 'noGh' };
    if (seen.ok) return { url: seen.out, existed: true };
    const notesFile = path.join(os.tmpdir(), `lw-release-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.md`);
    try {
      // 'wx': a file (or symlink) already at that name is never written through.
      fs.writeFileSync(notesFile, Buffer.from(notes, 'utf8').subarray(0, MAX_NOTES_BYTES), { flag: 'wx', mode: 0o600 });
      const made = await run('gh', repoPath, ['release', 'create', tag, '--title', tag, '--notes-file', notesFile, '--verify-tag']);
      return made.ok ? { url: made.out.split('\n').pop() } : { error: 'releaseFailed', detail: made.err };
    } finally {
      fs.rmSync(notesFile, { force: true });
    }
  }

  /**
   * Tags CHANGELOG.md's newest version on origin's branch head, pushes the
   * tag and creates the GitHub release with that version's section. Safe to
   * repeat: an existing tag or release is kept.
   * @returns {Promise<{ok:boolean, tag?:string, url?:string, error?:string, detail?:string}>}
   */
  async function release({ repoPath } = {}) {
    try {
      if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return { ok: false, error: 'noRepo' };
      const md = readSmall(path.join(repoPath, CHANGELOG_FILE), MAX_CHANGELOG_BYTES);
      const version = latestVersion(md);
      if (!version || !VERSION_RE.test(version)) return { ok: false, error: 'noVersion' };
      const tag = `v${version}`;
      const other = manifestMismatch(repoPath, version);
      if (other) return { ok: false, tag, error: 'versionMismatch', detail: `package.json is ${clip(other, 40)}` };
      const head = await releaseCommit(repoPath);
      if (head.error) return { ok: false, tag, error: head.error, detail: head.detail };
      const tagged = await ensureTag(repoPath, tag, head.sha);
      if (tagged.error) return { ok: false, tag, error: tagged.error, detail: tagged.detail };
      const published = await ghRelease(repoPath, tag, changelogSection(md, version) || `Release ${tag}`);
      if (published.error) return { ok: false, tag, error: published.error, detail: published.detail };
      return { ok: true, tag, ...(published.url ? { url: clip(published.url, 300) } : {}) };
    } catch (err) {
      return { ok: false, error: 'crashed', detail: clip(errText(err)) };
    }
  }

  return { release };
}

/**
 * The real deps.shipDocs for src/lunasworkWiring.js.
 * @param {{env?:()=>object}} ctx
 */
function createShipDocsDeps(ctx = {}) {
  const committer = createCommitter({ env: ctx.env });
  const releaser = createReleaser({ env: ctx.env });
  return {
    cards: ({ repoPath, laps }) => docsCards({ screens: keyScreens(laps), release: releaseProcess(repoPath) }),
    prepare: ({ repoPath }) => committer.commitPaths({
      repoPath, paths: [CHANGELOG_FILE], message: "docs(changelog): Luna's Work iteration entries before the release",
    }),
    release: ({ repoPath }) => releaser.release({ repoPath }),
  };
}

// ---- the controller side ------------------------------------------------------------------

/**
 * @param {{deps:object, run:()=>object, update:(fields:object)=>void, transition:(phase:string, fields?:object)=>void,
 *   finish:(verdict:string, fields?:object)=>void, retryLater:(why:string)=>void, logEvent:(text:string)=>void,
 *   cardBook:{fileCards:Function, lookup:Function, settle:Function}, withBuilderModel:(card:object)=>object|null,
 *   withBrief?:(card:object)=>object}} ctx
 *   deps.shipDocs = {cards({repoPath, laps}), prepare?({repoPath}), release?({repoPath})}
 */
function createShipDocs(ctx) {
  const { deps, run, update, transition, finish, retryLater, logEvent, cardBook } = ctx;
  const withBrief = typeof ctx.withBrief === 'function' ? ctx.withBrief : (c) => c;
  const sd = () => (isObj(deps.shipDocs) && typeof deps.shipDocs.cards === 'function' ? deps.shipDocs : null);

  async function attempt(label, fn, fallback) {
    try {
      const res = await fn();
      return isObj(res) ? res : fallback;
    } catch (err) {
      logEvent(`${label} failed: ${clip(errText(err))}`);
      return fallback;
    }
  }

  /**
   * At a SHIP verdict: schedule the docs iteration. false = no docs
   * iteration (not configured, already run, or its cards not filed) - the
   * caller finishes as before.
   * @param {{history:object[], lastCritic:object, laps:object[]}} final
   * @returns {Promise<boolean>}
   */
  async function begin(final) {
    const docs = sd();
    const r = run();
    if (!docs || r.shipDocs) return false;
    if (typeof docs.prepare === 'function') {
      const prep = await attempt('CHANGELOG.md commit', () => docs.prepare({ repoPath: r.repoPath }), { ok: false, error: 'failed' });
      if (!prep.ok) logEvent(`CHANGELOG.md not committed before the docs iteration: ${clip(prep.error)}`);
    }
    let cards = [];
    try {
      cards = await docs.cards({ repoPath: r.repoPath, laps: final.laps });
    } catch (err) {
      logEvent(`docs cards not built: ${clip(errText(err))}`);
    }
    const ats = Array.isArray(cards) && cards.length ? cardBook.fileCards(r.projectId, r.id, cards) : [];
    if (!ats.length) {
      logEvent('docs iteration not scheduled: its cards could not be filed - SHIP without it');
      return false;
    }
    const stored = cardBook.lookup(r.projectId, ats).map(withBrief).map(ctx.withBuilderModel).filter(Boolean);
    const n = r.iteration + 1;
    logEvent(`SHIP verdict - docs iteration ${n} first (${stored.length} cards: README, user guide, release)`);
    transition('building', {
      history: final.history,
      lastCritic: final.lastCritic,
      laps: final.laps,
      iteration: n,
      current: { ...emptyCurrent(), cards: stored, notes: DOCS_NOTE },
      shipDocs: { n, cards: ats, landed: [], release: null },
    });
    return true;
  }

  /** The build of this iteration is the docs iteration's. */
  function isDocsBuild() {
    const r = run();
    return isObj(r.shipDocs) && r.shipDocs.n === r.iteration;
  }

  /**
   * After the docs build: green with every card landed = the cards close,
   * the release is published and the run ends as SHIP. Otherwise the
   * missing cards are built again.
   * @param {object} build the build record (lunaswork buildRecord)
   */
  async function end(build) {
    const r = run();
    const state = r.shipDocs;
    const landed = [...new Set([...state.landed, ...(isObj(build) && Array.isArray(build.closed) ? build.closed : [])])]
      .filter((at) => state.cards.includes(at));
    const missing = state.cards.filter((at) => !landed.includes(at));
    const green = isObj(build) && build.selfCheck === 'green';
    if (!green || missing.length) {
      update({
        shipDocs: { ...state, landed },
        current: { ...r.current, cards: r.current.cards.filter((c) => missing.includes(c.at)), planId: null, build: null },
      });
      retryLater(`docs iteration: ${green ? `${missing.length} card(s) did not land` : 'the build is red'}`);
      return;
    }
    cardBook.settle(r.projectId, landed.map((at) => ({ at, outcome: 'done' })));
    const docs = sd();
    const release = docs && typeof docs.release === 'function'
      ? await attempt('release', () => docs.release({ repoPath: r.repoPath }), { ok: false, error: 'failed' })
      : null;
    if (release) logEvent(release.ok ? `release ${release.tag || ''} published` : `release not published: ${clip(release.error)}${release.detail ? ` (${clip(release.detail)})` : ''}`);
    finish('ship', { current: { ...r.current, build }, shipDocs: { ...state, landed, release } });
  }

  return { begin, isDocsBuild, end };
}

module.exports = {
  docsCards,
  releaseProcess,
  latestVersion,
  changelogSection,
  createReleaser,
  createShipDocsDeps,
  createShipDocs,
};
