// ============================================================================
// Luna's Work headless Playtester: argv allows only the adapter's MCP tools,
// the prompt carries no code and no earlier verdicts, validation drops
// evidence-less scores and foreign screenshots, shipConfirm is always opus,
// screen diffs above the threshold become findings, and a broken answer yields
// an empty report instead of a crash. `claude` is a fake exec; disk writes go
// to temp dirs, never the real config/ directory.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { PNG } = require('pngjs');

const P = require('../src/lunasworkPlaytest.js');
const A = require('../src/lunasworkAdapters.js');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const URL_ = 'http://localhost:5173';
const CODE_MARKER = 'SECRET_SOURCE_CODE_MARKER';
const SCORE_MARKER = 'PREVIOUS_SCORE_MARKER';

const TEST_PLAN = '# Test plan\n\n## Journeys\n\n### Make a quote\n1. Open the app\n2. Enter 10 m of steel\n';
const SHIP = '# Ship criteria\n\n## Core flows\n- [x] A quote can be made end to end\n- [ ] Totals are correct\n';

/** A project with a design pack, source code and an earlier playtest log. */
function fakeProject() {
  const dir = tmpDir('lw-pt-project-');
  fs.mkdirSync(path.join(dir, 'design'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'design', 'TEST_PLAN.md'), TEST_PLAN);
  fs.writeFileSync(path.join(dir, 'design', 'SHIP_CRITERIA.md'), SHIP);
  fs.writeFileSync(path.join(dir, 'design', 'PLAYTEST_LOG.md'), `## Iteration 1\nscore 7/10 ${SCORE_MARKER}\n`);
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), `const x = '${CODE_MARKER}';\n`);
  return dir;
}

/**
 * A real web adapter, started against a fake server, so tools() carries the
 * --allowed-origins lock. Its evidence dir lives in a temp runs root.
 */
async function fakeAdapter({ start = true } = {}) {
  const adapter = A.createAdapter('web', {
    projectDir: tmpDir('lw-pt-adapter-'),
    runsRoot: path.join(tmpDir('lw-pt-runs-'), 'runs'),
    runId: 'run1',
    iteration: 1,
    spawn: () => Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() }),
    fetch: async () => ({ status: 200 }),
    sleep: async () => {},
    execFile: (file, args, options, cb) => cb(null),
  });
  if (start) await adapter.start({ adapter: 'web', startCommand: 'npm run dev', url: URL_, readyTimeoutSec: 5 });
  return adapter;
}

function writePng(file, width, height, paint) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b] = paint(x, y);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}
const red = () => [255, 0, 0];

/**
 * A fake `claude`: records the call and the stdin prompt, lets `onCall`
 * write screenshots into the cwd (as Playwright MCP would), then answers.
 */
function fakeClaude({ raw, stdout, error, onCall } = {}) {
  const calls = [];
  const execImpl = (file, args, options, cb) => {
    const stdin = new PassThrough();
    const call = { file, args, options, prompt: '' };
    calls.push(call);
    stdin.on('data', (d) => {
      call.prompt += d;
    });
    stdin.on('finish', () => {
      if (onCall) onCall(options.cwd);
      const out = stdout !== undefined ? stdout : JSON.stringify({ structured_output: raw, total_cost_usd: 0.5 });
      setImmediate(() => cb(error || null, out));
    });
    return { stdin };
  };
  return { calls, execImpl };
}

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];
/** A well-formed report: all four lists present. */
const full = (over = {}) => ({ findings: [], scores: [], journeys: [], screens: [], ...over });

// ---- argv -----------------------------------------------------------------------

test('argv allows only the adapter MCP tools and disallows every code tool', async () => {
  const tools = (await fakeAdapter()).tools();
  const args = P.buildPlaytestArgs({ model: 'sonnet', tools });

  assert.equal(argAfter(args, '--tools'), '', 'no built-in tools at all');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(argAfter(args, '--permission-mode'), 'dontAsk');
  assert.equal(argAfter(args, '--setting-sources'), '');
  assert.deepEqual(JSON.parse(argAfter(args, '--mcp-config')), tools.mcpConfig);

  const allowed = argAfter(args, '--allowedTools').split(',');
  assert.ok(allowed.length > 0);
  for (const t of allowed) assert.match(t, /^mcp__playwright__browser_[a-z_]+$/);

  const denied = argAfter(args, '--disallowedTools').split(',');
  for (const t of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']) assert.ok(denied.includes(t), `${t} denied`);
  for (const t of denied) assert.ok(!allowed.includes(t));
});

test('built-in or foreign-server tools from the adapter never reach --allowedTools', () => {
  const tools = {
    mcpConfig: { mcpServers: { playwright: { command: 'npx', args: [] } } },
    allowedTools: ['Bash', 'Read', 'mcp__evil__run', 'mcp__playwright__browser_click', 42],
  };
  assert.deepEqual(P.allowedAdapterTools(tools), ['mcp__playwright__browser_click']);
  assert.throws(() => P.buildPlaytestArgs({ model: 'sonnet', tools: { mcpConfig: {}, allowedTools: ['Bash'] } }));
});

// ---- prompt ---------------------------------------------------------------------

test('runPlaytest runs outside the repo and its prompt carries no code and no earlier scores', async () => {
  const projectDir = fakeProject();
  const adapter = await fakeAdapter();
  const fake = fakeClaude({ raw: { findings: [], scores: [], journeys: [], screens: [] } });

  const res = await P.runPlaytest({ projectDir, adapter, url: URL_, execImpl: fake.execImpl });

  assert.equal(res.ok, true);
  const [call] = fake.calls;
  assert.equal(call.file, 'claude');
  assert.deepEqual(call.args, P.buildPlaytestArgs({ model: 'sonnet', tools: adapter.tools() }), 'the guarded argv is what runs');
  assert.equal(call.options.cwd, adapter.evidenceDir);
  assert.notEqual(path.resolve(call.options.cwd), path.resolve(projectDir));
  assert.ok(!call.args.join(' ').includes(projectDir), 'project path not in argv');

  assert.ok(call.prompt.includes(URL_));
  assert.ok(call.prompt.includes('Enter 10 m of steel'), 'test plan included');
  assert.ok(call.prompt.includes('Totals are correct'), 'ship criteria included');
  assert.ok(call.prompt.includes('1440') && call.prompt.includes('390'), 'both widths');
  assert.ok(!call.prompt.includes(CODE_MARKER), 'no source code');
  assert.ok(!call.prompt.includes(SCORE_MARKER), 'no playtest log / earlier scores');
  assert.ok(!call.prompt.includes(projectDir), 'no repo path');
  assert.ok(!/\[[xX]\]/.test(call.prompt), 'earlier gate verdicts cleared');
});

test('a design/ junction pointing elsewhere is not read into the prompt', async () => {
  const projectDir = tmpDir('lw-pt-linked-');
  const elsewhere = tmpDir('lw-pt-elsewhere-');
  fs.writeFileSync(path.join(elsewhere, 'TEST_PLAN.md'), `# Test plan\n${SCORE_MARKER}\n`);
  fs.symlinkSync(elsewhere, path.join(projectDir, 'design'), 'junction');
  const fake = fakeClaude({ raw: full() });

  const res = await P.runPlaytest({ projectDir, adapter: await fakeAdapter(), url: URL_, execImpl: fake.execImpl });
  assert.equal(res.error, 'noDesignPack');
  assert.equal(fake.calls.length, 0);
});

test('the url must be the started app origin', async () => {
  const fake = fakeClaude({ raw: full() });
  const run = async (adapter, url) => P.runPlaytest({ projectDir: fakeProject(), adapter, url, execImpl: fake.execImpl });
  assert.equal((await run(await fakeAdapter({ start: false }), URL_)).error, 'badUrl', 'unstarted adapter has no origin lock');
  assert.equal((await run(await fakeAdapter(), 'http://localhost:9999')).error, 'badUrl');
  assert.equal(fake.calls.length, 0);
});

test('shipConfirm prompt is built from the ship criteria only', () => {
  const prompt = P.buildPlaytestPrompt({ mode: 'shipConfirm', url: URL_, testPlan: TEST_PLAN, shipCriteria: SHIP });
  assert.ok(prompt.includes('Totals are correct'));
  assert.ok(!prompt.includes('Enter 10 m of steel'));
});

// ---- models ---------------------------------------------------------------------

test('shipConfirm always uses opus, whatever the playtester setting', async () => {
  for (const playtester of ['haiku', 'sonnet', 'auto', 'opus']) {
    assert.equal(P.playtestModel('shipConfirm', { playtester }).model, 'opus');
  }
  const fake = fakeClaude({ raw: { findings: [], scores: [], journeys: [], screens: [] } });
  const res = await P.runPlaytest({
    projectDir: fakeProject(),
    adapter: await fakeAdapter(),
    url: URL_,
    mode: 'shipConfirm',
    models: { playtester: 'haiku' },
    execImpl: fake.execImpl,
  });
  assert.equal(res.model, 'opus');
  assert.equal(argAfter(fake.calls[0].args, '--model'), 'opus');
  assert.equal(res.screenDiff, null, 'the ship pass does not diff screens');
});

test('explore follows the playtester setting, default sonnet', () => {
  assert.equal(P.playtestModel('explore', undefined).model, 'sonnet');
  assert.equal(P.playtestModel('explore', { playtester: 'haiku' }).model, 'haiku');
  assert.equal(P.playtestModel('explore', { playtester: 'auto' }).model, 'sonnet');
});

// ---- validation -----------------------------------------------------------------

function evidenceWorld() {
  const evidenceDir = tmpDir('lw-pt-evidence-');
  writePng(path.join(evidenceDir, 'f1.png'), 4, 4, red);
  const outside = path.join(tmpDir('lw-pt-outside-'), 'x.png');
  writePng(outside, 4, 4, red);
  return { evidenceDir, outside };
}

const ev = (screenshot, steps = ['Open the app']) => ({ screenshot, steps });

test('scores without evidence are dropped', () => {
  const { evidenceDir } = evidenceWorld();
  const raw = full({
    scores: [
      { milestone: 'Core flows', criterion: 'ok', score: 8, evidence: ev('f1.png') },
      { milestone: 'Core flows', criterion: 'no shot', score: 9, evidence: ev('') },
      { milestone: 'Core flows', criterion: 'no steps', score: 9, evidence: ev('f1.png', []) },
      { milestone: 'Core flows', criterion: 'no evidence', score: 9 },
      { milestone: 'Core flows', criterion: 'out of range', score: 11, evidence: ev('f1.png') },
    ],
  });
  const report = P.validateReport(raw, { evidenceDir });
  assert.deepEqual(report.scores.map((s) => s.criterion), ['ok']);
  assert.equal(report.scores[0].evidence.screenshot, fs.realpathSync(path.join(evidenceDir, 'f1.png')));
  assert.equal(report.warnings.filter((w) => w.code === 'noEvidence').length, 3);
});

test('screenshot paths outside the evidence dir, missing or stale are dropped', () => {
  const { evidenceDir, outside } = evidenceWorld();
  const stale = path.join(evidenceDir, 'old.png');
  writePng(stale, 4, 4, red);
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(stale, past, past);
  const since = Date.now() - 10 * 60 * 1000;

  // Escapes through links: a junction (no privilege needed) and, where the OS
  // allows it, a file symlink.
  fs.symlinkSync(path.dirname(outside), path.join(evidenceDir, 'lnk'), 'junction');
  let fileLink = null;
  try {
    fs.symlinkSync(outside, path.join(evidenceDir, 'link.png'), 'file');
    fileLink = 'link.png';
  } catch {
    // EPERM without Developer Mode on Windows - the junction case still runs.
  }
  fs.writeFileSync(path.join(evidenceDir, 'text.png'), 'console dump, not an image');

  const score = (screenshot) => ({ milestone: 'M', criterion: screenshot, score: 5, evidence: ev(screenshot) });
  const cited = ['f1.png', outside, '../x.png', 'missing.png', 'old.png', 'server.log', 'lnk/x.png', 'text.png'];
  if (fileLink) cited.push(fileLink);
  const raw = full({
    scores: cited.map(score),
    findings: [{ kind: 'bug', severity: 'high', title: 'Broken', steps: ['a'], screenshot: outside, consoleErrors: [] }],
  });
  const report = P.validateReport(raw, { evidenceDir, since });
  assert.deepEqual(report.scores.map((s) => s.criterion), ['f1.png']);
  assert.equal(report.findings.length, 1, 'the finding itself is kept');
  assert.equal(report.findings[0].screenshot, null, 'its foreign screenshot is not');
});

test('a journey claimed as passed without evidence does not count as passed', () => {
  const { evidenceDir } = evidenceWorld();
  const raw = full({
    journeys: [
      { name: 'Proven', passed: true, evidence: ev('f1.png') },
      { name: 'Claimed', passed: true, evidence: ev('', []) },
      { name: 'Failed', passed: false, evidence: ev('', []) },
    ],
  });
  const report = P.validateReport(raw, { evidenceDir });
  assert.deepEqual(report.journeys.map((j) => [j.name, j.passed]), [['Proven', true], ['Claimed', false], ['Failed', false]]);
  assert.ok(report.warnings.some((w) => w.code === 'noEvidence' && w.journey === 'Claimed'));
});

test('text fields are capped and malformed records dropped', () => {
  const { evidenceDir } = evidenceWorld();
  const long = 'x'.repeat(5000);
  const raw = full({
    findings: [
      {
        kind: 'bug',
        severity: 'low',
        title: long,
        steps: Array(50).fill(long),
        screenshot: 'f1.png',
        consoleErrors: Array(50).fill(long),
      },
      { kind: 'nonsense', severity: 'low', title: 'x' },
      { kind: 'bug', severity: 'urgent', title: 'x' },
      null,
    ],
    journeys: [{ name: 'Make a quote', passed: true, evidence: ev('f1.png') }, { name: 'x', passed: 'yes' }],
  });
  const report = P.validateReport(raw, { evidenceDir });
  const [f] = report.findings;
  assert.equal(report.findings.length, 1);
  assert.ok(f.title.length <= 200);
  assert.ok(f.steps.length <= 20 && f.steps.every((s) => s.length <= 300));
  assert.ok(f.consoleErrors.length <= 20 && f.consoleErrors.every((s) => s.length <= 500));
  assert.deepEqual(report.journeys.map((j) => j.name), ['Make a quote']);
});

// ---- failures never crash -------------------------------------------------------

test('malformed output yields an empty report with an error note', async () => {
  const cases = [
    { stdout: 'not json at all' },
    { stdout: JSON.stringify({ result: '{oops' }) },
    { stdout: JSON.stringify({ is_error: true, result: 'boom' }) },
    { error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }), stdout: '' },
    { error: Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }), stdout: '' },
    // The `result` fallback skips the schema: `{}` is malformed, not "nothing found".
    { stdout: JSON.stringify({ result: '{}' }) },
    { raw: { findings: [] } },
  ];
  for (const c of cases) {
    const fake = fakeClaude(c);
    const res = await P.runPlaytest({ projectDir: fakeProject(), adapter: await fakeAdapter(), url: URL_, execImpl: fake.execImpl });
    assert.equal(res.ok, false);
    assert.deepEqual(res.report.findings, []);
    assert.deepEqual(res.report.scores, []);
    assert.equal(res.report.errors.length, 1);
    assert.equal(res.report.errors[0].code, res.error);
  }
});

test('a structured answer of the wrong shape validates to an empty report', () => {
  const report = P.validateReport('just text', { evidenceDir: tmpDir('lw-pt-e-') });
  assert.deepEqual(report.findings, []);
  assert.equal(report.errors[0].code, 'badReport');
});

test('bad url, missing pack or missing ship criteria fail without calling claude', async () => {
  const fake = fakeClaude({ raw: {} });
  const empty = tmpDir('lw-pt-empty-');
  const run = async (over) =>
    P.runPlaytest({ projectDir: fakeProject(), adapter: await fakeAdapter(), url: URL_, execImpl: fake.execImpl, ...over });
  assert.equal((await run({ url: 'file:///etc/passwd' })).error, 'badUrl');
  assert.equal((await run({ mode: 'yolo' })).error, 'badMode');
  assert.equal((await run({ projectDir: empty })).error, 'noDesignPack');
  assert.equal((await run({ projectDir: empty, mode: 'shipConfirm' })).error, 'noShipCriteria');
  assert.equal(fake.calls.length, 0);
});

test('a timeout kills the whole process tree and reports timeout', async () => {
  const killed = [];
  let finish = null;
  const execImpl = (file, args, options, cb) => {
    finish = cb;
    return { pid: 777, stdin: new PassThrough() };
  };
  const res = await P.runPlaytest({
    projectDir: fakeProject(),
    adapter: await fakeAdapter(),
    url: URL_,
    execImpl,
    timeoutMs: 5,
    killTreeImpl: (pid) => {
      killed.push(pid);
      finish(Object.assign(new Error('killed'), { code: 1 }), '');
    },
  });
  assert.deepEqual(killed, [777]);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
});

test('a screenshot from before this pass started is not evidence of it', async () => {
  const adapter = await fakeAdapter();
  fs.mkdirSync(adapter.evidenceDir, { recursive: true });
  const earlier = path.join(adapter.evidenceDir, 'explore-pass.png');
  writePng(earlier, 4, 4, red);
  const oneSecondAgo = new Date(Date.now() - 1000);
  fs.utimesSync(earlier, oneSecondAgo, oneSecondAgo);

  const fake = fakeClaude({
    onCall: (cwd) => writePng(path.join(cwd, 'ship-1.png'), 4, 4, red),
    raw: full({
      scores: [
        { milestone: 'Core flows', criterion: 'fresh', score: 9, evidence: ev('ship-1.png') },
        { milestone: 'Core flows', criterion: 'reused', score: 9, evidence: ev('explore-pass.png') },
      ],
    }),
  });
  const res = await P.runPlaytest({ projectDir: fakeProject(), adapter, url: URL_, mode: 'shipConfirm', execImpl: fake.execImpl });
  assert.deepEqual(res.report.scores.map((s) => s.criterion), ['fresh']);
});

// ---- screen comparison ----------------------------------------------------------

function screenWorld() {
  const evidenceDir = tmpDir('lw-pt-diff-');
  const baselinesDir = path.join(tmpDir('lw-pt-base-'), 'baselines');
  return { evidenceDir, baselinesDir };
}

test('first run stores the baseline and reports nothing', () => {
  const { evidenceDir, baselinesDir } = screenWorld();
  writePng(path.join(evidenceDir, 'home.png'), 20, 20, red);
  const out = P.compareScreens([{ name: 'home-desktop', screenshot: path.join(evidenceDir, 'home.png') }], {
    evidenceDir,
    baselinesDir,
  });
  assert.deepEqual(out.findings, []);
  assert.equal(out.results[0].status, 'baseline');
  assert.ok(fs.existsSync(path.join(baselinesDir, 'home-desktop.png')));
});

test('a screen diff above the threshold yields a finding with both images', () => {
  const { evidenceDir, baselinesDir } = screenWorld();
  writePng(path.join(baselinesDir, 'home-desktop.png'), 20, 20, red);
  // Left half turns blue: 50% of pixels differ.
  writePng(path.join(evidenceDir, 'home.png'), 20, 20, (x) => (x < 10 ? [0, 0, 255] : [255, 0, 0]));

  const out = P.compareScreens([{ name: 'home-desktop', screenshot: path.join(evidenceDir, 'home.png') }], {
    evidenceDir,
    baselinesDir,
  });
  assert.equal(out.findings.length, 1);
  const [f] = out.findings;
  assert.equal(out.results[0].status, 'changed');
  assert.ok(Math.abs(out.results[0].ratio - 0.5) < 1e-9);
  assert.match(f.title, /home-desktop.*50\.0%/);
  assert.ok(fs.existsSync(f.screenshot) && fs.existsSync(f.baseline) && fs.existsSync(f.diff));
  assert.ok(f.baseline.startsWith(evidenceDir) && f.diff.startsWith(evidenceDir), 'images kept as evidence');
  // The baseline rolled forward to the new screenshot.
  assert.deepEqual(fs.readFileSync(path.join(baselinesDir, 'home-desktop.png')), fs.readFileSync(f.screenshot));
});

test('a diff below the threshold is not a finding', () => {
  const { evidenceDir, baselinesDir } = screenWorld();
  writePng(path.join(baselinesDir, 'home-desktop.png'), 20, 20, red);
  // One pixel of 400 = 0.25%, under the 2% default.
  writePng(path.join(evidenceDir, 'home.png'), 20, 20, (x, y) => (x === 0 && y === 0 ? [0, 0, 255] : [255, 0, 0]));
  const screens = [{ name: 'home-desktop', screenshot: path.join(evidenceDir, 'home.png') }];

  const out = P.compareScreens(screens, { evidenceDir, baselinesDir });
  assert.deepEqual(out.findings, []);
  assert.equal(out.results[0].status, 'same');

  // The same change with a stricter threshold is one.
  writePng(path.join(baselinesDir, 'home-desktop.png'), 20, 20, red);
  assert.equal(P.compareScreens(screens, { evidenceDir, baselinesDir, threshold: 0.001 }).findings.length, 1);
});

test('a size change is a finding; a broken image is skipped, never thrown', () => {
  const { evidenceDir, baselinesDir } = screenWorld();
  writePng(path.join(baselinesDir, 'a.png'), 20, 20, red);
  writePng(path.join(evidenceDir, 'a.png'), 20, 30, red);
  fs.writeFileSync(path.join(evidenceDir, 'b.png'), 'not a png');
  const out = P.compareScreens(
    [
      { name: 'a', screenshot: path.join(evidenceDir, 'a.png') },
      { name: 'b', screenshot: path.join(evidenceDir, 'b.png') },
    ],
    { evidenceDir, baselinesDir },
  );
  assert.equal(out.findings.length, 1);
  assert.match(out.findings[0].title, /20x20 to 20x30/);
  assert.equal(out.findings[0].diff, null);
  assert.equal(out.results[1].status, 'skipped');
  assert.equal(out.warnings[0].code, 'diffFailed');
});

test('an oversized PNG is refused from its header, before decoding', () => {
  const { evidenceDir, baselinesDir } = screenWorld();
  const file = path.join(evidenceDir, 'bomb.png');
  writePng(file, 4, 4, red);
  // Claim 20000x20000 in IHDR: tiny on disk, ~1.6 GB if it were decoded.
  const buf = fs.readFileSync(file);
  buf.writeUInt32BE(20000, 16);
  buf.writeUInt32BE(20000, 20);
  fs.writeFileSync(file, buf);

  const out = P.compareScreens([{ name: 'bomb', screenshot: file }], { evidenceDir, baselinesDir });
  assert.equal(out.results[0].status, 'skipped');
  assert.match(out.warnings[0].detail, /too large/);
});

test('a screen name cannot climb out of the baselines folder', () => {
  const { evidenceDir, baselinesDir } = screenWorld();
  writePng(path.join(evidenceDir, 'home.png'), 4, 4, red);
  const out = P.compareScreens([{ name: '../../evil', screenshot: path.join(evidenceDir, 'home.png') }], {
    evidenceDir,
    baselinesDir,
  });
  assert.equal(out.results[0].name, 'evil');
  assert.ok(fs.existsSync(path.join(baselinesDir, 'evil.png')));
  assert.ok(!fs.existsSync(path.join(baselinesDir, '..', '..', 'evil.png')));
});

test('end to end: explore run validates screenshots and turns a changed screen into a finding', async () => {
  const adapter = await fakeAdapter();
  const baselines = P.baselinesDirFor(adapter.evidenceDir);
  assert.equal(path.basename(baselines), 'baselines');
  assert.equal(path.basename(path.dirname(baselines)), 'lunaswork-run1');
  writePng(path.join(baselines, 'home-desktop.png'), 20, 20, red);

  const fake = fakeClaude({
    onCall: (cwd) => {
      writePng(path.join(cwd, 'home-desktop.png'), 20, 20, () => [0, 0, 255]);
      writePng(path.join(cwd, 'f1.png'), 4, 4, red);
    },
    raw: {
      findings: [{ kind: 'bug', severity: 'high', title: 'Total is NaN', steps: ['Enter 10'], screenshot: 'f1.png', consoleErrors: ['TypeError'] }],
      scores: [
        { milestone: 'Core flows', criterion: 'Totals are correct', score: 2, evidence: ev('f1.png', ['Enter 10']) },
        { milestone: 'Core flows', criterion: 'A quote can be made', score: 10, evidence: ev('', []) },
      ],
      journeys: [{ name: 'Make a quote', passed: false, evidence: ev('f1.png') }],
      screens: [{ name: 'Home Desktop', screenshot: 'home-desktop.png' }],
    },
  });
  const res = await P.runPlaytest({ projectDir: fakeProject(), adapter, url: URL_, execImpl: fake.execImpl });

  assert.equal(res.ok, true);
  assert.equal(res.costUsd, 0.5);
  assert.deepEqual(res.report.scores.map((s) => s.criterion), ['Totals are correct']);
  assert.equal(res.report.findings.length, 2);
  assert.equal(res.report.findings[1].kind, 'feel');
  assert.match(res.report.findings[1].title, /home-desktop/);
  assert.equal(res.screenDiff.results[0].status, 'changed');
});

// ---- personas and browser matrix ------------------------------------------------------

const R = require('../src/lunasworkRules.js');

test('the prompt carries the personas and every browser x width of the pass', () => {
  const prompt = P.buildPlaytestPrompt({
    mode: 'explore',
    url: URL_,
    testPlan: TEST_PLAN,
    shipCriteria: SHIP,
    personas: R.personasFor(0, true),
    matrix: R.matrixFor(0, true),
    tools: {
      mcpConfig: {
        mcpServers: {
          playwright: { args: ['--browser', 'chromium'] },
          'playwright-webkit': { args: ['--browser', 'webkit'] },
        },
      },
    },
  });
  for (const p of R.PERSONAS) assert.ok(prompt.includes(p.prompt), p.id);
  assert.ok(prompt.includes('persona "a11y"'));
  assert.ok(prompt.includes('firefox at 820px'));
  assert.ok(prompt.includes('webkit at 390px (phone, browser_resize 390x844)'));
  assert.ok(prompt.includes('mcp__playwright-webkit__*'));
  assert.ok(prompt.includes('engineOnly'));
});

test('runPlaytest rotates one persona and one combo by the adapter iteration; the report lists them', async () => {
  const adapter = await fakeAdapter();
  const fake = fakeClaude({ raw: full() });
  const res = await P.runPlaytest({ projectDir: fakeProject(), adapter, url: URL_, execImpl: fake.execImpl });

  assert.equal(res.ok, true);
  const prompt = fake.calls[0].prompt;
  assert.ok(prompt.includes('Core journeys (persona "core")'));
  assert.ok(prompt.includes('Power user (persona "power")'), 'iteration 1 -> the second persona');
  assert.ok(!prompt.includes('persona "breakIt"'));
  assert.deepEqual(res.report.personas.map((p) => p.id), ['core', 'power']);
  assert.deepEqual(res.report.matrix.map((c) => `${c.engine}@${c.width}`), ['chromium@1440', 'chromium@820']);
});

test('the SHIP confirmation is the milestone gate: all personas, every engine x width', async () => {
  const adapter = await fakeAdapter();
  const fake = fakeClaude({ raw: full() });
  const res = await P.runPlaytest({ projectDir: fakeProject(), adapter, url: URL_, mode: 'shipConfirm', execImpl: fake.execImpl });

  assert.equal(res.ok, true);
  assert.equal(res.report.personas.length, 6);
  assert.equal(res.report.matrix.length, 9);
  const servers = JSON.parse(argAfter(fake.calls[0].args, '--mcp-config')).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['playwright', 'playwright-firefox', 'playwright-webkit']);
  // An explicit isGate wins over the mode default.
  const plain = P.passPlan({ mode: 'shipConfirm', isGate: false, iteration: 2 });
  assert.equal(plain.personas.length, 2);
  assert.equal(plain.matrix.length, 2);
  assert.deepEqual(P.passPlan({}).personas.map((p) => p.id), ['core', 'firstTime'], 'no iteration -> 0');
});

test('findings carry persona, engine and width; an engine-only bug says so in its title', () => {
  const { evidenceDir } = evidenceWorld();
  const finding = (over) => ({
    kind: 'bug', severity: 'high', title: 'Total is blank', steps: ['Open'], screenshot: 'f1.png', consoleErrors: [], ...over,
  });
  const raw = full({
    findings: [
      finding({ persona: 'power', engine: 'webkit', width: 390, engineOnly: true }),
      finding({ title: 'Firefox drops the cart', persona: 'core', engine: 'firefox', width: 820, engineOnly: true }),
      finding({ persona: 'breakIt', engine: 'opera', width: 777, engineOnly: true }),
    ],
  });
  const report = P.validateReport(raw, { evidenceDir, personas: R.personasFor(1, false), matrix: R.matrixFor(1, false) });
  const [a, b, c] = report.findings;
  assert.deepEqual([a.persona, a.engine, a.width, a.engineOnly], ['power', 'webkit', 390, true]);
  assert.equal(a.title, 'Total is blank [webkit only, 390px]');
  assert.equal(b.title, 'Firefox drops the cart', 'already names the engine');
  assert.deepEqual([c.persona, c.engine, c.width, c.engineOnly], [null, null, null, false], 'not run / unknown');
  assert.equal(c.title, 'Total is blank');
  assert.deepEqual(report.personas.map((p) => p.id), ['core', 'power']);
});

test('PLAYTEST_SCHEMA requires persona, engine and width on every finding', () => {
  const item = P.PLAYTEST_SCHEMA.properties.findings.items;
  for (const key of ['persona', 'engine', 'width', 'engineOnly']) assert.ok(item.required.includes(key), key);
  assert.deepEqual(item.properties.engine.enum, ['chromium', 'firefox', 'webkit']);
  assert.deepEqual(item.properties.width.enum, [390, 820, 1440]);
});

test('every browser server must be origin-locked - one open engine refuses the pass', async () => {
  const adapter = await fakeAdapter();
  const fake = fakeClaude({ raw: full() });
  const leaky = {
    ...adapter,
    tools: (opts) => {
      const t = adapter.tools(opts);
      t.mcpConfig.mcpServers['playwright-firefox'] = { type: 'stdio', command: 'npx', args: ['--browser', 'firefox'] };
      t.allowedTools.push('mcp__playwright-firefox__browser_navigate');
      return t;
    },
  };
  const res = await P.runPlaytest({ projectDir: fakeProject(), adapter: leaky, url: URL_, execImpl: fake.execImpl });
  assert.equal(res.error, 'badUrl');
  assert.equal(fake.calls.length, 0);
});
