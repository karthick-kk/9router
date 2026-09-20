#!/usr/bin/env node
/**
 * Composite-stage efficiency report.
 *
 * Answers the question the strategy exists to answer: for the turns that actually
 * ran, what did they cost, and what would the same turns have cost on the capable
 * model alone? Every routed turn carries the same conversation, so replaying it at
 * the capable model's rate is a fair counterfactual for spend. It is NOT a claim
 * about quality — a cheap turn that produced a worse answer still counts as a
 * "saving" here, which is why the per-model call counts are printed alongside.
 *
 * Usage:
 *   node scripts/combo-efficiency-report.mjs [comboName] [--days N] [--db PATH]
 *
 * Reads the same sqlite file the gateway writes. In Docker the DB lives in the
 * 9router-data volume, so run it inside the container or point --db at a copy.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

import { getPricingForModel, calculateCostFromTokens, formatCost } from "../open-sse/providers/pricing.js";

function parseArgs(argv) {
  const args = { combo: null, days: null, db: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--db") args.db = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else rest.push(a);
  }
  args.combo = rest[0] || null;
  return args;
}

function resolveDbPath(explicit) {
  const candidates = [
    explicit,
    process.env.DATA_DIR ? resolve(process.env.DATA_DIR, "db/data.sqlite") : null,
    "/app/data/db/data.sqlite",
    resolve(homedir(), ".9router/db/data.sqlite"),
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// Reuse the gateway's own driver chain so this works wherever the app works.
async function openDb(path) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    return { all: (sql, params = []) => db.prepare(sql).all(...params) };
  } catch { /* fall through */ }
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path, { readonly: true });
  return { all: (sql, params = []) => db.prepare(sql).all(...params) };
}

function costOf(provider, model, promptTokens, completionTokens) {
  const pricing = getPricingForModel(provider, model);
  return calculateCostFromTokens({ prompt_tokens: promptTokens, completion_tokens: completionTokens }, pricing);
}

function pct(part, whole) {
  if (!whole) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/combo-efficiency-report.mjs [comboName] [--days N] [--db PATH]");
    return;
  }

  const dbPath = resolveDbPath(args.db);
  if (!dbPath) {
    console.error("Could not find data.sqlite. Pass --db PATH.");
    process.exit(1);
  }

  const db = await openDb(dbPath);
  const where = ["meta IS NOT NULL", "meta != ''", "meta != '{}'"];
  const params = [];
  if (args.days) {
    where.push("timestamp >= ?");
    params.push(new Date(Date.now() - args.days * 86400000).toISOString());
  }

  const rows = db.all(
    `SELECT timestamp, provider, model, promptTokens, completionTokens, cost, meta
     FROM usageHistory WHERE ${where.join(" AND ")} ORDER BY id ASC`,
    params
  );

  // Group by combo, keeping only rows a combo strategy actually tagged.
  const byCombo = new Map();
  for (const r of rows) {
    let meta;
    try { meta = JSON.parse(r.meta); } catch { continue; }
    const combo = meta?.combo;
    if (!combo) continue;
    if (args.combo && combo !== args.combo) continue;
    if (!byCombo.has(combo)) byCombo.set(combo, { strategy: meta.comboStrategy || "unknown", rows: [] });
    byCombo.get(combo).rows.push(r);
  }

  if (byCombo.size === 0) {
    console.log("No combo-attributed usage found yet.");
    console.log("Only requests served after the attribution change are tagged; run some traffic first.");
    return;
  }

  for (const [combo, { strategy, rows: crows }] of byCombo) {
    // The capable model is whichever tagged model is most expensive per token —
    // derived from observed spend rather than re-reading settings, so the report
    // stays correct even if the combo was reconfigured mid-window.
    const perModel = new Map();
    for (const r of crows) {
      const key = `${r.provider}/${r.model}`;
      const m = perModel.get(key) || { provider: r.provider, model: r.model, calls: 0, inTok: 0, outTok: 0, cost: 0 };
      m.calls++;
      m.inTok += r.promptTokens || 0;
      m.outTok += r.completionTokens || 0;
      m.cost += r.cost || 0;
      perModel.set(key, m);
    }

    const ranked = [...perModel.values()].sort((a, b) => {
      const ra = getPricingForModel(a.provider, a.model)?.input ?? 0;
      const rb = getPricingForModel(b.provider, b.model)?.input ?? 0;
      return rb - ra;
    });
    const capable = ranked[0];

    const actualCost = crows.reduce((s, r) => s + (r.cost || 0), 0);
    // Counterfactual: same turns, all on the capable model.
    const baselineCost = crows.reduce(
      (s, r) => s + costOf(capable.provider, capable.model, r.promptTokens || 0, r.completionTokens || 0),
      0
    );
    const saved = baselineCost - actualCost;

    console.log(`\n${"=".repeat(72)}`);
    console.log(`Combo: ${combo}   strategy: ${strategy}   turns: ${crows.length}`);
    console.log(`Window: ${crows[0].timestamp.slice(0, 16)} → ${crows.at(-1).timestamp.slice(0, 16)}`);
    console.log("=".repeat(72));

    console.log("\nPer-model breakdown");
    console.log(`${"model".padEnd(38)} ${"calls".padStart(6)} ${"in".padStart(11)} ${"out".padStart(8)} ${"cost".padStart(10)}`);
    console.log("-".repeat(78));
    for (const m of ranked) {
      const tag = m === capable ? " (capable)" : "";
      console.log(
        `${(m.provider + "/" + m.model + tag).padEnd(38)} ${String(m.calls).padStart(6)} ${String(m.inTok).padStart(11)} ${String(m.outTok).padStart(8)} ${formatCost(m.cost).padStart(10)}`
      );
    }

    console.log("\nSpend vs capable-only baseline");
    console.log(`  actual (routed)          ${formatCost(actualCost)}`);
    console.log(`  baseline (all ${capable.model})  ${formatCost(baselineCost)}`);
    if (saved >= 0) {
      console.log(`  saved                    ${formatCost(saved)}  (${pct(saved, baselineCost)} of baseline)`);
    } else {
      console.log(`  OVERSPENT                ${formatCost(-saved)}  — routing cost more than the capable model alone`);
    }

    const capableShare = capable.calls / crows.length;
    console.log(`\n  capable-tier share       ${pct(capable.calls, crows.length)} of turns (${capable.calls}/${crows.length})`);
    if (capableShare > 0.85) {
      console.log("  note: almost every turn ran on the capable model — little to gain unless");
      console.log("        the classifier/downgrade thresholds are loosened.");
    }
    console.log("\n  Cost is an estimate from the pricing tables, not a provider invoice.");
    console.log("  It measures spend only; judge answer quality separately.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
