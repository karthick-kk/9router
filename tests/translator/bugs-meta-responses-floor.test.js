// Meta Responses API floors max_output_tokens at 16 — small client probes
// (e.g. Claude Code's /model validation ping with max_tokens < 16) must be
// clamped, not passed through verbatim, or Meta 400s the request.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const O2R = (body) => translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "m", body, true, null, null);

describe("OpenAI → Responses max_output_tokens floor (Meta >= 16)", () => {
  it("clamps tiny max_tokens up to 16", () => {
    const out = O2R({ messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
    expect(out.max_output_tokens).toBe(16);
  });

  it("clamps tiny max_completion_tokens up to 16", () => {
    const out = O2R({ messages: [{ role: "user", content: "hi" }], max_completion_tokens: 1 });
    expect(out.max_output_tokens).toBe(16);
  });

  it("clamps native Responses input with tiny max_tokens", () => {
    const out = O2R({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], max_tokens: 8 });
    expect(out.max_output_tokens).toBe(16);
  });

  it("passes normal values through unchanged", () => {
    const out = O2R({ messages: [{ role: "user", content: "hi" }], max_tokens: 32000 });
    expect(out.max_output_tokens).toBe(32000);
  });
});
