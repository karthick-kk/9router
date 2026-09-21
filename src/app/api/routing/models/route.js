import { NextResponse } from "next/server";
import { queryModels } from "@/lib/db/repos/routingDecisionsRepo.js";
import { isModelOffline } from "@/sse/services/comboHealth.js";
import { getAdaptiveStats } from "open-sse/services/combo/adaptive-state.js";

export const dynamic = "force-dynamic";

// The in-memory registries live in process memory and are empty on a fresh
// restart, so every lookup is fail-open: a model absent from both maps simply
// reports offline=false / stats=null.
function inHealth(key) {
  const offline = isModelOffline(key);
  const stats = getAdaptiveStats(key);
  const hasStats = stats && (stats.successes > 0 || stats.failures > 0);
  return { offline, stats: hasStats ? stats : null };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "today";
    const { models } = await queryModels({ period });
    return NextResponse.json(
      { models: models.map((m) => ({ ...m, inHealth: inHealth(m.model) })) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[routing/models] error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
