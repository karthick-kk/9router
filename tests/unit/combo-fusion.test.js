import { describe, it, expect, vi } from "vitest";

import { handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

// Minimal OpenAI-chat Response stub with the .ok + .clone().json() surface the engine uses.
function okResponse(content, { delayMs = 0 } = {}) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  const res = make();
  return delayMs > 0 ? new Promise((r) => setTimeout(() => r(res), delayMs)) : res;
}

function errResponse(status = 500) {
  const make = () => ({ ok: false, status, clone: make, json: async () => ({ error: { message: "boom" } }) });
  return make();
}

describe("fusion combo", () => {
  it("answers directly with a single-model panel (nothing to fuse)", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("solo"));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/only"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/only");
  });

  it("fans out to the panel then routes a synthesis turn to the judge", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model, isPanel) => {
      seen.push(model);
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true, tools: [{ name: "x" }] },
      models: ["p/a", "p/b", "p/c"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
    });

    // 3 panel calls + 1 judge call.
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
    expect(seen.slice(0, 3).sort()).toEqual(["p/a", "p/b", "p/c"]);
    expect(seen[3]).toBe("p/judge");

    // Panel calls are non-streaming with tools stripped.
    for (const [body, model, isPanel] of handleSingleModel.mock.calls.filter(([, m]) => m !== "p/judge")) {
      expect(body.stream).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(isPanel).toBe(true);
    }

    // Judge call carries every panel answer + keeps the client's stream flag.
    const [judgeBody, , isPanel] = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeBody.messages.at(-1).content;
    expect(judgeText).toContain("ans-p/a");
    expect(judgeText).toContain("ans-p/b");
    expect(judgeText).toContain("ans-p/c");
    expect(judgeText).toContain("Source 1");
    expect(judgeBody.stream).toBe(true);
    expect(isPanel).toBeUndefined();

    expect(res.ok).toBe(true);
  });

  it("defaults the judge to the first panel model when none is set", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => { seen.push(model); return okResponse(`ans-${model}`); });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/first", "p/second"],
      handleSingleModel,
      log,
    });
    // Last call is the judge; defaults to panel[0].
    expect(seen.at(-1)).toBe("p/first");
  });

  it("proceeds on quorum without waiting for a straggler (grace window)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/slow") return okResponse("slow", { delayMs: 5000 });
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`fast-${model}`);
    });

    const t0 = Date.now();
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/x", "p/y", "p/slow"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 10000 },
    });
    const elapsed = Date.now() - t0;

    // Two fast answers reach quorum; grace is 50ms, so we never wait ~5s for p/slow.
    expect(elapsed).toBeLessThan(2000);

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    expect(judgeText).toContain("fast-p/x");
    expect(judgeText).toContain("fast-p/y");
    expect(judgeText).not.toContain("slow");
  });

  it("returns the lone survivor directly when only one panel model succeeds", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "p/ok") return okResponse("lone");
      return errResponse(500);
    });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    // No judge call — single answer means there is nothing to fuse.
    const judged = handleSingleModel.mock.calls.some(([, m]) => m === "p/judge");
    expect(judged).toBe(false);
  });

  it("returns 503 when the whole panel fails", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(500));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    expect(res.status).toBe(503);
  });

  it("flattens previous tool history and assistant tool_calls into prose for panel calls", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "find files" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "find" } }] },
          { role: "tool", tool_call_id: "c1", content: "['a.js']" },
          { role: "user", content: "describe it" }
        ],
        tools: [{ type: "function" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    // Panel calls keep every turn but tool turns are flattened to assistant prose.
    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.messages.length).toBe(4);
      expect(panelBody.messages[0]).toEqual({ role: "user", content: "find files" });
      expect(panelBody.messages[1].tool_calls).toBeUndefined();
      expect(panelBody.messages[1].content).toContain("find");
      expect(panelBody.messages[2].role).toBe("assistant");
      expect(panelBody.messages[2].content).toContain("['a.js']");
      expect(panelBody.messages[3]).toEqual({ role: "user", content: "describe it" });
    }

    // Judge call still receives the unmodified history + synthesis prompt.
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    expect(judgeCall).toBeDefined();
    const judgeBody = judgeCall[0];
    expect(judgeBody.messages.length).toBe(5); // original 4 + judge prompt turn
    expect(judgeBody.messages[1].tool_calls).toBeDefined();
    expect(judgeBody.messages[2].role).toBe("tool");
  });

  it("flattens Anthropic-style tool_use and tool_result blocks in arrays", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "run" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }
        ],
        tools: [{ name: "run", description: "d" }]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge"
    });

    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel === true);
    expect(panelCalls.length).toBe(2);
    const panelBody = panelCalls[0][0];
    
    expect(panelBody.tools).toBeUndefined();
    expect(panelBody.messages.length).toBe(3);
    
    // Flattened tool_use
    expect(panelBody.messages[1].content).toBe("ok\n[Called tools: run]");
    
    // Flattened tool_result
    expect(panelBody.messages[2].content).toBe("[Tool result: done]");
  });
});

describe("fusion decision capture", () => {
  const mkBody = () => ({ messages: [{ role: "user", content: "What is the capital of France?" }] });
  const fastTuning = { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 };

  it("emits one fusion-judge decision (judge-configured) + onServed on the judge answer", async () => {
    const onDecision = vi.fn(), onServed = vi.fn();
    const handleSingleModel = vi.fn(async (_body, model) => okResponse(model === "p/judge" ? "FINAL" : `ans-${model}`));
    const res = await handleFusionChat({
      body: mkBody(),
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      comboName: "eric",
      judgeModel: "p/judge",
      onDecision,
      onServed,
      decisionSessionId: "sess-1",
      decisionTurn: 3,
    });

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0][0]).toMatchObject({
      combo: "eric", strategy: "fusion", source: "fusion-judge",
      reason: "judge-configured", picked: "p/judge",
      sessionId: "sess-1", turn: 3, confidence: null, classifierMs: null,
    });
    expect(onDecision.mock.calls[0][0].scores).toEqual({ panel: ["p/a", "p/b"] });
    expect(onDecision.mock.calls[0][0].preview).toBe("What is the capital of France?");

    expect(onServed).toHaveBeenCalledTimes(1);
    expect(onServed.mock.calls[0][0]).toMatchObject({
      served: "p/judge", success: true, fellOver: false, fellOverTo: null,
      status: 200, latencyMs: expect.any(Number),
    });
    expect(res.ok).toBe(true);
  });

  it("reports judge-auto (picked = panel[0]) when no judge model is configured", async () => {
    const onDecision = vi.fn();
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: mkBody(),
      models: ["p/first", "p/second"],
      handleSingleModel,
      log,
      onDecision,
    });
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0][0]).toMatchObject({
      source: "fusion-judge", reason: "judge-auto", picked: "p/first",
    });
  });

  it("single-panel passthrough: onServed served=panel[0], no onDecision", async () => {
    const onDecision = vi.fn(), onServed = vi.fn();
    const handleSingleModel = vi.fn(async () => okResponse("solo"));
    await handleFusionChat({
      body: mkBody(),
      models: ["p/only"],
      handleSingleModel,
      log,
      onDecision,
      onServed,
    });
    expect(onDecision).not.toHaveBeenCalled();
    expect(onServed).toHaveBeenCalledTimes(1);
    expect(onServed.mock.calls[0][0]).toMatchObject({
      served: "p/only", success: true, fellOver: false, fellOverTo: null, status: 200,
    });
  });

  it("400 with no models: onServed served=null status=400, no onDecision", async () => {
    const onDecision = vi.fn(), onServed = vi.fn();
    const handleSingleModel = vi.fn();
    const res = await handleFusionChat({
      body: mkBody(),
      models: [],
      handleSingleModel,
      log,
      onDecision,
      onServed,
    });
    expect(res.status).toBe(400);
    expect(onDecision).not.toHaveBeenCalled();
    expect(onServed).toHaveBeenCalledTimes(1);
    expect(onServed.mock.calls[0][0]).toMatchObject({
      served: null, success: false, status: 400, latencyMs: expect.any(Number),
    });
  });

  it("503 when the whole panel fails: decision emitted, onServed served=null status=503", async () => {
    const onDecision = vi.fn(), onServed = vi.fn();
    const handleSingleModel = vi.fn(async () => errResponse(500));
    const res = await handleFusionChat({
      body: mkBody(),
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      onDecision,
      onServed,
      tuning: fastTuning,
    });
    expect(res.status).toBe(503);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onServed).toHaveBeenCalledTimes(1);
    expect(onServed.mock.calls[0][0]).toMatchObject({ served: null, success: false, status: 503 });
  });

  it("lone survivor: decision emitted, onServed served = surviving model", async () => {
    const onDecision = vi.fn(), onServed = vi.fn();
    const handleSingleModel = vi.fn(async (_b, m) => (m === "p/ok" ? okResponse("lone") : errResponse(500)));
    await handleFusionChat({
      body: mkBody(),
      models: ["p/ok", "p/bad"],
      handleSingleModel,
      log,
      onDecision,
      onServed,
      tuning: fastTuning,
    });
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onServed).toHaveBeenCalledTimes(1);
    expect(onServed.mock.calls[0][0]).toMatchObject({ served: "p/ok", success: true, fellOver: false });
  });

  it("preview comes from the newest user message (text parts joined, sliced to 200)", async () => {
    const onDecision = vi.fn();
    const longText = "x".repeat(300);
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: [{ type: "text", text: longText }, { type: "image_url", image_url: { url: "u" } }] },
        ]
      },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      onDecision,
    });
    const preview = onDecision.mock.calls[0][0].preview;
    expect(preview).toBe("x".repeat(200));
    expect(preview.length).toBe(200);
  });

  it("throwing onDecision and onServed never break the response", async () => {
    const handleSingleModel = vi.fn(async (_b, m) => okResponse(m === "p/judge" ? "F" : "a"));
    const res = await handleFusionChat({
      body: mkBody(),
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      onDecision: () => { throw new Error("d"); },
      onServed: () => { throw new Error("s"); },
    });
    expect(res.ok).toBe(true);
  });
});
