import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

export async function GET() {
  try {
    const settings = await getSettings();
    const headroomUrl = settings.headroomUrl || DEFAULT_HEADROOM_URL;
    const statsUrl = `${headroomUrl.replace(/\/$/, "")}/stats`;

    const res = await fetch(statsUrl, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Headroom returned ${res.status}` },
        { status: res.status }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to reach headroom: ${error.message}` },
      { status: 502 }
    );
  }
}
