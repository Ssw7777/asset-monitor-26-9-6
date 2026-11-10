import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { CHANGE_RANGES, buildChangeSummary, type ChangeRangeKey } from "@/lib/changes";
import { readStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const requested = new URL(req.url).searchParams.get("range") || "24h";
  const range = (CHANGE_RANGES.some((item) => item.key === requested)
    ? requested
    : "24h") as ChangeRangeKey;

  const state = await readStore();
  return NextResponse.json(buildChangeSummary(state, range));
}
