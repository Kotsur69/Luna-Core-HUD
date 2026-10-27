// ============================================================================
// Luna's Work launch assets at SHIP (src/lunasworkLaunch.js, C10 / LW 3.31b).
// Covers: the marketing agent runs only for a SHIP run (directly and through
// the reporter's onRunEnd, every end verdict), over a fixed command line with
// the pack + screenshots on stdin; its answer lands in the project's
// marketing/ folder (landing, pitch, store listing for an app, Polish
// versions for a bilingual project, curated screenshots in the agent's
// order); model text never picks a file name; a failed agent writes nothing;
// and the return pack (report + email) links the files. The agent is a fake.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LAUNCH_AGENT,
  isBilingual,
  isApp,
  candidateScreens,
  buildLaunchArgs,
  validateLaunch,
  runLaunchAssets,
} = require('../src/lunasworkLaunch');
const { createLunasWorkReporter, FINAL_VERDICTS } = require('../src/lunasworkReport');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const BRIEF_APP_PL = '# Brief\n\nA desktop app (Electron) for steel quotes. UI in pl/en.\n';
const BRIEF_WEB_EN = '# Brief\n\nA small web page for a bakery.\n';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-launch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A project repo with a design pack and an iteration's evidence folder with key screens. */
function makeProject(t, brief) {
  const root = tmp(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'design'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'design', 'BRIEF.md'), brief);
  fs.writeFileSync(path.join(repo, 'design', 'DESIGN.md'), '# Design\n\nCalm, blue, big numbers.\n');
  const evidenceDir = path.join(root, 'runs', 'lunaswork-lwship1', 'iter-4');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const shot = (name) => {
    const file = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(file, PNG);
    return file;
  };
  const screens = ['home-desktop', 'home-mobile', 'quote-desktop', 'quote-mobile'].map((name) => ({ name, screenshot: shot(name) }));
  shot('diff-home-desktop');
  return { root, repo, evidenceDir, screens };
}

function shipRun(p, extra = {}) {
  return {
    id: 'lwship1',
    repoPath: p.repo,
    verdict: 'ship',
    iteration: 4,
    milestone: 'polish',
    evidenceDir: p.evidenceDir,
    current: { report: { journeys: [], screens: p.screens } },
    history: [],
    laps: [],
    log: [],
    ...extra,
  };
}

const COPY = {
  landing: {
    headline: 'Steel quotes in a minute',
    subheadline: 'Price a job before the call ends.',
    sections: [{ heading: 'Real prices', body: 'Daily steel prices.\n\nNo spreadsheet.' }, { heading: '', body: 'dropped: no heading' }],
    cta: 'Get a quote',
  },
  pitch: { sentence: 'Quotes for steel jobs, fast.', paragraph: 'A desktop app that prices steel jobs. It keeps the numbers right.' },
  store: { title: 'SteelQuote', short: 'Fast steel quotes', long: 'Long text about quotes.', keywords: ['steel', 'quote', 'steel'] },
};
const ANSWER = {
  ...COPY,
  screens: ['quote-desktop', '../../evil', 'home-mobile', 'quote-desktop'],
  pl: {
    landing: { headline: 'Wyceny stali w minute', subheadline: 'Wycena przed koncem rozmowy.', sections: [{ heading: 'Prawdziwe ceny', body: 'Ceny z dzis.' }], cta: 'Wycen' },
    pitch: { sentence: 'Szybkie wyceny stali.', paragraph: 'Aplikacja do wycen stali.' },
    store: { title: 'StalWycena', short: 'Szybkie wyceny', long: 'Dlugi opis.', keywords: ['stal'] },
  },
};

/** A fake `claude` runner: records each call, answers like `claude -p --output-format json`. */
function fakeAgent(answer = ANSWER) {
  const calls = [];
  const runClaude = async (call) => {
    calls.push(call);
    if (answer instanceof Error) return { error: 'failed', detail: answer.message };
    return { stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: answer, total_cost_usd: 0.42 }) };
  };
  return { calls, runClaude };
}

const read = (repo, rel) => fs.readFileSync(path.join(repo, rel), 'utf8');

test('isBilingual / isApp read the brief and design', () => {
  assert.equal(isBilingual(BRIEF_APP_PL), true);
  assert.equal(isBilingual('Interface po polsku i angielsku'), true);
  assert.equal(isBilingual(BRIEF_WEB_EN), false);
  assert.equal(isApp(BRIEF_APP_PL), true);
  assert.equal(isApp('An Android app for runners'), true);
  assert.equal(isApp(BRIEF_WEB_EN), false);
});

test('the agent is invoked only at SHIP: every other verdict is skipped, no call', async (t) => {
  const p = makeProject(t, BRIEF_APP_PL);
  for (const verdict of ['plateau', 'red', 'stop', null]) {
    const agent = fakeAgent();
    const res = await runLaunchAssets({ run: shipRun(p, { verdict }), runClaude: agent.runClaude, log: () => {} });
    assert.equal(res.skipped, 'not-ship', String(verdict));
    assert.equal(agent.calls.length, 0);
  }
  assert.equal(fs.existsSync(path.join(p.repo, 'marketing')), false);
});

test('a fixed command line: the agent, schema and tools are constants; the pack and screens go on stdin', async (t) => {
  const p = makeProject(t, BRIEF_APP_PL);
  const agent = fakeAgent();
  const res = await runLaunchAssets({ run: shipRun(p), runClaude: agent.runClaude, log: () => {} });
  assert.equal(res.ok, true);
  assert.equal(agent.calls.length, 1);
  const call = agent.calls[0];
  assert.deepEqual(call.args, buildLaunchArgs({ addDirs: [p.evidenceDir] }));
  assert.equal(call.args[call.args.indexOf('--agent') + 1], LAUNCH_AGENT);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Glob');
  assert.ok(call.args.includes('-p') && call.args.includes('--no-session-persistence'));
  // Nothing from the pack reaches argv; it is all in the prompt.
  assert.ok(!call.args.some((a) => a.includes('steel quotes')));
  assert.equal(call.cwd, p.repo);
  assert.match(call.prompt, /A desktop app \(Electron\) for steel quotes/);
  assert.match(call.prompt, /Calm, blue, big numbers/);
  assert.match(call.prompt, /home-mobile: .*home-mobile\.png/);
  assert.match(call.prompt, /- store: a store listing/);
  assert.match(call.prompt, /- pl: the same landing and pitch and store in Polish/);
});

test('SHIP writes marketing/: landing, pitch, store listing, Polish versions, curated screenshots', async (t) => {
  const p = makeProject(t, BRIEF_APP_PL);
  const res = await runLaunchAssets({ run: shipRun(p), runClaude: fakeAgent().runClaude, log: () => {} });
  assert.equal(res.ok, true);
  assert.equal(res.dir, path.join(p.repo, 'marketing'));
  assert.deepEqual(res.files, [
    'marketing/LANDING.md',
    'marketing/PITCH.md',
    'marketing/STORE_LISTING.md',
    'marketing/LANDING.pl.md',
    'marketing/PITCH.pl.md',
    'marketing/STORE_LISTING.pl.md',
    'marketing/screenshots/01-quote-desktop.png',
    'marketing/screenshots/02-home-mobile.png',
  ]);
  const landing = read(p.repo, 'marketing/LANDING.md');
  assert.match(landing, /^# Landing page/);
  assert.match(landing, /## Steel quotes in a minute/);
  assert.match(landing, /### Real prices\n\nDaily steel prices\.\n\nNo spreadsheet\./);
  assert.doesNotMatch(landing, /dropped: no heading/);
  assert.match(landing, /\*\*Call to action:\*\* Get a quote/);
  const pitch = read(p.repo, 'marketing/PITCH.md');
  assert.match(pitch, /## One sentence\n\nQuotes for steel jobs, fast\./);
  assert.match(pitch, /## One paragraph\n\nA desktop app that prices steel jobs/);
  const store = read(p.repo, 'marketing/STORE_LISTING.md');
  assert.match(store, /## Title\n\nSteelQuote/);
  assert.match(store, /## Short description\n\nFast steel quotes/);
  assert.match(store, /## Keywords\n\nsteel, quote\n/);
  assert.match(read(p.repo, 'marketing/LANDING.pl.md'), /^# Strona glowna[\s\S]*## Wyceny stali w minute/);
  assert.match(read(p.repo, 'marketing/STORE_LISTING.pl.md'), /StalWycena/);
  assert.deepEqual(fs.readFileSync(path.join(p.repo, 'marketing/screenshots/01-quote-desktop.png')), PNG);
  // The model's "../../evil" picked no file anywhere.
  assert.equal(fs.existsSync(path.join(p.root, 'evil.png')), false);
});

test('a web page in English only: no store listing, no Polish files, even if the agent sends them', async (t) => {
  const p = makeProject(t, BRIEF_WEB_EN);
  const agent = fakeAgent();
  const res = await runLaunchAssets({ run: shipRun(p), runClaude: agent.runClaude, log: () => {} });
  assert.equal(res.ok, true);
  assert.equal(res.app, false);
  assert.equal(res.bilingual, false);
  assert.ok(!res.files.some((f) => /STORE_LISTING|\.pl\.md$/.test(f)), res.files.join(', '));
  assert.match(agent.calls[0].prompt, /- store: leave it out/);
  assert.match(agent.calls[0].prompt, /- pl: leave it out/);
});

test('no screens picked: the offered key screens are kept; the diff images are never offered', async (t) => {
  const p = makeProject(t, BRIEF_WEB_EN);
  // No report in the snapshot: the evidence folder is scanned instead.
  const run = shipRun(p, { current: {} });
  assert.deepEqual(candidateScreens(run).map((s) => s.name), ['home-desktop', 'home-mobile', 'quote-desktop', 'quote-mobile']);
  const res = await runLaunchAssets({ run, runClaude: fakeAgent({ ...COPY, screens: [] }).runClaude, log: () => {} });
  assert.deepEqual(res.files.filter((f) => f.includes('screenshots/')), [
    'marketing/screenshots/01-home-desktop.png',
    'marketing/screenshots/02-home-mobile.png',
    'marketing/screenshots/03-quote-desktop.png',
    'marketing/screenshots/04-quote-mobile.png',
  ]);
});

test('a new SHIP replaces the old curated screenshots and keeps hand-made files', async (t) => {
  const p = makeProject(t, BRIEF_WEB_EN);
  const shots = path.join(p.repo, 'marketing', 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, '09-old-desktop.png'), PNG);
  fs.writeFileSync(path.join(shots, 'my-banner.png'), PNG);
  const res = await runLaunchAssets({ run: shipRun(p), runClaude: fakeAgent().runClaude, log: () => {} });
  assert.equal(res.ok, true);
  assert.deepEqual(fs.readdirSync(shots).sort(), ['01-quote-desktop.png', '02-home-mobile.png', 'my-banner.png']);
});

test('a linked marketing/ folder is refused: nothing is written through it', async (t) => {
  const p = makeProject(t, BRIEF_WEB_EN);
  const elsewhere = path.join(p.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(p.repo, 'marketing'), 'junction');
  const res = await runLaunchAssets({ run: shipRun(p), runClaude: fakeAgent().runClaude, log: () => {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'crashed');
  assert.match(res.detail, /marketing is a link/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('validateLaunch: text is capped and one-lined, a store listing only for an app', () => {
  const long = 'x'.repeat(5000);
  const v = validateLaunch(
    { ...COPY, landing: { ...COPY.landing, headline: `a\nb${long}` }, screens: ['home-desktop'] },
    { app: false, bilingual: false, screenNames: ['home-desktop'] },
  );
  assert.equal(v.ok, true);
  assert.equal(v.copy.store, null);
  assert.equal(v.pl, null);
  assert.ok(v.copy.landing.headline.length <= 120);
  assert.doesNotMatch(v.copy.landing.headline, /\n/);
  assert.deepEqual(v.screens, ['home-desktop']);
  assert.equal(validateLaunch({ landing: { headline: 'x', sections: [] }, pitch: COPY.pitch }).ok, false);
  assert.equal(validateLaunch(null).ok, false);
});

test('a failed or malformed agent answer writes nothing', async (t) => {
  const p = makeProject(t, BRIEF_APP_PL);
  const failed = await runLaunchAssets({ run: shipRun(p), runClaude: fakeAgent(new Error('boom')).runClaude, log: () => {} });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'failed');
  const bad = await runLaunchAssets({ run: shipRun(p), runClaude: fakeAgent({ nonsense: true }).runClaude, log: () => {} });
  assert.equal(bad.error, 'badAssets');
  const noRepo = await runLaunchAssets({ run: shipRun(p, { repoPath: path.join(p.root, 'gone') }), runClaude: fakeAgent().runClaude, log: () => {} });
  assert.equal(noRepo.error, 'noRepo');
  assert.equal(fs.existsSync(path.join(p.repo, 'marketing')), false);
});

function fakeMail() {
  const sends = [];
  return {
    sends,
    deps: {
      sender: { status: () => ({ connected: true }), send: async (msg) => sends.push(msg) },
      prefs: { loadPrefs: () => ({ godmodeEmail: true }), loadState: () => ({ godmode: {} }), updateState: () => {} },
      enabled: () => true,
    },
  };
}

test('the return pack: onRunEnd runs the agent at SHIP only and links the assets in the report and email', async (t) => {
  const p = makeProject(t, BRIEF_APP_PL);
  const runsDir = path.join(p.root, 'runs');
  const agent = fakeAgent();
  const launched = [];
  const mail = fakeMail();
  const reporter = createLunasWorkReporter({
    runsDir: () => runsDir,
    mail: mail.deps,
    readFile: () => null,
    launch: (run) => {
      launched.push(run.verdict);
      return runLaunchAssets({ run, runClaude: agent.runClaude, log: () => {} });
    },
  });
  for (const verdict of FINAL_VERDICTS) {
    const res = await reporter.onRunEnd(shipRun(p, { id: `lw${verdict}`, verdict }));
    assert.equal(res.ok, true, verdict);
  }
  assert.deepEqual(launched, ['ship']);
  assert.equal(agent.calls.length, 1);

  const md = fs.readFileSync(path.join(runsDir, 'lunaswork-lwship.md'), 'utf8');
  assert.match(md, /## Launch assets\n\nIn the project's marketing\/ folder, not committed - review, then commit\.\n\n- marketing\/LANDING\.md\n/);
  assert.match(md, /- marketing\/STORE_LISTING\.pl\.md/);
  assert.match(md, /- marketing\/screenshots\/01-quote-desktop\.png/);
  assert.match(fs.readFileSync(path.join(runsDir, 'lunaswork-lwship.html'), 'utf8'), /<h2>Launch assets<\/h2>[\s\S]*marketing\/PITCH\.md/);
  for (const verdict of ['plateau', 'red', 'stop']) {
    assert.doesNotMatch(fs.readFileSync(path.join(runsDir, `lunaswork-lw${verdict}.md`), 'utf8'), /Launch assets/, verdict);
  }
  const shipMail = mail.sends.find((m) => / - SHIP/.test(m.subject));
  assert.match(shipMail.text, /## Launch assets[\s\S]*- marketing\/LANDING\.md/);
});

test('a failed agent is a line in the pack, never a lost report', async (t) => {
  const p = makeProject(t, BRIEF_APP_PL);
  const runsDir = path.join(p.root, 'runs');
  const reporter = createLunasWorkReporter({
    runsDir: () => runsDir,
    readFile: () => null,
    launch: async () => {
      throw new Error('agent exploded');
    },
    log: () => {},
  });
  const res = await reporter.onRunEnd(shipRun(p));
  assert.equal(res.ok, true);
  assert.match(fs.readFileSync(res.file, 'utf8'), /## Launch assets\n\nThe marketing agent wrote nothing: crashed\./);
});
