// ============================================================================
// LunaCore - God Mode post-merge services (main process composition root)
// ----------------------------------------------------------------------------
// Builds the implementations of orchestraFinalize.js POST_MERGE_STEPS from
// the real git / npm helpers, so main.js only wires one object:
//   updateLocalBase - ff the main checkout + npm ci (src/worktrees.js)
//
// Every side effect comes in through deps, so tests use fakes.
// ============================================================================

'use strict';

const path = require('path');
const worktrees = require('./worktrees');

/**
 * True when `inner` is `outer` or a folder inside it.
 * @param {string} outer
 * @param {string} inner
 */
function isInside(outer, inner) {
  if (typeof outer !== 'string' || typeof inner !== 'string' || !outer || !inner) return false;
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {{appPath?: () => string|null, git?: {updateLocalBase?: Function}}} deps
 *   appPath: the folder LunaCore itself runs from - `npm ci` never runs
 *   there (it would delete the node_modules the running app loads from)
 */
function createPostMergeServices(deps = {}) {
  const git = { updateLocalBase: worktrees.updateLocalBase, ...(deps.git || {}) };
  const skipInstall = (root) => {
    const app = deps.appPath ? deps.appPath() : null;
    return app && isInside(root, app) ? 'LunaCore runs from this checkout' : null;
  };

  const impls = {
    updateLocalBase: (ctx) => git.updateLocalBase(ctx.repoPath, ctx.base, { skipInstall }),
  };

  return { impls };
}

module.exports = { createPostMergeServices, isInside };
