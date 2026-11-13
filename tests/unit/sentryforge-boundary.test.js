import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the jev.js deps before importing the strategy under test, so the test
// never depends on live classifier health or network. We drive every CLEF
// answer explicitly.
vi.mock("../../open-sse/services/combo/jev.js", () => ({
  extractTurn: (body) => {
    const msgs = body?.messages || [];
    const last = msgs[msgs.length - 1];
    const userText = last?.content ?? "";
    return { userText, continuation: false };
  },
  parseDecisionBody: (text) => {
    try { return JSON.parse(text); } catch { return null; }
  },
  demoteSick: (models) => ({ order: models }),
}));

// capabilities import is only used for serviceable(); it must not throw on import.
vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: () => ({}),
}));

import { orderModelsBySentryforge } from "../../open-sse/services/combo/sentryforge.js";

// A combo with one Kiro member and one Acme member.
const MODELS = ["krb/auto", "acme/qwen"];
const KIRO = "krb/auto";
const ERIC = "acme/qwen";

function mkBody(prompt) {
  return { messages: [{ role: "user", content: prompt }] };
}

async function route(prompt, answers) {
  const cfg = {
    url: "http://127.0.0.1:1/nope",
    timeoutMs: 50,
    codeConfidenceGate: 0.85,
  };
  // Stub global fetch to return the canned CLEF answers.
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ answers }), { status: 200 });
  const decisions = [];
  try {
    const order = await orderModelsBySentryforge({
      body: mkBody(prompt),
      models: MODELS,
      cfg,
      log: { info() {}, warn() {} },
      comboName: "clef-kiroacme",
      sessionId: "s",
      turn: 1,
      onDecision: (d) => decisions.push(d),
    });
    return { order, decision: decisions[0] || null };
  } finally {
    globalThis.fetch = orig;
  }
}

describe("sentryforge executable-file-write boundary", () => {
  it("routes an agentic source-file write to Kiro (code-kiro)", async () => {
    const { order, decision } = await route(
      "Create a new file src/debounce.js that exports { debounce }.",
      { kind: { choice: "code", confidence: 0.97 }, route: { choice: KIRO, confidence: 0.9 } }
    );
    expect(decision.reason).toBe("code-kiro");
    expect(order[0]).toBe(KIRO);
    expect(order).not.toContain(ERIC); // Kiro-only serve order
  });

  it("routes a fix-repo-files turn to Kiro (code-kiro)", async () => {
    const { order, decision } = await route(
      "npm test fails: TokenStore isn't safe under concurrent callers. Fix src/token-refresh.js so the suite passes.",
      { kind: { choice: "code", confidence: 0.98 }, route: { choice: KIRO, confidence: 0.9 } }
    );
    expect(decision.reason).toBe("code-kiro");
    expect(order[0]).toBe(KIRO);
    expect(order).not.toContain(ERIC);
  });

  it("routes a refactor of repo source to Kiro (code-kiro)", async () => {
    const { order, decision } = await route(
      "Refactor src/config.js: extract per-field logic into helper functions. npm test must still pass 17/17.",
      { kind: { choice: "code", confidence: 0.98 }, route: { choice: KIRO, confidence: 0.9 } }
    );
    expect(decision.reason).toBe("code-kiro");
    expect(order[0]).toBe(KIRO);
  });

  it("routes an explanation (prose, no file write) to Acme (noncode-acme)", async () => {
    const { order, decision } = await route(
      "In a few sentences, explain how an LRU cache decides which entry to evict.",
      { kind: { choice: "noncode", confidence: 0.93 }, route: { choice: ERIC, confidence: 0.9 } }
    );
    expect(decision.reason).toBe("noncode-acme");
    expect(order[0]).toBe(ERIC);
    expect(order).toContain(KIRO); // Kiro kept as tail
  });

  it("routes a markdown spec write (src/rate-limit-design.md) to Acme, even with code sketches", async () => {
    const { order, decision } = await route(
      "Write your rate-limiting design to src/rate-limit-design.md: the policy interface and how config.js supplies the selection. Keep it under 400 words; code sketches are fine.",
      { kind: { choice: "noncode", confidence: 0.90 }, route: { choice: ERIC, confidence: 0.9 } }
    );
    expect(decision.reason).toBe("noncode-acme");
    expect(order[0]).toBe(ERIC);
  });

  it("keeps a confident noncode answer that contains illustrative snippets on Acme", async () => {
    const { order, decision } = await route(
      "Explain token refresh under concurrent callers. Show a short pseudocode single-flight guard inside the explanation.",
      { kind: { choice: "noncode", confidence: 0.91 }, route: { choice: ERIC, confidence: 0.9 } }
    );
    expect(decision.reason).toBe("noncode-acme");
    expect(order[0]).toBe(ERIC);
  });

  it("fail-closes to Kiro when a noncode label is below the confidence gate", async () => {
    const { order, decision } = await route(
      "Explain how the rate limiter works at the window boundary.",
      { kind: { choice: "noncode", confidence: 0.78 }, route: { choice: ERIC, confidence: 0.9 } }
    );
    expect(decision.reason).toBe("guard-low-confidence");
    expect(order[0]).toBe(KIRO);
    expect(order).not.toContain(ERIC);
  });

  it("fail-closes to Kiro on classifier timeout", async () => {
    const cfg = { url: "http://127.0.0.1:1/nope", timeoutMs: 1, codeConfidenceGate: 0.85 };
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      // simulate a hang that AbortSignal.timeout will abort
      return new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })), 200));
    };
    const decisions = [];
    try {
      const order = await orderModelsBySentryforge({
        body: mkBody("explain something"),
        models: MODELS,
        cfg,
        log: { info() {}, warn() {} },
        comboName: "clef-kiroacme",
        sessionId: "s",
        turn: 1,
        onDecision: (d) => decisions.push(d),
      });
      expect(decisions[0].reason).toBe("timeout");
      expect(order[0]).toBe(KIRO);
      expect(order).not.toContain(ERIC);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("never returns an Acme model as head for a code turn, even if the route pick names Acme", async () => {
    // CLEF says code but its route pick is an Acme model — the guard must
    // ignore the pick and serve Kiro-only.
    const { order, decision } = await route(
      "Fix src/cache.js so npm test passes (LRU evicts the wrong entry).",
      { kind: { choice: "code", confidence: 0.95 }, route: { choice: ERIC, confidence: 0.9 } }
    );
    expect(decision.reason).toBe("code-kiro");
    expect(order[0]).toBe(KIRO);
    expect(order).not.toContain(ERIC);
  });
});
