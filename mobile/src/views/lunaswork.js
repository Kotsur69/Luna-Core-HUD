// ============================================================================
// LunaCore phone - Luna's Work: the run going on now (LW 2.17b)
// ----------------------------------------------------------------------------
// The PC puts a compact snapshot of its current run in the `godmode` row
// (src/lunasworksnapshot.js) on every phase change, throttled: phase, role,
// iteration, verdict, scores per milestone, tokens per role, cards opened /
// closed, the time-to-SHIP estimate (LW 2.22b), what waits for Mati, the
// feedback items' status and up to three screenshot thumbnails.
// Under the status sit the parts that write, the same cards the God Mode page
// uses: decisions (LW 1.6), the wheel (LW 1.11) and the feedback / steer form
// (B17) - the status card's buttons scroll to them. Right under the status:
// "Ask Luna about the run" (LW 2.27, ./ask.js). Every string is text; a
// thumbnail is only ever a data: image the reader already checked.
// ============================================================================

import { h } from '../dom.js';
import { t, tf } from '../i18n.js';
import { lunasworkFrom } from '../snapmodel.js';
import { mountSnapshots, when } from './snapshotview.js';
import { repaintWhileShown } from './godmodelive.js';
import { decisionsCard, createDecisionAnswers } from './decisions.js';
import { feedbackCard, createFeedbackSender } from './feedback.js';
import { wheelCard, createWheelSender } from './wheel.js';
import { askCard, createAskSender } from './ask.js';
import { statusKey, statusTone } from '../feedbackmodel.js';

const PHASES = ['preprod', 'directing', 'building', 'launching', 'playtesting', 'critiquing', 'handed', 'done'];
const VERDICTS = ['ship', 'plateau', 'red', 'stop'];

const phaseLabel = (phase) => (PHASES.includes(phase) ? t(`lwPhase_${phase}`) : phase || '?');

/** "950", "12k", "4.1M" */
export function shortTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/** The estimate in one line: "about 4.5 h (3-7 h) · ~6 iterations", or the not-enough-data hint. */
export function etaText(eta) {
  if (!eta) return t('lwEtaNone');
  const iters = tf('lwEtaIterations', { n: eta.iterations });
  if (eta.hours === null) return iters;
  const range = eta.low !== null ? ` (${eta.low}-${eta.high !== null ? eta.high : '?'} h)` : '';
  return `${tf('lwEtaHours', { h: eta.hours })}${range} · ${iters}`;
}

function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fact(label, value) {
  return h('div', { class: 'row' }, h('span', { class: 'hint grow' }, label), h('span', { class: 'num' }, value));
}

function scoresBlock(scores) {
  if (!scores.length) return null;
  return h(
    'div',
    { class: 'stack-sm' },
    h('span', { class: 'label' }, t('lwScores')),
    h(
      'ul',
      { class: 'rows' },
      scores.map((m) => h('li', { class: 'row-col' }, h('span', {}, m.milestone || t('lwNoMilestone')), h('span', { class: 'hint num' }, m.points.map((p) => `#${p.n} ${p.score}`).join(' · ')))),
    ),
  );
}

function tokensBlock(snap) {
  if (!snap.tokens.length) return null;
  return h(
    'div',
    { class: 'stack-sm' },
    h('span', { class: 'label' }, tf('lwTokens', { tokens: shortTokens(snap.total.tokens), cost: snap.total.costUsd.toFixed(2) })),
    h('ul', { class: 'rows' }, snap.tokens.map((r) => h('li', {}, fact(r.role, `${shortTokens(r.tokens)} · $${r.costUsd.toFixed(2)}`)))),
  );
}

function shotsBlock(shots) {
  if (!shots.length) return null;
  return h(
    'div',
    { class: 'lw-shots' },
    shots.map((s) => h('figure', { class: 'lw-shot' }, h('img', { src: s.src, alt: s.name, loading: 'lazy' }), h('figcaption', { class: 'hint' }, `${s.name} · #${s.n}`))),
  );
}

function feedbackBlock(items) {
  if (!items.length) return null;
  return h(
    'div',
    { class: 'stack-sm' },
    h('span', { class: 'label' }, t('lwFeedback')),
    h('ul', { class: 'rows' }, items.map((f) => h('li', { class: 'row' }, h('span', { class: 'grow' }, f.text), h('span', { class: statusTone(f.status) }, t(statusKey(f.status)))))),
  );
}

function actions(snap) {
  const waits = snap.decisions.length;
  return h(
    'div',
    { class: 'decision-options' },
    h('button', { class: waits ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost', type: 'button', disabled: waits ? undefined : true, onclick: () => scrollTo('godmode-decisions') }, tf('lwAnswer', { n: waits })),
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => scrollTo('godmode-feedback') }, t('lwSteer')),
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => scrollTo('godmode-wheel') }, t('lwWheel')),
  );
}

/** The status card of the run, or the empty hint. */
export function statusCard(snap, now) {
  if (!snap) return h('p', { class: 'empty' }, t('lwEmpty'));
  const where = [snap.repoName, snap.machine].filter(Boolean).join(' · ');
  const verdict = VERDICTS.includes(snap.verdict) ? t(`lwVerdict_${snap.verdict}`) : null;
  return h(
    'section',
    { class: 'card stack-sm', 'aria-labelledby': 'lw-status' },
    h(
      'div',
      { class: 'row' },
      h('h2', { class: 'section-title grow', id: 'lw-status' }, t('lwTitle')),
      snap.stale ? h('span', { class: 'tag is-warn' }, t('lwStale')) : null,
      h('span', { class: snap.active ? 'tag is-good' : 'tag' }, snap.active ? phaseLabel(snap.phase) : verdict || t('lwEnded')),
    ),
    h('span', { class: 'hint' }, `${where} · ${when(snap.at, now)}`),
    snap.milestone ? fact(t('lwMilestone'), snap.milestone) : null,
    fact(t('lwIteration'), [String(snap.iteration), snap.role].filter(Boolean).join(' · ')),
    verdict && snap.active ? fact(t('lwVerdict'), verdict) : null,
    fact(t('lwCards'), tf('lwCardsValue', { closed: snap.cards.closed, opened: snap.cards.opened })),
    fact(t('lwEta'), etaText(snap.eta)),
    scoresBlock(snap.scores),
    tokensBlock(snap),
    feedbackBlock(snap.feedback),
    shotsBlock(snap.shots),
    snap.active ? actions(snap) : null,
  );
}

/** God Mode's small link to this page while a run is published. */
export function lunasworkLinkCard(rows, now) {
  const snap = lunasworkFrom(rows, now);
  if (!snap || !snap.active) return null;
  return h(
    'a',
    { class: 'card link-row', href: '#lunaswork' },
    h('span', { class: 'grow' }, h('span', { class: 'link-title' }, t('lwTitle')), h('span', { class: 'hint' }, [snap.repoName, phaseLabel(snap.phase), etaText(snap.eta)].filter(Boolean).join(' · '))),
  );
}

/**
 * @param {HTMLElement} main
 * @param {{cloud: object, toast: (m: string, bad?: boolean) => void}} deps
 * @returns {{refresh: () => Promise<void>}}
 */
export function mountLunasWork(main, deps) {
  const answers = createDecisionAnswers(deps, () => view.repaint());
  const feedback = createFeedbackSender(deps, () => view.repaint());
  const wheel = createWheelSender(deps, () => view.repaint());
  const ask = createAskSender(deps, () => view.repaint());
  const view = mountSnapshots(main, deps, ['godmode'], (byKind, now) => {
    const rows = byKind.godmode;
    return h(
      'div',
      { class: 'stack' },
      statusCard(lunasworkFrom(rows, now), now),
      askCard(rows, now, { mirror: ask.mirror(), send: ask.send }),
      decisionsCard(rows, now, { mirror: answers.mirror(), send: answers.send }),
      wheelCard(rows, now, { mirror: wheel.mirror(), send: wheel.send }),
      feedbackCard(rows, now, { mirror: feedback.mirror(), send: feedback.send }),
    );
  });
  repaintWhileShown(main, view);
  return view;
}
