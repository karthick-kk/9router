import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("../../src/sse/services/comboHealth.js", () => ({
  getHealthDetail: (m) => {
    if (m === "p/Down") return { status: "offline", lastError: "connect timeout", updatedAt: 1 };
    if (m === "p/Up") return { status: "online", lastError: null, updatedAt: 2 };
    return { status: "unknown", lastError: null, updatedAt: null };
  },
}));

let GET;
beforeAll(async () => {
  ({ GET } = await import("../../src/app/api/combos/health/route.js"));
});

const call = (qs) => GET({ url: `http://localhost:20128/api/combos/health${qs}` });

describe("GET /api/combos/health", () => {
  it("reports registry status for each requested model", async () => {
    const json = await (await call("?models=p/Down,p/Up,p/None")).json();
    expect(json.health["p/Down"]).toEqual({ status: "offline", lastError: "connect timeout", updatedAt: 1 });
    expect(json.health["p/Up"]).toEqual({ status: "online", lastError: null, updatedAt: 2 });
    expect(json.health["p/None"]).toEqual({ status: "unknown", lastError: null, updatedAt: null });
  });

  it("returns an empty map when no models are requested", async () => {
    const json = await (await call("")).json();
    expect(json.health).toEqual({});
  });

  it("ignores blank entries and caps the list at 200", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `p/m${i}`).join(",");
    const json = await (await call(`?models=,${many},`)).json();
    expect(Object.keys(json.health)).toHaveLength(200);
  });
});
