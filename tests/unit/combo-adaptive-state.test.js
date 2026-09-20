import { describe, it, expect, beforeEach } from "vitest";

import { recordAttempt, getAdaptiveStats, resetAdaptiveState } from "../../open-sse/services/combo/adaptive-state.js";
import { PENALTY_MAX } from "../../open-sse/services/combo/adaptive-scoring.js";

const MIN = 60 * 1000;
const T0 = 1_700_000_000_000; // fixed clock for deterministic decay

describe("adaptive health state", () => {
  beforeEach(() => resetAdaptiveState());

  it("reports empty stats for an unseen model (uniform prior, no demotion)", () => {
    expect(getAdaptiveStats("p/a", T0)).toEqual({ successes: 0, failures: 0, avgLatencyMs: null, penalty: 0 });
  });

  it("accumulates successes, failures, and latency", () => {
    recordAttempt("p/a", true, { latencyMs: 1000, now: T0 });
    recordAttempt("p/a", true, { latencyMs: 3000, now: T0 });
    recordAttempt("p/a", false, { now: T0 });
    const s = getAdaptiveStats("p/a", T0);
    expect(s.successes).toBeCloseTo(2);
    expect(s.failures).toBeCloseTo(1);
    expect(s.avgLatencyMs).toBeCloseTo(2000);
    expect(s.penalty).toBe(0);
  });

  it("does not record latency for failures (a hung failure is a failure, not a speed sample)", () => {
    recordAttempt("p/a", false, { latencyMs: 9000, now: T0 });
    expect(getAdaptiveStats("p/a", T0).avgLatencyMs).toBeNull();
  });

  it("decays the tally on write (a recovered model is not held hostage by a bad hour)", () => {
    // 10 failures at T0.
    for (let i = 0; i < 10; i++) recordAttempt("p/a", false, { now: T0 });
    // Decay is applied on the NEXT write, not on read, so scoring stays a pure
    // read: until then the stored tally is unchanged.
    expect(getAdaptiveStats("p/a", T0 + 30 * MIN).failures).toBeCloseTo(10);
    // A write 3 half-lives later folds in 10 * e^-3 ≈ 0.5 of the old failures.
    recordAttempt("p/a", true, { latencyMs: 500, now: T0 + 90 * MIN });
    const s = getAdaptiveStats("p/a", T0 + 90 * MIN);
    expect(s.successes).toBeCloseTo(1);
    expect(s.failures).toBeLessThan(1);
  });

  it("keys state by model string, independent across models", () => {
    recordAttempt("p/a", false, { now: T0 });
    recordAttempt("p/b", true, { latencyMs: 800, now: T0 });
    expect(getAdaptiveStats("p/a", T0).failures).toBeCloseTo(1);
    expect(getAdaptiveStats("p/b", T0).successes).toBeCloseTo(1);
  });

  it("shares state across combos that include the same model (health is per-model)", () => {
    // Two different combos both route through p/a — a single failure is seen by both.
    recordAttempt("p/a", false, { now: T0 });
    expect(getAdaptiveStats("p/a", T0).failures).toBeCloseTo(1);
    // Scoring p/a from either combo's perspective uses the same tally.
    recordAttempt("p/a", false, { now: T0 });
    expect(getAdaptiveStats("p/a", T0).failures).toBeCloseTo(2);
  });
});

describe("429 penalty", () => {
  beforeEach(() => resetAdaptiveState());

  it("rises on rate-limited failures and saturates at the max", () => {
    recordAttempt("p/a", false, { rateLimited: true, now: T0 });
    const p1 = getAdaptiveStats("p/a", T0).penalty;
    expect(p1).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) recordAttempt("p/a", false, { rateLimited: true, now: T0 });
    expect(getAdaptiveStats("p/a", T0).penalty).toBeLessThanOrEqual(PENALTY_MAX + 1e-9);
  });

  it("does not rise on a plain (non-rate-limit) failure", () => {
    recordAttempt("p/a", false, { now: T0 });
    expect(getAdaptiveStats("p/a", T0).penalty).toBe(0);
  });

  it("decays over time so a cleared rate-limit window stops demoting", () => {
    for (let i = 0; i < 10; i++) recordAttempt("p/a", false, { rateLimited: true, now: T0 });
    const early = getAdaptiveStats("p/a", T0).penalty;
    // Penalty half-life is 10 min; after 60 min it is ~1/64th.
    const later = getAdaptiveStats("p/a", T0 + 60 * MIN).penalty;
    expect(early).toBeGreaterThan(0);
    expect(later).toBeLessThan(early * 0.05);
    expect(later).toBeGreaterThan(0); // decays, never hard-resets (still a tiny demotion)
  });
});

describe("reset", () => {
  it("clears all model state", () => {
    recordAttempt("p/a", true, { latencyMs: 500, now: T0 });
    resetAdaptiveState();
    expect(getAdaptiveStats("p/a", T0)).toEqual({ successes: 0, failures: 0, avgLatencyMs: null, penalty: 0 });
  });
});
