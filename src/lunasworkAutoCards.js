// ============================================================================
// LunaCore - Luna's Work: the Director's own cards (LW 2.21a, LW 2.26)
// ----------------------------------------------------------------------------
// Cards the Director creates from the pack, not from the model:
//   seed     one `seed:<hash>` card per design/references data set
//            (lunasworkSeed); a `seed-pii:<hash>` card when the references hold
//            real personal data - splitByScope sends it to the decision queue
//   legal    an EU web app's GDPR cards before SHIP (lunasworkLegal), once per
//            `legal:<slug>` tag, plus their journeys in design/TEST_PLAN.md
//   variants LW 2.25a, only with the project's designVariants toggle on: the
//            variant cards of every key screen (lunasworkVariants), and the
//            screens whose variants are all built (`ready`, to screenshot)
//
// Cards go through lunasworkCritic.applyCards; scheduleAutoCards never throws.
// ============================================================================

'use strict';

const pack = require('./lunasworkPack');
const seed = require('./lunasworkSeed');
const legal = require('./lunasworkLegal');
const { applyCards } = require('./lunasworkCritic');
const { CARD_CHOICES } = require('./lunasworkDecisions');
const variants = require('./lunasworkVariants');
const { isPrototypeCard } = require('./lunasworkPrototype');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (raw, max) => (typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const hasTag = (card, tag) => Array.isArray(card.tags) && card.tags.includes(tag);
const hasTagPrefix = (card, prefix) => Array.isArray(card.tags) && card.tags.some((t) => typeof t === 'string' && t.startsWith(prefix));

/** LW 2.21a / 2.26: a seed data or legal card the Director created from the pack. */
const isSeedCard = (card) => hasTagPrefix(card, seed.SEED_TAG_PREFIX);
const isLegalCard = (card) => hasTagPrefix(card, legal.LEGAL_TAG_PREFIX);
// LW 2.25: the design-variant and prototype cards come from the toggles, not from a model.
const isAutoCard = (card) => isSeedCard(card) || isLegalCard(card) || variants.isVariantCard(card) || isPrototypeCard(card);
/** LW 2.21a: the card that copies real personal data - only with a decision-queue OK. */
const isPiiCard = (card) => hasTagPrefix(card, seed.PII_TAG_PREFIX);
const PII_MISSING = `real emails / phone numbers / tax ids from design/references in the fixtures - default ${CARD_CHOICES.outOfScope.defaultAnswer}: the fixtures keep fake values`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * LW 2.26: the legal cards are due before SHIP - once the first milestone
 * gate passed (the app has pages to link a policy from), or from the start
 * when SHIP_CRITERIA.md has a single rung.
 */
function legalDue(lastCritic, shipCriteria) {
  const gates = pack.parseShipCriteria(shipCriteria);
  if (gates.length < 2) return true;
  if (!isObj(lastCritic)) return false;
  if (lastCritic.allPassed === true) return true;
  return typeof lastCritic.next === 'string' && !!lastCritic.next && norm(lastCritic.next) !== norm(gates[0].name);
}

/** LW 2.21a: the seed (and personal-data) cards the references call for and no card carries yet. */
function seedCardsDue(repoDir, todos) {
  const files = seed.referenceDataFiles(repoDir);
  const hash = seed.referencesHash(files);
  if (!hash) return { cards: [], info: null };
  const pii = seed.scanPii(files);
  const has = (tag) => todos.some((c) => hasTag(c, tag));
  const cards = [
    ...(has(seed.seedTag(hash)) ? [] : [seed.seedCard({ hash, files, pii })]),
    ...(pii.found && !has(seed.piiTag(hash)) ? [seed.piiCard({ hash, pii })] : []),
  ];
  return { cards, info: { hash, files: files.length, pii: pii.found ? seed.piiSummary(pii) : null } };
}

/** LW 2.26: the legal cards of an EU web app that do not exist yet, and its TEST_PLAN.md journeys. */
function legalCardsDue(repoDir, todos, docs, lastCritic) {
  const eu = legal.euWebApp(docs);
  if (!eu.eu) return { cards: [], info: { eu: false, reason: eu.reason }, journeys: null };
  if (!legalDue(lastCritic, docs.shipCriteria)) return { cards: [], info: { eu: true, reason: eu.reason, due: false }, journeys: null };
  const trackers = legal.detectTrackers(repoDir, docs);
  const cards = legal.legalCards({ cookies: trackers.found })
    .filter((c) => !todos.some((t) => c.extraTags.some((tag) => hasTag(t, tag))));
  return {
    cards,
    info: { eu: true, reason: eu.reason, due: true, trackers: trackers.hits },
    journeys: pack.appendLegalJourneys({ cookies: trackers.found }),
  };
}

/**
 * Creates the Director's own cards (seed data, legal pack, design variants)
 * in the to-do store, tagged with the run tag. Never throws.
 * @param {{repoDir:string, todoStore:object, lastCritic?:object|null, designVariants?:boolean}} opts
 * @returns {{created:object[], seed:object|null, legal:object|null, journeysWritten:boolean,
 *   variants:{screens:number, ready:object[]}|null, warnings:object[]}} variants null = toggle off
 */
function scheduleAutoCards({ repoDir, todoStore, lastCritic, designVariants }, tag, todos, docs) {
  const out = { created: [], seed: null, legal: null, journeysWritten: false, variants: null, warnings: [] };
  try {
    const seedDue = seedCardsDue(repoDir, todos);
    const legalNow = legalCardsDue(repoDir, todos, docs, lastCritic);
    const variantsNow = designVariants === true ? variants.variantsDue(repoDir, todos) : { cards: [], ready: [], screens: 0 };
    out.seed = seedDue.info;
    out.legal = legalNow.info;
    if (designVariants === true) out.variants = { screens: variantsNow.screens, ready: variantsNow.ready };
    if (legalNow.journeys) {
      const res = pack.applyWrite(repoDir, legalNow.journeys);
      if (res.ok) out.journeysWritten = true;
      else out.warnings.push({ code: 'packWriteFailed', file: 'TEST_PLAN.md', detail: res.error });
    }
    const cards = [...seedDue.cards, ...legalNow.cards, ...variantsNow.cards];
    if (!cards.length) return out;
    if (typeof todoStore.write !== 'function') {
      out.warnings.push({ code: 'autoCardsSkipped', detail: 'the to-do store is read-only' });
      return out;
    }
    const applied = applyCards(todoStore, cards, tag);
    if (applied.error) out.warnings.push({ code: 'autoCardsFailed', detail: clean(applied.error, 300) });
    out.created = applied.created || [];
    out.warnings.push(...(applied.warnings || []));
  } catch (err) {
    out.warnings.push({ code: 'autoCardsFailed', detail: clean(err && err.message, 300) });
  }
  return out;
}

module.exports = {
  isSeedCard,
  isLegalCard,
  isAutoCard,
  isPiiCard,
  PII_MISSING,
  legalDue,
  scheduleAutoCards,
};
