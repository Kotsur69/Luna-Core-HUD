// ============================================================================
// Luna's Work milestone demo video (src/lunasworkDemo.js, B13 / LW 3.33).
// Covers: walkthrough props built from the playtest evidence in TEST_PLAN.md
// journey order (title card, one scene per journey, captions + steps,
// 30-90 s); the Remotion path read from the env / local setting and never
// guessed - unknown means no render and a pl + en note asking for it; the
// fixed render command; attach vs link by the size cap, end to end through
// the milestone email; a render failure (or a throwing renderer) never
// blocks the email or the run; and gmailsend carrying a binary attachment
// byte for byte. The renderer is a fake.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FPS,
  MIN_SECONDS,
  MAX_SECONDS,
  REMOTION_DIR_ENV,
  DEFAULT_COMPOSITION,
  NO_PATH_NOTE,
  buildDemoProps,
  remotionSetup,
  renderCommand,
  execRender,
  listDemoVideos,
  createDemoMaker,
} = require('../src/lunasworkDemo');
const { createLunasWorkReporter } = require('../src/lunasworkReport');
const { buildMime, MAX_BINARY_ATTACHMENT } = require('../src/gmailsend');

const RUN_ID = 'lwdemo1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const TEST_PLAN = '# Test plan\n\n## Journeys\n\n### Sign up\n\nsteps\n\n### Make a quote\n\nsteps\n\n### Export PDF\n\nsteps\n';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-demo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A runs folder with one iteration's evidence: a screenshot per journey, key screens, a recording. */
function makeEvidence(t) {
  const root = tmp(t);
  const runsDir = path.join(root, 'runs');
  const evidenceDir = path.join(runsDir, `lunaswork-${RUN_ID}`, 'iter-3');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const shot = (name) => {
    const file = path.join(evidenceDir, name);
    fs.writeFileSync(file, PNG);
    return file;
  };
  fs.writeFileSync(path.join(evidenceDir, 'page-1.webm'), 'webm');
  const journey = (name, file, passed = true) => ({ name, passed, evidence: { screenshot: shot(file), steps: [`open ${name}`, 'click go'] } });
  // The Playtester reported them out of TEST_PLAN order.
  const report = {
    journeys: [
      journey('Export PDF', 'j-export.png', false),
      journey('Sign up', 'j-signup.png'),
      { name: 'Ghost', passed: true, evidence: { screenshot: path.join(evidenceDir, 'missing.png'), steps: ['x'] } },
      journey('Make a quote', 'j-quote.png'),
    ],
    screens: [{ name: 'home-desktop', screenshot: shot('home-desktop.png') }, { name: 'home-mobile', screenshot: shot('home-mobile.png') }],
  };
  return { root, runsDir, evidenceDir, report };
}

function makeRun(e, extra = {}) {
  return { id: RUN_ID, repoPath: path.join(e.root, 'amsteel'), iteration: 4, milestone: 'polish', evidenceDir: e.evidenceDir, laps: [], history: [], ...extra };
}

const seconds = (props) => props.durationInFrames / props.fps;

test('props: title card, then one scene per journey in TEST_PLAN order, captions from the journey steps', (t) => {
  const e = makeEvidence(t);
  const built = buildDemoProps({ milestone: 'core flows', repoName: 'amsteel', iteration: 3, report: e.report, evidenceDir: e.evidenceDir, journeyOrder: ['Sign up', 'Make a quote', 'Export PDF'] });
  const { props, files } = built;
  assert.equal(props.title.text, 'Milestone reached: core flows');
  assert.equal(props.title.subtitle, 'amsteel - iteration 3');
  assert.deepEqual(props.scenes.map((s) => s.caption), ['Sign up', 'Make a quote', 'Export PDF']);
  assert.deepEqual(props.scenes.map((s) => s.image), ['scene-01.png', 'scene-02.png', 'scene-03.png']);
  assert.deepEqual(props.scenes[0].steps, ['open Sign up', 'click go']);
  assert.deepEqual(props.scenes.map((s) => s.passed), [true, true, false]);
  // Images are copied by our names, from the journey's own screenshot.
  assert.equal(files[0].from, path.join(e.evidenceDir, 'j-signup.png'));
  assert.equal(files[2].from, path.join(e.evidenceDir, 'j-export.png'));
  assert.deepEqual(props.recordings, ['recording-01.webm']);
  assert.ok(seconds(props) >= MIN_SECONDS && seconds(props) <= MAX_SECONDS, `${seconds(props)} s`);
  assert.equal(props.durationInFrames, props.title.frames + props.scenes.reduce((sum, s) => sum + s.frames, 0));
});

test('props: 30-90 s whatever the number of scenes; key screens when no journey has a screenshot; nothing -> null', (t) => {
  const e = makeEvidence(t);
  const one = buildDemoProps({ report: { journeys: [e.report.journeys[1]] } }).props;
  assert.ok(seconds(one) >= MIN_SECONDS, `${seconds(one)} s`);
  const many = Array.from({ length: 40 }, (_, i) => ({ ...e.report.journeys[1], name: `J${i}` }));
  const long = buildDemoProps({ report: { journeys: many } }).props;
  assert.ok(seconds(long) <= MAX_SECONDS, `${seconds(long)} s`);
  assert.equal(long.fps, FPS);
  const screensOnly = buildDemoProps({ milestone: 'm', report: { journeys: [], screens: e.report.screens } }).props;
  assert.deepEqual(screensOnly.scenes.map((s) => s.caption), ['home']);
  assert.equal(buildDemoProps({ report: { journeys: [], screens: [] } }), null);
  assert.equal(buildDemoProps({}), null);
});

test('the Remotion path comes from the env or the local setting, never guessed', (t) => {
  const root = tmp(t);
  const remotion = path.join(root, 'Remotion vids');
  fs.mkdirSync(remotion);
  assert.equal(remotionSetup({ env: {}, readLocal: () => null }), null);
  assert.equal(remotionSetup({ env: { [REMOTION_DIR_ENV]: remotion }, readLocal: () => null }), null, 'no package.json: not a project');
  fs.writeFileSync(path.join(remotion, 'package.json'), '{}');
  assert.deepEqual(remotionSetup({ env: { [REMOTION_DIR_ENV]: remotion }, readLocal: () => null }), { dir: remotion, composition: DEFAULT_COMPOSITION });
  assert.deepEqual(remotionSetup({ env: {}, readLocal: () => ({ remotionDir: remotion, composition: 'Walkthrough' }) }), { dir: remotion, composition: 'Walkthrough' });
  assert.equal(remotionSetup({ env: {}, readLocal: () => ({ remotionDir: remotion, composition: 'x; rm -rf' }) }).composition, DEFAULT_COMPOSITION);
  assert.equal(remotionSetup({ env: { [REMOTION_DIR_ENV]: 'relative/path' }, readLocal: () => null }), null);
});

test('the fixed render command: the setup CLI under node, props in, mp4 out', () => {
  const setup = { dir: path.resolve('/r/vids'), composition: 'LunaWorkDemo' };
  const cmd = renderCommand({ setup, propsFile: '/w/props.json', outFile: '/w/demo-x.mp4', publicDir: '/w/public', nodePath: '/bin/node', cli: () => '/r/vids/cli.js' });
  assert.deepEqual(cmd, {
    command: '/bin/node',
    args: ['/r/vids/cli.js', 'render', 'LunaWorkDemo', '/w/demo-x.mp4', '--props=/w/props.json', '--public-dir=/w/public'],
    cwd: setup.dir,
  });
  assert.equal(renderCommand({ setup, propsFile: 'p', outFile: 'o', publicDir: 'd', cli: () => null }), null);
});

/** A demo maker over a fake Remotion setup and a fake renderer writing `bytes` bytes. */
function makeMaker(e, { bytes = 1000, attachMaxBytes, render, remotion = true } = {}) {
  const renders = [];
  const maker = createDemoMaker({
    runsDir: () => e.runsDir,
    env: () => ({}),
    readLocal: () => (remotion ? { remotionDir: e.root } : null),
    cli: () => path.join(e.root, 'remotion-cli.js'),
    readTestPlan: () => TEST_PLAN,
    attachMaxBytes,
    log: () => {},
    render:
      render ||
      (async (cmd) => {
        renders.push(cmd);
        fs.writeFileSync(cmd.args[3], Buffer.alloc(bytes, 7));
        return { ok: true };
      }),
  });
  fs.writeFileSync(path.join(e.root, 'package.json'), '{}');
  return { maker, renders };
}

test('make: props.json + images under runs/lunaswork-<id>/demo-<slug>/, render, small video attached', async (t) => {
  const e = makeEvidence(t);
  const { maker, renders } = makeMaker(e, { bytes: 1000 });
  const res = await maker.make(makeRun(e), { milestone: 'Core flows!', report: e.report, evidenceDir: e.evidenceDir, iteration: 3 });
  assert.equal(res.ok, true);
  const work = path.join(e.runsDir, `lunaswork-${RUN_ID}`, 'demo-core-flows');
  const props = JSON.parse(fs.readFileSync(path.join(work, 'props.json'), 'utf8'));
  assert.deepEqual(props.scenes.map((s) => s.caption), ['Sign up', 'Make a quote', 'Export PDF']);
  assert.deepEqual(fs.readFileSync(path.join(work, 'public', 'scene-01.png')), PNG);
  assert.equal(renders.length, 1);
  assert.deepEqual(renders[0].args.slice(1), ['render', DEFAULT_COMPOSITION, res.file, `--props=${path.join(work, 'props.json')}`, `--public-dir=${path.join(work, 'public')}`]);
  assert.equal(res.file, path.join(e.runsDir, `lunaswork-${RUN_ID}`, 'demo-core-flows.mp4'));
  assert.equal(res.attach.mimeType, 'video/mp4');
  assert.equal(res.attach.content.length, 1000);
  assert.equal(res.link, undefined);
  assert.deepEqual(listDemoVideos(e.runsDir, RUN_ID), [res.file]);
});

test('make: a video over the size cap is not attached but linked from the run folder', async (t) => {
  const e = makeEvidence(t);
  const { maker } = makeMaker(e, { bytes: 5000, attachMaxBytes: 4096 });
  const res = await maker.make(makeRun(e), { milestone: 'polish', report: e.report });
  assert.equal(res.ok, true);
  assert.equal(res.attach, undefined);
  assert.equal(res.link, path.join(e.runsDir, `lunaswork-${RUN_ID}`, 'demo-polish.mp4'));
  assert.equal(res.bytes, 5000);
});

test('make: no Remotion path -> no render, a pl + en note asking Mati for it, the props still written', async (t) => {
  const e = makeEvidence(t);
  const { maker, renders } = makeMaker(e, { remotion: false });
  const res = await maker.make(makeRun(e), { milestone: 'polish', report: e.report });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'no-remotion');
  assert.deepEqual(res.note, NO_PATH_NOTE);
  assert.match(res.note.en, /Remotion vids/);
  assert.match(res.note.pl, /Remotion vids/);
  assert.equal(renders.length, 0);
  assert.ok(fs.existsSync(res.propsFile));
});

test('make: a render failure or a throwing renderer is tolerated, never rejects', async (t) => {
  const e = makeEvidence(t);
  const failed = await makeMaker(e, { render: async () => ({ ok: false, error: 'failed', detail: 'composition not found' }) }).maker.make(makeRun(e), { milestone: 'a', report: e.report });
  assert.deepEqual([failed.ok, failed.error], [false, 'failed']);
  const thrown = await makeMaker(e, { render: async () => { throw new Error('remotion crashed'); } }).maker.make(makeRun(e), { milestone: 'b', report: e.report });
  assert.deepEqual([thrown.ok, thrown.error], [false, 'failed']);
  const silent = await makeMaker(e, { render: async () => ({ ok: true }) }).maker.make(makeRun(e), { milestone: 'c', report: e.report });
  assert.deepEqual([silent.ok, silent.error], [false, 'noVideo']);
  assert.deepEqual(await makeMaker(e).maker.make({ id: '../evil' }, {}), { ok: false, skipped: 'bad-run' });
  assert.equal((await makeMaker(e).maker.make(makeRun(e, { evidenceDir: null }), { milestone: 'd', report: { journeys: [] } })).skipped, 'no-evidence');
});

/** failWithAttachment: the error a send with an attachment throws (gmailsend's GmailError shape). */
function fakeMail({ failWithAttachment = null } = {}) {
  const sends = [];
  const tries = [];
  return {
    sends,
    tries,
    deps: {
      sender: {
        status: () => ({ connected: true }),
        send: async (msg) => {
          tries.push(msg);
          if (failWithAttachment && msg.attachments) throw Object.assign(new Error(failWithAttachment.message), { reason: failWithAttachment.reason });
          sends.push(msg);
        },
      },
      prefs: { loadPrefs: () => ({ godmodeEmail: true }), loadState: () => ({ godmode: {} }), updateState: () => {} },
      enabled: () => true,
    },
  };
}

test('milestone email: a small demo is attached, a big one linked by its place under runs/', async (t) => {
  const e = makeEvidence(t);
  const small = fakeMail();
  const ctx = { milestone: 'core flows', report: e.report, evidenceDir: e.evidenceDir, iteration: 3 };
  const r1 = createLunasWorkReporter({ runsDir: () => e.runsDir, mail: small.deps, demo: makeMaker(e, { bytes: 900 }).maker });
  const res = await r1.onMilestone(makeRun(e), ctx);
  assert.equal(res.sent, true);
  assert.equal(small.sends[0].attachments.length, 1);
  assert.equal(small.sends[0].attachments[0].mimeType, 'video/mp4');
  assert.ok(Buffer.isBuffer(small.sends[0].attachments[0].content));
  assert.match(small.sends[0].text, /DEMO VIDEO\n- Attached: lunaswork-lwdemo1-demo-core-flows\.mp4/);

  const big = fakeMail();
  const r2 = createLunasWorkReporter({ runsDir: () => e.runsDir, mail: big.deps, demo: makeMaker(e, { bytes: 5000, attachMaxBytes: 1024 }).maker });
  await r2.onMilestone(makeRun(e), ctx);
  assert.equal(big.sends[0].attachments, undefined);
  assert.match(big.sends[0].text, /Too big to attach - saved as runs\/lunaswork-lwdemo1\/demo-core-flows\.mp4/);
  // The email names the place under runs/, never the full path on this PC.
  assert.ok(!big.sends[0].text.includes(e.root));
  // A replayed hook neither renders nor sends again.
  assert.equal((await r2.onMilestone(makeRun(e), ctx)).skipped, 'duplicate');
  assert.equal(big.sends.length, 1);
});

test('milestone email: a failed render, a missing path or a refused attachment never stop the email', async (t) => {
  const e = makeEvidence(t);
  const ctx = { milestone: 'core flows', report: e.report };
  const failing = fakeMail();
  const r1 = createLunasWorkReporter({
    runsDir: () => e.runsDir,
    mail: failing.deps,
    log: () => {},
    demo: makeMaker(e, { render: async () => { throw new Error('boom'); } }).maker,
  });
  assert.equal((await r1.onMilestone(makeRun(e), ctx)).sent, true);
  assert.match(failing.sends[0].text, /DEMO VIDEO\n- Not rendered \(failed\) - the run goes on\./);

  const noPath = fakeMail();
  await createLunasWorkReporter({ runsDir: () => e.runsDir, mail: noPath.deps, demo: makeMaker(e, { remotion: false }).maker }).onMilestone(makeRun(e), ctx);
  assert.match(noPath.sends[0].text, /Demo video not rendered: LunaCore does not know where your 'Remotion vids' setup is/);
  assert.match(noPath.sends[0].text, /PL: Film demo nie zostal wyrenderowany/);

  // Gmail turned the big message down: it goes once more, without the video.
  const refused = fakeMail({ failWithAttachment: { reason: 'gmail-failed', message: 'HTTP 413' } });
  const res = await createLunasWorkReporter({ runsDir: () => e.runsDir, mail: refused.deps, log: () => {}, demo: makeMaker(e).maker }).onMilestone(makeRun(e), ctx);
  assert.equal(res.sent, true);
  assert.equal(refused.sends[0].attachments, undefined);
  assert.match(refused.sends[0].text, /The demo video could not be attached/);

  // A network error may have delivered it: no resend, so never a duplicate email.
  const lost = fakeMail({ failWithAttachment: { reason: 'gmail-network', message: 'socket hang up' } });
  const res2 = await createLunasWorkReporter({ runsDir: () => e.runsDir, mail: lost.deps, log: () => {}, demo: makeMaker(e).maker }).onMilestone(makeRun(e), ctx);
  assert.deepEqual([res2.sent, res2.error], [false, 'gmail-network']);
  assert.equal(lost.tries.length, 1);

  const crashing = { make: async () => { throw new Error('maker blew up'); }, videos: () => [] };
  const r4 = createLunasWorkReporter({ runsDir: () => e.runsDir, mail: fakeMail().deps, log: () => {}, demo: crashing });
  assert.equal((await r4.onMilestone(makeRun(e), ctx)).sent, true);
});

test('the return pack lists every demo of the run and asks for the Remotion path when it is unknown', async (t) => {
  const e = makeEvidence(t);
  const { maker } = makeMaker(e, { bytes: 10 });
  await maker.make(makeRun(e), { milestone: 'skeleton', report: e.report });
  const noPath = makeMaker(e, { remotion: false }).maker;
  const reporter = createLunasWorkReporter({ runsDir: () => e.runsDir, readFile: () => null, demo: noPath });
  const res = await reporter.onRunEnd(makeRun(e, { verdict: 'ship', current: { report: e.report } }));
  const md = fs.readFileSync(res.file, 'utf8');
  assert.match(md, /## Needs you\n\n- Demo video not rendered: LunaCore does not know where your 'Remotion vids' setup is/);
  assert.match(md, /## Demo videos\n\n- .*demo-skeleton\.mp4/);
});

test('execRender: a timeout kills the whole render tree; a failure keeps the last stderr line', async () => {
  const killed = [];
  let finish;
  const hung = (_cmd, _args, _opts, cb) => {
    finish = cb;
    return { pid: 4242 };
  };
  const res = await execRender({ command: 'node', args: [], cwd: '.' }, {
    timeoutMs: 5,
    execImpl: hung,
    killTreeImpl: async (pid) => {
      killed.push(pid);
      finish(Object.assign(new Error('killed'), { killed: true }));
    },
  });
  assert.deepEqual(res, { ok: false, error: 'timeout' });
  assert.deepEqual(killed, [4242]);

  const failing = (_cmd, _args, _opts, cb) => {
    setImmediate(() => cb(new Error('exit 1'), '', 'Bundling...\nError: No composition with the ID LunaWorkDemo found\n'));
    return { pid: 1 };
  };
  const failed = await execRender({ command: 'node', args: [], cwd: '.' }, { execImpl: failing, killTreeImpl: async () => assert.fail('no kill') });
  assert.deepEqual(failed, { ok: false, error: 'failed', detail: 'Error: No composition with the ID LunaWorkDemo found' });

  const chatty = (_cmd, _args, _opts, cb) => {
    setImmediate(() => cb(Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true })));
    return { pid: 2 };
  };
  assert.deepEqual(await execRender({ command: 'node', args: [], cwd: '.' }, { execImpl: chatty }), { ok: false, error: 'failed', detail: 'render output too long' });
});

test('gmailsend: a Buffer attachment goes out byte for byte; one over the cap is left out whole', () => {
  const video = Buffer.from([0, 1, 2, 250, 251, 255]);
  const mime = buildMime({ address: 'me@example.com', subject: 's', text: 'b', boundary: 'B', attachments: [{ filename: 'demo.mp4', mimeType: 'video/mp4', content: video }] });
  assert.match(mime, /Content-Type: video\/mp4; name="demo.mp4"/);
  const part = mime.split('--B').find((p) => p.includes('demo.mp4'));
  const body = part.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.deepEqual(Buffer.from(body, 'base64'), video);
  const tooBig = buildMime({ address: 'me@example.com', subject: 's', text: 'b', boundary: 'B', attachments: [{ filename: 'big.mp4', mimeType: 'video/mp4', content: Buffer.alloc(MAX_BINARY_ATTACHMENT + 1) }] });
  assert.doesNotMatch(tooBig, /big\.mp4/);
});
