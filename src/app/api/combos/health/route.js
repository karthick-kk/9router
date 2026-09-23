import { NextResponse } from "next/server";
import { getHealthDetail } from "@/sse/services/comboHealth.js";

export const dynamic = "force-dynamic";

/**
 * Live health snapshot of the combo probe registry (in-memory, filled by the
 * combo health ticker). Accepts a comma-separated `models` list; models never
 * probed (fresh restart, monitoring off) are reported as "unknown". Fail-open:
 * a bad request just returns what we could report.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const models = (searchParams.get("models") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    return NextResponse.json(
      { health: Object.fromEntries(models.map((m) => [m, getHealthDetail(m)])) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[combos/health] error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
