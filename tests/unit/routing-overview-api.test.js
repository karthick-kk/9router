import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPricingForModel, calculateCostFromTokens } from "open-sse/providers/pricing.js";

// End-to-end test of the real math: queryOverview runs against a sandboxed
// SQLite DB (temp DATA_DIR, same pattern as routing-decisions-repo.test.js).
// usageHistory rows are inserted directly (the table exists after schema sync);
// routingDecisions rows go through recordDecision + backfillOutcome so the
// latency path exercises the real JSON encoding.
//
// Model choice: both names are exact MODEL_PRICING entries, so the "capable"
// ranking is deterministic (no pattern-glob or unknown-model fallback involved):
//   claude-opus-4-6 → input $5.00/1M, output $25.00/1M
//   gpt-4o-mini     → input $0.15/1M, output $0.60/1M
const OPUS = "claude-opus-4-6";
const MINI = "gpt-4o-mini";
const PROV = "testprov"; // no PROVIDER_PRICING override for this provider

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-overview-test-"));
process.env.DATA_DIR = tmp;
global._dbAdapter = { instance: null, initPromise: null, logged: false };

let repo;
let db;
beforeAll(async () => {
  const driver = await import("../../src/lib/db/driver.js");
  db = await driver.getAdapter();
  repo = await import("../../src/lib/db/repos/routingDecisionsRepo.js");
  await seed();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ALPHA_ROWS = [
  { ts: "2026-09-10T07:00:00.000Z", model: OPUS, in: 1_000_000, out: 100_000, cost: 7.5, status: "ok" },
  { ts: "2026-09-10T08:00:00.000Z", model: MINI, in: 1_000_000, out: 100_000, cost: 0.21, status: "ok" },
  { ts: "2026-09-11T09:00:00.000Z", model: MINI, in: 2_000_000, out: 200_000, cost: 0.42, status: "error" },
];
// Expected alpha cost in the same row order the repo sums them: 7.5 + 0.21 + 0.42
const ALPHA_COST = 7.5 + 0.21 + 0.42;
const opusPricing = getPricingForModel(PROV, OPUS);
const miniPricing = getPricingForModel(PROV, MINI);
const costAt = (pricing, i, o) => calculateCostFromTokens({ prompt_tokens: i, completion_tokens: o }, pricing);
const ALPHA_BASELINE =
  costAt(opusPricing, ALPHA_ROWS[0].in, ALPHA_ROWS[0].out) +
  costAt(opusPricing, ALPHA_ROWS[1].in, ALPHA_ROWS[1].out) +
  costAt(opusPricing, ALPHA_ROWS[2].in, ALPHA_ROWS[2].out); // 7.5 + 7.5 + 15 = 30
const ALPHA_SAVED = ALPHA_BASELINE - ALPHA_COST;

const USAGE_SQL = `INSERT INTO usageHistory (timestamp, provider, model, promptTokens, completionTokens, cost, status, meta)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

async function seed() {
  // alpha: 2 cheap turns + 1 capable turn, one errored row, two different days.
  for (const r of ALPHA_ROWS) {
    db.run(USAGE_SQL, [r.ts, PROV, r.model, r.in, r.out, r.cost, r.status, JSON.stringify({ combo: "alpha", comboStrategy: "composite-stage" })]);
  }
  // beta: one old turn + one turn today (survives a 7d window).
  db.run(USAGE_SQL, ["2026-09-10T07:30:00.000Z", PROV, MINI, 500_000, 50_000, 0.105, "ok", JSON.stringify({ combo: "beta", comboStrategy: "jev" })]);
  db.run(USAGE_SQL, [new Date().toISOString(), PROV, MINI, 100_000, 10_000, 0.021, "ok", JSON.stringify({ combo: "beta", comboStrategy: "jev" })]);
  // Untagged row (excluded by the SQL filter) and a corrupt-meta row (must be
  // skipped by the parse guard, not crash the query).
  db.run(USAGE_SQL, ["2026-09-10T08:00:00.000Z", PROV, MINI, 1, 1, 0, "ok", "{}"]);
  db.run(USAGE_SQL, ["2026-09-10T08:00:00.000Z", PROV, MINI, 1, 1, 0, "ok", '{"combo": "ghost"']);

  // Latency: alpha has 2 backfilled outcomes (1000, 2000) + 1 unbackfilled.
  const a1 = await repo.recordDecision({ combo: "alpha", strategy: "composite-stage", source: "composite-stage", reason: "test" });
  await repo.backfillOutcome(a1, { served: OPUS, success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 1000 });
  const a2 = await repo.recordDecision({ combo: "alpha", strategy: "composite-stage", source: "composite-stage", reason: "test" });
  await repo.backfillOutcome(a2, { served: MINI, success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 2000 });
  await repo.recordDecision({ combo: "alpha", strategy: "composite-stage", source: "composite-stage", reason: "test" }); // outcome stays NULL

  // beta: one recent outcome (500) + one 30-day-old outcome (99999) that must
  // drop out of the 7d window.
  const b1 = await repo.recordDecision({ combo: "beta", strategy: "jev", source: "jev", reason: "test" });
  await repo.backfillOutcome(b1, { served: MINI, success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 500 });
  db.run(
    `INSERT INTO routingDecisions (id, timestamp, combo, strategy, sessionId, turn, source, reason, picked, confidence, scores, preview, classifierMs, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ["old-beta-1", Date.now() - 30 * 86400000, "beta", "jev", null, 1, "manual", "test", null, null, "{}", "", null]
  );
  await repo.backfillOutcome("old-beta-1", { served: MINI, success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 99999 });
}

const overview = (opts) => repo.queryOverview(opts);

describe("queryOverview (GET /api/routing/overview data layer)", () => {
  it("sanity: the pricing table knows both test models", () => {
    expect(opusPricing?.input).toBe(5.0);
    expect(miniPricing?.input).toBe(0.15);
  });

  it("aggregates per-combo spend, tokens and error rate from usageHistory", async () => {
    const { combos, available, period } = await overview({ period: "all" });
    expect(period).toBe("all");
    expect(available).toEqual(["alpha", "beta"]);
    expect(combos).toHaveLength(2);
    const alpha = combos.find((c) => c.combo === "alpha");
    expect(alpha.strategy).toBe("composite-stage");
    expect(alpha.requests).toBe(3);
    expect(alpha.promptTokens).toBe(4_000_000);
    expect(alpha.completionTokens).toBe(400_000);
    expect(alpha.cost).toBeCloseTo(ALPHA_COST, 4);
    expect(alpha.errorRate).toBe(0.3333); // 1 of 3 rows has status != "ok"
  });

  it("marks the highest input-priced observed model as capable and prices the baseline at its rate", async () => {
    const { combos } = await overview({ period: "all" });
    const alpha = combos.find((c) => c.combo === "alpha");
    expect(alpha.capableModel).toBe(OPUS);
    expect(alpha.baselineCost).toBeCloseTo(ALPHA_BASELINE, 4);
    expect(alpha.saved).toBeCloseTo(ALPHA_SAVED, 4);
    // Same rounding as savedPct in queryOverview (src/lib/db/repos/routingDecisionsRepo.js): ×1000 then /10.
    expect(alpha.savedPct).toBe(Math.round((ALPHA_SAVED / ALPHA_BASELINE) * 1000) / 10); // 72.9
    expect(alpha.capableShare).toBe(33.3); // 1 capable call / 3 requests
  });

  it("averages finite backfilled outcome latencies in the window", async () => {
    const { combos } = await overview({ period: "all" });
    const alpha = combos.find((c) => c.combo === "alpha");
    expect(alpha.avgLatencyMs).toBe(1500); // (1000 + 2000) / 2; NULL outcome ignored
  });

  it("reports a single-model combo with zero savings and 100% capable share", async () => {
    const { combos } = await overview({ period: "all" });
    const beta = combos.find((c) => c.combo === "beta");
    expect(beta.requests).toBe(2);
    expect(beta.capableModel).toBe(MINI);
    expect(beta.saved).toBeCloseTo(0, 4);
    expect(beta.savedPct).toBe(0);
    expect(beta.capableShare).toBe(100);
    expect(beta.avgLatencyMs).toBe(50250); // (500 + 99999) / 2 over period=all
  });

  it("buckets the savings trend by day, ascending, recomputing saved per bucket at capable pricing", async () => {
    const { combos } = await overview({ period: "all" });
    const alpha = combos.find((c) => c.combo === "alpha");
    expect(alpha.series).toHaveLength(2);
    const [d1, d2] = alpha.series;
    expect(d1.bucket).toBe("2026-09-10");
    expect(d1.requests).toBe(2);
    expect(d1.cost).toBeCloseTo(7.5 + 0.21, 4);
    expect(d1.saved).toBeCloseTo(15 - (7.5 + 0.21), 4); // 2M in + 200K out at opus = $15
    expect(d2.bucket).toBe("2026-09-11");
    expect(d2.requests).toBe(1);
    expect(d2.cost).toBeCloseTo(0.42, 4);
    expect(d2.saved).toBeCloseTo(15 - 0.42, 4);
  });

  it("filters combos to the selected combo but keeps available unfiltered", async () => {
    const { combos, available } = await overview({ period: "all", combo: "alpha" });
    expect(combos).toHaveLength(1);
    expect(combos[0].combo).toBe("alpha");
    expect(available).toEqual(["alpha", "beta"]);
  });

  it("returns an empty list for a combo that is not in the window", async () => {
    const { combos, available } = await overview({ period: "all", combo: "nope" });
    expect(combos).toEqual([]);
    expect(available).toEqual(["alpha", "beta"]);
  });

  it("skips corrupt meta rows without crashing the whole query", async () => {
    const { combos, available } = await overview({ period: "all" });
    expect(available).not.toContain("ghost");
    expect(combos).toHaveLength(2);
  });

  it("applies the window to both usageHistory (ISO text) and routingDecisions (ms integer)", async () => {
    const { combos, available } = await overview({ period: "7d" });
    // 2026-09-10 rows are 11 days old; only today's beta row survives.
    expect(available).toEqual(["beta"]);
    const beta = combos.find((c) => c.combo === "beta");
    expect(beta.requests).toBe(1);
    expect(beta.cost).toBeCloseTo(0.021, 4);
    // The 30-day-old 99999ms outcome is outside the window; only the recent 500ms counts.
    expect(beta.avgLatencyMs).toBe(500);
  });

  it("falls back to today for an unknown period", async () => {
    const { period, available } = await overview({ period: "bogus" });
    expect(period).toBe("today");
    expect(available).toEqual(["beta"]); // only the row inserted today is in scope
  });
});
