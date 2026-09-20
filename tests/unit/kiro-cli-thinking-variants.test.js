import { describe, it, expect } from "vitest";
import { buildVariants, stripSyntheticSuffixes } from "../../open-sse/services/kiroModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { resolveKiroEffortPath } from "../../open-sse/config/kiroConstants.js";

/**
 * Regression tests for kiro-cli thinking capability.
 *
 * The gateway catalog returns one entry per upstream model, but Kiro exposes
 * thinking/agentic by selecting a synthetic `-thinking` / `-agentic` /
 * `-thinking-agentic` variant (same upstream, toggled on at request time).
 * kiro-cli must expand the same variants and gate thinking levels exactly like
 * the legacy `kiro` provider so the model picker is not misled.
 *
 * Gateway-specific: unlike the legacy CodeWhisperer surface, the Kiro gateway
 * REJECTS the thinking `additionalModelRequestFields` for models below the
 * reasoning boundary (resolveKiroEffortPath === null, e.g. 4.5/4/haiku) with
 * 400 REQUEST_BODY_INVALID. The resolver drops `-thinking` variants for those.
 */

// The exact filter used by the kiro-cli model route resolver:
// a `-thinking` variant is only offered when the upstream model supports thinking.
export function gatewayThinkingFilter(modelId, variantCapabilities) {
  if (!variantCapabilities.thinking) return true;
  return resolveKiroEffortPath(modelId) !== null;
}

describe("kiro-cli variant expansion", () => {
  it("expands a Claude model into the full 4-variant set", () => {
    const variants = buildVariants("claude-sonnet-5", "Kiro Claude Sonnet 5");
    const ids = variants.map((v) => v.id);
    expect(ids).toEqual([
      "claude-sonnet-5",
      "claude-sonnet-5-thinking",
      "claude-sonnet-5-agentic",
      "claude-sonnet-5-thinking-agentic",
    ]);
    const thinking = variants.find((v) => v.id === "claude-sonnet-5-thinking");
    expect(thinking.capabilities).toEqual({ thinking: true, agentic: false });
    expect(variants[0].capabilities).toEqual({ thinking: false, agentic: false });
  });

  it("skips agentic variants for auto (server-side routing) but keeps thinking", () => {
    const variants = buildVariants("auto", "Kiro Auto");
    const ids = variants.map((v) => v.id);
    expect(ids).toEqual(["auto", "auto-thinking"]);
  });

  it("strips the synthetic suffixes back to the upstream id", () => {
    expect(stripSyntheticSuffixes("claude-sonnet-5-thinking-agentic")).toBe("claude-sonnet-5");
    expect(stripSyntheticSuffixes("claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

describe("kiro-cli thinking levels match legacy kiro", () => {
  it.each([
    ["claude-sonnet-5"],
    ["claude-sonnet-4.6"],
    ["claude-opus-4.8"],
  ])("advertises levels for supported model %s", (model) => {
    expect(getThinkingLevels("kiro-cli", model)).not.toBeNull();
    expect(getThinkingLevels("kiro-cli", model)).toEqual(getThinkingLevels("kiro", model));
  });

  it.each([
    ["claude-sonnet-4.5"],
    ["minimax-m2.5"],
    ["qwen3-coder-next"],
    ["auto"],
  ])("returns null (no thinking) for %s", (model) => {
    expect(getThinkingLevels("kiro-cli", model)).toBeNull();
    expect(getThinkingLevels("kiro", model)).toBeNull();
  });

  // `auto` looks like a thinking candidate (it routes to Claude models that do
  // reason) but the gateway catalog reports additionalModelRequestFieldsSchema
  // null for it, and live probes return only redacted reasoning — identically
  // with and without thinking fields, across every request shape tried. So it
  // must stay off the thinking path rather than advertise a level picker.
  it("keeps auto off the thinking path", () => {
    expect(resolveKiroEffortPath("auto")).toBeNull();
  });

  it("does not treat an unrelated id containing 'auto' as thinking-capable", () => {
    expect(resolveKiroEffortPath("autonomous-x")).toBeNull();
  });
});

describe("kiro-cli gateway thinking filter", () => {
  it("keeps thinking variants for supported models (4.6+)", () => {
    for (const v of buildVariants("claude-opus-4.7", "Claude Opus 4.7")) {
      expect(gatewayThinkingFilter("claude-opus-4.7", v.capabilities)).toBe(true);
    }
  });

  it("drops thinking variants for legacy models (4.5/4/haiku) the gateway rejects", () => {
    for (const m of ["claude-opus-4.5", "claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5", "auto", "qwen3-coder-next"]) {
      for (const v of buildVariants(m, m)) {
        const keep = gatewayThinkingFilter(m, v.capabilities);
        if (v.capabilities.thinking) expect(keep).toBe(false);
        else expect(keep).toBe(true);
      }
    }
  });
});