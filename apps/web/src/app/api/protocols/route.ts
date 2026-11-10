import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { CHANGE_RANGES, type ChangeRangeKey } from "@/lib/changes";
import { buildProtocolPerformance } from "@/lib/protocols";
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
  const dapps = state.onchainBreakdown?.dapps ?? [];
  return NextResponse.json(
    buildProtocolPerformance(
      state,
      range,
      dapps.map((dapp) => ({ name: dapp.name, netUsd: dapp.netUsd }))
    )
  );
}
