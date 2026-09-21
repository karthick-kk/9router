import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "9router-rd-test-"));
process.env.DATA_DIR = tmp;
global._dbAdapter = { instance: null, initPromise: null, logged: false };

let repo;
beforeAll(async () => {
  repo = await import("../../src/lib/db/repos/routingDecisionsRepo.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base = {
  combo: "jev-eric", strategy: "jev", sessionId: "sess-1", turn: 1,
  source: "jev", reason: "classified", picked: "9eric/Qwen/Qwen3.8-27B-FP8",
  confidence: 0.82, scores: { probabilities: { "9eric/Qwen/Qwen3.8-27B-FP8": 0.82 } },
  preview: "fix the login bug", classifierMs: 412,
};

describe("routingDecisionsRepo", () => {
  it("records a decision and returns its id", async () => {
    const id = await repo.recordDecision(base);
    expect(typeof id).toBe("string");
    const { sessions } = await repo.queryTrajectories({ combo: "jev-eric", limit: 10 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("sess-1");
    expect(sessions[0].turns[0]).toMatchObject({
      combo: "jev-eric", strategy: "jev", turn: 1, source: "jev",
      reason: "classified", picked: base.picked, confidence: 0.82,
      scores: base.scores, preview: base.preview, classifierMs: 412, outcome: null,
    });
  });

  it("backfills the outcome by id", async () => {
    const id = await repo.recordDecision(base);
    await repo.backfillOutcome(id, { served: base.picked, success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 1234 });
    const { sessions } = await repo.queryTrajectories({ combo: "jev-eric", limit: 10 });
    expect(sessions[0].turns.at(-1).outcome).toEqual({
      served: base.picked, success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 1234,
    });
  });

  it("backfilling a missing id is a no-op", async () => {
    await expect(repo.backfillOutcome("nope", { served: "x", success: true, fellOver: false, fellOverTo: null, status: 200, latencyMs: 1 })).resolves.toBeUndefined();
  });

  it("prunes to the configured ring cap (oldest first)", async () => {
    const db = (await import("../../src/lib/db/repos/settingsRepo.js"));
    await db.updateSettings({ routingDecisionsMaxRecords: 5 });
    const ids = [];
    for (let i = 0; i < 7; i++) {
      ids.push(await repo.recordDecision({ ...base, turn: i + 1, sessionId: `s${i}` }));
    }
    const { sessions } = await repo.queryTrajectories({ combo: "jev-eric", limit: 100 });
    expect(sessions.length).toBe(5); // 2 oldest pruned
    const keptTurns = sessions.map(s => s.turns[0].turn);
    expect(keptTurns).toContain(5);
    expect(keptTurns).toContain(7);
    expect(keptTurns).not.toContain(1);
    expect(keptTurns).not.toContain(2);
  });

  it("groups trajectories by session and filters", async () => {
    await repo.recordDecision({ ...base, sessionId: "A", turn: 1, confidence: 0.3, reason: "below-gate-held" });
    await repo.recordDecision({ ...base, sessionId: "A", turn: 2, confidence: 0.9 });
    await repo.recordDecision({ ...base, sessionId: "B", turn: 1, confidence: 0.9 });
    const all = await repo.queryTrajectories({ combo: "jev-eric", limit: 10 });
    expect(all.sessions.length).toBeGreaterThanOrEqual(3);

    const low = await repo.queryTrajectories({ combo: "jev-eric", limit: 10, maxConf: 0.5 });
    for (const s of low.sessions) for (const t of s.turns) expect(t.confidence).toBeLessThanOrEqual(0.5);
  });

  it("returns all combos' sessions when combo is omitted (all-combos view)", async () => {
    await repo.recordDecision({ ...base, combo: "other-combo", strategy: "other", sessionId: "C", turn: 1 });
    await repo.recordDecision({ ...base, sessionId: "J", turn: 1 });

    const all = await repo.queryTrajectories({ limit: 100 });
    expect(all.sessions.length).toBeGreaterThanOrEqual(1);
    const otherSessions = all.sessions.filter(s => s.turns[0].combo === "other-combo");
    expect(otherSessions.length).toBeGreaterThanOrEqual(1);
    expect(otherSessions[0].sessionId).toBe("C");

    const filtered = await repo.queryTrajectories({ combo: "jev-eric", limit: 100 });
    expect(filtered.sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of filtered.sessions) for (const t of s.turns) expect(t.combo).toBe("jev-eric");
  });
});
