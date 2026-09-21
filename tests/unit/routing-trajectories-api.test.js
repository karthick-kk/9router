import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Two route concerns share one sandboxed SQLite DB (temp DATA_DIR, same pattern
// as routing-overview-api.test.js): the trajectories route reads routingDecisions
// through the real repo, and the models route reads usageHistory through the real
// repo. The two in-memory SSE-side registries are process-global Maps, so they are
// mocked to make the models route's inHealth enrichment deterministic without
// touching real state.
vi.mock("../../src/sse/services/comboHealth.js", () => ({
  isModelOffline: (m) => m === "p/Offline",
}));
vi.mock("../../open-sse/services/combo/adaptive-state.js", () => ({
  getAdaptiveStats: (m) =>
    m === "p/Healthy"
      ? { successes: 5, failures: 1, avgLatencyMs: 100, penalty: 0 }
      : { successes: 0, failures: 0, avgLatencyMs: null, penalty: 0 },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-traj-models-test-"));
process.env.DATA_DIR = tmp;
global._dbAdapter = { instance: null, initPromise: null, logged: false };

let db;
let repo;
let GET_TRAJ;
let GET_MODELS;

beforeAll(async () => {
  const driver = await import("../../src/lib/db/driver.js");
  db = await driver.getAdapter();
  repo = await import("../../src/lib/db/repos/routingDecisionsRepo.js");
  ({ GET: GET_TRAJ } = await import("../../src/app/api/routing/trajectories/route.js"));
  ({ GET: GET_MODELS } = await import("../../src/app/api/routing/models/route.js"));
  await seedUsage();
  await seedTrajectories();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Models-route seed: three provider/model keys, one per inHealth case.
//   p/Healthy -> has adaptive stats (mock), not offline
//   p/Offline -> offline (mock), zero adaptive stats
//   p/Unknown -> in neither registry (fail-open)
const USAGE_SQL = `INSERT INTO usageHistory (timestamp, provider, model, promptTokens, completionTokens, cost, status, meta)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

async function seedUsage() {
  const now = new Date().toISOString(); // within the default "today" window
  // p/Healthy: 2 rows, 1 errored -> errorRate 0.5, cost 0.75.
  db.run(USAGE_SQL, [now, "p", "Healthy", 1000, 100, 0.5, "ok", "{}"]);
  db.run(USAGE_SQL, [now, "p", "Healthy", 2000, 200, 0.25, "error", "{}"]);
  // p/Offline: 1 ok row, cost 0.10.
  db.run(USAGE_SQL, [now, "p", "Offline", 500, 50, 0.1, "ok", "{}"]);
  // p/Unknown: 1 errored row, cost 0.20.
  db.run(USAGE_SQL, [now, "p", "Unknown", 300, 30, 0.2, "error", "{}"]);
}

// Trajectories-route seed: combo "alpha" has two sessions (s1 with two
// high-confidence turns, one of which fails over; s2 with one low-confidence
// turn), plus combo "beta" so the picker lists two combos.
async function seedTrajectories() {
  let id = await repo.recordDecision({ combo: "alpha", strategy: "composite-stage", sessionId: "s1", turn: 1, source: "composite-stage", reason: "classifier", confidence: 0.9 });
  await repo.backfillOutcome(id, { served: "p/Healthy", success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 100 });
  id = await repo.recordDecision({ combo: "alpha", strategy: "composite-stage", sessionId: "s1", turn: 2, source: "composite-stage", reason: "classifier", confidence: 0.85 });
  await repo.backfillOutcome(id, { served: "p/Offline", success: false, fellOver: true, fellOverTo: "p/Healthy", status: 500, latencyMs: 300 });
  id = await repo.recordDecision({ combo: "alpha", strategy: "composite-stage", sessionId: "s2", turn: 1, source: "composite-stage", reason: "classifier", confidence: 0.2 });
  await repo.backfillOutcome(id, { served: "p/Healthy", success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 80 });
  id = await repo.recordDecision({ combo: "beta", strategy: "jev", sessionId: "sb1", turn: 1, source: "jev", reason: "classifier", confidence: 0.5 });
  await repo.backfillOutcome(id, { served: "p/Unknown", success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 120 });
}

describe("GET /api/routing/trajectories", () => {
  const call = (qs) => GET_TRAJ({ url: `http://localhost:20128/api/routing/trajectories${qs}` });

  it("groups decisions into sessions with ascending turns", async () => {
    const res = await call("?combo=alpha&limit=50");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.combo).toBe("alpha");
    expect(Array.isArray(json.sessions)).toBe(true);
    expect(json.sessions).toHaveLength(2); // s1 + s2
    const byId = Object.fromEntries(json.sessions.map((s) => [s.sessionId, s]));
    expect(byId.s1.turns).toHaveLength(2);
    expect(byId.s2.turns).toHaveLength(1);
    expect(byId.s1.turns[0].turn).toBe(1);
    expect(byId.s1.turns[1].turn).toBe(2);
  });

  it("caps the number of sessions at limit", async () => {
    const json = await (await call("?combo=alpha&limit=1")).json();
    expect(json.sessions).toHaveLength(1);
  });

  it("filters rows by maxConf", async () => {
    const json = await (await call("?combo=alpha&maxConf=0.5")).json();
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0].sessionId).toBe("s2");
  });

  it("filters rows by minConf", async () => {
    const json = await (await call("?combo=alpha&minConf=0.8")).json();
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0].sessionId).toBe("s1");
    expect(json.sessions[0].turns).toHaveLength(2);
  });

  it("filters to failover outcomes only", async () => {
    const json = await (await call("?combo=alpha&failoverOnly=true")).json();
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0].sessionId).toBe("s1");
    expect(json.sessions[0].turns).toHaveLength(1); // only the failed-over turn
    expect(json.sessions[0].turns[0].outcome.fellOver).toBe(true);
  });

  it("returns the distinct combos as the picker list", async () => {
    const json = await (await call("?combo=alpha")).json();
    expect(json.combos).toEqual(["alpha", "beta"]);
  });

  it("returns 200 empty for an unknown combo, all sessions for an absent combo (and the full picker)", async () => {
    const res = await call("?combo=ghost");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessions).toEqual([]);
    expect(json.combos).toEqual(["alpha", "beta"]);

    const json2 = await (await call("")).json(); // no combo at all -> all combos
    expect(json2.combo).toBeNull();
    expect(json2.sessions).toHaveLength(3); // s1, s2 (alpha) + sb1 (beta)
    expect(json2.sessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s2", "sb1"]);
    expect(json2.combos).toEqual(["alpha", "beta"]);
  });
});

describe("GET /api/routing/models", () => {
  const call = (qs) => GET_MODELS({ url: `http://localhost:20128/api/routing/models${qs}` });

  it("groups usage by provider/model with per-model aggregates", async () => {
    const json = await (await call("")).json();
    expect(Array.isArray(json.models)).toBe(true);
    expect(json.models).toHaveLength(3);
    const byModel = Object.fromEntries(json.models.map((m) => [m.model, m]));
    const healthy = byModel["p/Healthy"];
    expect(healthy.requests).toBe(2);
    expect(healthy.promptTokens).toBe(3000);
    expect(healthy.completionTokens).toBe(300);
    expect(healthy.cost).toBeCloseTo(0.75, 4);
    expect(healthy.errorRate).toBe(0.5); // 1 of 2 rows has status != "ok"
  });

  it("sorts models by cost descending", async () => {
    const json = await (await call("")).json();
    expect(json.models.map((m) => m.model)).toEqual(["p/Healthy", "p/Unknown", "p/Offline"]);
  });

  it("marks a model offline via the in-memory health registry", async () => {
    const json = await (await call("")).json();
    const byModel = Object.fromEntries(json.models.map((m) => [m.model, m]));
    expect(byModel["p/Offline"].inHealth.offline).toBe(true);
    expect(byModel["p/Healthy"].inHealth.offline).toBe(false);
    expect(byModel["p/Unknown"].inHealth.offline).toBe(false);
  });

  it("attaches adaptive stats when present, null when the model has no history", async () => {
    const json = await (await call("")).json();
    const byModel = Object.fromEntries(json.models.map((m) => [m.model, m]));
    expect(byModel["p/Healthy"].inHealth.stats).toEqual({ successes: 5, failures: 1, avgLatencyMs: 100, penalty: 0 });
    expect(byModel["p/Offline"].inHealth.stats).toBeNull(); // zero adaptive stats
    expect(byModel["p/Unknown"].inHealth).toEqual({ offline: false, stats: null }); // fail-open
  });
});
