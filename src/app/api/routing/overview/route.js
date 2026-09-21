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
