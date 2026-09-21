import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  recordProbeResult,
  isModelOffline,
  isModelStable,
  getOfflineModels,
  filterOfflineModels,
  forgetModels,
  resetComboHealth,
  OFFLINE_THRESHOLD,
} from "../../src/sse/services/comboHealth.js";
import {
  runComboHealthTick,
  startComboHealthScheduler,
  stopComboHealthScheduler,
  readIntervalMs,
} from "../../src/sse/services/comboHealthScheduler.js";

const MODELS = ["9eric/deepseek-ai/Dead-Model", "9eric/Qwen/Live-Model"];

// Stub so ticks never touch the real settings repo/DB in unit tests.
const noSettings = { loadSettings: async () => ({ comboStrategies: {} }) };

beforeEach(() => {
  resetComboHealth();
  delete process.env.DISABLE_COMBO_HEALTH;
  globalThis.__comboHealthScheduler?.lastProbeAt?.clear(); // fresh probe-window state
});

afterEach(() => {
  stopComboHealthScheduler();
  vi.unstubAllGlobals();
});

describe("comboHealth registry", () => {
  it("treats unknown models as online", () => {
    expect(isModelOffline("9eric/unknown")).toBe(false);
    expect(filterOfflineModels(MODELS)).toEqual(MODELS);
  });

  it("stays online after a single failed probe", () => {
    recordProbeResult("m/one", { ok: false, error: "HTTP 500" });
    expect(isModelOffline("m/one")).toBe(false);
    expect(OFFLINE_THRESHOLD).toBeGreaterThan(1);
  });

  it("goes offline after OFFLINE_THRESHOLD consecutive failures", () => {
    for (let i = 0; i < OFFLINE_THRESHOLD - 1; i++) {
      recordProbeResult("m/one", { ok: false, error: "HTTP 500" });
    }
    expect(isModelOffline("m/one")).toBe(false);
    recordProbeResult("m/one", { ok: false, error: "HTTP 503" });
    expect(isModelOffline("m/one")).toBe(true);
  });

  it("resets the failure count on a successful probe", () => {
    recordProbeResult("m/one", { ok: false, error: "HTTP 500" });
    recordProbeResult("m/one", { ok: true });
    recordProbeResult("m/one", { ok: false, error: "HTTP 500" });
    expect(isModelOffline("m/one")).toBe(false);
  });

  it("one successful probe brings an offline model back online", () => {
    recordProbeResult("m/one", { ok: false, error: "HTTP 500" });
    recordProbeResult("m/one", { ok: false, error: "HTTP 500" });
    expect(isModelOffline("m/one")).toBe(true);
    expect(recordProbeResult("m/one", { ok: true })).toBe("online");
    expect(isModelOffline("m/one")).toBe(false);
  });

  it("returns transition events only on state change", () => {
    expect(recordProbeResult("m/one", { ok: false })).toBeNull();
    expect(recordProbeResult("m/one", { ok: false })).toBe("offline");
    expect(recordProbeResult("m/one", { ok: false })).toBeNull();
    expect(recordProbeResult("m/one", { ok: true })).toBe("online");
    expect(recordProbeResult("m/one", { ok: true })).toBeNull();
  });

  it("filter removes offline models, keeps the rest in order", () => {
    recordProbeResult("m/dead", { ok: false, error: "x" });
    recordProbeResult("m/dead", { ok: false, error: "x" });
    expect(filterOfflineModels(["m/dead", "m/a", "m/b", "m/c"])).toEqual(["m/a", "m/b", "m/c"]);
  });

  it("filter never returns an empty list — all-offline combo keeps its full order", () => {
    for (const m of MODELS) {
      recordProbeResult(m, { ok: false, error: "x" });
      recordProbeResult(m, { ok: false, error: "x" });
    }
    expect(filterOfflineModels(MODELS)).toEqual(MODELS);
  });

  it("getOfflineModels lists exactly the offline models", () => {
    recordProbeResult("m/dead", { ok: false, error: "x" });
    recordProbeResult("m/dead", { ok: false, error: "x" });
    expect(getOfflineModels()).toEqual(["m/dead"]);
  });
});

describe("comboHealth scheduler tick", () => {
  const combos = [
    { name: "jev-eric", models: ["9eric/Dead", "9eric/Live"] },
    { name: "eric-moa", models: ["9eric/Live", "9eric/Other"] },
  ];

  it("dedupes models across combos — each probed once per tick", async () => {
    const probed = [];
    await runComboHealthTick({
      ...noSettings,
      loadCombos: async () => combos,
      probe: async (m) => { probed.push(m); return { ok: true }; },
    });
    expect(probed.sort()).toEqual(["9eric/Dead", "9eric/Live", "9eric/Other"]);
  });

  it("marks a model offline after two consecutive failing ticks", async () => {
    const tick = (failDead) => runComboHealthTick({
      ...noSettings,
      loadCombos: async () => combos,
      probe: async (m) => (m === "9eric/Dead" && failDead ? { ok: false, error: "HTTP 503" } : { ok: true }),
    });

    await tick(true);
    expect(isModelOffline("9eric/Dead")).toBe(false);
    await tick(true);
    expect(isModelOffline("9eric/Dead")).toBe(true);
    expect(isModelOffline("9eric/Live")).toBe(false);
  });

  it("re-probes offline models every tick and recovers them on one success", async () => {
    let deadAlive = false;
    const tick = () => runComboHealthTick({
      ...noSettings,
      loadCombos: async () => combos,
      probe: async (m) => (m === "9eric/Dead"
        ? (deadAlive ? { ok: true } : { ok: false, error: "HTTP 503" })
        : { ok: true }),
    });

    await tick();
    await tick();
    expect(isModelOffline("9eric/Dead")).toBe(true);

    deadAlive = true;
    await tick();
    expect(isModelOffline("9eric/Dead")).toBe(false);
  });

  it("counts a probe that throws (e.g. timeout) as a failure", async () => {
    const tick = () => runComboHealthTick({
      ...noSettings,
      loadCombos: async () => combos,
      probe: async (m) => {
        if (m === "9eric/Dead") throw new Error("fetch timeout");
        return { ok: true };
      },
    });
    await tick();
    await tick();
    expect(isModelOffline("9eric/Dead")).toBe(true);
    expect(isModelOffline("9eric/Live")).toBe(false);
  });

  it("a failing loadCombos does not throw out of the tick", async () => {
    await expect(runComboHealthTick({
      ...noSettings,
      loadCombos: async () => { throw new Error("db down"); },
    })).resolves.toBeUndefined();
  });

  it("a failing loadSettings is fail-open — everything probed at default cadence", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    await expect(runComboHealthTick({
      loadSettings: async () => { throw new Error("settings down"); },
      loadCombos: async () => [{ name: "x", models: ["9eric/a"] }],
      probe,
    })).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("an empty combo list is a no-op", async () => {
    const probe = vi.fn();
    await runComboHealthTick({ ...noSettings, loadCombos: async () => [], probe });
    expect(probe).not.toHaveBeenCalled();
  });

  it("caps probe concurrency at 3 and preserves result order", async () => {
    const many = ["9eric/a", "9eric/b", "9eric/c", "9eric/d", "9eric/e", "9eric/f"];
    const combos = [{ name: "x", models: many }];
    let inFlight = 0, maxInFlight = 0;
    const order = [];
    await runComboHealthTick({
      ...noSettings,
      loadCombos: async () => combos,
      probe: async (m) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(m);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { ok: true };
      },
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    // Results recorded in combo order regardless of completion order.
    expect(order).toEqual(many);
  });

  it("one rejected probe doesn't reject the tick (fail-open per item)", async () => {
    await expect(runComboHealthTick({
      ...noSettings,
      loadCombos: async () => [{ name: "x", models: ["9eric/a", "9eric/b"] }],
      probe: async (m) => { if (m === "9eric/a") throw new Error("boom"); return { ok: true }; },
    })).resolves.toBeUndefined();
    // The other model still probed and recorded as online (not offline).
    expect(isModelOffline("9eric/b")).toBe(false);
  });
});

describe("comboHealth per-combo monitor settings", () => {
  it("no settings entry = monitored (default-on back-compat)", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    await runComboHealthTick({
      ...noSettings,
      loadCombos: async () => [{ name: "x", models: ["9eric/a"] }],
      probe,
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("health:false — model not probed and prior offline state cleared", async () => {
    recordProbeResult("9eric/Dead", { ok: false, error: "x" });
    recordProbeResult("9eric/Dead", { ok: false, error: "x" });
    expect(isModelOffline("9eric/Dead")).toBe(true);
    expect(filterOfflineModels(["9eric/Dead", "9eric/Live"])).toEqual(["9eric/Live"]);

    const probe = vi.fn(async () => ({ ok: true }));
    await runComboHealthTick({
      loadSettings: async () => ({ comboStrategies: { "x": { health: false } } }),
      loadCombos: async () => [{ name: "x", models: ["9eric/Dead", "9eric/Live"] }],
      probe,
    });
    expect(probe).not.toHaveBeenCalled();
    // State forgotten → unknown → full list routes again.
    expect(isModelOffline("9eric/Dead")).toBe(false);
    expect(filterOfflineModels(["9eric/Dead", "9eric/Live"])).toEqual(["9eric/Dead", "9eric/Live"]);
  });

  it("model in a monitored + an unmonitored combo stays probed", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    await runComboHealthTick({
      loadSettings: async () => ({ comboStrategies: { keep: { health: false } } }),
      loadCombos: async () => [
        { name: "keep", models: ["9eric/Shared"] },
        { name: "monitored", models: ["9eric/Shared", "9eric/Only"] },
      ],
      probe,
    });
    expect(probe).toHaveBeenCalledTimes(2); // both shared + only
    expect(isModelOffline("9eric/Shared")).toBe(false);
  });

  it("interval gating: stable model skipped inside its window, re-probed after", async () => {
    let now = 1_000_000;
    const deps = (strategies) => ({
      loadSettings: async () => ({ comboStrategies: strategies }),
      loadCombos: async () => [{ name: "x", models: ["9eric/slow"] }],
      probe: async () => ({ ok: true }),
      now: () => now,
    });
    const strategies = { x: { healthIntervalMin: 5 } };

    const probe = vi.fn(async () => ({ ok: true }));
    await runComboHealthTick({ ...deps(strategies), probe });
    expect(probe).toHaveBeenCalledTimes(1); // first tick: unknown → probe

    now += 60_000; // +1 min, inside the 5-min window, model stable
    await runComboHealthTick({ ...deps(strategies), probe });
    expect(probe).toHaveBeenCalledTimes(1);

    now += 5 * 60_000; // window elapsed
    await runComboHealthTick({ ...deps(strategies), probe });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("a failing model is probed every tick regardless of interval (fast failover)", async () => {
    let now = 1_000_000;
    const probe = vi.fn(async () => ({ ok: false, error: "HTTP 503" }));
    const deps = (strategies) => ({
      loadSettings: async () => ({ comboStrategies: strategies }),
      loadCombos: async () => [{ name: "x", models: ["9eric/sick"] }],
      probe,
      now: () => now,
    });
    const strategies = { x: { healthIntervalMin: 60 } };

    await runComboHealthTick({ ...deps(strategies) }); // fail #1
    expect(isModelOffline("9eric/sick")).toBe(false);
    now += 60_000;
    await runComboHealthTick({ ...deps(strategies) }); // fail #2 — NOT gated
    expect(isModelOffline("9eric/sick")).toBe(true);
    now += 60_000;
    await runComboHealthTick({ ...deps(strategies) }); // offline — still probed every tick
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("model removed from every combo gets its state cleared (no stale offline flag)", async () => {
    recordProbeResult("9eric/Ghost", { ok: false, error: "x" });
    recordProbeResult("9eric/Ghost", { ok: false, error: "x" });
    expect(isModelOffline("9eric/Ghost")).toBe(true);

    // Ghost is in no combo anymore (deleted / edited out).
    await runComboHealthTick({
      ...noSettings,
      loadCombos: async () => [{ name: "x", models: ["9eric/Live"] }],
      probe: async () => ({ ok: true }),
    });
    expect(isModelOffline("9eric/Ghost")).toBe(false);
    expect(filterOfflineModels(["9eric/Ghost"])).toEqual(["9eric/Ghost"]);
  });

  it("fastest interval wins when a model is in two monitored combos", async () => {
    let now = 1_000_000;
    const probe = vi.fn(async () => ({ ok: true }));
    const deps = {
      loadSettings: async () => ({
        comboStrategies: { fast: { healthIntervalMin: 1 }, slow: { healthIntervalMin: 60 } },
      }),
      loadCombos: async () => [
        { name: "fast", models: ["9eric/shared"] },
        { name: "slow", models: ["9eric/shared"] },
      ],
      probe,
      now: () => now,
    };

    await runComboHealthTick(deps); // probe #1
    expect(probe).toHaveBeenCalledTimes(1);

    now += 60_000; // 1 min: fast window elapsed (slow's 60-min has not)
    await runComboHealthTick(deps);
    expect(probe).toHaveBeenCalledTimes(2); // fastest cadence wins
  });
});

describe("comboHealth forgetModels + isModelStable", () => {
  it("forgetModels clears entries so models count as unknown/online again", () => {
    recordProbeResult("m/dead", { ok: false, error: "x" });
    recordProbeResult("m/dead", { ok: false, error: "x" });
    expect(isModelOffline("m/dead")).toBe(true);
    forgetModels(["m/dead", "m/unknown"]);
    expect(isModelOffline("m/dead")).toBe(false);
    expect(filterOfflineModels(["m/dead", "m/live"])).toEqual(["m/dead", "m/live"]);
  });

  it("isModelStable: unknown, suspect, and offline are all unstable", () => {
    expect(isModelStable("m/unknown")).toBe(false);
    recordProbeResult("m/suspect", { ok: false, error: "x" });
    expect(isModelStable("m/suspect")).toBe(false);
    recordProbeResult("m/ok", { ok: true });
    expect(isModelStable("m/ok")).toBe(true);
    recordProbeResult("m/ok", { ok: false, error: "x" });
    expect(isModelStable("m/ok")).toBe(false);
  });
});

describe("comboHealth scheduler lifecycle", () => {
  it("start is idempotent and stop resets it", () => {
    expect(startComboHealthScheduler()).toBe(true);
    expect(startComboHealthScheduler()).toBe(false);
    stopComboHealthScheduler();
    expect(startComboHealthScheduler()).toBe(true);
    stopComboHealthScheduler();
  });

  it("respects DISABLE_COMBO_HEALTH", () => {
    process.env.DISABLE_COMBO_HEALTH = "1";
    expect(startComboHealthScheduler()).toBe(false);
    stopComboHealthScheduler();
  });

  it("honors COMBO_HEALTH_INTERVAL_MS and ignores invalid values", () => {
    delete process.env.COMBO_HEALTH_INTERVAL_MS;
    expect(readIntervalMs()).toBe(60000);

    process.env.COMBO_HEALTH_INTERVAL_MS = "120000";
    expect(readIntervalMs()).toBe(120000);

    process.env.COMBO_HEALTH_INTERVAL_MS = "not-a-number";
    expect(readIntervalMs()).toBe(60000);

    process.env.COMBO_HEALTH_INTERVAL_MS = "500"; // below the 1s floor
    expect(readIntervalMs()).toBe(60000);

    delete process.env.COMBO_HEALTH_INTERVAL_MS;
  });
});
