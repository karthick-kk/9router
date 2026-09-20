/**
 * Adaptive combo routing — per-model health state.
 *
 * An in-memory, decay-weighted tally of how each model in a combo has been
 * behaving: successes, failures, time-to-response, and a live 429 penalty.
 * Counts are keyed on the combo model string ("provider/model") and shared
 * across every combo that includes the model — if a model is down, it is down
 * in all of them, so health belongs to the model, not the combo.
 *
 * Why decay instead of a raw counter: a model that was flaky an hour ago but
 * has been fine since should not stay demoted. Every write applies an
 * exponential decay to the stored pseudo-counts for the time elapsed since the
 * last write, so the tally is always "what has been happening lately," with a
 * half-life rather than a hard cutoff. The 429 penalty decays on a shorter
 * half-life, matching how rate-limit windows actually clear.
 *
 * In-memory only, like the round-robin and composite-stage routing state: a
 * restart loses the history, which is safe — an empty state scores every model
 * at the uniform prior, i.e. it falls back to the configured model order. No
 * persistence is needed for a signal this ephemeral.
 */

import { PENALTY_MAX } from "./adaptive-scoring.js";

// Half-life for the success/failure/latency tally: recent behavior dominates,
// old behavior fades. 30 min is long enough that a healthy model's record is
// stable across a normal session, short enough that a recovered model is not
// held hostage by a bad hour.
const HALF_LIFE_MS = 30 * 60 * 1000;

// 429 penalty clears faster than general health — rate-limit windows roll over
// in minutes, so the demotion should too.
const PENALTY_HALF_LIFE_MS = 10 * 60 * 1000;
const PENALTY_PER_429 = 2; // consecutive 429s saturate the penalty within a few hits

// Safety net: drop models unseen for this long so the map can't grow without
// bound. Realistically a combo touches a handful of models, so this rarely fires.
const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const modelStates = new Map();
let sweepTimer = null;

function decay(elapsedMs) {
  if (elapsedMs <= 0) return 1;
  return Math.exp(-elapsedMs / HALF_LIFE_MS);
}

function decayPenalty(elapsedMs) {
  if (elapsedMs <= 0) return 1;
  return Math.exp(-elapsedMs / PENALTY_HALF_LIFE_MS);
}

function getOrCreate(model, now) {
  let s = modelStates.get(model);
  if (!s) {
    s = {
      successes: 0,
      failures: 0,
      latencySum: 0,
      latencyCount: 0,
      updatedAt: now,
      penalty: 0,
      penaltyAt: now,
      lastSeen: now,
    };
    modelStates.set(model, s);
  }
  return s;
}

/**
 * The current, time-decayed 429 penalty for a model. Reading it decays the
 * stored penalty toward zero as its window rolls over, without rewriting the
 * stored value (so a quiet model's penalty does not keep resetting its clock).
 */
function currentPenalty(s, now) {
  return s.penalty * decayPenalty(now - s.penaltyAt);
}

/**
 * Record one completed attempt at a model.
 *
 * @param {string} model            combo model string ("provider/model")
 * @param {boolean} success          whether the attempt returned a usable 2xx
 * @param {number} [latencyMs]       time-to-response for the attempt; only used on success
 * @param {boolean} [rateLimited]    true if the failure was a 429 / rate-limit error
 * @param {number} [now]             injectable clock for tests
 */
export function recordAttempt(model, success, { latencyMs = null, rateLimited = false, now = Date.now() } = {}) {
  if (!model) return;
  const s = getOrCreate(model, now);

  // Decay the stored tally for the time since the last write, then fold in this
  // attempt. Decaying on write (not on read) keeps scoring a pure read.
  const factor = decay(now - s.updatedAt);
  s.successes *= factor;
  s.failures *= factor;
  s.latencySum *= factor;
  s.latencyCount *= factor;
  s.updatedAt = now;
  s.lastSeen = now;

  if (success) {
    s.successes += 1;
    // 0ms is a real "instant" attempt (Date.now() clock), not a missing sample.
    if (latencyMs != null && Number.isFinite(latencyMs) && latencyMs >= 0) {
      s.latencySum += latencyMs;
      s.latencyCount += 1;
    }
  } else {
    s.failures += 1;
    if (rateLimited) {
      const base = currentPenalty(s, now);
      s.penalty = Math.min(PENALTY_MAX, base + PENALTY_PER_429);
      s.penaltyAt = now;
    }
  }
  maybeSweep();
}

/**
 * Aggregated stats for scoring a model. Models with no history return empty
 * stats, which scoreModel treats as the uniform prior (no demotion, optimistic
 * latency) — so an unknown model is never penalized for being unseen.
 */
export function getAdaptiveStats(model, now = Date.now()) {
  const s = modelStates.get(model);
  if (!s) return { successes: 0, failures: 0, avgLatencyMs: null, penalty: 0 };

  // Latency mean uses the raw (already decayed-on-write) tally.
  const avgLatencyMs = s.latencyCount > 0 ? s.latencySum / s.latencyCount : null;
  return {
    successes: s.successes,
    failures: s.failures,
    avgLatencyMs,
    penalty: currentPenalty(s, now),
  };
}

/** Test / config-change seam: drop all adaptive health state. */
export function resetAdaptiveState() {
  modelStates.clear();
}

function maybeSweep() {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    const cutoff = Date.now() - SWEEP_AFTER_MS;
    for (const [model, s] of modelStates) {
      if (s.lastSeen < cutoff) modelStates.delete(model);
    }
  }, SWEEP_INTERVAL_MS);
  // The sweep is a bounded-memory nicety; it must never keep the process alive.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}
