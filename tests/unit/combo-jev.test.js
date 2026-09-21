import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { orderModelsByJev, extractTurn } from "../../open-sse/services/combo/jev.js";

const MODELS = ["oc/fast-model", "oc/smart-model"];
const CFG = { apiKey: "test-key", confidenceGate: 0.5 };

function jevResponse(choice, { confidence = 0.9, type = "choice" } = {}) {
  return {
    ok: true,
    json: async () => ({ answers: { route: { type, choice, confidence, probabilities: {} } } }),
  };
}

describe("jev combo classifier", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.TYPESAFE_API_KEY;
  });
  afterEach(() => vi.unstubAllGlobals());

  const body = { messages: [{ role: "user", content: "refactor the auth module" }] };

  it("moves the chosen model to the front", async () => {
    fetchMock.mockResolvedValue(jevResponse("oc/smart-model"));
    const ordered = await orderModelsByJev({ body, models: MODELS, cfg: CFG });
    expect(ordered).toEqual(["oc/smart-model", "oc/fast-model"]);

    const req = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(req.model).toBe("jev-latest");
    expect(req.questions.route.type).toBe("choice");
    expect(Object.keys(req.questions.route.criteria).sort()).toEqual([...MODELS].sort());
    expect(req.state.userRequest).toContain("refactor");
    expect(req.state.kind).toContain("fresh user turn");
  });

  it("uses user rubrics as criteria when provided", async () => {
    fetchMock.mockResolvedValue(jevResponse("oc/fast-model"));
    await orderModelsByJev({ body, models: MODELS, rubrics: { "oc/fast-model": "cheap mechanical edits" }, cfg: CFG });
    const req = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(req.questions.route.criteria["oc/fast-model"]).toBe("cheap mechanical edits");
    // no rubric → auto rubric contains the model id
    expect(req.questions.route.criteria["oc/smart-model"]).toContain("smart-model");
  });

  it("marks tool-step continuations", () => {
    const t = extractTurn({ messages: [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "on it", tool_calls: [{ id: "1" }] },
      { role: "tool", tool_call_id: "1", content: "test output" },
    ] });
    expect(t.continuation).toBe(true);
    expect(t.userText).toBe("fix the bug");
  });

  it("sends Bearer auth and URL from cfg", async () => {
    fetchMock.mockResolvedValue(jevResponse("oc/fast-model"));
    await orderModelsByJev({ body, models: MODELS, cfg: { ...CFG, url: "https://example.test/v1/systemone" } });
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/v1/systemone");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer test-key");
  });

  it("applies the per-combo mode policy to the instruction", async () => {
    fetchMock.mockResolvedValue(jevResponse("oc/smart-model"));
    await orderModelsByJev({ body, models: MODELS, cfg: { ...CFG, mode: "quality" } });
    let req = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(req.questions.route.instructions).toContain("best output");
    expect(req.questions.route.instructions).not.toContain("cheapest model");

    await orderModelsByJev({ body, models: MODELS, cfg: CFG });
    req = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(req.questions.route.instructions).toContain("cheapest model");

    await orderModelsByJev({ body, models: MODELS, cfg: { ...CFG, mode: "balanced" } });
    req = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(req.questions.route.instructions).toContain("quality and cost equally");
  });

  it("falls back (null) on HTTP error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    expect(await orderModelsByJev({ body, models: MODELS, cfg: CFG })).toBeNull();
  });

  it("falls back on network throw", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    expect(await orderModelsByJev({ body, models: MODELS, cfg: CFG })).toBeNull();
  });

  it("falls back on timeout via AbortSignal", async () => {
    fetchMock.mockImplementation((_url, opts) => new Promise((_res, rej) => {
      opts.signal.addEventListener("abort", () => rej(opts.signal.reason));
    }));
    expect(await orderModelsByJev({ body, models: MODELS, cfg: { ...CFG, timeoutMs: 10 } })).toBeNull();
  });

  it("falls back on unknown choice", async () => {
    fetchMock.mockResolvedValue(jevResponse("oc/not-in-combo"));
    expect(await orderModelsByJev({ body, models: MODELS, cfg: CFG })).toBeNull();
  });

  it("falls back below the confidence gate", async () => {
    fetchMock.mockResolvedValue(jevResponse("oc/smart-model", { confidence: 0.3 }));
    expect(await orderModelsByJev({ body, models: MODELS, cfg: CFG })).toBeNull();
    fetchMock.mockResolvedValue(jevResponse("oc/smart-model", { confidence: 0.3 }));
    expect(await orderModelsByJev({ body, models: MODELS, cfg: { ...CFG, confidenceGate: 0.2 } }))
      .toEqual(["oc/smart-model", "oc/fast-model"]);
  });

  it("follows the probability ranking when low confidence and mode=rank", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { route: {
        type: "choice", choice: "oc/smart-model", confidence: 0.3,
        probabilities: { "oc/smart-model": 0.34, "oc/fast-model": 0.66 },
      } } }),
    });
    expect(await orderModelsByJev({ body, models: MODELS, cfg: { ...CFG, lowConfidence: "rank" } }))
      .toEqual(["oc/fast-model", "oc/smart-model"]);
    // default (hold) still keeps the order
    expect(await orderModelsByJev({ body, models: MODELS, cfg: CFG })).toBeNull();
  });

  it("skips Jev without a key, without a user turn, or for one model", async () => {
    expect(await orderModelsByJev({ body, models: MODELS, cfg: {} })).toBeNull();
    expect(await orderModelsByJev({ body: { messages: [] }, models: MODELS, cfg: CFG })).toBeNull();
    expect(await orderModelsByJev({ body, models: ["only/one"], cfg: CFG })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads TYPESAFE_API_KEY env as fallback", async () => {
    process.env.TYPESAFE_API_KEY = "env-key";
    fetchMock.mockResolvedValue(jevResponse("oc/fast-model"));
    await orderModelsByJev({ body, models: MODELS, cfg: {} });
    expect(fetchMock).toHaveBeenCalled();
    delete process.env.TYPESAFE_API_KEY;
  });
});

describe("decision capture", () => {
  const opts = (over = {}) => ({
    body: { messages: [{ role: "user", content: "fix the login bug" }] },
    models: ["9eric/A", "9eric/B"],
    cfg: { apiKey: "k", timeoutMs: 1000 },
    log: { warn() {}, info() {} },
    onDecision: vi.fn(),
    ...over,
  });

  it.each([
    // [stub answers.route (or null), cfg, expectedReason, expectedConfidence, expectedOrder]
    [{ type: "choice", choice: "9eric/B", confidence: 0.9, probabilities: { "9eric/B": 0.9, "9eric/A": 0.1 } }, {}, "classified", 0.9, ["9eric/B", "9eric/A"]],
    [{ type: "choice", choice: "9eric/B", confidence: 0.2 }, {}, "below-gate-held", 0.2, null],
    [{ type: "choice", choice: "9eric/B", confidence: 0.2, probabilities: { "9eric/B": 0.6, "9eric/A": 0.4 } }, { lowConfidence: "rank" }, "ranked", 0.2, ["9eric/B", "9eric/A"]],
    [null, {}, "no-usable-choice", null, null],
  ])("route %o → reason %s", async (answer, cfgExtra, reason, confidence, expectedOrder) => {
    const onDecision = vi.fn();
    global.fetch = answer === null
      ? vi.fn(async () => ({ ok: true, json: async () => ({}) }))
      : vi.fn(async () => ({ ok: true, json: async () => ({ answers: { route: answer } }) }));
    const out = await orderModelsByJev(opts({ cfg: { apiKey: "k", timeoutMs: 1000, ...cfgExtra }, onDecision, turn: 2, comboName: "jev-eric", sessionId: "s1" }));
    expect(out).toEqual(expectedOrder);
    expect(onDecision).toHaveBeenCalledTimes(1);
    const rec = onDecision.mock.calls[0][0];
    expect(rec).toMatchObject({
      combo: "jev-eric", strategy: "jev", sessionId: "s1", turn: 2,
      source: "jev", reason, confidence,
      preview: "fix the login bug",
    });
    expect(rec.picked).toBeTruthy();
    expect(Number.isFinite(rec.classifierMs)).toBe(true); // fetch was called in these paths
  });

  it("fetch throws → error reason, fail-open still returns null", async () => {
    const onDecision = vi.fn();
    global.fetch = vi.fn(async () => { throw new Error("aborted"); });
    const out = await orderModelsByJev(opts({ onDecision, comboName: "c" }));
    expect(out).toBeNull();
    expect(onDecision.mock.calls[0][0]).toMatchObject({ source: "jev", reason: "error" });
  });

  it("fetch throws TimeoutError → timeout reason", async () => {
    const onDecision = vi.fn();
    const te = new Error("aborted");
    te.name = "TimeoutError";
    global.fetch = vi.fn(async () => { throw te; });
    const out = await orderModelsByJev(opts({ onDecision, comboName: "c" }));
    expect(out).toBeNull();
    expect(onDecision.mock.calls[0][0]).toMatchObject({ source: "jev", reason: "timeout" });
  });

  it("HTTP 500 → http-500 reason", async () => {
    const onDecision = vi.fn();
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    await orderModelsByJev(opts({ onDecision, comboName: "c" }));
    expect(onDecision.mock.calls[0][0].reason).toBe("http-500");
  });

  it("no API key → no-api-key reason, picked = first model, no fetch", async () => {
    const onDecision = vi.fn();
    global.fetch = vi.fn();
    const out = await orderModelsByJev(opts({ cfg: {}, onDecision, comboName: "c" }));
    expect(out).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onDecision.mock.calls[0][0]).toMatchObject({ source: "jev", reason: "no-api-key", picked: "9eric/A", classifierMs: null });
  });

  it("single model → single-model reason, picked = that model, no fetch", async () => {
    const onDecision = vi.fn();
    global.fetch = vi.fn();
    const out = await orderModelsByJev(opts({ models: ["9eric/A"], onDecision, comboName: "c" }));
    expect(out).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onDecision.mock.calls[0][0]).toMatchObject({ source: "jev", reason: "single-model", picked: "9eric/A", classifierMs: null });
  });

  it("no user text → no-user-text reason, no fetch", async () => {
    const onDecision = vi.fn();
    global.fetch = vi.fn();
    const out = await orderModelsByJev(opts({ body: { messages: [{ role: "user", content: "  " }] }, onDecision, comboName: "c" }));
    expect(out).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onDecision.mock.calls[0][0]).toMatchObject({ source: "jev", reason: "no-user-text", picked: "9eric/A", classifierMs: null });
  });

  it("never throws out of the decision path even if onDecision throws", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ answers: { route: { type: "choice", choice: "9eric/B", confidence: 0.9 } } }) }));
    await expect(orderModelsByJev(opts({ onDecision: () => { throw new Error("boom"); }, comboName: "c" }))).resolves.toEqual(["9eric/B", "9eric/A"]);
  });
});
