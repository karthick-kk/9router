/**
 * Adaptive combo routing — pure scoring math.
 *
 * A Thompson-sampling bandit over a combo's models. Every request we draw a
 * reliability sample from each model's Beta posterior and blend it with a
 * latency score; a decaying 429 penalty then demotes (never fully excludes)
 * a model that is currently rate-limited. The result reorders the combo's
 * models before the normal failover loop runs, so a sick model is skipped
 * proactively instead of after a request has already paid for the failure.
 *
 * The math is adapted from the freellmapi router (scoring.ts): a convex
 * combination of normalized [0,1] axes, with guardrails that only ever pull a
 * model down as it gets dangerous and never reorder two healthy models
 * against each other.
 *
 * This module is deliberately I/O-free — it takes already-aggregated stats and
 * returns a score. State lives in adaptive-state.js; selection lives in
 * adaptive.js. Keeping it pure makes the ordering logic trivially unit-testable
 * and keeps the port rebase-friendly (no shared-file coupling).
 */

// ── Reliability: Beta posterior + Thompson sampling ─────────────────────────
//
// Beta(1,1) prior = uniform: an unseen model is genuinely uncertain, not
// assumed good or bad. Successes push alpha up, failures push beta up, and the
// decay handled in adaptive-state.js keeps old evidence from pinning a model.
// Sampling (rather than taking the mean) is the exploration: a model that just
// failed draws a low reliability this request and is skipped, but as the
// posterior re-inflates it comes back automatically — no timers, no hard bench.

export const PRIOR_SUCCESS = 1;
export const PRIOR_FAILURE = 1;

export function reliabilityPosterior(successes, failures) {
  return {
    alpha: Math.max(0, successes) + PRIOR_SUCCESS,
    beta: Math.max(0, failures) + PRIOR_FAILURE,
  };
}

// Deterministic expected reliability — for dashboard display / stable tests.
export function expectedReliability(successes, failures) {
  const { alpha, beta } = reliabilityPosterior(successes, failures);
  return alpha / (alpha + beta);
}

// Marsaglia & Tsang normal + gamma, used to sample a Beta via two Gamma draws.
function randomNormal() {
  const u1 = Math.random() || Number.EPSILON;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}

function sampleGamma(shape) {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random() || Number.EPSILON, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = randomNormal(); v = 1 + c * x; } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha, beta) {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  const sum = x + y;
  return sum > 0 ? x / sum : 0.5;
}

// ── Speed: time-to-response ──────────────────────────────────────────────────
//
// At the combo failover loop we learn, for each attempted model, how long the
// request took before a usable response came back. For a streaming response
// that is time-to-first-byte (fetch resolves once upstream sends headers); for
// a non-streaming one it is total time. Either way, a model that is degrading
// shows it here *before* it starts failing outright — a slow-but-200 model is
// still a real routing signal, which a pure success/fail counter misses.
//
// Linear ramp: full credit at BEST, zero at WORST. The window is wider than a
// generic LLM gateway because first-byte on a large model can legitimately run
// several seconds.

export const LATENCY_BEST_MS = 500;
export const LATENCY_WORST_MS = 15000;
// Optimistic prior so a model with no latency samples yet is not penalized.
export const LATENCY_PRIOR = 0.6;

export function latencyScore(avgMs) {
  // 0ms is a real "instant" attempt (millisecond clock), not a missing sample —
  // only null/undefined/negative/NaN mean "unmeasured".
  if (avgMs == null || !Number.isFinite(avgMs) || avgMs < 0) return LATENCY_PRIOR;
  if (avgMs <= LATENCY_BEST_MS) return 1;
  if (avgMs >= LATENCY_WORST_MS) return 0;
  return 1 - (avgMs - LATENCY_BEST_MS) / (LATENCY_WORST_MS - LATENCY_BEST_MS);
}

// ── Guardrail: live rate-limit penalty ───────────────────────────────────────
//
// A 429 (or an error the provider phrases as rate-limiting) bumps a penalty;
// the penalty decays over time (handled in adaptive-state.js) and maps here to
// a multiplier. At max penalty a model keeps 40% of its score — demoted hard
// but never excluded, so it recovers as the penalty decays rather than needing
// a manual reset.

export const PENALTY_MAX = 10;
export const PENALTY_MAX_DAMP = 0.6;

export function rateLimitFactor(penalty) {
  const p = Math.min(Math.max(0, penalty), PENALTY_MAX);
  return 1 - (p / PENALTY_MAX) * PENALTY_MAX_DAMP;
}

// ── Presets ───────────────────────────────────────────────────────────────────
//
// Each preset is just a (reliability, speed) weight pair summing to 1 — the
// engine is identical, only the emphasis changes. `custom` carries no default;
// the caller supplies a weight vector (the dashboard lets an operator set it).
//
// `reliable` is the default: for interchangeable models the operator usually
// just wants it to work, so reliability leads and speed keeps a slow model from
// winning. `fastest` is the mirror for latency-sensitive interactive use.

export const ADAPTIVE_PRESETS = {
  reliable: { reliability: 0.7, speed: 0.3 },
  balanced: { reliability: 0.5, speed: 0.5 },
  fastest: { reliability: 0.3, speed: 0.7 },
};

export const DEFAULT_ADAPTIVE_PRESET = "reliable";

/**
 * Resolve a preset name (or a custom weight object) to normalized weights.
 * Unknown preset names fall back to the default rather than throwing — routing
 * must never fail because a stored setting went stale.
 */
export function resolveAdaptiveWeights(preset) {
  if (preset && typeof preset === "object") {
    const rel = Number(preset.reliability);
    const speed = Number(preset.speed);
    if (Number.isFinite(rel) && Number.isFinite(speed) && rel + speed > 0) {
      const total = rel + speed;
      return { reliability: rel / total, speed: speed / total };
    }
  }
  const name = typeof preset === "string" ? preset : DEFAULT_ADAPTIVE_PRESET;
  return ADAPTIVE_PRESETS[name] || ADAPTIVE_PRESETS[DEFAULT_ADAPTIVE_PRESET];
}

// ── The combined score ───────────────────────────────────────────────────────
/**
 * Convex base (∈[0,1]) × the rate-limit guardrail.
 *
 * @param {object} inputs
 * @param {number} inputs.reliability  [0,1] — sampled (routing) or expected (display)
 * @param {number} inputs.latency      [0,1] — latencyScore of the model's avg latency
 * @param {number} inputs.rateLimit    [floor,1] — rateLimitFactor multiplier
 * @param {object} weights             { reliability, speed } — assumed to sum to 1,
 *                                     but renormalized so the base never leaves [0,1]
 * @returns {number} final score in [0,1]
 */
export function combineScore({ reliability, latency, rateLimit }, weights) {
  const wSum = weights.reliability + weights.speed || 1;
  const base =
    (weights.reliability * reliability + weights.speed * latency) / wSum;
  return base * rateLimit;
}

/**
 * Score one model from aggregated stats. `sampled` true → Thompson draw for
 * live routing (the per-call randomness the bandit needs for exploration);
 * false → deterministic expected reliability, for stable tests / display.
 *
 * @param {object} stats
 * @param {number} stats.successes  decay-weighted success pseudo-count
 * @param {number} stats.failures   decay-weighted failure pseudo-count
 * @param {number|null} stats.avgLatencyMs  avg time-to-response, or null if unmeasured
 * @param {number} stats.penalty    current (already decayed) 429 penalty, 0..PENALTY_MAX
 */
export function scoreModel(stats, { preset = DEFAULT_ADAPTIVE_PRESET, sampled = true } = {}) {
  const weights = resolveAdaptiveWeights(preset);
  const { successes, failures, avgLatencyMs, penalty } = stats;
  const { alpha, beta } = reliabilityPosterior(successes, failures);
  const reliability = sampled ? sampleBeta(alpha, beta) : expectedReliability(successes, failures);
  return combineScore(
    { reliability, latency: latencyScore(avgLatencyMs), rateLimit: rateLimitFactor(penalty) },
    weights,
  );
}
