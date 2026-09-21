import { describe, it, expect, vi } from "vitest";
import { detectRequiredCapabilities, reorderByCapabilities, handleComboChat } from "../../open-sse/services/combo.js";

describe("detectRequiredCapabilities", () => {
  it("text-only -> empty", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: "hi" }] });
    expect(r.size).toBe(0);
  });

  it("openai image_url -> vision", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "x" } },
    ] }] });
    expect(r.has("vision")).toBe(true);
  });

  it("openai file -> pdf", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [
      { type: "file", file: { file_data: "data:application/pdf;base64,x" } },
    ] }] });
    expect(r.has("pdf")).toBe(true);
  });

  it("gemini inlineData image -> vision", () => {
    const r = detectRequiredCapabilities({ contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
    ] }] });
    expect(r.has("vision")).toBe(true);
  });

  it("antigravity request.contents image -> vision", () => {
    const r = detectRequiredCapabilities({ request: { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/jpeg", data: "x" } },
    ] }] } });
    expect(r.has("vision")).toBe(true);
  });

  it("web_search tool -> search", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: "q" }], tools: [
      { type: "web_search" },
    ] });
    expect(r.has("search")).toBe(true);
  });

  it("responses input_image -> vision", () => {
    const r = detectRequiredCapabilities({ input: [{ role: "user", content: [
      { type: "input_image", image_url: "x" },
    ] }] });
    expect(r.has("vision")).toBe(true);
  });
});

describe("reorderByCapabilities", () => {
  it("no required -> unchanged", () => {
    const models = ["a/x", "b/y"];
    expect(reorderByCapabilities(models, new Set())).toBe(models);
  });

  it("floats vision-capable model to front, keeps fallback", () => {
    // deepseek-chat = no vision; claude-sonnet = vision
    const models = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"];
    const out = reorderByCapabilities(models, new Set(["vision"]));
    expect(out[0]).toBe("anthropic/claude-sonnet-4.6");
    expect(out).toContain("deepseek/deepseek-chat"); // not dropped
    expect(out).toHaveLength(2);
  });

  it("keeps order when no model matches", () => {
    const models = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"];
    const out = reorderByCapabilities(models, new Set(["vision"]));
    expect(out).toBe(models);
  });

  it("single model -> unchanged", () => {
    const models = ["a/x"];
    expect(reorderByCapabilities(models, new Set(["vision"]))).toBe(models);
  });
});

describe("decision capture", () => {
  const mk = (over = {}) => ({
    body: { messages: [{ role: "user", content: "x" }] },
    models: ["p/A", "p/B"],
    handleSingleModel: vi.fn(async () => ({ ok: true, status: 200, clone: () => ({ json: async () => ({}) }) })),
    log: { info() {}, warn() {}, debug() {} },
    comboName: "eric",
    ...over,
  });

  it("fallback → static/combo-order decision, then served outcome", async () => {
    const onDecision = vi.fn(), onServed = vi.fn();
    await handleComboChat(mk({ comboStrategy: "fallback", onDecision, onServed }));
    expect(onDecision.mock.calls[0][0]).toMatchObject({ strategy: "fallback", source: "static", reason: "combo-order", picked: "p/A", combo: "eric" });
    expect(onServed.mock.calls[0][0]).toMatchObject({ served: "p/A", success: true, fellOver: false });
  });

  it("failover → outcome.fellOver true with the served model", async () => {
    const onServed = vi.fn();
    const hsm = vi.fn(async (b, m) => m === "p/A"
      ? { ok: false, status: 503, statusText: "unavailable", clone: () => ({ json: async () => ({ error: { message: "unavailable" } }) }) }
      : { ok: true, status: 200, clone: () => ({ json: async () => ({}) }) });
    await handleComboChat(mk({ comboStrategy: "fallback", handleSingleModel: hsm, onServed }));
    expect(onServed.mock.calls[0][0]).toMatchObject({ served: "p/B", success: true, fellOver: true });
  });

  it("adaptive → thompson-sampled decision with stats snapshot", async () => {
    const onDecision = vi.fn();
    await handleComboChat(mk({ comboStrategy: "adaptive", onDecision }));
    expect(onDecision.mock.calls[0][0]).toMatchObject({ strategy: "adaptive", source: "adaptive", reason: "thompson-sampled" });
    expect(onDecision.mock.calls[0][0].scores.stats).toEqual(expect.objectContaining({ successes: expect.any(Number) }));
  });

  it("onDecision throwing never breaks routing", async () => {
    await expect(handleComboChat(mk({ comboStrategy: "fallback", onDecision: () => { throw new Error("boom"); } }))).resolves.toBeDefined();
  });

  it("onServed throwing never breaks routing", async () => {
    await expect(handleComboChat(mk({ comboStrategy: "fallback", onServed: () => { throw new Error("boom"); } }))).resolves.toBeDefined();
  });
});
