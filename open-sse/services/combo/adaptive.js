/**
 * Adaptive combo routing — model ordering.
 *
 * Given a combo's candidate models, return them reordered by live health
 * (reliability × speed, rate-limit demotion) instead of the configured order.
 * The reordering happens before the normal failover loop, so the loop is
 * unchanged and still the backstop: if adaptive ordering is wrong, the loop
 * simply walks the rest of the list. Fail-safe by construction — any error
 * returns the original order, never an empty or partial list.
 */

import { scoreModel, DEFAULT_ADAPTIVE_PRESET } from "./adaptive-scoring.js";
import { getAdaptiveStats } from "./adaptive-state.js";

/**
 * @param {string[]} models  candidate combo models ("provider/model")
 * @param {object}  [options]
 * @param {string|object} [options.preset]  preset name ("reliable" | "balanced" |
 *                                           "fastest") or a custom {reliability, speed}
 * @param {boolean} [options.sampled=true]  true → Thompson sample per model (live
 *                                           routing: the draw IS the exploration, so
 *                                           interchangeable models share load);
 *                                           false → deterministic expected reliability
 *                                           (stable ordering for tests/display)
 * @param {Function} [options.getStats]     injectable stats source (tests)
 * @param {number} [options.now]            injectable clock (tests)
 * @returns {string[]} models reordered best-first; original order on any error
 */
export function orderAdaptiveModels(models, { preset = DEFAULT_ADAPTIVE_PRESET, sampled = true, getStats = getAdaptiveStats, now = Date.now() } = {}) {
  if (!models || models.length <= 1) return models;
  try {
    return models
      .map((model, index) => ({
        model,
        index,
        score: scoreModel(getStats(model, now), { preset, sampled }),
      }))
      .sort((a, b) => (b.score - a.score) || (a.index - b.index))
      .map((e) => e.model);
  } catch {
    return models;
  }
}

export { scoreModel, resolveAdaptiveWeights, ADAPTIVE_PRESETS, DEFAULT_ADAPTIVE_PRESET } from "./adaptive-scoring.js";
export { recordAttempt, getAdaptiveStats, resetAdaptiveState } from "./adaptive-state.js";
