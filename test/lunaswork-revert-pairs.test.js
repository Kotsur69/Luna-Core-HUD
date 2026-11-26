// ============================================================================
// Luna's Work rollback: commits net of revert pairs (src/lunasworkRevertPairs.js).
// Pure helpers only; the real-git rollback after a rollback is covered in
// test/lunaswork-checkpoint.test.js.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { revertLinkArgs, parseRevertLinks, subjectTarget, netOfReverts } = require('../src/lunasworkRevertPairs');

const sha = (c) => c.repeat(40);
const commit = (c, subject) => ({ sha: sha(c), merge: false, subject });
const subjects = (list) => list.map((c) => c.subject);

test('an earlier rollback and the work it undid cancel; only the new work is still applied', () => {
  // Oldest -> newest: C1 C2 R(C2) R(C1) D1 D2; the list is newest first.
  const list = [
    commit('6', 'feat: d2'),
    commit('5', 'feat: d1'),
    commit('4', 'Revert "feat: c1"'),
    commit('3', 'Revert "feat: c2"'),
    commit('2', 'feat: c2'),
    commit('1', 'feat: c1'),
  ];
  const links = new Map([
    [sha('4'), sha('1')],
    [sha('3'), sha('2')],
  ]);
  const net = netOfReverts(list, links);
  assert.deepEqual(subjects(net.applied), ['feat: d2', 'feat: d1']);
  assert.deepEqual(subjects(net.cancelled), ['Revert "feat: c1"', 'Revert "feat: c2"', 'feat: c2', 'feat: c1']);
});

test('a revert of a revert cancels the revert; the original stays applied', () => {
  const list = [commit('3', 'Reapply "feat: c"'), commit('2', 'Revert "feat: c"'), commit('1', 'feat: c')];
  const links = new Map([
    [sha('3'), sha('2')],
    [sha('2'), sha('1')],
  ]);
  assert.deepEqual(subjects(netOfReverts(list, links).applied), ['feat: c']);
});

test('a revert of a commit before the range stays: it is needed to reach the good tree', () => {
  const list = [commit('2', 'Revert "feat: old"'), commit('1', 'feat: new')];
  const links = new Map([[sha('2'), sha('9')]]);
  assert.deepEqual(subjects(netOfReverts(list, links).applied), ['Revert "feat: old"', 'feat: new']);
});

test('the body line is the whole truth: a same-named commit in the range is not its target', () => {
  // The revert undoes an older "feat: x" outside the range, not this one.
  const list = [commit('2', 'Revert "feat: x"'), commit('1', 'feat: x')];
  const links = new Map([[sha('2'), sha('9')]]);
  assert.equal(netOfReverts(list, links).cancelled.length, 0);
});

test('without a body line the subject names the target, newest match first', () => {
  const list = [
    commit('4', 'Reapply "feat: a"'),
    commit('3', 'Revert "feat: a"'),
    commit('2', 'feat: a'),
    commit('1', 'feat: a'),
  ];
  // Reapply pairs with the Revert; feat: a (2) and the older feat: a (1) stay.
  assert.deepEqual(netOfReverts(list).applied.map((c) => c.sha), [sha('2'), sha('1')]);
  assert.deepEqual(netOfReverts([commit('2', 'Revert "feat: a"'), commit('1', 'feat: a')]).applied, []);
  assert.equal(subjectTarget('Revert "Revert "feat: a""'), 'Revert "feat: a"');
  assert.equal(subjectTarget('Reapply "feat: a"'), 'Revert "feat: a"');
  assert.equal(subjectTarget('feat: a'), null);
});

test('parseRevertLinks reads plain and merge reverts; other commits are left out', () => {
  const out = [
    `${sha('3')}\x1fRevert "Merge package a"\n\nThis reverts commit ${sha('1')}, reversing\nchanges made to ${sha('0')}.\n`,
    `${sha('2')}\x1fRevert "fix: b"\n\nThis reverts commit ${sha('4')}.\n`,
    `${sha('5')}\x1ffeat: mentions This reverts commit ${sha('6')} mid-line\n`,
    'garbage',
  ].join('\x1e');
  const links = parseRevertLinks(out);
  assert.deepEqual([...links.entries()], [
    [sha('3'), sha('1')],
    [sha('2'), sha('4')],
  ]);
  assert.deepEqual(revertLinkArgs('a..b'), ['log', '--first-parent', '--format=%H%x1f%B%x1e', 'a..b']);
  assert.deepEqual(netOfReverts(null), { applied: [], cancelled: [] });
});
