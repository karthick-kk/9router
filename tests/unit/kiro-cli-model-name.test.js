/**
 * prettyKiroCliModelName — the Kiro gateway's List-Available-Models echoes the
 * model id back as `modelName` (e.g. "claude-opus-5.5"), so the live catalog
 * would otherwise render raw ids in the dashboard grid, the Combo picker and
 * /v1/models instead of the friendly names the static registry used to show.
 * This pins the id → friendly-name mapping (and the genuine-name passthrough).
 */
import { describe, it, expect } from "vitest";
import { prettyKiroCliModelName } from "../../open-sse/services/kiroCliModels.js";

describe("prettyKiroCliModelName", () => {
  it("derives Claude names from the id when the gateway echoes the id", () => {
    // The real gateway returns modelName === modelId, so the second arg mirrors it.
    expect(prettyKiroCliModelName("claude-opus-5.5", "claude-opus-5.5")).toBe("Claude Opus 5.5");
    expect(prettyKiroCliModelName("claude-sonnet-5.5", "claude-sonnet-5.5")).toBe("Claude Sonnet 5.5");
    expect(prettyKiroCliModelName("claude-haiku-4.5", "claude-haiku-4.5")).toBe("Claude Haiku 4.5");
    expect(prettyKiroCliModelName("claude-opus-4.6", "claude-opus-4.6")).toBe("Claude Opus 4.6");
    expect(prettyKiroCliModelName("claude-sonnet-4", "claude-sonnet-4")).toBe("Claude Sonnet 4");
  });

  it("handles missing version and non-Claude Claude ids", () => {
    expect(prettyKiroCliModelName("claude-haiku-5", "claude-haiku-5")).toBe("Claude Haiku 5");
  });

  it("maps auto to Auto", () => {
    expect(prettyKiroCliModelName("auto", "auto")).toBe("Auto");
    expect(prettyKiroCliModelName("auto", undefined)).toBe("Auto");
  });

  it("maps MiniMax and Qwen Coder aliases", () => {
    expect(prettyKiroCliModelName("minimax-m2.5", "minimax-m2.5")).toBe("MiniMax M2.5");
    expect(prettyKiroCliModelName("minimax-m2.1", "minimax-m2.1")).toBe("MiniMax M2.1");
    expect(prettyKiroCliModelName("qwen3-coder-next", "qwen3-coder-next")).toBe("Qwen3 Coder Next");
  });

  it("honors a genuine gateway display name (differs from id and has a space)", () => {
    expect(prettyKiroCliModelName("claude-opus-5.5", "Claude Opus 5.5")).toBe("Claude Opus 5.5");
    expect(prettyKiroCliModelName("foo-bar-baz", "Foo Bar Baz")).toBe("Foo Bar Baz");
  });

  it("falls back to the raw id for unknown patterns with no name", () => {
    expect(prettyKiroCliModelName("gpt-oss-120b", "gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(prettyKiroCliModelName("gpt-oss-120b", undefined)).toBe("gpt-oss-120b");
  });
});
