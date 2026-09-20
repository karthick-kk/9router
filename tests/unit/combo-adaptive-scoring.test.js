import { describe, it, expect } from "vitest";

import {
  reliabilityPosterior,
  expectedReliability,
  sampleBeta,
  latencyScore,
  rateLimitFactor,
  resolveAdaptiveWeights,
  combineScore,
  scoreModel,
  LATENCY_BEST_MS,
  LATENCY_WORST_MS,
  LATENCY_PRIOR,
  PENALTY_MAX,
  PENALTY_MAX_DAMP,
  ADAPTIVE_PRESETS,
  DEFAULT_ADAPTIVE_PRESET,
} from "../../open-sse/services/combo/adaptive-scoring.js";

describe("reliability posterior (Beta)", () => {
  it("uses a Beta(1,1) uniform prior for an unseen model", () => {
    expect(reliabilityPosterior(0, 0)).toEqual({ alpha: 1, beta: 1 });
    expect(expectedReliability(0, 0)).toBeCloseTo(0.5);
  });

  it("shifts the mean toward success with successes and toward failure with failures", () => {
    // Mean is (s+1)/(s+f+2) — the Beta(1,1) prior counts as one of each, pulling
    // a 9:1 record from the raw 0.9 toward 0.833.
    expect(expectedReliability(9, 1)).toBeCloseTo(10 / 12); // ≈ 0.833
    expect(expectedReliability(1, 9)).toBeCloseTo(2 / 12); // ≈ 0.167
  });

  it("is monotonic in the success/failure ratio", () => {
    expect(expectedReliability(20, 0)).toBeGreaterThan(expectedReliability(20, 10));
    expect(expectedReliability(20, 10)).toBeGreaterThan(expectedReliability(0, 20));
  });
});

describe("sampleBeta", () => {
  it("always returns a value in [0, 1]", () => {
    for (let i = 0; i < 500; i++) {
      const v = sampleBeta(3, 2);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("tracks the posterior mean (Beta(11,2) samples high)", () => {
    // 10 successes / 1 failure → mean 11/13 ≈ 0.846. The sampled mean should
    // clearly exceed the uniform prior.
    const n = 400;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleBeta(11, 2);
    expect(sum / n).toBeGreaterThan(0.7);
  });

  it("is symmetric for a balanced posterior", () => {
    const n = 1000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleBeta(5, 5);
    expect(sum / n).toBeGreaterThan(0.42);
    expect(sum / n).toBeLessThan(0.58);
  });
});

describe("latencyScore", () => {
  it("returns the optimistic prior for unmeasured latency (null/undefined/negative/NaN)", () => {
    expect(latencyScore(null)).toBe(LATENCY_PRIOR);
    expect(latencyScore(undefined)).toBe(LATENCY_PRIOR);
    expect(latencyScore(-5)).toBe(LATENCY_PRIOR);
    expect(latencyScore(NaN)).toBe(LATENCY_PRIOR);
  });

  it("is full credit at/below the best threshold (0ms included) and zero at/above the worst", () => {
    expect(latencyScore(0)).toBe(1); // an instant attempt is full credit, not "unmeasured"
    expect(latencyScore(LATENCY_BEST_MS)).toBe(1);
    expect(latencyScore(LATENCY_WORST_MS)).toBe(0);
    expect(latencyScore(60000)).toBe(0);
  });

  it("is the midpoint exactly halfway between the thresholds", () => {
    const mid = (LATENCY_BEST_MS + LATENCY_WORST_MS) / 2;
    expect(latencyScore(mid)).toBeCloseTo(0.5);
  });

  it("is monotonically decreasing", () => {
    const a = latencyScore(1000);
    const b = latencyScore(5000);
    const c = latencyScore(12000);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
});

describe("rateLimitFactor", () => {
  it("is 1 with no penalty and the floor at max penalty", () => {
    expect(rateLimitFactor(0)).toBe(1);
    expect(rateLimitFactor(PENALTY_MAX)).toBeCloseTo(1 - PENALTY_MAX_DAMP);
  });

  it("is linear in the penalty", () => {
    expect(rateLimitFactor(PENALTY_MAX / 2)).toBeCloseTo(1 - PENALTY_MAX_DAMP / 2);
  });

  it("clamps out-of-range penalties", () => {
    expect(rateLimitFactor(99)).toBeCloseTo(1 - PENALTY_MAX_DAMP);
    expect(rateLimitFactor(-5)).toBe(1);
  });
});

describe("resolveAdaptiveWeights", () => {
  it("maps each preset to a weight pair summing to 1", () => {
    for (const name of Object.keys(ADAPTIVE_PRESETS)) {
      const w = resolveAdaptiveWeights(name);
      expect(w.reliability + w.speed).toBeCloseTo(1);
      expect(w.reliability).toBeGreaterThanOrEqual(0);
      expect(w.speed).toBeGreaterThanOrEqual(0);
    }
  });

  it("orders presets by reliability emphasis", () => {
    const r = resolveAdaptiveWeights("reliable").reliability;
    const b = resolveAdaptiveWeights("balanced").reliability;
    const f = resolveAdaptiveWeights("fastest").reliability;
    expect(r).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(f);
  });

  it("falls back to the default preset for an unknown name", () => {
    expect(resolveAdaptiveWeights("bogus")).toEqual(ADAPTIVE_PRESETS[DEFAULT_ADAPTIVE_PRESET]);
    expect(resolveAdaptiveWeights(null)).toEqual(ADAPTIVE_PRESETS[DEFAULT_ADAPTIVE_PRESET]);
    expect(resolveAdaptiveWeights(undefined)).toEqual(ADAPTIVE_PRESETS[DEFAULT_ADAPTIVE_PRESET]);
  });

  it("normalizes a custom weight object", () => {
    expect(resolveAdaptiveWeights({ reliability: 2, speed: 2 })).toEqual({ reliability: 0.5, speed: 0.5 });
  });

  it("rejects a malformed custom object and uses the default", () => {
    expect(resolveAdaptiveWeights({ reliability: 0, speed: 0 })).toEqual(ADAPTIVE_PRESETS[DEFAULT_ADAPTIVE_PRESET]);
    expect(resolveAdaptiveWeights({ reliability: "x", speed: 0.5 })).toEqual(ADAPTIVE_PRESETS[DEFAULT_ADAPTIVE_PRESET]);
  });
});

describe("combineScore", () => {
  it("is a convex base times the rate-limit multiplier", () => {
    // Weights sum to 2 → renormalized. base = (1*1 + 1*0.5)/2 = 0.75.
    expect(combineScore({ reliability: 1, latency: 0.5, rateLimit: 1 }, { reliability: 1, speed: 1 }))
      .toBeCloseTo(0.75);
  });

  it("applies the rate-limit demotion on top", () => {
    const full = combineScore({ reliability: 1, latency: 1, rateLimit: 1 }, ADAPTIVE_PRESETS.reliable);
    const damped = combineScore({ reliability: 1, latency: 1, rateLimit: 0.4 }, ADAPTIVE_PRESETS.reliable);
    expect(full).toBeCloseTo(1);
    expect(damped).toBeCloseTo(0.4);
  });

  it("never escapes [0,1] with normalized weights", () => {
    const w = resolveAdaptiveWeights("balanced");
    const v = combineScore({ reliability: 1, latency: 1, rateLimit: 1 }, w);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("scoreModel", () => {
  const RELIABLE = "reliable";

  it("scores a healthy model much higher than a failing one (deterministic)", () => {
    const good = scoreModel(
      { successes: 9, failures: 1, avgLatencyMs: null, penalty: 0 },
      { preset: RELIABLE, sampled: false },
    );
    const bad = scoreModel(
      { successes: 1, failures: 9, avgLatencyMs: null, penalty: 0 },
      { preset: RELIABLE, sampled: false },
    );
    expect(good).toBeGreaterThan(0.7);
    expect(bad).toBeLessThan(0.4);
    expect(good).toBeGreaterThan(bad);
  });

  it("demotes a rate-limited model below an otherwise-identical one", () => {
    const base = scoreModel(
      { successes: 10, failures: 0, avgLatencyMs: null, penalty: 0 },
      { preset: RELIABLE, sampled: false },
    );
    const limited = scoreModel(
      { successes: 10, failures: 0, avgLatencyMs: null, penalty: PENALTY_MAX },
      { preset: RELIABLE, sampled: false },
    );
    expect(limited).toBeLessThan(base);
    // Never fully excluded — keeps the floor fraction.
    expect(limited).toBeCloseTo(base * (1 - PENALTY_MAX_DAMP));
  });

  it("a fast healthy model beats a slow healthy one under the fastest preset", () => {
    const fast = scoreModel(
      { successes: 10, failures: 1, avgLatencyMs: 600, penalty: 0 },
      { preset: "fastest", sampled: false },
    );
    const slow = scoreModel(
      { successes: 10, failures: 1, avgLatencyMs: 14000, penalty: 0 },
      { preset: "fastest", sampled: false },
    );
    expect(fast).toBeGreaterThan(slow);
  });

  it("the sampled path stays in range and favors the healthy model across many draws", () => {
    let goodWins = 0;
    const trials = 300;
    for (let i = 0; i < trials; i++) {
      const g = scoreModel({ successes: 200, failures: 5, avgLatencyMs: null, penalty: 0 }, { preset: RELIABLE, sampled: true });
      const b = scoreModel({ successes: 5, failures: 200, avgLatencyMs: null, penalty: 0 }, { preset: RELIABLE, sampled: true });
      if (g > b) goodWins++;
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
    // With 200:5 vs 5:200 the healthy model should win essentially every draw.
    expect(goodWins).toBeGreaterThan(trials * 0.98);
  });
});
