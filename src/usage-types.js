// ============================================================================
// LunaCore - usage module type definitions (JSDoc)
// ----------------------------------------------------------------------------

/**
 * @typedef {Object} UsageLimit
 * @property {'5h'|'daily'|'weekly'|'monthly'|'balance'|'custom'} window
 *   The time window for this limit.
 * @property {string} label
 *   Human-readable label (e.g., "5-hour window", "Weekly limit").
 * @property {'messages'|'tokens'|'credits'|'currency'} unit
 *   Unit of measurement for the limit.
 * @property {number} used
 *   Current usage amount in this window.
 * @property {number} limit
 *   Maximum allowed in this window.
 * @property {number} percentUsed
 *   Percentage of limit used (0-100).
 * @property {'account'|'response_headers'|'manual'} source
 *   Where the data came from.
 */

/**
 * @typedef {Object} NormalizedUsage
 * @property {'claude'|'openai'|'glm'|'local'} providerId
 *   The provider identifier.
 * @property {string} displayName
 *   Human-readable provider name.
 * @property {'ok'|'loading'|'error'|'unsupported'|'unconfigured'} status
 *   Current status of the usage data.
 * @property {string|null} errorMessage
 *   Error message if status is 'error' or 'unconfigured'.
 * @property {UsageLimit[]} limits
 *   Array of limit objects for this provider.
 * @property {boolean} isFallback
 *   True if showing Claude usage while using a local model.
 * @property {number} updatedAt
 *   Timestamp when data was last fetched.
 */
