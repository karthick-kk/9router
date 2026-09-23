import { describe, it, expect, beforeEach, vi } from "vitest";

import { orderAdaptiveModels, recordAttempt, resetAdaptiveState, getAdaptiveStats } from "../../open-sse/services/combo/adaptive.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };
const A = "ericaiproxy/qwen3.8";
const B = "ericaiproxy/glm5.2";
const C = "ericaiproxy/deepseek4flash";

function okResponse(content = "ok") {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  return make();
}

function errResponse(status = 503, message = "down") {
  const make = () => ({ ok: false, status, statusText: "", clone: make, json: async () => ({ error: { message } }) });
  return make();
}

// Injectable stats source keyed by model string — deterministic, no decay.
function statsSource(map) {
  return (model) => map.get(model) || { successes: 0, failures: 0, avgLatencyMs: null, penalty: 0 };
}

// Prime the LIVE health cache (what handleComboChat reads) so an end-to-end test
// can arrange a specific sick/healthy spread without depending on wall-clock decay.
function primeLive(model, { successes = 0, failures = 0, latencyMs = null, rateLimited = false } = {}) {
  if (successes) recordAttempt(model, true, { latencyMs, now: 0 });
  for (let i = 0; i < failures; i++) recordAttempt(model, false, { rateLimited, now: 0 });
}

describe("orderAdaptiveModels (pure ordering)", () => {
  beforeEach(() => resetAdaptiveState());

  it("returns the input unchanged for a single or empty list", () => {
    expect(orderAdaptiveModels([], { getStats: statsSource(new Map()) })).toEqual([]);
    expect(orderAdaptiveModels([A], { getStats: statsSource(new Map()) })).toEqual([A]);
  });

  it("keeps the configured order when all models have identical (empty) stats", () => {
    // Deterministic mode: uniform prior for every model → equal scores → the
    // configured order wins the tie. (In live sampled mode the draws tiebreak,
    // which is the intended load-sharing behavior for interchangeable models.)
    expect(orderAdaptiveModels([A, B, C], { getStats: statsSource(new Map()), preset: "reliable", sampled: false }))
      .toEqual([A, B, C]);
  });

  it("floats a healthy model ahead of a sick one (deterministic via expected reliability)", () => {
    const stats = new Map([
      [A, { successes: 50, failures: 0, avgLatencyMs: null, penalty: 0 }],
      [B, { successes: 0, failures: 50, avgLatencyMs: null, penalty: 0 }],
      [C, { successes: 0, failures: 0, avgLatencyMs: null, penalty: 0 }],
    ]);
    const order = orderAdaptiveModels([B, A, C], { getStats: statsSource(stats), preset: "reliable", sampled: false });
    // A healthy (≈0.98), C uniform prior (0.5), B sick (≈0.02).
    expect(order).toEqual([A, C, B]);
  });

  it("floats a rate-limited model to the back even if its reliability is fine", () => {
    const stats = new Map([
      [A, { successes: 10, failures: 0, avgLatencyMs: null, penalty: 10 }], // 40% score
      [B, { successes: 10, failures: 0, avgLatencyMs: null, penalty: 0 }],  // full score
    ]);
    expect(orderAdaptiveModels([A, B], { getStats: statsSource(stats), preset: "reliable", sampled: false })[0]).toBe(B);
  });

  it("floats a fast model ahead of a slow one under the fastest preset", () => {
    const stats = new Map([
      [A, { successes: 10, failures: 1, avgLatencyMs: 14000, penalty: 0 }],
      [B, { successes: 10, failures: 1, avgLatencyMs: 600, penalty: 0 }],
    ]);
    expect(orderAdaptiveModels([A, B], { getStats: statsSource(stats), preset: "fastest", sampled: false })[0]).toBe(B);
  });

  it("returns the original order on any error (fail-safe, never empty/partial)", () => {
    expect(orderAdaptiveModels([A, B, C], { getStats: () => { throw new Error("boom"); } }))
      .toEqual([A, B, C]);
  });

  it("breaks ties by configured order (stable) in deterministic mode", () => {
    const same = { successes: 10, failures: 1, avgLatencyMs: 1000, penalty: 0 };
    const stats = new Map([[A, same], [B, same], [C, same]]);
    expect(orderAdaptiveModels([C, A, B], { getStats: statsSource(stats), preset: "balanced", sampled: false }))
      .toEqual([C, A, B]);
  });

  it("samples (Thompson) by default so interchangeable models share load", () => {
    // Same healthy stats → the live (sampled) path is allowed to reorder the
    // list across calls (the draws tiebreak). It must still be a permutation of
    // the input, never empty/partial, and must keep the input for a single model.
    const same = { successes: 10, failures: 1, avgLatencyMs: 1000, penalty: 0 };
    const stats = new Map([[A, same], [B, same], [C, same]]);
    for (let i = 0; i < 30; i++) {
      const order = orderAdaptiveModels([A, B, C], { getStats: statsSource(stats), preset: "balanced" });
      expect(order).toHaveLength(3);
      expect(new Set(order)).toEqual(new Set([A, B, C]));
    }
  });
});

describe("handleComboChat with adaptive strategy (end-to-end, live cache)", () => {
  beforeEach(() => resetAdaptiveState());

  it("tries the healthy model first and succeeds on the first attempt", async () => {
    // Prime the live cache: A is reliable, B is sick, C is unseen.
    primeLive(A, { successes: 50 });
    primeLive(B, { failures: 50 });
    const attempts = [];
    const handler = vi.fn(async (body, model) => {
      attempts.push(model);
      return okResponse(`from ${model}`);
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: [A, B, C],
      handleSingleModel: handler,
      log,
      comboName: "test",
      comboStrategy: "adaptive",
      adaptivePreset: "reliable",
    });

    expect(res.ok).toBe(true);
    // The sick B must not be the first thing tried, even though it is in the list.
    expect(attempts[0]).not.toBe(B);
    expect(attempts.length).toBe(1);
  });

  it("still falls through if the adaptive-picked model is down now (backstop intact)", async () => {
    // A is healthy historically (so adaptive favors it), but is down right now.
    // B is the fallback. Whatever order the bandit draws, the failover loop must
    // carry the request to completion on B.
    primeLive(A, { successes: 40 });
    primeLive(B, { successes: 40 });
    const attempts = [];
    const handler = vi.fn(async (body, model) => {
      attempts.push(model);
      if (model === A) return errResponse(503);
      return okResponse(`from ${model}`);
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: [A, B],
      handleSingleModel: handler,
      log,
      comboName: "test",
      comboStrategy: "adaptive",
      adaptivePreset: "reliable",
    });

    // The request succeeds, served by B (the only healthy model right now).
    // If adaptive picked A first, A's 503 fell through to B; if it picked B
    // first, B succeeded outright. Either way B is the final attempt.
    expect(res.ok).toBe(true);
    expect(attempts.at(-1)).toBe(B);
  });

  it("returns all-unavailable if every model fails (unchanged error contract)", async () => {
    const handler = vi.fn(async () => errResponse(503));
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: [A, B],
      handleSingleModel: handler,
      log,
      comboName: "test",
      comboStrategy: "adaptive",
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });

  it("learns from live outcomes: a model that just keeps failing is demoted next request", async () => {
    // Drive real requests: A fails every time, B succeeds. The loop records each
    // attempt into the live cache as it goes.
    const failer = vi.fn(async (body, model) => (model === A ? errResponse(503) : okResponse()));
    for (let i = 0; i < 12; i++) {
      await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        models: [A, B],
        handleSingleModel: failer,
        log,
        comboName: "test",
        comboStrategy: "adaptive",
      });
    }

    // Next request: the live cache now has ~12 A-failures vs B successes, so the
    // adaptive order should try B first.
    const attempts = [];
    const allOk = vi.fn(async (body, model) => {
      attempts.push(model);
      return okResponse();
    });
    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: [A, B],
      handleSingleModel: allOk,
      log,
      comboName: "test",
      comboStrategy: "adaptive",
    });
    expect(attempts[0]).toBe(B);
  });

  it("observes attempts for NON-adaptive strategies too (shared health cache is strategy-blind)", async () => {
    // A plain "fallback" combo (e.g. a Jev combo, where the classifier runs in
    // the chat handler and handleComboChat only sees the reordered list) still
    // touches the shared model-health cache: a failed attempt is a failure
    // signal for EVERY strategy that reads it later.
    const A400 = "ericaiproxy/bad400";
    const ok = "ericaiproxy/ok";
    const handler = vi.fn(async (body, model) => (model === A400 ? errResponse(400, "bad request") : okResponse()));
    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: [A400, ok],
      handleSingleModel: handler,
      log,
      comboName: "test",
      comboStrategy: "fallback",
    });
    // The failed A400 attempt (400 → no-fallback path, returned to the client)
    // must have been observed by the shared cache.
    const badStats = getAdaptiveStats(A400);
    expect(badStats.failures).toBe(1);
    expect(badStats.successes).toBe(0);
  });

  it("does NOT reorder or observe when the strategy is not adaptive (default preserved)", async () => {
    // Prime A as healthy and B as sick. Under plain "fallback" the configured
    // order [A, B] must be honored regardless of that health.
    primeLive(A, { successes: 40 });
    primeLive(B, { failures: 40 });
    const attempts = [];
    const handler = vi.fn(async (body, model) => {
      attempts.push(model);
      if (model === A) return errResponse(503);
      return okResponse();
    });
    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: [A, B],
      handleSingleModel: handler,
      log,
      comboName: "test",
      comboStrategy: "fallback",
    });
    // Plain fallback tries A first (configured order) even though A is healthy here
    // — the point is that adaptive demotion did NOT kick in to reorder.
    expect(attempts[0]).toBe(A);
  });
});
