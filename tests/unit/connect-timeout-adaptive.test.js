import { describe, it, expect, beforeEach, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";

const MOD = path.resolve(__dirname, "../../open-sse/services/connect-timeout.js");
const MIN = 60 * 1000;
const T0 = 1_700_000_000_000; // fixed clock for deterministic windowing

// The module reads its config constants (feature flag, floor, ceiling…) from
// runtimeConfig at import time, so each scenario sets env then imports fresh.
async function loadTracker(env = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  const mod = await import(`${pathToFileURL(MOD).href}?t=${Math.random()}`);
  return mod;
}

async function fillFast(mod, provider, n, ttft = 2000) {
  for (let i = 0; i < n; i++) mod.recordLatency(provider, ttft, T0 + i);
}

describe("adaptive connect timeout", () => {
  const envBackup = {};
  beforeEach(() => {
    for (const k of ["ADAPTIVE_CONNECT_TIMEOUT", "ADAPTIVE_TIMEOUT_FLOOR_MS", "ADAPTIVE_TIMEOUT_MIN_SAMPLES", "FETCH_CONNECT_TIMEOUT_MS", "ADAPTIVE_TIMEOUT_HEADROOM"]) {
      if (!(k in envBackup)) envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });

  it("suggests nothing when the feature is off (static behavior preserved)", async () => {
    const mod = await loadTracker({ ADAPTIVE_CONNECT_TIMEOUT: undefined });
    await fillFast(mod, "p/fast", 20);
    expect(mod.suggestTimeout("p/fast", T0 + MIN)).toBeNull();
  });

  it("suggests nothing below the warmup sample count", async () => {
    const mod = await loadTracker({ ADAPTIVE_CONNECT_TIMEOUT: "1" });
    await fillFast(mod, "p/slow-start", 9); // one short of the default 10
    expect(mod.suggestTimeout("p/slow-start", T0 + MIN)).toBeNull();
  });

  it("p95 × headroom for a warm window (fast provider gets tightened)", async () => {
    const mod = await loadTracker({ ADAPTIVE_CONNECT_TIMEOUT: "1", ADAPTIVE_TIMEOUT_FLOOR_MS: "1000" });
    // 19 samples at 2s, one outlier at 10s: sorted idx = ceil(0.95*20)-1 = 18
    // → the 19th element = 2000 (outlier sits at idx 19). Suggestion = 2000×2.
    await fillFast(mod, "p/fast", 19);
    mod.recordLatency("p/fast", 10000, T0 + 19);
    expect(mod.suggestTimeout("p/fast", T0 + MIN)).toBe(4000);
  });

  it("clamps to the floor: never tightens below ADAPTIVE_TIMEOUT_FLOOR_MS", async () => {
    const mod = await loadTracker({ ADAPTIVE_CONNECT_TIMEOUT: "1", ADAPTIVE_TIMEOUT_FLOOR_MS: "15000" });
    await fillFast(mod, "p/instant", 20, 50); // instant responses → 50*2=100 < floor
    expect(mod.suggestTimeout("p/instant", T0 + MIN)).toBe(15000);
  });

  it("clamps to the static ceiling: adaptive can never loosen past FETCH_CONNECT_TIMEOUT_MS", async () => {
    const mod = await loadTracker({
      ADAPTIVE_CONNECT_TIMEOUT: "1",
      ADAPTIVE_TIMEOUT_FLOOR_MS: "1000",
      FETCH_CONNECT_TIMEOUT_MS: "90000",
      ADAPTIVE_TIMEOUT_HEADROOM: "2",
    });
    await fillFast(mod, "p/slow", 20, 60000); // 60s × 2 = 120s > 90s ceiling
    expect(mod.suggestTimeout("p/slow", T0 + MIN)).toBe(90000);
  });

  it("ages out stale samples: long-quiet provider falls back to null (static)", async () => {
    const mod = await loadTracker({ ADAPTIVE_CONNECT_TIMEOUT: "1" });
    await fillFast(mod, "p/quiet", 20);
    // 11 minutes later the whole window has expired (WINDOW_MS = 10 min)
    expect(mod.suggestTimeout("p/quiet", T0 + 11 * MIN)).toBeNull();
  });

  it("ignores nonsense samples (negative, NaN)", async () => {
    const mod = await loadTracker({ ADAPTIVE_CONNECT_TIMEOUT: "1", ADAPTIVE_TIMEOUT_FLOOR_MS: "1000" });
    mod.recordLatency("p/junk", -5, T0);
    mod.recordLatency("p/junk", NaN, T0);
    expect(mod.suggestTimeout("p/junk", T0 + MIN)).toBeNull();
    await fillFast(mod, "p/junk", 10);
    expect(mod.suggestTimeout("p/junk", T0 + MIN)).toBe(4000); // junk never entered the window
  });

  it("evicts on connect timeout: down-then-slower recovery is not strangled by stale fast samples", async () => {
    const mod = await loadTracker({ ADAPTIVE_CONNECT_TIMEOUT: "1", ADAPTIVE_TIMEOUT_FLOOR_MS: "1000", FETCH_CONNECT_TIMEOUT_MS: "90000" });
    // Healthy history: 2s × 20 → tight 4s budget.
    await fillFast(mod, "p/flapper", 20, 2000);
    expect(mod.suggestTimeout("p/flapper", T0 + MIN)).toBe(4000);
    // Provider goes down, then comes back slower (needs 40s). evictProvider()
    // drops the window → suggestion null → static 90s until it re-earns trust.
    mod.evictProvider("p/flapper");
    expect(mod.suggestTimeout("p/flapper", T0 + 2 * MIN)).toBeNull();
    // Rebuild on the new (slow) reality: 40s × 20 → 80s.
    await fillFast(mod, "p/flapper", 20, 40000);
    expect(mod.suggestTimeout("p/flapper", T0 + 3 * MIN)).toBe(80000);
  });

  it("summary reports only warm providers with p50/p95/suggested/evictions", async () => {
    const mod = await loadTracker({ ADAPTIVE_CONNECT_TIMEOUT: "1", ADAPTIVE_TIMEOUT_FLOOR_MS: "1000", FETCH_CONNECT_TIMEOUT_MS: "90000" });
    await fillFast(mod, "p/warm", 20, 2000);   // warm: shown
    mod.recordLatency("p/cold", 2000, T0);      // 1 sample: below warmup, hidden
    mod.evictProvider("p/warm");                // bump eviction counter
    await fillFast(mod, "p/warm", 20, 2000);    // re-warm after eviction (T0..T0+19)

    const rows = mod.getTrackerSummary(T0 + MIN);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("p/warm");
    expect(rows[0].samples).toBeGreaterThanOrEqual(10);
    expect(rows[0].p50).toBeGreaterThan(0);
    expect(rows[0].p95).toBeGreaterThanOrEqual(rows[0].p50);
    expect(rows[0].suggested).toBeGreaterThan(0);
    expect(rows[0].evictions).toBe(1);
  });

  it("keeps providers independent and respects the memory cap", async () => {
    const mod = await loadTracker({ ADAPTIVE_CONNECT_TIMEOUT: "1", ADAPTIVE_TIMEOUT_FLOOR_MS: "1000", FETCH_CONNECT_TIMEOUT_MS: "90000" });
    await fillFast(mod, "p/a", 20, 1000);
    await fillFast(mod, "p/b", 20, 30000); // 30s × 2 = 60s, under a 90s ceiling
    expect(mod.suggestTimeout("p/a", T0 + MIN)).toBe(2000);
    expect(mod.suggestTimeout("p/b", T0 + MIN)).toBe(60000);
    // Cap: push 100 samples, window must still answer (and only keep ≤50)
    await fillFast(mod, "p/a", 100, 1000);
    expect(mod.suggestTimeout("p/a", T0 + 2 * MIN)).toBe(2000);
  });
});
