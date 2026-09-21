# Routing Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every combo routing decision (all strategies) with its outcome, and add a Routing dashboard page (Overview / Trajectories / Models) that shows per-combo spend, routing-quality (savings) math, and per-turn decision trajectories for fine-tuning.

**Architecture:** New `routingDecisions` SQLite table (ring-pruned to a configurable cap) written by small fail-open capture hooks at each strategy's decision point (`jev.js`, `composite-stage.js`, `adaptive`/fallback in `combo.js`, `handleFusionChat`). The chat handler backfills the outcome after the response. Three read-only API routes under `/api/routing/` feed one new dashboard page. The `ComboEfficiencyCard` on Usage and `/api/usage/combo-efficiency` are deleted (math moves server-side into `/api/routing/overview`).

**Tech Stack:** Next.js 16 app dir, SQLite via `getAdapter()` (better-sqlite3/node:sqlite), recharts for charts, Tailwind v4 + existing shared components (`Card`, `Select`, `Input`, `Toggle`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-routing-intelligence-design.md`

## Global Constraints

- Git identity for all commits: `karthick-kk <kkzone@gmail.com>` (repo-level config; verify with `git config user.email`).
- Commit after every task; never push without being asked.
- Full unit suite must end with **zero new failures** vs the known baseline (~124 pre-existing failures). Run from `tests/`: `npx -y vitest run --config ./vitest.config.js` (single file: append the file name).
- Capture must be **fail-open**: any DB/serialization error logs a warn and never affects routing or the request.
- `preview` column stores at most 200 chars of the user turn. No headers, no full messages, no classifier reasoning text are stored.
- Period vocabulary (copy verbatim from `src/app/api/usage/combo-efficiency/route.js:9-20`): `today, 24h, 7d, 30d, 60d, all` mapping to ISO cutoff strings; `all` = `"1970-01-01T00:00:00.000Z"`.
- DB is always SQLite through `getAdapter()` from `@/lib/db/driver.js` (repo files) or `@/lib/localDb` (API routes — routes in this repo import `getSettings, updateSettings, ...` from `@/lib/localDb` which re-exports the db layer; `getAdapter` is imported directly from `@/lib/db/driver.js` in API routes, see `src/app/api/usage/combo-efficiency/route.js:2`).
- `usageHistory` row shape (for the overview math): `timestamp` (ISO TEXT), `provider`, `model`, `promptTokens`, `completionTokens`, `cost` (REAL), `status` (TEXT, `"ok"` on success — see `usageRepo.js:224,286`), `meta` (JSON `{combo, comboStrategy}`).
- `usageHistory.meta` tagging (`saveUsageStats` combo/comboStrategy in `open-sse/handlers/chatCore/requestDetail.js`) stays untouched — the new page's per-combo cost is built on it.

---

### Task 1: `routingDecisions` table + repo (record, backfill, prune)

**Files:**
- Modify: `src/lib/db/schema.js:6` (SCHEMA_VERSION) and `:138-155` area (add table to `TABLES`)
- Create: `src/lib/db/repos/routingDecisionsRepo.js`
- Modify: `src/lib/db/repos/settingsRepo.js:7-69` (`DEFAULT_SETTINGS` — add `routingDecisionsMaxRecords: 5000`)
- Test: `tests/unit/routing-decisions-repo.test.js`

**Interfaces:**
- Consumes: `getAdapter()` (`@/lib/db/driver.js`), `getSettings()` (`@/lib/db/repos/settingsRepo.js`).
- Produces (exact signatures later tasks rely on):
  - `recordDecision(rec) -> Promise<string|null>` where `rec = { combo: string, strategy: string, sessionId: string|null, turn: number, source: string, reason: string, picked: string, confidence: number|null, scores: object, preview: string, classifierMs: number|null }`
  - `backfillOutcome(id: string, outcome: { served, success, fellOver, fellOverTo: string|null, status: number|null, latencyMs: number }) -> Promise<void>`
  - `queryTrajectories({ combo, limit, minConf, maxConf, failoverOnly, failOpenOnly }) -> Promise<{ sessions: Array<{ sessionId: string|null, turns: Array<row> }> }>` (row = full record with `scores`/`outcome` parsed)
  - `queryOverview({ period, combo }) -> Promise<{ combos: Array<object>, available: string[] }>`
  - `queryModels({ period }) -> Promise<{ models: Array<object> }>` (implemented in Task 8, but the file skeleton lands here)

- [ ] **Step 1: Write the failing repo test**

Create `tests/unit/routing-decisions-repo.test.js`. It sandboxes the real DB driver in a temp `DATA_DIR` — same pattern as `tests/unit/db-migration-chain.test.js` (read that file first for the exact env/singleton-reset incantation; the driver singleton is `global._dbAdapter = { instance, initPromise, logged }` in `src/lib/db/driver.js:5`).

```js
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tests && npx -y vitest run --config ./vitest.config.js unit/routing-decisions-repo.test.js`
Expected: FAIL — module `routingDecisionsRepo.js` does not exist.

- [ ] **Step 3: Add the table to the schema**

In `src/lib/db/schema.js`, change line 6 to `export const SCHEMA_VERSION = 2;` and add to `TABLES` (after `requestDetails`):

```js
  routingDecisions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "INTEGER NOT NULL",
      combo: "TEXT NOT NULL",
      strategy: "TEXT NOT NULL",
      sessionId: "TEXT",
      turn: "INTEGER DEFAULT 1",
      source: "TEXT NOT NULL",
      reason: "TEXT",
      picked: "TEXT",
      confidence: "REAL",
      scores: "TEXT",
      preview: "TEXT",
      classifierMs: "INTEGER",
      outcome: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rdcom_combo_ts ON routingDecisions(combo, timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rdcom_ts ON routingDecisions(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rdcom_session ON routingDecisions(combo, sessionId, turn)",
    ],
  },
```

The boot migration path (`syncSchemaFromTables` in `src/lib/db/migrate.js:79-109`) auto-`ALTER`s live DBs; the `SCHEMA_VERSION` bump triggers the pre-change backup. No migration file needed (additive only).

- [ ] **Step 4: Add the settings default**

In `src/lib/db/repos/settingsRepo.js` `DEFAULT_SETTINGS` (near line 46-49, the observability keys), add:

```js
  routingDecisionsMaxRecords: 5000,
```

- [ ] **Step 5: Implement the repo**

Create `src/lib/db/repos/routingDecisionsRepo.js`:

```js
import crypto from "crypto";
import { getAdapter } from "../driver.js";
import { getSettings } from "./settingsRepo.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const FAIL_OPEN_REASONS = new Set([
  "no-api-key", "timeout", "http-error", "no-usable-choice", "classifier-disabled", "classifier-error",
]);

/**
 * Record one routing decision. Fail-open: returns null (and logs nothing here —
 * callers decide whether to warn) on any error. Prunes the ring to the
 * configured cap (settings.routingDecisionsMaxRecords, default 5000, min 500).
 * @param {{combo: string, strategy: string, sessionId?: string|null, turn?: number, source: string, reason: string, picked?: string|null, confidence?: number|null, scores?: object, preview?: string, classifierMs?: number|null}} rec
 * @returns {Promise<string|null>} the new row id, or null
 */
export async function recordDecision(rec) {
  try {
    const db = await getAdapter();
    const { routingDecisionsMaxRecords } = await getSettings();
    const cap = Math.max(500, Number(routingDecisionsMaxRecords) > 0 ? Number(routingDecisionsMaxRecords) : 5000);
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO routingDecisions(id, timestamp, combo, strategy, sessionId, turn, source, reason, picked, confidence, scores, preview, classifierMs, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id, Date.now(), rec.combo, rec.strategy, rec.sessionId || null,
        Number.isFinite(rec.turn) ? rec.turn : 1, rec.source, rec.reason || "",
        rec.picked || null, typeof rec.confidence === "number" ? rec.confidence : null,
        stringifyJson(rec.scores || {}), (rec.preview || "").slice(0, 200),
        Number.isFinite(rec.classifierMs) ? rec.classifierMs : null,
      ]
    );
    // Ring prune (same mechanism as requestDetailsRepo.js:127-133): oldest first.
    const { n } = db.get(`SELECT COUNT(*) AS n FROM routingDecisions`);
    if (n > cap) db.run(`DELETE FROM routingDecisions WHERE id IN (SELECT id FROM routingDecisions ORDER BY timestamp ASC, id ASC LIMIT ?)`, [n - cap]);
    return id;
  } catch {
    return null;
  }
}

/**
 * Backfill the post-response outcome. Missing id (pruned between decision and
 * completion) is a no-op. Fail-open.
 */
export async function backfillOutcome(id, outcome) {
  if (!id) return;
  try {
    const db = await getAdapter();
    db.run(
      `UPDATE routingDecisions SET outcome = ? WHERE id = ?`,
      [stringifyJson({
        served: outcome.served || null,
        success: !!outcome.success,
        fellOver: !!outcome.fellOver,
        fellOverTo: outcome.fellOverTo || null,
        status: outcome.status ?? null,
        latencyMs: Number.isFinite(outcome.latencyMs) ? outcome.latencyMs : null,
      }), id]
    );
  } catch {
    /* fail-open */
  }
}

function parseRow(r) {
  return {
    id: r.id, timestamp: r.timestamp, combo: r.combo, strategy: r.strategy,
    sessionId: r.sessionId, turn: r.turn, source: r.source, reason: r.reason,
    picked: r.picked, confidence: r.confidence,
    scores: parseJson(r.scores, {}), preview: r.preview || "",
    classifierMs: r.classifierMs, outcome: r.outcome ? parseJson(r.outcome, null) : null,
  };
}

/**
 * Decision records for a combo as per-session trajectories, newest session
 * first, turns ascending within a session. limit = number of sessions (default
 * 50, max 200). Filters: confidence range, failover-only (outcome.fellOver),
 * fail-open-only (reason in FAIL_OPEN_REASONS).
 */
export async function queryTrajectories({ combo, limit = 50, minConf, maxConf, failoverOnly, failOpenOnly } = {}) {
  const db = await getAdapter();
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  let rows = db.all(
    `SELECT * FROM routingDecisions WHERE combo = ? ORDER BY timestamp DESC LIMIT 5000`,
    [combo]
  );
  rows = rows.map(parseRow);
  if (typeof minConf === "number") rows = rows.filter(r => r.confidence != null && r.confidence >= minConf);
  if (typeof maxConf === "number") rows = rows.filter(r => r.confidence == null || r.confidence <= maxConf);
  if (failoverOnly) rows = rows.filter(r => r.outcome?.fellOver === true);
  if (failOpenOnly) rows = rows.filter(r => FAIL_OPEN_REASONS.has(r.reason));

  const bySession = new Map();
  for (const r of rows) {
    const key = r.sessionId || `__req__${r.id}`;
    if (!bySession.has(key)) bySession.set(key, { sessionId: r.sessionId, turns: [] });
    bySession.get(key).turns.push(r);
  }
  let sessions = [...bySession.values()];
  sessions.sort((a, b) => (b.turns[0]?.timestamp || 0) - (a.turns[0]?.timestamp || 0));
  sessions = sessions.slice(0, lim);
  for (const s of sessions) s.turns.sort((a, b) => a.turn - b.turn || a.timestamp - b.timestamp);
  return { sessions };
}

/** Implemented in Task 8. */
export async function queryOverview() { throw new Error("not implemented yet"); }
/** Implemented in Task 8. */
export async function queryModels() { throw new Error("not implemented yet"); }
```

Note: `queryTrajectories` reads up to 5000 rows (ring cap makes this bounded) and filters in JS — the confidence/failover/fail-open filters touch JSON columns, so a window scan at this size is fine (same reasoning as the existing `meta` scan in `combo-efficiency/route.js:30-36`).

- [ ] **Step 6: Run the repo tests to verify they pass**

Run: `cd tests && npx -y vitest run --config ./vitest.config.js unit/routing-decisions-repo.test.js`
Expected: 5 passed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/schema.js src/lib/db/repos/settingsRepo.js src/lib/db/repos/routingDecisionsRepo.js tests/unit/routing-decisions-repo.test.js
git commit -m "feat(routing): routingDecisions table + repo (record/backfill/ring-prune/trajectories)"
```

---

### Task 2: Jev capture

**Files:**
- Modify: `open-sse/services/combo/jev.js:88-159` (`orderModelsByJev`)
- Modify: `src/sse/handlers/chat.js:157-164` and `:255-263` (pass `sessionId` + `onDecision`)
- Test: `tests/unit/combo-jev.test.js` (extend — read it first; it already stubs the Jev fetch)

**Interfaces:**
- Consumes: `recordDecision` (Task 1) via the new `onDecision` callback (chat.js owns the repo call — the strategy layer stays DB-free, matching how `log` is injected).
- Produces: `orderModelsByJev` gains two options, `sessionId` (string|null) and `onDecision(rec)` (synchronous, called exactly once on every path where a decision or fail-open happened). `rec` fields: `combo` (from new option `comboName`), `strategy: "jev"`, `sessionId`, `turn`, `source: "jev"`, `reason` ∈ `classified` | `ranked` | `below-gate-held` | `http-<status>` | `timeout` | `error` | `no-usable-choice` | `no-api-key` | `single-model`, `picked` (the first model of the returned order; `models[0]` when null), `confidence` (number or null), `scores` (`{ probabilities }` when available, else `{}`), `preview` (first 200 chars of the user turn), `classifierMs` (null when no HTTP call was made).
- `turn`: for a fresh user turn (`continuation === false`) the caller's session map increments; jev.js computes `turn` itself: option `turn` (number, default 1) — chat.js resolves it (see wiring below).

- [ ] **Step 1: Write the failing capture tests**

Append to `tests/unit/combo-jev.test.js` (reuse its existing fetch-stub helper — read the file to find how it mocks the Jev response):

```js
describe("decision capture", () => {
  const opts = (over = {}) => ({
    body: { messages: [{ role: "user", content: "fix the login bug" }] },
    models: ["9eric/A", "9eric/B"],
    cfg: { apiKey: "k", timeoutMs: 1000 },
    log: { warn() {}, info() {} },
    onDecision: vi.fn(),
    ...over,
  });

  it.each([
    // [stub answers.route (or null), cfg, expectedReason, expectedConfidence, expectedOrder]
    [{ type: "choice", choice: "9eric/B", confidence: 0.9, probabilities: { "9eric/B": 0.9, "9eric/A": 0.1 } }, {}, "classified", 0.9, ["9eric/B", "9eric/A"]],
    [{ type: "choice", choice: "9eric/B", confidence: 0.2 }, {}, "below-gate-held", 0.2, null],
    [{ type: "choice", choice: "9eric/B", confidence: 0.2, probabilities: { "9eric/B": 0.6, "9eric/A": 0.4 } }, { lowConfidence: "rank" }, "ranked", 0.2, ["9eric/B", "9eric/A"]],
    [null, {}, "no-usable-choice", null, null],
  ])("route %o → reason %s", async (answer, cfgExtra, reason, confidence, expectedOrder) => {
    const onDecision = vi.fn();
    global.fetch = answer === null
      ? vi.fn(async () => ({ ok: true, json: async () => ({}) }))
      : vi.fn(async () => ({ ok: true, json: async () => ({ answers: { route: answer } }) }));
    const out = await orderModelsByJev(opts({ cfg: { apiKey: "k", timeoutMs: 1000, ...cfgExtra }, onDecision, turn: 2, comboName: "jev-eric", sessionId: "s1" }));
    expect(out).toEqual(expectedOrder);
    expect(onDecision).toHaveBeenCalledTimes(1);
    const rec = onDecision.mock.calls[0][0];
    expect(rec).toMatchObject({
      combo: "jev-eric", strategy: "jev", sessionId: "s1", turn: 2,
      source: "jev", reason, confidence,
      preview: "fix the login bug",
    });
    expect(rec.picked).toBeTruthy();
    expect(Number.isFinite(rec.classifierMs)).toBe(true); // fetch was called in these paths
  });

  it("fetch throws → timeout reason, fail-open still returns null", async () => {
    const onDecision = vi.fn();
    global.fetch = vi.fn(async () => { throw new Error("aborted"); });
    const out = await orderModelsByJev(opts({ onDecision, comboName: "c" }));
    expect(out).toBeNull();
    expect(onDecision.mock.calls[0][0]).toMatchObject({ source: "jev", reason: /timeout|error/ });
  });

  it("HTTP 500 → http-500 reason", async () => {
    const onDecision = vi.fn();
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    await orderModelsByJev(opts({ onDecision, comboName: "c" }));
    expect(onDecision.mock.calls[0][0].reason).toBe("http-500");
  });

  it("no API key → no-api-key reason, picked = first model, no fetch", async () => {
    const onDecision = vi.fn();
    global.fetch = vi.fn();
    const out = await orderModelsByJev(opts({ cfg: {}, onDecision, comboName: "c" }));
    expect(out).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onDecision.mock.calls[0][0]).toMatchObject({ source: "jev", reason: "no-api-key", picked: "9eric/A", classifierMs: null });
  });

  it("never throws out of the decision path even if onDecision throws", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ answers: { route: { type: "choice", choice: "9eric/B", confidence: 0.9 } } }) }));
    await expect(orderModelsByJev(opts({ onDecision: () => { throw new Error("boom"); }, comboName: "c" }))).resolves.toEqual(["9eric/B", "9eric/A"]);
  });
});
```

(Adjust the first two `it` blocks: drop the dead first `it` once the `it.each` covers success — keep only the `it.each` + the error-path tests. `opts` stays as the shared base.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd tests && npx -y vitest run --config ./vitest.config.js unit/combo-jev.test.js`
Expected: new describe block fails (onDecision never called), existing tests still pass.

- [ ] **Step 3: Implement capture in `orderModelsByJev`**

Modify `orderModelsByJev` in `open-sse/services/combo/jev.js` (currently lines 88-159). **Do not rewrite the function wholesale** — the existing `request` payload construction (the `criteria`/`autoRubric` loop, `modePolicy`, `state`, and the `request` object built from them) stays exactly as-is; only the signature, the early-return paths, and the post-fetch decision points change. The code below shows the full new function with the unchanged middle marked:

```js
export async function orderModelsByJev({ body, models, rubrics = {}, cfg = {}, log, comboName = null, sessionId = null, turn = 1, onDecision }) {
  const emit = (rec) => {
    if (typeof onDecision !== "function") return;
    try { onDecision({ combo: comboName, strategy: "jev", sessionId, turn, ...rec }); }
    catch { /* capture must never break routing */ }
  };
  const apiKey = cfg.apiKey || process.env.TYPESAFE_API_KEY || "";
  if (!apiKey) { emit({ source: "jev", reason: "no-api-key", picked: Array.isArray(models) ? models[0] : null, confidence: null, scores: {}, preview: "", classifierMs: null }); return null; }
  if (!Array.isArray(models) || models.length < 2) { emit({ source: "jev", reason: "single-model", picked: models?.[0] || null, confidence: null, scores: {}, preview: "", classifierMs: null }); return null; }

  const { userText, continuation } = extractTurn(body);
  const preview = userText.slice(0, 200);
  if (!userText.trim()) { emit({ source: "jev", reason: "no-user-text", picked: models[0], confidence: null, scores: {}, preview, classifierMs: null }); return null; }

  const url = cfg.url || JEV_DEFAULTS.url;
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : JEV_DEFAULTS.timeoutMs;
  const gate = Number.isFinite(cfg.confidenceGate) ? cfg.confidenceGate : JEV_DEFAULTS.confidenceGate;

  const criteria = {};
  for (const m of models) criteria[m] = rubrics[m]?.trim() || autoRubric(m);
  const modePolicy = JEV_MODES[cfg.mode] || JEV_MODES.efficient;

  const state = {
    kind: continuation ? "tool-step continuation in an ongoing agent session" : "fresh user turn",
    userRequest: userText,
  };
  const request = { /* unchanged: model, state, questions.route */ };

  const t0 = Date.now();
  let answer;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log?.warn?.("JEV", `Classifier HTTP ${res.status}, keeping combo order`);
      emit({ source: "jev", reason: `http-${res.status}`, picked: models[0], confidence: null, scores: {}, preview, classifierMs: Date.now() - t0 });
      return null;
    }
    answer = (await res.json())?.answers?.route;
  } catch (err) {
    log?.warn?.("JEV", `Classifier failed (${err?.name === "TimeoutError" ? "timeout" : err?.message || "error"}), keeping combo order`);
    emit({ source: "jev", reason: err?.name === "TimeoutError" ? "timeout" : "error", picked: models[0], confidence: null, scores: {}, preview, classifierMs: Date.now() - t0 });
    return null;
  }
  const elapsed = Date.now() - t0;
  const probabilities = answer?.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {};

  if (answer?.type !== "choice" || !models.includes(answer.choice)) {
    log?.warn?.("JEV", "Classifier returned no usable choice, keeping combo order");
    emit({ source: "jev", reason: "no-usable-choice", picked: models[0], confidence: null, scores: { probabilities }, preview, classifierMs: elapsed });
    return null;
  }
  const confidence = typeof answer.confidence === "number" ? answer.confidence : 1;
  if (confidence < gate) {
    if (cfg.lowConfidence === "rank" && Object.keys(probabilities).length > 0) {
      const ranked = [...models].sort((a, b) => (probabilities[b] || 0) - (probabilities[a] || 0));
      log?.info?.("JEV", `Low confidence ${confidence.toFixed(2)}, following Jev ranking: ${ranked.join(" > ")}`);
      emit({ source: "jev", reason: "ranked", picked: ranked[0], confidence, scores: { probabilities }, preview, classifierMs: elapsed });
      return ranked;
    }
    log?.info?.("JEV", `Low confidence ${confidence.toFixed(2)} for ${answer.choice}, keeping combo order`);
    emit({ source: "jev", reason: "below-gate-held", picked: models[0], confidence, scores: { probabilities }, preview, classifierMs: elapsed });
    return null;
  }

  log?.info?.("JEV", `Picked ${answer.choice} (conf ${confidence.toFixed(2)})`);
  emit({ source: "jev", reason: "classified", picked: answer.choice, confidence, scores: { probabilities }, preview, classifierMs: elapsed });
  return [answer.choice, ...models.filter((m) => m !== answer.choice)];
}
```

(Keep the existing `request` object construction verbatim — only the early-returns and tail change. Add `no-user-text` to `FAIL_OPEN_REASONS` in `routingDecisionsRepo.js` in Task 1's file: append to the Set.)

- [ ] **Step 4: Wire chat.js call sites**

In `src/sse/handlers/chat.js`, both Jev call sites (lines ~157-164 and ~255-263) pass session + turn. The turn comes from the combo session map so trajectories count correctly; `getRoutingState` from `open-sse/services/combo/session-state.js` is already exported. A fresh user turn increments; continuations reuse the current counter:

```js
import { getRoutingState } from "open-sse/services/combo/session-state.js";
// (add to the existing combo.js import line or a new line at the top)
```

At each site (pattern; the second site at :255 is identical). The `decision` holder is declared **before** the `if (comboStrategy === "jev")` block so Task 4's `handleComboChat` wiring can share it — and because a Jev request must produce exactly ONE decision record (the Jev one), Task 4's wiring passes `onDecision: undefined` to `handleComboChat` when `comboStrategy === "jev"`:

```js
// Per-request decision holder: the Jev capture (below) fills it, and the
// onServed hook (Task 4) backfills it after the response.
const decision = { id: null };
const sid = comboSessionId(request, body);
const { continuation } = extractTurn(body); // jev.js exports extractTurn
const st = sid ? getRoutingState(modelStr, sid) : null;
// composite-stage owns its own counter (handleCompositeStageChat increments
// state.turnCounter per request) — incrementing here too would double-count.
if (st && !continuation && comboStrategy !== "composite-stage") st.turnCounter += 1;
let routedModels = comboModels;
if (comboStrategy === "jev") {
  routedModels = (await orderModelsByJev({
    body,
    models: comboModels,
    rubrics: comboStrategies[modelStr]?.jevRubrics,
    cfg: { /* unchanged */ },
    log,
    comboName: modelStr,
    sessionId: sid,
    turn: st ? st.turnCounter : 1,
    onDecision: (rec) => { recordDecision(rec).then((id) => { decision.id = id; }); },
  })) || comboModels;
}
// sid / st / decision are reused verbatim by the Task 4 handleComboChat wiring
// (onServed backfill + decisionSessionId + decisionTurn).
```

Because `recordDecision` is async and the backfill needs its id, the `onServed` hook (Task 4) reads `decision.id` after the response (microtask-safe: `recordDecision`'s promise is resolved by the time the HTTP response stream completes; if it wasn't, `backfillOutcome(null)` is a documented no-op). Add `import { recordDecision, backfillOutcome } from "@/lib/db/repos/routingDecisionsRepo.js";` at the top of chat.js.

Import `extractTurn` and `getRoutingState` (both exported — verify `extractTurn` is exported at `jev.js:45` via the `open-sse/services/combo.js` re-export at :19; if not re-exported, add `extractTurn` to that re-export list).

- [ ] **Step 5: Run tests**

Run: `cd tests && npx -y vitest run --config ./vitest.config.js unit/combo-jev.test.js`
Expected: all pass (new capture tests + pre-existing).

- [ ] **Step 6: Commit**

```bash
git add open-sse/services/combo/jev.js src/sse/handlers/chat.js open-sse/services/combo.js tests/unit/combo-jev.test.js src/lib/db/repos/routingDecisionsRepo.js
git commit -m "feat(routing): capture Jev classifier decisions (choice, confidence, probabilities, latency, fail-open cause)"
```

---

### Task 3: Composite-stage capture

**Files:**
- Modify: `open-sse/services/combo/composite-stage.js:128` (`handleCompositeStageChat` signature) and its decision/return path (find where `logDecision` is called — it already receives `comboName, sessionId, turn, selectedModel, decision, state`)
- Modify: `src/sse/handlers/chat.js:56-80` (`dispatchCompositeStage` — pass `onDecision`/`onServed`)
- Test: `tests/unit/combo-composite-stage.test.js` (extend)

**Interfaces:**
- Consumes: nothing new (composite already has everything: `comboName`, `sessionId`, `turn` (its `turn` object with `.kind`/`.text`), `decision` from `decideTier`, `state`).
- Produces: `handleCompositeStageChat` gains `onDecision(rec)` and `onServed(outcome)` options. `rec`: `{ combo: comboName, strategy: "composite-stage", sessionId, turn: state.turnCounter (number), source: decision.source, reason: decision.reason, picked: selectedModel, confidence: decision.classifier?.confidence ?? null, scores: { stageScore?, signals?, classifierTier?, escalations: state.escalations, downgrades: state.downgrades }, preview: first 200 chars of the user turn text ("" for tool continuations), classifierMs: null (composite's classifier latency is not separately measured today — leave null; the classifier call itself is a model request already captured in usageHistory) }`. `outcome`: `{ served: <final model>, success, fellOver: false, fellOverTo: null, status, latencyMs }` — emitted exactly once on the handler's terminal return paths (capable/efficient single-model result, 400, 503).

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/combo-composite-stage.test.js` (read the file first for its `handleSingleModel` stub pattern):

```js
describe("decision capture", () => {
  const base = {
    body: { messages: [{ role: "user", content: "hello world" }] },
    models: ["9eric/Capable", "9eric/Efficient"],
    handleSingleModel: vi.fn(async () => ({ ok: true, status: 200, clone: () => ({ json: async () => ({}) }) })),
    log: { warn() {}, info() {}, debug() {} },
    comboName: "eric-moa",
    sessionId: "sess-c",
    config: { classifier: { enabled: false }, stage: { enabled: false } },
  };

  it("emits one decision with tier + reason, then a served outcome", async () => {
    const onDecision = vi.fn(), onServed = vi.fn();
    await handleCompositeStageChat({ ...base, onDecision, onServed });
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0][0]).toMatchObject({
      combo: "eric-moa", strategy: "composite-stage", sessionId: "sess-c",
      turn: 1, source: "picker-default", reason: "no classifier model",
      picked: expect.any(String),
    });
    expect(onServed).toHaveBeenCalledTimes(1);
    expect(onServed.mock.calls[0][0]).toMatchObject({ success: true, fellOver: false });
  });

  it("does not throw if onDecision throws", async () => {
    await expect(handleCompositeStageChat({ ...base, onDecision: () => { throw new Error("boom"); } })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tests && npx -y vitest run --config ./vitest.config.js unit/combo-composite-stage.test.js`
Expected: new tests fail (hooks never called), existing pass.

- [ ] **Step 3: Implement**

In `handleCompositeStageChat` (`composite-stage.js:128`), add `onDecision, onServed` to the destructured params. Next to the existing `logDecision(...)` call site, emit:

```js
const safeEmit = (fn) => { if (typeof fn === "function") { try { fn(); } catch { /* fail-open */ } } };
// where logDecision is called:
safeEmit(() => onDecision({
  combo: comboName, strategy: "composite-stage", sessionId, turn: state.turnCounter,
  source: decision.source, reason: decision.reason, picked: selectedModel,
  confidence: decision.classifier?.confidence ?? null,
  scores: {
    ...(decision.stageScore !== undefined ? { stageScore: decision.stageScore } : {}),
    ...(decision.signals ? { signals: decision.signals } : {}),
    ...(decision.classifier ? { classifierTier: decision.classifier.tier } : {}),
    escalations: state.escalations, downgrades: state.downgrades,
  },
  preview: turn.kind === "user" ? String(turn.text || "").slice(0, 200) : "",
  classifierMs: null,
}));
```

On every terminal return (the capable/efficient `handleSingleModel` result, the 400 no-models, the 503 all-failed), before returning:

```js
safeEmit(() => onServed({
  served: <the model the response was produced by, or null for 400/503>,
  success: res?.ok ?? (res?.status || 0) < 400,
  fellOver: false, fellOverTo: null,
  status: res?.status ?? null,
  latencyMs: Date.now() - <handler start ts>,
}));
```

Add `const t0 = Date.now();` at handler top.

- [ ] **Step 4: Wire dispatchCompositeStage in chat.js**

In `dispatchCompositeStage` (`chat.js:56-80`), build the per-request holder and pass hooks:

```js
const decision = { id: null };
const t0 = Date.now();
return handleCompositeStageChat({
  /* existing args */
  onDecision: (rec) => { recordDecision(rec).then((id) => { decision.id = id; }); },
  onServed: (outcome) => { backfillOutcome(decision.id, { ...outcome, latencyMs: Date.now() - t0 }); },
});
```

(Note: composite measures its own latencyMs; pass `latencyMs: outcome.latencyMs` — use the handler's value, drop the outer t0 for composite. Keep it simple: `backfillOutcome(decision.id, outcome)`.)

- [ ] **Step 5: Run tests**

Run: `cd tests && npx -y vitest run --config ./vitest.config.js unit/combo-composite-stage.test.js`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add open-sse/services/combo/composite-stage.js src/sse/handlers/chat.js tests/unit/combo-composite-stage.test.js
git commit -m "feat(routing): capture composite-stage tier decisions + outcomes"
```

---

### Task 4: Fallback / round-robin / adaptive capture in `handleComboChat`

**Files:**
- Modify: `open-sse/services/combo.js:306-433` (`handleComboChat` — add `onDecision`, `onServed`, `decisionTurn` options)
- Test: `tests/unit/combo-autoswitch.test.js` (extend — it already drives `handleComboChat` end-to-end with a stubbed `handleSingleModel`; read it first)

**Interfaces:**
- Produces: `handleComboChat({ ..., onDecision, onServed, decisionSessionId = null, decisionTurn = 1 })`.
  - One `onDecision(rec)` at the top after all reordering (rotation, auto-switch, adaptive) so `picked` is the model the loop will actually try first:
    - adaptive: `{ combo: comboName, strategy: "adaptive", sessionId: decisionSessionId, turn: decisionTurn, source: "adaptive", reason: "thompson-sampled", picked: rotatedModels[0], confidence: null, scores: { stats: getAdaptiveStats(rotatedModels[0], Date.now()), preset: typeof adaptivePreset === "string" ? adaptivePreset : "custom", order: rotatedModels }, preview: "", classifierMs: null }`
    - fallback/round-robin: `source: "static"`, `reason: comboStrategy === "round-robin" ? "round-robin" : "combo-order"`, `scores: { order: rotatedModels }`, no stats.
  - One `onServed(outcome)` on each terminal return:
    - success (line ~356): `{ served: modelStr, success: true, fellOver: i > 0, fellOverTo: null, status: result.status ?? 200, latencyMs: Date.now() - loopStart }`
    - no-fallback failure (~387): `{ served: modelStr, success: false, fellOver: i > 0, fellOverTo: null, status: result.status, latencyMs: ... }`
    - all-failed (~422): `{ served: null, success: false, fellOver: true, fellOverTo: null, status, latencyMs: ... }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/combo-autoswitch.test.js`:

```js
describe("decision capture", () => {
  const mk = (over = {}) => ({
    body: { messages: [{ role: "user", content: "x" }] },
    models: ["p/A", "p/B"],
    handleSingleModel: vi.fn(async () => ({ ok: true, status: 200, clone: () => ({ json: async () => ({}) }) })),
    log: { info() {}, warn() {}, debug() {} },
    comboName: "eric",
    ...over,
  });

  it("fallback → static/combo-order decision, then served outcome", async () => {
    const onDecision = vi.fn(), onServed = vi.fn();
    await handleComboChat(mk({ comboStrategy: "fallback", onDecision, onServed }));
    expect(onDecision.mock.calls[0][0]).toMatchObject({ strategy: "fallback", source: "static", reason: "combo-order", picked: "p/A", combo: "eric" });
    expect(onServed.mock.calls[0][0]).toMatchObject({ served: "p/A", success: true, fellOver: false });
  });

  it("failover → outcome.fellOver true with the served model", async () => {
    const onServed = vi.fn();
    const hsm = vi.fn(async (b, m) => m === "p/A"
      ? { ok: false, status: 503, statusText: "unavailable", clone: () => ({ json: async () => ({ error: { message: "unavailable" } }) }) }
      : { ok: true, status: 200, clone: () => ({ json: async () => ({}) }) });
    await handleComboChat(mk({ comboStrategy: "fallback", handleSingleModel: hsm, onServed }));
    expect(onServed.mock.calls[0][0]).toMatchObject({ served: "p/B", success: true, fellOver: true });
  });

  it("adaptive → thompson-sampled decision with stats snapshot", async () => {
    const onDecision = vi.fn();
    await handleComboChat(mk({ comboStrategy: "adaptive", onDecision }));
    expect(onDecision.mock.calls[0][0]).toMatchObject({ strategy: "adaptive", source: "adaptive", reason: "thompson-sampled" });
    expect(onDecision.mock.calls[0][0].scores.stats).toEqual(expect.objectContaining({ successes: expect.any(Number) }));
  });

  it("onDecision throwing never breaks routing", async () => {
    await expect(handleComboChat(mk({ comboStrategy: "fallback", onDecision: () => { throw new Error("boom"); } }))).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tests && npx -y vitest run --config ./vitest.config.js unit/combo-autoswitch.test.js`
Expected: new tests fail; existing pass.

- [ ] **Step 3: Implement in `handleComboChat`**

`combo.js` already imports `getAdaptiveStats`? It imports `orderAdaptiveModels` from `./combo/adaptive.js` (which re-exports `getAdaptiveStats`, `adaptive.js:46`) — import it there: add `getAdaptiveStats` to that import. Then:

```js
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, autoSwitch = true, adaptivePreset = null, onDecision, onServed, decisionSessionId = null, decisionTurn = 1 }) {
  const safeEmit = (fn, arg) => { if (typeof fn === "function") { try { fn(arg); } catch { /* fail-open */ } } };
  /* ... existing rotation/auto-switch/adaptive code ... */

  // Decision capture: the order is final after adaptive reordering.
  const adaptiveEnabled = comboStrategy === "adaptive";
  const decisionScores = adaptiveEnabled
    ? { stats: getAdaptiveStats(rotatedModels[0], Date.now()), preset: typeof adaptivePreset === "string" ? adaptivePreset : "custom", order: rotatedModels }
    : { order: rotatedModels };
  safeEmit(onDecision, {
    combo: comboName, strategy: adaptiveEnabled ? "adaptive" : comboStrategy,
    sessionId: decisionSessionId, turn: decisionTurn,
    source: adaptiveEnabled ? "adaptive" : "static",
    reason: adaptiveEnabled ? "thompson-sampled" : (comboStrategy === "round-robin" ? "round-robin" : "combo-order"),
    picked: rotatedModels[0], confidence: null, scores: decisionScores, preview: "", classifierMs: null,
  });

  const loopStart = Date.now();
  /* ... existing for-loop, with safeEmit(onServed, {...}) at the three terminal returns as specified in Interfaces ... */
```

(The existing `const adaptiveEnabled = comboStrategy === "adaptive";` at line 327 moves up / is reused — don't declare it twice.)

- [ ] **Step 4: Run tests**

Run: `cd tests && npx -y vitest run --config ./vitest.config.js unit/combo-autoswitch.test.js`
Expected: all pass.

- [ ] **Step 5: Wire chat.js to pass the hooks**

In both `handleComboChat` call sites in chat.js (~198-213 and ~296-309), reuse the `sid` / `st` / `decision` locals that Task 2's wiring already declared at the top of each combo branch (the second, capacity-adapter site has no Jev branch — declare the same three locals there). Pass:

```js
onDecision: comboStrategy === "jev" ? undefined : (rec) => { recordDecision(rec).then((id) => { decision.id = id; }); },
onServed: (outcome) => { backfillOutcome(decision.id, outcome); },
decisionSessionId: sid,
decisionTurn: st ? st.turnCounter : 1,
```

The `undefined` for Jev is required: `orderModelsByJev` already records the decision for that request, and a second record from `handleComboChat` would double-count it. The backfill (`onServed`) still runs for Jev requests against the Jev record's id.

- [ ] **Step 6: Commit**

```bash
git add open-sse/services/combo.js src/sse/handlers/chat.js tests/unit/combo-autoswitch.test.js
git commit -m "feat(routing): capture fallback/round-robin/adaptive decisions + failover outcomes"
```

---

### Task 5: Fusion capture

**Files:**
- Modify: `open-sse/services/combo.js:598-~700` (`handleFusionChat` — add `onDecision`, `onServed`, `decisionSessionId`, `decisionTurn`)
- Test: `tests/unit/combo-fusion.test.js` (extend)

**Interfaces:**
- Produces: `handleFusionChat({ ..., onDecision, onServed, decisionSessionId = null, decisionTurn = 1 })`.
  - Decision (after the judge is chosen, before panel calls): `{ combo: comboName, strategy: "fusion", sessionId: decisionSessionId, turn: decisionTurn, source: "fusion-judge", reason: judgeModel ? "judge-configured" : "judge-auto", picked: judge (the judge model string), confidence: null, scores: { panel: models }, preview: first 200 chars of the newest user text (reuse the small local extract — fusion already builds `judgeBody`; just take the first user message text and slice 200), classifierMs: null }`
  - Served (terminal returns only: the judge's final answer return `return handleSingleModel(judgeBody, judge)`, the single-panel passthrough, the 400/503 errors): `{ served: <judge or panel model or null>, success, fellOver: false, fellOverTo: null, status, latencyMs }`.

- [ ] **Step 1: Write the failing tests** (append to `combo-fusion.test.js`, same style as Task 4's tests): decision emitted once with `source: "fusion-judge"` and `picked` = judge; `onServed` emitted once on the final judge answer; throwing hooks don't break routing.

- [ ] **Step 2: Run to verify it fails** — `cd tests && npx -y vitest run --config ./vitest.config.js unit/combo-fusion.test.js`

- [ ] **Step 3: Implement** — mirror Task 4's `safeEmit` pattern; `const t0 = Date.now()` at handler top; wire the two chat.js fusion call sites (~169-187, ~267-285) with the shared `decision` holder from Task 4's wiring (same `decision`, `sid`, `turn` values).

- [ ] **Step 4: Run tests** — same command; all pass.

- [ ] **Step 5: Commit**

```bash
git add open-sse/services/combo.js src/sse/handlers/chat.js tests/unit/combo-fusion.test.js
git commit -m "feat(routing): capture fusion judge decisions + outcomes"
```

---

### Task 6: `/api/routing/overview`

**Files:**
- Create: `src/app/api/routing/overview/route.js`
- Modify: `src/lib/db/repos/routingDecisionsRepo.js` (implement `queryOverview`)
- Test: `tests/unit/routing-overview-api.test.js`

**Interfaces:**
- Consumes: `getAdapter()`; `getPricingForModel`, `calculateCostFromTokens` from `open-sse/providers/pricing.js`; `usageHistory` rows; `queryOverview` from the repo.
- Produces: `GET /api/routing/overview?period=&combo=` → `{ combos: Array, available: string[], period: string }` where each combo entry:
```js
{
  combo, strategy,
  requests, promptTokens, completionTokens, cost, errorRate,          // from usageHistory (status != "ok" → error)
  avgLatencyMs,                                                        // mean of routingDecisions.outcome.latencyMs (non-null) in window, null if none
  capableModel, baselineCost, saved, savedPct, capableShare,          // efficiency math (moved from combo-efficiency/route.js:70-114)
  series: [{ bucket, cost, requests, saved }],                         // day buckets for the trend chart
}
```

- [ ] **Step 1: Write the failing route test**

`tests/unit/routing-overview-api.test.js` — mock the driver the way `tests/unit/combo-efficiency-api.test.js` does (read it first; it mocks `@/lib/db/driver.js` `getAdapter` with a stub whose `.all()` returns prepared `usageHistory`-shaped rows). Seed rows: two combos, some `status: "error"` rows, one combo with rows for a cheap + a priced model; seed `routingDecisions` rows via a second stubbed `.all` for the latency query. Assert: per-combo `requests/cost/errorRate`, `capableModel` = most expensive input-priced observed model, `savedPct` math matches `combo-efficiency`'s formula (`baselineCost` via `calculateCostFromTokens` at the capable model's pricing), `avgLatencyMs` from outcome rows, and the `combo=` filter.

- [ ] **Step 2: Run to verify it fails** — `cd tests && npx -y vitest run --config ./vitest.config.js unit/routing-overview-api.test.js`

- [ ] **Step 3: Implement `queryOverview` in the repo** (replace the Task 1 stub)

```js
import { getPricingForModel, calculateCostFromTokens } from "open-sse/providers/pricing.js";

const PERIODS = { /* copy verbatim from src/app/api/usage/combo-efficiency/route.js:9-20 */ };

export async function queryOverview({ period = "today", combo = null } = {}) {
  const db = await getAdapter();
  const cutoff = (PERIODS[period] || PERIODS.today)();
  const rows = db.all(
    `SELECT timestamp, provider, model, promptTokens, completionTokens, cost, status, meta
     FROM usageHistory WHERE meta IS NOT NULL AND meta != '' AND meta != '{}' AND timestamp >= ? ORDER BY id ASC`,
    [cutoff]
  );
  // group by meta.combo exactly like combo-efficiency/route.js:40-52
  /* ... */
  // per combo: requests/cost/tokens/errorRate; perModel map; capable = highest input price;
  // baseline/saved/savedPct/capableShare exactly like combo-efficiency/route.js:73-114;
  // avgLatencyMs:
  const latRows = db.all(
    `SELECT outcome FROM routingDecisions WHERE combo = ? AND timestamp >= ? AND outcome IS NOT NULL`,
    [name, Date.parse(cutoff)]
  );
  const lats = latRows.map(r => parseJson(r.outcome, {})?.latencyMs).filter(Number.isFinite);
  // series: bucket by day (new Date(r.timestamp).toISOString().slice(0,10)), accumulate cost/requests; recompute saved per bucket with the same capable pricing.
}
```

- [ ] **Step 4: Implement the route**

```js
import { NextResponse } from "next/server";
import { queryOverview } from "@/lib/db/repos/routingDecisionsRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const { combos, available, period } = await queryOverview({
      period: searchParams.get("period") || "today",
      combo: searchParams.get("combo") || null,
    });
    return NextResponse.json({ combos, available, period }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[routing/overview] error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 5: Run tests** — `cd tests && npx -y vitest run --config ./vitest.config.js unit/routing-overview-api.test.js` — all pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/routing/overview/route.js src/lib/db/repos/routingDecisionsRepo.js tests/unit/routing-overview-api.test.js
git commit -m "feat(routing): overview API (per-combo spend, error rate, latency, savings series)"
```

---

### Task 7: `/api/routing/trajectories` and `/api/routing/models`

**Files:**
- Create: `src/app/api/routing/trajectories/route.js`
- Create: `src/app/api/routing/models/route.js`
- Modify: `src/lib/db/repos/routingDecisionsRepo.js` (implement `queryModels`)
- Test: `tests/unit/routing-trajectories-api.test.js`

**Interfaces:**
- `GET /api/routing/trajectories?combo=&limit=&minConf=&maxConf=&failoverOnly=&failOpenOnly=` → `queryTrajectories` passthrough (Task 1) + `{ combos: string[] }` (distinct combos present in the ring, for the picker).
- `GET /api/routing/models?period=` → `{ models: Array }`, one entry per model seen in `usageHistory` in the window: `{ model: "provider/name", requests, promptTokens, completionTokens, cost, errorRate, inHealth: { offline: boolean, stats: { successes, failures, avgLatencyMs, penalty } | null } }` where `inHealth.offline` comes from `isModelOffline` (`src/sse/services/comboHealth.js`) and `stats` from `getAdaptiveStats` (`open-sse/services/combo/adaptive-state.js`). In-memory pieces may be undefined on a fresh process → `stats: null`, `offline: false`.

- [ ] **Step 1: Write the failing test** for trajectories route (driver mocked; assert session grouping, `limit`, `maxConf`, `failoverOnly` pass through to `queryTrajectories`, and `combos` list) and for the models route (assert `inHealth.offline` flips when `isModelOffline` is stubbed true — mock `@/lib/db/driver.js`, `src/sse/services/comboHealth.js`, and `open-sse/services/combo/adaptive-state.js` via `vi.mock`).

- [ ] **Step 2: Run to verify it fails** — `cd tests && npx -y vitest run --config ./vitest.config.js unit/routing-trajectories-api.test.js`

- [ ] **Step 3: Implement** both routes (thin wrappers over the repo functions; models route groups `usageHistory` rows by `provider/model` exactly like Task 6's perModel map, then enriches with the in-memory lookups). Implement `queryModels` in the repo (the in-memory enrichment lives in the route, not the repo, so the repo stays pure DB).

- [ ] **Step 4: Run tests** — all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/routing/trajectories/route.js src/app/api/routing/models/route.js src/lib/db/repos/routingDecisionsRepo.js tests/unit/routing-trajectories-api.test.js
git commit -m "feat(routing): trajectories + models APIs (decision timeline, live health per model)"
```

---

### Task 8: Routing dashboard page + sidebar entry

**Files:**
- Create: `src/app/(dashboard)/dashboard/routing/page.js`
- Create: `src/app/(dashboard)/dashboard/routing/components/TrajectoryTimeline.js`
- Modify: `src/shared/components/Sidebar.js:25` (add entry after Usage)
- No unit tests (consistent with the rest of the dashboard — verified live in Task 10)

**Interfaces:**
- Consumes: the three APIs from Tasks 6-7. Charts: recharts (already a dependency; `UsageChart` at `src/app/(dashboard)/dashboard/usage/components/UsageChart.js` is the in-repo reference for the chart styling). Components: `Card`, `Select`, `Input` from `@/shared/components` (same import list as `dashboard/combos/page.js:8`).

- [ ] **Step 1: Sidebar entry**

In `Sidebar.js` `navItems`, after the Usage line:

```js
  { href: "/dashboard/routing", label: "Routing", icon: "route" },
```

- [ ] **Step 2: Page shell with the three tabs**

`page.js`: `"use client"`; tabs `Overview | Trajectories | Models` (same tab pattern as `dashboard/usage/page.js:31-50`); shared `period` state (`today/24h/7d/30d/60d/all`) fetched from each API with `Promise.all` on tab+period change; loading spinner + empty-state copy like `UsageStats`.

**Overview tab:**
- Per-combo card grid: combo name + strategy badge; spend row (`requests · tokens in/out · $cost · error% · avg latency`); savings row (`$saved (pct%) vs <capableModel>` + `capableShare%`); a recharts `AreaChart` of `series` (cost vs baseline area, `saved` line) — mirror `UsageChart`'s recharts usage.
- Combo `Select` (options from `available`, sentinel `ALL` like `combo-efficiency`'s `ALL_COMBOS`).

**Trajectories tab:**
- Combo `Select` (from `/api/routing/trajectories` `combos`), filters: `Input type="number"` min/max confidence (0–1, step 0.05), `Toggle` failovers-only, `Toggle` fail-opens-only (all re-fetch the API with query params).
- Sessions list (left, most recent first: `session?` suffix + last timestamp + turn count) → `TrajectoryTimeline` (right): vertical list of turn cards. Each card: `#turn · HH:MM:SS · strategy/source (reason)` header; picked model in mono; confidence bar (`w-full h-1 bg-black/5` + inner `bg-brand-500` at `confidence*100%`); probability bars per `scores.probabilities` entry (label + relative-width bar); composite: `tier · stageScore · signals` chips; preview in `text-xs text-text-muted` italic; outcome badge: green `served X ✓ {latencyMs}ms` / amber `fell over to Y` / red `failed {status}` / grey `fail-open: {reason}`.

**Models tab:**
- Table: model (mono), live status dot (green online / red offline from `inHealth.offline`), adaptive `succ/fail` + `avg latency` + penalty (from `inHealth.stats`, `—` when null), period `requests · $cost · error%`.

- [ ] **Step 3: Syntax + build check**

Run: `cd /home/ekrkaxx/dev/tools/9router && node --check src/app/\(dashboard\)/dashboard/routing/page.js && node --check src/app/\(dashboard\)/dashboard/routing/components/TrajectoryTimeline.js`
(The app's real compile happens in the Docker build — Task 10's rebuild is the authoritative check; `next build` is not run on the host.)

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/dashboard/routing/ src/shared/components/Sidebar.js
git commit -m "feat(routing): Routing dashboard page (overview, trajectories, models)"
```

---

### Task 9: Delete the duplicated efficiency card + route; add retention setting UI

**Files:**
- Modify: `src/shared/components/UsageStats.js:472,540-648` (remove `<ComboEfficiencyCard />` render, the `ComboEfficiencyCard` component, its `PERIOD`/combo-select state, and the `combo-efficiency` fetch)
- Delete: `src/app/api/usage/combo-efficiency/route.js`
- Delete: `tests/unit/combo-efficiency-api.test.js` (tests a deleted route — its math is now covered by `routing-overview-api.test.js`)
- Modify: `src/app/(dashboard)/dashboard/profile/page.js` (retention input next to the observability toggle at ~line 1617)

**Interfaces:**
- Produces: nothing new; deletes only. `settings.routingDecisionsMaxRecords` is the only new setting (default from Task 1).

- [ ] **Step 1: Remove the card**

Delete the `<ComboEfficiencyCard />` line (UsageStats.js:472), the component (lines ~540-648 incl. its period/combo state and fetch at :579), and any now-unused imports. Grep after deletion: `grep -rn "combo-efficiency\|ComboEfficiencyCard" src/` must return nothing.

- [ ] **Step 2: Delete the route + its test**

```bash
git rm src/app/api/usage/combo-efficiency/route.js tests/unit/combo-efficiency-api.test.js
```

- [ ] **Step 3: Retention input on the profile page**

Next to the observability toggle (~line 1617, read the surrounding block first), add a compact number input bound to `settings.routingDecisionsMaxRecords` (min 500, step 500), saved via the same PATCH pattern as `enableObservability` (`profile/page.js:640-649`):

```js
const saveDecisionsCap = async (v) => {
  const n = Math.max(500, Number(v) || 5000);
  setSettings(prev => ({ ...prev, routingDecisionsMaxRecords: n }));
  await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ routingDecisionsMaxRecords: n }) });
};
```

Render: `<Input type="number" min={500} step={500} label="Routing decisions kept" defaultValue={settings.routingDecisionsMaxRecords ?? 5000} onBlur={(e) => saveDecisionsCap(e.target.value)} inputClassName="w-24" />` (match the local `Input` props usage in that file — read one existing usage first and mirror it).

- [ ] **Step 4: Run the affected tests**

Run: `cd tests && npx -y vitest run --config ./vitest.config.js unit/routing-overview-api.test.js unit/combo-health.test.js`
Expected: pass. Then grep check from Step 1.

- [ ] **Step 5: Commit**

```bash
git add -A src/shared/components/UsageStats.js src/app/api/usage/combo-efficiency/ tests/unit/combo-efficiency-api.test.js "src/app/(dashboard)/dashboard/profile/page.js"
git commit -m "refactor(routing): remove duplicated efficiency card/route; retention cap UI on profile"
```

---

### Task 10: Full suite + deploy + live verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `cd /home/ekrkaxx/dev/tools/9router/tests && npx -y vitest run --config ./vitest.config.js 2>&1 | tail -5`
Expected: failures count == baseline (~124). If any NEW failure names a routing/combo file, fix before proceeding.

- [ ] **Step 2: Rebuild + restart**

```bash
cd /home/ekrkaxx/dev/tools/9router && docker compose build 9router && docker compose up -d 9router
```
(Background it; ~3-5 min. Then `docker logs 9router-9router-1 --since 1m | grep -iE "ready|error" | head`.)

- [ ] **Step 3: Generate traffic**

Send one real `jev-eric` request and one `eric-moa` (composite) request the way previous sessions did: `docker cp` an in-container script that fetches `http://127.0.0.1:20128/api/v1/chat/completions` with `x-9r-cli-token` (sha256(machineId + "9r-cli-auth" + cliSecret) first 16 hex) + Bearer API key (recipe in the `9router-background-schedulers` memory / earlier sessions).

- [ ] **Step 4: Verify the data**

```bash
docker exec 9router-9router-1 node -e '...'  # or a copied .mjs script:
# - SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM routingDecisions  (expect ≥2 rows)
# - confirm one row has source "jev" with non-null confidence + classifierMs, one has source in the composite set
# - after the responses settle, confirm outcome IS NOT NULL with served + latencyMs
```

- [ ] **Step 5: Verify the page**

In-container `GET /dashboard/routing` returns the app shell (login-gated, as before — HTTP 200 is expected); the authoritative check is the deployed bundle: `docker exec 9router-9router-1 sh -c 'grep -rl "Trajectories\|/api/routing/overview" /app/.next/server | head'` must list the routing page chunk. Then ask the user to open **Routing** in the dashboard and confirm: Overview shows per-combo cards with spend+savings, Trajectories shows the sessions/timeline from Step 3's traffic, Models shows the live health dots.

- [ ] **Step 6: Commit anything left** (none expected) and report: feature complete, verified live, and the exact things the user should click.
