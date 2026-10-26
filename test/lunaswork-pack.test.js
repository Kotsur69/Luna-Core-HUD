// ============================================================================
// Luna's Work (docs/LUNAS_WORK_PLAN.md, slice 2): the design pack in
// lunasworkPack.js - scaffold, ownership ops, writes kept inside design/,
// ship-criteria parsing, completeness and the interview brief.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pack = require('../src/lunasworkPack.js');
const { gatePassed } = require('../src/lunasworkRules.js');

const tempRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-lwpack-'));
const designFile = (repo, file) => path.join(repo, 'design', file);
const read = (repo, file) => fs.readFileSync(designFile(repo, file), 'utf8');
const write = (repo, file, text) => {
  fs.mkdirSync(path.join(repo, 'design'), { recursive: true });
  fs.writeFileSync(designFile(repo, file), text);
};

/** A pack with every required file filled in. */
function filledRepo() {
  const repo = tempRepo();
  pack.scaffoldPack(repo);
  write(repo, 'BRIEF.md', '# Brief\n\n## What it is\n\nA steel quote calculator.\n');
  write(repo, 'DESIGN.md', '# Design\n\n## Features\n\n- Quote from a drawing\n');
  write(repo, 'SHIP_CRITERIA.md', '# Ship\n\n## Milestone 1: Skeleton\n\n- [ ] Opens\n');
  pack.applyWrite(repo, pack.appendJourney('Make a quote\n\n1. Open\n2. Expect a total'));
  return repo;
}

// ---- scaffold -------------------------------------------------------------------

test('scaffoldPack writes every template and the references README', () => {
  const repo = tempRepo();
  const res = pack.scaffoldPack(repo);
  assert.equal(res.ok, true);
  assert.deepEqual(res.created.sort(), [...pack.PACK_FILES, 'references/README.md'].sort());
  for (const file of pack.PACK_FILES) assert.equal(read(repo, file), pack.TEMPLATES[file]);
  assert.ok(fs.existsSync(designFile(repo, 'references/README.md')));
});

test('scaffoldPack never overwrites an existing file', () => {
  const repo = tempRepo();
  write(repo, 'BRIEF.md', 'Mati wrote this');
  const res = pack.scaffoldPack(repo);
  assert.equal(read(repo, 'BRIEF.md'), 'Mati wrote this');
  assert.ok(res.skipped.includes('BRIEF.md'));
  assert.ok(!res.created.includes('BRIEF.md'));
  const again = pack.scaffoldPack(repo);
  assert.deepEqual(again.created, []);
});

test('scaffoldPack rejects a non-absolute or missing repo dir without throwing', () => {
  assert.equal(pack.scaffoldPack('relative/dir').ok, false);
  assert.equal(pack.scaffoldPack(null).ok, false);
});

test('scaffoldPack refuses a design/ that is a symlink or junction', () => {
  const repo = tempRepo();
  const outside = tempRepo();
  // 'junction' needs no admin rights on Windows; other platforms ignore the type.
  fs.symlinkSync(outside, path.join(repo, 'design'), 'junction');
  const res = pack.scaffoldPack(repo);
  assert.equal(res.ok, false);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the link');
});

// ---- ownership ops ----------------------------------------------------------------

test('appendDesign appends and keeps the existing text', () => {
  const repo = tempRepo();
  write(repo, 'DESIGN.md', '# Design\n\nOriginal.\n');
  assert.deepEqual(pack.applyWrite(repo, pack.appendDesign('## Added\n\nMore.')), { ok: true });
  assert.equal(read(repo, 'DESIGN.md'), '# Design\n\nOriginal.\n\n## Added\n\nMore.\n');
});

test('appendPlaytestLog and appendDecision append at the end', () => {
  const repo = tempRepo();
  pack.scaffoldPack(repo);
  pack.applyWrite(repo, pack.appendPlaytestLog('## Iteration 1\n\nAll good.'));
  assert.ok(read(repo, 'PLAYTEST_LOG.md').endsWith('## Iteration 1\n\nAll good.\n'));
  pack.applyWrite(repo, pack.appendDecision({ choice: 'SQLite', because: 'one file\nno server', source: 'director' }));
  pack.applyWrite(repo, pack.appendDecision({ choice: 'PLN', because: 'Polish market' }));
  assert.ok(
    read(repo, 'DECISIONS.md').endsWith(
      '- Chose SQLite because one file no server (source: director)\n- Chose PLN because Polish market\n',
    ),
  );
});

test('append ops reject empty or oversized input', () => {
  assert.equal(pack.appendDesign(''), null);
  assert.equal(pack.appendDesign(42), null);
  assert.equal(pack.appendPlaytestLog('x'.repeat(pack.MAX_APPEND_CHARS + 1)), null);
  assert.equal(pack.appendDecision({ choice: 'X' }), null);
  assert.equal(pack.appendDecision(null), null);
  assert.equal(pack.appendJourney('   '), null);
  assert.equal(pack.writeArchitecture(''), null);
});

test('appendJourney inserts into the Journeys section, before any later section', () => {
  const repo = tempRepo();
  write(repo, 'TEST_PLAN.md', '# Test plan\n\n## Journeys\n\n### First\n\n## Notes\n\nKeep me.\n');
  pack.applyWrite(repo, pack.appendJourney('Second\n1. Do it'));
  const md = read(repo, 'TEST_PLAN.md');
  assert.deepEqual(pack.parseJourneys(md), ['First', 'Second']);
  assert.ok(md.indexOf('### Second') < md.indexOf('## Notes'));
  assert.ok(md.endsWith('## Notes\n\nKeep me.\n'));
});

test('appendJourney on the template lands under Journeys', () => {
  const repo = tempRepo();
  pack.scaffoldPack(repo);
  pack.applyWrite(repo, pack.appendJourney('### Login'));
  assert.deepEqual(pack.parseJourneys(read(repo, 'TEST_PLAN.md')), ['Login']);
});

test('writeArchitecture replaces the whole file', () => {
  const repo = tempRepo();
  pack.scaffoldPack(repo);
  pack.applyWrite(repo, pack.writeArchitecture('# Architecture\n\nNew.'));
  assert.equal(read(repo, 'ARCHITECTURE.md'), '# Architecture\n\nNew.\n');
});

// ---- writes stay inside design/ -----------------------------------------------------

test('applyWrite rejects path traversal and non-pack files', () => {
  const repo = tempRepo();
  const update = () => 'pwned';
  for (const file of ['../evil.md', '..\\evil.md', '/etc/passwd', 'sub/BRIEF.md', 'notes.md', path.join(repo, 'x.md')]) {
    const res = pack.applyWrite(repo, { file, update });
    assert.equal(res.ok, false, file);
  }
  assert.ok(!fs.existsSync(path.join(repo, 'evil.md')));
  assert.ok(!fs.existsSync(path.join(path.dirname(repo), 'evil.md')));
});

test('applyWrite rejects a missing op or relative repo dir', () => {
  assert.equal(pack.applyWrite(tempRepo(), null).ok, false);
  assert.equal(pack.applyWrite('relative', pack.appendDesign('x')).ok, false);
});

// ---- ship criteria ------------------------------------------------------------------

test('parseShipCriteria parses the default ladder in order', () => {
  const ladder = pack.parseShipCriteria(pack.TEMPLATES['SHIP_CRITERIA.md']);
  assert.deepEqual(
    ladder.map((m) => m.name),
    ['Milestone 1: Skeleton', 'Milestone 2: Core flows', 'Milestone 3: Complete', 'Milestone 4: Polish'],
  );
  assert.ok(ladder.every((m) => m.criteria.length > 0));
  assert.equal(ladder[0].criteria[0].text, 'The app starts without errors');
  assert.equal(gatePassed(ladder[0]), false);
});

test('parseShipCriteria reads checked items and feeds gatePassed', () => {
  const md = '# Ship\n\n## Skeleton\n- [x] Opens\r\n- [X] Has nav\n\n## Done\n- [ ] All\n<!-- ## Hidden\n- [ ] no -->\n';
  const [skeleton, done, ...rest] = pack.parseShipCriteria(md);
  assert.equal(rest.length, 0);
  assert.equal(gatePassed(skeleton), true);
  assert.equal(gatePassed(done), false);
});

test('parseShipCriteria tolerates garbage input', () => {
  assert.deepEqual(pack.parseShipCriteria(null), []);
  assert.deepEqual(pack.parseShipCriteria('- [ ] orphan item'), []);
});

// ---- completeness -------------------------------------------------------------------

test('packCompleteness flags every required file missing in an empty repo', () => {
  assert.deepEqual(pack.packCompleteness(tempRepo()), {
    complete: false,
    missing: [...pack.REQUIRED_FILES],
    empty: [],
  });
});

test('packCompleteness flags template-only required files as empty', () => {
  const repo = tempRepo();
  pack.scaffoldPack(repo);
  assert.deepEqual(pack.packCompleteness(repo), { complete: false, missing: [], empty: [...pack.REQUIRED_FILES] });
});

test('packCompleteness passes a filled pack with template-only ARCHITECTURE / DECISIONS', () => {
  assert.deepEqual(pack.packCompleteness(filledRepo()), { complete: true, missing: [], empty: [] });
});

test('packCompleteness needs a gate item and a journey', () => {
  const repo = filledRepo();
  write(repo, 'SHIP_CRITERIA.md', '# Ship\n\n## Milestone 1\n\nNo checklist yet.\n');
  write(repo, 'TEST_PLAN.md', pack.TEMPLATES['TEST_PLAN.md'].replace('## Journeys', '## Journeys\n\nTBD'));
  fs.rmSync(designFile(repo, 'BRIEF.md'));
  assert.deepEqual(pack.packCompleteness(repo), {
    complete: false,
    missing: ['BRIEF.md'],
    empty: ['SHIP_CRITERIA.md', 'TEST_PLAN.md'],
  });
});

test('packCompleteness treats headings-and-comments-only as empty', () => {
  const repo = filledRepo();
  write(repo, 'DESIGN.md', '# Design\n\n<!-- todo -->\n\n## Features\n');
  assert.deepEqual(pack.packCompleteness(repo).empty, ['DESIGN.md']);
});

// ---- interview brief ----------------------------------------------------------------

test('interviewBrief names the design folder and marks files that need work', () => {
  const repo = tempRepo();
  pack.scaffoldPack(repo);
  write(repo, 'BRIEF.md', '# Brief\n\nDone already.\n');
  const brief = pack.interviewBrief(repo);
  assert.ok(brief.includes(path.join(repo, 'design')));
  for (const file of pack.PACK_FILES) assert.ok(brief.includes(file), file);
  assert.ok(/DESIGN\.md:.*needs work/.test(brief));
  assert.ok(!/BRIEF\.md:.*needs work/.test(brief));
  assert.ok(brief.includes('references'));
});

test('interviewBrief does not throw on a bad repo dir', () => {
  assert.equal(typeof pack.interviewBrief(undefined), 'string');
});

test('interviewBrief asks for the roadmap in the epic line format (LW 2.13)', () => {
  const brief = pack.interviewBrief(tempRepo());
  assert.match(brief, /ROADMAP\.md: ask for the roadmap/);
  assert.match(brief, /- \[ \] epic:<slug> - <title>/);
});

// ---- roadmap (LW 2.13) ------------------------------------------------------------

const ROADMAP = `# Roadmap

<!-- a comment with - [ ] epic:ghost - Not an epic -->

## Goal

Steel quotes in two minutes,
from a drawing.

## Milestones

### Milestone 1: Skeleton

- [x] epic:shell - App shell
- [ ] epic:quote-form - Quote form

### Milestone 2: Core flows

- [ ] \`pdf-export\` PDF export
- [ ] Email the quote
- [ ] epic:quote-form - Duplicate, ignored
`;

test('parseRoadmap parses the ROADMAP.md template in TEMPLATES', () => {
  assert.deepEqual(pack.parseRoadmap(pack.TEMPLATES['ROADMAP.md']), { goal: '', milestones: [] });
  assert.equal(pack.activeEpic(pack.parseRoadmap(pack.TEMPLATES['ROADMAP.md'])), null);
});

test('parseRoadmap reads goal, milestones and epics; comments and duplicates skipped', () => {
  assert.deepEqual(pack.parseRoadmap(ROADMAP), {
    goal: 'Steel quotes in two minutes, from a drawing.',
    milestones: [
      {
        name: 'Milestone 1: Skeleton',
        epics: [
          { slug: 'shell', title: 'App shell', done: true },
          { slug: 'quote-form', title: 'Quote form', done: false },
        ],
      },
      {
        name: 'Milestone 2: Core flows',
        epics: [
          { slug: 'pdf-export', title: 'PDF export', done: false },
          { slug: 'email-the-quote', title: 'Email the quote', done: false },
        ],
      },
    ],
  });
});

test('parseRoadmap is tolerant: CRLF, "## " milestone headings, epics without a heading', () => {
  const crlf = pack.parseRoadmap(ROADMAP.replace(/\n/g, '\r\n'));
  assert.deepEqual(crlf, pack.parseRoadmap(ROADMAP));
  const flat = pack.parseRoadmap('# Roadmap\n\n## Milestone A\n\n- [ ] epic:a1 - One\n\n## Milestone B\n- [X] epic:b1\n');
  assert.deepEqual(flat.milestones.map((m) => [m.name, m.epics]), [
    ['Milestone A', [{ slug: 'a1', title: 'One', done: false }]],
    ['Milestone B', [{ slug: 'b1', title: 'b1', done: true }]],
  ]);
  const bare = pack.parseRoadmap('## Milestones\n- [ ] epic:only - Only epic\n');
  assert.deepEqual(bare.milestones, [{ name: 'Milestone 1', epics: [{ slug: 'only', title: 'Only epic', done: false }] }]);
});

test('parseRoadmap skips "## " sections that are not milestones', () => {
  const md = `${ROADMAP}\n## Notes\n\n- [ ] remember the logo\n\n## Milestone 3: Polish\n\n- [ ] epic:polish - Polish\n`;
  const names = pack.parseRoadmap(md).milestones.map((m) => m.name);
  assert.deepEqual(names, ['Milestone 1: Skeleton', 'Milestone 2: Core flows', 'Milestone 3: Polish']);
  assert.ok(!pack.parseRoadmap(md).milestones.some((m) => m.epics.some((e) => e.slug === 'remember-the-logo')));
});

test('tickEpic ticks the epic box, not a box inside a comment on the same line', () => {
  const repo = tempRepo();
  const md = '## Milestones\n### M1\n<!-- [ ] --> - [ ] epic:a - A\n';
  write(repo, 'ROADMAP.md', md);
  pack.applyWrite(repo, pack.tickEpic('a'));
  assert.equal(read(repo, 'ROADMAP.md'), '## Milestones\n### M1\n<!-- [ ] --> - [x] epic:a - A\n');
});

test('parseRoadmap returns null for a broken or non-roadmap file', () => {
  for (const md of [null, undefined, 42, {}, '', '   \n', 'just some prose', '- Milestone 3: multiplayer leaderboard\n']) {
    assert.equal(pack.parseRoadmap(md), null, JSON.stringify(md));
  }
});

test('activeEpic: first open epic of the first milestone that still has one', () => {
  assert.deepEqual(pack.activeEpic(pack.parseRoadmap(ROADMAP)), { slug: 'quote-form', title: 'Quote form', milestone: 'Milestone 1: Skeleton' });
  const later = pack.parseRoadmap(ROADMAP.replace('- [ ] epic:quote-form - Quote form', '- [x] epic:quote-form - Quote form'));
  assert.equal(pack.activeEpic(later).slug, 'pdf-export');
  assert.equal(pack.activeEpic(pack.parseRoadmap(ROADMAP.replace(/\[ \]/g, '[x]'))), null, 'all done');
  assert.equal(pack.activeEpic(null), null);
});

test('tickEpic flips one checkbox and changes nothing else', () => {
  const repo = tempRepo();
  const crlf = ROADMAP.replace(/\n/g, '\r\n');
  write(repo, 'ROADMAP.md', crlf);
  assert.equal(pack.applyWrite(repo, pack.tickEpic('quote-form')).ok, true);
  const after = read(repo, 'ROADMAP.md');
  assert.equal(after, crlf.replace('- [ ] epic:quote-form - Quote form', '- [x] epic:quote-form - Quote form'));
  // The duplicate line further down and the commented-out epic are untouched.
  assert.match(after, /- \[ \] epic:quote-form - Duplicate, ignored/);
  // Ticking again, or an unknown epic, leaves the file byte for byte.
  pack.applyWrite(repo, pack.tickEpic('quote-form'));
  pack.applyWrite(repo, pack.tickEpic('ghost'));
  assert.equal(read(repo, 'ROADMAP.md'), after);
  assert.equal(pack.tickEpic('../x'), null);
  assert.equal(pack.tickEpic(''), null);
});

// ---- contracts (LW 2.12) ----------------------------------------------------------

test('writeContracts writes design/CONTRACTS.md with the contracts and the ownership map', () => {
  const repo = tempRepo();
  const op = pack.writeContracts({
    iteration: 3,
    contracts: [
      { name: 'quoteTotal', kind: 'function', spec: 'quoteTotal(items: Item[]) -> number\n# not a heading of the file' },
      { name: 'POST /api/quote', kind: 'route', spec: 'body {items}, returns {id, total}' },
    ],
    ownership: [{ path: 'src/quote/**', owner: 12 }, { path: 'src/api.js', owner: 13 }],
  });
  assert.equal(op.file, 'CONTRACTS.md');
  assert.equal(pack.applyWrite(repo, op).ok, true);
  const md = read(repo, 'CONTRACTS.md');
  assert.match(md, /^# Contracts\n/);
  assert.match(md, /iteration 3/);
  assert.match(md, /## quoteTotal \(function\)\n\nquoteTotal\(items: Item\[\]\) -> number\n#### not a heading/);
  assert.match(md, /## POST \/api\/quote \(route\)/);
  assert.match(md, /\| `src\/quote\/\*\*` \| 12 \|/);
  assert.match(md, /\| `src\/api\.js` \| 13 \|/);
  assert.equal(pack.readPackFile(repo, 'CONTRACTS.md'), md);
});

test('writeContracts: nothing to write is no op; CONTRACTS.md is never scaffolded', () => {
  assert.equal(pack.writeContracts({}), null);
  assert.equal(pack.writeContracts({ contracts: [{ name: '', kind: 'data', spec: 'x' }] }), null);
  assert.equal(pack.PACK_FILES.includes('CONTRACTS.md'), false);
  const repo = tempRepo();
  pack.scaffoldPack(repo);
  assert.equal(fs.existsSync(designFile(repo, 'CONTRACTS.md')), false);
});
