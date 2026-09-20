import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveKiroCliApiRegion,
  KIRO_CLI_API_REGION_MAP,
  resolveKiroCliProfileArn,
} from "../../open-sse/services/kiroCliModels.js";

/**
 * Regression tests for the Kiro CLI gateway management API.
 *
 * The `kiro-cli` provider resolves its profileARN over the Kiro gateway
 * (management.{apiRegion}.kiro.dev) rather than the legacy CodeWhisperer
 * surface, and maps the SSO login region to the API region that actually hosts
 * the account's profile. This is the fix for accounts whose profile lives in a
 * non-default region (e.g. eu-west-1 login → eu-central-1 profile), which the
 * legacy `kiro` provider could never resolve.
 */
describe("kiro-cli region mapping", () => {
  it("maps EU SSO regions to eu-central-1", () => {
    expect(resolveKiroCliApiRegion("eu-west-1")).toBe("eu-central-1");
    expect(resolveKiroCliApiRegion("eu-west-2")).toBe("eu-central-1");
    expect(resolveKiroCliApiRegion("eu-north-1")).toBe("eu-central-1");
  });

  it("maps US/APAC SSO regions to us-east-1", () => {
    expect(resolveKiroCliApiRegion("us-west-2")).toBe("us-east-1");
    expect(resolveKiroCliApiRegion("ap-southeast-1")).toBe("us-east-1");
  });

  it("passes through unlisted regions and defaults blank to us-east-1", () => {
    expect(resolveKiroCliApiRegion("us-east-1")).toBe("us-east-1");
    expect(resolveKiroCliApiRegion("eu-central-1")).toBe("eu-central-1");
    expect(resolveKiroCliApiRegion("")).toBe("us-east-1");
    expect(resolveKiroCliApiRegion(undefined)).toBe("us-east-1");
  });
});

describe("kiro-cli profile resolution", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("resolves a profile over the gateway in the API region (eu-west-1 → eu-central-1)", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-central-1:649419331989:profile/3VQ9QH3XVKEU";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("eu-central-1") && u.endsWith("/List-Available-Profiles")) {
        return {
          ok: true,
          json: async () => ({ profiles: [{ arn: profileArn }] }),
        };
      }
      // us-east-1 returns empty (the legacy surface's answer for this account)
      return { ok: true, json: async () => ({ profiles: [] }) };
    });

    const arn = await resolveKiroCliProfileArn("the-access-token", "eu-west-1", { log: console });
    expect(arn).toBe(profileArn);

    // Should have probed the primary API region first (eu-central-1) before fallbacks.
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toContain("eu-central-1.kiro.dev");
    expect(urls[0]).toContain("/List-Available-Profiles");
  });

  it("returns null when no region has a profile", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ profiles: [] }),
    });
    const arn = await resolveKiroCliProfileArn("token", "us-east-1", { log: console });
    expect(arn).toBeNull();
  });

  it("caches the resolved profile by token+region", async () => {
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ profiles: [{ arn: profileArn }] }),
    });

    const first = await resolveKiroCliProfileArn("tok", "us-east-1");
    const second = await resolveKiroCliProfileArn("tok", "us-east-1");
    expect(first).toBe(profileArn);
    expect(second).toBe(profileArn);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});