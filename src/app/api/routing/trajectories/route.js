import { NextResponse } from "next/server";
import { queryTrajectories, listCombos } from "@/lib/db/repos/routingDecisionsRepo.js";

export const dynamic = "force-dynamic";

// Presence of the literal string "true" is the only way these booleans arrive
// from a query string; anything else (including omission) is falsy.
const isTrue = (v) => v === "true";
// A parseable 0-1 float, or null when absent/invalid (repo treats null as "no filter").
function conf(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const combo = searchParams.get("combo") || null;
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const { sessions } = await queryTrajectories({
      combo,
      limit: Number.isFinite(limit) ? limit : 50,
      minConf: conf(searchParams.get("minConf")),
      maxConf: conf(searchParams.get("maxConf")),
      failoverOnly: isTrue(searchParams.get("failoverOnly")),
      failOpenOnly: isTrue(searchParams.get("failOpenOnly")),
    });
    // The picker always lists every combo in the ring, even when `combo` is
    // absent or unknown (in which case `sessions` is simply empty).
    const combos = await listCombos();
    return NextResponse.json({ sessions, combos, combo }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[routing/trajectories] error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
