import { describe, it, expect } from "vitest";

import { scoreStage } from "../../open-sse/services/combo/stage-scorer.js";
import { classifyTrailingTurn } from "../../open-sse/services/combo/trajectory.js";

// Build an OpenAI-format tool round trip: assistant calls `tool`, result comes back.
function toolTurn(tool, result) {
  return [
    { role: "assistant", content: "", tool_calls: [{ id: `c-${tool}-${result.slice(0, 6)}`, type: "function", function: { name: tool } }] },
    { role: "tool", tool_call_id: `c-${tool}-${result.slice(0, 6)}`, content: result },
  ];
}

// Same round trip in Claude/Anthropic block form.
function claudeToolTurn(tool, result, { isError = false } = {}) {
  return [
    { role: "assistant", content: [{ type: "tool_use", id: `t-${tool}`, name: tool, input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `t-${tool}`, content: result, is_error: isError }] },
  ];
}

describe("scoreStage signals", () => {
  it("reports no evidence for a plain user turn", () => {
    const out = scoreStage({ body: { messages: [{ role: "user", content: "hi" }] } });
    expect(out.hasEvidence).toBe(false);
    expect(out.score).toBe(0);
  });

  it("scores repeated failing tests as errors + spinning", () => {
    const out = scoreStage({
      body: {
        messages: [
          { role: "user", content: "run the tests" },
          ...toolTurn("Bash", "FAIL src/a.test.js — 3 tests failed, exit code 1"),
          ...toolTurn("Bash", "FAIL src/a.test.js — 3 tests failed, exit code 1"),
        ],
      },
    });
    expect(out.signals.errorSeverity).toBe(1);
    expect(out.signals.spinning).toBeGreaterThan(0);
    expect(out.score).toBeGreaterThan(0.5);
  });

  it("treats an is_error tool result as an error even without error words", () => {
    const out = scoreStage({
      body: { messages: [{ role: "user", content: "go" }, ...claudeToolTurn("Bash", "nope", { isError: true })] },
    });
    expect(out.signals.errorSeverity).toBe(1);
  });

  it("scores broad reading and searching as exploration", () => {
    const out = scoreStage({
      body: {
        messages: [
          { role: "user", content: "how does auth work" },
          ...toolTurn("Grep", "12 matches across 5 files"),
          ...toolTurn("Read", "export function login() {}"),
          ...toolTurn("Read", "export function logout() {}"),
        ],
      },
    });
    expect(out.signals.exploration).toBe(1);
    expect(out.signals.productionIntensity).toBe(0);
    expect(out.score).toBeGreaterThan(0);
  });

  it("scores steady editing as production and pushes the score down", () => {
    const out = scoreStage({
      body: {
        messages: [
          { role: "user", content: "implement it" },
          ...toolTurn("Edit", "applied 1 change"),
          ...toolTurn("Write", "wrote src/b.js"),
          ...toolTurn("Edit", "applied 1 change to src/c.js"),
        ],
      },
    });
    expect(out.signals.productionIntensity).toBe(1);
    expect(out.signals.exploration).toBe(0);
    expect(out.score).toBe(0);
  });

  it("counts running commands as production, not as no activity at all", () => {
    // Regression: `bash` was in neither hint list, so shell-driven turns — the bulk
    // of a real agentic session — scored exploration 0 / production 0 and the score
    // collapsed to whatever spinning contributed. Signals must reflect the work.
    const out = scoreStage({
      body: {
        messages: [
          { role: "user", content: "run the build" },
          ...toolTurn("Bash", "build succeeded in 4.1s"),
          ...toolTurn("Bash", "all 40 tests passed"),
        ],
      },
    });
    expect(out.signals.productionIntensity).toBeGreaterThan(0);
    expect(out.score).toBeLessThanOrEqual(0.25);
  });

  it("withdraws production credit while the work is failing", () => {
    // Regression: crediting production on a failing loop cancelled the error signal,
    // scoring a spinning agent as "routine production" and sending it to the cheap
    // model exactly when it needed the capable one. Errors must dominate.
    const succeeding = scoreStage({
      body: {
        messages: [
          { role: "user", content: "implement it" },
          ...toolTurn("Bash", "ok"),
          ...toolTurn("Edit", "applied 1 edit"),
          ...toolTurn("Bash", "ok"),
        ],
      },
    });
    // Pure failing loop with no edit success: must escalate (score > upgrade 0.5)
    const failing = scoreStage({
      body: {
        messages: [
          { role: "user", content: "fix the build" },
          ...toolTurn("Bash", "FAIL: 4 tests failed, exit code 1"),
          ...toolTurn("Bash", "FAIL: 4 tests failed, exit code 1"),
          ...toolTurn("Bash", "FAIL: 4 tests failed, exit code 1"),
        ],
      },
    });
    expect(failing.signals.productionIntensity).toBeLessThan(succeeding.signals.productionIntensity);
    // Pure failures must escalate; clean production must not.
    expect(failing.score).toBeGreaterThan(0.5);
    expect(succeeding.score).toBeLessThanOrEqual(0.25);
  });

  it("flags a critical error", () => {
    const out = scoreStage({
      body: { messages: [{ role: "user", content: "build" }, ...toolTurn("Bash", "FATAL: compilation failed: cannot find module 'x'")] },
    });
    expect(out.criticalError).toBe(true);
  });

  it("does not flag a critical error when the override is off", () => {
    const out = scoreStage({
      body: { messages: [{ role: "user", content: "build" }, ...toolTurn("Bash", "FATAL: compilation failed")] },
      cfg: { criticalErrorOverride: false },
    });
    expect(out.criticalError).toBe(false);
  });

  it("normalizes near-identical errors so varying numbers still count as repeats", () => {
    const out = scoreStage({
      body: {
        messages: [
          { role: "user", content: "fix" },
          ...toolTurn("Bash", "Error: timeout after 1042ms at 0xdeadbeef"),
          ...toolTurn("Bash", "Error: timeout after 2318ms at 0xfeedface"),
        ],
      },
    });
    expect(out.signals.spinning).toBeGreaterThan(0);
  });

  it("reads Claude-format trajectories the same as OpenAI ones", () => {
    const out = scoreStage({
      body: {
        messages: [
          { role: "user", content: "investigate" },
          ...claudeToolTurn("Grep", "many matches"),
          ...claudeToolTurn("Read", "file body"),
        ],
      },
    });
    expect(out.hasEvidence).toBe(true);
    expect(out.signals.exploration).toBe(1);
  });

  it("keeps every signal within 0..1 and the score clamped", () => {
    const messages = [{ role: "user", content: "go" }];
    for (let i = 0; i < 20; i++) messages.push(...toolTurn("Bash", "FATAL error: everything is broken"));
    const out = scoreStage({ body: { messages } });
    expect(out.score).toBeLessThanOrEqual(1);
    expect(out.score).toBeGreaterThanOrEqual(0);
    for (const v of Object.values(out.signals)) {
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("classifyTrailingTurn", () => {
  it("identifies a new user turn", () => {
    const out = classifyTrailingTurn({
      messages: [{ role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: "second" }],
    });
    expect(out.kind).toBe("user");
    expect(out.text).toBe("second");
  });

  it("identifies an OpenAI tool continuation", () => {
    const out = classifyTrailingTurn({
      messages: [{ role: "user", content: "go" }, ...toolTurn("Bash", "ok")],
    });
    expect(out.kind).toBe("tool");
  });

  it("identifies a Claude tool_result continuation despite its user role", () => {
    const out = classifyTrailingTurn({
      messages: [{ role: "user", content: "go" }, ...claudeToolTurn("Bash", "ok")],
    });
    expect(out.kind).toBe("tool");
  });

  it("identifies a Responses API function_call_output continuation", () => {
    const out = classifyTrailingTurn({
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", name: "Bash", call_id: "c1", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
    });
    expect(out.kind).toBe("tool");
  });

  it("reads a Gemini user turn", () => {
    const out = classifyTrailingTurn({
      contents: [{ role: "model", parts: [{ text: "ok" }] }, { role: "user", parts: [{ text: "next question" }] }],
    });
    expect(out.kind).toBe("user");
    expect(out.text).toBe("next question");
  });

  it("returns none for an empty conversation", () => {
    expect(classifyTrailingTurn({}).kind).toBe("none");
    expect(classifyTrailingTurn({ messages: [] }).kind).toBe("none");
  });
});
