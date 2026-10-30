/**
 * Tests for two independent frontend/capabilities fixes:
 *
 * #4293 — deepseek-v4-1-flash (hyphen) has vision=false
 *   Kenari exposes the model under the ID "deepseek-v4-1-flash" (dash instead
 *   of dot).  The capabilities table only had "deepseek-v4.1-flash" (dot), so
 *   the hyphenated variant fell through to the generic *deepseek* pattern which
 *   has vision:false.  Fix: add "deepseek-v4-1-flash" as an alias with the same
 *   vision:true entry.
 *
 * #4244 — Zed missing from SelectModelModal LIVE_CATALOG_PROVIDERS
 *   The hardcoded list ["cursor","cline","clinepass"] omitted "zed", so the
 *   Zed provider card was never fetched and never shown in the Combo picker.
 *   Fix: add "zed" to the list (and wire up the corresponding state/hook/ternary).
 *
 * kiro-cli — same gap: the Combo picker's LIVE_CATALOG_PROVIDERS omitted
 *   "kiro-cli", so the static (stale) registry won and the live 5.5 gateway
 *   models never appeared in "Add Model to Combo". Fix: add "kiro-cli" to
 *   the list and wire up kiroCliModels like zedModels.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// ── #4293 deepseek-v4-1-flash vision capability ───────────────────────────

describe("deepseek-v4-1-flash capabilities (#4293)", () => {
  it("reports vision:true for the hyphenated deepseek-v4-1-flash id (Kenari variant)", () => {
    // Any provider that uses the hyphenated id should get vision:true
    const caps = getCapabilitiesForModel("kenari", "deepseek-v4-1-flash");
    expect(caps.vision).toBe(true);
  });

  it("still reports vision:true for the dotted deepseek-v4.1-flash id", () => {
    const caps = getCapabilitiesForModel("ollama", "deepseek-v4.1-flash");
    expect(caps.vision).toBe(true);
  });

  it("still reports reasoning:true for deepseek-v4-1-flash", () => {
    const caps = getCapabilitiesForModel("kenari", "deepseek-v4-1-flash");
    expect(caps.reasoning).toBe(true);
  });

  it("reports the correct contextWindow (1M) for deepseek-v4-1-flash", () => {
    const caps = getCapabilitiesForModel("kenari", "deepseek-v4-1-flash");
    expect(caps.contextWindow).toBe(1000000);
  });
});

// ── #4244 LIVE_CATALOG_PROVIDERS includes zed ────────────────────────────
// ModelSelectModal.js is JSX so we cannot import it in Vitest without a
// JSX transform.  Read the source text and verify the constant definition
// directly — this is reliable and does not require a full React setup.

import fs from "fs";
import path from "path";

describe("ModelSelectModal LIVE_CATALOG_PROVIDERS includes zed (#4244)", () => {
  let src;
  beforeAll(() => {
    const fileUrl = new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url);
    src = fs.readFileSync(fileUrl, "utf-8");
  });

  it("includes zed in LIVE_CATALOG_PROVIDERS", () => {
    // Match the const definition line and verify zed is present
    const match = src.match(/const LIVE_CATALOG_PROVIDERS\s*=\s*\[([^\]]+)\]/);
    expect(match).toBeTruthy();
    const list = match[1];
    expect(list).toContain('"zed"');
  });

  it("still includes cursor, cline, clinepass", () => {
    const match = src.match(/const LIVE_CATALOG_PROVIDERS\s*=\s*\[([^\]]+)\]/);
    const list = match[1];
    expect(list).toContain('"cursor"');
    expect(list).toContain('"cline"');
    expect(list).toContain('"clinepass"');
  });

  it("zedModels hook call is present in the file", () => {
    expect(src).toContain("zedModels");
    expect(src).toContain("zedConnectionIds");
  });
});

// ── kiro-cli live catalog in the Combo picker ────────────────────────────
// kiro-cli's backend customResolver resolves the live Kiro gateway catalog
// (per-account entitlements), so the stale static registry must not win.
// Same source-text pattern as the zed test above (JSX cannot be imported).
describe("ModelSelectModal LIVE_CATALOG_PROVIDERS includes kiro-cli", () => {
  let src;
  beforeAll(() => {
    const fileUrl = new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url);
    src = fs.readFileSync(fileUrl, "utf-8");
  });

  it("includes kiro-cli in LIVE_CATALOG_PROVIDERS", () => {
    const match = src.match(/const LIVE_CATALOG_PROVIDERS\s*=\s*\[([^\]]+)\]/);
    expect(match).toBeTruthy();
    expect(match[1]).toContain('"kiro-cli"');
  });

  it("kiroCliModels hook call is present in the file", () => {
    expect(src).toContain("kiroCliModels");
    expect(src).toContain("kiroCliConnectionIds");
  });

  it("liveModels ternary routes kiro-cli to kiroCliModels", () => {
    expect(src).toContain('providerId === "kiro-cli" ? kiroCliModels');
  });
});