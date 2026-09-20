import { describe, it, expect, vi } from "vitest";

import { classifyTier, parseClassifierOutput, buildClassifierBody } from "../../open-sse/services/combo/classifier.js";
import { TIER } from "../../open-sse/services/combo/session-state.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

// Same Response stub shape the fusion tests use: .ok + .clone().json().
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

describe("parseClassifierOutput", () => {
  it("parses clean JSON", () => {
    expect(parseClassifierOutput('{"tier":"CAPABLE","confidence":0.92}')).toEqual({ tier: TIER.CAPABLE, confidence: 0.92 });
    expect(parseClassifierOutput('{"tier":"efficient","confidence":0.8}')).toEqual({ tier: TIER.EFFICIENT, confidence: 0.8 });
  });

  it("recovers JSON wrapped in prose or code fences", () => {
    expect(parseClassifierOutput('Sure!\n```json\n{"tier":"EFFICIENT","confidence":0.81}\n```')).toEqual({ tier: TIER.EFFICIENT, confidence: 0.81 });
  });

  it("treats a missing confidence as zero rather than certain", () => {
    expect(parseClassifierOutput('{"tier":"EFFICIENT"}')).toEqual({ tier: TIER.EFFICIENT, confidence: 0 });
  });

  it("rescales a percentage confidence", () => {
    expect(parseClassifierOutput('{"tier":"CAPABLE","confidence":92}')).toEqual({ tier: TIER.CAPABLE, confidence: 0.92 });
  });

  it("returns null when no tier can be recovered", () => {
    expect(parseClassifierOutput("I think you should use a big model")).toBeNull();
    expect(parseClassifierOutput("")).toBeNull();
    expect(parseClassifierOutput(null)).toBeNull();
    expect(parseClassifierOutput('{"tier":"MEDIUM","confidence":0.9}')).toBeNull();
  });
});

describe("buildClassifierBody", () => {
  it("sends a minimal non-streaming request with no tools", () => {
    const body = buildClassifierBody("do a thing");
    expect(body.stream).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.temperature).toBe(0);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("do a thing");
  });

  it("truncates an oversized user turn", () => {
    const body = buildClassifierBody("x".repeat(500), { maxUserChars: 10 });
    expect(body.messages[0].content).toContain("[truncated]");
    expect(body.messages[0].content).not.toContain("x".repeat(20));
  });

  it("carries the routing instructions in the user turn, not only a system message", () => {
    // Regression: a role:"system" message is dropped outright by the claude→kiro
    // direct route (it reads the top-level `system` field), which left the
    // classifier with no instructions at all on Claude Code traffic.
    const body = buildClassifierBody("add a test");
    expect(body.messages.some((m) => m.role === "system")).toBe(false);
    expect(body.messages[0].content).toMatch(/routing classifier/i);
    expect(body.messages[0].content).toMatch(/CAPABLE/);
    expect(body.messages[0].content).toMatch(/EFFICIENT/);
    // Also set top-level for the formats that do read it.
    expect(body.system).toMatch(/routing classifier/i);
  });
});

describe("classifier body through the claude→kiro direct route", () => {
  // The bug this guards against was invisible to a body-shape assertion: the body
  // looked right and only lost its instructions during translation. Exercise the
  // real translator, which is what the kiro/kiro-cli providers actually use.
  const creds = { providerSpecificData: { authMethod: "social" } };

  it("delivers the routing instructions to the wire payload", () => {
    const out = claudeToKiroRequest("claude-haiku-4.5-agentic", buildClassifierBody("add a test for the parser"), false, creds);
    expect(out).toBeTruthy();
    const content = out.conversationState?.currentMessage?.userInputMessage?.content || "";
    expect(content).toMatch(/routing classifier/i);
    expect(content).toContain("add a test for the parser");
    expect(out.systemPrompt || "").toMatch(/routing classifier/i);
  });

  it("ships no tool specs, so the classifier cannot start calling tools", () => {
    const out = claudeToKiroRequest("claude-haiku-4.5-agentic", buildClassifierBody("q"), false, creds);
    const specs = out.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools;
    expect(specs === undefined || specs.length === 0).toBe(true);
  });
});

describe("classifyTier", () => {
  const log = { info: () => {}, warn: () => {}, debug: () => {} };

  it("returns the classified tier on a well-formed answer", async () => {
    const handleSingleModel = vi.fn(async () => okResponse('{"tier":"EFFICIENT","confidence":0.9}'));
    const out = await classifyTier({ userText: "add a test", classifierModel: "p/haiku", handleSingleModel });
    expect(out.tier).toBe(TIER.EFFICIENT);
    expect(out.confidence).toBe(0.9);
    expect(handleSingleModel.mock.calls[0][1]).toBe("p/haiku");
  });

  it("falls back to capable on a malformed answer", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("no idea, sorry"));
    const out = await classifyTier({ userText: "q", classifierModel: "p/haiku", handleSingleModel });
    expect(out.tier).toBe(TIER.CAPABLE);
    expect(out.confidence).toBe(0);
    expect(out.reason).toContain("unparseable");
  });

  it("falls back to capable on timeout", async () => {
    const handleSingleModel = vi.fn(async () => okResponse('{"tier":"EFFICIENT","confidence":1}', { delayMs: 3000 }));
    const out = await classifyTier({ userText: "q", classifierModel: "p/haiku", handleSingleModel, cfg: { timeoutMs: 30 } });
    expect(out.tier).toBe(TIER.CAPABLE);
    expect(out.reason).toContain("timeout");
  });

  it("falls back to capable on an http error", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(503));
    const out = await classifyTier({ userText: "q", classifierModel: "p/haiku", handleSingleModel });
    expect(out.tier).toBe(TIER.CAPABLE);
    expect(out.reason).toContain("503");
  });

  it("falls back to capable when the call throws", async () => {
    const handleSingleModel = vi.fn(async () => { throw new Error("socket hang up"); });
    const out = await classifyTier({ userText: "q", classifierModel: "p/haiku", handleSingleModel });
    expect(out.tier).toBe(TIER.CAPABLE);
    expect(out.reason).toContain("socket hang up");
  });

  it("falls back to capable with no classifier model configured", async () => {
    const handleSingleModel = vi.fn();
    const out = await classifyTier({ userText: "q", classifierModel: "", handleSingleModel });
    expect(out.tier).toBe(TIER.CAPABLE);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });

  it("reads the tier out of a Claude-format response", async () => {
    const json = { content: [{ type: "text", text: '{"tier":"EFFICIENT","confidence":0.88}' }] };
    const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
    const out = await classifyTier({ userText: "q", classifierModel: "p/haiku", handleSingleModel: async () => make() });
    expect(out.tier).toBe(TIER.EFFICIENT);
  });
});
