import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  handleCompositeStageChat,
  pickInitialTier,
  pickStageTier,
  resolveTierModels,
  PICKER,
  COMPOSITE_DEFAULTS,
} from "../../open-sse/services/combo/composite-stage.js";
import { TIER, resetRoutingState } from "../../open-sse/services/combo/session-state.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

const CAPABLE = "kiro/claude-opus-5";
const EFFICIENT = "kiro/minimax-m2.5";
const CLASSIFIER = "kiro/claude-haiku-4.5";

const CONFIG = { capableModel: CAPABLE, efficientModel: EFFICIENT, classifierModel: CLASSIFIER };

function okResponse(content = "ok") {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  return make();
}

function errResponse(status = 503) {
  const make = () => ({ ok: false, status, clone: make, json: async () => ({ error: { message: "down" } }) });
  return make();
}

// A handler that answers the classifier with `tier`/`confidence` and echoes anything else.
function makeHandler({ tier = "EFFICIENT", confidence = 0.95, failEfficient = false } = {}) {
  const calls = [];
  const fn = vi.fn(async (body, model, isClassifier) => {
    calls.push({ body, model, isClassifier });
    if (model === CLASSIFIER) return okResponse(JSON.stringify({ tier, confidence }));
    if (failEfficient && model === EFFICIENT) return errResponse(503);
    return okResponse(`answer from ${model}`);
  });
  return { fn, calls, routed: () => calls.filter((c) => c.model !== CLASSIFIER).map((c) => c.model) };
}

function userTurn(text) {
  return { messages: [{ role: "user", content: text }], stream: true, tools: [{ name: "Bash" }] };
}

// A tool-loop continuation whose trajectory reads as `kind` (errors or production).
function toolLoop(kind) {
  const result = kind === "errors"
    ? "FAIL: 4 tests failed, exit code 1"
    : "applied 1 edit";
  const tool = kind === "errors" ? "Bash" : "Edit";
  return {
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: tool } }] },
      { role: "tool", tool_call_id: "c1", content: result },
      { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: tool } }] },
      { role: "tool", tool_call_id: "c2", content: result },
    ],
    stream: true,
    tools: [{ name: tool }],
  };
}

beforeEach(() => resetRoutingState());

describe("resolveTierModels", () => {
  it("falls back to the combo's own model order when tiers are unset", () => {
    const out = resolveTierModels(["a/one", "b/two", "c/three"], {});
    expect(out.capable).toBe("a/one");
    expect(out.efficient).toBe("b/two");
    expect(out.classifier).toBeNull();
  });

  it("prefers explicit settings over the model list", () => {
    const out = resolveTierModels(["a/one", "b/two"], CONFIG);
    expect(out.capable).toBe(CAPABLE);
    expect(out.efficient).toBe(EFFICIENT);
    expect(out.classifier).toBe(CLASSIFIER);
  });

  it("leaves efficient null for a single-model combo", () => {
    const out = resolveTierModels(["a/one"], {});
    expect(out.capable).toBe("a/one");
    expect(out.efficient).toBeNull();
  });
});

describe("pickInitialTier (capable-first thresholds)", () => {
  const cfg = { picker: PICKER.CAPABLE_FIRST, threshold: 0.75 };

  it("routes a confident EFFICIENT call to the efficient tier", () => {
    expect(pickInitialTier({ tier: TIER.EFFICIENT, confidence: 0.9 }, cfg)).toBe(TIER.EFFICIENT);
  });

  it("keeps a low-confidence EFFICIENT call on capable", () => {
    expect(pickInitialTier({ tier: TIER.EFFICIENT, confidence: 0.5 }, cfg)).toBe(TIER.CAPABLE);
  });

  it("keeps CAPABLE on capable regardless of confidence", () => {
    expect(pickInitialTier({ tier: TIER.CAPABLE, confidence: 0.1 }, cfg)).toBe(TIER.CAPABLE);
  });

  it("mirrors the logic under efficient_first", () => {
    const eff = { picker: PICKER.EFFICIENT_FIRST, threshold: 0.75 };
    expect(pickInitialTier({ tier: TIER.CAPABLE, confidence: 0.9 }, eff)).toBe(TIER.CAPABLE);
    expect(pickInitialTier({ tier: TIER.CAPABLE, confidence: 0.5 }, eff)).toBe(TIER.EFFICIENT);
    expect(pickInitialTier({ tier: TIER.EFFICIENT, confidence: 0.1 }, eff)).toBe(TIER.EFFICIENT);
  });
});

describe("pickStageTier (hysteresis)", () => {
  const cfg = { upgradeThreshold: 0.5, downgradeThreshold: 0.25, hysteresis: true };

  it("escalates on a high score", () => {
    expect(pickStageTier({ hasEvidence: true, score: 0.8 }, TIER.EFFICIENT, cfg).tier).toBe(TIER.CAPABLE);
  });

  it("downgrades on a low score", () => {
    expect(pickStageTier({ hasEvidence: true, score: 0.1 }, TIER.CAPABLE, cfg).tier).toBe(TIER.EFFICIENT);
  });

  it("holds the current tier inside the hysteresis band, in both directions", () => {
    expect(pickStageTier({ hasEvidence: true, score: 0.35 }, TIER.CAPABLE, cfg).tier).toBe(TIER.CAPABLE);
    expect(pickStageTier({ hasEvidence: true, score: 0.35 }, TIER.EFFICIENT, cfg).tier).toBe(TIER.EFFICIENT);
  });

  it("resolves the band to capable when hysteresis is off (ambiguous → capable)", () => {
    const out = pickStageTier({ hasEvidence: true, score: 0.35 }, TIER.EFFICIENT, { ...cfg, hysteresis: false });
    expect(out.tier).toBe(TIER.CAPABLE);
  });

  it("forces capable on a critical error even from the efficient tier", () => {
    const out = pickStageTier({ hasEvidence: true, score: 0, criticalError: true }, TIER.EFFICIENT, cfg);
    expect(out.tier).toBe(TIER.CAPABLE);
    expect(out.reason).toContain("critical");
  });

  it("retains the current tier with no trajectory evidence", () => {
    expect(pickStageTier({ hasEvidence: false, score: 0 }, TIER.EFFICIENT, cfg).tier).toBe(TIER.EFFICIENT);
    expect(pickStageTier({ hasEvidence: false, score: 0 }, TIER.CAPABLE, cfg).tier).toBe(TIER.CAPABLE);
  });

  it("does not downgrade capable on weak evidence", () => {
    // Mild exploration with no errors: above the downgrade line, so capable holds.
    for (const score of [0.26, 0.3, 0.49]) {
      expect(pickStageTier({ hasEvidence: true, score }, TIER.CAPABLE, cfg).tier).toBe(TIER.CAPABLE);
    }
  });

  it("uses the documented default thresholds", () => {
    expect(COMPOSITE_DEFAULTS.upgradeThreshold).toBe(0.5);
    expect(COMPOSITE_DEFAULTS.downgradeThreshold).toBe(0.25);
    expect(COMPOSITE_DEFAULTS.threshold).toBe(0.75);
    expect(COMPOSITE_DEFAULTS.picker).toBe(PICKER.CAPABLE_FIRST);
  });
});

describe("handleCompositeStageChat routing", () => {
  it("classifies a new user turn and routes to the efficient model", async () => {
    const h = makeHandler({ tier: "EFFICIENT", confidence: 0.95 });
    await handleCompositeStageChat({
      body: userTurn("implement the function we agreed on"),
      models: [CAPABLE, EFFICIENT],
      handleSingleModel: h.fn,
      log,
      comboName: "c1",
      sessionId: "s1",
      config: CONFIG,
    });
    expect(h.calls[0].model).toBe(CLASSIFIER);
    expect(h.routed()).toEqual([EFFICIENT]);
  });

  it("routes an architecture turn to the capable model", async () => {
    const h = makeHandler({ tier: "CAPABLE", confidence: 0.92 });
    await handleCompositeStageChat({
      body: userTurn("should we move to event-driven architecture?"),
      models: [CAPABLE, EFFICIENT],
      handleSingleModel: h.fn,
      log,
      comboName: "c1",
      sessionId: "s1",
      config: CONFIG,
    });
    expect(h.routed()).toEqual([CAPABLE]);
  });

  it("stays on capable when the classifier is unconfident", async () => {
    const h = makeHandler({ tier: "EFFICIENT", confidence: 0.4 });
    await handleCompositeStageChat({
      body: userTurn("maybe change this?"),
      models: [CAPABLE, EFFICIENT],
      handleSingleModel: h.fn,
      log,
      comboName: "c1",
      sessionId: "s1",
      config: CONFIG,
    });
    expect(h.routed()).toEqual([CAPABLE]);
  });

  it("does not call the classifier on a tool continuation", async () => {
    const h = makeHandler();
    await handleCompositeStageChat({
      body: toolLoop("production"),
      models: [CAPABLE, EFFICIENT],
      handleSingleModel: h.fn,
      log,
      comboName: "c1",
      sessionId: "s1",
      config: CONFIG,
    });
    expect(h.calls.some((c) => c.model === CLASSIFIER)).toBe(false);
  });

  it("escalates mid-loop when the trajectory turns bad", async () => {
    const h = makeHandler({ tier: "EFFICIENT", confidence: 0.95 });
    const opts = { models: [CAPABLE, EFFICIENT], handleSingleModel: h.fn, log, comboName: "c1", sessionId: "s-esc", config: CONFIG };

    // Turn 1: classified EFFICIENT → M2.5.
    await handleCompositeStageChat({ ...opts, body: userTurn("add tests for the parser") });
    expect(h.routed()).toEqual([EFFICIENT]);

    // Turn 2: repeated test failures → escalate to Opus.
    await handleCompositeStageChat({ ...opts, body: toolLoop("errors") });
    expect(h.routed()).toEqual([EFFICIENT, CAPABLE]);
  });

  it("keeps state per session so conversations don't cross-contaminate", async () => {
    const h = makeHandler({ tier: "EFFICIENT", confidence: 0.95 });
    const base = { models: [CAPABLE, EFFICIENT], handleSingleModel: h.fn, log, comboName: "c1", config: CONFIG };

    // Session A ends up on capable after a bad trajectory.
    await handleCompositeStageChat({ ...base, sessionId: "A", body: userTurn("add tests") });
    await handleCompositeStageChat({ ...base, sessionId: "A", body: toolLoop("errors") });
    // Session B's first tool turn must not inherit A's tier; it has its own state.
    await handleCompositeStageChat({ ...base, sessionId: "B", body: userTurn("add tests") });

    expect(h.routed()).toEqual([EFFICIENT, CAPABLE, EFFICIENT]);
  });

  it("reuses the stored classification when the same user turn is retried", async () => {
    const h = makeHandler({ tier: "EFFICIENT", confidence: 0.95 });
    const opts = { models: [CAPABLE, EFFICIENT], handleSingleModel: h.fn, log, comboName: "c1", sessionId: "s-retry", config: CONFIG };
    const body = userTurn("same request");
    await handleCompositeStageChat({ ...opts, body });
    await handleCompositeStageChat({ ...opts, body });
    // One classifier call for two identical turns.
    expect(h.calls.filter((c) => c.model === CLASSIFIER)).toHaveLength(1);
    expect(h.routed()).toEqual([EFFICIENT, EFFICIENT]);
  });

  it("falls back to capable when the efficient model is unavailable", async () => {
    const h = makeHandler({ tier: "EFFICIENT", confidence: 0.95, failEfficient: true });
    const res = await handleCompositeStageChat({
      body: userTurn("mechanical refactor"),
      models: [CAPABLE, EFFICIENT],
      handleSingleModel: h.fn,
      log,
      comboName: "c1",
      sessionId: "s-fail",
      config: CONFIG,
    });
    expect(h.routed()).toEqual([EFFICIENT, CAPABLE]);
    expect(res.ok).toBe(true);
  });

  it("routes to capable without a classifier model configured", async () => {
    const h = makeHandler();
    await handleCompositeStageChat({
      body: userTurn("anything"),
      models: [CAPABLE, EFFICIENT],
      handleSingleModel: h.fn,
      log,
      comboName: "c1",
      sessionId: "s-noclf",
      config: { capableModel: CAPABLE, efficientModel: EFFICIENT },
    });
    expect(h.calls.some((c) => c.model === CLASSIFIER)).toBe(false);
    expect(h.routed()).toEqual([CAPABLE]);
  });

  it("skips the classifier when it is disabled", async () => {
    const h = makeHandler();
    await handleCompositeStageChat({
      body: userTurn("anything"),
      models: [CAPABLE, EFFICIENT],
      handleSingleModel: h.fn,
      log,
      comboName: "c1",
      sessionId: "s-off",
      config: { ...CONFIG, classifier: { enabled: false } },
    });
    expect(h.calls.some((c) => c.model === CLASSIFIER)).toBe(false);
    expect(h.routed()).toEqual([CAPABLE]);
  });

  it("uses capable when no efficient model exists", async () => {
    const h = makeHandler({ tier: "EFFICIENT", confidence: 0.99 });
    await handleCompositeStageChat({
      body: userTurn("trivial change"),
      models: [CAPABLE],
      handleSingleModel: h.fn,
      log,
      comboName: "solo",
      sessionId: "s-solo",
      config: { capableModel: CAPABLE, classifierModel: CLASSIFIER },
    });
    expect(h.routed()).toEqual([CAPABLE]);
  });

  it("returns 400 for a combo with no models", async () => {
    const res = await handleCompositeStageChat({
      body: userTurn("x"),
      models: [],
      handleSingleModel: vi.fn(),
      log,
      comboName: "empty",
      sessionId: "s",
      config: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("tool-loop and streaming preservation", () => {
  it("passes the body through untouched to the routed model", async () => {
    const h = makeHandler({ tier: "EFFICIENT", confidence: 0.95 });
    const body = {
      messages: [
        { role: "user", content: "find and fix" },
        { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Edit", input: { path: "a.js" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "applied 1 edit" }] },
      ],
      tools: [{ name: "Edit", description: "edit a file", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      stream: true,
      thinking: { type: "enabled", budget_tokens: 8000 },
      max_tokens: 32000,
    };

    await handleCompositeStageChat({
      body,
      models: [CAPABLE, EFFICIENT],
      handleSingleModel: h.fn,
      log,
      comboName: "c1",
      sessionId: "s-loop",
      config: CONFIG,
    });

    const routed = h.calls.find((c) => c.model !== CLASSIFIER);
    // Same object identity: the strategy selects, it does not rewrite.
    expect(routed.body).toBe(body);
    expect(routed.body.tools).toHaveLength(1);
    expect(routed.body.stream).toBe(true);
    expect(routed.body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(routed.body.messages[1].content[1].type).toBe("tool_use");
    expect(routed.body.messages[2].content[0].type).toBe("tool_result");
  });

  it("preserves thinking config and tool structure across a tier switch in both directions", async () => {
    const h = makeHandler({ tier: "EFFICIENT", confidence: 0.95 });
    const opts = { models: [CAPABLE, EFFICIENT], handleSingleModel: h.fn, log, comboName: "c1", sessionId: "s-switch", config: CONFIG };
    const thinking = { type: "enabled", budget_tokens: 4000 };

    // EFFICIENT first, then a bad trajectory escalates to CAPABLE, then production
    // work downgrades again — three turns, two switches.
    await handleCompositeStageChat({ ...opts, body: { ...userTurn("add tests"), thinking } });
    await handleCompositeStageChat({ ...opts, body: { ...toolLoop("errors"), thinking } });
    await handleCompositeStageChat({ ...opts, body: { ...toolLoop("production"), thinking } });

    expect(h.routed()).toEqual([EFFICIENT, CAPABLE, EFFICIENT]);
    for (const call of h.calls.filter((c) => c.model !== CLASSIFIER)) {
      expect(call.body.thinking).toEqual(thinking);
      expect(call.body.tools).toBeDefined();
      expect(call.body.stream).toBe(true);
    }
  });

  it("marks the classifier call so callers can strip its tools, and never streams it", async () => {
    const h = makeHandler();
    await handleCompositeStageChat({
      body: userTurn("q"),
      models: [CAPABLE, EFFICIENT],
      handleSingleModel: h.fn,
      log,
      comboName: "c1",
      sessionId: "s-flag",
      config: CONFIG,
    });
    const clf = h.calls.find((c) => c.model === CLASSIFIER);
    expect(clf.isClassifier).toBe(true);
    expect(clf.body.stream).toBe(false);
    expect(clf.body.tools).toBeUndefined();
    // The routed call is not flagged.
    expect(h.calls.find((c) => c.model !== CLASSIFIER).isClassifier).toBeUndefined();
  });
});
