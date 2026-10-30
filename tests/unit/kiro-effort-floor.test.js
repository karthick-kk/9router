/**
 * Implicit effort floor for `-thinking` variants (no explicit effort in body).
 *
 * Selecting `<model>-thinking` is the only thinking signal an OpenAI-shaped
 * client sends without effort control. The fallback budget (16000) mapped to
 * `medium`, which live-verified returns ZERO reasoning frames on Sonnet 5.5
 * (medium=0, high=50, max=384) — the model answers with no visible reasoning
 * while the client expects a thinking variant. The floor must therefore be
 * model-aware: 5.5+ Claude models default to `high`.
 *
 * Explicit effort always wins (the floor only applies when the body carries no
 * effort), and models below 5.5 keep the `medium` budget-derived default.
 */
import { describe, it, expect } from "vitest";
import {
  buildKiroAdditionalModelRequestFieldsForModel,
  KIRO_THINKING_BUDGET_DEFAULT,
} from "../../open-sse/config/kiroConstants.js";

describe("implicit effort floor for -thinking variants", () => {
  it("defaults 5.5 models to high when no explicit effort is sent", () => {
    for (const model of [
      "claude-sonnet-5.5",
      "claude-sonnet-5-5",
      "claude-opus-5.5",
      "claude-haiku-5.5",
    ]) {
      const fields = buildKiroAdditionalModelRequestFieldsForModel(
        { messages: [] },
        model,
        KIRO_THINKING_BUDGET_DEFAULT,
      );
      expect(fields?.output_config?.effort, model).toBe("high");
    }
  });

  it("keeps medium for models below the 5.5 floor", () => {
    for (const model of [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4.6",
      "claude-sonnet-4.6",
    ]) {
      const fields = buildKiroAdditionalModelRequestFieldsForModel(
        { messages: [] },
        model,
        KIRO_THINKING_BUDGET_DEFAULT,
      );
      expect(fields?.output_config?.effort, model).toBe("medium");
    }
  });

  it("lets an explicit effort win over the floor (in both directions)", () => {
    // Explicit medium stays medium even on 5.5.
    expect(
      buildKiroAdditionalModelRequestFieldsForModel(
        { output_config: { effort: "medium" } },
        "claude-sonnet-5.5",
        KIRO_THINKING_BUDGET_DEFAULT,
      )?.output_config?.effort,
    ).toBe("medium");
    // Explicit low stays low even on 5.5.
    expect(
      buildKiroAdditionalModelRequestFieldsForModel(
        { output_config: { effort: "low" } },
        "claude-sonnet-5.5",
        KIRO_THINKING_BUDGET_DEFAULT,
      )?.output_config?.effort,
    ).toBe("low");
    // Explicit max stays max.
    expect(
      buildKiroAdditionalModelRequestFieldsForModel(
        { output_config: { effort: "max" } },
        "claude-sonnet-5.5",
        KIRO_THINKING_BUDGET_DEFAULT,
      )?.output_config?.effort,
    ).toBe("max");
  });

  it("sends no native fields for legacy models even with a -thinking budget", () => {
    expect(
      buildKiroAdditionalModelRequestFieldsForModel(
        { messages: [] },
        "claude-sonnet-4.5",
        KIRO_THINKING_BUDGET_DEFAULT,
      ),
    ).toBeUndefined();
  });

  it("sends no native fields for auto (gateway redacts its reasoning)", () => {
    expect(
      buildKiroAdditionalModelRequestFieldsForModel(
        { messages: [] },
        "auto",
        KIRO_THINKING_BUDGET_DEFAULT,
      ),
    ).toBeUndefined();
  });
});
