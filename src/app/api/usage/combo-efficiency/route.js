import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getPricingForModel, calculateCostFromTokens } from "open-sse/providers/pricing.js";

export const dynamic = "force-dynamic";

// Same period vocabulary the rest of the usage page uses, so the card's window
// selector can mirror the page-level one instead of inventing its own units.
const PERIODS = {
  today: () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  },
  "24h": () => new Date(Date.now() - 86400000).toISOString(),
  "7d": () => new Date(Date.now() - 7 * 86400000).toISOString(),
  "30d": () => new Date(Date.now() - 30 * 86400000).toISOString(),
  "60d": () => new Date(Date.now() - 60 * 86400000).toISOString(),
  all: () => "1970-01-01T00:00:00.000Z",
};

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const combo = searchParams.get("combo");
    const period = searchParams.get("period") || "today";
    const cutoff = (PERIODS[period] || PERIODS.today)();

    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, promptTokens, completionTokens, cost, meta
       FROM usageHistory
       WHERE meta IS NOT NULL AND meta != '' AND meta != '{}' AND timestamp >= ?
       ORDER BY id ASC`,
      [cutoff]
    );

    // Group every tagged row by combo. `available` is built from the unfiltered set
    // so the dropdown keeps listing all combos even while one is selected.
    const byCombo = new Map();
    for (const r of rows) {
      let meta;
      try { meta = JSON.parse(r.meta); } catch { continue; }
      const c = meta?.combo;
      if (!c) continue;
      if (!byCombo.has(c)) {
        byCombo.set(c, { strategy: meta.comboStrategy || "unknown", rows: [] });
      }
      byCombo.get(c).rows.push(r);
    }

    const available = [...byCombo.keys()].sort();
    const selected = combo && byCombo.has(combo) ? [combo] : available;

    const results = [];
    for (const name of selected) {
      const { strategy, rows: crows } = byCombo.get(name);

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

      // Capable tier = the most expensive model per input token. Derived from
      // observed spend rather than settings, so the report stays correct even if
      // the combo was reconfigured inside the window.
      const ranked = [...perModel.values()].sort((a, b) => {
        const ra = getPricingForModel(a.provider, a.model)?.input || 0;
        const rb = getPricingForModel(b.provider, b.model)?.input || 0;
        return rb - ra;
      });
      const capable = ranked[0];
      if (!capable) continue;

      const actualCost = crows.reduce((s, r) => s + (r.cost || 0), 0);
      // Counterfactual: the same turns, all answered by the capable model.
      const capablePricing = getPricingForModel(capable.provider, capable.model);
      const baselineCost = crows.reduce(
        (s, r) => s + calculateCostFromTokens(
          { prompt_tokens: r.promptTokens || 0, completion_tokens: r.completionTokens || 0 },
          capablePricing
        ),
        0
      );
      const saved = baselineCost - actualCost;

      const r4 = (n) => Math.round(n * 10000) / 10000;
      results.push({
        combo: name,
        strategy,
        turns: crows.length,
        window: { from: crows[0]?.timestamp || null, to: crows.at(-1)?.timestamp || null },
        capableModel: capable.model,
        perModel: ranked.map((m) => ({
          model: m.model,
          provider: m.provider,
          calls: m.calls,
          inTok: m.inTok,
          outTok: m.outTok,
          cost: r4(m.cost),
          isCapable: m === capable,
        })),
        actualCost: r4(actualCost),
        baselineCost: r4(baselineCost),
        saved: r4(saved),
        savedPct: baselineCost > 0 ? Math.round((saved / baselineCost) * 1000) / 10 : 0,
        capableCalls: capable.calls,
        capableShare: Math.round((capable.calls / crows.length) * 1000) / 10,
      });
    }

    return NextResponse.json({ combos: results, available, period });
  } catch (error) {
    console.error("[combo-efficiency] error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
