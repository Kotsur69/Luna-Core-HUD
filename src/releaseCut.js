// ============================================================================
// LunaCore - cut a release (main process)
// ----------------------------------------------------------------------------
// Exactly the manual release steps, in order, on the repo's main checkout:
//
//   0. refuse (nothing changed yet) on: no `dist` script in package.json, or
//      one the step-5 output override cannot reach (distScriptProblem), a
//      dirty tree, another branch checked out, the run's merge not in HEAD
//      ("run not landed on base"), a base behind origin (fetched first), no
//      `gh auth`, no previous v* tag, nothing new since it, red `npm test`
//   1. `npm version <x> --no-git-tag-version` - minor when any feat: commit
//      came since the last v* tag, else patch
//   2. README.md: a '> **Current release: vX - <title>.**' block on top, built
//      from the feat/fix subjects since that tag ('chore: luna wip' and
//      merges left out); the previous block is demoted to '> **vPrev - ...**'
//   3. commit `chore(release): vX - <title>` (+ Co-Authored-By), tag vX on
//      that commit
//   4. push that commit to the base branch, then the tag - never --force
//   5. `npm run dist` into a fresh dist/release-vX/ (a running LunaCore can
//      hold dist/win-unpacked/resources/app.asar open, so an old output
//      folder is never reused); 'LunaCore Setup X.exe' (+ .blockmap) copied
//      to the dashed names latest.yml points to. A dist failure says the tag
//      is already pushed; an EBUSY one also names the holding process
//   6. `gh release create vX --latest` with latest.yml, the portable exe, the
//      setup exe and its blockmap, all from dist/release-vX/; the notes file
//      sits there too (dist/ is gitignored)
//
// `npm test` takes minutes: right before step 1 the branch, the clean tree
// and HEAD are checked again, and the tag and the push name the release
// commit by sha - a checkout switched meanwhile never gets the release.
//
// git and gh run without a shell (argv only); npm runs FIXED command strings
// through the shell (npm is a .cmd on Windows) - the only value in them is
// the version this module computed and checked against SEMVER_RE. Tool
// output that reaches the board / report / email is redacted. Every side
// effect comes in through deps, so tests use fakes.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');
const { findLockHolders, describeHolders, lockedPathOf } = require('./fileLockHolder');

const SEMVER_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const TAG_RE = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const FULL_SHA_RE = /^[0-9a-f]{40,64}$/;
const BASE_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const FEAT_RE = /^feat(\([^)]*\))?!?:\s*/i;
const FIX_RE = /^fix(\([^)]*\))?!?:\s*/i;
const RELEASE_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/releases\/tag\/v\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const CURRENT_RE = /^> \*\*Current release: (v\d+\.\d+\.\d+)(\s+(?:-|—)\s+)(.*)\*\*\s*$/m;
const CO_AUTHOR = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const PRODUCT = 'LunaCore';

const GIT_TIMEOUT_MS = 60 * 1000;
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const TEST_TIMEOUT_MS = 20 * 60 * 1000;
const DIST_TIMEOUT_MS = 40 * 60 * 1000;
const GH_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SUBJECTS = 200;
const MAX_TITLE = 60;
const MAX_SUBJECT = 160;
const WRAP_AT = 76;

// Control characters plus Unicode format characters (zero-width, bidi
// overrides): commit subjects reach the README, the commit and the notes.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS_RE = /[\x00-\x1f\x7f​-‏‪-‮⁠-⁩﻿]+/g;
const oneLine = (v, max = MAX_SUBJECT) => String(v == null ? '' : v).replace(UNSAFE_CHARS_RE, ' ').trim().slice(0, max);
const lines = (text) =>
  String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
const lastLine = (text) => oneLine(lines(text).slice(-1)[0] || '', 300);

// Tool output shown on the board, in the report and the run email: no
// credentials from a remote URL, no token-shaped strings.
const URL_CREDENTIALS_RE = /(https?:\/\/)[^/\s@]+@/gi;
const TOKEN_RE = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/g;
const redact = (text) => String(text == null ? '' : text).replace(URL_CREDENTIALS_RE, '$1***@').replace(TOKEN_RE, '***');

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/** Commit subjects that never make the notes: Luna's WIP commits and merges. */
const isSkippedSubject = (s) => /^chore: luna wip\b/i.test(s) || /^Merge\b/.test(s);

/** The subject without its `feat(scope): ` / `fix: ` prefix. */
const stripType = (s) => oneLine(s.replace(FEAT_RE, '').replace(FIX_RE, ''));

/**
 * The feat / fix subjects since the last tag, newest first, the rest left out.
 * @param {string[]} subjects `git log --format=%s` output lines
 * @returns {{features:string[], fixes:string[]}}
 */
function buildNotes(subjects) {
  const kept = (Array.isArray(subjects) ? subjects : []).map((s) => oneLine(s, 300)).filter((s) => s && !isSkippedSubject(s));
  return {
    features: kept.filter((s) => FEAT_RE.test(s)).map(stripType).filter(Boolean),
    fixes: kept.filter((s) => FIX_RE.test(s)).map(stripType).filter(Boolean),
  };
}

/**
 * The next version: minor when any feat: commit came since the last tag,
 * else patch.
 * @param {string} version current x.y.z (package.json)
 * @param {string[]} subjects
 * @returns {string|null} null when `version` is not x.y.z
 */
function nextVersion(version, subjects) {
  const m = SEMVER_RE.exec(String(version || ''));
  if (!m) return null;
  const [major, minor, patch] = m.slice(1).map(Number);
  const feat = (subjects || []).some((s) => !isSkippedSubject(s) && FEAT_RE.test(String(s)));
  return feat ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/**
 * `text` cut to at most `max` characters on a word boundary: whole words
 * only, no ellipsis (the README line adds its own end dot), trailing
 * punctuation dropped. A first word longer than the limit is the one case
 * cut mid-word.
 */
function truncateWords(text, max) {
  const src = String(text || '').trim();
  if (src.length <= max) return src;
  const cut = src.slice(0, max + 1).lastIndexOf(' ');
  return (cut > 0 ? src.slice(0, cut) : src.slice(0, max)).replace(/[\s.,;:!?-]+$/, '');
}

/**
 * The release title: the newest feature, else the newest fix, cut on a word
 * boundary, no end dot. The subject keeps its own casing; only its first
 * letter is made upper case.
 */
function releaseTitle(notes) {
  const raw = notes.features[0] || notes.fixes[0] || 'maintenance release';
  const short = truncateWords(raw.replace(/[.\s]+$/, ''), MAX_TITLE);
  return short.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/** One bullet, wrapped like the README's hand-written ones. */
function bullet(text, prefix) {
  const out = [];
  const indent = prefix.replace(/- $/, '  ');
  let line = prefix;
  for (const word of text.split(/\s+/)) {
    const fresh = line === prefix || line === indent;
    if (!fresh && line.length + word.length + 1 > WRAP_AT) {
      out.push(line);
      line = indent;
    }
    line += line === prefix || line === indent ? word : ` ${word}`;
  }
  out.push(line);
  return out;
}

/** The README block lines for a release (without the '>' spacer). */
function readmeBlock(version, title, notes, sep = ' - ') {
  const items = [...notes.features, ...notes.fixes.map((f) => `Fix: ${f}`)];
  return [`> **Current release: v${version}${sep}${title}.**`, ...items.flatMap((s) => bullet(s, '> - '))];
}

/**
 * README.md with the new block on top of the old one, the old one demoted
 * to '> **vPrev - ...**'. Without a current block the new one goes right
 * under the first paragraph after the title.
 * @returns {string}
 */
function updateReadme(text, version, title, notes) {
  const src = String(text || '');
  const cur = CURRENT_RE.exec(src);
  if (cur) {
    const block = readmeBlock(version, title, notes, cur[2]).join('\n');
    const demoted = `> **${cur[1]}${cur[2]}${cur[3]}**`;
    return `${src.slice(0, cur.index)}${block}\n>\n${demoted}${src.slice(cur.index + cur[0].length)}`;
  }
  const block = readmeBlock(version, title, notes).join('\n');
  const all = src.split('\n');
  const head = all.findIndex((l) => /^# /.test(l));
  let at = head < 0 ? 0 : head + 1;
  while (at < all.length && all[at].trim() === '') at += 1;
  while (at < all.length && all[at].trim() !== '') at += 1;
  return [...all.slice(0, at), '', block, ...all.slice(at)].join('\n');
}

/** The GitHub release notes (markdown) for the notes file. */
function releaseNotes(version, title, notes) {
  const out = [`## ${PRODUCT} v${version} - ${title}`, ''];
  if (notes.features.length) out.push('### Features', '', ...notes.features.map((f) => `- ${f}`), '');
  if (notes.fixes.length) out.push('### Fixes', '', ...notes.fixes.map((f) => `- ${f}`), '');
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * The dist file names of a version: what electron-builder writes and what
 * latest.yml names, plus `dir`, the version's own output folder (posix,
 * relative to the repo).
 */
function distAssets(version) {
  return {
    dir: `dist/release-v${version}`,
    setup: `${PRODUCT} Setup ${version}.exe`,
    setupBlockmap: `${PRODUCT} Setup ${version}.exe.blockmap`,
    dashedSetup: `${PRODUCT}-Setup-${version}.exe`,
    dashedBlockmap: `${PRODUCT}-Setup-${version}.exe.blockmap`,
    portable: `${PRODUCT}-${version}-portable.exe`,
    latest: 'latest.yml',
    notes: `release-notes-v${version}.md`,
  };
}

/**
 * The step-5 build command: electron-builder writes into the version's own
 * folder. The string goes through the shell, so the version must be x.y.z.
 * @param {string} version
 * @returns {string|null} null for anything that is not x.y.z
 */
function distCommand(version) {
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) return null;
  return `npm run dist -- -c.directories.output=${distAssets(version).dir}`;
}

// Shell operators that would split the dist script into several commands:
// `npm run dist -- <args>` appends <args> to the LAST one only.
const SHELL_CHAIN_RE = /[;&|<>\r\n`]/;
const ELECTRON_BUILDER_RE = /^electron-builder(\s|$)/;

/**
 * Why package.json's scripts cannot carry distCommand's output override, or
 * null. The override is appended to the `dist` script, so that script must be
 * ONE electron-builder command that does not set the output folder itself,
 * and no predist / postdist step may run outside the override (a clean step
 * there could touch dist/win-unpacked, which a running LunaCore holds).
 * @param {object} scripts package.json `scripts`
 * @returns {string|null}
 */
function distScriptProblem(scripts) {
  const dist = scripts && typeof scripts === 'object' ? scripts.dist : undefined;
  if (typeof dist !== 'string') return 'no dist script in package.json';
  const cmd = dist.trim();
  if (!ELECTRON_BUILDER_RE.test(cmd) || SHELL_CHAIN_RE.test(cmd)) {
    return 'the dist script is not a single electron-builder command (the output folder override would not reach it)';
  }
  if (/directories\.output/.test(cmd)) return 'the dist script sets its own output folder';
  const hook = ['predist', 'postdist'].find((name) => scripts[name] != null);
  if (hook) return `package.json has a ${hook} script, which runs outside the build's output folder`;
  return null;
}

// ---------------------------------------------------------------------------
// Default side effects
// ---------------------------------------------------------------------------

/** git / gh without a shell: {ok, code, stdout, stderr}, never rejects. */
function execBin(bin, args, opts) {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
}

/** A FIXED npm command string through the shell: {ok, output, timedOut}, never rejects. */
function execShell(command, opts) {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${String(stdout || '')}\n${String(stderr || '')}`.trim(), timedOut: !!(err && err.killed) }),
    );
  });
}

const DEFAULT_DEPS = { exec: execBin, shell: execShell, fs, lockHolders: findLockHolders };

// ---------------------------------------------------------------------------
// The release
// ---------------------------------------------------------------------------

/**
 * Commits since the last v* tag in `repoPath` (read-only).
 * @returns {Promise<{ok:true, tag:string, count:number}|{ok:false, reason:string}>}
 */
async function unreleasedCount(repoPath, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const git = (args) => d.exec('git', ['-C', repoPath, ...args], { timeout: GIT_TIMEOUT_MS, env: d.env });
  const tagRes = await git(['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const tag = tagRes.ok ? lastLine(tagRes.stdout) : '';
  if (!TAG_RE.test(tag)) return { ok: false, reason: 'no previous v* tag' };
  const res = await git(['rev-list', '--count', `${tag}..HEAD`]);
  const count = Number(lastLine(res.stdout));
  return res.ok && Number.isInteger(count) ? { ok: true, tag, count } : { ok: false, reason: 'git failed' };
}

/** HEAD's full sha, or null. */
async function headOf(git) {
  const res = await git(['rev-parse', 'HEAD']);
  const sha = res.ok ? lastLine(res.stdout) : '';
  return FULL_SHA_RE.test(sha) ? sha : null;
}

/**
 * The checkout is still what the preflight saw: clean, on `base`, at `head`.
 * @returns {Promise<string|null>} why not, or null
 */
async function stillSame(git, base, head) {
  const status = await git(['status', '--porcelain']);
  if (!status.ok || status.stdout.trim()) return 'the checkout changed during the tests (uncommitted changes)';
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.ok || lastLine(branch.stdout) !== base) return `the checkout left ${base} during the tests`;
  return (await headOf(git)) === head ? null : `${base} moved during the tests`;
}

/** Step 0: every refusal, before anything changes. Returns the facts the rest needs, or a refusal. */
async function preflight(opts, d, git, npm) {
  const refuse = (stage, reason) => ({ refusal: { ok: false, refused: true, stage, reason } });
  const { repoPath, base, landedSha } = opts;
  let pkg;
  try {
    pkg = JSON.parse(d.fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
  } catch {
    return refuse('package', 'package.json unreadable');
  }
  const scriptProblem = distScriptProblem(pkg && pkg.scripts);
  if (scriptProblem) return refuse('package', scriptProblem);
  if (!SEMVER_RE.test(String(pkg.version))) return refuse('package', 'package.json version is not x.y.z');

  const status = await git(['status', '--porcelain']);
  if (!status.ok) return refuse('status', 'git status failed');
  if (status.stdout.trim()) return refuse('status', 'uncommitted changes');
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.ok || lastLine(branch.stdout) !== base) return refuse('branch', `not on ${base}`);
  if (typeof landedSha !== 'string' || !SHA_RE.test(landedSha)) return refuse('landed', 'run not landed on base');
  if (!(await git(['merge-base', '--is-ancestor', landedSha, 'HEAD'])).ok) return refuse('landed', 'run not landed on base');
  const fetched = await git(['fetch', '--quiet', 'origin', `refs/heads/${base}:refs/remotes/origin/${base}`], PUSH_TIMEOUT_MS);
  if (!fetched.ok) return refuse('landed', `could not fetch origin/${base}`);
  const behind = await git(['rev-list', '--count', `HEAD..refs/remotes/origin/${base}`]);
  if (!behind.ok || Number(lastLine(behind.stdout)) > 0) return refuse('landed', `local ${base} is behind origin`);
  const head = await headOf(git);
  if (!head) return refuse('branch', 'no HEAD commit');

  const auth = await d.exec('gh', ['auth', 'status'], { cwd: repoPath, timeout: GIT_TIMEOUT_MS, env: d.env });
  if (auth.code === 'ENOENT') return refuse('gh', 'gh not installed');
  if (!auth.ok) return refuse('gh', 'gh not authenticated (gh auth login)');

  const since = await unreleasedCount(repoPath, d);
  if (!since.ok) return refuse('tag', since.reason);
  if (since.count === 0) return refuse('tag', `nothing new since ${since.tag}`);
  const log = await git(['log', `${since.tag}..HEAD`, '--no-merges', '--format=%s', `-n${MAX_SUBJECTS}`]);
  if (!log.ok) return refuse('tag', 'git log failed');
  const subjects = lines(log.stdout);
  const version = nextVersion(pkg.version, subjects);
  if (!version) return refuse('package', 'package.json version is not x.y.z');
  if ((await git(['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`])).ok) return refuse('tag', `v${version} already exists`);

  (d.log || (() => {}))(`release: npm test before v${version}`);
  const tests = await npm('npm test', TEST_TIMEOUT_MS);
  if (!tests.ok) return refuse('tests', tests.timedOut ? 'tests timed out' : 'tests failed');
  // The tests took minutes: the checkout must still be the one checked above.
  const moved = await stillSame(git, base, head);
  if (moved) return refuse('branch', moved);
  return { version, notes: buildNotes(subjects) };
}

/** A regular file (not a link, not a folder) at `file`. */
function isPlainFile(d, file) {
  try {
    return d.fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/** Step 5: the build's dashed copies, checked against latest.yml. Returns an error reason or null. */
function prepareAssets(d, repoPath, assets) {
  const inDist = (name) => path.join(repoPath, assets.dir, name);
  for (const name of [assets.setup, assets.setupBlockmap, assets.portable, assets.latest]) {
    if (!isPlainFile(d, inDist(name))) return `${assets.dir}/${name} missing or not a regular file`;
  }
  const latest = d.fs.readFileSync(inDist(assets.latest), 'utf8');
  if (!latest.includes(assets.dashedSetup)) return `${assets.dir}/latest.yml does not point to ${assets.dashedSetup}`;
  d.fs.copyFileSync(inDist(assets.setup), inDist(assets.dashedSetup));
  d.fs.copyFileSync(inDist(assets.setupBlockmap), inDist(assets.dashedBlockmap));
  return null;
}

/**
 * Step 5 failed: why, in words. The tag is already pushed by then, so the
 * reason says the release has to be published by hand; an EBUSY failure
 * also names the process holding the file. Never rejects.
 * @param {{output:string, timedOut:boolean}} dist the npm answer
 */
async function distFailure(d, repoPath, tag, dist) {
  const pushed = `tag ${tag} is already pushed, publish the GitHub release by hand`;
  if (dist.timedOut) return `npm run dist timed out (${pushed})`;
  const locked = lockedPathOf(dist.output);
  if (!locked) return `npm run dist failed (${pushed}): ${lastLine(dist.output)}`;
  const rel = path.relative(repoPath, locked);
  const inRepo = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  // Only a file inside the repo is looked up: a path from tool output could
  // name anything, a UNC share included.
  let found = { ok: false, reason: 'holder not looked up (outside the repo)' };
  if (inRepo) {
    try {
      found = await d.lockHolders(locked, { env: d.env });
    } catch (err) {
      found = { ok: false, reason: `lock holder lookup failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  let holder = 'holder not found';
  if (!found || !found.ok) holder = (found && found.reason) || 'lock holder lookup failed';
  else if (found.holders.length) holder = `held by ${describeHolders(found.holders)}`;
  // The holder before the path: the reason is cut at 300 characters.
  return `npm run dist failed (${pushed}): EBUSY, ${holder}, on ${oneLine(inRepo ? rel : locked, 120)}`;
}

/**
 * Cuts a release in `repoPath` (the main checkout, on `base`).
 * @param {{repoPath:string, base:string, landedSha:string|null, title?:string}} opts
 *   landedSha: the head the run's merge pushed (integration.headSha) - it
 *   must be in HEAD, so only what landed is released
 * @param {{exec?:Function, shell?:Function, fs?:object, env?:object, log?:(line:string)=>void,
 *   lockHolders?:(file:string)=>Promise<object>}} [deps] lockHolders: fileLockHolder.findLockHolders
 * @returns {Promise<{ok:true, version:string, tag:string, title:string, url:string|null}
 *   | {ok:false, refused:boolean, stage:string, reason:string}>} never rejects
 */
async function cutRelease(opts, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const log = d.log || (() => {});
  const fail = (stage, reason) => ({ ok: false, refused: false, stage, reason: oneLine(redact(reason), 300) || 'failed' });
  const o = opts || {};
  const { repoPath, base } = o;
  if (typeof repoPath !== 'string' || !repoPath || !path.isAbsolute(repoPath)) return { ok: false, refused: true, stage: 'input', reason: 'no repo' };
  if (typeof base !== 'string' || !BASE_RE.test(base) || base.includes('..')) {
    return { ok: false, refused: true, stage: 'input', reason: 'bad base branch' };
  }
  const git = (args, timeout = GIT_TIMEOUT_MS) => d.exec('git', ['-C', repoPath, ...args], { timeout, env: d.env });
  const npm = (command, timeout) => d.shell(command, { cwd: repoPath, timeout, env: d.env });
  const file = (...parts) => path.join(repoPath, ...parts);

  try {
    const pre = await preflight(o, d, git, npm);
    if (pre.refusal) return pre.refusal;
    const { version, notes } = pre;
    const tag = `v${version}`;
    const title = truncateWords(oneLine(o.title), MAX_TITLE) || releaseTitle(notes);

    // 1. The version (package.json + package-lock.json).
    const bump = await npm(`npm version ${version} --no-git-tag-version`, GIT_TIMEOUT_MS * 2);
    if (!bump.ok) return fail('version', `npm version failed: ${lastLine(bump.output)}`);

    // 2. README.
    const readme = d.fs.readFileSync(file('README.md'), 'utf8');
    d.fs.writeFileSync(file('README.md'), updateReadme(readme, version, title, notes), 'utf8');

    // 3. Commit, then the tag on exactly that commit.
    const toAdd = ['package.json', 'README.md', ...(d.fs.existsSync(file('package-lock.json')) ? ['package-lock.json'] : [])];
    if (!(await git(['add', '--', ...toAdd])).ok) return fail('commit', 'git add failed');
    const commit = await git(['commit', '-m', `chore(release): ${tag} - ${title}`, '-m', CO_AUTHOR]);
    if (!commit.ok) return fail('commit', `git commit failed: ${lastLine(commit.stderr || commit.stdout)}`);
    const releaseSha = await headOf(git);
    if (!releaseSha) return fail('commit', 'no release commit');
    const tagged = await git(['tag', '-a', tag, '-m', `${tag} - ${title}`, releaseSha]);
    if (!tagged.ok) return fail('tag', `git tag failed: ${lastLine(tagged.stderr)}`);

    // 4. Push the release commit to the base branch, then the tag. Never --force.
    const pushBase = await git(['push', 'origin', `${releaseSha}:refs/heads/${base}`], PUSH_TIMEOUT_MS);
    if (!pushBase.ok) return fail('push', `push ${base} failed: ${lastLine(pushBase.stderr)}`);
    const pushTag = await git(['push', 'origin', `refs/tags/${tag}`], PUSH_TIMEOUT_MS);
    if (!pushTag.ok) return fail('push', `push ${tag} failed: ${lastLine(pushTag.stderr)}`);

    // 5. Build into the version's own folder, then the dashed copies
    //    latest.yml points to, and the notes. The version goes into a shell
    //    command: checked against SEMVER_RE again right here.
    const assets = distAssets(version);
    const distCmd = distCommand(version);
    if (!distCmd) return fail('dist', `refusing to build: version ${version} is not x.y.z`);
    log(`release: npm run dist for ${tag} into ${assets.dir}`);
    const dist = await npm(distCmd, DIST_TIMEOUT_MS);
    if (!dist.ok) return fail('dist', await distFailure(d, repoPath, tag, dist));
    const assetError = prepareAssets(d, repoPath, assets);
    if (assetError) return fail('assets', assetError);
    const inDir = (name) => path.join(...assets.dir.split('/'), name);
    d.fs.writeFileSync(path.join(repoPath, inDir(assets.notes)), releaseNotes(version, title, notes), 'utf8');

    // 6. The GitHub release, every asset from the version's folder.
    const gh = await d.exec(
      'gh',
      [
        'release', 'create', tag,
        '--title', `${PRODUCT} ${tag}`,
        '--notes-file', inDir(assets.notes),
        '--latest',
        inDir(assets.latest),
        inDir(assets.portable),
        inDir(assets.dashedSetup),
        inDir(assets.dashedBlockmap),
      ],
      { cwd: repoPath, timeout: GH_TIMEOUT_MS, env: d.env },
    );
    if (!gh.ok) return fail('release', `gh release create failed: ${lastLine(gh.stderr)}`);
    const url = lines(gh.stdout).reverse().find((l) => RELEASE_URL_RE.test(l)) || null;
    return { ok: true, version, tag, title, url };
  } catch (err) {
    return fail('error', err instanceof Error ? err.message : String(err));
  }
}

/**
 * A cutRelease answer as a post-merge step result (orchestraPostMerge):
 * released / skipped (a refusal) / error (a step that broke).
 */
function releaseResult(res) {
  if (res && res.ok) return { released: true, version: res.version, tag: res.tag, title: res.title, url: res.url };
  if (res && res.refused) return { skipped: res.reason };
  return { error: res ? `${res.stage}: ${res.reason}` : 'failed' };
}

module.exports = {
  cutRelease,
  unreleasedCount,
  releaseResult,
  buildNotes,
  nextVersion,
  releaseTitle,
  updateReadme,
  releaseNotes,
  distAssets,
  distCommand,
  distScriptProblem,
  truncateWords,
  isSkippedSubject,
  redact,
  CO_AUTHOR,
};
