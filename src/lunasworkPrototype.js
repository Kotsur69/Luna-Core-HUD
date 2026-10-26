// ============================================================================
// LunaCore - Luna's Work clickable mockup first (docs/LUNAS_WORK_PLAN.md C2, LW 2.25b)
// ----------------------------------------------------------------------------
// The 'Clickable mockup first' toggle (lunasworkSettings, per project, off by
// default; pinned in the run at start as run.toggles.mockupFirst). With it on,
// pre-production ends with a prototype iteration before the first Director:
//
//   1. begin()          one prototype card (prototypeCard): a rough clickable
//                       mockup of the main screens with fake data, under
//                       `prototype/`, opening at <url>/prototype/. Built as a
//                       short God Mode iteration through the normal
//                       stepBuilding; end(build) takes its result (red or not
//                       landed = built again, retryLater's three-strikes rule)
//   2. afterPlaytest()  the app is launched and played ONCE in the
//                       Playtester's 'navigation' mode (links and buttons
//                       only); then the decision queue asks "Approve the
//                       prototype?" with how to open it and the screenshots.
//                       Default at the deadline: approve
//   3. gate()           the first directing step waits for that answer (the
//                       run's wait timer, waitReason 'prototype'; an early
//                       answer wakes it - onAnswered). Free text in the answer
//                       is Mati's comments: a review card (reviewCard) plus a
//                       DESIGN.md append (deps.appendDesign). Then the real
//                       build starts
//   4. cleanup          once the first milestone gate passed (the real screens
//                       exist), one card deletes prototype/ (cleanupCard)
//
// Off = begin() returns false and the run goes straight to the build.
// ============================================================================

'use strict';

const { emptyCurrent } = require('./lunasworkRun');

const PROTOTYPE_DIR = 'prototype/';
const PROTOTYPE_TAG = 'prototype';
const REVIEW_TAG = 'prototype-review';
const CLEANUP_TAG = 'prototype-cleanup';
const TAGS = Object.freeze([PROTOTYPE_TAG, REVIEW_TAG, CLEANUP_TAG]);
const APPROVE = 'approve';
const PROTOTYPE_DEADLINE_MS = 4 * 60 * 60 * 1000;
const NOTE = 'clickable prototype (LW 2.25b)';
const MAX_COMMENT_CHARS = 500;
const MAX_DETAIL_CHARS = 300;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, max) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** One of the toggle's own cards (passes the Director's scope guard, like the pack's cards). */
const isPrototypeCard = (card) => isObj(card) && Array.isArray(card.tags) && card.tags.some((t) => TAGS.includes(t));

/** <url>/prototype/ of the pinned profile, or the bare folder name. */
function prototypeUrl(profile) {
  try {
    return new URL(PROTOTYPE_DIR, isObj(profile) ? profile.url : '').href;
  } catch {
    return PROTOTYPE_DIR;
  }
}

// ---- cards (lunasworkCritic.applyCards shape) --------------------------------------------

function prototypeCard(url) {
  return {
    kind: 'missing',
    severity: 'high',
    text: 'Prototype: a rough clickable mockup of the main screens in prototype/',
    details: [
      'Build a rough, clickable prototype of the main screens in design/DESIGN.md (Screens): fake data, no real logic, no backend calls.',
      "- Put every file under prototype/ at the repo root: static HTML and CSS with prototype/index.html as the start page that links every main screen, or the stack's own pages when it cannot serve static files - then add only the thinnest route that serves them.",
      `- It must open at ${url} while the app runs with its normal start command; every main screen is reachable by clicks from the start page, with a way back.`,
      "- Do not touch the real app's screens. Mati reviews the prototype before the real build; the folder is deleted once the real screens exist.",
    ].join('\n'),
    acceptance: [`${url} opens the prototype's start page`, 'every main screen of DESIGN.md is reachable by clicks and has a way back'],
    files: [PROTOTYPE_DIR],
    updatesCardId: null,
    extraTags: [PROTOTYPE_TAG],
  };
}

function reviewCard(comments) {
  return {
    kind: 'feel',
    severity: 'medium',
    text: `Prototype review: ${clip(comments, 200)}`,
    details: `Mati's comments on the clickable prototype - apply them to the real screens:\n${clip(comments, MAX_COMMENT_CHARS)}`,
    acceptance: ["the real screens follow Mati's prototype comments"],
    files: [],
    updatesCardId: null,
    extraTags: [REVIEW_TAG],
  };
}

function cleanupCard(url) {
  return {
    kind: 'missing',
    severity: 'low',
    text: 'Prototype: remove the prototype/ folder now that the real screens exist',
    details: 'The clickable prototype has done its job. Remove prototype/ and the route that served it, if any. Nothing in the real app may link to it or import from it.',
    acceptance: ['the prototype/ folder no longer exists', `${url} no longer serves the prototype`],
    files: [PROTOTYPE_DIR],
    updatesCardId: null,
    extraTags: [CLEANUP_TAG],
  };
}

// ---- the controller side -----------------------------------------------------------------

/**
 * @param {{deps:object, run:()=>object, update:(fields:object)=>void, transition:(phase:string, fields?:object)=>void,
 *   retryLater:(why:string)=>void, logEvent:(text:string)=>void, armWait:(until:number, reason:string)=>void,
 *   wake:(reason:string)=>void, ask:(spec:object)=>{ok:boolean, id?:number},
 *   cardBook:{fileCards:Function, lookup:Function, settle:Function}, withBuilderModel:(card:object)=>object|null,
 *   withBrief?:(card:object)=>object}} ctx
 *   deps.appendDesign?({repoPath, text}) -> boolean (Mati's comments into DESIGN.md)
 */
function createPrototype(ctx) {
  const { deps, run, update, transition, retryLater, logEvent, cardBook } = ctx;
  const withBrief = typeof ctx.withBrief === 'function' ? ctx.withBrief : (c) => c;
  const state = () => (isObj(run().prototype) ? run().prototype : null);
  const on = () => isObj(run().toggles) && run().toggles.mockupFirst === true;
  const at = (status) => !!state() && state().status === status && state().n === run().iteration;

  /**
   * The prototype iteration instead of the first Director. false = toggle
   * off, already done, or its card not filed: the run goes on as before.
   * @param {object} [carry] fields of run.current to keep (iteration 0's hook notes)
   */
  function begin(carry = {}) {
    if (!on() || state()) return false;
    const r = run();
    const ats = cardBook.fileCards(r.projectId, r.id, [prototypeCard(prototypeUrl(r.profile))]);
    if (!ats.length) {
      logEvent('clickable mockup first: the prototype card could not be filed - straight to the build');
      return false;
    }
    const cards = cardBook.lookup(r.projectId, ats).map(withBrief).map(ctx.withBuilderModel).filter(Boolean);
    const n = r.iteration + 1;
    logEvent(`clickable mockup first: prototype iteration ${n} before the real build`);
    transition('building', {
      iteration: n,
      current: { ...emptyCurrent(), ...carry, cards, notes: NOTE },
      prototype: { n, cards: ats, status: 'building', decisionId: null, cleanupAt: null },
    });
    return true;
  }

  /** This iteration's build is the prototype's. */
  const isBuild = () => at('building');
  /** This iteration's playtest is the prototype's navigation pass. */
  const isPlaytest = () => at('playtest');

  /** After the prototype build: green with its card landed = on to the navigation pass. */
  function end(build) {
    const r = run();
    const landed = isObj(build) && Array.isArray(build.closed) ? build.closed.filter((a) => state().cards.includes(a)) : [];
    const green = isObj(build) && build.selfCheck === 'green';
    if (!green || landed.length < state().cards.length) {
      update({ current: { ...r.current, planId: null, build: null } });
      retryLater(`prototype iteration: ${green ? 'the prototype card did not land' : 'the build is red'}`);
      return;
    }
    cardBook.settle(r.projectId, landed.map((a) => ({ at: a, outcome: 'done' })));
    transition('launching', { current: { ...r.current, build }, prototype: { ...state(), status: 'playtest' } });
  }

  /** The navigation pass ran: ask "Approve the prototype?" and go on to the first Director, which waits for it. */
  function afterPlaytest(res) {
    const r = run();
    const report = isObj(res) && isObj(res.report) ? res.report : {};
    const problems = Array.isArray(report.findings) ? report.findings.length : 0;
    const shots = Array.isArray(report.screens) ? report.screens.length : 0;
    const nav = isObj(res) && res.ok === true
      ? `navigation: ${problems} problem(s), ${shots} screenshot(s)`
      : `navigation pass failed (${clip(isObj(res) ? res.error : 'failed', 40)})`;
    const where = r.evidenceDir ? ` in ${r.evidenceDir}` : '';
    logEvent(`prototype played once, ${nav}`);
    const asked = ctx.ask({
      kind: 'prototype',
      question: 'Approve the prototype? Answer approve, or write what to change - your comments become cards and go into DESIGN.md.',
      detail: clip(`open ${prototypeUrl(r.profile)} (start the app: ${r.profile ? r.profile.startCommand : '-'}); ${nav}; screenshots${where}`, MAX_DETAIL_CHARS),
      options: [APPROVE],
      defaultAnswer: APPROVE,
      freeText: true,
      deadlineMs: PROTOTYPE_DEADLINE_MS,
      cardIds: [],
    });
    if (!asked.ok) logEvent('prototype: the approval could not be queued - the real build starts');
    transition('directing', {
      iteration: r.iteration + 1,
      current: emptyCurrent(),
      prototype: { ...state(), status: asked.ok ? 'asked' : 'approved', decisionId: asked.ok ? asked.id : null },
    });
  }

  /** Mati's comments: a review card and a DESIGN.md append. */
  function takeComments(text) {
    const r = run();
    const ats = cardBook.fileCards(r.projectId, r.id, [reviewCard(text)]);
    if (!ats.length) logEvent('prototype comments: the review card could not be filed');
    if (typeof deps.appendDesign === 'function') {
      try {
        if (deps.appendDesign({ repoPath: r.repoPath, text: `## Prototype review\n\n${clip(text, MAX_COMMENT_CHARS)}` }) === false) {
          logEvent('prototype comments: DESIGN.md not updated');
        }
      } catch (err) {
        logEvent(`prototype comments: DESIGN.md not updated (${errText(err).slice(0, 150)})`);
      }
    }
  }

  /** The first milestone gate passed: the real screens exist, the prototype goes. */
  function cleanupDue() {
    const s = state();
    const last = run().lastCritic;
    const passed = isObj(last) && (last.allPassed === true || (isObj(last.milestone) && last.milestone.passed === true));
    if (!s || s.status !== 'approved' || !passed) return;
    const r = run();
    const ats = cardBook.fileCards(r.projectId, r.id, [cleanupCard(prototypeUrl(r.profile))]);
    if (!ats.length) {
      logEvent('prototype: the cleanup card could not be filed - tried again next iteration');
      return;
    }
    logEvent('prototype: the real screens exist, a card removes prototype/');
    update({ prototype: { ...s, status: 'cleanup', cleanupAt: ats[0] } });
  }

  /**
   * At the start of every directing step. true = the run waits for the
   * prototype approval (no Director yet); false = go on.
   */
  function gate() {
    const s = state();
    if (!s) return false;
    if (s.status !== 'asked') {
      cleanupDue();
      return false;
    }
    const decision = run().decisions.find((d) => d.id === s.decisionId);
    if (decision && decision.status === 'pending') {
      ctx.armWait(decision.deadline, 'prototype');
      return true;
    }
    const answer = decision ? decision.answer : APPROVE;
    const comments = answer && answer !== APPROVE ? answer : null;
    if (comments) takeComments(comments);
    const byDefault = decision && decision.answeredBy === 'default' ? ' (default after deadline)' : '';
    logEvent(`prototype approved${byDefault}${comments ? ' with comments' : ''} - the real build starts`);
    update({ prototype: { ...s, status: 'approved' } });
    return false;
  }

  /** An early answer to the approval wakes the waiting run. */
  function onAnswered(answered) {
    const s = state();
    if (s && s.status === 'asked' && answered.some((d) => d.id === s.decisionId)) ctx.wake('prototype');
  }

  return { begin, isBuild, end, isPlaytest, afterPlaytest, gate, onAnswered };
}

module.exports = {
  PROTOTYPE_DIR,
  PROTOTYPE_DEADLINE_MS,
  APPROVE,
  isPrototypeCard,
  prototypeUrl,
  prototypeCard,
  reviewCard,
  cleanupCard,
  createPrototype,
};
