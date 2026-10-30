/**
 * /v1/models live resolver for the `kiro-cli` (krb) provider.
 *
 * kiro-cli (like legacy kiro) must serve its model list from the live gateway
 * catalog rather than the static registry fallback, otherwise newly-released
 * thinking-capable models (the 5.5 generation) never appear in /v1/models and
 * dead entries (minimax-m2.5, …) linger. The dashboard connection-models route
 * already resolves live; this test pins the same behaviour on the public
 * /v1/models endpoint via LIVE_MODEL_RESOLVERS.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

// Legacy kiro resolver should not fire for a kiro-cli connection. Keep the
// real buildVariants (used by the kiro-cli resolver) via importOriginal.
vi.mock("open-sse/services/kiroModels.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveKiroModels: vi.fn(async () => {
      throw new Error("legacy kiro live fetch must not run for kiro-cli");
    }),
  };
});

const kiroCliStub = vi.hoisted(() => ({
  profileArn: "arn:aws:codewhisperer:eu-central-1:000000000000:profile/TESTARN",
  catalog: [
    { modelId: "claude-sonnet-5.5", modelName: "Claude Sonnet 5.5", rateMultiplier: 2.0, tokenLimits: { maxInputTokens: 1000000 } },
    { modelId: "claude-sonnet-4.5", modelName: "Claude Sonnet 4.5", rateMultiplier: 1.0, tokenLimits: { maxInputTokens: 200000 } },
    { modelId: "auto", modelName: "Auto", rateMultiplier: 1.0, tokenLimits: { maxInputTokens: 200000 } },
  ],
  fetchError: null,
  profileArnCalls: 0,
  catalogCalls: 0,
}));

vi.mock("open-sse/services/kiroCliModels.js", () => ({
  resolveKiroCliProfileArn: vi.fn(async () => {
    kiroCliStub.profileArnCalls += 1;
    return kiroCliStub.profileArn;
  }),
  fetchKiroCliCatalog: vi.fn(async () => {
    kiroCliStub.catalogCalls += 1;
    if (kiroCliStub.fetchError) throw new Error(kiroCliStub.fetchError);
    return kiroCliStub.catalog;
  }),
  normalizeKiroCliModel: (raw) => ({
    id: raw.modelId,
    name: raw.modelName || raw.modelId,
    rateMultiplier: raw.rateMultiplier,
    contextWindow: raw.tokenLimits?.maxInputTokens || undefined,
  }),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

function krbConn(overrides = {}) {
  return {
    id: "conn-1",
    provider: "kiro-cli",
    isActive: true,
    accessToken: "tok-123",
    providerSpecificData: { region: "eu-west-1" },
    ...overrides,
  };
}

beforeEach(() => {
  db.getProviderConnections.mockReset();
  kiroCliStub.profileArn = "arn:aws:codewhisperer:eu-central-1:000000000000:profile/TESTARN";
  kiroCliStub.fetchError = null;
  kiroCliStub.profileArnCalls = 0;
  kiroCliStub.catalogCalls = 0;
});

describe("/v1/models kiro-cli live resolver", () => {
  it("expands the live gateway catalog into variants and exposes 5.5 thinking variants", async () => {
    db.getProviderConnections.mockResolvedValue([krbConn({ id: "conn-live" })]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("krb/claude-sonnet-5.5");
    expect(ids).toContain("krb/claude-sonnet-5.5-thinking");
    expect(ids).toContain("krb/claude-sonnet-5.5-agentic");
    expect(ids).toContain("krb/claude-sonnet-5.5-thinking-agentic");
    // auto keeps base only — the gateway redacts its reasoning (resolveKiroEffortPath null)
    expect(ids).toContain("krb/auto");
    expect(ids).not.toContain("krb/auto-thinking");
    expect(ids).not.toContain("krb/auto-agentic");

    // The live catalog is authoritative: dead static-fallback entries are gone.
    expect(ids).not.toContain("krb/minimax-m2.5");
    expect(ids).not.toContain("krb/claude-opus-5");

    // The live 1M context window flows through from the gateway catalog (not the
    // static pattern table) to the published limits + capability block.
    const thinking = models.find((m) => m.id === "krb/claude-sonnet-5.5-thinking");
    expect(thinking.context_length).toBe(1000000);
    expect(thinking.capabilities?.reasoning).toBe(true);
    expect(thinking.capabilities?.contextWindow).toBe(1000000);
  });

  it("keeps thinking variants for 5.5 but not for the legacy 4.5 the gateway rejects", async () => {
    db.getProviderConnections.mockResolvedValue([krbConn({ id: "conn-variants" })]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("krb/claude-sonnet-5.5-thinking");
    expect(ids).toContain("krb/claude-sonnet-4.5");
    expect(ids).not.toContain("krb/claude-sonnet-4.5-thinking");
  });

  it("falls back to the static catalog when the gateway cannot resolve a profile", async () => {
    kiroCliStub.profileArn = null;
    db.getProviderConnections.mockResolvedValue([krbConn({ id: "conn-noprofile" })]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    // Static registry list is served (the resolver returned null).
    expect(ids).toContain("krb/claude-sonnet-5");
    expect(ids).toContain("krb/auto");
    // No 5.5 models from the (unfetched) live catalog leak in.
    expect(ids).not.toContain("krb/claude-sonnet-5.5-thinking");
  });

  it("falls back to the static catalog when the live fetch throws", async () => {
    kiroCliStub.fetchError = "Kiro CLI management ListAvailableModels failed: 500";
    db.getProviderConnections.mockResolvedValue([krbConn({ id: "conn-error" })]);

    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("krb/claude-sonnet-5");
    expect(ids).not.toContain("krb/claude-sonnet-5.5-thinking");
  });
});
