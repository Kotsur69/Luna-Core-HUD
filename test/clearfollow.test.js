// Tests for following a tab's CLI across /clear (TranscriptWatcher).
//
// /clear keeps the same `claude` process but moves it to a NEW session id, so
// the transcript the watcher was pinned to goes silent and a new
// <new-id>.jsonl takes over. The CLI records its current id in
// ~/.claude/sessions/<pid>.json (verified live on claude 2.1.289: the file is
// rewritten in place, same pid, new sessionId). These tests fake that file in
// a throwaway sessions dir; transcripts live in a throwaway project scope.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const { TranscriptWatcher, encodeProjectDir } = require('../src/observer');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function makeScope() {
  const cwd = path.join(os.tmpdir(), `lunacore-clear-${randomUUID()}`);
  const dir = path.join(PROJECTS_DIR, encodeProjectDir(cwd));
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunacore-sessions-'));
  fs.mkdirSync(dir, { recursive: true });
  return {
    cwd,
    dir,
    sessionsDir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    },
  };
}

function writeTranscript(dir, uuid, inputTokens = 1000) {
  const entry = { sessionId: uuid, message: { model: 'claude-opus-5', usage: { input_tokens: inputTokens } } };
  fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), `${JSON.stringify(entry)}\n`);
}

/** Writes the CLI's per-process state file, as claude does at start and on /clear. */
function writeCliState(sessionsDir, pid, sessionId, cwd, procStart = '111') {
  fs.writeFileSync(
    path.join(sessionsDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, procStart, kind: 'interactive' }),
  );
}

function newWatcher(scope, sessionUuid, onMetrics = () => {}) {
  const w = new TranscriptWatcher(onMetrics, { cwd: scope.cwd, sessionUuid, sessionsDir: scope.sessionsDir });
  w.snapshotBaseline();
  return w;
}

test('clear: the watcher re-pins to the transcript of the id /clear switched to', () => {
  const scope = makeScope();
  const launched = randomUUID();
  const afterClear = randomUUID();
  const w = newWatcher(scope, launched);
  try {
    writeCliState(scope.sessionsDir, 4242, launched, scope.cwd);
    writeTranscript(scope.dir, launched);
    w.followSessionSwitch();
    assert.equal(w.pickFile(), path.join(scope.dir, `${launched}.jsonl`));

    // /clear: same process, new id; the new transcript appears on the next message.
    writeCliState(scope.sessionsDir, 4242, afterClear, scope.cwd);
    w.followSessionSwitch();
    assert.equal(w.sessionUuid, afterClear);
    assert.equal(w.pickFile(), null, 'nothing exchanged since /clear yet');

    writeTranscript(scope.dir, afterClear);
    assert.equal(w.pickFile(), path.join(scope.dir, `${afterClear}.jsonl`));
  } finally {
    w.stop();
    scope.cleanup();
  }
});

test('clear: the switch resets the context reading instead of freezing the old one', () => {
  const scope = makeScope();
  const launched = randomUUID();
  const seen = [];
  const w = newWatcher(scope, launched, (m) => seen.push(m));
  try {
    writeCliState(scope.sessionsDir, 7, launched, scope.cwd);
    writeTranscript(scope.dir, launched, 50000);
    w.tick();
    assert.equal(seen.at(-1).tokens, 50000);

    writeCliState(scope.sessionsDir, 7, randomUUID(), scope.cwd);
    w.tick();
    assert.equal(seen.at(-1).tokens, 0, 'a cleared session starts from an empty context');
  } finally {
    w.stop();
    scope.cleanup();
  }
});

test('clear: another tab clearing does not move this watcher', () => {
  const scope = makeScope();
  const mine = randomUUID();
  const theirs = randomUUID();
  const w = newWatcher(scope, mine);
  try {
    writeCliState(scope.sessionsDir, 1, mine, scope.cwd);
    writeCliState(scope.sessionsDir, 2, theirs, scope.cwd);
    w.followSessionSwitch();

    writeCliState(scope.sessionsDir, 2, randomUUID(), scope.cwd);
    w.followSessionSwitch();
    assert.equal(w.sessionUuid, mine);
  } finally {
    w.stop();
    scope.cleanup();
  }
});

test('clear: a reused pid (different process start) is not followed', () => {
  const scope = makeScope();
  const mine = randomUUID();
  const w = newWatcher(scope, mine);
  try {
    writeCliState(scope.sessionsDir, 9, mine, scope.cwd, 'start-A');
    w.followSessionSwitch();

    // Our claude exited and the OS handed pid 9 to an unrelated claude.
    writeCliState(scope.sessionsDir, 9, randomUUID(), scope.cwd, 'start-B');
    w.followSessionSwitch();
    assert.equal(w.sessionUuid, mine);
  } finally {
    w.stop();
    scope.cleanup();
  }
});

test('clear: the old transcript is released once the watcher moves on', () => {
  const scope = makeScope();
  const launched = randomUUID();
  const w = newWatcher(scope, launched);
  try {
    writeCliState(scope.sessionsDir, 5, launched, scope.cwd);
    writeTranscript(scope.dir, launched);
    w.followSessionSwitch();
    w.pickFile();

    writeCliState(scope.sessionsDir, 5, randomUUID(), scope.cwd);
    w.followSessionSwitch();

    // A later /resume of the old session in a new tab must be able to claim it.
    const other = newWatcher(scope, launched);
    assert.equal(other.pickFile(), path.join(scope.dir, `${launched}.jsonl`));
    other.stop();
  } finally {
    w.stop();
    scope.cleanup();
  }
});
