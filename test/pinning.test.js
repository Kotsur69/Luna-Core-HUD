// Testy przypinania transcriptu do sesji (TranscriptWatcher).
//
// Unlike observer.test.js these DO touch the filesystem: the whole point is
// which file a watcher selects, and that cannot be faked with strings. Each test
// works inside a throwaway directory under ~/.claude/projects and removes it
// afterwards; no real transcript is ever opened.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const { TranscriptWatcher, encodeProjectDir } = require('../src/observer');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Creates an isolated scope dir plus the cwd that maps onto it. */
function makeScope() {
  const cwd = path.join(os.tmpdir(), `lunacore-pin-${randomUUID()}`);
  const dir = path.join(PROJECTS_DIR, encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return {
    cwd,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Writes a minimal but realistically shaped transcript. */
function writeTranscript(dir, uuid, model = 'claude-opus-5', inputTokens = 1000) {
  const entry = {
    sessionId: uuid,
    message: { model, usage: { input_tokens: inputTokens } },
  };
  fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), `${JSON.stringify(entry)}\n`);
}

const newWatcher = (cwd, sessionUuid) => {
  const w = new TranscriptWatcher(() => {}, { cwd, sessionUuid });
  w.snapshotBaseline(); // what start() does, minus the timer
  return w;
};

test('pinning: a watcher with a session id waits for its OWN file', () => {
  const scope = makeScope();
  const mine = randomUUID();
  const w = newWatcher(scope.cwd, mine);
  try {
    // Somebody else's session is already there and is the newest file present.
    writeTranscript(scope.dir, randomUUID());
    assert.equal(w.pickFile(), null, 'must not adopt a foreign transcript');

    writeTranscript(scope.dir, mine);
    assert.equal(w.pickFile(), path.join(scope.dir, `${mine}.jsonl`));
  } finally {
    w.stop();
    scope.cleanup();
  }
});

test('pinning: two sessions in one folder do not swap, whatever the tick order', () => {
  // The bug this fixes: both watchers poll on independent timers, so whichever
  // ticked first claimed any newly appeared file - even one created by the other
  // tab's PTY. An Opus tab then showed Sonnet's numbers and vice versa. Here the
  // ticks are deliberately interleaved in the adversarial order: A ticks first,
  // but only B's transcript exists yet.
  const scope = makeScope();
  const uuidA = randomUUID();
  const uuidB = randomUUID();
  const a = newWatcher(scope.cwd, uuidA);
  const b = newWatcher(scope.cwd, uuidB);
  try {
    writeTranscript(scope.dir, uuidB, 'claude-sonnet-5');

    assert.equal(a.pickFile(), null, 'A must not claim B just because A ticked first');
    assert.equal(b.pickFile(), path.join(scope.dir, `${uuidB}.jsonl`));

    writeTranscript(scope.dir, uuidA, 'claude-opus-5');
    assert.equal(a.pickFile(), path.join(scope.dir, `${uuidA}.jsonl`));

    // And the pin holds: B keeps its own file after A joins.
    assert.equal(b.pickFile(), path.join(scope.dir, `${uuidB}.jsonl`));
  } finally {
    a.stop();
    b.stop();
    scope.cleanup();
  }
});

test('pinning: a pinned watcher never re-picks, even if a newer file appears', () => {
  const scope = makeScope();
  const mine = randomUUID();
  const w = newWatcher(scope.cwd, mine);
  try {
    writeTranscript(scope.dir, mine);
    const first = w.pickFile();

    writeTranscript(scope.dir, randomUUID()); // a newer neighbour shows up
    assert.equal(w.pickFile(), first, 'pin must survive a fresher neighbour');
  } finally {
    w.stop();
    scope.cleanup();
  }
});

test('pinning: stop() releases the claim so a restart can retake the file', () => {
  const scope = makeScope();
  const mine = randomUUID();
  try {
    writeTranscript(scope.dir, mine);

    const first = newWatcher(scope.cwd, mine);
    const file = first.pickFile();
    first.stop();

    const second = newWatcher(scope.cwd, mine);
    assert.equal(second.pickFile(), file, 'a respawned tab must get its file back');
    second.stop();
  } finally {
    scope.cleanup();
  }
});

test('pinning: without a session id the old heuristic still selects a file', () => {
  // Bare-shell profiles cannot be pinned - the fallback must keep working.
  const scope = makeScope();
  const w = newWatcher(scope.cwd, null);
  try {
    assert.equal(w.pickFile(), null, 'nothing created since start yet');

    writeTranscript(scope.dir, randomUUID());
    assert.ok(String(w.pickFile()).endsWith('.jsonl'), 'should adopt the new transcript');
  } finally {
    w.stop();
    scope.cleanup();
  }
});
