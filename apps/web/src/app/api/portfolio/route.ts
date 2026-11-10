import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { computeTotals, publicState, readStore } from "@/lib/store";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  const state = await readStore();
  const totals = computeTotals(state);
  const pub = publicState(state);
  return NextResponse.json({
    ...pub,
    totals,
    serverConnected: true,
  });
}
