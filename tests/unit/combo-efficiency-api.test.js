import { describe, it, expect, vi, beforeEach } from "vitest";

// The two bugs this file exists to catch were both invisible to a body-shape check
// and only surfaced as a 500 at runtime: destructuring `crows` from a record that
// stores `rows`, and calling the async `getAdapter()` without awaiting it.

const rows = [
  // kiro-moa: 2 capable turns, 3 efficient turns.
  mkRow("2026-08-31T07:00:00Z", "kiro-cli", "claude-opus-5-thinking-agentic", 100000, 500, 1.0, "kiro-moa"),
  mkRow("2026-08-31T07:01:00Z", "kiro-cli", "minimax-m2.5", 100000, 500, 0.06, "kiro-moa"),
  mkRow("2026-08-31T07:02:00Z", "kiro-cli", "minimax-m2.5", 100000, 500, 0.06, "kiro-moa"),
  mkRow("2026-08-31T07:03:00Z", "kiro-cli", "claude-opus-5-thinking-agentic", 100000, 500, 1.0, "kiro-moa"),
  mkRow("2026-08-31T07:04:00Z", "kiro-cli", "minimax-m2.5", 100000, 500, 0.06, "kiro-moa"),
  // A second combo must be reported separately.
  mkRow("2026-08-31T07:05:00Z", "kiro-cli", "minimax-m2.5", 50000, 200, 0.03, "other-combo"),
  // Untagged rows (meta '{}') must be ignored entirely.
  { timestamp: "2026-08-31T07:06:00Z", provider: "kiro-cli", model: "minimax-m2.5", promptTokens: 1, completionTokens: 1, cost: 0.1, meta: "{}" },
];

function mkRow(timestamp, provider, model, promptTokens, completionTokens, cost, combo) {
  return {
    timestamp, provider, model, promptTokens, completionTokens, cost,
    meta: JSON.stringify({ combo, comboStrategy: "composite-stage" }),
  };
}

const adapter = { all: vi.fn(() => rows) };
// getAdapter is async in the real driver; returning a promise here is what makes a
// missing `await` in the route fail loudly instead of silently yielding undefined.
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => adapter) }));

const { GET } = await import("../../src/app/api/usage/combo-efficiency/route.js");

function call(qs = "") {
  return GET({ url: `http://localhost:20128/api/usage/combo-efficiency${qs}` });
}

beforeEach(() => adapter.all.mockClear());

describe("GET /api/usage/combo-efficiency", () => {
  it("returns a per-combo report instead of throwing", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.combos)).toBe(true);
    expect(json.combos.length).toBe(2);
    expect(json.error).toBeUndefined();
  });

  it("groups turns per combo and ignores untagged usage", async () => {
    const { combos } = await (await call()).json();
    const moa = combos.find((c) => c.combo === "kiro-moa");
    expect(moa.turns).toBe(5);
    expect(moa.strategy).toBe("composite-stage");
    expect(combos.find((c) => c.combo === "other-combo").turns).toBe(1);
  });

  it("marks the most expensive model as capable and counts calls per model", async () => {
    const { combos } = await (await call()).json();
    const moa = combos.find((c) => c.combo === "kiro-moa");
    const capable = moa.perModel.find((m) => m.isCapable);
    expect(capable.model).toBe("claude-opus-5-thinking-agentic");
    expect(capable.calls).toBe(2);
    expect(moa.capableModel).toBe("claude-opus-5-thinking-agentic");
    expect(moa.perModel.find((m) => m.model === "minimax-m2.5").calls).toBe(3);
    expect(moa.capableShare).toBe(40);
    expect(moa.capableCalls).toBe(2);
  });

  it("reports a saving against the capable-only baseline", async () => {
    const { combos } = await (await call()).json();
    const moa = combos.find((c) => c.combo === "kiro-moa");
    // Routing three of five turns to the cheap model must beat all-capable.
    expect(moa.baselineCost).toBeGreaterThan(moa.actualCost);
    expect(moa.saved).toBeCloseTo(moa.baselineCost - moa.actualCost, 4);
    expect(moa.savedPct).toBeGreaterThan(0);
  });

  it("returns the observed window as full timestamps the UI can format", async () => {
    const { combos } = await (await call()).json();
    const moa = combos.find((c) => c.combo === "kiro-moa");
    expect(moa.window.from).toBe("2026-08-31T07:00:00Z");
    expect(moa.window.to).toBe("2026-08-31T07:04:00Z");
  });

  it("filters to one combo but still lists every combo for the dropdown", async () => {
    const json = await (await call("?combo=kiro-moa")).json();
    expect(json.combos).toHaveLength(1);
    expect(json.combos[0].combo).toBe("kiro-moa");
    // The selector must not lose its other options while one is selected.
    expect(json.available).toEqual(["kiro-moa", "other-combo"]);
  });

  it("ignores an unknown combo filter rather than returning nothing", async () => {
    const json = await (await call("?combo=nope")).json();
    expect(json.combos.length).toBe(2);
  });

  it("translates a named period into a query cutoff", async () => {
    await call("?period=7d");
    const [, params] = adapter.all.mock.calls[0];
    const cutoff = new Date(params[0]).getTime();
    expect(Math.abs(cutoff - (Date.now() - 7 * 86400000))).toBeLessThan(60000);
  });

  it("treats period=all as no lower bound", async () => {
    await call("?period=all");
    const [, params] = adapter.all.mock.calls[0];
    expect(new Date(params[0]).getTime()).toBe(0);
  });

  it("falls back to today for a missing or unknown period", async () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    for (const qs of ["", "?period=bogus"]) {
      adapter.all.mockClear();
      await call(qs);
      const [, params] = adapter.all.mock.calls[0];
      expect(new Date(params[0]).getTime()).toBe(startOfToday.getTime());
    }
  });

  it("returns an empty list rather than an error when nothing is tagged", async () => {
    adapter.all.mockReturnValueOnce([]);
    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.combos).toEqual([]);
    expect(json.available).toEqual([]);
  });
});
