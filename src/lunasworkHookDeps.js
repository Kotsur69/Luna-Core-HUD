// ============================================================================
// LunaCore - Luna's Work loop-hook deps (main process)
// ----------------------------------------------------------------------------
// The real implementations behind the controller's loop hooks
// (src/lunasworkLoopHooks.js), built for src/lunasworkWiring.js:
//
//   refreshGraph   lunasworkGraph: re-index + docs/CODEMAPS commit (LW 2.23)
//   i18n           lunasworkI18n.i18nCards on the checkout (B11)
//   lighthouse     lunasworkLighthouse.runLighthouse on the TEST_PLAN.md
//                  routes of the running app, with the project's budgets
//                  (lunasworkSettings.lighthouseBudgetsFor) (B7)
//   reviews        lunasworkReviews.runReviews with the iteration diff (2.15)
//   secondOpinion  lunasworkSecondOpinion.runSecondOpinion - only when Mati
//                  set a CLI order (settings.secondOpinionOrder); null = off,
//                  because the gate's evidence goes to that vendor (B8)
//
// The iteration diff (docs/CODEMAPS left out) runs from the previous checkpoint tag
// (lunasworkCheckpoint.tagName) to HEAD, else from the last non-codemaps commit.
// The second opinion gets the same diff as its gate diff.
// ============================================================================

'use strict';

const path = require('path');
const { execFile } = require('child_process');
const pack = require('./lunasworkPack');
const settingsStore = require('./lunasworkSettings');
const { tagName } = require('./lunasworkCheckpoint');
const { createGraphRefresher, CODEMAPS_DIR } = require('./lunasworkGraph');
const { i18nCards } = require('./lunasworkI18n');
const { runLighthouse } = require('./lunasworkLighthouse');
const { reviewsDue, runReviews } = require('./lunasworkReviews');
const { runSecondOpinion } = require('./lunasworkSecondOpinion');

const GIT_TIMEOUT_MS = 30 * 1000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
// Lighthouse covers every route on desktop and mobile: keep the list short.
const MAX_ROUTES = 8;
const ROUTE_PATH_RE = /(?:^|[\s(`"'])(\/(?:[A-Za-z0-9._~-]+\/?)*)(?=$|[\s)`"',.;:!?])/gm;
const URL_RE = /https?:\/\/[^\s)`"'<>]+/g;

/**
 * Pure. The app routes TEST_PLAN.md names - same-origin URLs and "/path"
 * mentions - as absolute URLs on the profile's origin, the root first.
 * @param {string} md TEST_PLAN.md
 * @param {string} baseUrl the running app's URL
 * @returns {string[]} at most MAX_ROUTES, no duplicates; [] without a valid base URL
 */
function routesFromTestPlan(md, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const text = String(md || '');
  const paths = ['/'];
  for (const m of text.matchAll(URL_RE)) {
    try {
      const u = new URL(m[0].replace(/[.,;:!?]+$/, ''));
      if (u.origin === base.origin) paths.push(u.pathname + u.search);
    } catch {
      // not a URL after all
    }
  }
  // A sentence's full stop is no part of the path ("Back to /quote.").
  for (const m of text.matchAll(ROUTE_PATH_RE)) if (!m[1].startsWith('//')) paths.push(m[1].replace(/\.+$/, '') || '/');
  const urls = paths.map((p) => new URL(p, base.origin).href);
  return [...new Set(urls)].slice(0, MAX_ROUTES);
}

function gitOut(repoPath, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_DIFF_BYTES }, (err, stdout) => {
      // A diff over the buffer cap is still worth its first megabytes (the prompts cut it anyway).
      if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && stdout) return resolve(String(stdout));
      resolve(err ? null : String(stdout || ''));
    });
  });
}

/**
 * The iteration's diff, docs/CODEMAPS left out (LW 2.23 commits the maps on
 * top): previous checkpoint tag..HEAD, else from the parent of the newest
 * commit that is not a codemaps refresh; '' on failure.
 */
async function iterationDiff(repoPath, runId, iteration) {
  const prev = Number.isInteger(iteration) && iteration > 1 ? tagName(runId, iteration - 1) : null;
  const hasTag = prev ? (await gitOut(repoPath, ['rev-parse', '-q', '--verify', `refs/tags/${prev}`])) !== null : false;
  let base = hasTag ? `refs/tags/${prev}` : null;
  if (!base) {
    const work = String((await gitOut(repoPath, ['rev-list', '-n', '1', '--invert-grep', '--grep', '^docs(codemaps): ', 'HEAD'])) || '').trim();
    base = /^[0-9a-f]{40}$/.test(work) ? `${work}~1` : 'HEAD~1';
  }
  return (await gitOut(repoPath, ['diff', '--no-color', `${base}..HEAD`, '--', '.', `:(exclude)${CODEMAPS_DIR}`])) || '';
}

/** DESIGN.md and SHIP_CRITERIA.md: what the second opinion judges the gate against. */
function designPack(repoPath) {
  return ['DESIGN.md', 'SHIP_CRITERIA.md']
    .map((file) => {
      const text = pack.readPackFile(repoPath, file);
      return text ? `# design/${file}\n\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * @param {{env:()=>object, settings?:()=>object, log?:(line:string)=>void}} ctx
 * @returns {{refreshGraph:Function, i18n:Function, lighthouse:Function, reviews:Function, secondOpinion:Function}}
 */
function createHookDeps(ctx) {
  const settings = typeof ctx.settings === 'function' ? ctx.settings : () => settingsStore.readSettings();
  const log = typeof ctx.log === 'function' ? (message) => ctx.log(`[lunaswork] ${message}`) : () => {};
  const graph = createGraphRefresher({ env: ctx.env, log: ctx.log });

  return {
    refreshGraph: (opts) => graph.refreshGraph(opts),
    i18n: ({ repoPath, runId }) => i18nCards({ repoPath, runId }),
    lighthouse: async ({ projectId, repoPath, url, evidenceDir }) => {
      const routes = routesFromTestPlan(pack.readPackFile(repoPath, 'TEST_PLAN.md') || '', url);
      if (!routes.length) return null;
      const res = await runLighthouse({
        routes,
        repoPath,
        reportDir: typeof evidenceDir === 'string' && evidenceDir ? path.join(evidenceDir, 'lighthouse') : undefined,
        env: ctx.env(),
        log,
      });
      return { ...res, budgets: settingsStore.lighthouseBudgetsFor(settings(), projectId) };
    },
    reviews: async ({ iteration, isGate, runId, repoPath }) => {
      // No review due: no diff to read.
      const diff = reviewsDue(iteration, isGate).length ? await iterationDiff(repoPath, runId, iteration) : '';
      return runReviews({ iteration, isGate, runId, repoPath, diff, env: ctx.env(), log });
    },
    secondOpinion: async ({ isGate, repoPath, runId, iteration, report, allPassed }) => {
      const order = settingsStore.normalizeCliOrder(settings().secondOpinionOrder);
      if (!order.length) return null;
      return runSecondOpinion({
        isGate,
        order,
        cwd: repoPath,
        env: ctx.env(),
        allPassed,
        log,
        inputs: { playtestReport: report, designPack: designPack(repoPath), gateDiff: await iterationDiff(repoPath, runId, iteration) },
      });
    },
  };
}

module.exports = { routesFromTestPlan, iterationDiff, createHookDeps };
